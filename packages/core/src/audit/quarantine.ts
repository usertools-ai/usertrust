// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Torn-tail quarantine (#194): the ONE repair the audit chain admits, so failing closed on a
 * torn tail has a recovery path that is not hand-editing the evidence.
 *
 * A TORN TAIL is, positively: bytes after the log's last newline that do not parse as JSON —
 * an append that never completed (a crash, a short write). Nothing else qualifies:
 *  - every line before it must verify from genesis (parse, link, sequence, hash);
 *  - the `.meta` head anchor must be at the verified head, exactly one behind it at its
 *    predecessor, or absent on a chain of at most one event (the states the writer itself leaves);
 *  - the chain must be the single `events.jsonl` (no other segments);
 *  - an unterminated last line that DOES parse is not torn, and is refused (that repair is an
 *    operator's decision, not this tool's).
 *
 * The repair, under the vault's writer lock (taken through `createAuditWriter`'s `lockAtCreate`,
 * so a live writer in this or another process refuses it), in this order:
 *  1. the log is fsync'd, and a `.meta` anchor one behind, or absent, is brought to the verified
 *     head (the genesis anchor for an empty chain) — before anything is appended, so no later
 *     failure can leave it in a state no run accepts (two behind, or absent on two events);
 *  2. the torn bytes are copied byte for byte to `audit/quarantine/<sha256>-<offset>.torn`
 *     (fsync'd, with its directory and the directory's parent);
 *  3. the log is truncated at the torn line's offset (fsync'd);
 *  4. a chained `audit.quarantine.torn_tail` event records the offset, length, SHA-256 and file.
 *
 * ONE CUT, ONE FILE, ONE RECORD. A cut is identified by its evidence file, named by the bytes'
 * digest AND the offset they were cut at — never by the digest alone: identical torn bytes can
 * recur (a short write of the same first bytes of a line), and each cut needs its own record. The
 * name is durable before the cut (step 2 precedes step 3), so a run that died between the cut and
 * its record is FINISHED by the next run: every quarantine file whose `file` no chained record
 * names gets one. Two cuts never share a name: once a cut at offset X is recorded, the record
 * itself lies past X, and the log only grows past it. (The one exception is declared in
 * LIMITATIONS.md: a cut whose record never landed, followed by byte-identical torn bytes at the
 * same offset, is indistinguishable on disk from one interrupted cut, and is recorded once.)
 *
 * Every refusal happens before the first write — in the read-only analysis, or in the link check on
 * the log's own descriptor immediately before the first repair write — so a refusal changes nothing.
 * The one exception is a hard link made to the log after that check: the cut-time check then
 * reports an INTERRUPTED repair ({@link AuditQuarantineInterruptedError}), naming what was done,
 * never a refusal. The crash-point sweep in the tests holds these properties over every durable
 * step and start state.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { GENESIS_HASH, VAULT_DIR } from "../shared/constants.js";
import {
	type AuditWriter,
	createAuditWriter,
	isUnsupportedDirSync,
	releaseAuditWriterForTeardown,
	writeAnchorAtomically,
} from "./chain.js";
import {
	acquireSmallFile,
	listDirectory,
	MAX_INVENTORY_NAMES,
	MAX_TAIL_BYTES,
	readLogTail,
	splitLines,
} from "./tail-read.js";
import {
	classifyAuditTail,
	eventHashHolds,
	MAX_ANCHOR_BYTES,
	parseLine,
	type TailState,
} from "./tail-state.js";

export const QUARANTINE_EVENT_KIND = "audit.quarantine.torn_tail";
const QUARANTINE_ACTOR = "usertrust-cli";

/** The chain is not in the one state this tool repairs; nothing was changed. */
export class AuditQuarantineRefusedError extends Error {
	constructor(why: string) {
		super(`audit quarantine refused: ${why}. Nothing was changed.`);
		this.name = "AuditQuarantineRefusedError";
	}
}

/**
 * A repair that had ALREADY WRITTEN when it found it could not go on, so it is NOT a refusal and
 * never claims that nothing changed: `done` names each step already taken. The one cause is
 * another name hard-linked to the log after the repair's pre-write check (another actor working on
 * the vault mid-repair; see AGENTS.md). The log is never cut then. Everything already done is a
 * state the next run continues from: remove the other name and run again.
 */
