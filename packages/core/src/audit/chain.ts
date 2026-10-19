// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Audit Chain Writer — SHA-256 hash-chained JSONL
 *
 * Appends audit events to a JSONL log where each event's hash covers
 * the previous event's hash, creating a tamper-evident chain. Single-writer
 * semantics are enforced via advisory file lock + in-process async mutex.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	futimesSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { GENESIS_HASH, VAULT_DIR } from "../shared/constants.js";
import { mkdirPrivate, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../shared/private-fs.js";
import type { AuditEvent } from "../shared/types.js";
import { canonicalize } from "./canonical.js";
import {
	acquireSmallFile,
	countLogLines,
	fileKindOf,
	listDirectory,
	MAX_EVENT_LINE_BYTES,
	MAX_INVENTORY_NAMES,
	MAX_TAIL_BYTES,
	openFailure,
	readLogTail,
} from "./tail-read.js";
import {
	classifyAuditTail,
	type LogObservation,
	type LogTail,
	MAX_ANCHOR_BYTES,
	parseLine,
	type TailState,
	type TailStateName,
	type TrailingKind,
	writerAction,
} from "./tail-state.js";

// ── Durable writes ──

/**
 * Write EVERY byte of `data`, or throw (#194). `writeSync` may write fewer bytes than asked (a
 * nearly full disk, a signal); ignoring its count reported a partial line as appended and durable —
 * a torn tail with a durability claim on it. A write that makes no progress throws.
 */
function writeFully(fd: number, data: string): void {
	const buf = Buffer.from(data, "utf-8");
	let off = 0;
	while (off < buf.length) {
		const n = writeSync(fd, buf, off, buf.length - off);
		if (n <= 0) {
			throw new Error(`audit write made no progress (${off} of ${buf.length} bytes written)`);
		}
		off += n;
	}
}

/**
 * Replace the `.meta` head anchor ATOMICALLY: written and fsync'd to a private temp file, then
 * renamed over the anchor, then the directory is fsync'd. Rewriting it in place (open "w" truncates
 * first) left an EMPTY or half-written anchor after a crash mid-write — one that reads as corrupt
 * and refuses every append and verification. Now the anchor is always the old one or the new one.
 */
export function writeAnchorAtomically(metaPath: string, content: string): void {
	const tmp = `${metaPath}.${randomUUID()}.tmp`;
	const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
	try {
		try {
			writeFully(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, metaPath);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* renamed, or never created */
		}
		throw err;
	}
	// The parent-directory fsync makes the RENAME durable. Only an UNSUPPORTED directory fsync
	// (EINVAL/ENOTSUP/EOPNOTSUPP/EISDIR) is best effort; a genuine failure (EIO, …) propagates into
	// appendEvent's degraded-append / durable-hash contract instead of reporting a durable anchor a
	// crash could roll back.
	let dfd: number | undefined;
	try {
		dfd = openSync(dirname(metaPath), "r");
		fsyncSync(dfd);
	} catch (err) {
		if (!isUnsupportedDirSync(err)) throw err;
	} finally {
		if (dfd !== undefined) closeSync(dfd);
	}
}

/** A directory fsync the platform does not support — the only directory-sync error that is best effort. */
export function isUnsupportedDirSync(err: unknown): boolean {
	const code = errorCode(err);
	return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EISDIR";
}

/**
 * The log ends in a TORN line — bytes after its last newline, from an append that never
 * completed. Nothing is appended after it: the new line would be concatenated onto the torn
 * bytes, burying them mid-file. `usertrust audit quarantine-tail` moves a torn tail aside,
 * recorded on the chain, when the bytes are a fragment (not JSON) after a chain it can vouch for;
 * anything else after the last newline (JSON that is not an event, or a whole event without its
 * newline) is not a torn write, and is not for it.
 */
export class AuditTornTailError extends Error {
	/** What the bytes after the last newline are, when the writer classified them. */
	readonly kind: TrailingKind | undefined;
	/** The state of the complete lines before them, when the writer classified them. */
	readonly state: TailStateName | undefined;
	constructor(logPath: string, bytes: number, tail?: TailState) {
		const kind = tail?.torn?.kind;
		const quarantinable =
			tail === undefined ||
			(kind === "fragment" &&
				(tail.state === "FRESH" || tail.state === "MATCH" || tail.state === "ONE_PAST_ANCHOR"));
		super(
			`Audit log ${logPath} ends in a torn line (${bytes} byte(s) after its last newline${
				kind === undefined || kind === "fragment" ? "" : `: ${kind.replaceAll("_", " ")}`
			}). Refusing to append. ${
				quarantinable
					? "Run `usertrust audit quarantine-tail` to move it aside, recorded on the chain."
					: "It is not a torn write that `usertrust audit quarantine-tail` can move aside: keep the vault exactly as it is, and run `usertrust verify` for the details."
			}`,
		);
		this.name = "AuditTornTailError";
		this.kind = kind;
		this.state = tail?.state;
	}
}

/**
 * The log's tail is not one this writer can explain against its `.meta` anchor (`tail-state.ts`):
 * events missing after the anchored head, a replaced head, events past it that do not chain from it,
 * an anchor or a log that cannot be read, a vault mid-recovery. NOTHING is appended (the writer once
 * adopted any last line it found and rewrote the anchor to it, so a truncated log became the anchored
 * truth at the next call), and nothing is created or changed: the event is dead-lettered as any failed
 * append's is. `state` names the classification; `found` is the log's last event and `anchored` the
 * anchor, where they could be read.
 */
export class AuditTailMismatchError extends Error {
	readonly state: TailStateName;
	readonly found: TailState["found"];
	readonly anchored: TailState["anchored"];
	constructor(logPath: string, tail: TailState) {
		super(
			`Audit log ${logPath} cannot be appended to: ${tail.state} (${tail.note}). Nothing was written to it. Keep the vault exactly as it is, and run \`usertrust verify\` for the details.`,
		);
		this.name = "AuditTailMismatchError";
		this.state = tail.state;
		this.found = tail.found;
		this.anchored = tail.anchored;
	}
}

// ── Types ──

export interface AppendEventInput {
	kind: string;
	actor: string;
	data: Record<string, unknown>;
}

/**
 * Where a PARTIALLY-successful append records the hash of the event that did
 * land durably in `events.jsonl`.
 *
 * `appendEvent` writes the log, fsyncs it, and only then writes the `.meta`
 * sidecar. A sidecar failure therefore rejects for an event that IS on the
 * chain — and a caller told only "it failed" throws away the correlation handle
 * for a record an auditor can still read. The hash rides out on the rejection
 * so that caller can recover it.
 *
 * A SYMBOL, not a string key: invisible to `JSON.stringify`, `Object.keys` and
 * any log line that serialises the error, and impossible to collide with a
 * field some other layer sets.
 */
const DURABLE_EVENT_HASH = Symbol.for("usertrust.audit.durableEventHash");

/**
 * Recover the hash of an event that reached the log before the append failed.
 * `undefined` means nothing durable was written — the ordinary total failure.
 */
export function readDurableEventHash(err: unknown): string | undefined {
	if (err === null || typeof err !== "object") return undefined;
	const value = (err as Record<symbol, unknown>)[DURABLE_EVENT_HASH];
	return typeof value === "string" ? value : undefined;
}

export interface AuditWriter {
	appendEvent(input: AppendEventInput): Promise<AuditEvent>;
	/**
	 * Check that the next append could go on: the log's tail classified against its anchor exactly as
	 * the append classifies it, under the same mutex and lock. Throws what the append would throw for a
	 * refused tail ({@link AuditTailMismatchError}, {@link AuditTornTailError}), or the lock's refusal.
	 * Nothing is written to the chain or its anchor, rolled forward, or counted as a failed write; the
	 * lock is taken as an append takes it (its file created, and the directory synced, when this writer
	 * does not hold it yet). `audit.failClosed` callers run it before any hold, so a vault whose append
	 * would be refused is refused before money moves. Optional: a writer without it is never
	 * pre-flighted.
	 */
	preflight?(): Promise<void>;
	getWriteFailures(): number;
	isDegraded(): boolean;
	flush(): Promise<void>;
	/**
	 * Release every advisory lock this writer holds and reset its state. Every lock is attempted;
	 * one that could not be released (its file could not be read, or its unlink failed) is left in
	 * place, and after the last one an {@link AuditLockReleaseError} naming each is thrown. (`destroy()`
	 * never rejects for it: see {@link releaseAuditWriterForTeardown}.)
	 */
	release(): void;
	/**
	 * The id of this writer's CURRENT hold on this vault's advisory lock, or undefined while it holds none (a lazy
	 * writer takes the lock at its first append; a writer whose lock another process reclaimed holds none). Every
	 * acquisition has a new id — a new writer's, and this writer's own after it lost the lock and took it again — so a
	 * lock released, or lost, and taken again reads as a different owner. Read from the lock file each time.
	 * Optional: a writer that cannot say (a test double) reads as holding none.
	 */
	lockOwner?(): string | undefined;
}

/** Options for {@link openSharedAuditWriter}. */
export interface SharedAuditWriterOptions {
	/**
	 * Called after each of this handle's appends SUCCEEDS, when the vault's writer therefore holds the lock. It must
	 * not throw (what it throws is swallowed: an append's outcome is never its listener's).
	 */
	onAppended?: () => void;
}

/**
 * The audit writer's advisory lock for a vault is held by another LIVE writer — another
 * process, or another writer in this process. Only one writer may append to a vault's chain.
 * A subclass of `Error` with the same message as before, so existing `catch` blocks and
 * message checks behave as they did.
 */
export class AuditWriterLockHeldError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuditWriterLockHeldError";
	}
}

/** The `code` of an error, if it carries a string one (an `errno` code such as `EIO`). */
function errorCode(err: unknown): string | undefined {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/**
 * `release()` left one or more lock files in place: each could not be read, or its unlink failed.
 * Every lock was attempted. A lock left behind keeps other processes off that vault until this
 * process exits. `errors` holds one error per lock (its `cause` is the filesystem error); `left`
 * lists each lock's path and that error's code — the message carries only those, never an
 * underlying message.
 */
export class AuditLockReleaseError extends AggregateError {
	readonly left: ReadonlyArray<{ path: string; code: string | undefined }>;
	constructor(failures: ReadonlyArray<{ path: string; error: unknown }>) {
		const left = failures.map((f) => ({ path: f.path, code: errorCode(f.error) }));
		super(
			failures.map(
				(f) => new Error(`Audit writer lock ${f.path} could not be released`, { cause: f.error }),
			),
			`Audit writer lock release left ${left.length} lock file(s) in place: ${left
				.map((l) => `${l.path} (${l.code ?? "unknown error"})`)
				.join("; ")}`,
		);
		this.name = "AuditLockReleaseError";
		this.left = left;
	}
}

/**
 * Untrusted text (a vault path) in a human-facing warning: C0, DEL and C1 become `?`, as
 * `scrubForError` does in `audit/verify.ts` — a crafted directory name must not drive the terminal
 * that prints the warning (C1 holds the 8-bit CSI/OSC introducers). Only the PRINTED text is
 * scrubbed: an error's data (`AuditLockReleaseError.left`) keeps the real path, which a substitution
 * would corrupt.
 */
function scrubForWarning(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "?" : ch;
	}
	return out;
}

/** The `process.emitWarning` code under which a teardown reports an audit lock left behind. */
export const AUDIT_LOCK_LEFT_WARNING = "USERTRUST_AUDIT_LOCK_LEFT";

/**
 * Release `audit` for a teardown that must NEVER reject — `destroy()` on `trust()` and
 * `createGovernor`. Callers routinely call those without await or catch, and an unhandled rejection
 * kills the process: a stranded lock is a liveness problem (other processes wait until this one
 * exits), not a reason to crash. A failed release is therefore reported, not thrown: as a process
 * warning with the stable code {@link AUDIT_LOCK_LEFT_WARNING}, and on `console.warn`. The report
 * names each lock path left behind and its error code — nothing else from the error — scrubbed
 * for the terminal.
 */
export function releaseAuditWriterForTeardown(audit: AuditWriter): void {
	try {
		audit.release();
	} catch (err) {
		const message = describeReleaseFailure(err);
		console.warn(`[AUDIT] ${message}`);
		process.emitWarning(message, { code: AUDIT_LOCK_LEFT_WARNING });
	}
}

/**
 * A release failure, as ONE line fit for a terminal: each lock path left behind and its error code
 * (or, for an unexpected error, only its kind and code — never its message), scrubbed. Never the
 * error object itself: printing that prints its message and every nested error unscrubbed.
 */
function describeReleaseFailure(err: unknown): string {
	return scrubForWarning(
		err instanceof AuditLockReleaseError
			? err.message
			: `Audit writer release failed (${err instanceof Error ? err.name : typeof err}${
					errorCode(err) === undefined ? "" : `: ${errorCode(err)}`
				}); its lock may be left in place.`,
	);
}

