// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The governor's side of `audit/effective-budget.ts`: it records the budget it ENFORCES in its own vault, where the
 * vault readers look. Kept apart from the reader so the audit readers stay free of filesystem writes.
 */

import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EFFECTIVE_BUDGET_FILE } from "../audit/effective-budget.js";
import { PRIVATE_FILE_MODE } from "../shared/private-fs.js";

/**
 * What the record carries: the budget (or, when the vault's live governors disagree, `null` and how many there are),
 * WHEN it was written, and WHICH process wrote it. `writtenAt` lets every reader show the record's age, so a record
 * that outlived its writer (a removal that also failed) never passes as current.
 */
type EffectiveBudgetRecord = ({ budget: number } | { budget: null; governors: number }) & {
	writtenAt: string;
	pid: number;
	processStartedAt: string;
};

/** The filesystem steps the failure paths depend on: test seams, because none of these failures is easy to stage. */
export interface EffectiveRecordIo {
	write: (path: string, data: string) => void;
	rename: (from: string, to: string) => void;
	/** Removes the staging file; a missing one is not an error. */
	cleanup: (path: string) => void;
	remove: (path: string) => void;
}

const REAL_IO: EffectiveRecordIo = {
	write: (path, data) => writeFileSync(path, data, { mode: PRIVATE_FILE_MODE, flag: "wx" }),
	rename: (from, to) => renameSync(from, to),
	cleanup: (path) => rmSync(path, { force: true }),
	remove: (path) => rmSync(path),
};

/**
 * The budgets the LIVE governors in this process enforce, per vault. One process holds a vault's audit writer lock,
 * so every governor that can enforce on a vault is in this map: the record is aggregated here, in-process, with no
 * cross-process liveness. A stored "conflict" flag would go stale; the record is instead rewritten on every start and
 * every destroy, as the agreed budget or as "several governors".
 */
const liveBudgets = new Map<string, Map<symbol, number>>();

/**
 * Register a governor's enforced budget on its vault (`vaultDir` is the `.usertrust` directory) and publish the
 * vault's record. Returns the release a destroy() calls: it drops this governor and republishes for the rest (the last
 * one's release leaves the record as it was, read "as of" its writtenAt). Never throws.
 */
export function registerEnforcedBudget(
	vaultDir: string,
	budget: number,
	seams: Partial<EffectiveRecordIo> = {},
): () => void {
	const key = resolve(vaultDir);
	let live = liveBudgets.get(key);
	if (live === undefined) {
		live = new Map();
		liveBudgets.set(key, live);
	}
	const id = Symbol("governor");
	live.set(id, budget);
	publish(key, live, seams);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		live.delete(id);
		if (live.size === 0) {
			liveBudgets.delete(key);
			return;
		}
		publish(key, live, seams);
	};
}

function publish(
	vaultDir: string,
	live: Map<symbol, number>,
	seams: Partial<EffectiveRecordIo>,
): void {
	const distinct = new Set(live.values());
	if (distinct.size === 1) {
		writeRecord(vaultDir, { budget: [...distinct][0] as number }, seams);
	} else {
		writeRecord(vaultDir, { budget: null, governors: live.size }, seams);
	}
}

/**
 * Record `budget` as the one this vault's governor enforces, outside the live registry (a one-off writer, and the
 * tests' way to stage a record). Never throws: on failure it warns on stderr and removes any earlier record.
 */
export function recordEffectiveBudget(
	vaultDir: string,
	budget: number,
	seams: Partial<EffectiveRecordIo> = {},
): void {
	writeRecord(vaultDir, { budget }, seams);
}

function writeRecord(
	vaultDir: string,
	body: { budget: number } | { budget: null; governors: number },
	seams: Partial<EffectiveRecordIo>,
): void {
	const io: EffectiveRecordIo = { ...REAL_IO, ...seams };
	const target = join(vaultDir, EFFECTIVE_BUDGET_FILE);
	// A unique staging path per write, so two governors starting on one vault never rename each other's half-file.
	const tmp = join(vaultDir, `${EFFECTIVE_BUDGET_FILE}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const now = Date.now();
		const record: EffectiveBudgetRecord = {
			...body,
			writtenAt: new Date(now).toISOString(),
			pid: process.pid,
			processStartedAt: new Date(now - Math.round(process.uptime() * 1000)).toISOString(),
		};
		io.write(tmp, JSON.stringify(record));
		io.rename(tmp, target);
	} catch (err) {
		// The cleanup is best-effort too: `force` ignores a missing file, not a read-only filesystem (EROFS), and an
		// advisory record must never reject the governor's constructor.
		try {
			io.cleanup(tmp);
		} catch {
			// a staging file left behind is harmless: readers only open effective-budget.json
		}
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
