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
	 * another directory, or the vault lost the event the dashboard last verified, or an earlier load's deletion was carried
	 * in (`loadState`'s `deletionSeen`). The caller latches `deletionCauses` for the life of the process.
	 */
	deletionDetected: boolean;
	/** What this load's `deletionDetected` rests on, the carried-in causes included: one chain error per cause. */
	deletionCauses: DeletionCause[];
	/**
	 * What this load verified (`LogHead`): the hash of the chain's tip (`tipHash`), and whether the vault held any
	 * evidence. Set only when the load is `verified`, and, when the caller passed no head (nothing verified yet), from
	 * any read of the whole vault that did not latch, so a first read that is already broken still has its events held
	 * against a later replacement. Undefined otherwise: when no pass read the vault unchanged throughout, when its read
	 * failed, when its own check latched a deletion of events, or when its chain did not verify against a head the
	 * caller already had. The caller then keeps the head it had: a read that failed is not evidence of what the vault
	 * holds, and a chain that did not verify is not one to judge later loads against (another chain appended to a
	 * verified one, then the verified events removed, would otherwise leave only the other chain, reading valid).
	 */
	head: LogHead | undefined;
	/**
	 * Whether this load VERIFIED the vault: it read the vault whole (`loadSucceeded`), and that read's own verdict is
	 * valid, before any deletion cause (carried in or found by this load) is added. The caller keeps it as the last full
	 * load's outcome: while it is false, no append is extended onto the state, and a load is the only thing that moves
	 * the head.
	 */
	verified: boolean;
	/**
	 * Whether this load read the vault whole: one pass read it unchanged throughout, and its reads succeeded (an absent
	 * audit directory is a read of nothing). The caller keeps it as the last full load's outcome: while it is false, no
	 * append is extended onto the state and every check reloads in full, until a load succeeds again.
	 */
	loadSucceeded: boolean;
}

/**
 * Why a deletion was detected: "directory", the audit directory disappeared or was replaced by another one; "events",
 * the vault no longer holds the event the dashboard last verified, or holds nothing where it held something (`LogHead`).
 */
export type DeletionCause = "directory" | "events";

/** A file's modification and status-change times, in nanoseconds, as one `fstat` saw them. */
export interface LogTimes {
	mtimeNs: bigint;
	ctimeNs: bigint;
}

/**
 * What the dashboard last verified of the log, and what every later full load must still hold.
 *
 * `verifiedHash` is the hash of the chain's tip as a full load that verified read it (`tipHash`: by linkage, never by
 * reading order), or of the last event a verified append added while the last full load had verified. Each event's
 * hash commits to every event before it, so an honest later log still holds an event with that hash, whatever was
 * appended or rotated since; one that does not was truncated, emptied or replaced by another chain. Undefined when the
 * load read no event with a hash.
 *
 * `hadEvidence` is whether the vault held anything: log bytes in `events.jsonl` or in any rotated segment (malformed
 * lines included), an anchor, or events. A log of malformed lines only has no event to remember, so its removal is seen
 * by this instead, wherever its bytes are: a rotation that moves them into a segment still holds them.
 *
 * No count and no position: a load that races a rotation written in two steps reads some events twice, and a count
 * taken there is larger than the finished rotation's; in file order a rotation moves positions.
 */