export interface CreateAuditWriterOptions {
	/**
	 * Take the vault's advisory lock NOW, in the factory, instead of at the first append.
	 * A second writer (another process, or another live writer in this process) then fails
	 * HERE with {@link AuditWriterLockHeldError} — before its caller does anything that
	 * assumes it is the one writer. Default `false`: the lock is taken at the first append,
	 * exactly as before.
	 */
	lockAtCreate?: boolean;
}

// ── AsyncMutex ──

/**
 * In-process async mutex for serializing audit writes.
 *
 * SINGLE-PROCESS CONSTRAINT: This mutex is process-local (in-memory).
 * It guarantees sequential writes within a single Node.js process but
 * provides NO protection across multiple processes.
 */
class AsyncMutex {
	private queue: Promise<void> = Promise.resolve();

	async acquire(): Promise<() => void> {
		let release: (() => void) | undefined;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prev = this.queue;
		this.queue = next;
		await prev;
		return release as () => void;
	}
}

// ── Advisory Lock ──
//
// THREAT MODEL. This lock prevents ACCIDENTAL concurrent writers: two processes, or two writers in
// one process, appending to one vault's chain — which would fork it, each writer caching its own
// tail. It is not a defence against an adversary on the host. Anyone who can rename or recreate
// the audit directory can already write the chain directly, so pathname races under a CONCURRENT
// directory replacement are out of scope. They cannot be closed here: Node has no atomic,
// inode-bound unlink, so every check-then-unlink by path — stale-lock cleanup, release, and the
// rollback of a create that will not be reported — has a window in which the directory can be
// swapped under it. What IS checked narrows the window without closing it: an acquire reports
// success only if, after its create, the requested path holds the very file that create made; a
// replacement after that check is out of scope like the rest. A kernel advisory lock held on an
// open fd (flock/fcntl) would remove the dependence on pathnames altogether (see issue #288).
// Holding a file descriptor open for the writer's lifetime was rejected earlier because the lock's
// semantics are the lock file's EXISTENCE at its path; an open fd adds no exclusion by itself,
// only together with such a kernel lock.
//
// The lock file APPEARS COMPLETE. Its content is written and fsync'd to a private temp file, which
// is then hard-linked to the lock's name: `link` fails with EEXIST when the name is taken, so it is
// the exclusive create, and the name never exists without its full content. (An exclusive create
// followed by a write left a window in which another process read the lock empty, judged it
// corrupt, and unlinked a LIVE writer's lock.) A filesystem without hard links cannot host a vault's
// writer: the acquire fails closed rather than fall back to that window.
//
// Liveness is judged on ONE KERNEL. The lock records the writer's PID and, where they can be read,
// the kernel's boot id and the writer's PID namespace. A lock from another PID namespace cannot be
// probed from this one, and is held — whatever its boot id says, because a boot id is not always
// the kernel's: systemd-nspawn gives each container a private one on the host's kernel, so a host
// and a container sharing a vault read each other's LIVE locks as "before this boot". Only a lock
// from this namespace (or one that names none) whose boot id is known and differs from this
// boot's — both known — is taken as written before a reboot, its PID naming nothing now. A vault
// shared between kernels (two hosts, two VMs) is outside the model: no PID probe means anything
// there.
//
// The one proof that crosses namespaces is a LEASE. A writer that records its PID namespace also
// renews the lock file's mtime every LEASE_RENEW_MS (futimes, through an fd proven to be its own
// lock), and says so in the lock (`leaseRenewMs`). Another namespace's lock that declares a lease
// is reclaimed only when BOTH hold: its mtime is more than LEASE_STALE_MS behind this clock, and
// this process has itself seen it unrenewed — the same file, the same mtime — across
// LEASE_CONFIRM_MS of its own MONOTONIC clock. One kernel has one monotonic clock, and it stops
// for a suspend: a live holder is awake whenever this observer is, and its timer renews within
// that window. The wall-clock age alone would reclaim a live lock after a host suspend or a
// clock step forward. A lock with no lease (an earlier version's) is held, as before. See
// AGENTS.md ("Staleness is judged on one kernel") for the split-brain analysis.

const LOCK_FILE_NAME = ".audit-writer.lock";

/** One lock a live writer holds; keyed in {@link heldLocks} by the lock FILE's `dev:ino`. */
interface HeldLock {
	/**
	 * Where the lock file was last SEEN: its physical path (the realpath of its directory) at the
	 * create, refreshed by every acquire that verifies it. Never the caller's spelling — a symlink
	 * alias can be removed or retargeted while the lock is held. Refreshed because the directory
	 * can also be RENAMED while held, the lock file moving with it; see {@link releaseLocks}.
	 */
	path: string;
	/** The lock declares a lease (`leaseRenewMs`), so {@link renewLeases} must keep renewing it. */
	leased: boolean;
	/**
	 * A random id for THIS acquisition (`AuditWriter.lockOwner`). Not the writerId: a writer that lost its lock
	 * and took it again keeps its writerId, and a caller that remembered what it published under that id would
	 * not see that another holder came and went in between.
	 */
	acquisitionId: string;
	/**
	 * A leased lock's last SUCCESSFUL renewal, on this process's monotonic clock (`performance.now()`),
	 * read BEFORE the call that set the mtime another process sees (the create's write, or a renewal's
	 * `futimes`), so it is never later than that mtime. A failed renewal never moves it. See
	 * {@link LEASE_HOLDER_BOUND_MS}.
	 */
	renewedAt: number;
	/** The code of the last renewal that failed since the last one that succeeded, for the refusal's message. */
	renewalError?: string | undefined;
	/**
	 * The lease lapsed, and its file could not be removed: the entry stays ONLY as the cleanup record
	 * ({@link lapseLease}). It is never renewed, never names an owner, and never authorizes a write;
	 * the next append, and release, try the removal again.
	 */
	lapsed?: true;
}

/**
 * How often a holder renews its lease: the lock file's mtime, set through an fd proven to be its own
 * lock ({@link renewLease}). Recorded in the lock as `leaseRenewMs`.
 */
const LEASE_RENEW_MS = 5_000;
/**
 * The least wall-clock age (now − the lock's mtime) at which another namespace's lease counts as
 * expired. A reader uses `max(this, 6 × the lock's leaseRenewMs)`, so a lock declaring a slower
 * renewal waits longer and never shorter. It makes an observer wait well past a brief stall of a
 * live holder's renewals; it is NOT what keeps a holder safe, since a wall-clock step satisfies it at
 * once (see LEASE_HOLDER_BOUND_MS).
 */
const LEASE_STALE_MS = 60_000;
/**
 * The least time this process must itself have seen a lease unrenewed — the same lock file, the same
 * mtime — on its MONOTONIC clock before it reclaims it. A reader uses `max(this, 3 × leaseRenewMs)`.
 * This is what makes the wall-clock age safe to use: after a host suspend, or a wall-clock step
 * forward, every lease reads as expired at once, but a live holder's timer renews within one interval
 * of the observer's own awake time, and the observation resets.
 */
const LEASE_CONFIRM_MS = 30_000;
/**
 * How long a HOLDER may go without a successful renewal before it stops writing under its lease: past
 * this, on its own monotonic clock since {@link HeldLock.renewedAt}, the lease has LAPSED. The next
 * append that meets it is refused, and the lock is given up ({@link lapseLease}).
 *
 * Why this bound, and why it holds. A holder whose renewals fail (EMFILE on the open, EIO from
 * `futimes`) still looks live to itself; if it went on appending, an observer in another namespace
 * would reclaim the lock from a LIVE, ACTIVE writer, and an append in flight across the takeover forks
 * the chain. So the holder must stop STRICTLY BEFORE the earliest moment any observer can reclaim,
 * counted from the last mtime that observer can see — the last successful renewal, `renewedAt`:
 *  - The observer needs its OWN monotonic observation of that same mtime for at least
 *    `max(LEASE_CONFIRM_MS, 3 × leaseRenewMs)` ≥ 30 s (judgeLease). It cannot see an mtime before it
 *    is set, and `renewedAt` is read before the call that sets it; one kernel has one monotonic clock.
 *    So no observer reclaims earlier than `renewedAt + 30 s`.
 *  - Its wall-clock condition (age > 60 s) gives the holder NO guarantee: a wall-clock step forward
 *    makes it true at once. The bound is therefore set against the 30 s, never the 60 s.
 *  - The holder checks the bound at the start of the append's synchronous span, which then runs to
 *    the fsync with no await. 20 s leaves 10 s of that 30 s for the span itself.
 *  - And it tolerates ordinary failure: at a 5 s renewal interval, three renewals in a row may fail,
 *    or the timer may run late, before the fourth (at 20 s) must succeed. One transient failure
 *    followed by a success never comes near it.
 */
const LEASE_HOLDER_BOUND_MS = 20_000;
/** The slowest renewal a lock may declare and still be honoured as a lease: an hour. */
const LEASE_RENEW_MAX_MS = 3_600_000;

/**
 * The lease timings, for the tests that pin their relationships (the holder's bound must stay below the
 * observer's earliest reclaim). Internal: not exported from the package.
 */
export const LEASE_TIMING = Object.freeze({
	renewMs: LEASE_RENEW_MS,
	staleMs: LEASE_STALE_MS,
	confirmMs: LEASE_CONFIRM_MS,
	holderBoundMs: LEASE_HOLDER_BOUND_MS,
});

/**
 * A holder's lease lapsed: its renewals failed (or did not run) for longer than
 * {@link LEASE_HOLDER_BOUND_MS}, so another namespace may soon reclaim its lock. The append that met
 * it is refused (the writer degrades and dead-letters it, as for any failed append), and the lock was
 * given up. The next append takes the vault's lock afresh, re-reading the chain's tail.
 */
export class AuditLeaseLapsedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuditLeaseLapsedError";
	}
}

/**
 * writerId → (lock-file `dev:ino` → {@link HeldLock}): every lock every LIVE writer in this process
 * holds (#195). The identity is read through the fd of the lock's exclusive create and kept here;
 * it is never re-derived from what a directory looks like later.
 *
 * This is the ONLY thing that can make a lock file "a live writer's in this process": the file
 * carries a writerId, and it is live iff that writer holds the file's own inode here. A same-PID
 * lock file that is not — a crashed earlier instance of this PID, a recycled PID, a copy — is
 * reclaimable; one that is, is refused (reclaiming a live sibling's lock forks the chain: two
 * writers append, each from the tail it read).
 *
 * Deliberately NOT keyed by the directory. Keyed by the directory's `(dev, ino)`, every hit had to
 * be re-verified, because a directory's identity can be stale by the time it is used: a directory
 * replaced between its lookup and the lock's create registered the new lock under the old
 * directory's key, so a second same-process writer missed it and reclaimed the LIVE lock. The lock
 * file itself is the thing held, and it says who holds it.
 *
 * A writer can hold SEVERAL locks: its vault path may be a symlink retargeted to another vault
 * between appends, and the lock it took on the first vault is still its own to release.
 *
 * A lock is registered only once its create has fully succeeded, and a writer's locks leave only
 * through its release. A writer dropped without `release()` therefore keeps its locks for the life
 * of the process — this process cannot prove the writer is gone (a reference to it may still
 * append), so its locks are not reclaimable here; another process may reclaim them once this PID
 * is dead.
 */
const heldLocks = new Map<string, Map<string, HeldLock>>();

function hasFsCode(err: unknown, code: string): boolean {
	return err instanceof Error && (err as { code?: string }).code === code;
}

/** One read of an existing lock file: its identity and the claim it carries, from ONE fd. */
interface LockFileView {
	identity: string;
	/** `undefined` when the content is not a JSON object (a corrupt file). */
	pid: unknown;
	writerId: unknown;
	/** The writer's kernel boot id, if it recorded one (see {@link thisBootId}). */
	bootId: unknown;
	/** The writer's PID namespace, if it recorded one (see {@link thisPidNamespace}). */
	pidNs: unknown;
	/** The holder's lease renewal interval, if it declared a lease (see {@link LEASE_RENEW_MS}). */
	leaseRenewMs: unknown;
	/** The file's mtime — a leased lock's last renewal — exactly, to tell one renewal from the next. */
	mtimeNs: bigint;
	/** The same mtime in milliseconds since the epoch, for its age on this clock. */
	mtimeMs: number;
}

/** `O_NOFOLLOW` where the platform has it (not Windows, which has no such flag). */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Read the lock file at `lockPath` — identity and content through the SAME fd, so they are one
 * file's even if the path is swapped meanwhile. `undefined` if it does not exist (it can vanish
 * between a create's EEXIST and this read).
 *
 * Every other failure THROWS — the open, the fstat, the read itself. A lock that could not be read
 * is never "a lock nobody holds": an acquire that took it for one would unlink a LIVE lock and
 * admit a second writer. Only content that WAS read and does not parse is corrupt.
 *
 * The name is never followed: a symlink at the lock's name is not a lock any writer made (each
 * links a regular file there), and the open fails (ELOOP) — so it throws, like any lock that
 * cannot be read, and is never judged by whatever it points at.
 */