export class AuditQuarantineInterruptedError extends Error {
	readonly done: readonly string[];
	constructor(why: string, done: readonly string[]) {
		super(
			`audit quarantine interrupted: ${why}. The log was NOT cut. Already done: ${done.join("; ")}. Remove the other name and run \`usertrust audit quarantine-tail\` again to finish.`,
		);
		this.name = "AuditQuarantineInterruptedError";
		this.done = done;
	}
}

export interface TornTail {
	offset: number;
	length: number;
	sha256: string;
	file: string;
}

export interface QuarantineResult {
	dryRun: boolean;
	/** The torn tail found (and, unless a dry run, moved aside), or null when the log is clean. */
	torn: TornTail | null;
	/** The evidence `file` of each quarantine record appended (or, in a dry run, that would be) —
	 * the torn tail's, and any cut left unrecorded by an earlier run that died after truncating. */
	recorded: string[];
	/** Present (true) only when the `.meta` anchor was brought to the verified head (or, in a dry run,
	 * would be): from ONE BEHIND (an event landed, its anchor update failed), or from ABSENT on a
	 * chain of at most one event (the genesis anchor for an empty one). */
	anchorAdvanced?: true;
}

interface ChainEvent {
	kind?: unknown;
	data?: { file?: unknown };
	hash: string;
	previousHash?: unknown;
	sequence?: unknown;
}

/**
 * Verify every complete line from genesis; returns the events (throws a refusal). Each line is judged
 * before any field is read (`parseLine`): JSON that is not an event is refused by name. The one
 * absent-sequence policy: an event without `sequence` (written by an older version) is at its line,
 * and one with a sequence must carry exactly that. Hashing is total: an event canonicalization
 * refuses is a refusal here, never a throw.
 */
function verifyPrefix(lines: readonly Buffer[]): ChainEvent[] {
	const events: ChainEvent[] = [];
	let prev = GENESIS_HASH;
	for (let i = 0; i < lines.length; i++) {
		const line = parseLine(lines[i] as Buffer);
		if (line.kind === "unparseable") {
			throw new AuditQuarantineRefusedError(
				`the line after sequence ${i} does not parse — corruption before the tail`,
			);
		}
		if (line.kind === "non_event") {
			throw new AuditQuarantineRefusedError(
				`line ${i + 1} is JSON but not an audit event — corruption before the tail`,
			);
		}
		if (line.kind === "malformed") {
			throw new AuditQuarantineRefusedError(
				`line ${i + 1} carries a sequence that is not a positive safe integer — corruption before the tail`,
			);
		}
		const ok =
			line.previousHash === prev &&
			(line.sequence === undefined || line.sequence === i + 1) &&
			eventHashHolds(line.event);
		if (!ok) {
			throw new AuditQuarantineRefusedError(
				`sequence ${i + 1} does not verify — corruption before the tail`,
			);
		}
		events.push(line.event as unknown as ChainEvent);
		prev = line.hash;
	}
	return events;
}

/**
 * The anchor against the verified chain, as the writer's own classification decides it
 * (`tail-state.ts`): at the head (`MATCH`, or `FRESH` under a genesis anchor), ONE behind it (an event
 * landed and its anchor update failed: `ONE_PAST_ANCHOR`), or absent on a chain of at most one event
 * (`FRESH`, or the first event's `ONE_PAST_ANCHOR`). Every other state is refused before anything is
 * written: a recovery in progress, another segment, an anchor or a tail that cannot be read, and any
 * disagreement, which is a truncation, not a torn tail.
 */