export interface LogHead {
	verifiedHash: string | undefined;
	hadEvidence: boolean;
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
 * `head`: what the dashboard last verified (`LogHead`). A load fails the check when the head names a verified hash and
 * no event read now has it, or when the head had evidence and this read found no log bytes, no anchor and no events:
 * the log was truncated, emptied or replaced by another chain, whatever its own verdict. The CHECK runs on any read that
 * succeeded, valid or not; the head this load RETURNS for later loads is set only from a read whose chain verified
 * (`LedgerState.head`). Membership only, never a count
 * or a position: a rotation moves positions, and a load that raced a rotation written in two steps (a segment, then
 * `events.jsonl`) reads events twice. A pass that fails it is read again, and the deletion is latched only when a
 * second pass that read the vault unchanged throughout (`consistent`) fails it too: a log renamed away and back during
 * one pass's read gives that pass no events that were ever missing. The check is judged only on a read that SUCCEEDED,
 * as the pass's own reads report it: the audit directory present and listable, the events' reader (`readLedgerEvents`,
 * through `onReadError`) naming no directory, log or segment it could not read, and the pass's read of the `.meta`
 * anchor not failing; an absent file (ENOENT) is a read of nothing. No separate probe of the files decides it, since a
 * permission change between a probe and the read would let a failed read pass. A directory or file that could not be
 * read gives no events, which is not evidence that events are gone. Such a read never latches a deletion and returns no
 * head; its own verdict (unreadable, invalid) stands, and a later read that succeeds is judged against the head the
 * caller kept.
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
			return {
				...pass.state,
				logId: undefined,
				logTimes: undefined,
				head: undefined,
				loadSucceeded: false,
				verified: false,
				summary: { ...pass.state.summary, verifiedAt: null },
			};
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
	/** Called at the end of each pass with what it decided. */
	afterPass?:
		| ((pass: { consistent: boolean; readSucceeded: boolean; contained: boolean }) => void)
		| undefined;
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
	const segmentsBefore = segmentsState(join(vaultPath, "audit"));
	loadSeam.afterDescriptor?.();
	// What the pass's own reads could not read: the error codes the events' reader reported (a directory it could not
	// stat or list, a log or segment it could not read), and the anchor's read. ENOENT is absence, which is a read.
	const unread: string[] = [];
	const events = readLedgerEvents(vaultPath, { onReadError: (_path, code) => unread.push(code) });
	const anchor = readAnchor(`${logPath}.meta`);
	if (anchor.error !== undefined) unread.push(anchor.error);
	const integrity = deriveChainIntegrity(events);
	const vault = verifyVault(vaultPath);
	loadSeam.afterReaders?.();
	// The readers read by PATH. Only if the path still names the file the descriptor read, with the same size and mtime,
	// do `lastHash`, `byteOffset` and `logId` all describe one file; otherwise (a rename, an append) the load is redone.
	// The rotated segments are bracketed too (the directory's listing, and each segment's identity and size), so a
	// containment failure is latched only on a read of one unchanged set of files: a segment listed and then removed
	// before it was read gave the reader ENOENT, which it reads as absence, and only the bracket sees it went.
	const consistent =
		(snapshot === undefined || snapshot.fingerprint === pathFingerprint(logPath)) &&
		segmentsBefore.fingerprint === segmentsState(join(vaultPath, "audit")).fingerprint;
	const { dir: auditDir, listError, id: dirId } = auditDirState(vaultPath);
	// Whether the pass's read SUCCEEDED, decided by the reads themselves, never by a separate probe of the files (a
	// permission change between a probe and the read would let a failed read pass): the audit directory present and
	// listable, the events' reader reporting no file it could not read, and the anchor read. A file that is absent
	// (ENOENT) was read successfully as "nothing there", so a log and anchor removed from a directory that stays is still
	// a read of the vault. An unreadable directory or file gives no events, and a read that failed is not evidence that
	// events are gone: its verdict stands on its own (the readability errors fail it), and it is never compared with the
	// head, nor recorded as one.
	const readSucceeded = auditDir === "present" && listError === undefined && unread.length === 0;
	// What the vault held, as this pass read it: log bytes in `events.jsonl` (the descriptor's size) or in any rotated
	// segment (its size, from the same bracket; the bracket checked neither changed), an anchor, or events. Bytes in a
	// segment count: a malformed-only log rotated into a segment still holds them, and malformed bytes only in a segment,
	// then that segment removed, held something and now hold nothing.
	const evidence = {
		logBytes: (snapshot?.byteOffset ?? 0) > 0 || segmentsBefore.bytes,
		anchor: anchor.present,
		events: events.length > 0,
	};
	// The check is evaluated only on a read that succeeded; a failed one holds the head trivially, so it is neither read
	// again for a confirmation nor latched.
	const contained = !readSucceeded || holdsHead(events, evidence, head);
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
	const latchesEvents = confirming && consistent && !contained && !causes.has("directory");
	if (latchesEvents) causes.add("events");
	const deletionCauses = (["directory", "events"] as const).filter((c) => causes.has(c));
	const deletionDetected = deletionCauses.length > 0;
	// The whole vault was read: one unchanged set of files, every read succeeded, or there was no audit directory to read.
	const loadSucceeded =
		consistent && (readSucceeded || (auditDir === "absent" && unread.length === 0));
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
	// The read's own verdict, before any deletion cause is added: what `verified` rests on.
	const readValid = integrity.valid && (vault.valid || (noAuditDir && readErrors.length === 0));
	const valid =
		integrity.valid && !deletionDetected && (vault.valid || (noAuditDir && errors.length === 0));
	const verified = loadSucceeded && readValid;

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
			verifiedAt: loadSucceeded ? new Date().toISOString() : null,
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
		// Set only by a pass that read the whole vault, whose own check did not latch, and whose chain VERIFIED; or, when
		// the caller had no head yet, by any such read, verified or not, since there is nothing verified to keep. A pass
		// that latched keeps the head it was judged against: the events it read are not the ones verified. So does one
		// whose chain did not verify: its events may hold another chain beside the verified one, and that chain's tip
		// would let the verified events be removed unseen.
		head:
			loadSucceeded && readSucceeded && !latchesEvents && (verified || head === undefined)
				? {
						verifiedHash: tipHash(events, head),
						hadEvidence: evidence.logBytes || evidence.anchor || evidence.events,
					}
				: undefined,
		loadSucceeded,
		verified,
	};
	loadSeam.afterPass?.({ consistent, readSucceeded, contained });
	return { state, consistent, contained };
}

