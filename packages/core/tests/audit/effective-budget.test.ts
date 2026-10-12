// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The budget a governor ENFORCES reaches its vault's readers.
 *
 * A server tenant's budget (`opts.budget`), an SDK caller's `trust(client, { budget })`, a config file outside the
 * vault, and the built-in default all used to read as 0 from the vault ("no budget set", and a negative remaining),
 * because every reader looked only at the vault's own `usertrust.config.json`.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

import {
	AuditWriterLockHeldError,
	createAuditWriter,
	openSharedAuditWriter,
} from "../../src/audit/chain.js";
import { EFFECTIVE_BUDGET_FILE, readEffectiveBudget } from "../../src/audit/effective-budget.js";
import { describeBudgetSource, isKnownBudget, loadBudgetConfig } from "../../src/audit/read.js";
import { recordEffectiveBudget } from "../../src/budget/effective-record.js";
import { trust } from "../../src/govern.js";
import { createGovernor, type Governor } from "../../src/headless.js";
import { DEFAULT_BUDGET, VAULT_DIR } from "../../src/shared/constants.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let base: string;
let vaultDir: string;

beforeEach(() => {
	base = join(tmpdir(), `effective-budget-${randomUUID()}`);
	vaultDir = join(base, VAULT_DIR);
	mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(base, { recursive: true, force: true });
});

function writeConfig(path: string, budget: number): void {
	writeFileSync(path, JSON.stringify({ budget }), { mode: 0o600 });
}

/** One governed call. A governor publishes its budget only once this process holds the vault's writer lock: from its
 *  first successful append. */
async function appendOnce(gov: Governor): Promise<void> {
	const auth = await gov.authorize({
		model: "claude-haiku-5-5",
		estimatedInputTokens: 10,
		maxOutputTokens: 1,
	});
	await gov.settle(auth, { inputTokens: 1, outputTokens: 1 });
}