function repairableAnchor(tail: TailState): "absent" | "head" | "oneBehind" {
	switch (tail.state) {
		case "FRESH":
			return tail.anchored === null ? "absent" : "head";
		case "MATCH":
			return "head";
		case "ONE_PAST_ANCHOR":
			return tail.anchored === null ? "absent" : "oneBehind";
		case "RECOVERY_PENDING":
			throw new AuditQuarantineRefusedError(
				"a recovery was interrupted (audit/quarantine/PENDING): it must finish before anything else repairs this vault",
			);
		case "SEGMENTED":
			throw new AuditQuarantineRefusedError("the chain has other segments");
		case "INVENTORY_UNREADABLE":
		case "LOG_UNREADABLE":
		case "LOG_NOT_REGULAR":
		case "TAIL_OVERSIZE":
		case "ANCHOR_UNREADABLE":
		case "TAIL_UNPARSEABLE":
		case "TAIL_NOT_AN_EVENT":
		case "TAIL_MALFORMED":
		case "CORRUPT_TAIL":
			throw new AuditQuarantineRefusedError(`${tail.note} (${tail.state})`);
		case "LOG_EMPTY_ANCHOR_RECORDS_EVENTS":
		case "ANCHOR_MISSING":
		case "HEAD_MISMATCH":
		case "FEWER_THAN_ANCHOR":
		case "UNCHAINED_PAST_ANCHOR":
		case "MORE_THAN_ONE_PAST_ANCHOR":
		case "SEQUENCE_EXHAUSTED":
			throw new AuditQuarantineRefusedError(
				`the .meta head anchor disagrees with the verified chain (${tail.state}: ${tail.note}) — a truncation, not a torn tail`,
			);
		default:
			return assertNever(tail.state);
	}
}

function assertNever(state: never): never {
	throw new Error(`quarantine: unhandled tail state ${String(state)}`);
}

/**
 * The log must be a REGULAR file with ONE name — never a symlink a hostile vault planted, and never
 * a hard-linked file: a cut truncates the inode, so it would cut every other name for it too.
 */
function assertRegularLog(logPath: string): void {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(logPath);
	} catch (err) {
		if (isCode(err, "ENOENT")) return;
		throw err;
	}
	if (st.isSymbolicLink() || !st.isFile()) {
		throw new AuditQuarantineRefusedError(
			"audit/events.jsonl is not a regular file (a symlink or other) — refusing to read or cut through it",
		);
	}
	assertSingleName(st.nlink);
}

function assertSingleName(nlink: number): void {
	if (nlink !== 1) {
		throw new AuditQuarantineRefusedError(
			`audit/events.jsonl has ${nlink} hard links — cutting it would cut every other name for the same file`,
		);
	}
}

/** Read every byte of an open fd from offset 0. */
function readAllFd(fd: number): Buffer {
	const size = fstatSync(fd).size;
	const buf = Buffer.alloc(size);
	let off = 0;
	while (off < size) {
		const n = readSync(fd, buf, off, size - off, off);
		if (n <= 0) break;
		off += n;
	}
	return buf.subarray(0, off);
}

/** fsync a DIRECTORY. Where the filesystem does not support it ({@link isUnsupportedDirSync}, as
 * the anchor writer treats it), it is best effort: refusing there would make the recovery path fail
 * at the same step on every retry and never complete. Any other error is real. */
function fsyncDir(path: string): void {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (err) {
		if (isUnsupportedDirSync(err)) return;
		throw err;
	}
	try {
		fsyncSync(fd);
	} catch (err) {
		if (!isUnsupportedDirSync(err)) throw err;
	} finally {
		closeSync(fd);
	}
}

/** `lstat` that answers `undefined` for a path that does not exist (a dangling symlink exists). */
function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch (err) {
		if (isCode(err, "ENOENT")) return undefined;
		throw err;
	}
}

function isCode(err: unknown, ...codes: string[]): boolean {
	return (
		err instanceof Error && "code" in err && codes.includes((err as { code?: string }).code ?? "")
	);
}

/** A cut's evidence file: `<sha256>-<offset>.torn`, the offset in canonical decimal. */
const TORN_NAME = /^([0-9a-f]{64})-(0|[1-9][0-9]{0,15})\.torn$/;

/** One cut: what was cut, where, and the evidence file that names it. */
interface Cut {
	sha256: string;
	offset: number;
	file: string;
}

function cutOf(sha256: string, offset: number): Cut {
	return { sha256, offset, file: `quarantine/${sha256}-${offset}.torn` };
}

