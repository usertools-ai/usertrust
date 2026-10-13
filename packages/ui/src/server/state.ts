// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	type BigIntStats,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import {
	deriveChainIntegrity,
	describeBudgetSource,
	isKnownBudget,
	loadBudgetConfig,
	readLedgerEvents,
	verifyVault,
} from "usertrust";
import { isHeaderSpend } from "../shared/aggregate.js";
import type { SummaryPayload } from "../shared/api.js";
import { type RemoteSettings, remoteSettings } from "../shared/kit.js";
import { type LedgerRow, toLedgerRows } from "../shared/rows.js";
import { TransferIndex } from "./verdicts.js";

export type { SummaryPayload } from "../shared/api.js";

export const ROW_CAP = 100_000;
const GENESIS = "0".repeat(64);

export interface LedgerState {
	rows: LedgerRow[];
	/** Every event by transfer, for each row's TRANSFER verdict; the live tail adds to it. */
	transfers: TransferIndex;
	summary: SummaryPayload;
	lastHash: string;
	/**
	 * Where the next read of `events.jsonl` starts: the log's size as the load's descriptor saw it (0 when absent), a
	 * fragment after its last newline included. Not the offset after that newline: the load already counted such a
	 * fragment as a malformed line, so a range read from there could join it to a later line onto a verdict that has
	 * counted it once; and a dead writer's fragment would then read as a grow on every check.
	 */
	byteOffset: number;
	/**
	 * Whether the load saw bytes after the log's last newline (a writer mid-line, or one that died mid-line). The load
	 * counted them as a malformed line, so a grow after such a load is a full reload, never an extension.
	 */
	pendingFragment: boolean;
	/**
	 * The identity of the `events.jsonl` that `lastHash` and `byteOffset` describe (`fileIdentity`), taken from the
	 * descriptor its bytes were read through. Undefined when the log was absent, when the filesystem gives no inode
	 * number, or when no load could read one unchanged file throughout: every grow is then a full reload.
	 */
	logId: string | undefined;
	/**
	 * The log's mtime and ctime as the descriptor that read it saw them (the load's, then each grow's). Where the log has
	 * no identity (inode 0), the watcher compares them to notice a same-size replacement. Undefined when the log was
	 * absent or no load read one unchanged file throughout.
	 */
	logTimes: LogTimes | undefined;
	/**
	 * Whether the audit directory EXISTED at this load (a `stat` of it succeeded), readable or not: once a server has
	 * seen it, its absence is a deletion, so a directory that was there and could not be listed still counts.
	 */
	auditDirPresent: boolean;
	/**
	 * Whether the audit directory existed AND could be listed at this load. False when it is absent and when it is
	 * unreadable alike: a verdict raised from no readable log cannot be extended by an append, only re-derived.
	 */
	auditDirReadable: boolean;
	/**
	 * The audit directory's identity at this load (`fileIdentity`), or undefined when it is absent, cannot be statted,
	 * or reports inode 0. The caller records the first one it sees and passes it to every later load (`auditDirId`).
	 */
	auditDirId: string | undefined;
	/**
	 * Whether this load found a deletion: the audit directory is absent after the process had seen it, or replaced by
	 * another directory, or the log lost or changed events an earlier load held, or an earlier load's deletion was carried
	 * in (`loadState`'s `deletionSeen`). The caller latches `deletionCauses` for the life of the process.
	 */
	deletionDetected: boolean;
	/** What this load's `deletionDetected` rests on, the carried-in causes included: one chain error per cause. */
	deletionCauses: DeletionCause[];
	/**
	 * The events this load read: their number and the last one's hash (`LogHead`). Undefined when no pass of the load read
	 * the vault unchanged throughout, or when its read failed (an audit directory or audit file that could not be read):
	 * the caller then keeps the head it had, because a read that failed is not evidence of what the vault holds.
	 */
	head: LogHead | undefined;
}