function readLockFile(lockPath: string): LockFileView | undefined {
	let fd: number;
	try {
		fd = openSync(lockPath, fsConstants.O_RDONLY | O_NOFOLLOW);
	} catch (err) {
		if (hasFsCode(err, "ENOENT")) return undefined;
		throw err;
	}
	try {
		return readLockFd(fd);
	} finally {
		closeSync(fd);
	}
}

/** {@link readLockFile} on an fd the caller opened: its identity, mtime and claim, all from that fd. */
function readLockFd(fd: number): LockFileView {
	const st = fstatSync(fd, { bigint: true });
	const content = readFileSync(fd, "utf-8");
	let claim:
		| {
				pid?: unknown;
				writerId?: unknown;
				bootId?: unknown;
				pidNs?: unknown;
				leaseRenewMs?: unknown;
		  }
		| undefined;
	try {
		const parsed: unknown = JSON.parse(content);
		if (parsed !== null && typeof parsed === "object") claim = parsed;
	} catch {
		/* read, but corrupt: no claim */
	}
	return {
		identity: `${st.dev}:${st.ino}`,
		pid: claim?.pid,
		writerId: claim?.writerId,
		bootId: claim?.bootId,
		pidNs: claim?.pidNs,
		leaseRenewMs: claim?.leaseRenewMs,
		mtimeNs: st.mtimeNs,
		mtimeMs: Number(st.mtimeNs / 1_000_000n),
	};
}

/**
 * The live writer in this process that holds `file`, with its record of that lock — if any: the
 * writerId the file carries holds the file's own inode. The writerId alone is not enough — a copy
 * of the file carries it too; the inode alone is not enough — a freed inode is reused by the next
 * file. No pid check: a file carrying a live writerId AND an inode that writer created is that
 * writer's file.
 */
function liveHolderOf(file: LockFileView): { writerId: string; lock: HeldLock } | undefined {
	if (typeof file.writerId !== "string") return undefined;
	const lock = heldLocks.get(file.writerId)?.get(file.identity);
	return lock === undefined ? undefined : { writerId: file.writerId, lock };
}

// ── Whose kernel, whose namespace ──

/** A boot id as Linux writes it: a lower-case UUID. Anything else is not one this code compares. */
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A PID namespace as Linux names it: the `/proc/<pid>/ns/pid` link target. */
const PID_NS = /^pid:\[\d+\]$/;

let cachedBootId: string | undefined;
let cachedPidNs: string | undefined;

/**
 * This kernel's boot id (Linux: `/proc/sys/kernel/random/boot_id`), or `undefined` when it cannot
 * be read — not Linux, no `/proc`, or a failed read. Only a SUCCESSFUL read is cached (a boot id
 * cannot change while this process lives): a transient failure must not leave every later lock
 * this process writes, and every later judgement it makes, without a boot id for its lifetime.
 * No other platform's boot identity is read: macOS has one only through a subprocess, which would
 * sit inside every acquire; there the PID probe decides, as before.
 */
function thisBootId(): string | undefined {
	if (cachedBootId !== undefined) return cachedBootId;
	try {
		const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
		if (BOOT_ID.test(id)) cachedBootId = id;
	} catch {
		/* unknown — and not cached */
	}
	return cachedBootId;
}

/**
 * This process's PID namespace (Linux: the `/proc/self/ns/pid` link target), or `undefined` when it
 * cannot be read. Cached only once read, like {@link thisBootId}. Containers on one host share the
 * kernel — and its boot id — but `kill(pid, 0)` sees only the caller's own PID namespace, and a
 * container's writer is often PID 1 there, the same number as a writer in a sibling container.
 */
function thisPidNamespace(): string | undefined {
	if (cachedPidNs !== undefined) return cachedPidNs;
	try {
		const ns = readlinkSync("/proc/self/ns/pid");
		if (PID_NS.test(ns)) cachedPidNs = ns;
	} catch {
		/* unknown — and not cached */
	}
	return cachedPidNs;
}

/**
 * Was this lock written before this boot? ONLY when the lock carries a boot id, this process can
 * read its own, and the two differ EXACTLY. An unknown boot id on either side is never a verdict
 * (fail toward live): the PID judgement decides, as it did before boot ids were recorded. Never a
 * time estimate — an uptime-derived boot time moves with every wall-clock step, and a step would
 * reclaim a LIVE writer's lock.
 */
function writtenBeforeThisBoot(lock: LockFileView): boolean {
	if (typeof lock.bootId !== "string" || !BOOT_ID.test(lock.bootId)) return false;
	const now = thisBootId();
	return now !== undefined && lock.bootId !== now;
}

/**
 * How the lock's PID namespace relates to this process's:
 *  - `unrecorded`: the lock names none (written before namespaces were recorded, or where they
 *    cannot be read) — the PID is judged as before;
 *  - `same`: both are known and equal — the PID means the same process here;
 *  - `foreign`: both are known and differ — this process cannot probe that PID;
 *  - `unknown`: the lock names one, and this process cannot read its own (or the lock's is not a
 *    namespace) — it cannot tell, and fails toward live.
 */
function namespaceOf(lock: LockFileView): "unrecorded" | "same" | "foreign" | "unknown" {
	if (lock.pidNs === undefined) return "unrecorded";
	const now = thisPidNamespace();
	if (now === undefined || typeof lock.pidNs !== "string" || !PID_NS.test(lock.pidNs)) {
		return "unknown";
	}
	return lock.pidNs === now ? "same" : "foreign";
}

/**
 * A lock file's `pid`, as a message may print it: the number when it is one a process can carry
 * (a non-negative safe integer), else `<invalid>`. A lock file's content is untrusted — a vault
 * restored from someone else's snapshot can carry a `pid` string full of terminal controls — so
 * no field read from a lock reaches a message, a warning or an error except through this or
 * {@link describeLockField}.
 */
function describeLockPid(pid: unknown): string {
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid >= 0
		? String(pid)
		: "<invalid>";
}

/** A string field read from a lock file (a boot id, a namespace), as printed: itself when it has `shape`, else `<invalid>`. */
function describeLockField(value: unknown, shape: RegExp): string {
	return typeof value === "string" && shape.test(value) ? value : "<invalid>";
}

/**
 * The lock's content: who holds it, and — where they can be read — on which boot and namespace.
 * `leased`: the holder will renew the file's mtime every {@link LEASE_RENEW_MS} (see
 * {@link createLock} for when a lock declares that).
 */
function lockContentFor(writerId: string, leased: boolean): string {
	const bootId = thisBootId();
	const pidNs = thisPidNamespace();
	return JSON.stringify({
		pid: process.pid,
		writerId,
		startedAt: new Date().toISOString(),
		...(bootId === undefined ? {} : { bootId }),
		...(pidNs === undefined ? {} : { pidNs }),
		...(leased ? { leaseRenewMs: LEASE_RENEW_MS } : {}),
	});
}

// ── Leases: the proof that crosses PID namespaces ──

/**
 * What this process has seen of each other-namespace lease, by lock path: which file, at which mtime,
 * and since when (this process's MONOTONIC clock) it has seen exactly that. A different file or a new
 * mtime — a renewal — starts the observation over.
 */
const leaseWatch = new Map<string, { identity: string; mtimeNs: bigint; since: number }>();

/** A lock's declared renewal interval, when it is one this code honours; else the lock has no lease. */
function leaseRenewMsOf(lock: LockFileView): number | undefined {
	const ms = lock.leaseRenewMs;
	return typeof ms === "number" && Number.isSafeInteger(ms) && ms > 0 && ms <= LEASE_RENEW_MAX_MS
		? ms
		: undefined;
}

type LeaseVerdict =
	/** The lock declares no lease (an earlier version's), or one this code does not honour. */
	| { kind: "none" }
	/** Renewed within the stale threshold (or its mtime is ahead of this clock). */
	| { kind: "fresh"; ageMs: number; staleMs: number; confirmMs: number }
	/** Past the threshold, but this process has not yet seen it unrenewed for long enough. */
	| { kind: "confirming"; ageMs: number; staleMs: number; remainingMs: number }
	/** Past the threshold, and seen unrenewed for at least the confirmation window: the holder is gone. */
	| { kind: "expired"; ageMs: number; unchangedMs: number };

/**
 * Judge another namespace's lease. Both conditions must hold for `expired`, and either one alone is
 * not enough:
 *  - its mtime is more than the stale threshold behind this clock (`Date.now()`: the lease's own
 *    wall time, never a monotonic clock, which restarts at every boot and is not comparable with a
 *    timestamp in a file). An mtime AHEAD of this clock is fresh: fail toward live.
 *  - this process has seen the same file at the same mtime for at least the confirmation window of
 *    its own monotonic clock. Every call records what it sees, so the first look at a lease starts
 *    the window and a later acquire completes it.
 */
function judgeLease(lockPath: string, lock: LockFileView): LeaseVerdict {
	const renewMs = leaseRenewMsOf(lock);
	if (renewMs === undefined) return { kind: "none" };
	const staleMs = Math.max(LEASE_STALE_MS, 6 * renewMs);
	const confirmMs = Math.max(LEASE_CONFIRM_MS, 3 * renewMs);
	const now = performance.now();
	const seen = leaseWatch.get(lockPath);
	let since = now;
	if (seen !== undefined && seen.identity === lock.identity && seen.mtimeNs === lock.mtimeNs) {
		since = seen.since;
	} else {
		leaseWatch.set(lockPath, { identity: lock.identity, mtimeNs: lock.mtimeNs, since });
	}
	const ageMs = Date.now() - lock.mtimeMs;
	// `!(a > b)`, not `a <= b`: an age that is not a number is never expired.
	if (!(ageMs > staleMs)) return { kind: "fresh", ageMs, staleMs, confirmMs };
	const unchangedMs = now - since;
	if (unchangedMs < confirmMs) {
		return { kind: "confirming", ageMs, staleMs, remainingMs: confirmMs - unchangedMs };
	}
	return { kind: "expired", ageMs, unchangedMs };
}

