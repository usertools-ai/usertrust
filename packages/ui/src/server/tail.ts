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
		watcher = watch(auditDir, () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(check, DEBOUNCE_MS);
		});
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
			logSeen = logNow;
			dirSeen = dirNow;
			if (lost) events.onResync();
			else check();
		}, MISSING_DIR_POLL_MS);
		// The poll must never keep a process alive on its own: the server's close() clears it, and a process that has
		// nothing else to do exits even if a caller forgets to close.
		poller.unref();
	}

	return () => {
		if (timer) clearTimeout(timer);
		watcher?.close();
		if (poller) clearInterval(poller);
	};
}
