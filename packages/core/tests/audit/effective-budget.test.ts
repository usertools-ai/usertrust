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
	renameSync,
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
import {
	recordEffectiveBudget,
	registerEnforcedBudget,
} from "../../src/budget/effective-record.js";
import { type TrustEngine, trust } from "../../src/govern.js";
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

/** One governed call. A governor replaces an existing record only once this process holds the vault's writer lock: from
 *  its first successful append. */
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
// first append, so two processes can each hold a registry. A record is REPLACED only while THIS process holds the
// lock, so a process that never gets the lock never overwrites the holder's record. Before its first append a governor
// publishes only where no record stands: a vault that has none (a new one, or one only a release without the record
// wrote) read "not yet published" until the first governed call, however long the governor had been running.
describe("the record is replaced only under the vault's writer lock", () => {
	it("red-first (not yet published until a call): a governor that has not appended publishes on a vault with no record", async () => {
		expect(readEffectiveBudget(vaultDir)).toEqual({ state: "absent" });
		const gov = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_234 });
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
		expect(rawRecord().pid).toBe(process.pid);
		// Owner-only, like every record, and nothing staged is left behind.
		expect(statSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).mode & 0o777).toBe(0o600);
		expect(readdirSync(vaultDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		// Its destroy, with no call, leaves the record as it was: read "as of" its writtenAt, as any last governor's.
		const published = readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE));
		await gov.destroy();
		expect(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).equals(published)).toBe(true);
	});

	it("trust(): a client that has not called publishes on a vault with no record", async () => {
		const g = await trust(chatClient(), { dryRun: true, vaultBase: base, budget: 1_234 });
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
		await g.destroy();
	});

	it("red-first (published over the holder's): a governor that has not appended never replaces another writer's record", async () => {
		const OLD = "2026-01-02T03:04:05.000Z";
		writeFileSync(
			join(vaultDir, EFFECTIVE_BUDGET_FILE),
			JSON.stringify({ budget: 9_000, writtenAt: OLD, pid: 1, processStartedAt: OLD }),
		);
		const before = readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE));
		const gov = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_234 });
		expect(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).equals(before)).toBe(true);
		// Its first append takes the lock: now it replaces it.
		await appendOnce(gov);
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
		await gov.destroy();
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