/** Milliseconds as whole seconds for a message (an mtime ahead of the clock reads as 0s). */
function secondsOf(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/**
 * The safe recovery steps a refusal that is never resolved from here prints: confirm that nothing
 * writes the vault any more (on every platform it may run on), remove exactly this one file, and
 * verify the chain. The vault root is the lock's directory's grandparent
 * (`<root>/.usertrust/audit/.audit-writer.lock`).
 */
function recoverySteps(lockPath: string): string {
	const vaultRoot = dirname(dirname(dirname(lockPath)));
	return ` To recover by hand, only once no process can still be writing this vault: (1) confirm that no writer is running in any host, WSL distribution or container that can reach the vault. On Linux, WSL and macOS run \`ps -eo pid,args | grep -iE 'usertrust|node'\`; on Windows, \`wsl --list --running\` lists the running WSL distributions (run the ps command in each), \`docker ps\` lists the containers, and \`tasklist /FI "IMAGENAME eq node.exe"\` lists native Node processes. (2) Remove exactly this file and nothing else: ${lockPath} (\`rm -- <file>\` on Linux, WSL and macOS; \`Remove-Item -LiteralPath <file>\` in PowerShell). (3) Verify the chain: \`usertrust verify ${vaultRoot}\`.`;
}

/** Why another namespace's lock is held, by what its lease says. */
function foreignHeldMessage(lockPath: string, lock: LockFileView, lease: LeaseVerdict): string {
	const head = `Audit writer lock held by PID ${describeLockPid(lock.pid)} in another PID namespace (${describeLockField(lock.pidNs, PID_NS)}). This process cannot probe that namespace.`;
	let why: string;
	switch (lease.kind) {
		case "fresh":
			why = ` Its holder renewed its lease ${secondsOf(lease.ageMs)} ago, so it is treated as live. If that holder is gone, the lock is reclaimed automatically once the lease has gone unrenewed for more than ${secondsOf(lease.staleMs)} and this process has seen it unrenewed for ${secondsOf(lease.confirmMs)}, at an append after that.`;
			break;
		case "confirming":
			why = ` Its lease was last renewed ${secondsOf(lease.ageMs)} ago, more than the ${secondsOf(lease.staleMs)} after which a holder counts as gone. It is reclaimed automatically at the first append after this process has seen it unrenewed for another ${secondsOf(lease.remainingMs)}; nothing needs to be done by hand if its holder is gone.`;
			break;
		default:
			why =
				" The lock carries no lease (it was written by a usertrust version that does not renew one), so it is never reclaimed automatically from another namespace.";
	}
	return `${head}${why}${recoverySteps(lockPath)} Lock file: ${lockPath}`;
}

/**
 * Remove a lock file that no live writer in this process holds (the caller has established that,
 * from a successful read). Throws if a live process (another PID) holds it.
 *
 * In order: the same PID in the same namespace (or a lock that names none) is a crashed earlier
 * instance of this PID. Anything else is another process's lock: HELD if its namespace is another
 * one, or cannot be compared — FIRST, whatever its boot id, since a private boot id (a
 * systemd-nspawn container's) would otherwise make a live writer beside it look like a previous
 * boot's — except another namespace's lock whose LEASE has expired ({@link judgeLease}), which is
 * reclaimed; then reclaimed if it was written before this boot (exact boot ids, both known);
 * otherwise judged by `kill(pid, 0)`, as before.
 */
function tryCleanStaleLock(lockPath: string, lock: LockFileView): void {
	const { pid } = lock;
	const namespace = namespaceOf(lock);
	try {
		if (pid === process.pid && (namespace === "same" || namespace === "unrecorded")) {
			// Same PID, and no live writer in this process holds the file (see liveHolderOf): a
			// crashed earlier instance of this PID — a container's PID 1 is the usual one — or a
			// copy of a lock. Nothing in this process can be appending under it.
			console.warn(
				`[AUDIT] Reclaiming stale same-PID lock (PID ${process.pid}). Previous process exited without releasing the lock.`,
			);
			unlinkSync(lockPath);
			return;
		}
		if (namespace === "foreign") {
			// A PID probe means nothing here, and neither does a differing boot id (nspawn). Only a
			// lease the holder stopped renewing proves it gone: see judgeLease. No lease, held.
			const lease = judgeLease(lockPath, lock);
			if (lease.kind === "expired") {
				console.warn(
					`[AUDIT] Reclaiming a lock from another PID namespace whose lease expired (PID ${describeLockPid(pid)}, namespace ${describeLockField(lock.pidNs, PID_NS)}; last renewed ${secondsOf(lease.ageMs)} ago, seen unrenewed for ${secondsOf(lease.unchangedMs)}).`,
				);
				leaseWatch.delete(lockPath);
				unlinkSync(lockPath);
				return;
			}
			throw new AuditWriterLockHeldError(foreignHeldMessage(lockPath, lock, lease));
		}
		if (namespace === "unknown") {
			throw new AuditWriterLockHeldError(
				`Audit writer lock held by PID ${describeLockPid(pid)} in a PID namespace this process cannot compare with its own. The lock is never reclaimed from here.${recoverySteps(lockPath)} Lock file: ${lockPath}`,
			);
		}
		if (writtenBeforeThisBoot(lock)) {
			// From this namespace (or one unrecorded), and its PID was recorded before this boot: it
			// names no process of this one, whatever process carries that number now.
			console.warn(
				`[AUDIT] Reclaiming a lock written before this boot (PID ${describeLockPid(pid)}, boot ${describeLockField(lock.bootId, BOOT_ID)}; this boot ${describeLockField(thisBootId(), BOOT_ID)}).`,
			);
			unlinkSync(lockPath);
			return;
		}
		try {
			process.kill(pid as number, 0);
			// Process is alive — lock is held
			throw new AuditWriterLockHeldError(
				`Audit writer lock held by PID ${describeLockPid(pid)}. Only one process may write to the audit log. Lock file: ${lockPath}`,
			);
		} catch (killErr: unknown) {
			if (hasFsCode(killErr, "ESRCH")) {
				// Process is dead — stale lock
				unlinkSync(lockPath);
				return;
			}
			if (hasFsCode(killErr, "EPERM")) {
				throw new AuditWriterLockHeldError(
					`Audit writer lock held by PID ${describeLockPid(pid)}. Only one process may write to the audit log. Lock file: ${lockPath}`,
				);
			}
			throw killErr;
		}
	} catch (err) {
		if (err instanceof AuditWriterLockHeldError) {
			throw err;
		}
		// Corrupt lock file (no usable pid), or already gone — remove it
		try {
			unlinkSync(lockPath);
		} catch {
			/* best effort */
		}
	}
}

/**
 * A lock's private temp file, `<lock>.<writerId>.tmp` in the lock's own directory. Only the exact
 * name `.audit-writer.lock` is ever read as a lock: a temp file — complete, half-written, or left
 * by a writer that crashed — never is.
 */
const LOCK_TEMP_NAME =
	/^\.audit-writer\.lock\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/**
 * How old a temp file must be before {@link sweepLeftoverTemps} removes it. A live create holds its
 * temp file for a few syscalls; this is far longer. The age is only ever a HOUSEKEEPING judgement,
 * never a lock's: removing a live creator's temp file can only fail that create (its link meets
 * ENOENT), never admit a second writer.
 */
const LEFTOVER_TEMP_AGE_MS = 60_000;

/** `link` answers these where the filesystem cannot make a hard link (FAT/exFAT, some network and FUSE mounts). */
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);

/** Remove a temp file, if it is there. Never throws: an unremoved temp file is never read as a lock. */
function removeTemp(tmp: string): void {
	try {
		unlinkSync(tmp);
	} catch {
		/* gone already, or left for the sweep */
	}
}

/**
 * Write `content` to the private temp file `tmp` — created exclusively, never through a symlink,
 * written in full and fsync'd — and return its `dev:ino`, read through the create's own fd. On any
 * failure the temp file is removed and the error thrown.
 *
 * A temp file already at `tmp` is this writer's own leftover: the name carries the writer's random
 * id, and one writer never takes two locks at once (every acquire is synchronous). It is removed
 * and the create made afresh.
 *
 * `wantLease`: the lock should declare a lease. It does so only if this very file's mtime can be
 * set through its fd — the inode the lock will be, so the renewal that must follow is the call
 * proven to work here. A lock that declared a lease its holder could not renew would read as
 * expired to another namespace while that holder is live. `leased` says what was declared.
 */
function writeLockTemp(
	tmp: string,
	contentFor: (leased: boolean) => string,
	wantLease: boolean,
): { identity: string; leased: boolean; stampedAt: number } {
	const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;
	let fd: number;
	try {
		fd = openSync(tmp, flags, 0o600);
	} catch (err) {
		if (!hasFsCode(err, "EEXIST")) throw err;
		unlinkSync(tmp);
		fd = openSync(tmp, flags, 0o600);
	}
	try {
		try {
			const st = fstatSync(fd, { bigint: true });
			// Read BEFORE the write that sets the mtime others see: the lease's first renewal, never later
			// than that mtime (see LEASE_HOLDER_BOUND_MS).
			const stampedAt = performance.now();
			let leased = false;
			if (wantLease) {
				try {
					const now = new Date();
					futimesSync(fd, now, now);
					leased = true;
				} catch {
					/* this filesystem cannot renew a lease: the lock declares none, and is judged as before */
				}
			}
			writeFully(fd, contentFor(leased));
			fsyncSync(fd);
			return { identity: `${st.dev}:${st.ino}`, leased, stampedAt };
		} finally {
			closeSync(fd);
		}
	} catch (err) {
		removeTemp(tmp);
		throw err;
	}
}

/**
 * Fsync `dir`, so the lock's link (and its temp file's removal) reach the disk. Best effort, as
 * the spend ledger's directory fsync is: a platform that cannot fsync a directory is silent, and
 * any other failure is reported and does not fail the acquire. Nothing depends on the lock
 * surviving a power loss — every writer that held it dies with that boot.
 */
function syncDirectory(dir: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(dir, fsConstants.O_RDONLY);
		fsyncSync(fd);
	} catch (err) {
		const code = errorCode(err);
		const unsupported =
			code === "EINVAL" ||
			code === "ENOTSUP" ||
			code === "EOPNOTSUPP" ||
			code === "EISDIR" ||
			code === "EPERM" ||
			code === "EBADF";
		if (!unsupported) {
			console.warn(
				`[AUDIT] Audit writer lock directory not fsynced (${code ?? "unknown error"}); the lock is held regardless.`,
			);
		}
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* a directory fd: nothing was written through it */
			}
		}
	}
}

/**
 * Remove temp files that crashed writers left in `dir` (a writer that died between its temp file's
 * create and its removal leaves one behind, one per crash). Run by a writer that has just taken
 * the lock, so they cannot accumulate without bound. Only names of the temp-file form, only once
 * older than {@link LEFTOVER_TEMP_AGE_MS}; `lstat` and `unlink` never follow a symlink. Best
 * effort: a temp file that cannot be judged or removed is left for a later sweep.
 */
function sweepLeftoverTemps(dir: string): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of names) {
		if (!LOCK_TEMP_NAME.test(name)) continue;
		const path = join(dir, name);
		try {
			const st = lstatSync(path);
			if (st.isDirectory() || now - st.mtimeMs < LEFTOVER_TEMP_AGE_MS) continue;
			unlinkSync(path);
		} catch {
			/* gone, or not removable now: a later sweep tries again */
		}
	}
}

/**
 * The lock file's exclusive create. On success the lock is this writer's: recorded in
 * {@link heldLocks} and `true` returned. `false` means the lock file exists (EEXIST).
 *
 * The lock APPEARS COMPLETE: its content is written in full and fsync'd to a private temp file
 * ({@link writeLockTemp}), which is then hard-linked to the lock's name. `link` never replaces an
 * existing name — it fails with EEXIST — so it is the atomic exclusive create, and two processes
 * that both found a lock stale and both removed it cannot both take it. And no reader ever finds
 * the lock's name with no content, or half of it: an exclusive create followed by a write left
 * exactly that window, and a reader that judged the empty lock corrupt removed a LIVE writer's lock.
 * `link` does not follow a symlink at the lock's name; a name that is taken is taken. This link,
 * at a PATH, is the ONLY cross-process exclusion.
 *
 * A filesystem that cannot make a hard link fails the acquire, closed: falling back to the exclusive
 * create and write would bring that window back, and a forked chain is worse than a writer that
 * cannot start. The error keeps `link`'s code.
 *
 * The identity is read through the temp file's create fd — the link gives the lock that very inode
 * — so it is the file THIS create made, never one swapped in after it. The temp file is removed
 * on every path, success included.
 *
 * Registered only after EVERYTHING succeeded. A failure after the link throws with nothing
 * registered — an owner registered by an acquire that threw could never be released (the caller
 * gets no writer, and a scoped lock never reaches its release) and would refuse this vault in this
 * process for good — and removes the lock the link made, if it is still that file (its inode AND
 * this writer's id: an inode alone is reused on Linux), so no lock is left behind for other
 * processes either.
 */
function createLock(lockPath: string, writerId: string, leasable: boolean): boolean {
	const tmp = `${lockPath}.${writerId}.tmp`;
	// A lease is declared only where another namespace could judge this lock, i.e. where the lock
	// names this process's namespace (elsewhere, with no /proc, no reader ever consults it), and only
	// for a holder whose every write re-checks the lock first (`leasable`: see acquireProcessLock).
	const { identity, leased, stampedAt } = writeLockTemp(
		tmp,
		(withLease) => lockContentFor(writerId, withLease),
		leasable && thisPidNamespace() !== undefined,
	);
	try {
		linkSync(tmp, lockPath);
	} catch (err) {
		removeTemp(tmp);
		if (hasFsCode(err, "EEXIST")) return false;
		const code = errorCode(err);
		if (code !== undefined && LINK_UNSUPPORTED.has(code)) {
			throw Object.assign(
				new Error(
					`Audit writer lock cannot be created: link() failed with ${code}, so this filesystem cannot make the hard link the lock is created with. A vault's audit directory must be on a filesystem with hard links (see LIMITATIONS.md). Lock file: ${lockPath}`,
					{ cause: err },
				),
				{ code },
			);
		}
		throw err;
	}
	removeTemp(tmp);
	syncDirectory(dirname(lockPath));
	// The link succeeded — but WHERE? The directory can be replaced between the temp file's create
	// and now, and then the lock this create made sits in the old directory while the requested one
	// has none (or another writer's). Success is reported only if the file at the requested path is
	// the one this create made: its inode AND this writer's id, read through one fd.
	let there: LockFileView | undefined;
	try {
		there = readLockFile(lockPath);
	} catch (err) {
		rollBackCreate(lockPath, identity, writerId);
		throw err;
	}
	if (there?.identity !== identity || there.writerId !== writerId) {
		throw new AuditWriterLockHeldError(
			`Audit writer lock not taken: the lock file at ${lockPath} is not the one this writer just created — its directory was replaced while the lock was being taken. Only one writer may append to the audit log; retry once the vault is stable.`,
		);
	}
	let mine = heldLocks.get(writerId);
	if (mine === undefined) {
		mine = new Map();
		heldLocks.set(writerId, mine);
	}
	mine.set(identity, {
		path: lockPath,
		leased,
		acquisitionId: randomUUID(),
		renewedAt: stampedAt,
	});
	if (leased) startLeaseRenewal();
	return true;
}

/** The one timer that renews every leased lock this process holds; running only while there is one. */
let leaseTimer: ReturnType<typeof setInterval> | undefined;

function startLeaseRenewal(): void {
	if (leaseTimer !== undefined) return;
	leaseTimer = setInterval(renewLeases, LEASE_RENEW_MS);
	// The renewal never keeps a process alive: a process that is otherwise done exits, and its
	// lease then lapses, which is what a lease is for.
	leaseTimer.unref?.();
}

/** Stop the timer once no lock any writer here holds is leased (and not lapsed). */
function stopLeaseRenewalIfIdle(): void {
	if (leaseTimer === undefined) return;
	for (const locks of heldLocks.values()) {
		for (const lock of locks.values()) if (lock.leased && lock.lapsed !== true) return;
	}
	clearInterval(leaseTimer);
	leaseTimer = undefined;
}

