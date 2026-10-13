// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { type BigIntStats, existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { join } from "node:path";
import { fileIdentity, type LogTimes } from "./state.js";

export interface TailEvents {
	/** Byte range grew: caller reads/verifies the appended lines itself. */
	onGrow(): void;
	/** File shrank or was replaced: caller must fully reload + notify clients. */
	onResync(): void;
}

const DEBOUNCE_MS = 250;
/** How often the log's path is polled while its audit directory does not exist yet. */
const MISSING_DIR_POLL_MS = 1000;
/** How often the log is checked in fs.watch mode whether or not an event arrived: the bound on a late or lost event. */
const BACKSTOP_MS = 1000;

/**
 * For tests only, never exported from the package: the backstop's interval, the fs.watch function, and the stat its
 * memo key is built from, read once when `watchLedger` starts. Tests shorten the interval, replace the watcher with one
 * that never calls back or that emits `error`, and hand the memo chosen stats. The defaults are the production behaviour.
 */
export const __tailTestSeam: {
	backstopMs: number;
	watch: typeof watch;
	statLog: (path: string) => BigIntStats;
} = {
	backstopMs: BACKSTOP_MS,
	watch,
	statLog: (path) => statSync(path, { bigint: true }),
};

/**
 * Watches the vault's log and calls back on a change. `sizeOf` is the log size the caller holds; `identityOf` the log's
 * identity its last load recorded (`fileIdentity`); `auditDirIdOf` the audit directory's identity when the caller first
 * saw it; `timesOf` the log's mtime and ctime as its last load or grow saw them. Each check compares the directory's
 * identity (absent where one was seen, or another directory at the path, is a resync), then the log's size, then at the
 * same size its identity, or its timestamps when the identity is unknown.
 */
export function watchLedger(
	vaultPath: string,
	sizeOf: () => number,
	events: TailEvents,
	identityOf?: () => string | undefined,
	auditDirIdOf?: () => string | undefined,
	timesOf?: () => LogTimes | undefined,
): () => void {
	const auditDir = join(vaultPath, "audit");
	const logPath = join(auditDir, "events.jsonl");
	let timer: NodeJS.Timeout | undefined;
	let watcher: FSWatcher | undefined;
	let poller: NodeJS.Timeout | undefined;
	let backstop: NodeJS.Timeout | undefined;
	const { backstopMs, watch: watchDir, statLog } = __tailTestSeam;

	const sizeOfLog = (): number => {
		try {
			return statSync(logPath).size;
		} catch {
			return 0;
		}
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
	 * Whether the log's timestamps moved at the same size on the previous check too. A filesystem with no stable inode
	 * numbers (inode 0) gives no identity, so a same-size replacement is seen by its mtime and ctime instead. Both must
	 * differ from the recorded ones on TWO consecutive checks: some systems update a write's timestamps before its size,
	 * and one check can land between the two halves of an append.
	 */
	let timesMoved = false;

	const check = (): void => {
		// The directory first: a vault replaced in one step can hold a log of any size, and a directory deleted while it
		// held no log bytes changes no size at all (an absent log reads as 0).
		if (auditDirMoved()) {
			events.onResync();
			return;
		}
		const size = sizeOfLog();
		const known = sizeOf();
		if (size !== known) timesMoved = false;
		if (size < known) events.onResync();
		else if (size > known) events.onGrow();
		else if (identityOf !== undefined) {
			// A same-size replacement changes no size, so the identity is compared, or the timestamps where it is unknown.
			const knownId = identityOf();
			if (knownId !== undefined) {
				timesMoved = false;
				if (replacedAtSameSize(knownId)) events.onResync();
			} else if (rewrittenAtSameSize()) events.onResync();
		}
	};

	const rewrittenAtSameSize = (): boolean => {
		const known = timesOf?.();
		let moved = false;
		if (known !== undefined) {
			try {
				const st = statSync(logPath, { bigint: true });
				moved = st.mtimeNs !== known.mtimeNs || st.ctimeNs !== known.ctimeNs;
			} catch {
				moved = false;
			}
		}
		const confirmed = moved && timesMoved;
		// A resync records new timestamps; the next difference starts its own count.
		timesMoved = moved && !confirmed;
		return confirmed;
	};

	const replacedAtSameSize = (known: string | undefined): boolean => {
		if (known === undefined) return false;
		try {
			const now = fileIdentity(statSync(logPath, { bigint: true }));
			return now !== undefined && now !== known;
		} catch {
			return false;
		}
	};

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
		// absence), or the known size moved since the last call, or while a timestamp change waits for its second check.
		// Every field check() compares is in the key, or a skip could hide it. The log's fields come from ONE BigInt stat:
		// a JS number cannot hold a 64-bit file id (Windows' exceed 2^53), and two ids that round to one value would let
		// a skip hide a replacement.
		let memo: string | undefined;
		backstop = setInterval(() => {
			let seen: string;
			try {
				const st = statLog(logPath);
				seen = `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.dev}:${st.ino}:${st.birthtimeNs}`;
			} catch (err) {
				seen = `error:${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
			}
			seen += `|${auditDirNow()}|${sizeOf()}`;
			if (seen === memo && !timesMoved) return;
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

	return () => {
		if (timer) clearTimeout(timer);
		watcher?.close();
		if (backstop) clearInterval(backstop);
		if (poller) clearInterval(poller);
	};
}