/**
 * Why a deletion was detected: "directory", the audit directory disappeared or was replaced by another one; "events",
 * the log no longer holds events an earlier load or verified append held.
 */
export type DeletionCause = "directory" | "events";

/** A file's modification and status-change times, in nanoseconds, as one `fstat` saw them. */
export interface LogTimes {
	mtimeNs: bigint;
	ctimeNs: bigint;
}

/** The events a load or a verified append left the dashboard holding: how many, and the hash of the last one. */
export interface LogHead {
	count: number;
	hash: string | undefined;
}

// Presence of the mirror file is not a verdict — a planted empty/junk file
// must not read as "anchored". verifyVaultWithAnchors needs a caller-pinned
// genesis the UI server does not have.
function anchorFile(vaultPath: string): "present" | "absent" {
	return existsSync(join(vaultPath, "audit", "anchors", "anchors.jsonl")) ? "present" : "absent";
}

/**
 * The summary's budget fields, read from the vault: the governor's record of what it enforces, else the vault config.
 * The server re-reads them when either file changes (a governor starting writes the record OUTSIDE `audit/`).
 */
export function budgetSummary(
	vaultPath: string,
	spentUt: number,
): Pick<
	SummaryPayload,
	"budget" | "budgetSource" | "budgetWrittenAt" | "budgetProvenance" | "remainingUt"
> {
	const config = loadBudgetConfig(vaultPath);
	const budget = isKnownBudget(config.source) ? config.budget : null;
	return {
		budget,
		budgetSource: config.source,
		budgetWrittenAt: config.writtenAt,
		budgetProvenance: describeBudgetSource(config),
		remainingUt: budget === null ? null : budget - spentUt,
	};
}

/**
 * The vault config's `remote` section. A missing or unreadable config leaves every remote load off. The path is
 * statted FIRST: opening a FIFO planted there would block this process (at startup, and on every config poll).
 */
export function readRemoteSettings(vaultPath: string): RemoteSettings {
	const path = join(vaultPath, "usertrust.config.json");
	try {
		if (!statSync(path).isFile()) return remoteSettings(undefined);
		return remoteSettings(JSON.parse(readFileSync(path, "utf-8")) as unknown);
	} catch {
		return remoteSettings(undefined);
	}
}

/**
 * What the vault's audit directory is: `dir` is "absent", "present", or the error code of a check that could not be
 * made, and `listError` is the error code of listing a PRESENT directory (undefined when it lists).
 * Only ENOENT is absence: `existsSync` is false on EACCES (no search permission on the vault) and on ENOTDIR too, and
 * both readers then see no events, so treating those as absence showed a vault this process cannot read as empty and
 * clean. Presence is decided by `stat` alone and listing is kept apart from it: a directory that exists and cannot be
 * listed (mode 111) is still there, so deleting it later is a deletion and never a first run.
 */
function auditDirState(vaultPath: string): {
	dir: "absent" | "present" | string;
	listError?: string;
	id?: string | undefined;
} {
	const auditPath = join(vaultPath, "audit");
	let id: string | undefined;
	try {
		id = fileIdentity(statSync(auditPath, { bigint: true }));
	} catch (err) {
		return { dir: statFailure(vaultPath, auditPath, err) };
	}
	// A directory this process may stat but not list (no read permission on it) is present and unreadable: both readers
	// see no events, and the verifier names it "could not be enumerated". Listing it here says so as an unreadable read.
	try {
		readdirSync(auditPath);
	} catch (err) {
		return {
			dir: "present",
			listError: (err as NodeJS.ErrnoException).code ?? "unknown error",
			id,
		};
	}
	return { dir: "present", id };
}

