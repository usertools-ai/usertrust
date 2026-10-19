// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The governor's side of `audit/effective-budget.ts`: it records the budget it ENFORCES in its own vault, where the
 * vault readers look. Kept apart from the reader so the audit readers stay free of filesystem writes.
 */

import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EFFECTIVE_BUDGET_FILE } from "../audit/effective-budget.js";
import { scrubForTerminal } from "../cli/target.js";
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
	/** Gives `from` the name `to`, failing if `to` exists: how a publish without the lock never replaces a record. */
	link: (from: string, to: string) => void;
}

const REAL_IO: EffectiveRecordIo = {
	write: (path, data) => writeFileSync(path, data, { mode: PRIVATE_FILE_MODE, flag: "wx" }),
	rename: (from, to) => renameSync(from, to),
	cleanup: (path) => rmSync(path, { force: true }),
	remove: (path) => rmSync(path),
	link: (from, to) => linkSync(from, to),
};

/**
 * The budgets the LIVE governors in this process enforce, per vault, and the lock owner the record was last published
 * under. The record is REPLACED only while this process holds the vault's audit writer lock: the holder is the one
 * process whose appends reach the chain, so every governor that can enforce on the vault through it is in this map,
 * and a process that loses the race (its appends fail on the lock and it runs degraded) never overwrites the holder's
 * record. A stored "conflict" flag would go stale; the record is instead rewritten on every start and every destroy
 * while the lock is held, and once more when the lock is taken by a writer it was not published under.
 *
 * A governor takes the lock lazily, at its first append. Until then it publishes WITHOUT the lock, but only where no
 * other writer's record stands: where there is no record at all (a new vault, or one only an earlier release wrote,
 * which never published one), or where the record is still this process's own unheld one (`unheldRecords`). So
 * readers see the budget from the start, never "not yet published" until a first call, and never in place of a
 * record another process published. The lock holder's first append replaces an unheld record with its own.
 *
 * A write that FAILED publishes nothing, so it does not count as published: the next append retries it. Every append,
 * not a backoff: an append already writes to this vault, so one more small write beside it costs little, and a timer
 * would leave readers on "not yet published" after the filesystem recovered. The retries do not warn again: one
 * warning per lock owner until a write succeeds, so a filesystem that keeps failing warns once, not on every call.
 */
interface VaultRegistry {
	live: Map<symbol, number>;
	/** The lock owner the record was last published under, or undefined if it never was. Set only by a write that succeeded. */
	publishedUnder: string | undefined;
	/** The lock owner whose failed write has already warned, until a write succeeds; undefined if none has failed. */
	warnedUnder: string | undefined;
}
const registries = new Map<string, VaultRegistry>();

/**
 * Per physical vault: the exact text of the record this process last published WITHOUT the lock, while that record may
 * still stand. Kept after the vault's registry is dropped, so a later governor in this process can replace its own
 * record, and only its own; a publish under the lock ends it.
 */
const unheldRecords = new Map<string, string>();

/**
 * A governor's registration: `appended` after each of its successful appends, `release` from its destroy(), once the
 * calls it drains and the holds it records have appended and before the audit lock is released: a call that settles
 * while destroy() drains may be the governor's first append, and must still publish.
 */
export interface EnforcedBudgetRegistration {
	/**
	 * The process now holds the vault's writer lock: publish if the record was not published under this owner, which
	 * includes a publish whose write failed (retried here, at every append, until one succeeds).
	 */
	appended(): void;
	/**
	 * Drop this governor and republish for the rest, under the lock or, without it, over this process's own unheld
	 * record only (the last one's leaves the record as it was, read "as of" its writtenAt).
	 */
	release(): void;
}

/**
 * Register a governor's enforced budget on its vault (`vaultDir` is the `.usertrust` directory) and publish it at once.
 * `lockOwner` reads which writer holds the vault's lock in this process (the governor's audit handle,
 * `AuditWriter.lockOwner`); undefined means none, and the publish then never replaces another writer's record. Never
 * throws.
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
		registry = { live: new Map(), publishedUnder: undefined, warnedUnder: undefined };
		registries.set(key, registry);
	}
	const reg = registry;
	const id = Symbol("governor");
	reg.live.set(id, budget);
	// The record is written through THIS caller's path: any alias of the vault reaches the same physical file.
	const publishUnder = (owner: string): void => {
		// Whatever this write does, the record on disk is no longer an unheld one of this process's.
		unheldRecords.delete(key);
		if (publish(vaultDir, reg.live, seams, reg.warnedUnder !== owner)) {
			reg.publishedUnder = owner;
			reg.warnedUnder = undefined;
		} else {
			// Not published, and an earlier success under this owner no longer stands (the failed write removed its
			// record, or the live set it described has changed): the next append retries.
			reg.publishedUnder = undefined;
			reg.warnedUnder = owner;
		}
	};
	const publishNow = (): void => {
		const owner = ownerOf(lockOwner);
		if (owner !== undefined) {
			publishUnder(owner);
			return;
		}
		const mine = publishUnheld(vaultDir, liveBody(reg.live), unheldRecords.get(key), seams);
		if (mine === undefined) unheldRecords.delete(key);
		else unheldRecords.set(key, mine);
	};
	publishNow();
	let released = false;
	return {
		appended: () => {
			if (released) return;
			const owner = ownerOf(lockOwner);
			if (owner !== undefined && owner !== reg.publishedUnder) publishUnder(owner);
		},
		release: () => {
			if (released) return;
			released = true;
			reg.live.delete(id);
			if (reg.live.size === 0) {
				if (registries.get(key) === reg) registries.delete(key);
				return;
			}
			publishNow();
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

type RecordBody = { budget: number } | { budget: null; governors: number };

/** What the live governors' record says: the budget they agree on, or that they disagree and how many there are. */
function liveBody(live: Map<symbol, number>): RecordBody {
	const distinct = new Set(live.values());
	return distinct.size === 1
		? { budget: [...distinct][0] as number }
		: { budget: null, governors: live.size };
}