/**
 * The chain's tip, by LINKAGE: the one event whose hash no other event's `previousHash` names. Never the last event in
 * reading order: in file order (events without `sequence`) `events.jsonl` is read first and the segments after it, so
 * the last event read can be an older segment's tail. When no single event is the tip (a broken or forked chain, which
 * a load that verified never reads), the last event in sequence order if every event has a `sequence` (the order the
 * reader returns them in then), and otherwise the head's own hash, unchanged: no tip is guessed from file order.
 * Undefined when the read holds no event with a hash.
 */
function tipHash(
	events: readonly { hash?: unknown; previousHash?: unknown; sequence?: unknown }[],
	head: LogHead | undefined,
): string | undefined {
	const named = new Set<unknown>();
	for (const e of events) named.add(e.previousHash);
	// A Set, so an event read twice (a load racing a rotation's two steps) is one candidate, not two.
	const tips = new Set<string>();
	for (const e of events) if (typeof e.hash === "string" && !named.has(e.hash)) tips.add(e.hash);
	if (tips.size === 1) return [...tips][0];
	if (events.length === 0) return undefined;
	if (events.every((e) => typeof e.sequence === "number")) {
		const hash = events.at(-1)?.hash;
		return typeof hash === "string" ? hash : undefined;
	}
	return head?.verifiedHash;
}

/**
 * Whether a read still holds `head`: an event with its verified hash (anywhere: a rotation moves positions in file
 * order), and, when the head had evidence, some evidence still (log bytes, an anchor, or an event). No head holds
 * trivially.
 */
function holdsHead(
	events: readonly { hash?: unknown }[],
	evidence: { logBytes: boolean; anchor: boolean; events: boolean },
	head: LogHead | undefined,
): boolean {
	if (head === undefined) return true;
	if (head.verifiedHash !== undefined && !events.some((e) => e.hash === head.verifiedHash))
		return false;
	return !head.hadEvidence || evidence.logBytes || evidence.anchor || evidence.events;
}

/**
 * The rotated segments as the readers would gather them: every `*.jsonl` but `events.jsonl` in the audit directory,
 * sorted, each with its identity, size and mtime, read through a descriptor so a segment that cannot be opened records
 * its error code. A listing or open that fails is part of the fingerprint, so two reads that both fail the same way
 * compare equal and a read that fails differently does not. It answers whether the set of files stayed the same, never
 * whether the readers could read them: that comes from the readers. `bytes`: whether any segment it opened holds bytes,
 * from the same `fstat`, so the evidence it reports describes the same set of files the bracket compared.
 */
function segmentsState(auditPath: string): { fingerprint: string; bytes: boolean } {
	let names: string[];
	try {
		names = readdirSync(auditPath)
			.filter((n) => n.endsWith(".jsonl") && n !== "events.jsonl")
			.sort();
	} catch (err) {
		return {
			fingerprint: `list:${(err as NodeJS.ErrnoException).code ?? "unknown"}`,
			bytes: false,
		};
	}
	let bytes = false;
	const fingerprint = names
		.map((n) => {
			let fd: number;
			try {
				fd = openSync(join(auditPath, n), "r");
			} catch (err) {
				return `${n}=${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
			}
			try {
				const st = fstatSync(fd, { bigint: true });
				if (st.size > 0n) bytes = true;
				return `${n}=${fingerprintOf(st)}`;
			} catch (err) {
				return `${n}=${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
			} finally {
				closeSync(fd);
			}
		})
		.join("|");
	return { fingerprint, bytes };
}

/**
 * Reads the `.meta` anchor: whether it is there, and the error code of a read that failed (none when it read, or is
 * absent: ENOENT).
 * `verifyVault` reads the anchor too, but folds a read that failed into "present but corrupt", the same answer as bytes
 * that do not parse, and it is the mirror of the standalone verifier, so it gives no way to see the code. This read is
 * the pass's own read of the anchor's bytes, made beside the events' read: its result is what the pass knows.
 */
function readAnchor(metaPath: string): { present: boolean; error?: string } {
	try {
		readFileSync(metaPath);
		return { present: true };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? { present: false } : { present: true, error: code ?? "unknown" };
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