/** "absent" for a path that is really missing, else the code (or reason) the check could not be made. */
function statFailure(vaultPath: string, auditPath: string, err: unknown): string {
	const code = (err as NodeJS.ErrnoException).code;
	if (code !== "ENOENT") return code ?? "unknown error";
	// statSync follows links, so a link whose target is missing (an unmounted volume, say) throws ENOENT too: the vault
	// is out of reach, not absent. Either link counts: the audit entry or the vault directory itself.
	if (isDanglingLink(auditPath) || isDanglingLink(vaultPath))
		return "a symbolic link on its path has no target";
	return "absent";
}

/** True for a symbolic link that does not resolve; false for anything else, including a path that does not exist. */
function isDanglingLink(path: string): boolean {
	try {
		if (!lstatSync(path).isSymbolicLink()) return false;
	} catch {
		return false;
	}
	try {
		statSync(path);
		return false;
	} catch {
		return true;
	}
}

/** `verifyVault`'s error for a vault with no audit directory: no evidence either way, not tampering. */
const NO_AUDIT_DIR = "Audit directory not found:";

/** What a latched deletion's error tells the operator to do when the change was theirs. */
const RESTART_REMEDY = "If you restored or replaced this vault on purpose, restart the dashboard.";

/**
 * The chain error each cause of a deletion detected while the dashboard was open carries, on every load for as long as
 * it is latched. Each names the cause and the remedy: a legitimate restore reads as a deletion until a restart.
 */
const DELETION_ERRORS: Record<DeletionCause, string> = {
	directory: `The audit directory was replaced or deleted while this dashboard was open (deletion detected). ${RESTART_REMEDY}`,
	events: `The audit log lost or changed events it held while this dashboard was open (deletion detected). ${RESTART_REMEDY}`,
};

/**
 * `auditDirSeen`: whether this process has ever seen the vault's audit directory. A first run has none; a directory that
 * existed and is gone was deleted, whatever it held (events, malformed lines, nothing), and must never read as a first
 * run. A count of parsed events missed a log of malformed lines only, which verification fails with zero events.
 *
 * `deletionSeen`: the causes of a deletion an earlier load of this process already detected. The caller latches the
 * returned `deletionCauses` and passes them back, and they hold for the life of the process: the deletion error stays in
 * `summary.chain.errors` and the chain stays invalid whatever the directory holds afterwards, because a directory
 * recreated with a fresh valid chain is not the one that was destroyed. Its events may still load and show as rows; only
 * the verdict is fixed. A first run (never seen, nothing deleted) is unaffected.
 *
 * `auditDirId`: the audit directory's identity when this process first saw it (`fileIdentity`). A present directory
 * with a different identity is another directory in its place (removed, and a fresh vault renamed in, between two
 * checks): a deletion, as its absence would be. Unknown on either side (none recorded, inode 0) proves nothing.
 *
 * `head`: the events the dashboard held before this load (`LogHead`). The events read now must include the head's hash
 * and number at least its count; a log that does not was truncated, emptied or replaced by another chain, whatever its
 * own verdict. Membership, not position: in file order (events without `sequence`) `events.jsonl` is read before the
 * rotated segments, so a rotation moves positions. A pass that fails it is read again, and the deletion is latched only
 * when the failure persists on a pass that read the vault unchanged throughout (`consistent`): a read that raced a
 * rotation written in two steps (a segment, then `events.jsonl`) can see events missing that never were. Containment is
 * judged only on a read that SUCCEEDED (the audit directory present and listable, and every audit file it reads opened
 * or absent): a directory or file that could not be read gives no events, which is not evidence that events are gone.
 * Such a read never latches a deletion and returns no head; its own verdict (unreadable, invalid) stands, and a later
 * read that succeeds is judged against the head the caller kept.
 */