/** `quarantine/` must be a REAL directory — never a symlink a hostile vault planted. */
function ensureRealQuarantineDir(qDir: string): void {
	try {
		mkdirSync(qDir, { mode: 0o700 });
	} catch (err) {
		if (!isCode(err, "EEXIST")) throw err;
	}
	const st = lstatSync(qDir);
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new AuditQuarantineRefusedError(
			"audit/quarantine is not a real directory (a symlink or a file) — refusing to write evidence through it",
		);
	}
}

/**
 * The bytes of an EXISTING quarantine file, accepted only if it is a REGULAR file (lstat — not a
 * symlink) whose content hashes to its own name. A planted or corrupt `*.torn` is refused, never
 * trusted by its filename.
 */
function verifiedEvidence(auditDir: string, cut: Cut): Buffer {
	const path = join(auditDir, cut.file);
	const st = lstatSync(path);
	if (st.isSymbolicLink() || !st.isFile()) {
		throw new AuditQuarantineRefusedError(
			`${cut.file} is not a regular file — refusing to trust or record it`,
		);
	}
	const bytes = readFileSync(path);
	if (createHash("sha256").update(bytes).digest("hex") !== cut.sha256) {
		throw new AuditQuarantineRefusedError(
			`${cut.file} does not hash to its name — refusing to record a digest the evidence does not have`,
		);
	}
	return bytes;
}

/**
 * Publish the torn bytes as evidence ATOMICALLY: write + fsync a PRIVATE temp file
 * (O_EXCL|O_NOFOLLOW, 0600) in quarantine/, then hard-link it to its cut's name — `link` never
 * replaces an existing name. A crash or ENOSPC mid-write leaves only a `.tmp` (ignored), never a
 * partial file under the final name that would block every retry. An existing final file is
 * accepted only via {@link verifiedEvidence}.
 */
function writeEvidence(auditDir: string, cut: Cut, tailBytes: Buffer): void {
	const qPath = join(auditDir, cut.file);
	const tmp = join(auditDir, "quarantine", `.${cut.sha256}-${cut.offset}.${randomUUID()}.tmp`);
	const tfd = openSync(
		tmp,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		try {
			let off = 0;
			while (off < tailBytes.length) {
				const n = writeSync(tfd, tailBytes, off, tailBytes.length - off);
				if (n <= 0) throw new Error("quarantine write made no progress");
				off += n;
			}
			fsyncSync(tfd);
		} finally {
			closeSync(tfd);
		}
		try {
			linkSync(tmp, qPath);
		} catch (err) {
			if (!isCode(err, "EEXIST")) throw err;
			verifiedEvidence(auditDir, cut); // an earlier run's identical evidence — idempotent
		}
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			/* already gone */
		}
	}
}

/** The most bytes a cut's record takes as a line: 561 with every number at 2^53, so with room to spare. */
export const MAX_RECORD_LINE_BYTES = 1024;

/**
 * Refused unless the writer could append the repair's records. Each cut is recorded by an append onto
 * the log as the cut leaves it, its first `cut` bytes, so this is checked before anything is changed.
 * The writer reads that log's last lines within MAX_TAIL_BYTES (`readLogTail`, its own read), and
 * takes the first record only if it fits beside the last line within the same bound (`appendEvent`'s
 * check); every record after it follows a record. A last line an older writer left over the bound for
 * one event would otherwise be cut, and its record then refused on this run and every one after.
 */
function assertRecordable(bytes: Buffer, cut: number): void {
	const left = readLogTail(bytes, cut);
	if (left.kind !== "tail") {
		throw new AuditQuarantineRefusedError(
			`the log as the cut leaves it has last lines over the ${MAX_TAIL_BYTES}-byte bound the writer reads them within (TAIL_OVERSIZE): the writer could not append the record of the cut`,
		);
	}
	const lastLineBytes = left.tail.lines.at(-1)?.length ?? 0;
	if (lastLineBytes + MAX_RECORD_LINE_BYTES + 3 > MAX_TAIL_BYTES) {
		throw new AuditQuarantineRefusedError(
			`the log's last line (${lastLineBytes} bytes) leaves no room for the record of the cut within the ${MAX_TAIL_BYTES}-byte bound the writer reads its last lines within: the writer could not append it`,
		);
	}
}