// Before its first append a governor publishes WITHOUT the lock, so the publish must never take the place of another
// writer's record: it fills an empty slot, or replaces this process's own unheld record (the live set changed), and
// nothing else. `lockOwner` reads none throughout, as for every governor that has not appended.
describe("a publish without the lock", () => {
	const none = (): undefined => undefined;
	const stagingFiles = (): string[] => readdirSync(vaultDir).filter((f) => f.endsWith(".tmp"));

	it("red-first (one of two): two governors in this process that disagree read as several, and the rest after one leaves", () => {
		const a = registerEnforcedBudget(vaultDir, 2_000, none);
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 2_000, source: "governor" });
		const b = registerEnforcedBudget(vaultDir, 5_000, none);
		expect(readEffectiveBudget(vaultDir)).toMatchObject({ state: "several", governors: 2 });
		b.release();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 2_000, source: "governor" });
		a.release();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 2_000, source: "governor" });
		expect(stagingFiles()).toEqual([]);
	});

	it("a later governor in this process replaces this process's own unheld record, after the last one left", () => {
		registerEnforcedBudget(vaultDir, 2_000, none).release();
		const b = registerEnforcedBudget(vaultDir, 5_000, none);
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 5_000, source: "governor" });
		b.release();
	});

	it("red-first (published over the holder's): once another writer replaced it, nothing published here without the lock replaces that", () => {
		const a = registerEnforcedBudget(vaultDir, 2_000, none);
		// The lock holder, in another process, publishes its own.
		recordEffectiveBudget(vaultDir, 9_999);
		const holders = readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE));
		const b = registerEnforcedBudget(vaultDir, 5_000, none);
		expect(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).equals(holders)).toBe(true);
		b.release();
		expect(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).equals(holders)).toBe(true);
		a.release();
	});

	it.each([
		["linked back", {}],
		[
			"renamed back where it cannot be linked",
			{
				link: (): void => {
					throw Object.assign(new Error("EPERM: operation not permitted, link"), {
						code: "EPERM",
					});
				},
			},
		],
	] as const)(
		"red-first (lost the holder's): a record that replaced this process's own between the check and the move is %s",
		(_how, linkSeam) => {
			const a = registerEnforcedBudget(vaultDir, 2_000, none);
			const target = join(vaultDir, EFFECTIVE_BUDGET_FILE);
			let holders: Buffer | undefined;
			// The holder publishes in the instant between this process reading its own record and moving it aside.
			const racingRename = (from: string, to: string): void => {
				if (from === target && holders === undefined) {
					recordEffectiveBudget(vaultDir, 9_999);
					holders = readFileSync(target);
				}
				renameSync(from, to);
			};
			const b = registerEnforcedBudget(vaultDir, 5_000, none, {
				...linkSeam,
				rename: racingRename,
			});
			expect(holders).toBeDefined();
			expect(readFileSync(target).equals(holders as Buffer)).toBe(true);
			expect(stagingFiles()).toEqual([]);
			b.release();
			a.release();
		},
	);

	it("a failed publish without the lock says nothing and leaves no figure that is not the live set's", () => {
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const refuse = (): void => {
			throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
		};
		// No record: still none, so readers stay at "not yet published", as before this publish existed.
		const a = registerEnforcedBudget(vaultDir, 2_000, none, { link: refuse });
		expect(readEffectiveBudget(vaultDir)).toEqual({ state: "absent" });
		a.release();
		// This process's own record, about to describe the wrong live set: removed, never left as the figure.
		const c = registerEnforcedBudget(vaultDir, 2_000, none);
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 2_000, source: "governor" });
		const d = registerEnforcedBudget(vaultDir, 5_000, none, { link: refuse });
		expect(readEffectiveBudget(vaultDir)).toEqual({ state: "absent" });
		expect(stagingFiles()).toEqual([]);
		expect(err).not.toHaveBeenCalled();
		d.release();
		c.release();
	});

	it("something at the record's path that is not a regular file is left alone", () => {
		mkdirSync(join(vaultDir, EFFECTIVE_BUDGET_FILE));
		const a = registerEnforcedBudget(vaultDir, 2_000, none);
		expect(statSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).isDirectory()).toBe(true);
		expect(stagingFiles()).toEqual([]);
		a.release();
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

/** A gate the test opens; every call parked on it waits until then. */
function gate(): { wait: Promise<void>; open: () => void } {
	let open = (): void => {};
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { wait, open };
}

/** A ledger engine whose POST waits on `post`: a settle is in flight until the test opens it. */
function parkedPostEngine(post: Promise<void>): TrustEngine {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {
			await post;
		}),
		voidPendingSpend: vi.fn(async () => {}),
		voidAllPending: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

/** A chat client whose one call waits on `wait`: the call is in flight until the test opens it. */
function parkedChatClient(wait: Promise<void>) {
	const client = chatClient();
	const done = client.chat.completions.create.getMockImplementation();
	client.chat.completions.create.mockImplementation(async (...args: unknown[]) => {
		await wait;
		return done?.(...args);
	});
	return client;
}

/** The record on disk, raw: who wrote it. */
function rawRecord(): { budget: unknown; pid: unknown } {
	return JSON.parse(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE), "utf-8")) as {
		budget: unknown;
		pid: unknown;
	};
}