export function loadState(
	vaultPath: string,
	rowCap: number = ROW_CAP,
	auditDirSeen = false,
	deletionSeen: readonly DeletionCause[] = [],
	auditDirId: string | undefined = undefined,
	head: LogHead | undefined = undefined,
): LedgerState {
	// Whether an earlier pass of this load already failed containment: the next consistent pass that fails it confirms.
	let failedBefore = false;
	// A retry redoes the WHOLE load, so one pass's identity is never paired with another pass's events, verdict or offset.
	for (let retry = 0; ; retry++) {
		const pass = loadPass(
			vaultPath,
			rowCap,
			auditDirSeen,
			deletionSeen,
			auditDirId,
			head,
			failedBefore,
		);
		// A consistent pass that holds the head, or one that confirms a failure (latched inside the pass), is the answer.
		if (pass.consistent && (pass.contained || failedBefore)) return pass.state;
		const unconfirmed = pass.consistent && !pass.contained;
		// Still changing: every later grow is a full reload until a load reads one unchanged file throughout. A failure
		// never read consistently twice latches nothing, and its verdict stands on its own. A consistent first failure on
		// the last retry still gets its confirming pass.
		if (retry >= LOAD_RETRIES && !unconfirmed)
			return { ...pass.state, logId: undefined, logTimes: undefined, head: undefined };
		failedBefore ||= !pass.contained;
		// What a discarded pass OBSERVED about the directory stays observed (a recreated directory must not undo a
		// deletion it saw); only what it read from the file (events, verdict, offset, identity) is rebuilt.
		auditDirSeen ||= pass.state.auditDirPresent;
		auditDirId ??= pass.state.auditDirId;
		deletionSeen = pass.state.deletionCauses;
	}
}

/** How many times a load whose log changed under it is redone before its identity is left unknown. */
const LOAD_RETRIES = 3;

/**
 * Test-only: called between a load's steps, so a row can change the log at a chosen point. Not exported from the
 * package (its entry point is `server.js`).
 */
export const loadSeam: {
	afterDescriptor?: (() => void) | undefined;
	afterReaders?: (() => void) | undefined;
} = {};

