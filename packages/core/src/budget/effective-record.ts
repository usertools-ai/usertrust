// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The governor's side of `audit/effective-budget.ts`: it records the budget it ENFORCES in its own vault, where the
 * vault readers look. Kept apart from the reader so the audit readers stay free of filesystem writes.
 */

import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EFFECTIVE_BUDGET_FILE } from "../audit/effective-budget.js";
import { PRIVATE_FILE_MODE } from "../shared/private-fs.js";

/**
 * What the record carries: the budget, WHEN it was written, and WHICH process wrote it. `writtenAt` lets every reader
 * show the record's age, so a record that outlived its writer (a removal that also failed) never passes as current.
 */
interface EffectiveBudgetRecord {
	budget: number;
	writtenAt: string;
	pid: number;
	processStartedAt: string;
}

/** The two filesystem steps a failure path depends on: test seams, because neither failure is easy to stage. */
export interface EffectiveRecordIo {
	write: (path: string, data: string) => void;
	remove: (path: string) => void;
}

const REAL_IO: EffectiveRecordIo = {
	write: (path, data) => writeFileSync(path, data, { mode: PRIVATE_FILE_MODE, flag: "wx" }),
	remove: (path) => rmSync(path),
};

/**
 * Record `budget` as the one this vault's governor enforces. `vaultDir` is the `.usertrust` directory, which the
 * governor has already created owner-only. Never throws: on failure it warns on stderr and removes any earlier record.
 */
export function recordEffectiveBudget(
	vaultDir: string,
	budget: number,
	io: EffectiveRecordIo = REAL_IO,
): void {
	const target = join(vaultDir, EFFECTIVE_BUDGET_FILE);
	// A unique staging path per write, so two governors starting on one vault never rename each other's half-file.
	const tmp = join(vaultDir, `${EFFECTIVE_BUDGET_FILE}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const now = Date.now();
		const record: EffectiveBudgetRecord = {
			budget,
			writtenAt: new Date(now).toISOString(),
			pid: process.pid,
			processStartedAt: new Date(now - Math.round(process.uptime() * 1000)).toISOString(),
		};
		io.write(tmp, JSON.stringify(record));
		renameSync(tmp, target);
	} catch (err) {
		rmSync(tmp, { force: true });
		let removed = "no earlier record was present";
		try {
			io.remove(target);
			removed = "the earlier record was removed";
		} catch (rmErr) {
			const code = (rmErr as NodeJS.ErrnoException | undefined)?.code;
			if (code !== "ENOENT")
				removed = `the earlier record could NOT be removed (${code ?? "error"}); readers show its writtenAt, so it reads as old, never as current`;
		}
		process.stderr.write(
			`[usertrust] could not record the enforced budget in ${target}: ${
				err instanceof Error ? err.message : String(err)
			}; ${removed}. Enforcement is unaffected; vault readers fall back to the vault config.\n`,
		);
	}
}