// A publish that failed was counted as published: `publishedUnder` was set whatever the write did, so every later
// append under the same lock owner skipped the record, and readers stayed on "not yet published" for the life of
// that writer. A failed write is now retried at the next append; it warns once per lock owner until one succeeds.
describe("a failed publish is retried under the same lock owner", () => {
	function failingIo(): { fail: boolean; writes: number; write: (p: string, d: string) => void } {
		const io = {
			fail: true,
			writes: 0,
			write: (p: string, d: string): void => {
				io.writes++;
				if (io.fail) {
					throw Object.assign(new Error("ENOSPC: no space left on device, open"), {
						code: "ENOSPC",
					});
				}
				writeFileSync(p, d, { mode: 0o600, flag: "wx" });
			},
		};
		return io;
	}

	it("red-first (never retried): the first publish's write fails; a later append under the same owner publishes", () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const io = failingIo();
		// Registered while the lock is held: it publishes at once, and that write fails.
		const reg = registerEnforcedBudget(vaultDir, 2_000, () => "owner-1", { write: io.write });
		expect(io.writes).toBe(1);
		expect(readEffectiveBudget(vaultDir)).toEqual({ state: "absent" });
		expect(loadBudgetConfig(vaultDir).source).toBe("unpublished");
		// The filesystem recovers; the next append under the SAME owner publishes.
		io.fail = false;
		reg.appended();
		expect(io.writes).toBe(2);
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 2_000, source: "governor" });
		// Published now: a later append under the same owner writes nothing more.
		reg.appended();
		expect(io.writes).toBe(2);
		reg.release();
	});

	it("red-first (never retried): a publish that fails AFTER a success under the same owner is retried too", () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const io = failingIo();
		io.fail = false;
		const a = registerEnforcedBudget(vaultDir, 2_000, () => "owner-1", { write: io.write });
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 2_000, source: "governor" });
		// A second governor starts while the lock is held; its publish fails and removes a's record, which alone would
		// misstate what is enforced.
		io.fail = true;
		const b = registerEnforcedBudget(vaultDir, 5_000, () => "owner-1", { write: io.write });
		expect(readEffectiveBudget(vaultDir)).toEqual({ state: "absent" });
		io.fail = false;
		a.appended();
		expect(readEffectiveBudget(vaultDir)).toMatchObject({ state: "several", governors: 2 });
		b.release();
		a.release();
	});

	it("a write that keeps failing is retried at every append, and warns once per lock owner until one succeeds", () => {
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const warnings = (): number =>
			err.mock.calls.filter((c) => String(c[0]).includes("could not record the enforced budget"))
				.length;
		const io = failingIo();
		let owner = "owner-1";
		const reg = registerEnforcedBudget(vaultDir, 2_000, () => owner, { write: io.write });
		for (let i = 0; i < 5; i++) reg.appended();
		expect(io.writes).toBe(6);
		expect(warnings()).toBe(1);
		// A new writer takes the lock: its first failure is reported too.
		owner = "owner-2";
		reg.appended();
		reg.appended();
		expect(warnings()).toBe(2);
		// A success ends the streak: the next failure under the SAME writer (a second governor registering, whose
		// publish fails) warns again, exactly once.
		io.fail = false;
		reg.appended();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 2_000, source: "governor" });
		io.fail = true;
		const second = registerEnforcedBudget(vaultDir, 2_000, () => owner, { write: io.write });
		expect(warnings()).toBe(3);
		reg.appended();
		second.appended();
		expect(warnings()).toBe(3);
		// And a failure under a new writer warns too.
		owner = "owner-3";
		reg.appended();
		expect(warnings()).toBe(4);
		second.release();
		reg.release();
	});

	it("red-first (never retried): through createGovernor, a write that failed once is published by the next call", async () => {
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const gov = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_234 });
		// A non-empty directory at the record's path (in place of the one its start published) refuses the rename and
		// the removal.
		rmSync(join(vaultDir, EFFECTIVE_BUDGET_FILE), { force: true });
		mkdirSync(join(vaultDir, EFFECTIVE_BUDGET_FILE));
		writeFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE, "x"), "x");
		await appendOnce(gov);
		expect(err.mock.calls.map((c) => String(c[0])).join("")).toMatch(
			/could not record the enforced budget/,
		);
		rmSync(join(vaultDir, EFFECTIVE_BUDGET_FILE), { recursive: true });
		await appendOnce(gov);
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
		await gov.destroy();
	});
});