function loadPass(
	vaultPath: string,
	rowCap: number,
	auditDirSeen: boolean,
	deletionSeen: readonly DeletionCause[],
	auditDirId: string | undefined,
	head: LogHead | undefined,
	confirming: boolean,
): { state: LedgerState; consistent: boolean; contained: boolean } {
	const logPath = join(vaultPath, "audit", "events.jsonl");
	const snapshot = snapshotLog(logPath);
	const metaPath = `${logPath}.meta`;
	const unreadBefore = readFailure(logPath) ?? readFailure(metaPath);
	const segmentsBefore = segmentsFingerprint(join(vaultPath, "audit"));
	loadSeam.afterDescriptor?.();
	const events = readLedgerEvents(vaultPath);
	const integrity = deriveChainIntegrity(events);
	const vault = verifyVault(vaultPath);
	loadSeam.afterReaders?.();
	// The readers read by PATH. Only if the path still names the file the descriptor read, with the same size and mtime,
	// do `lastHash`, `byteOffset` and `logId` all describe one file; otherwise (a rename, an append) the load is redone.
	// The rotated segments are bracketed too (the directory's listing, and each segment's identity and size), so a
	// containment failure is latched only on a read of one unchanged set of files.
	const segmentsAfter = segmentsFingerprint(join(vaultPath, "audit"));
	const consistent =
		(snapshot === undefined || snapshot.fingerprint === pathFingerprint(logPath)) &&
		segmentsBefore.fingerprint === segmentsAfter.fingerprint;
	const { dir: auditDir, listError, id: dirId } = auditDirState(vaultPath);
	// Whether the readers' read SUCCEEDED: the audit directory present and listable, and every audit file they read
	// (`events.jsonl`, each rotated segment, the `.meta` anchor) opened without an error, before and after them. A file
	// that is absent (ENOENT) was read successfully as "nothing there", so a log and anchor removed from a directory that
	// stays is still a read of the vault. An unreadable directory or file gives no events, and a read that failed is not
	// evidence that events are gone: its verdict stands on its own (the readability errors fail it), and it is never
	// compared with the head, nor recorded as one.
	const readSucceeded =
		auditDir === "present" &&
		listError === undefined &&
		unreadBefore === undefined &&
		segmentsBefore.unreadable === undefined &&
		segmentsAfter.unreadable === undefined &&
		(readFailure(logPath) ?? readFailure(metaPath)) === undefined;
	// Containment is evaluated only on a read that succeeded; a failed one holds the head trivially, so it is neither
	// read again for a confirmation nor latched.
	const contained = !readSucceeded || holdsHead(events, head);
	let spentUt = 0;
	for (const e of events) {
		if (isHeaderSpend(e.kind, e.data.cost)) spentUt += e.data.cost;
	}

	// A project before its first governed call has no audit directory, and verifyVault reports exactly that, which
	// the dashboard showed as a red CHAIN INTEGRITY FAILURE. That one error, with no events and the directory really
	// absent, is dropped; every other error stands. A log deleted while its anchor records events keeps its
	// "deletion detected" (the anchor lives in the audit directory, so that directory exists), and if verifyVault ever
	// words the missing-directory error differently, it is kept too: the vault reads as broken, never as clean.
	// The exception is for an audit directory this process has never seen: one deleted while the dashboard was open
	// (the live tail resyncs, and the reload finds it gone) is evidence destroyed, not a first run.
	// A deletion is latched: once detected it is carried by every later load, so a directory recreated in its place
	// (even one holding a valid chain) cannot clear the evidence that the original was destroyed. Another directory at
	// the path (a different identity) is the same evidence, however fast it was swapped in.
	const replaced = auditDirId !== undefined && dirId !== undefined && dirId !== auditDirId;
	const causes = new Set(deletionSeen);
	if ((auditDir === "absent" && auditDirSeen) || replaced) causes.add("directory");
	// Only a CONFIRMING pass that read the vault unchanged throughout latches a containment failure. A directory gone or
	// replaced lost its events with it, so that deletion is named once, by its directory.
	if (confirming && consistent && !contained && !causes.has("directory")) causes.add("events");
	const deletionCauses = (["directory", "events"] as const).filter((c) => causes.has(c));
	const deletionDetected = deletionCauses.length > 0;
	const noAuditDir =
		events.length === 0 && auditDir === "absent" && !auditDirSeen && !deletionDetected;
	const readErrors = noAuditDir
		? vault.errors.filter((e) => !e.startsWith(NO_AUDIT_DIR))
		: auditDir === "absent" || (auditDir === "present" && listError === undefined)
			? vault.errors
			: // verifyVault calls an unreadable directory "not found": say what actually stopped the read.
				[
					...vault.errors,
					`Audit directory could not be read (${listError ?? auditDir}): this vault was not verified`,
				];
	const errors = [...readErrors, ...deletionCauses.map((c) => DELETION_ERRORS[c])];
	const valid =
		integrity.valid && !deletionDetected && (vault.valid || (noAuditDir && errors.length === 0));

	const truncated = events.length > rowCap;
	const visible = truncated ? events.slice(-rowCap) : events;
	// Integrity indexes are relative to the full ordered list; re-derive for the slice.
	const offset = events.length - visible.length;
	const sliceIntegrity =
		integrity.breakIndex === null
			? integrity
			: { valid: false, breakIndex: Math.max(0, integrity.breakIndex - offset) };
	// Every event, not only the visible slice: a visible row's verdict can rest on an earlier record of its transfer.
	const transfers = new TransferIndex();
	transfers.add(events);
	const rows = toLedgerRows(visible, sliceIntegrity, transfers.verdictOf);

	const state: LedgerState = {
		rows,
		transfers,
		summary: {
			vaultPath,
			...budgetSummary(vaultPath, spentUt),
			spentUt,
			chain: {
				events: events.length,
				valid,
				empty: valid && events.length === 0,
				breakIndex: integrity.breakIndex,
				errors,
			},
			anchorFile: anchorFile(vaultPath),
			remote: readRemoteSettings(vaultPath),
			rowCount: rows.length,
			truncated,
		},
		lastHash: events.at(-1)?.hash ?? GENESIS,
		byteOffset: snapshot?.byteOffset ?? 0,
		pendingFragment: snapshot?.pendingFragment ?? false,
		logId: snapshot?.id,
		logTimes: snapshot?.times,
		auditDirPresent: auditDir === "present",
		auditDirReadable: auditDir === "present" && listError === undefined,
		auditDirId: dirId,
		deletionDetected,
		deletionCauses,
		head: readSucceeded ? { count: events.length, hash: headHash(events) } : undefined,
	};
	return { state, consistent, contained };
}

