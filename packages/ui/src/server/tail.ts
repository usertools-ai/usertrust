// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { join } from "node:path";

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
 * For tests only, never exported from the package: the backstop's interval and the fs.watch function, read once when
 * `watchLedger` starts. Tests shorten the one and replace the other with a watcher that never calls back, or that emits
 * `error`. The defaults are the production behaviour.
 */
export const __tailTestSeam: { backstopMs: number; watch: typeof watch } = {
	backstopMs: BACKSTOP_MS,
	watch,
};

export function watchLedger(
	vaultPath: string,
	sizeOf: () => number,
	events: TailEvents,
): () => void {
	const auditDir = join(vaultPath, "audit");
	const logPath = join(auditDir, "events.jsonl");
	let timer: NodeJS.Timeout | undefined;
	let watcher: FSWatcher | undefined;
	let poller: NodeJS.Timeout | undefined;
	let backstop: NodeJS.Timeout | undefined;
	const { backstopMs, watch: watchDir } = __tailTestSeam;

	const sizeOfLog = (): number => {
		try {
			return statSync(logPath).size;
		} catch {
			return 0;
		}
	};

	const check = (): void => {
		const size = sizeOfLog();
		const known = sizeOf();
		if (size < known) events.onResync();
		else if (size > known) events.onGrow();
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
		// runs only when the log's size, mtime or inode, its stat error, or the known size moved since the last call.
		let memo: string | undefined;
		backstop = setInterval(() => {
			let seen: string;
			try {
				const st = statSync(logPath);
				seen = `${st.size}:${st.mtimeMs}:${st.ino}`;
			} catch (err) {
				seen = `error:${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
			}
			seen += `|${sizeOf()}`;
			if (seen === memo) return;
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
			if (lost || appeared) events.onResync();
			else check();
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