/**
 * Renew every leased lock every live writer in this process holds — or, for one whose renewals have
 * failed past {@link LEASE_HOLDER_BOUND_MS}, give it up ({@link lapseLease}) instead: a renewal that
 * succeeds after that point must not revive a lease an observer may already be about to reclaim.
 */
function renewLeases(): void {
	const now = new Date();
	for (const [writerId, locks] of heldLocks) {
		for (const [identity, lock] of locks) {
			// A lapsed entry waiting for its file's removal: the next append, or release, retries it.
			if (!lock.leased || lock.lapsed === true) continue;
			if (!leaseLapsed(lock)) {
				renewLease(lock, identity, writerId, now);
				continue;
			}
			const outcome = lapseLease(writerId, identity, lock);
			// Reported at the writer's next acquire, as THIS acquisition's lapse: an acquire that finds a
			// healthy newer acquisition of this writer at the vault (it lost this one while stalled and
			// took the vault again) drops the report, so it never refuses an append under that one.
			lapsedLeases.set(writerId, { identity, message: lapseMessage(lock, outcome) });
		}
	}
}

/** Has this held lease gone without a successful renewal for longer than the holder's bound? */
function leaseLapsed(lock: HeldLock): boolean {
	return lock.leased && performance.now() - lock.renewedAt > LEASE_HOLDER_BOUND_MS;
}

/**
 * A lapse the renewal timer found, until the writer's next acquire reports it: WHICH acquisition
 * lapsed (its lock file's `dev:ino`) and why. The report belongs to that acquisition, not the writer:
 * an acquire that finds a healthy NEWER acquisition of this writer at the vault drops it unreported
 * (see {@link healthyAcquisitionAt}).
 */
const lapsedLeases = new Map<string, { identity: string; message: string }>();

/**
 * Is the file at `lockPath` a healthy acquisition of `writerId` other than `lapsedIdentity`:
 * registered, not lapsed, and within its bound? A read that fails answers no (the report stands).
 */
function healthyAcquisitionAt(lockPath: string, writerId: string, lapsedIdentity: string): boolean {
	try {
		const file = readLockFile(lockPath);
		if (file === undefined || file.identity === lapsedIdentity || file.writerId !== writerId) {
			return false;
		}
		const lock = heldLocks.get(writerId)?.get(file.identity);
		return lock !== undefined && lock.lapsed !== true && !leaseLapsed(lock);
	} catch {
		return false;
	}
}

/** An errno code fit for a message, else `unknown`. */
function describeCode(code: string | undefined): string {
	return code !== undefined && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown";
}

/**
 * What giving up a lapsed lease did:
 *  - `removed`: its file was this lock, and is gone; the entry left the registry.
 *  - `lost`: its file is not at the path last seen (absent, or another acquisition's there). Nothing
 *    is removed. The entry STAYS, marked lapsed, as a non-owning cleanup
 *    record: "absent" can also mean the vault was RENAMED with the lock in it, and `release()` then
 *    still finds the lock through the caller's current spelling (see releaseLocks).
 *  - `stranded`: its file could not be read or removed (`code`). The entry STAYS, marked lapsed, as the
 *    cleanup record: the next append and `release()` retry the removal, and a release that still
 *    cannot remove it reports it (`AuditLockReleaseError`, the teardown warning).
 */
type LapseOutcome = "removed" | "lost" | { stranded: string };

/**
 * Give up a lease that lapsed. It is not renewed again, `lockOwner()` no longer names it, and it never
 * authorizes a write again. Its file is removed if it is still this lock (inode AND writerId; a lock
 * another writer put there is left alone). Removed rather than left: this writer will not write under
 * it again, and a lock left in place would only keep this namespace's other processes waiting on a
 * live PID. The writer's next append takes the vault afresh — a new lock, a new lease if the mtime can
 * be set, and the tail re-read from the log.
 */
function lapseLease(writerId: string, identity: string, lock: HeldLock): LapseOutcome {
	lock.lapsed = true;
	stopLeaseRenewalIfIdle();
	let outcome: LapseOutcome;
	try {
		const file = readLockFile(lock.path);
		if (file?.identity === identity && file.writerId === writerId) {
			unlinkSync(lock.path);
			outcome = "removed";
		} else {
			outcome = "lost";
		}
	} catch (err) {
		return { stranded: describeCode(errorCode(err)) };
	}
	// Only a file this writer just removed ends the record; a `lost` one keeps it (above).
	if (outcome === "removed") {
		const mine = heldLocks.get(writerId);
		mine?.delete(identity);
		if (mine?.size === 0) heldLocks.delete(writerId);
	}
	return outcome;
}

/** The refusal for a lapsed lease, naming its cause and what became of its lock. */
function lapseMessage(lock: HeldLock, outcome: LapseOutcome): string {
	const what =
		typeof outcome === "object"
			? `the lock could not be removed (${outcome.stranded}): each append retries, and release reports it if it still cannot`
			: "the lock was given up";
	return `Audit writer lease lapsed: no renewal of this writer's lock succeeded for ${secondsOf(performance.now() - lock.renewedAt)} (last renewal error: ${lock.renewalError === undefined ? "none — no renewal ran" : describeCode(lock.renewalError)}), more than the ${secondsOf(LEASE_HOLDER_BOUND_MS)} after which this writer stops: a writer in another PID namespace could begin to reclaim the lock ${secondsOf(LEASE_CONFIRM_MS)} after its last renewal. This append is refused so no takeover can land under a write; ${what}. The next append takes the vault's lock afresh. Lock file: ${lock.path}`;
}

/**
 * Renew one lease: set the lock file's mtime to `now` — through an fd whose file is PROVEN to be
 * this lock (its create-time inode AND this writer's id, read through that same fd), so a renewal can
 * never touch a lock another writer took after this one lost it: `futimes` acts on the inode, not on
 * a path that may name someone else's file by now. Never throws (it runs on a timer): a lock that is
 * gone, moved or another's is simply not renewed. Losing the lock is noticed where it matters, at the
 * next append, which verifies its own lock before it writes. A failure is recorded, and only a success
 * moves `renewedAt`: renewals that keep failing lapse the lease (LEASE_HOLDER_BOUND_MS).
 */
function renewLease(lock: HeldLock, identity: string, writerId: string, now: Date): void {
	let fd: number;
	try {
		fd = openSync(lock.path, fsConstants.O_RDONLY | O_NOFOLLOW);
	} catch (err) {
		lock.renewalError = errorCode(err) ?? "unknown";
		return;
	}
	try {
		const file = readLockFd(fd);
		if (file.identity === identity && file.writerId === writerId) {
			// Read BEFORE the futimes: never later than the mtime it sets (see LEASE_HOLDER_BOUND_MS).
			const before = performance.now();
			futimesSync(fd, now, now);
			lock.renewedAt = before;
			lock.renewalError = undefined;
		}
	} catch (err) {
		// Not renewed: `renewedAt` stays where the last SUCCESS left it, and the bound counts on.
		lock.renewalError = errorCode(err) ?? "unknown";
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* opened read-only: nothing was written through it */
		}
	}
}

/**
 * Undo a create that will not be reported: unlink the file at `lockPath` if it is still the one
 * the create made — its inode AND this writer's id. The inode ALONE is not this file: once it is
 * unlinked, Linux (ext4) hands the freed inode to the very next file created, so a lock another
 * writer put here in the meantime can carry it, and unlinking that would free a LIVE lock. A file
 * that cannot be read is left — unregistered, a same-PID lock nobody here holds. (Like every
 * check-then-unlink by path here, this has a window if the directory itself is replaced
 * concurrently: see the threat model at the top of this section.)
 */
function rollBackCreate(lockPath: string, identity: string, writerId: string): void {
	try {
		const file = readLockFile(lockPath);
		if (file?.identity === identity && file.writerId === writerId) unlinkSync(lockPath);
	} catch {
		/* cannot tell: leave it — unregistered, it is a same-PID lock nobody here holds */
	}
}

/**
 * Is `file` — the lock file at `lockPath` — this writer's own? Then remember where it is NOW: the
 * directory may have been renamed since this writer last saw it (and the caller's symlink
 * repointed), and release must reach it.
 */
function verifyOwnLockFile(file: LockFileView, lockPath: string, writerId: string): boolean {
	const holder = liveHolderOf(file);
	if (holder?.writerId !== writerId) return false;
	holder.lock.path = lockPath;
	return true;
}

/**
 * The acquisition id of the lock `writerId` holds on the log at `logPath` RIGHT NOW: registered here
 * AND the file at that path is its own (a fresh read). Registration alone is not enough: another
 * namespace may have reclaimed an expired lease since, and the registry keeps a lost lock's entry
 * until release. A read that fails answers none (fail toward "not the holder": the caller publishes
 * nothing).
 */
function currentAcquisition(logPath: string, writerId: string): string | undefined {
	if (!heldLocks.has(writerId)) return undefined;
	try {
		const lockPath = join(canonicalPath(dirname(logPath)), LOCK_FILE_NAME);
		const file = readLockFile(lockPath);
		if (file === undefined || !verifyOwnLockFile(file, lockPath, writerId)) return undefined;
		const lock = heldLocks.get(writerId)?.get(file.identity);
		return lock === undefined || lock.lapsed === true || leaseLapsed(lock)
			? undefined
			: lock.acquisitionId;
	} catch {
		return undefined;
	}
}

/**
 * Take (or confirm) the vault's advisory lock. Returns `true` when a lock file was CREATED by this
 * call, `false` when the writer's existing lock was verified still held. A writer whose earlier
 * lock turned out to be gone gets `true` here: its lock was lost for a while, someone else may
 * have appended (and failed) in that time, so the directory is synced again before anything chains
 * from what is there.
 *
 * Every decision is made from the lock FILE in the requested directory — whose it is, read from
 * the file — never from a directory's identity or a remembered path. A lock file that cannot be
 * read makes this THROW: it is never reclaimed.
 *
 * `leasable`: the lock may declare a lease, so another namespace may reclaim it once its renewals
 * stop. Only a holder whose EVERY write to the vault goes through `appendEvent`, which re-checks the
 * lock before it writes, may say so. A holder that mutates the vault in other ways under the lock (a
 * snapshot restore's renames, a quarantine's cut) has no such check, and after losing a lease while
 * paused it would overwrite or cut the new holder's events: its lock declares no lease, and is held
 * from another namespace as before.
 */
function acquireProcessLock(logPath: string, writerId: string, leasable: boolean): boolean {
	// The directory the OS opens for the log, resolved as a vault is ({@link canonicalPath}):
	// realpath(3), or the portable resolver only where it names that same directory. The portable
	// resolver alone folds a `..` in a link's target lexically, which put the lock in ANOTHER directory
	// than the log's (a link `.usertrust -> a/link/../vault`), where a second writer never met it. An
	// absent directory throws ENOENT here, before anything is created.
	const dir = canonicalPath(dirname(logPath));
	const lockPath = join(dir, LOCK_FILE_NAME);

	// A writer that already holds a lock first looks for it here, so its every append does not
	// create (and fsync) a temp file only to meet EEXIST. The same decision from the same read the
	// create's EEXIST would lead to: the file carries this writer's id and inode, so it is this
	// writer's. Anything else falls through to the create.
	// A lease that lapsed since this writer's last append (its renewal timer gave the lock up) is
	// reported here, once: this append is refused, and the next one takes the vault afresh. Unless the
	// lapse was an OLDER acquisition's and a healthy newer one of this writer holds the vault now: then
	// this append is not refused for it.
	const lapsed = lapsedLeases.get(writerId);
	if (lapsed !== undefined) {
		lapsedLeases.delete(writerId);
		if (!healthyAcquisitionAt(lockPath, writerId, lapsed.identity)) {
			throw new AuditLeaseLapsedError(lapsed.message);
		}
	}
	if (heldLocks.has(writerId)) {
		const file = readLockFile(lockPath);
		if (file !== undefined && verifyOwnLockFile(file, lockPath, writerId)) {
			// The holder's bound, checked in the same synchronous span as the ownership check and the
			// write after it (no await between them): renewals that failed for too long stop the write
			// before any observer can reclaim the lock under it.
			const lock = heldLocks.get(writerId)?.get(file.identity);
			if (lock !== undefined && (lock.lapsed === true || leaseLapsed(lock))) {
				// Lapsed NOW: refused. Lapsed earlier (already reported) with its file still here: the
				// removal is retried, and only once it succeeds does this append go on, to take the vault
				// afresh below.
				const reported = lock.lapsed === true;
				const outcome = lapseLease(writerId, file.identity, lock);
				if (!reported || typeof outcome === "object") {
					throw new AuditLeaseLapsedError(lapseMessage(lock, outcome));
				}
			} else {
				return false;
			}
		}
	}

	if (createLock(lockPath, writerId, leasable)) {
		sweepLeftoverTemps(dir);
		return true;
	}

	// The lock file exists. Whose it is, the file says — and a read that fails throws out of here.
	const file = readLockFile(lockPath);
	if (file !== undefined && verifyOwnLockFile(file, lockPath, writerId)) return false;
	const holder = file === undefined ? undefined : liveHolderOf(file);
	if (holder !== undefined) {
		// A LIVE writer in this process holds this vault → refuse.
		throw new AuditWriterLockHeldError(
			`Audit writer lock held by another writer in this process (dir ${dir}). Only one writer per vault per process.`,
		);
	}

	// Read, and no live writer in this process holds it: stale, or another process's. (Gone
	// since the EEXIST: nothing to clean.)
	if (file !== undefined) tryCleanStaleLock(lockPath, file);

	// Second attempt after stale lock cleanup. If another process raced us and
	// already re-created the lock, EEXIST here means they won — report as held.
	if (createLock(lockPath, writerId, leasable)) {
		sweepLeftoverTemps(dir);
		return true;
	}
	throw new AuditWriterLockHeldError(
		`Audit writer lock acquired by another process during stale lock cleanup. Lock file: ${lockPath}`,
	);
}