/** The last event's hash, when it has one: what a later load must still hold. */
function headHash(events: readonly { hash?: unknown }[]): string | undefined {
	const hash = events.at(-1)?.hash;
	return typeof hash === "string" ? hash : undefined;
}

/**
 * Whether `events` still hold `head`: at least its count, and its hash among them (anywhere: a rotation moves positions
 * in file order). No head, or a head of no events, holds trivially.
 */
function holdsHead(events: readonly { hash?: unknown }[], head: LogHead | undefined): boolean {
	if (head === undefined || head.count === 0) return true;
	if (events.length < head.count) return false;
	return head.hash === undefined || events.some((e) => e.hash === head.hash);
}

/**
 * The rotated segments as the readers would gather them: every `*.jsonl` but `events.jsonl` in the audit directory,
 * sorted, each with its identity, size and mtime, read through a descriptor so a segment that cannot be OPENED records
 * its error code. A listing or open that fails is part of the fingerprint, so two reads that both fail the same way
 * compare equal and a read that fails differently does not. `unreadable` is the first error code other than ENOENT (a
 * segment removed after the listing was read as absent, which is a read), undefined when every segment opened.
 */
function segmentsFingerprint(auditPath: string): {
	fingerprint: string;
	unreadable: string | undefined;
} {
	let names: string[];
	try {
		names = readdirSync(auditPath)
			.filter((n) => n.endsWith(".jsonl") && n !== "events.jsonl")
			.sort();
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "unknown";
		return { fingerprint: `list:${code}`, unreadable: code };
	}
	let unreadable: string | undefined;
	const fingerprint = names
		.map((n) => {
			let fd: number;
			try {
				fd = openSync(join(auditPath, n), "r");
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code ?? "unknown";
				if (code !== "ENOENT") unreadable ??= code;
				return `${n}=${code}`;
			}
			try {
				return `${n}=${fingerprintOf(fstatSync(fd, { bigint: true }))}`;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code ?? "unknown";
				unreadable ??= code;
				return `${n}=${code}`;
			} finally {
				closeSync(fd);
			}
		})
		.join("|");
	return { fingerprint, unreadable };
}

/**
 * The error code of opening `path` for reading, or undefined when it opens or is absent (ENOENT): an absent file is
 * read as "nothing there", which is a read; a file that exists and cannot be opened (EACCES, say) is a read that failed.
 */
function readFailure(path: string): string | undefined {
	try {
		closeSync(openSync(path, "r"));
		return undefined;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? undefined : (code ?? "unknown error");
	}
}

/**
 * A file's (or the audit directory's) identity: device and inode number, plus its birth time where the platform reports
 * one (so a log deleted and recreated on an inode number the filesystem reused still reads as another file). BigInt fields throughout: Windows
 * file ids exceed 2^53. Undefined for inode 0, which some filesystems report for every file.
 *
 * What it cannot see: a rewrite in place (same inode) that does not shorten the log, and a delete-and-recreate that
 * reuses the inode number where no birth time is reported. The load's bracket compares size and mtime as well, and
 * mtime is coarse on every filesystem (a few milliseconds on Linux's local filesystems, 1 s on HFS+, 2 s on FAT, coarser
 * on some network mounts), so a same-size rewrite within one tick passes it too.
 */
