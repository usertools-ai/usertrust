// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { type BigIntStats, existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { join } from "node:path";
import { anchorStamp, fileIdentity, type LogTimes } from "./state.js";

export interface TailEvents {
	/** Byte range grew: caller reads/verifies the appended lines itself. */
	onGrow(): void;
	/** File shrank or was replaced: caller must fully reload + notify clients. */
	onResync(): void;
	/**
	 * The periodic full re-verify (`REVERIFY_MS`): the caller reloads in full, unless a load is already running. Only a
	 * watcher given it runs the interval.
	 */
	onReverify?(): void;
}

const DEBOUNCE_MS = 250;
/** How often the log's path is polled while its audit directory does not exist yet. */
const MISSING_DIR_POLL_MS = 1000;
/** How often the log is checked in fs.watch mode whether or not an event arrived: the bound on a late or lost event. */
const BACKSTOP_MS = 1000;
/**
 * How often the whole vault is re-verified whatever the checks saw. An append is verified incrementally, and a check
 * compares sizes, identities and timestamps, so a rewrite in place that none of them sees (a same-length edit of an
 * earlier event beside an append, inside one check) is only seen by a full read: this bounds how long it can go unseen.
 */
const REVERIFY_MS = 5 * 60 * 1000;
/**
 * The least time between two full loads asked for by a timestamp change at an unchanged size. ctime moves on a mode
 * change, an extended-attribute write by a sync or backup agent and a hard link, none of which changes the log, and a
 * full load of 50 000 events takes about half a second: a churn of such changes must not keep the dashboard reloading.
 */
const SAME_SIZE_RELOAD_MS = 30 * 1000;
/**
 * The least time between two full loads retried, on an unchanged vault, after a full load failed: a full load of 50 000
 * events takes about half a second and is broadcast to every client, so a read that keeps failing costs one load per
 * window, and a vault that becomes readable again (an anchor's permission restored) reads correctly within about one.
 */
const FAILED_READ_RETRY_MS = 10 * 1000;

/**
 * For tests only, never exported from the package: the backstop's interval, the re-verify interval, the least time
 * between two same-size reloads, the least time between two retries of a failed read, the clock that time is measured on, the fs.watch function, and the stat of the log that
 * the memo key and every check are built from, read once when `watchLedger` starts. Tests shorten the intervals, replace
 * the watcher with one that never calls back or that emits `error`, and hand the checks chosen stats. The defaults are
 * the production behaviour.
 */
export const __tailTestSeam: {
	backstopMs: number;
	reverifyMs: number;
	sameSizeReloadMs: number;
	failedReadRetryMs: number;
	now: () => number;
	watch: typeof watch;
	statLog: (path: string) => BigIntStats;
} = {
	backstopMs: BACKSTOP_MS,
	reverifyMs: REVERIFY_MS,
	sameSizeReloadMs: SAME_SIZE_RELOAD_MS,
	failedReadRetryMs: FAILED_READ_RETRY_MS,
	now: () => performance.now(),
	watch,
	statLog: (path) => statSync(path, { bigint: true }),
};

/**
 * Watches the vault's log and calls back on a change. `sizeOf` is the log size the caller holds; `identityOf` the log's
 * identity its last load recorded (`fileIdentity`); `auditDirIdOf` the audit directory's identity when the caller first
 * saw it; `timesOf` the log's mtime and ctime as its last load or grow saw them; `reloadPending` whether the caller's
 * last full load failed (see `failedReadRetry`). Each check compares the directory's identity (absent where one was seen,
 * or another directory at the path, is a resync), then the log's size (a shrink resyncs, a grow is incremental), then at
 * the same size: its identity (another file resyncs), whether the last full load failed (a failed read is retried), and
 * its timestamps (a rewrite in place at the same length; guarded, see `rewrittenAtSameSize`). While the known size is
 * 0, or the last full load saw no anchor, `anchorOf` (the `.meta` anchor's `anchorStamp` at the last full load) is
 * compared too, after the size and identity checks: an anchor written or changed beside no log is a resync, and so is
 * the anchor a first append writes after a load that caught its log line but not yet its anchor (the writer fsyncs the
 * log before it renames the anchor into place). Once the log holds bytes AND a load has seen an anchor, the anchor is
 * not watched: the writer rewrites it after every append, and each append would be a full reload. A vault whose anchor
 * never appears costs one stat of it per check, and no reload while it stays absent.
 * With `events.onReverify`, the whole vault is also re-verified every `REVERIFY_MS`, whatever the checks saw.
 */
