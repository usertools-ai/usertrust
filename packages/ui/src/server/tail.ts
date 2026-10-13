// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync, type FSWatcher, statSync, unwatchFile, watch, watchFile } from "node:fs";
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
	let polling = false;

	const check = (): void => {
		const size = existsSync(logPath) ? statSync(logPath).size : 0;
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
		// fs.watchFile stats a missing path too, so the log's path is polled until it appears and grows.
		polling = true;
		watchFile(logPath, { interval: MISSING_DIR_POLL_MS }, check);
	}

	return () => {
		if (timer) clearTimeout(timer);
		watcher?.close();
		if (polling) unwatchFile(logPath, check);
	};
}