export function fileIdentity(st: BigIntStats): string | undefined {
	if (st.ino === 0n) return undefined;
	return st.birthtimeNs === 0n ? `${st.dev}:${st.ino}` : `${st.dev}:${st.ino}:${st.birthtimeNs}`;
}

/** The identity plus the size and mtime: what must not change between a load's descriptor read and its by-path reads. */
function fingerprintOf(st: BigIntStats): string {
	return `${st.dev}:${st.ino}:${st.birthtimeNs}:${st.size}:${st.mtimeNs}`;
}

function pathFingerprint(logPath: string): string | undefined {
	try {
		return fingerprintOf(statSync(logPath, { bigint: true }));
	} catch {
		return undefined;
	}
}

/**
 * The log as one descriptor sees it: its identity, its fingerprint, its size, and whether bytes follow its last newline.
 * Undefined when it cannot be read (absent, say): the offset is then 0, so every grow is a full reload.
 */
function snapshotLog(logPath: string):
	| {
			id: string | undefined;
			fingerprint: string;
			byteOffset: number;
			pendingFragment: boolean;
			times: LogTimes;
	  }
	| undefined {
	let fd: number;
	try {
		fd = openSync(logPath, "r");
	} catch {
		return undefined;
	}
	try {
		const st = fstatSync(fd, { bigint: true });
		const size = Number(st.size);
		return {
			id: fileIdentity(st),
			fingerprint: fingerprintOf(st),
			byteOffset: size,
			pendingFragment: afterLastNewline(fd, size) < size,
			times: { mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs },
		};
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** The offset just after the last newline in `[0, size)` of `fd`, read backwards from the end; 0 when there is none. */
function afterLastNewline(fd: number, size: number): number {
	const chunk = Buffer.alloc(64 * 1024);
	let end = size;
	while (end > 0) {
		const start = Math.max(0, end - chunk.length);
		const buf = readRange(fd, start, end, chunk);
		const at = buf.lastIndexOf(0x0a);
		if (at !== -1) return start + at + 1;
		end = start;
	}
	return 0;
}

/** Reads `[start, end)` of `fd` into `into` (or a new buffer), looping on short reads; stops early at end of file. */
function readRange(fd: number, start: number, end: number, into?: Buffer): Buffer {
	const buf = into ?? Buffer.alloc(end - start);
	let filled = 0;
	while (filled < end - start) {
		const n = readSync(fd, buf, filled, end - start - filled, start + filled);
		if (n === 0) break;
		filled += n;
	}
	return buf.subarray(0, filled);
}

export type Appended =
	| { kind: "bytes"; buf: Buffer; times: LogTimes }
	| { kind: "shrunk" }
	| { kind: "replaced" }
	| { kind: "unknown" };

/**
 * The bytes appended to the log after `byteOffset`, read through one descriptor whose identity is checked against
 * `logId` (the identity the last load recorded): only `[byteOffset, size)` is read, never the prefix this process has
 * already verified, with the log's timestamps as that descriptor saw them. "replaced" is another file at the path, "shrunk" a log shorter than the offset, and "unknown" an
 * identity that cannot be compared (none recorded, or inode 0); each calls for a full reload. A read that throws
 * (the log absent, unreadable) propagates.
 */
export function readAppended(
	logPath: string,
	byteOffset: number,
	logId: string | undefined,
): Appended {
	const fd = openSync(logPath, "r");
	try {
		const st = fstatSync(fd, { bigint: true });
		const id = fileIdentity(st);
		if (id === undefined || logId === undefined) return { kind: "unknown" };
		if (id !== logId) return { kind: "replaced" };
		const size = Number(st.size);
		if (size < byteOffset) return { kind: "shrunk" };
		return {
			kind: "bytes",
			buf: readRange(fd, byteOffset, size),
			times: { mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs },
		};
	} finally {
		closeSync(fd);
	}
}
