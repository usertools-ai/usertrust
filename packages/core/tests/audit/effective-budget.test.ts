// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The budget a governor ENFORCES reaches its vault's readers.
 *
 * A server tenant's budget (`opts.budget`), an SDK caller's `trust(client, { budget })`, a config file outside the
 * vault, and the built-in default all used to read as 0 from the vault ("no budget set", and a negative remaining),
 * because every reader looked only at the vault's own `usertrust.config.json`.
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
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

import { EFFECTIVE_BUDGET_FILE, readEffectiveBudget } from "../../src/audit/effective-budget.js";
import { describeBudgetSource, loadBudgetConfig } from "../../src/audit/read.js";
import { recordEffectiveBudget } from "../../src/budget/effective-record.js";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
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

	it("a failed write with no earlier record and no config leaves readers at 'none', not a number", () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		recordEffectiveBudget(vaultDir, 9_000, {
			write: () => {
				throw new Error("EIO");
			},
			remove: (p) => rmSync(p),
		});
		expect(loadBudgetConfig(vaultDir)).toEqual({ budget: 0, source: "none", writtenAt: null });
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
		expect(got).toEqual({ budget: 2_000, source: "governor", writtenAt: OLD });
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
		expect(describeBudgetSource({ source: "none", writtenAt: null })).toBe(
			"unknown: none recorded or configured",
		);
	});
});

describe("loadBudgetConfig: the governor's record, then the vault config, then none", () => {
	it.each([
		["record only", 2_000, null, { budget: 2_000, source: "governor" }],
		["the record wins over the vault config", 2_000, 500, { budget: 2_000, source: "governor" }],
		["no record: the vault config", null, 500, { budget: 500, source: "config", writtenAt: null }],
		[
			"neither: none (UNKNOWN, never a budget of 0)",
			null,
			null,
			{ budget: 0, source: "none", writtenAt: null },
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

	it("an UNREADABLE record is none even with a config present: the file may not be what was enforced", () => {
		writeFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE), "{torn");
		writeConfig(join(vaultDir, "usertrust.config.json"), 500);
		expect(loadBudgetConfig(vaultDir)).toEqual({ budget: 0, source: "none", writtenAt: null });
	});
});

describe("the governor records what it ENFORCES (red-first: every row read the vault config, or 0)", () => {
	const client = () => ({ chat: { completions: { create: vi.fn() } } });

	it.each([
		["createGovernor", "opts.budget, no config file (a server tenant)"],
		["trust", "opts.budget, no config file (an SDK caller)"],
	] as const)("%s: %s → the vault reads that budget", async (ctor, _n) => {
		if (ctor === "createGovernor") {
			const gov = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_234 });
			await gov.destroy();
		} else {
			const g = await trust(client(), { dryRun: true, vaultBase: base, budget: 1_234 });
			await g.destroy();
		}
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
	});

	it("opts.budget overrides the vault config, and the vault reads the override", async () => {
		writeConfig(join(vaultDir, "usertrust.config.json"), 500);
		const gov = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_234 });
		await gov.destroy();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 1_234, source: "governor" });
	});

	it("a config file OUTSIDE the vault (opts.configPath): the vault reads its budget", async () => {
		const outside = join(base, "tenant.config.json");
		writeConfig(outside, 700);
		const gov = await createGovernor({ dryRun: true, vaultBase: base, configPath: outside });
		await gov.destroy();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 700, source: "governor" });
	});

	it("no budget anywhere: the vault reads the built-in default the governor enforces", async () => {
		const gov = await createGovernor({ dryRun: true, vaultBase: base });
		await gov.destroy();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({
			budget: DEFAULT_BUDGET,
			source: "governor",
		});
		expect(existsSync(join(vaultDir, EFFECTIVE_BUDGET_FILE))).toBe(true);
	});

	it("a later start with a different budget replaces the record (the last start wins)", async () => {
		const a = await createGovernor({ dryRun: true, vaultBase: base, budget: 1_000 });
		await a.destroy();
		const b = await createGovernor({ dryRun: true, vaultBase: base, budget: 4_000 });
		await b.destroy();
		expect(loadBudgetConfig(vaultDir)).toMatchObject({ budget: 4_000, source: "governor" });
	});
});
