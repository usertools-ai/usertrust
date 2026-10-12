// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The governor's side of `audit/effective-budget.ts`: it records the budget it ENFORCES in its own vault, where the
 * vault readers look. Kept apart from the reader so the audit readers stay free of filesystem writes.
 */

import { randomUUID } from "node:crypto";
import { renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * The budgets the LIVE governors in this process enforce, per vault, and the lock owner the record was last published
 * under. The record is published ONLY while this process holds the vault's audit writer lock: the holder is the one
 * process whose appends reach the chain, so every governor that can enforce on the vault through it is in this map.
 * A governor takes the lock lazily, at its first append, so before that nothing is published; a process that loses
 * the race (its appends fail on the lock and it runs degraded) never overwrites the holder's record. A stored
 * "conflict" flag would go stale; the record is instead rewritten on every start and every destroy while the lock is
 * held, and once more when the lock is taken by a writer it was not published under.
 */
interface VaultRegistry {
	live: Map<symbol, number>;
	/** The lock owner the record was last published under, or undefined if it never was. */
	publishedUnder: string | undefined;
}
const registries = new Map<string, VaultRegistry>();

/** A governor's registration: `appended` after each of its successful appends, `release` from its destroy(). */
export interface EnforcedBudgetRegistration {
	/** The process now holds the vault's writer lock: publish if the record was not published under this owner. */
	appended(): void;
	/** Drop this governor and republish for the rest while the lock is held (the last one's leaves the record as it was, read "as of" its writtenAt). */
	release(): void;
}

/**
 * Register a governor's enforced budget on its vault (`vaultDir` is the `.usertrust` directory). `lockOwner` reads
 * which writer holds the vault's lock in this process (the governor's audit handle, `AuditWriter.lockOwner`);
 * undefined means none, and nothing is published. Never throws.
 */
export function registerEnforcedBudget(
	vaultDir: string,
	budget: number,
	lockOwner: () => string | undefined,
	seams: Partial<EffectiveRecordIo> = {},
): EnforcedBudgetRegistration {
	const key = vaultIdentity(vaultDir);
	let registry = registries.get(key);
	if (registry === undefined) {
		registry = { live: new Map(), publishedUnder: undefined };
		registries.set(key, registry);
	}
	const reg = registry;
	const id = Symbol("governor");
	reg.live.set(id, budget);
	// The record is written through THIS caller's path: any alias of the vault reaches the same physical file.
	const publishIfHeld = (): void => {
		const owner = ownerOf(lockOwner);
		if (owner === undefined) return;
		publish(vaultDir, reg.live, seams);
		reg.publishedUnder = owner;
	};
	publishIfHeld();
	let released = false;
	return {
		appended: () => {
			if (released) return;
			const owner = ownerOf(lockOwner);
			if (owner !== undefined && owner !== reg.publishedUnder) publishIfHeld();
		},
		release: () => {
			if (released) return;
			released = true;
			reg.live.delete(id);
			if (reg.live.size === 0) {
				if (registries.get(key) === reg) registries.delete(key);
				return;
			}
			publishIfHeld();
		},
	};
}

/** The lock owner, or undefined if it cannot be read: the record is advisory and never throws. */
function ownerOf(lockOwner: () => string | undefined): string | undefined {
	try {
		return lockOwner();
	} catch {
		return undefined;
	}
}

/**
 * One key per PHYSICAL vault directory: its `dev:ino`, the identity the shared audit writer (audit/chain.ts) and the
 * lock registry trust. A lexical path is not one: a symlink, a case or a firmlink alias of the same vault would get a
 * second registry, and a disagreement would be invisible. The resolved path is the fallback only when the directory
 * cannot be stat'ed (the record is advisory and never throws).
 */
function vaultIdentity(vaultDir: string): string {
	try {
		const id = statSync(vaultDir, { bigint: true });
		return `${id.dev}:${id.ino}`;
	} catch {
		return resolve(vaultDir);
	}
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
		warnBestEffort(
			`[usertrust] could not record the enforced budget in ${target}: ${
				err instanceof Error ? err.message : String(err)
			}; ${removed}. Enforcement is unaffected; vault readers fall back to the vault config.\n`,
		);
	}
}

/**
 * The warning is best-effort too. stderr can fail where the record did (the same full or read-only filesystem): a
 * write that throws, or a stream `'error'`, which with no listener is an uncaught exception. Either would reject an
 * initialised governor at registration, or escape a destroy() before its teardown steps. The throw is caught, and an
 * `'error'` from THIS write is contained by a listener held until a turn after the write's callback.
 */
function warnBestEffort(message: string): void {
	const stderr = process.stderr;
	const contain = (): void => {};
	try {
		stderr.on("error", contain);
		stderr.write(message, () => setImmediate(() => stderr.off("error", contain)));
	} catch {
		stderr.off("error", contain);
	}
}
