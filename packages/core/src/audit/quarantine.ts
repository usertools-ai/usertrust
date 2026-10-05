// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Torn-tail quarantine (#194.2): the ONE repair the audit chain admits, so failing closed on a
 * torn tail has a recovery path that is not hand-editing the evidence.
 *
 * A TORN TAIL is, positively: bytes after the log's last newline that do not parse as JSON —
 * an append that never completed (a crash, a short write). Nothing else qualifies:
 *  - every line before it must verify from genesis (parse, link, sequence, hash);
 *  - the `.meta` head anchor must be absent, at the verified head, or exactly one behind it at
 *    its predecessor (the states the writer itself leaves);
 *  - the chain must be the single `events.jsonl` (no other segments);
 *  - an unterminated last line that DOES parse is not torn, and is refused (that repair is an
 *    operator's decision, not this tool's).
 *
 * The repair, under the vault's writer lock: the torn bytes are copied byte for byte to
 * `audit/quarantine/<sha256>.torn` (fsync'd), the log is truncated at the torn line's offset
 * (fsync'd), and a chained `audit.quarantine.torn_tail` event records the offset, length,
 * SHA-256 and file. A run that died between the truncation and the event is FINISHED by the
 * next run: every quarantine file without its chained event gets one.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fsyncSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { GENESIS_HASH, VAULT_DIR } from "../shared/constants.js";
import { canonicalize } from "./canonical.js";
import { createAuditWriter } from "./chain.js";

export const QUARANTINE_EVENT_KIND = "audit.quarantine.torn_tail";
const QUARANTINE_ACTOR = "usertrust-cli";

/** The chain is not in the one state this tool repairs; nothing was changed. */
export class AuditQuarantineRefusedError extends Error {
	constructor(why: string) {
		super(`audit quarantine refused: ${why}. Nothing was changed.`);
		this.name = "AuditQuarantineRefusedError";
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
	/** Quarantine records appended (or, in a dry run, that would be) — the torn tail's, and any
	 * left unrecorded by an earlier run that died after truncating. */
	recorded: string[];
}

interface ChainEvent {
	kind?: unknown;
	data?: { sha256?: unknown };
	hash: string;
	previousHash?: unknown;
	sequence?: unknown;
}

/** Verify the complete lines `text` from genesis; returns the events (throws a refusal). */
function verifyPrefix(text: string): ChainEvent[] {
	const events: ChainEvent[] = [];
	let prev = GENESIS_HASH;
	let seq = 0;
	for (const raw of text.split("\n")) {
		if (raw === "") continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			throw new AuditQuarantineRefusedError(
				`the line after sequence ${seq} does not parse — corruption before the tail`,
			);
		}
		const { hash, ...rest } = e;
		const ok =
			typeof hash === "string" &&
			e.previousHash === prev &&
			e.sequence === seq + 1 &&
			createHash("sha256").update(canonicalize(rest)).digest("hex") === hash;
		if (!ok) {
			throw new AuditQuarantineRefusedError(
				`sequence ${seq + 1} does not verify — corruption before the tail`,
			);
		}
		events.push(e as unknown as ChainEvent);
		prev = hash as string;
		seq++;
	}
	return events;
}

function checkAnchor(metaPath: string, events: ChainEvent[]): void {
	if (!existsSync(metaPath)) return;
	let a: { lastHash?: unknown; sequence?: unknown };
	try {
		a = JSON.parse(readFileSync(metaPath, "utf-8")) as typeof a;
	} catch {
		throw new AuditQuarantineRefusedError("the .meta head anchor does not parse");
	}
	const head = events.at(-1);
	const headSeq = events.length;
	const isHead = a.sequence === headSeq && a.lastHash === (head?.hash ?? GENESIS_HASH);
	const oneBehind =
		head !== undefined && a.sequence === headSeq - 1 && a.lastHash === head.previousHash;
	if (!isHead && !oneBehind) {
		throw new AuditQuarantineRefusedError(
			`the .meta head anchor (sequence ${String(a.sequence)}) disagrees with the verified chain (sequence ${headSeq}) — a truncation, not a torn tail`,
		);
	}
}

/** fsync a DIRECTORY. Where the filesystem does not support it (EINVAL/ENOTSUP/EISDIR — as the
 * anchor writer treats it), it is best effort: refusing there would make the recovery path fail at
 * the same step on every retry and never complete (#196 r1 P2). Any other error is real. */
function fsyncDir(path: string): void {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (err) {
		if (isCode(err, "EISDIR", "EINVAL", "ENOTSUP", "EOPNOTSUPP")) return;
		throw err;
	}
	try {
		fsyncSync(fd);
	} catch (err) {
		if (!isCode(err, "EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR")) throw err;
	} finally {
		closeSync(fd);
	}
}

function isCode(err: unknown, ...codes: string[]): boolean {
	return (
		err instanceof Error && "code" in err && codes.includes((err as { code?: string }).code ?? "")
	);
}

const TORN_NAME = /^[0-9a-f]{64}\.torn$/;

/** `quarantine/` must be a REAL directory — never a symlink a hostile vault planted (#196 r1 P1). */
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
 * trusted by its filename (#196 r1 P2).
 */
function verifiedEvidence(path: string, sha: string): Buffer {
	const st = lstatSync(path);
	if (st.isSymbolicLink() || !st.isFile()) {
		throw new AuditQuarantineRefusedError(
			`quarantine/${sha}.torn is not a regular file — refusing to trust or record it`,
		);
	}
	const bytes = readFileSync(path);
	if (createHash("sha256").update(bytes).digest("hex") !== sha) {
		throw new AuditQuarantineRefusedError(
			`quarantine/${sha}.torn does not hash to its name — refusing to record a digest the evidence does not have`,
		);
	}
	return bytes;
}

/** Write the torn bytes as NEW evidence: O_EXCL (refuses any existing path, a symlink included) and
 * O_NOFOLLOW. An existing file is accepted only via {@link verifiedEvidence} with the same bytes. */
function writeEvidence(qPath: string, sha: string, tailBytes: Buffer): void {
	let qfd: number;
	try {
		qfd = openSync(
			qPath,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				(fsConstants.O_NOFOLLOW ?? 0),
			0o600,
		);
	} catch (err) {
		if (!isCode(err, "EEXIST")) throw err;
		verifiedEvidence(qPath, sha); // an earlier run's identical evidence — idempotent
		return;
	}
	try {
		let off = 0;
		while (off < tailBytes.length) {
			const n = writeSync(qfd, tailBytes, off, tailBytes.length - off);
			if (n <= 0) throw new Error("quarantine write made no progress");
			off += n;
		}
		fsyncSync(qfd);
	} finally {
		closeSync(qfd);
	}
}

interface Plan {
	torn: TornTail | null;
	tailBytes: Buffer;
	toRecord: string[];
}

/** READ-ONLY analysis (no lock, no mkdir, no write) — a dry run is exactly this (#196 r1 P2). */
function analyse(auditDir: string, logPath: string, qDir: string): Plan {
	if (!existsSync(auditDir)) {
		throw new AuditQuarantineRefusedError(`there is no audit directory at ${auditDir}`);
	}
	const segments = readdirSync(auditDir).filter(
		(f) => f.endsWith(".jsonl") && f !== "events.jsonl",
	);
	if (segments.length > 0) {
		throw new AuditQuarantineRefusedError(`the chain has other segments (${segments.join(", ")})`);
	}
	const bytes = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0);
	const cut = bytes.lastIndexOf(0x0a) + 1; // 0 when there is no newline at all
	const tailBytes = bytes.subarray(cut);
	let torn: TornTail | null = null;
	if (tailBytes.length > 0) {
		let parses = true;
		try {
			JSON.parse(tailBytes.toString("utf-8"));
		} catch {
			parses = false;
		}
		if (parses) {
			throw new AuditQuarantineRefusedError(
				"the unterminated last line parses as JSON — it is not a torn write",
			);
		}
		const sha256 = createHash("sha256").update(tailBytes).digest("hex");
		torn = { offset: cut, length: tailBytes.length, sha256, file: `quarantine/${sha256}.torn` };
	}
	const events = verifyPrefix(bytes.subarray(0, cut).toString("utf-8"));
	checkAnchor(`${logPath}.meta`, events);

	const recordedShas = new Set(
		events
			.filter((e) => e.kind === QUARANTINE_EVENT_KIND && typeof e.data?.sha256 === "string")
			.map((e) => e.data?.sha256 as string),
	);
	let pending: string[] = [];
	if (existsSync(qDir)) {
		const st = lstatSync(qDir);
		if (st.isSymbolicLink() || !st.isDirectory()) {
			throw new AuditQuarantineRefusedError(
				"audit/quarantine is not a real directory (a symlink or a file)",
			);
		}
		const names = readdirSync(qDir).filter((f) => f.endsWith(".torn"));
		const bad = names.filter((f) => !TORN_NAME.test(f));
		if (bad.length > 0) {
			throw new AuditQuarantineRefusedError(
				`audit/quarantine holds ${bad.length} file(s) not named <sha256>.torn`,
			);
		}
		pending = names
			.map((f) => f.slice(0, -".torn".length))
			.filter((sha) => !recordedShas.has(sha) && sha !== torn?.sha256)
			.sort();
		for (const sha of pending) verifiedEvidence(join(qDir, `${sha}.torn`), sha);
	}
	const toRecord = torn === null ? pending : [...pending, torn.sha256];
	return { torn, tailBytes, toRecord };
}

/**
 * Quarantine the vault's torn tail (see the module doc). `vaultRoot` is the directory holding
 * `.usertrust/`. A dry run is READ-ONLY: no lock, no directory, no write — on a mistaken path it
 * refuses instead of creating a vault and calling it clean. A real run takes the vault's writer
 * lock for the whole repair (another live writer: `AuditWriterLockHeldError`) and re-analyses
 * under it. Throws {@link AuditQuarantineRefusedError} for any other state.
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
		return { dryRun, torn: plan.torn, recorded: plan.toRecord };
	}
	if (!existsSync(auditDir)) {
		throw new AuditQuarantineRefusedError(`there is no audit directory at ${auditDir}`);
	}
	const writer = createAuditWriter(vaultRoot, { lockAtCreate: true });
	try {
		const { torn, tailBytes, toRecord } = analyse(auditDir, logPath, qDir);
		if (torn !== null) {
			// 1. The torn bytes, aside, byte for byte (idempotent by content name), through a REAL
			//    directory and an exclusive, no-follow create.
			ensureRealQuarantineDir(qDir);
			writeEvidence(join(auditDir, torn.file), torn.sha256, tailBytes);
			fsyncDir(qDir);
			// The NEW directory entry must be durable in its parent BEFORE the log is cut: a power
			// loss after the truncation must never lose the quarantine directory (#196 r1 P2).
			fsyncDir(auditDir);
			// 2. The log, cut back to its last complete line.
			const lfd = openSync(logPath, "r+");
			try {
				ftruncateSync(lfd, torn.offset);
				fsyncSync(lfd);
			} finally {
				closeSync(lfd);
			}
		}
		// 3. A chained record per quarantined tail not yet on the chain — length and digest from
		//    the VERIFIED bytes, never from the filename.
		for (const sha of toRecord) {
			const file = `quarantine/${sha}.torn`;
			const length = verifiedEvidence(join(auditDir, file), sha).length;
			await writer.appendEvent({
				kind: QUARANTINE_EVENT_KIND,
				actor: QUARANTINE_ACTOR,
				data: {
					sha256: sha,
					length,
					file,
					...(torn !== null && sha === torn.sha256 ? { offset: torn.offset } : {}),
				},
			});
		}
		return { dryRun, torn, recorded: toRecord };
	} finally {
		writer.release();
	}
}