// destroy() released the governor's registration FIRST, then drained its in-flight calls. A governor that had not yet
// appended published nothing at release, and a call that settled during the drain appended (taking the vault's lock)
// to a registration already released, so the record was never published: readers stayed on "not yet published", or
// on an earlier process's record. The registration is now released after the drain and its records.
describe("destroy() and the record", () => {
	const OLD = "2026-01-02T03:04:05.000Z";
	function writeOldRecord(): Buffer {
		const body = JSON.stringify({ budget: 2_000, writtenAt: OLD, pid: 1, processStartedAt: OLD });
		writeFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE), body);
		return readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE));
	}

	it("red-first (released first): createGovernor, a settle in flight lands during the drain; the record is this process's", async () => {
		const post = gate();
		const engine = parkedPostEngine(post.wait);
		// Another writer's record stands, so only an append (the lock) replaces it.
		const before = writeOldRecord();
		const gov = await createGovernor({ vaultBase: base, budget: 1_234, _engine: engine });
		const auth = await gov.authorize({
			model: "claude-haiku-5-5",
			estimatedInputTokens: 10,
			maxOutputTokens: 1,
		});
		const settling = gov.settle(auth, { inputTokens: 1, outputTokens: 1 });
		await vi.waitFor(() => expect(engine.postPendingSpend).toHaveBeenCalled());
		// Nothing has appended yet: the other writer's record is untouched.
		expect(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).equals(before)).toBe(true);
		const destroying = gov.destroy();
		post.open();
		await settling;
		await destroying;
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
		expect(rawRecord().pid).toBe(process.pid);
	});

	it("red-first (released first): trust(), a call in flight lands during the drain; the record is this process's", async () => {
		const call = gate();
		const client = parkedChatClient(call.wait);
		const before = writeOldRecord();
		const g = await trust(client, { dryRun: true, vaultBase: base, budget: 1_234 });
		const calling = callOnce(g);
		await vi.waitFor(() => expect(client.chat.completions.create).toHaveBeenCalled());
		expect(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).equals(before)).toBe(true);
		const destroying = g.destroy();
		call.open();
		await calling;
		await destroying;
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
		expect(rawRecord().pid).toBe(process.pid);
	});

	it("red-first (released first): createGovernor, a hold destroy() records is its first append; the record is published", async () => {
		const before = writeOldRecord();
		const gov = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_234 });
		await gov.authorize({
			model: "claude-haiku-5-5",
			estimatedInputTokens: 10,
			maxOutputTokens: 1,
		});
		expect(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).equals(before)).toBe(true);
		// destroy() ends the hold and records it (`hold_released`): this governor's first append.
		await gov.destroy();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
		expect(rawRecord().pid).toBe(process.pid);
	});

	it.each(["createGovernor", "trust"] as const)(
		"%s: a destroy with no call and no append publishes nothing; an older record is left as is, shown with its age",
		async (ctor) => {
			const before = writeOldRecord();
			if (ctor === "createGovernor") {
				const gov = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_234 });
				await gov.destroy();
			} else {
				const g = await trust(chatClient(), { dryRun: true, vaultBase: base, budget: 1_234 });
				await g.destroy();
			}
			expect(readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE)).equals(before)).toBe(true);
			const got = loadBudgetConfig(vaultDir);
			expect(got).toEqual({ budget: 2_000, source: "governor", writtenAt: OLD, reason: null });
			expect(describeBudgetSource(got)).toBe(`the enforced budget, as of ${OLD}`);
		},
	);

	it("createGovernor: a drain whose deadline expires still releases; the record is the remaining governor's", async () => {
		const a = await createGovernor({ dryRun: true, vaultBase: base, budget: 3_000 });
		await appendOnce(a);
		const post = gate();
		const b = await createGovernor({
			vaultBase: base,
			budget: 5_000,
			_engine: parkedPostEngine(post.wait),
			_destroyDrainMs: 300,
		});
		expect(loadBudgetConfig(vaultDir).source).toBe("several");
		const auth = await b.authorize({
			model: "claude-haiku-5-5",
			estimatedInputTokens: 10,
			maxOutputTokens: 1,
		});
		const settling = b.settle(auth, { inputTokens: 1, outputTokens: 1 }).catch(() => {});
		await expect(b.destroy()).resolves.toBeUndefined();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 3_000, source: "governor" });
		post.open();
		await settling;
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 3_000, source: "governor" });
		await a.destroy();
	});

	it("trust(): a drain whose deadline expires still releases; the record is the remaining governor's", {
		timeout: 20_000,
	}, async () => {
		const a = await trust(chatClient(), { dryRun: true, vaultBase: base, budget: 3_000 });
		await callOnce(a);
		const call = gate();
		const client = parkedChatClient(call.wait);
		const b = await trust(client, { dryRun: true, vaultBase: base, budget: 5_000 });
		expect(loadBudgetConfig(vaultDir).source).toBe("several");
		const calling = callOnce(b).catch(() => {});
		await vi.waitFor(() => expect(client.chat.completions.create).toHaveBeenCalled());
		await expect(b.destroy()).resolves.toBeUndefined();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 3_000, source: "governor" });
		call.open();
		await calling;
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 3_000, source: "governor" });
		await a.destroy();
	});
});

describe("the record's warning is scrubbed for the terminal", () => {
	it("red-first (raw): a vault path and an error carrying ESC and a C1 CSI print neither", () => {
		const ESC = String.fromCharCode(0x1b);
		const CSI = String.fromCharCode(0x9b);
		const dir = join(base, `vault${ESC}[2J${CSI}31m`);
		mkdirSync(dir, { recursive: true });
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		recordEffectiveBudget(dir, 1_000, {
			write: (path) => {
				throw new Error(`EIO: i/o error, open '${path}'${ESC}]0;title${CSI}`);
			},
		});
		const said = err.mock.calls.map((c) => String(c[0])).join("");
		expect(said).toMatch(/could not record the enforced budget/);
		expect(said).not.toContain(ESC);
		expect(said).not.toContain(CSI);
		expect(said).toContain("vault?[2J?31m");
	});
});
