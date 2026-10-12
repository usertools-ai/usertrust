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

interface EffectiveBudgetRecord {
	budget: number;
	recordedAt: string;
}

/**
 * Record `budget` as the one this vault's governor enforces. `vaultDir` is the `.usertrust` directory, which the
 * governor has already created owner-only. Never throws: on failure it warns on stderr and removes any earlier record.
 */
export function recordEffectiveBudget(
	vaultDir: string,
	budget: number,
	/** Test seam: the staging write. A real write failure that leaves the old record removable is hard to stage. */
	_write: (path: string, data: string) => void = writeStaged,
): void {
	const target = join(vaultDir, EFFECTIVE_BUDGET_FILE);
	// A unique staging path per write, so two governors starting on one vault never rename each other's half-file.
	const tmp = join(vaultDir, `${EFFECTIVE_BUDGET_FILE}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const record: EffectiveBudgetRecord = { budget, recordedAt: new Date().toISOString() };
		_write(tmp, JSON.stringify(record));
		renameSync(tmp, target);
	} catch (err) {
		rmSync(tmp, { force: true });
		let removed = "no earlier record was present";
		try {
			rmSync(target);
			removed = "the earlier record was removed";
		} catch (rmErr) {
			const code = (rmErr as NodeJS.ErrnoException | undefined)?.code;
			if (code !== "ENOENT")
				removed = `the earlier record could NOT be removed (${code ?? "error"})`;
		}
		process.stderr.write(
			`[usertrust] could not record the enforced budget in ${target}: ${
				err instanceof Error ? err.message : String(err)
			}; ${removed}. Enforcement is unaffected; vault readers fall back to the vault config.\n`,
		);
	}
}

function writeStaged(path: string, data: string): void {
	writeFileSync(path, data, { mode: PRIVATE_FILE_MODE, flag: "wx" });
}
