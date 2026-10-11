// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * An opener process for the migration race (#177): it signals it is ready, waits for the shared
 * "go" file so every opener starts together, then OPENS the journal (which migrates a v0 file)
 * and closes it. Prints one JSON line; exits non-zero if the open throws.
 */

import { existsSync, writeFileSync } from "node:fs";
import { HoldJournal } from "../../src/journal.js";

const [dbPath, goFile, readyFile] = process.argv.slice(2);
writeFileSync(readyFile as string, "");
while (!existsSync(goFile as string)) {
	await new Promise((r) => setTimeout(r, 1));
}
const startedAt = performance.timeOrigin + performance.now();
const j = HoldJournal.open(dbPath as string, { busyTimeoutMs: 5_000, busyRetries: 5 });
j.close();
console.log(JSON.stringify({ ok: true, startedAt }));