interface Plan {
	torn: TornTail | null;
	tailBytes: Buffer;
	toRecord: Cut[];
	anchor: "absent" | "head" | "oneBehind";
	head: { hash: string; sequence: number } | null;
}

/** READ-ONLY analysis (no lock, no mkdir, no write) — a dry run is exactly this. */
function analyse(auditDir: string, logPath: string, qDir: string, logBytes?: Buffer): Plan {
	if (!existsSync(auditDir)) {
		throw new AuditQuarantineRefusedError(`there is no audit directory at ${auditDir}`);
	}
	assertRegularLog(logPath);
	// `quarantine/` must be a real directory before anything about it is read (a dangling symlink there
	// included), so the refusal names it.
	const qSt = lstatOrUndefined(qDir);
	if (qSt !== undefined && (qSt.isSymbolicLink() || !qSt.isDirectory())) {
		throw new AuditQuarantineRefusedError(
			"audit/quarantine is not a real directory (a symlink or a file)",
		);
	}
	// The audit directory is the one the OS opens at its path, as the writer and every reader list it.
	const inventory = listDirectory(auditDir, MAX_INVENTORY_NAMES, true);
	const absent = logBytes === undefined && !existsSync(logPath);
	const bytes = logBytes ?? (absent ? Buffer.alloc(0) : readFileSync(logPath));
	// Split as bytes (`splitLines`): a log over V8's string limit is never decoded whole. `cut` is 0
	// when there is no newline at all.
	const { lines, trailing: tailBytes, trailingOffset: cut } = splitLines(bytes);
	// ONE classification, the writer's own: what this tool may repair is what the writer would go on
	// from, with nothing but a torn FRAGMENT after it.
	const tail = classifyAuditTail(
		{
			audit: inventory,
			quarantine: listDirectory(qDir),
			log: absent
				? { kind: "absent" }
				: {
						kind: "tail",
						tail: {
							lines: lines.slice(-2),
							fromStart: lines.length <= 2,
							count: lines.length,
							trailing: tailBytes,
							trailingOffset: cut,
						},
					},
			anchor: acquireSmallFile(`${logPath}.meta`, MAX_ANCHOR_BYTES),
		},
		"writer",
	);
	if (tail.state === "SEGMENTED" && inventory.kind === "ok") {
		const segments = inventory.names.filter((f) => f.endsWith(".jsonl") && f !== "events.jsonl");
		throw new AuditQuarantineRefusedError(`the chain has other segments (${segments.join(", ")})`);
	}
	let torn: TornTail | null = null;
	if (tail.torn !== null) {
		if (tail.torn.kind !== "fragment") {
			throw new AuditQuarantineRefusedError(
				"the unterminated last line parses as JSON — it is not a torn write. If it is a complete, genuine event, verify it and terminate it with a newline, then run `usertrust verify`; otherwise restore the log from a backup",
			);
		}
		const sha256 = createHash("sha256").update(tailBytes).digest("hex");
		torn = { ...cutOf(sha256, cut), length: tailBytes.length };
	}
	const anchor = repairableAnchor(tail);
	// The whole prefix, not only its tail: a torn tail is repaired only after a chain that verifies.
	const events = verifyPrefix(lines);
	const head =
		tail.found === null ? null : { hash: tail.found.hash, sequence: tail.found.sequence };

	// A cut is recorded iff a chained record names its evidence FILE (digest AND offset).
	const recordedFiles = new Set(
		events
			.filter((e) => e.kind === QUARANTINE_EVENT_KIND && typeof e.data?.file === "string")
			.map((e) => e.data?.file as string),
	);
	let pending: Cut[] = [];
	// Refused above if it is not a real directory (a dangling symlink included).
	if (qSt !== undefined) {
		const names = readdirSync(qDir).filter((f) => f.endsWith(".torn"));
		const cuts: Cut[] = [];
		for (const name of names) {
			const m = TORN_NAME.exec(name);
			const offset = m === null ? Number.NaN : Number(m[2]);
			if (m === null || !Number.isSafeInteger(offset)) {
				throw new AuditQuarantineRefusedError(
					`audit/quarantine holds a file not named <sha256>-<offset>.torn`,
				);
			}
			cuts.push(cutOf(m[1] as string, offset));
		}
		pending = cuts
			.filter((c) => !recordedFiles.has(c.file) && c.file !== torn?.file)
			.sort((a, b) => a.offset - b.offset || (a.sha256 < b.sha256 ? -1 : 1));
		for (const c of pending) {
			// An unrecorded cut was made at a line boundary of the log as it is now: the log was cut back
			// to that offset and has only grown by complete lines since.
			if (c.offset > cut || (c.offset > 0 && bytes[c.offset - 1] !== 0x0a)) {
				throw new AuditQuarantineRefusedError(
					`${c.file} names an offset that is not a line boundary of the verified log — not a cut this log could have had`,
				);
			}
			verifiedEvidence(auditDir, c);
		}
		// The torn tail's OWN evidence file may exist already (an earlier run died before the cut).
		// It is validated HERE, with the rest, so a bad one is refused before anything is changed —
		// never after the anchor has been advanced (and never only by a real run, not the dry run).
		if (torn !== null && lstatOrUndefined(join(auditDir, torn.file)) !== undefined) {
			verifiedEvidence(auditDir, cutOf(torn.sha256, torn.offset));
		}
	}
	const toRecord = torn === null ? pending : [...pending, cutOf(torn.sha256, torn.offset)];
	if (toRecord.length > 0) assertRecordable(bytes, cut);
	return { torn, tailBytes, toRecord, anchor, head };
}

