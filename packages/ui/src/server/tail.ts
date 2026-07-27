// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { type FSWatcher, existsSync, statSync, watch } from "node:fs";
import { join } from "node:path";

export interface TailEvents {
	/** Byte range grew: caller reads/verifies the appended lines itself. */
	onGrow(): void;
	/** File shrank or was replaced: caller must fully reload + notify clients. */
	onResync(): void;
}

const DEBOUNCE_MS = 250;

export function watchLedger(
	vaultPath: string,
	sizeOf: () => number,
	events: TailEvents,
): () => void {
	const auditDir = join(vaultPath, "audit");
	const logPath = join(auditDir, "events.jsonl");
	let timer: NodeJS.Timeout | undefined;
	let watcher: FSWatcher | undefined;

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
		// Audit dir missing — nothing to watch; server still serves empty state.
	}

	return () => {
		if (timer) clearTimeout(timer);
		watcher?.close();
	};
}