/** A chat client whose one call succeeds, so a `trust()` client can append. */
function chatClient() {
	return {
		chat: {
			completions: {
				create: vi.fn().mockResolvedValue({
					id: "c",
					model: "gpt-4o",
					choices: [{ message: { role: "assistant", content: "ok" } }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			},
		},
	};
}

async function callOnce(client: unknown): Promise<void> {
	await (
		client as { chat: { completions: { create: (a: unknown) => Promise<unknown> } } }
	).chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
}

describe("recordEffectiveBudget / readEffectiveBudget", () => {
	it("round-trips the budget, owner-only, leaving no staging file", () => {
		const before = Date.now();
		recordEffectiveBudget(vaultDir, 2_000);
		const first = readEffectiveBudget(vaultDir);
		expect(first).toMatchObject({ state: "recorded", budget: 2_000 });
		expect(first.state === "recorded" && Date.parse(first.writtenAt)).toBeGreaterThanOrEqual(
			before - 1,
		);
		expect(statSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).mode & 0o777).toBe(0o600);
		// WHICH process wrote it, besides when: the pid and that process's start
		const raw = JSON.parse(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE), "utf-8")) as Record<
			string,
			unknown
		>;
		expect(raw.pid).toBe(process.pid);
		expect(raw.processStartedAt).toMatch(ISO);
		recordEffectiveBudget(vaultDir, 3_000);
		expect(readEffectiveBudget(vaultDir)).toMatchObject({ state: "recorded", budget: 3_000 });
		expect(readdirSync(vaultDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("only a missing record is absent; anything that is not a positive integer budget is unreadable", () => {
		expect(readEffectiveBudget(vaultDir)).toEqual({ state: "absent" });
		const p = join(vaultDir, EFFECTIVE_BUDGET_FILE);
		for (const text of [
			"{not json",
			"null",
			'{"budget":0}',
			'{"budget":1.5}',
			'{"budget":"9"}',
			"{}",
			'{"budget":9}', // no writtenAt: a record without an age is not one
			'{"budget":9,"writtenAt":"yesterday"}',
			'{"budget":9,"writtenAt":"2026-10-12T15:00:00Z\\u001b[2J"}',
		]) {
			writeFileSync(p, text);
			expect(readEffectiveBudget(vaultDir).state, text).toBe("unreadable");
		}
	});

	it("red-first (stale): a FAILED write removes the earlier record and warns; it never throws", () => {
		recordEffectiveBudget(vaultDir, 2_000);
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		expect(() =>
			recordEffectiveBudget(vaultDir, 9_000, {
				write: () => {
					throw new Error("ENOSPC: no space left on device");
				},
				remove: (p) => rmSync(p),
			}),
		).not.toThrow();
		expect(readEffectiveBudget(vaultDir)).toEqual({ state: "absent" });
		const said = err.mock.calls.map((c) => String(c[0])).join("");
		expect(said).toMatch(
			/could not record the enforced budget .*ENOSPC.*the earlier record was removed/,
		);
	});

	it("a failed write with no earlier record and no config leaves readers at 'unpublished', not a number", () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		recordEffectiveBudget(vaultDir, 9_000, {
			write: () => {
				throw new Error("EIO");
			},
			remove: (p) => rmSync(p),
		});
		expect(loadBudgetConfig(vaultDir)).toEqual({
			budget: 0,
			source: "unpublished",
			writtenAt: null,
			reason: null,
		});
	});
});

describe("a STALE record never passes as current", () => {
	it("red-first (no age): the write AND the removal fail; the old record stays, and every reader shows its age", () => {
		const OLD = "2026-01-02T03:04:05.000Z";
		writeFileSync(
			join(vaultDir, EFFECTIVE_BUDGET_FILE),
			JSON.stringify({ budget: 2_000, writtenAt: OLD, pid: 1, processStartedAt: OLD }),
		);
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		recordEffectiveBudget(vaultDir, 9_000, {
			write: () => {
				throw new Error("EROFS: read-only file system");
			},
			remove: () => {
				throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			},
		});
		const got = loadBudgetConfig(vaultDir);
		expect(got).toEqual({ budget: 2_000, source: "governor", writtenAt: OLD, reason: null });
		expect(describeBudgetSource(got)).toBe(`the enforced budget, as of ${OLD}`);
		expect(err.mock.calls.map((c) => String(c[0])).join("")).toMatch(
			/the earlier record could NOT be removed \(EPERM\); readers show its writtenAt/,
		);
	});

	it("provenance wording: only a governor record reads as enforced, and with its age", () => {
		expect(
			describeBudgetSource({ source: "governor", writtenAt: "2026-10-12T15:00:00.000Z" }),
		).toBe("the enforced budget, as of 2026-10-12T15:00:00.000Z");
		expect(describeBudgetSource({ source: "config", writtenAt: null })).toBe(
			"from usertrust.config.json; not confirmed as enforced",
		);
		expect(describeBudgetSource({ source: "unpublished", writtenAt: null })).toBe(
			"unknown: not yet published; no governor has recorded the budget it enforces",
		);
		expect(
			describeBudgetSource({ source: "unreadable", writtenAt: null, reason: "not valid JSON" }),
		).toBe("unknown: the enforced-budget record could not be read; not valid JSON");
	});
});

describe("loadBudgetConfig: the governor's record, then the vault config, else unknown", () => {
	it.each([
		["record only", 2_000, null, { budget: 2_000, source: "governor" }],
		["the record wins over the vault config", 2_000, 500, { budget: 2_000, source: "governor" }],
		["no record: the vault config", null, 500, { budget: 500, source: "config", writtenAt: null }],
		[
			"neither: unpublished (UNKNOWN, never a budget of 0)",
			null,
			null,
			{ budget: 0, source: "unpublished", writtenAt: null, reason: null },
		],
	] as const)("%s", (_n, recorded, configured, expected) => {
		if (recorded !== null) recordEffectiveBudget(vaultDir, recorded);
		if (configured !== null) writeConfig(join(vaultDir, "usertrust.config.json"), configured);
		const got = loadBudgetConfig(vaultDir);
		expect(got).toMatchObject(expected);
		// Only a governor record carries an age; it is the instant it was written.
		if (got.source === "governor") expect(got.writtenAt).toMatch(ISO);
		else expect(got.writtenAt).toBeNull();
	});

	it("red-first (none): an UNREADABLE record is unknown WITH its reason, even with a config present", () => {
		writeFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE), "{torn");
		writeConfig(join(vaultDir, "usertrust.config.json"), 500);
		const got = loadBudgetConfig(vaultDir);
		expect(got).toEqual({
			budget: 0,
			source: "unreadable",
			writtenAt: null,
			reason: "not valid JSON",
		});
		expect(isKnownBudget(got.source)).toBe(false);
	});
});

describe("the governor records what it ENFORCES (red-first: every row read the vault config, or 0)", () => {
	it.each([
		["createGovernor", "opts.budget, no config file (a server tenant)"],
		["trust", "opts.budget, no config file (an SDK caller)"],
	] as const)("%s: %s → the vault reads that budget", async (ctor, _n) => {
		if (ctor === "createGovernor") {
			const gov = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_234 });
			await appendOnce(gov);
			await gov.destroy();
		} else {
			const g = await trust(chatClient(), { dryRun: true, vaultBase: base, budget: 1_234 });
			await callOnce(g);
			await g.destroy();
		}
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
	});

	it("opts.budget overrides the vault config, and the vault reads the override", async () => {
		writeConfig(join(vaultDir, "usertrust.config.json"), 500);
		const gov = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_234 });
		await appendOnce(gov);
		await gov.destroy();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
	});

	it("a config file OUTSIDE the vault (opts.configPath): the vault reads its budget", async () => {
		const outside = join(base, "tenant.config.json");
		writeConfig(outside, 700);
		const gov = await createGovernor({ dryRun: true, vaultBase: base, configPath: outside });
		await appendOnce(gov);
		await gov.destroy();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 700, source: "governor" });
	});

	it("no budget anywhere: the vault reads the built-in default the governor enforces", async () => {
		const gov = await createGovernor({ dryRun: true, vaultBase: base });
		await appendOnce(gov);
		await gov.destroy();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({
			budget: DEFAULT_BUDGET,
			source: "governor",
		});
		expect(existsSync(join(vaultDir, EFFECTIVE_BUDGET_FILE))).toBe(true);
	});

	it("a later start with a different budget replaces the record (the last start wins)", async () => {
		const a = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_000 });
		await appendOnce(a);
		await a.destroy();
		const b = await createGovernor({ dryRun: true, vaultBase: base, budget: 4_000 });
		await appendOnce(b);
		await b.destroy();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 4_000, source: "governor" });
	});
});