/**
 * Release EVERY lock `writerId` holds. Each is unlinked only if the file is still that lock (the
 * writerId and the create-time inode). Once it is not, the file at that path belongs to whoever
 * took the lock since — unlinking it would free a LIVE writer's lock for a third writer.
 *
 * Each lock is looked for where it was last seen, then where the caller's spelling leads NOW: a
 * vault renamed while its lock was held (its symlink repointed to the new name) takes the lock
 * file with it, and a writer with no acquire since — a scoped lock above all — never saw it move.
 * Neither place is trusted: the file found must be this lock.
 *
 * Every lock is attempted, whatever happens to one of them. A lock that could not be READ, or whose
 * unlink failed, is left in place and REPORTED: after the last lock, one {@link AuditLockReleaseError} lists each
 * left behind. A left-behind lock stops other processes until this PID exits; this process reclaims
 * it only after reading it successfully.
 *
 * The writer is deregistered in any case — it is done writing, and keeping it registered would
 * refuse its vaults in this process for good.
 */
function releaseLocks(writerId: string, logPath: string): void {
	lapsedLeases.delete(writerId);
	const held = heldLocks.get(writerId);
	if (held === undefined) return;
	heldLocks.delete(writerId);
	stopLeaseRenewalIfIdle();
	let spelled: string | undefined;
	try {
		spelled = join(canonicalPath(dirname(logPath)), LOCK_FILE_NAME);
	} catch {
		/* the caller's spelling no longer leads anywhere */
	}
	const failures: Array<{ path: string; error: unknown }> = [];
	for (const [identity, lock] of held) {
		// Each place is looked at once: a read that just failed is not retried as if it were news.
		const candidates =
			spelled === undefined || spelled === lock.path ? [lock.path] : [lock.path, spelled];
		// Where each failure happened: the lock is reported where it was actually found to fail —
		// after a rename, that is the new place, not the path the lock was last seen at.
		const problems: Array<{ path: string; error: unknown }> = [];
		let released = false;
		for (const candidate of candidates) {
			try {
				const file = readLockFile(candidate);
				if (file?.writerId !== writerId || file.identity !== identity) continue;
				unlinkSync(candidate);
				released = true;
			} catch (err) {
				// The unlink losing a race to another remover: the lock is gone, which is the point.
				if (hasFsCode(err, "ENOENT")) released = true;
				else problems.push({ path: candidate, error: err });
			}
			if (released) break;
		}
		const failed = problems[0];
		if (!released && failed !== undefined) failures.push(failed);
	}
	if (failures.length > 0) throw new AuditLockReleaseError(failures);
}

/**
 * Run `fn` while holding the audit writer's advisory lock for the vault whose
 * audit log is `logPath`. Acquires the same in-process live-writer registration
 * + on-disk lock that {@link createAuditWriter} uses, so a live writer on the
 * same vault in this process is refused. Use this to mutate the audit log
 * outside the writer (e.g. snapshot restore) without risking a forked chain.
 *
 * The lock is always released, even if `fn` throws. A lock that could not be released rejects
 * with an {@link AuditLockReleaseError} naming it — unless `fn` threw: then `fn`'s error is the rejection,
 * unchanged, and the release failure is reported to `console.error` beside it.
 */
export async function withAuditWriterLock<T>(
	logPath: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	const writerId = randomUUID();
	// Never leased: `fn` mutates the vault without the per-append ownership check.
	acquireProcessLock(logPath, writerId, false);
	let result: T;
	try {
		result = await fn();
	} catch (fnErr) {
		try {
			releaseLocks(writerId, logPath);
		} catch (releaseErr) {
			// One scrubbed line, never the error object: its message and nested errors carry the
			// lock's path raw, and a directory name can carry terminal escapes.
			console.error(
				`[AUDIT] Audit writer lock release failed after an error in the locked section: ${describeReleaseFailure(releaseErr)}`,
			);
		}
		throw fnErr;
	}
	releaseLocks(writerId, logPath);
	return result;
}

// ── The tail, classified on every append ──

const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

/**
 * The log opened BY PATH for an append, never through a descriptor kept from an earlier one: a log
 * replaced by another file renamed over it, even one of the same size, is the file at the path now, and that is what is
 * classified and written. `O_NOFOLLOW`: never through a symlink; `O_NONBLOCK`: a FIFO in its place
 * never blocks the open. Never created here: `undefined` means absent, and what a failed open stands
 * for (a symlink, a directory, a FIFO, or a log that cannot be opened) is classified like any input.
 */
function openLogByPath(logPath: string): { fd: number } | { fd: undefined; log: LogObservation } {
	try {
		return {
			fd: openSync(logPath, fsConstants.O_RDWR | fsConstants.O_APPEND | O_NOFOLLOW | O_NONBLOCK),
		};
	} catch (err) {
		return { fd: undefined, log: openFailure(err) };
	}
}

/** Whether a line read from the tail is an event without a `sequence` (written by an older version). */
function isLegacyEvent(line: Buffer): boolean {
	const parsed = parseLine(line);
	return parsed.kind === "event" && parsed.sequence === undefined;
}

/**
 * Classify the vault's audit tail for an append: the log through `opened` (its tail read backward
 * through that descriptor, bounded), the `.meta` anchor, and the names in `audit/` and
 * `audit/quarantine/`, each acquired without following a link or blocking on a FIFO (the audit
 * directory itself is the one the OS opens at its path, as every reader lists it). Whenever one of
 * the last two lines is a legacy event (one without a `sequence`, written by an older version), its
 * position is its line number, so the log's lines are counted: a full read, on every append and
 * pre-flight while such a line is one of the last two (a vault's first appends after an upgrade).
 * A read that fails on the open log is LOG_UNREADABLE, by name, like any other input.
 */
/**
 * The tail as an append would classify it, through the descriptor it would write through, with the
 * length in bytes of the log's last complete line as that read found it (0 with no log, or no line).
 */
function classifyForAppend(
	auditDir: string,
	logPath: string,
	opened: ReturnType<typeof openLogByPath>,
): { tail: TailState; lastLineBytes: number } {
	let log: LogObservation;
	if (opened.fd === undefined) {
		log = opened.log;
	} else {
		try {
			const st = fstatSync(opened.fd);
			if (!st.isFile()) {
				log = { kind: "not_regular", fileKind: fileKindOf(st) };
			} else {
				log = readLogTail(opened.fd, st.size);
				if (log.kind === "tail" && !log.tail.fromStart && log.tail.lines.some(isLegacyEvent)) {
					const tail: LogTail = { ...log.tail, count: countLogLines(opened.fd, st.size) };
					log = { kind: "tail", tail };
				}
			}
		} catch (err) {
			log = { kind: "unavailable", code: errorCode(err) ?? "EUNKNOWN" };
		}
	}
	const tail = classifyAuditTail(
		{
			audit: listDirectory(auditDir, MAX_INVENTORY_NAMES, true),
			quarantine: listDirectory(join(auditDir, "quarantine")),
			log,
			anchor: acquireSmallFile(`${logPath}.meta`, MAX_ANCHOR_BYTES),
		},
		"writer",
	);
	const lastLineBytes = log.kind === "tail" ? (log.tail.lines.at(-1)?.length ?? 0) : 0;
	return { tail, lastLineBytes };
}

/** The error an append refused in `tail` throws: nothing has been written. */
function refusalOf(logPath: string, tail: TailState): Error {
	return tail.torn !== null
		? new AuditTornTailError(logPath, tail.torn.length, tail)
		: new AuditTailMismatchError(logPath, tail);
}

/**
 * Fsync a directory the chain depends on. Only an UNSUPPORTED directory fsync (`isUnsupportedDirSync`)
 * is tolerated, as for the anchor's rename: a genuine failure (`EIO`) throws, and the append it
 * guards does not chain from entries a crash could still roll back.
 */