/**
 * Quarantine the vault's torn tail (see the module doc). `vaultRoot` is the directory holding
 * `.usertrust/`. A dry run is READ-ONLY: no lock, no directory, no write — on a mistaken path it
 * refuses instead of creating a vault and calling it clean. A real run takes the vault's writer
 * lock for the whole repair (another live writer: `AuditWriterLockHeldError`) and re-analyses
 * under it. Throws {@link AuditQuarantineRefusedError} for any other state, and
 * {@link AuditQuarantineInterruptedError} if the log gains a hard link mid-repair.
 *
 * The lock is released as `withAuditWriterLock` releases its own: when the repair throws, its error
 * is the rejection and a lock left behind is only reported (a `USERTRUST_AUDIT_LOCK_LEFT` warning);
 * when it succeeds, a lock left behind rejects with `AuditLockReleaseError`.
 */
export async function quarantineTornTail(
	vaultRoot: string,
	opts: { dryRun?: boolean } = {},
): Promise<QuarantineResult> {
	const dryRun = opts.dryRun === true;
	const auditDir = join(vaultRoot, VAULT_DIR, "audit");
	const logPath = join(auditDir, "events.jsonl");
	const qDir = join(auditDir, "quarantine");
	if (dryRun) {
		const plan = analyse(auditDir, logPath, qDir);
		return {
			dryRun,
			torn: plan.torn,
			recorded: plan.toRecord.map((c) => c.file),
			...(plan.anchor === "oneBehind" || (plan.anchor === "absent" && existsSync(logPath))
				? { anchorAdvanced: true as const }
				: {}),
		};
	}
	if (!existsSync(auditDir)) {
		throw new AuditQuarantineRefusedError(`there is no audit directory at ${auditDir}`);
	}
	const writer = createAuditWriter(vaultRoot, { lockAtCreate: true });
	let result: QuarantineResult;
	try {
		result = await repairUnderLock(writer, auditDir, logPath, qDir);
	} catch (err) {
		releaseAuditWriterForTeardown(writer);
		throw err;
	}
	writer.release();
	return result;
}