// Whole-PR MAX on 534b7c46: the record is a claim about a RUNNING governor, so it is written only once the governor
// has fully initialised; and nothing on its failure path may reject the constructor.
describe("the record is published only by a governor that started", () => {
	it("red-first (overwritten): a start that fails on an invalid policy leaves the earlier record byte-identical", async () => {
		const first = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_000 });
		await appendOnce(first);
		await first.destroy();
		const before = readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE));
		mkdirSync(join(vaultDir, "policies"), { recursive: true });
		writeFileSync(join(vaultDir, "policies", "default.yml"), "rules: [this is not a rule list\n");
		await expect(
			createGovernor({ dryRun: true, vaultBase: base, budget: 9_000 }),
		).rejects.toThrow();
		expect(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).equals(before)).toBe(true);
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_000, source: "governor" });
	});

	it("red-first (threw): the rename AND the staging cleanup both fail — it returns, warns, and never throws", () => {
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		expect(() =>
			recordEffectiveBudget(vaultDir, 2_000, {
				rename: () => {
					throw Object.assign(new Error("EROFS: read-only file system, rename"), { code: "EROFS" });
				},
				cleanup: () => {
					throw Object.assign(new Error("EROFS: read-only file system, unlink"), { code: "EROFS" });
				},
			}),
		).not.toThrow();
		expect(err.mock.calls.map((c) => String(c[0])).join("")).toMatch(
			/could not record the enforced budget .*EROFS/,
		);
	});
});

describe("a planted non-file at the record's path is never opened", () => {
	it("red-first (hangs): a FIFO is unreadable at once — no reader blocks on it", () => {
		execFileSync("mkfifo", [join(vaultDir, EFFECTIVE_BUDGET_FILE)]);
		const t0 = Date.now();
		expect(readEffectiveBudget(vaultDir)).toEqual({
			state: "unreadable",
			reason: "not a regular file",
		});
		expect(loadBudgetConfig(vaultDir)).toEqual({
			budget: 0,
			source: "unreadable",
			writtenAt: null,
			reason: "not a regular file",
		});
		expect(Date.now() - t0).toBeLessThan(1_000);
	});

	it("a directory at the record's path is unreadable too", () => {
		mkdirSync(join(vaultDir, EFFECTIVE_BUDGET_FILE));
		expect(readEffectiveBudget(vaultDir).state).toBe("unreadable");
	});
});