function syncDirectoryForChain(dir: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(dir, fsConstants.O_RDONLY);
		fsyncSync(fd);
	} catch (err) {
		if (!isUnsupportedDirSync(err)) throw err;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Fsync a directory, best effort: a failure changes nothing that depends on it. */
function syncDirectoryBestEffort(dir: string): void {
	try {
		syncDirectoryForChain(dir);
	} catch {
		/* best effort */
	}
}

/** An event ready to append: the hashed object, its hash, and the exact line persisted. */
interface BuiltEvent {
	event: AuditEvent & { sequence: number };
	hash: string;
	sequence: number;
	/** The canonical bytes persisted, without the newline. */
	line: string;
	/** Its kind, actor and data as persisted: what a dead letter records. */
	persistedInput: AppendEventInput;
}

/**
 * Build the event that chains from `previousHash` at `sequence`, and the bytes that persist it.
 * Throws on an input that cannot be hashed as it would be persisted, before anything is written.
 */
function buildEvent(input: AppendEventInput, previousHash: string, sequence: number): BuiltEvent {
	const event: Omit<AuditEvent, "hash"> & { sequence: number } = {
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		previousHash,
		kind: input.kind,
		actor: input.actor,
		data: input.data,
		sequence,
	};

	const canonical = canonicalize(event);
	let snapshot: Record<string, unknown>;
	try {
		snapshot = JSON.parse(canonical) as Record<string, unknown>;
	} catch {
		throw new Error("appendEvent: canonical bytes are not JSON");
	}
	// Refuse drift: the hashed bytes must be what we would persist
	// for the event (minus hash). A Date#toISOString that returns an
	// object is valid JSON in insertion order; re-canonicalizing
	// sorts it. Hash the first snapshot only if it is idempotent.
	const normalized = canonicalize(snapshot);
	if (normalized !== canonical) {
		throw new Error("appendEvent: canonical snapshot is not idempotent");
	}
	const hash = createHash("sha256").update(canonical).digest("hex");
	const line = canonicalize({ ...snapshot, hash });
	const fullEvent = snapshot as unknown as AuditEvent & { sequence: number };
	fullEvent.hash = hash;
	return {
		event: fullEvent,
		hash,
		sequence,
		line,
		persistedInput: { kind: fullEvent.kind, actor: fullEvent.actor, data: fullEvent.data },
	};
}

// ── DLQ Writer ──

function writeDeadLetter(
	dlqDir: string,
	entry: {
		source: string;
		transferId?: string;
		payload: unknown;
		error: string;
		timestamp: string;
		/**
		 * The event's hash when its bytes DID reach the chain before the failure (the `.meta` sidecar
		 * failed after the fsync): this dead letter then duplicates an event on the chain, and a
		 * reader can tell it from a lost one (`readChainDeadLetters`). Absent: the event is not known
		 * to be on the chain.
		 */
		eventHash?: string;
		checksum?: string;
		checksumAlg?: string;
	},
): void {
	try {
		if (!existsSync(dlqDir)) {
			mkdirSync(dlqDir, { recursive: true, mode: 0o700 });
		}

		// F3: best-effort corruption-detection checksum — NOT
		// tamper-evidence. Any key readable by this writer is readable by an
		// attacker with the same host access, so a keyed MAC here would only
		// imply integrity it cannot provide (the old HMAC key was derived from
		// the vault path — forgeable from public inputs). Tamper-evidence for
		// audit data lives in the hash chain + external anchoring.
		let canonicalEntry: string | undefined;
		try {
			canonicalEntry = canonicalize(entry);
		} catch {
			// canonicalize throws on NaN/Infinity — but a payload carrying NaN
			// is exactly the kind of failure a dead letter must still record.
			// JSON.stringify coerces them to null (the pre-checksum behavior);
			// the entry must be persisted, never dropped.
			canonicalEntry = undefined;
		}
		const checksum = createHash("sha256")
			.update(canonicalEntry ?? JSON.stringify(entry))
			.digest("hex");
		// The line is the bytes the checksum covers, so a reader recomputes it from what it reads:
		// the canonical record (parsed back once, so a getter or a `toJSON` never runs twice), or,
		// where canonicalize refused it, the JSON.stringify form it was summed over. (Persisting
		// JSON.stringify of a canonically summed record broke the sum for a value whose two forms
		// differ, such as a Buffer.)
		const line =
			canonicalEntry !== undefined
				? canonicalize({
						...(JSON.parse(canonicalEntry) as Record<string, unknown>),
						checksum,
						checksumAlg: "sha256",
					})
				: JSON.stringify({ ...entry, checksum, checksumAlg: "sha256" });

		// Opened as the log is, never blind: through no symlink (a dead letter is never written to a file
		// outside the vault), never blocking on a FIFO in its place (the writer's mutex is held), and
		// only into a regular file.
		const dlqPath = join(dlqDir, "dead-letters.jsonl");
		const fd = openSync(
			dlqPath,
			fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | O_NOFOLLOW | O_NONBLOCK,
			0o600,
		);
		try {
			if (!fstatSync(fd).isFile()) {
				throw new Error(`the dead-letter queue ${dlqPath} is not a regular file`);
			}
			// Every byte, as for the log (#194): this line is now the only record of an event the
			// chain lacks, and `usertrust verify` counts the vault's missing events from it.
			writeFully(fd, `${line}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// DLQ write failure — last resort, cannot do anything else
		console.error("[AUDIT] Dead-letter write failed", entry);
	}
}

// ── Factory ──

/**
 * Create an audit writer instance for the given vault path.
 *
 * The writer appends events to `<vaultPath>/.usertrust/audit/events.jsonl`.
 * Each event's SHA-256 hash covers the previous event's hash, creating a
 * tamper-evident chain. The first event chains from GENESIS_HASH.
 */
export function createAuditWriter(
	vaultPath: string,
	options: CreateAuditWriterOptions = {},
): AuditWriter {
	const auditDir = join(vaultPath, VAULT_DIR, "audit");
	if (!existsSync(auditDir)) {
		mkdirPrivate(auditDir);
	}
	return createAuditWriterAt({ auditDir, dlqDir: join(vaultPath, VAULT_DIR, "dlq") }, options);
}

/**
 * {@link createAuditWriter} for a holder that also mutates the vault OUTSIDE `appendEvent` while it
 * holds the lock (the torn-tail quarantine cuts the log): its lock declares no lease, so it is never
 * reclaimed from another namespace while it might still cut. Internal: not exported from the package.
 */
export function createUnleasedAuditWriter(
	vaultPath: string,
	options: CreateAuditWriterOptions = {},
): AuditWriter {
	const auditDir = join(vaultPath, VAULT_DIR, "audit");
	if (!existsSync(auditDir)) {
		mkdirPrivate(auditDir);
	}
	return createAuditWriterAt(
		{ auditDir, dlqDir: join(vaultPath, VAULT_DIR, "dlq") },
		options,
		false,
	);
}

/** Where a writer writes: its audit directory (the log, `.meta`, the lock) and its dead-letter directory. */
interface AuditWriterPaths {
	auditDir: string;
	dlqDir: string;
}

/** The writer itself, bound to `paths` exactly as given (the shared writer gives canonical ones). */
function createAuditWriterAt(
	{ auditDir, dlqDir }: AuditWriterPaths,
	options: CreateAuditWriterOptions = {},
	leasable = true,
): AuditWriter {
	const logPath = join(auditDir, "events.jsonl");
	const metaPath = `${logPath}.meta`;

	const writerId = randomUUID();
	const mutex = new AsyncMutex();
	// Whether the audit directory's entries an append chains from (the log's own, the anchor's last
	// rename) are known durable. False until this writer has synced the directory under its lock, and
	// again after a failed append (a rename whose directory sync failed) or a lock it had to take anew
	// (another writer appended, and may have failed, meanwhile): the directory is then synced before
	// anything chains from what is there.
	let baselineDurable = false;
	let degraded = false;
	let writeFailures = 0;
	// Eager: a second writer fails HERE. The append's own acquire then only verifies this
	// writer's lock (the file carries this writer's id and inode) and creates nothing.
	if (options.lockAtCreate === true) acquireProcessLock(logPath, writerId, leasable);

	/** Take the lock, or verify this writer holds it. One this call had to create is a new baseline. */
	function holdLock(): void {
		if (acquireProcessLock(logPath, writerId, leasable)) baselineDurable = false;
	}

	/**
	 * Decide an append, under the mutex and the lock, from ONE classification of the tail, read through
	 * the descriptor the append then writes: refuse (nothing written, nothing created), roll the anchor
	 * forward (a write interrupted between its log append and its anchor update: the log is synced
	 * before the anchor records it), or go on. Nothing is cached between appends: every input is
	 * acquired again, so a log truncated, replaced by a rename or given a new segment, an anchor
	 * restored alone, or a recovery begun since the last append is seen by the next one. Returns the
	 * open log (the caller owns it), or no descriptor for a FRESH vault without one: the log is never
	 * created here, only by the append, with its event in hand.
	 */
	function prepareAppend(): {
		fd: number | undefined;
		previousHash: string;
		sequence: number;
		lastLineBytes: number;
	} {
		const opened = openLogByPath(logPath);
		try {
			const { tail, lastLineBytes } = classifyForAppend(auditDir, logPath, opened);
			const action = writerAction(tail);
			if (action === "refuse") throw refusalOf(logPath, tail);
			if (!baselineDurable) {
				syncDirectoryForChain(auditDir);
				syncDirectoryBestEffort(dirname(auditDir));
				baselineDurable = true;
			}
			if (action === "roll_forward") {
				if (opened.fd === undefined || tail.found === null) {
					throw new Error("audit writer: a roll-forward needs the open log and its last event");
				}
				fsyncSync(opened.fd);
				writeAnchorAtomically(
					metaPath,
					JSON.stringify({ lastHash: tail.found.hash, sequence: tail.found.sequence }),
				);
			}
			const head = tail.found ?? { hash: GENESIS_HASH, sequence: 0 };
			return {
				fd: opened.fd,
				previousHash: head.hash,
				sequence: head.sequence + 1,
				lastLineBytes,
			};
		} catch (err) {
			if (opened.fd !== undefined) closeSync(opened.fd);
			throw err;
		}
	}

	async function appendEvent(input: AppendEventInput): Promise<AuditEvent> {
		const release = await mutex.acquire();
		// Set ONLY once the log bytes are fsync'd. Everything after that point can
		// still throw (the sidecar above all), and the event is on the chain
		// regardless — see DURABLE_EVENT_HASH.
		let durableHash: string | undefined;
		// Set as soon as the event's bytes are fsync'd into the log, before anything that can still fail
		// (the directory sync of a log this append created, the close): its dead letter then names the
		// hash, and a reader counts it on the chain exactly when the event at that hash is there. Not a
		// durability claim: a crash that loses a new log's directory entry loses the event, and the reader
		// then finds no event at the hash.
		let writtenHash: string | undefined;
		// The event as it is persisted (its kind, actor and data parsed back from the hashed bytes),
		// once it is built. A dead letter records THIS, never `input` serialised a second time: an input
		// that serialises differently twice (a getter, a stateful toJSON) would no longer match its own
		// event on the chain, and verify would report a durable event missing for good.
		let persistedInput: AppendEventInput | undefined;
		try {
			holdLock();
			let fd: number | undefined;
			let built: BuiltEvent;
			// Whether this append created the log: its directory entry is then synced before the event
			// is claimed durable (the anchor's rename would otherwise be the first to sync it).
			let created = false;
			try {
				for (let attempt = 1; ; attempt++) {
					const head = prepareAppend();
					fd = head.fd;
					built = buildEvent(input, head.previousHash, head.sequence);
					persistedInput = built.persistedInput;
					// Refused before anything is written or created: a line over the bound would make a
					// tail this writer then refuses to read (TAIL_OVERSIZE), for good.
					const lineBytes = Buffer.byteLength(built.line, "utf-8");
					if (lineBytes > MAX_EVENT_LINE_BYTES) {
						throw new Error(
							`audit event refused: its line is ${lineBytes} bytes, over the ${MAX_EVENT_LINE_BYTES}-byte bound for one event (this event was not written)`,
						);
					}
					// Nor a tail the NEXT append could not read: this line, the last one before it and the
					// newline before that, within the bound the tail is read within. Only a last line an
					// older writer left over the bound for one event can break that (a legacy vault): the
					// event is refused, and an ordinary one after it still goes on.
					const tailBytes = head.lastLineBytes + lineBytes + 3;
					if (tailBytes > MAX_TAIL_BYTES) {
						throw new Error(
							`audit event refused: with it, the log's last two lines would take ${tailBytes} bytes, over the ${MAX_TAIL_BYTES}-byte bound they are read within (this event was not written)`,
						);
					}
					if (fd !== undefined) break;
					// A FRESH vault with no log: created only now, with the event in hand, exclusively and
					// owner-only. One made since it was classified (by something other than a writer: the
					// lock excludes those) is classified again.
					try {
						fd = openSync(
							logPath,
							fsConstants.O_RDWR |
								fsConstants.O_APPEND |
								fsConstants.O_CREAT |
								fsConstants.O_EXCL |
								O_NOFOLLOW |
								O_NONBLOCK,
							PRIVATE_FILE_MODE,
						);
						created = true;
						break;
					} catch (err) {
						if (errorCode(err) !== "EEXIST" || attempt >= 3) throw err;
					}
				}
				// Through the descriptor the tail was classified through: the bytes judged are the bytes
				// appended to.
				writeFully(fd, `${built.line}\n`);
				fsyncSync(fd);
				writtenHash = built.hash;
				// A log made by this append exists only once the directory holding its entry is synced.
				if (created) syncDirectoryForChain(auditDir);
			} finally {
				if (fd !== undefined) closeSync(fd);
			}
			const { event: fullEvent, hash, sequence } = built;
			// The bytes are fsync'd: this event is on the chain even if the sidecar
			// write below throws. Deliberately set AFTER `closeSync` has run, so a
			// close that itself fails leaves this unset — under-claiming durability
			// is the safe direction here.
			durableHash = hash;

			// The anchor: what the next append checks the log's tail against.
			writeAnchorAtomically(metaPath, JSON.stringify({ lastHash: hash, sequence }));
			baselineDurable = true;

			return fullEvent;
		} catch (err) {
			degraded = true;
			writeFailures++;
			// Whatever failed, the directory's entries are not known durable now (a rename whose
			// directory sync failed): the next append syncs the directory again before it chains.
			baselineDurable = false;
			if (durableHash !== undefined && err !== null && typeof err === "object") {
				Object.defineProperty(err, DURABLE_EVENT_HASH, {
					value: durableHash,
					enumerable: false,
					writable: false,
					configurable: true,
				});
			}
			console.warn("[AUDIT] Audit trail degraded — write failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			writeDeadLetter(dlqDir, {
				source: "audit.chain.appendEvent",
				payload: persistedInput ?? input,
				error: err instanceof Error ? err.message : String(err),
				timestamp: new Date().toISOString(),
				...(writtenHash !== undefined ? { eventHash: writtenHash } : {}),
			});
			throw err;
		} finally {
			release();
		}
	}

	/**
	 * The append's own decision, without the append: the tail classified as the next append would
	 * classify it, under the same mutex and lock, and what the append would throw for a refused state
	 * thrown here. Nothing is written to the chain or its anchor, and nothing is rolled forward (a tail
	 * ONE past its anchor passes: the append rolls it forward) or counts as a failed write. The lock is
	 * taken as an append takes it: its file is created, and the directory synced, when it is not held.
	 */
	async function preflight(): Promise<void> {
		const release = await mutex.acquire();
		try {
			holdLock();
			const opened = openLogByPath(logPath);
			try {
				const { tail } = classifyForAppend(auditDir, logPath, opened);
				if (writerAction(tail) === "refuse") throw refusalOf(logPath, tail);
			} finally {
				if (opened.fd !== undefined) closeSync(opened.fd);
			}
		} finally {
			release();
		}
	}

	function getWriteFailures(): number {
		return writeFailures;
	}

	function isDegradedFn(): boolean {
		return degraded;
	}

	async function flush(): Promise<void> {
		const release = await mutex.acquire();
		release();
	}

	function releaseWriter(): void {
		baselineDurable = false;
		degraded = false;
		writeFailures = 0;
		// Last: it throws (AuditLockReleaseError) if a lock was left in place — after every lock was tried.
		releaseLocks(writerId, logPath);
	}

	return {
		appendEvent,
		preflight,
		getWriteFailures,
		isDegraded: isDegradedFn,
		flush,
		release: releaseWriter,
		lockOwner: () => currentAcquisition(logPath, writerId),
	};
}

// ── One writer per vault per process ──

/**
 * The `process.emitWarning` code under which a governor reports that its audit writes are failing:
 * once when the first of them fails, and once more, with the count, when it is destroyed. A failed
 * write never stops a call unless `audit.failClosed` is set, so this, the receipt's `auditDegraded`
 * and the dead letter are how anyone learns of it; `process.on("warning")` can watch for it.
 */
export const AUDIT_DEGRADED_WARNING = "USERTRUST_AUDIT_DEGRADED";

/** The process's one writer for a vault, and how many governors' handles on it are open. */
interface SharedVaultWriter {
	writer: AuditWriter;
	handles: number;
}