/** Write the live governors' record; true only if it was written. */
function publish(
	vaultDir: string,
	live: Map<symbol, number>,
	seams: Partial<EffectiveRecordIo>,
	warn: boolean,
): boolean {
	return writeRecord(vaultDir, liveBody(live), seams, warn);
}

/** The record's text, stamped now. */
function recordText(body: RecordBody): string {
	const now = Date.now();
	const record: EffectiveBudgetRecord = {
		...body,
		writtenAt: new Date(now).toISOString(),
		pid: process.pid,
		processStartedAt: new Date(now - Math.round(process.uptime() * 1000)).toISOString(),
	};
	return JSON.stringify(record);
}

/** A unique staging path per write, so two governors starting on one vault never rename each other's half-file. */
function stagingPath(vaultDir: string): string {
	return join(vaultDir, `${EFFECTIVE_BUDGET_FILE}.${process.pid}.${randomUUID()}.tmp`);
}

/**
 * A file's text if it is a regular file, `null` if nothing is there, undefined if it is anything else or cannot be
 * read. Stat FIRST, as every reader does: opening a FIFO planted at the path would block the governor.
 */
function readRegular(path: string): string | null | undefined {
	try {
		if (!statSync(path).isFile()) return undefined;
		return readFileSync(path, "utf-8");
	} catch (err) {
		return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? null : undefined;
	}
}

/**
 * Publish WITHOUT the vault's writer lock, never over another writer's record: only where there is no record, or where
 * the record is still, byte for byte, `mine` (this process's last unheld record). The new record is staged whole and
 * then LINKED into place, which fails if a record appeared meanwhile; the own record it replaces is first moved aside,
 * and put back if, by then, it turned out to be another writer's. Returns the text of this process's unheld record now
 * on disk, or undefined if there is none. Never throws, never warns, and never removes another writer's record: a
 * failure leaves readers where they were (an absent record reads as not yet published).
 */
function publishUnheld(
	vaultDir: string,
	body: RecordBody,
	mine: string | undefined,
	seams: Partial<EffectiveRecordIo>,
): string | undefined {
	const io: EffectiveRecordIo = { ...REAL_IO, ...seams };
	const target = join(vaultDir, EFFECTIVE_BUDGET_FILE);
	const current = readRegular(target);
	// Another writer's record, or something that is not a record this process can judge: it stands.
	if (current === undefined || (current !== null && current !== mine)) return undefined;
	const tmp = stagingPath(vaultDir);
	let ownMovedAside = false;
	try {
		const text = recordText(body);
		io.write(tmp, text);
		if (current !== null) {
			const aside = stagingPath(vaultDir);
			io.rename(target, aside);
			ownMovedAside = true;
			if (readRegular(aside) !== mine) {
				putBack(io, aside, target);
				return undefined;
			}
			removeQuietly(io, aside);
		}
		io.link(tmp, target);
		return text;
	} catch {
		// Nothing was published. This process's own earlier record, if one was moved aside, is gone: it described
		// governors that are no longer the live set, so none is better than it.
		return ownMovedAside ? undefined : mine;
	} finally {
		removeQuietly(io, tmp);
	}
}

/**
 * A record replaced since it was read was another writer's, moved aside by mistake: link it back unless a newer one has
 * taken its place (then the newer one stands). If it cannot be linked for any other reason it is renamed back, and if
 * that fails too it is left where it is rather than removed.
 */
function putBack(io: EffectiveRecordIo, aside: string, target: string): void {
	try {
		io.link(aside, target);
	} catch (err) {
		if ((err as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
			try {
				io.rename(aside, target);
			} catch {
				// left aside, never removed
			}
			return;
		}
	}
	removeQuietly(io, aside);
}

/** Remove a staging file, best-effort: one left behind is harmless, since readers only open effective-budget.json. */
function removeQuietly(io: EffectiveRecordIo, path: string): void {
	try {
		io.cleanup(path);
	} catch {
		// left behind
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
	writeRecord(vaultDir, { budget }, seams, true);
}

/**
 * Write the record; true only if it is now on disk. Never throws: a failure removes any earlier record and, when
 * `warn`, says so on stderr (a retry of a failure already reported passes false).
 */
function writeRecord(
	vaultDir: string,
	body: RecordBody,
	seams: Partial<EffectiveRecordIo>,
	warn: boolean,
): boolean {
	const io: EffectiveRecordIo = { ...REAL_IO, ...seams };
	const target = join(vaultDir, EFFECTIVE_BUDGET_FILE);
	const tmp = stagingPath(vaultDir);
	try {
		io.write(tmp, recordText(body));
		io.rename(tmp, target);
		return true;
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
		// The path is the caller's (a vaultBase), and the error quotes it: scrubbed for the terminal, as every echo is.
		if (warn) {
			warnBestEffort(
				`[usertrust] could not record the enforced budget in ${scrubForTerminal(target)}: ${scrubForTerminal(
					err instanceof Error ? err.message : String(err),
				)}; ${removed}. Enforcement is unaffected; vault readers fall back to the vault config.\n`,
			);
		}
		return false;
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