// Several live governors on one vault (the maintainers' ruling on the review): One process holds the vault's writer lock, so the
// record is aggregated in-process: the agreed budget, or "several governors" when they differ. Rewritten on every
// start and every destroy; no stored conflict flag.
describe("several live governors on one vault", () => {
	it("two governors that AGREE: the record is their budget", async () => {
		const a = await createGovernor({ dryRun: true, vaultBase: base, budget: 3_000 });
		await appendOnce(a);
		const b = await createGovernor({ dryRun: true, vaultBase: base, budget: 3_000 });
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 3_000, source: "governor" });
		await a.destroy();
		await b.destroy();
	});

	it("red-first (the last writer's): two that DISAGREE make the budget UNKNOWN on every surface", async () => {
		const a = await createGovernor({ dryRun: true, vaultBase: base, budget: 3_000 });
		await appendOnce(a);
		const b = await createGovernor({ dryRun: true, vaultBase: base, budget: 5_000 });
		const got = loadBudgetConfig(vaultDir);
		expect(got).toMatchObject({ budget: 0, source: "several" });
		expect(isKnownBudget(got.source)).toBe(false);
		expect(describeBudgetSource(got)).toMatch(
			/^unknown: several governors with different budgets, as of \d{4}-/,
		);
		expect(readEffectiveBudget(vaultDir)).toMatchObject({ state: "several", governors: 2 });
		await a.destroy();
		await b.destroy();
	});

	it("one of them destroyed: the record is the remaining governor's budget", async () => {
		const a = await createGovernor({ dryRun: true, vaultBase: base, budget: 3_000 });
		await appendOnce(a);
		const b = await createGovernor({ dryRun: true, vaultBase: base, budget: 5_000 });
		await a.destroy();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 5_000, source: "governor" });
		await b.destroy();
		// the last one's destroy leaves the record as it was, read "as of" its writtenAt
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 5_000, source: "governor" });
	});

	it("trust() clients join the same aggregation", async () => {
		const a = await trust(chatClient(), { dryRun: true, vaultBase: base, budget: 3_000 });
		await callOnce(a);
		const b = await trust(chatClient(), { dryRun: true, vaultBase: base, budget: 4_000 });
		expect(loadBudgetConfig(vaultDir).source).toBe("several");
		await b.destroy();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 3_000, source: "governor" });
		await a.destroy();
	});

	it("red-first (separate registries): one vault reached through a SYMLINK alias is one registry", async () => {
		const alias = join(tmpdir(), `effective-budget-alias-${randomUUID()}`);
		symlinkSync(base, alias);
		try {
			const a = await createGovernor({ dryRun: true, vaultBase: base, budget: 3_000 });
			await appendOnce(a);
			const b = await createGovernor({ dryRun: true, vaultBase: alias, budget: 5_000 });
			expect(loadBudgetConfig(vaultDir).source).toBe("several");
			await a.destroy();
			expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 5_000, source: "governor" });
			await b.destroy();
		} finally {
			unlinkSync(alias);
		}
	});

	it("a record of several with fewer than two governors is not one: unreadable, unknown", () => {
		writeFileSync(
			join(vaultDir, EFFECTIVE_BUDGET_FILE),
			JSON.stringify({ budget: null, governors: 1, writtenAt: "2026-10-12T00:00:00.000Z" }),
		);
		expect(readEffectiveBudget(vaultDir).state).toBe("unreadable");
	});
});