/**
 * Vault → its shared writer, keyed by the vault's identity on disk ({@link resolveSharedVault}), so
 * every spelling of one vault (a symlink, a relative path, another case) shares one writer. An entry
 * lives while a handle is open on it; the last handle's release releases the writer, and the lock.
 *
 * Module scope is process scope here: Node keeps ONE instance of an ES module per resolved file,
 * and `require()` of this ES module returns that same instance, so every `trust()` and
 * `createGovernor()` of one installed copy of usertrust meets this one map. (Two installed copies,
 * or worker threads, each have their own — LIMITATIONS.md.)
 */
const sharedWriters = new Map<string, SharedVaultWriter>();

/**
 * A governor's handle on the process's ONE audit writer for `vaultPath`. Every `trust()` client and
 * `createGovernor()` in a process that names the same vault appends through the same writer: one
 * mutex and one lock (the tail itself is read and classified anew on every append). Before this,
 * each made its own writer, the first to append took
 * the vault's lock, and every append by the others failed on it (`AuditWriterLockHeldError`, a live
 * writer in this process): their calls settled with their audit events in the dead-letter queue, off
 * the chain — the README's own pattern of an Anthropic and an OpenAI client dead-lettered half its
 * audit trail, and nothing that reads the chain could see it.
 *
 * The vault is resolved when the handle is opened, once ({@link resolveSharedVault}): a later
 * `chdir` does not move a handle opened with a relative path to another vault. The handle joins the
 * shared writer at its first append, exactly when a writer of its own would have taken the lock, so
 * a governor that never appends holds nothing. `release()` leaves it, and
 * the LAST handle to leave releases the writer and its lock. Every append also holds the writer for
 * itself until it finishes, so a release that lands while an append is still queued (a call that
 * outlived its governor's `destroy()` drain) leaves the writer to that append, which releases it.
 * An append after the release joins for that append only, so a destroyed governor never keeps the
 * writer, or the lock, from being released with the others. What a governor reads back is its own:
 * `isDegraded()` and `getWriteFailures()` count only this handle's failed appends, so one client's
 * failure does not trip another's `audit.failClosed`.
 *
 * A failed append is reported, never only flagged: its error still propagates (the call site marks
 * the receipt `auditDegraded`), the writer still dead-letters the event and warns on the console,
 * and the handle emits {@link AUDIT_DEGRADED_WARNING} at its first failure and, with the count, at
 * its release.
 */
export function openSharedAuditWriter(
	vaultPath: string,
	options: SharedAuditWriterOptions = {},
): AuditWriter {
	const vault = resolveSharedVault(vaultPath);
	let joined: SharedLease | undefined;
	let released = false;
	// What the governor reads (`isDegraded()`, `getWriteFailures()`): every failed append of this
	// handle, for its whole life. A report never resets them: a call still running past the release
	// reads them (`audit.failClosed` refuses a call on a degraded handle), and an append's own report
	// runs before its rejection reaches its caller.
	let degraded = false;
	let writeFailures = 0;
	// How many of those failures a warning has reported: the warnings come in batches.
	let reportedFailures = 0;
	// Appends started and not yet finished. A release that lands while some are still queued (a
	// destroy() whose drain timed out) counts THEIR failures too: its count is reported when the last
	// of them finishes, not before they could fail.
	let inflight = 0;
	let releaseCountPending = false;

	function failed(err: unknown): void {
		degraded = true;
		writeFailures++;
		// The batch's first failure.
		if (writeFailures - reportedFailures === 1) {
			warnAuditDegraded(vault, `failing: ${describeAppendFailure(err)}`);
		}
	}

	/** Report the failures not yet reported, with when they happened; the batch starts over. */
	function reportCount(when: "open" | "late"): void {
		const failures = writeFailures - reportedFailures;
		reportedFailures = writeFailures;
		if (failures === 0) return;
		const writes = `${failures} audit write${failures === 1 ? "" : "s"}`;
		warnAuditDegraded(
			vault,
			when === "open"
				? `${writes} failed while this governor was open`
				: `${writes} failed after this governor was destroyed`,
		);
	}

	async function appendEvent(input: AppendEventInput): Promise<AuditEvent> {
		// Two holds. The handle's own, from its first append until its release, keeps the writer (and
		// its lock) between appends, as a writer of its own would. And this APPEND's own, from here
		// until it finishes: a release that lands while the append is still queued on the writer —
		// destroy()'s drain timed out on a slow call — must not release the writer under it, or the
		// append re-takes the lock on a writer no handle will ever release again. After the release,
		// a late append takes only its own hold, so a destroyed governor never keeps the writer.
		if (!released) joined ??= joinSharedWriter(vault);
		const lease = joinSharedWriter(vault);
		inflight++;
		try {
			const event = await lease.shared.writer.appendEvent(input);
			try {
				options.onAppended?.();
			} catch {
				// the listener's failure is its own (the budget record is advisory); the event is on the chain
			}
			return event;
		} catch (err) {
			failed(err);
			throw err;
		} finally {
			leaveSharedWriterReporting(lease);
			inflight--;
			// After the release, the count is reported once every append in flight has finished: the
			// release's own (appends it found queued), or a late batch's (appends started after it).
			if (released && inflight === 0) {
				reportCount(releaseCountPending ? "open" : "late");
				releaseCountPending = false;
			}
		}
	}

	/**
	 * The shared writer's pre-flight, through a lease taken exactly as an append takes one (a second way
	 * in: the handle joins here too, and holds the writer for itself until the check finishes). A
	 * refusal is the call's, not a failed write: nothing is counted, warned or dead-lettered.
	 */
	async function preflight(): Promise<void> {
		if (!released) joined ??= joinSharedWriter(vault);
		const lease = joinSharedWriter(vault);
		try {
			await lease.shared.writer.preflight?.();
		} finally {
			leaveSharedWriterReporting(lease);
		}
	}

	async function flush(): Promise<void> {
		if (joined !== undefined) await joined.shared.writer.flush();
	}

	function release(): void {
		if (!released) {
			released = true;
			if (inflight === 0) reportCount("open");
			else releaseCountPending = true;
		}
		const was = joined;
		joined = undefined;
		// Last: it throws (AuditLockReleaseError) if this was the last handle and a lock was left.
		if (was !== undefined) leaveSharedWriter(was);
	}

	return {
		appendEvent,
		preflight,
		getWriteFailures: () => writeFailures,
		isDegraded: () => degraded,
		flush,
		release,
		// The vault's shared writer, whichever handle joined it: every handle on one vault reads the same owner.
		lockOwner: () => sharedWriters.get(vault.key)?.writer.lockOwner?.(),
	};
}

/** One handle's hold on a vault's shared writer: its map key and the entry it counted itself in. */
interface SharedLease {
	key: string;
	shared: SharedVaultWriter;
}

/** A vault as a shared writer knows it: canonical, absolute paths, and its identity on disk. */
interface SharedVault {
	/** The map key: the inode identity of the vault directory and of its audit directory. */
	key: string;
	/** The `.usertrust` directory. */
	vaultDir: string;
	auditDir: string;
	dlqDir: string;
}

/**
 * Resolve a handle's vault ONCE, when it is opened, with `realpathSync.native`: the on-disk names,
 * symlinks followed and in the directory's own case (the JS `realpathSync` keeps the caller's case,
 * so `/x/Vault` and `/x/vault` on a case-insensitive filesystem were two writers, and the second
 * one's events were dead-lettered). A writer is built from these canonical, absolute paths, its log,
 * `.meta`, lock and dead letters alike, so no later `chdir` or alias redirects it (a writer built
 * from a client's `vaultBase: "."` went on writing to whatever `.` meant next, for every client
 * sharing it). The vault directory itself is never made here: `securePrivateVault` creates it,
 * exclusively and owner-only, before a governor opens its writer. Only the audit directory inside
 * it is, owner-only and that one directory alone; a vault that does not exist fails here, at open.
 *
 * The map key is the `dev:ino` of the audit directory, read through that resolution, and of the
 * vault directory. The inode is the identity the lock registry already trusts (it keys each held
 * lock by its file's `dev:ino`), and it makes every spelling of one directory one writer by
 * construction. The vault directory's is in the key too, so a writer's dead letters always go to its
 * own vault's queue: two vaults whose `audit` directories are one (a symlink) get two writers, and
 * the second one's appends are refused by the lock, loudly, and dead-lettered where its `verify`
 * reads them.
 *
 * Existing vaults need no migration: their files are the same files, reached by their canonical
 * spelling. Out of scope, as in the lock's threat model: a directory replaced while a handle on it
 * is open (the writer keeps writing at the canonical path, to whatever is there), and filesystems
 * whose `dev:ino` is not stable (some network and FUSE mounts), where two handles may get two
 * writers and the second one's appends are refused by the lock — loudly, and dead-lettered.
 */
function resolveSharedVault(vaultPath: string): SharedVault {
	const auditPath = join(vaultPath, VAULT_DIR, "audit");
	if (!existsSync(auditPath)) {
		try {
			mkdirSync(auditPath, { mode: PRIVATE_DIR_MODE });
		} catch (err) {
			// Another handle made it first: that is the directory wanted, and it is checked below.
			if ((err as { code?: unknown }).code !== "EEXIST") throw err;
		}
	}
	const vaultDir = canonicalPath(join(vaultPath, VAULT_DIR));
	const auditDir = canonicalPath(join(vaultDir, "audit"));
	const vaultId = statSync(vaultDir, { bigint: true });
	const auditId = statSync(auditDir, { bigint: true });
	return {
		key: `${vaultId.dev}:${vaultId.ino}/${auditId.dev}:${auditId.ino}`,
		vaultDir,
		auditDir,
		dlqDir: join(vaultDir, "dlq"),
	};
}

/**
 * A directory's real path, in its on-disk case where the platform can say: `realpathSync.native`
 * (realpath(3)), else the JS `realpathSync`. On musl without `/proc`, realpath(3) fails even for an
 * existing directory; the JS resolver then gives the path with symlinks followed and the caller's
 * case. The writer map does not depend on which: its key is the directories' `dev:ino`, so every
 * spelling is still one writer. The audit lock resolves its directory here too, so the lock is
 * always beside the log the OS writes, whoever opens the writer.
 */
function canonicalPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		// The JS resolver folds a `..` inside a symlink's target lexically, so on some layouts it
		// names another directory than the one the OS opens. Its answer is used only when it IS that
		// directory (the same `dev:ino` as the path itself, which the OS resolves); otherwise refused.
		const resolved = realpathSync(path);
		const opened = statSync(path, { bigint: true });
		const named = statSync(resolved, { bigint: true });
		if (opened.dev !== named.dev || opened.ino !== named.ino) {
			throw new Error(
				`usertrust: cannot resolve the vault path ${path}: realpath(3) is unavailable, and the portable resolver names another directory (${resolved}) than the one this path opens`,
			);
		}
		return resolved;
	}
}

/** Count one more handle on the vault's shared writer, making the writer if there is none. */
function joinSharedWriter(vault: SharedVault): SharedLease {
	let shared = sharedWriters.get(vault.key);
	if (shared === undefined) {
		shared = {
			writer: createAuditWriterAt({ auditDir: vault.auditDir, dlqDir: vault.dlqDir }),
			handles: 0,
		};
		sharedWriters.set(vault.key, shared);
	}
	shared.handles++;
	return { key: vault.key, shared };
}

/**
 * Count one handle out. The last one out releases the writer and its lock: out of the map FIRST, so
 * a release that throws (a lock left behind) cannot leave a dead writer for the next handle to join.
 */
function leaveSharedWriter(lease: SharedLease): void {
	lease.shared.handles--;
	if (lease.shared.handles > 0) return;
	if (sharedWriters.get(lease.key) === lease.shared) sharedWriters.delete(lease.key);
	lease.shared.writer.release();
}

/** {@link leaveSharedWriter} after a late append: a lock left behind is reported, never thrown over the append's own outcome. */
function leaveSharedWriterReporting(lease: SharedLease): void {
	try {
		leaveSharedWriter(lease);
	} catch (err) {
		const message = describeReleaseFailure(err);
		console.warn(`[AUDIT] ${message}`);
		process.emitWarning(message, { code: AUDIT_LOCK_LEFT_WARNING });
	}
}

/** An append's failure, for a warning: its kind and code, and its message scrubbed for the terminal. */
function describeAppendFailure(err: unknown): string {
	if (!(err instanceof Error)) return typeof err;
	const code = errorCode(err);
	const message = err.message.length > 300 ? `${err.message.slice(0, 300)}…` : err.message;
	return `${err.name}${code === undefined ? "" : ` (${code})`}: ${message}`;
}

function warnAuditDegraded(vault: SharedVault, what: string): void {
	const message = scrubForWarning(
		`usertrust audit writes to ${vault.auditDir} are degraded — ${what}. Each event that did not reach the chain is in ${join(vault.dlqDir, "dead-letters.jsonl")}, its call's receipt carries auditDegraded, and \`usertrust verify\` reports the vault incomplete.`,
	);
	process.emitWarning(message, { code: AUDIT_DEGRADED_WARNING });
}