/** The real run's repair, with the vault's writer lock held by `writer`. */
async function repairUnderLock(
	writer: AuditWriter,
	auditDir: string,
	logPath: string,
	qDir: string,
): Promise<QuarantineResult> {
	// ONE no-follow descriptor for the read AND the cut: the bytes analysed are the bytes
	// truncated, and neither can be redirected through a symlinked log.
	assertRegularLog(logPath);
	let lfd: number | undefined;
	try {
		lfd = openSync(logPath, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
	} catch (err) {
		if (!isCode(err, "ENOENT")) {
			if (isCode(err, "ELOOP")) {
				throw new AuditQuarantineRefusedError(
					"audit/events.jsonl is a symlink — refusing to read or cut through it",
				);
			}
			throw err;
		}
	}
	let plan: Plan;
	let anchorAdvanced = false;
	try {
		if (lfd !== undefined && !fstatSync(lfd).isFile()) {
			throw new AuditQuarantineRefusedError("audit/events.jsonl is not a regular file");
		}
		plan = analyse(auditDir, logPath, qDir, lfd === undefined ? Buffer.alloc(0) : readAllFd(lfd));
		// 1. The verified log is durable BEFORE any head derived from it is published (log before
		//    sidecar, as the writer orders it): a complete last line with its anchor one behind can be
		//    an append whose fsync failed or never ran.
		if (lfd !== undefined) {
			fsyncSync(lfd);
			// The AUTHORITATIVE link check: on the descriptor that is cut, immediately before the
			// repair's first write. A link made before this point is a clean refusal, nothing changed.
			assertSingleName(fstatSync(lfd).nlink);
		}
		// The anchor is brought to the verified head BEFORE anything is appended — from ONE BEHIND
		// (an event landed, its `.meta` update failed), or from ABSENT (a chain of at most one event;
		// an empty one gets the genesis anchor). A record appended first, and then a failed or
		// crashed anchor update, would leave it two behind, or absent on two events: states no run
		// accepts, so the repair would be refused for good.
		if (lfd !== undefined && (plan.anchor === "oneBehind" || plan.anchor === "absent")) {
			writeAnchorAtomically(
				`${logPath}.meta`,
				JSON.stringify({
					lastHash: plan.head?.hash ?? GENESIS_HASH,
					sequence: plan.head?.sequence ?? 0,
				}),
			);
			anchorAdvanced = true;
		}
		if (plan.torn !== null && lfd !== undefined) {
			// 2. The torn bytes, aside, byte for byte (idempotent by the cut's name), through a REAL
			//    directory, published atomically.
			ensureRealQuarantineDir(qDir);
			const cut = cutOf(plan.torn.sha256, plan.torn.offset);
			writeEvidence(auditDir, cut, plan.tailBytes);
			fsyncDir(qDir);
			// The NEW directory entry must be durable in its parent BEFORE the log is cut: a power
			// loss after the truncation must never lose the quarantine directory.
			fsyncDir(auditDir);
			// 3. The log, cut back to its last complete line — on the SAME descriptor, whose file must
			//    still have ONE name at the moment it is cut: truncating the inode cuts every name. A
			//    link made SINCE the pre-write check found the repair already writing, so this is not a
			//    refusal: it is reported as an interrupted repair, naming what was done.
			const nlink = fstatSync(lfd).nlink;
			if (nlink !== 1) {
				throw new AuditQuarantineInterruptedError(
					`audit/events.jsonl gained another hard link during the repair (${nlink} links) — cutting it would cut every other name for the same file`,
					[
						...(anchorAdvanced ? ["the .meta head anchor was brought to the verified head"] : []),
						`the torn bytes were saved as ${cut.file}`,
					],
				);
			}
			ftruncateSync(lfd, plan.torn.offset);
			fsyncSync(lfd);
		}
	} finally {
		if (lfd !== undefined) closeSync(lfd);
	}
	const { torn, toRecord } = plan;
	// 4. A chained record per cut not yet on the chain — length and digest from the VERIFIED bytes,
	//    never from the filename.
	for (const c of toRecord) {
		const length = verifiedEvidence(auditDir, c).length;
		await writer.appendEvent({
			kind: QUARANTINE_EVENT_KIND,
			actor: QUARANTINE_ACTOR,
			data: { sha256: c.sha256, length, offset: c.offset, file: c.file },
		});
	}
	const recorded = toRecord.map((c) => c.file);
	return anchorAdvanced
		? { dryRun: false, torn, recorded, anchorAdvanced: true }
		: { dryRun: false, torn, recorded };
}