// Cross-process (the maintainers' ruling on the review): a governor takes the vault's writer lock LAZILY, at its
// first append, so two processes can each hold a registry. The record is published only while THIS process holds
// the lock: before the first successful append nothing is published, and a process that never gets the lock never
// overwrites the holder's record.
describe("the record is published only under the vault's writer lock", () => {
	it("red-first (published at construction): a governor that has not appended publishes nothing", async () => {
		const gov = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_234 });
		expect(readEffectiveBudget(vaultDir)).toEqual({ state: "absent" });
		expect(loadBudgetConfig(vaultDir).source).toBe("unpublished");
		await gov.destroy();
		expect(readEffectiveBudget(vaultDir)).toEqual({ state: "absent" });
	});

	it("its first successful append publishes", async () => {
		const gov = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_234 });
		await appendOnce(gov);
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
		await gov.destroy();
	});

	it("red-first (the second process's budget): a registry whose process does not hold the lock never publishes", async () => {
		// This process holds the lock: its governor's append took it, and its record says 3,000.
		const holder = await createGovernor({ dryRun: true, vaultBase: base, budget: 3_000 });
		await appendOnce(holder);
		const published = readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE));
		// A second process: its own registry (a fresh module instance) and its own writer, whose append fails on the
		// held lock, so its lock owner is none.
		vi.resetModules();
		const other = await import("../../src/budget/effective-record.js");
		const otherWriter = createAuditWriter(base);
		await expect(
			otherWriter.appendEvent({ kind: "llm_call", actor: "local", data: {} }),
		).rejects.toBeInstanceOf(AuditWriterLockHeldError);
		expect(otherWriter.lockOwner?.()).toBeUndefined();
		const reg = other.registerEnforcedBudget(vaultDir, 5_000, () => otherWriter.lockOwner?.());
		reg.appended();
		expect(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).equals(published)).toBe(true);
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 3_000, source: "governor" });
		reg.release();
		otherWriter.release();
		await holder.destroy();
	});

	it("red-first (stale): a lock released and taken again by a new writer republishes over another's record", async () => {
		const a = await createGovernor({ dryRun: true, vaultBase: base, budget: 3_000 });
		await appendOnce(a);
		// Registered while the lock is held: published with the rest at once (they agree).
		const b = await createGovernor({ dryRun: true, vaultBase: base, budget: 3_000 });
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 3_000, source: "governor" });
		// The lock's last handle leaves; b never appended, so nothing in this process holds the lock now.
		await a.destroy();
		// Another process takes the lock and publishes its own budget.
		recordEffectiveBudget(vaultDir, 9_999);
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 9_999 });
		// b's first append takes the lock with a NEW writer: the record is published under it again.
		await appendOnce(b);
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 3_000, source: "governor" });
		await b.destroy();
	});

	it("a handle's lock owner is the vault's shared writer, and none before its first append", async () => {
		const h = openSharedAuditWriter(base);
		expect(h.lockOwner?.()).toBeUndefined();
		await h.appendEvent({ kind: "llm_call", actor: "local", data: {} });
		expect(h.lockOwner?.()).toMatch(/^[0-9a-f-]{36}$/);
		h.release();
		expect(h.lockOwner?.()).toBeUndefined();
	});
});

// The failure path's own warning must not fail the governor (rule (b) of the review's stop rule): stderr can fail where
// the record did. With the lock held, a second governor's start and the first's destroy both publish.
describe("the record's warning is best-effort too", () => {
	/** Make every publish fail: a non-empty DIRECTORY at the record's path refuses the rename and the removal. */
	function blockTheRecord(): void {
		rmSync(join(vaultDir, EFFECTIVE_BUDGET_FILE), { force: true });
		mkdirSync(join(vaultDir, EFFECTIVE_BUDGET_FILE));
		writeFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE, "x"), "x");
	}

	it("red-first (rejected the start): the record write AND stderr both fail; a governor still starts and tears down", async () => {
		const a = await createGovernor({ dryRun: true, vaultBase: base, budget: 3_000 });
		await appendOnce(a);
		blockTheRecord();
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => {
			throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
		});
		// Registered while the lock is held: it publishes at once, and that publish fails.
		const b = await createGovernor({ dryRun: true, vaultBase: base, budget: 5_000 });
		await appendOnce(b);
		// The destroy republishes for the rest (it fails too) and then runs every teardown step.
		await expect(b.destroy()).resolves.toBeUndefined();
		await expect(appendOnce(b)).rejects.toThrow(/destroyed/);
		expect(write).toHaveBeenCalled();
		write.mockRestore();
		await a.destroy();
	});

	it("red-first (uncaught): a stream 'error' from the warning's write is contained", async () => {
		const baseline = process.stderr.listenerCount("error");
		const a = await createGovernor({ dryRun: true, vaultBase: base, budget: 3_000 });
		await appendOnce(a);
		blockTheRecord();
		const write = vi.spyOn(process.stderr, "write").mockImplementation(((
			_chunk: unknown,
			cb?: (err?: Error) => void,
		) => {
			const err = Object.assign(new Error("ENOSPC: no space left on device, write"), {
				code: "ENOSPC",
			});
			// As a failed stream write does: the callback with the error, then 'error' on the stream.
			process.nextTick(() => {
				cb?.(err);
				process.stderr.emit("error", err);
			});
			return false;
		}) as typeof process.stderr.write);
		const b = await createGovernor({ dryRun: true, vaultBase: base, budget: 5_000 });
		await new Promise((r) => setImmediate(r));
		await expect(b.destroy()).resolves.toBeUndefined();
		await new Promise((r) => setImmediate(r));
		write.mockRestore();
		// Every listener the warnings held is gone once their writes have reported.
		await new Promise((r) => setImmediate(r));
		expect(process.stderr.listenerCount("error")).toBe(baseline);
		await a.destroy();
	});
});