export function watchLedger(
	vaultPath: string,
	sizeOf: () => number,
	events: TailEvents,
	identityOf?: () => string | undefined,
	auditDirIdOf?: () => string | undefined,
	timesOf?: () => LogTimes | undefined,
	reloadPending?: () => boolean,
	anchorOf?: () => string | undefined,
): () => void {
	const auditDir = join(vaultPath, "audit");
	const logPath = join(auditDir, "events.jsonl");
	const metaPath = `${logPath}.meta`;
	let timer: NodeJS.Timeout | undefined;
	let watcher: FSWatcher | undefined;
	let poller: NodeJS.Timeout | undefined;
	let backstop: NodeJS.Timeout | undefined;
	let reverify: NodeJS.Timeout | undefined;
	const {
		backstopMs,
		reverifyMs,
		sameSizeReloadMs,
		failedReadRetryMs,
		now: clock,
		watch: watchDir,
		statLog,
	} = __tailTestSeam;

	/**
	 * The log's stat (none where it failed), and a key of every field of it a check compares, or of its error, of the
	 * audit directory's state, and, while the anchor is watched, of the anchor's (`anchorWatched`): two equal keys are a
	 * vault no check could tell apart. The log's fields come from ONE
	 * BigInt stat: a JS number cannot hold a 64-bit file id (Windows' exceed 2^53), and two ids that round to one value
	 * would let a key hide a replacement.
	 */
	const readLog = (): { st: BigIntStats | undefined; key: string } => {
		let st: BigIntStats | undefined;
		let key: string;
		try {
			st = statLog(logPath);
			key = `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.dev}:${st.ino}:${st.birthtimeNs}`;
		} catch (err) {
			key = `error:${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
		}
		return { st, key: `${key}|${auditDirNow()}|${anchorWatched() ? anchorStamp(metaPath) : "-"}` };
	};

	/**
	 * Whether the anchor is compared: only where the caller records one, and only while the known log size is 0 or the
	 * last full load saw no anchor ("absent"). The second keeps a first append's anchor watched when a load landed
	 * between its log write and its anchor rename; the load that sees the anchor records its stamp, and watching stops.
	 */
	const anchorWatched = (): boolean =>
		anchorOf !== undefined && (sizeOf() === 0 || anchorOf() === "absent");

	/**
	 * An anchor that appeared, went, or changed (another inode, a new ctime) since the last full load, while it is watched
	 * (`anchorWatched`). A load records the stamp it saw, so the same change is reported once. Unknown recorded proves nothing.
	 */
	const anchorMoved = (): boolean => {
		const known = anchorOf?.();
		return known !== undefined && anchorWatched() && anchorStamp(metaPath) !== known;
	};

	/** The audit directory as a stat sees it: its identity, "absent", or "unknown" (another error, or inode 0). */
	const auditDirNow = (): string => {
		try {
			return fileIdentity(statSync(auditDir, { bigint: true })) ?? "unknown";
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
		}
	};

	// The directory state a resync was last asked for: the same mismatch is reported once, not on every check.
	let dirReported: string | undefined;
	/**
	 * Whether the audit directory is absent where the caller saw one, or is another directory (a different identity),
	 * and this was not already reported. Unknown on either side (none recorded, inode 0, a stat that fails otherwise)
	 * asks for nothing: the log's own checks still run.
	 */
	const auditDirMoved = (): boolean => {
		const known = auditDirIdOf?.();
		if (known === undefined) return false;
		const now = auditDirNow();
		if (now === known || now === "unknown") {
			dirReported = undefined;
			return false;
		}
		if (now === dirReported) return false;
		dirReported = now;
		return true;
	};

	/**
	 * Whether the log's timestamps differed from the recorded ones, at the same size, on the previous check too (and so
	 * a same-size reload is waiting: for its second check, or for the limit below).
	 */
	let timesMoved = false;
	/** When the last same-size reload was asked for, on a monotonic clock (the seam's `now`); none yet. */
	let lastSameSizeReload = Number.NEGATIVE_INFINITY;

	/**
	 * The vault's key (`readLog`) at the last check that went on: the state the last full load it could have asked for
	 * read, or a later one. Taken first when the watcher starts, just after the caller's first load.
	 */
	let lastKey: string | undefined;
	/** When the failed read was last retried (or first seen failed), on the seam's clock; none outside a failed spell. */
	let lastFailedRetry: number | undefined;
	/** Whether a retry of the failed read is due by time alone: none seen yet, or a window since the last one. */
	const failedRetryDue = (): boolean =>
		lastFailedRetry === undefined || clock() - lastFailedRetry >= failedReadRetryMs;

	/**
	 * Whether this check may go on. While the caller's last full load failed (`reloadPending`): a read that failed is
	 * not a verdict, and its recovery may change nothing a check sees (an anchor's permission restored), so it is
	 * retried in full: at once when the vault changed in any way its key shows since the last check (a grow, a shrink,
	 * another file, new timestamps, the directory gone or replaced, a stat error that began or ended), else at most once
	 * per `FAILED_READ_RETRY_MS`, counted from when the failure was first seen. A retry on every check re-read a vault
	 * whose read kept failing in full once a second, with a resync to every client each time.
	 */
	const failedReadRetry = (key: string): boolean => {
		const changed = key !== lastKey;
		lastKey = key;
		if (reloadPending?.() !== true) {
			lastFailedRetry = undefined;
			return true;
		}
		if (lastFailedRetry === undefined) {
			// The load that failed ran just before this check: the window starts now, and only a change goes on.
			lastFailedRetry = clock();
			return changed;
		}
		if (!changed && clock() - lastFailedRetry < failedReadRetryMs) return false;
		lastFailedRetry = clock();
		return true;
	};

	const check = (): void => {
		// Size, identity and timestamps from ONE stat, so a check never pairs one file's size with another's identity.
		const { st, key } = readLog();
		if (!failedReadRetry(key)) return;
		// The directory first: a vault replaced in one step can hold a log of any size, and a directory deleted while it
		// held no log bytes changes no size at all (an absent log reads as 0).
		if (auditDirMoved()) {
			events.onResync();
			return;
		}
		const size = st === undefined ? 0 : Number(st.size);
		const known = sizeOf();
		if (size !== known) timesMoved = false;
		if (size < known) events.onResync();
		else if (size > known) events.onGrow();
		else if (identityOf !== undefined && replacedAtSameSize(st, identityOf())) {
			timesMoved = false;
			events.onResync();
		}
		// An anchor written beside no log, or after a load that saw the log but no anchor yet, changes no size, identity or
		// timestamp of the log. After the size and identity checks: a grow is still a grow.
		else if (anchorMoved()) events.onResync();
		// A read that failed is not a verdict: a check `failedReadRetry` let through reloads in full, whatever changed (a
		// permission restored changes neither the log's size nor its identity).
		else if (reloadPending?.() === true) events.onResync();
		else if (identityOf !== undefined && rewrittenAtSameSize(st)) events.onResync();
	};

	/** Another file at the log's path, where the caller recorded an identity. Unknown on either side proves nothing. */
	const replacedAtSameSize = (st: BigIntStats | undefined, known: string | undefined): boolean => {
		if (known === undefined || st === undefined) return false;
		const id = fileIdentity(st);
		return id !== undefined && id !== known;
	};

	/**
	 * A rewrite in place at the same length: the log's mtime or ctime differ from the ones the caller recorded. On a
	 * file system with no stable inode numbers (inode 0) this is also how a same-size replacement is seen. Two guards,
	 * both binding. The change must hold on TWO consecutive checks: on Linux a write updates ctime before the size, so
	 * one check can land inside an append. And at most one such reload runs per `SAME_SIZE_RELOAD_MS`: ctime also moves
	 * on a mode change, an extended-attribute write or a hard link. A change held back by the limit stays waiting, and
	 * reloads once the limit allows.
	 */
	const rewrittenAtSameSize = (st: BigIntStats | undefined): boolean => {
		const known = timesOf?.();
		const moved =
			known !== undefined &&
			st !== undefined &&
			(st.mtimeNs !== known.mtimeNs || st.ctimeNs !== known.ctimeNs);
		if (!moved) {
			timesMoved = false;
			return false;
		}
		if (!timesMoved) {
			timesMoved = true;
			return false;
		}
		const at = clock();
		if (at - lastSameSizeReload < sameSizeReloadMs) return false;
		lastSameSizeReload = at;
		// A resync records new timestamps; the next difference starts its own count.
		timesMoved = false;
		return true;
	};

	lastKey = readLog().key;
	try {
		watcher = watchDir(auditDir, () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(check, DEBOUNCE_MS);
		});
		// A watcher that reports an error (its directory deleted, on some platforms) is dropped rather than left to
		// throw an unhandled `error` and end the process; the backstop below keeps checking the log on its own.
		watcher.on("error", () => {
			try {
				watcher?.close();
			} catch {
				// already closed: nothing more to release
			}
			watcher = undefined;
		});
		// fs.watch can deliver an event late or not at all: on macOS under heavy filesystem activity an append's event
		// was observed about 45 s late, and the dashboard showed nothing new until a later write. This tick runs the
		// same check() the events run, so an append, a shrink or a removal is seen within about one interval whatever
		// the events do. It checks the log by PATH, so it also sees a directory replaced under the watcher.
		// The memo stops a torn last line (a writer that died mid-line) from being re-read in full every tick: check()
		// runs only when the log's size, timestamps or identity, its stat error, the audit directory's identity (or
		// absence), the anchor's stamp while it is watched (`anchorWatched`), or the known size moved since the last call, while a timestamp change waits for its second check or
		// for the same-size limit, or, while the last full load failed, once a retry of it is due (`failedReadRetry`).
		// Every field check() compares is in the key (`readLog`'s, and the known size), or a skip could hide it.
		let memo: string | undefined;
		backstop = setInterval(() => {
			const seen = `${readLog().key}|${sizeOf()}`;
			const retryDue = reloadPending?.() === true && failedRetryDue();
			if (seen === memo && !timesMoved && !retryDue) return;
			memo = seen;
			check();
		}, backstopMs);
		// Like the polling mode's interval: it never keeps a process alive on its own.
		backstop.unref();
	} catch {
		// No audit directory yet: a project before its first governed call. fs.watch cannot watch a path that does not
		// exist, and returning here left the dashboard on "no governed calls yet" while the first ones were written.
		// The path is polled on our own timer until the log appears and grows. fs.watchFile was tried first and is not
		// enough: it calls back only when ITS poll sees a stat change, and a directory deleted soon after the last append
		// was never seen to change, so the dashboard kept reading a verified chain over a deleted audit directory.
		let logSeen = false;
		let dirSeen = false;
		poller = setInterval(() => {
			const logNow = existsSync(logPath);
			const dirNow = existsSync(auditDir);
			// Present and now absent is a deletion even when the known size is 0 (a log that held no parsable event, or a
			// directory that never held a log): an absent log reads as size 0, which resyncs only when the known size is > 0.
			const lost = (logSeen && !logNow) || (dirSeen && !dirNow);
			// Absent at the previous check and present now. A directory that stays empty, or holds only an anchor, never grows,
			// so without this the server never loaded it and never learned it exists: its later deletion was classified as a
			// first run and read valid and empty. One load per appearance, since `dirSeen` holds until it is gone again.
			const appeared = dirNow && !dirSeen;
			logSeen = logNow;
			dirSeen = dirNow;
			if (lost || appeared) {
				// The reload this asks for reads the directory as it is now; the same state is not reported again by check().
				dirReported = auditDirNow();
				events.onResync();
			} else check();
		}, MISSING_DIR_POLL_MS);
		// The poll must never keep a process alive on its own: the server's close() clears it, and a process that has
		// nothing else to do exits even if a caller forgets to close.
		poller.unref();
	}

	// The periodic full re-verify, in either mode. Like the other intervals it never keeps a process alive on its own.
	if (events.onReverify !== undefined) {
		const onReverify = events.onReverify;
		reverify = setInterval(() => onReverify(), reverifyMs);
		reverify.unref();
	}

	return () => {
		if (timer) clearTimeout(timer);
		if (reverify) clearInterval(reverify);
		watcher?.close();
		if (backstop) clearInterval(backstop);
		if (poller) clearInterval(poller);
	};
}
