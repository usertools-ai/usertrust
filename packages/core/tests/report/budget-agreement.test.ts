// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The report and the governor must agree on ONE state. A budget is a wallet of units, and a local (nominal) call debits it
 * at the 1-unit floor: 100 such calls exhaust a 100-unit budget. The report reads 100% used, and the governor refuses the
 * next call. A report that counted dollars only would say 0% used over a wallet enforcement already considers empty.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run } from "../../src/cli/report.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

describe("report and governor agree on an exhausted budget of nominal units", () => {
	let dir: string;
	let stdout: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trust-budget-agree-"));
		mkdirSync(join(dir, VAULT_DIR), { recursive: true });
		process.env.USERTRUST_TEST = "1";
		stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		process.exitCode = undefined;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		process.env.USERTRUST_TEST = "";
		rmSync(dir, { recursive: true, force: true });
	});

	it("100 nominal calls on a 100-unit budget: the report reads 100% used and the governor refuses the next call", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100,
			vaultBase: dir,
			endpoint: { class: "local", runtime: "ollama" },
		});
		for (let i = 0; i < 100; i++) {
			const auth = await gov.authorize({ model: "qwen2.5:7b" });
			await gov.settle(auth, { inputTokens: 10, outputTokens: 10, usageSource: "provider" });
		}
		// enforcement: the wallet is empty
		await expect(gov.authorize({ model: "qwen2.5:7b" })).rejects.toThrow();
		await gov.destroy();

		const end = new Date(Date.now() + 3_600_000).toISOString();
		await run(dir, {}, ["--week", "--end", end, "--budget", "100", "--format", "json"]);
		const out = JSON.parse(stdout) as {
			budget: {
				usedFraction: number;
				overBudget: boolean;
				recordedSessionUt: number;
				recordedSessionNominal: number;
				recordedSessionWallet: number;
			};
			totals: { confirmedUt: number; nominalUt: number };
		};
		expect(out.budget.recordedSessionNominal).toBe(100);
		expect(out.budget.recordedSessionUt).toBe(0); // none of it is dollars
		expect(out.budget.recordedSessionWallet).toBe(100);
		expect(out.budget.usedFraction).toBe(1); // report and enforcement agree on one state
		expect(out.totals.confirmedUt).toBe(0);
		expect(out.totals.nominalUt).toBe(100);
	}, 60_000);
});

describe("report utilization == the governor's own counter, scenario by scenario (real governors)", () => {
	let dir: string;
	let stdout: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trust-budget-mirror-"));
		mkdirSync(join(dir, VAULT_DIR), { recursive: true });
		process.env.USERTRUST_TEST = "1";
		stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		process.exitCode = undefined;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		process.env.USERTRUST_TEST = "";
		rmSync(dir, { recursive: true, force: true });
	});

	const AUTH = { model: "claude-sonnet-4-6", estimatedInputTokens: 100, maxOutputTokens: 50 };

	/** A capped engine like the real one: a post above the hold is truncated and the gap comes back as shortfall. */
	function engine(opts: { postFails?: boolean } = {}): TrustEngine {
		const holds = new Map<string, number>();
		return {
			spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
				holds.set(p.transferId, p.amount);
				return { transferId: p.transferId };
			}),
			postPendingSpend: vi.fn(async (transferId: string, actual?: number) => {
				if (opts.postFails) throw new Error("tb unreachable");
				const held = holds.get(transferId) ?? 0;
				const want = actual ?? held;
				const posted = Math.min(want, held);
				return { posted, shortfall: want - posted };
			}),
			voidPendingSpend: vi.fn(async () => {}),
			destroy: vi.fn(),
		} satisfies TrustEngine;
	}

	async function reportWallet(): Promise<number> {
		const end = new Date(Date.now() + 3_600_000).toISOString();
		stdout = "";
		await run(dir, {}, ["--week", "--end", end, "--budget", "1000000000", "--format", "json"]);
		const out = JSON.parse(stdout) as { budget: { recordedSessionWallet: number } };
		return out.budget.recordedSessionWallet;
	}

	const SETTLE = { inputTokens: 4000, outputTokens: 900, usageSource: "provider" as const };

	it("an AMBIGUOUS POST: the governor counted the call, so does the report", async () => {
		const gov = await createGovernor({
			budget: 1_000_000_000,
			vaultBase: dir,
			_engine: engine({ postFails: true }),
		});
		const auth = await gov.authorize(AUTH);
		await gov.settle(auth, SETTLE);
		const spent = 1_000_000_000 - gov.budgetRemaining();
		await gov.destroy();
		expect(spent).toBeGreaterThan(0);
		expect(await reportWallet()).toBe(spent);
	});

	it("an ORPHAN shortfall (the llm_call append failed, the capped POST succeeded): the shortfall's actual is counted", async () => {
		const real = createAuditWriter(dir);
		const flaky = {
			...real,
			appendEvent: (i: Parameters<typeof real.appendEvent>[0]) =>
				i.kind === "llm_call" ? Promise.reject(new Error("disk full")) : real.appendEvent(i),
		};
		const gov = await createGovernor({
			budget: 1_000_000_000,
			vaultBase: dir,
			_engine: engine(),
			_audit: flaky as typeof real,
		});
		const auth = await gov.authorize(AUTH);
		await gov.settle(auth, SETTLE);
		const spent = 1_000_000_000 - gov.budgetRemaining();
		await gov.destroy();
		real.release();
		expect(spent).toBeGreaterThan(0);
		expect(await reportWallet()).toBe(spent);
	});

	it("a VOIDED call (abort) and a RELEASED hold: the governor counted nothing, so does the report", async () => {
		const gov = await createGovernor({ budget: 1_000_000_000, vaultBase: dir, _engine: engine() });
		const a = await gov.authorize(AUTH);
		await gov.abort(a);
		const b = await gov.authorize(AUTH);
		await gov.release(b, "unused");
		const spent = 1_000_000_000 - gov.budgetRemaining();
		await gov.destroy();
		expect(spent).toBe(0);
		expect(await reportWallet()).toBe(0);
	});

	it("a plain settled call, for the control", async () => {
		const gov = await createGovernor({ budget: 1_000_000_000, vaultBase: dir, _engine: engine() });
		const auth = await gov.authorize(AUTH);
		await gov.settle(auth, { inputTokens: 10, outputTokens: 5, usageSource: "provider" });
		const spent = 1_000_000_000 - gov.budgetRemaining();
		await gov.destroy();
		expect(spent).toBeGreaterThan(0);
		expect(await reportWallet()).toBe(spent);
	});
});

describe("the interval brackets the governor's counter (real governors), and a tampered counter is flagged", () => {
	let dir: string;
	let stdout: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trust-budget-interval-"));
		mkdirSync(join(dir, VAULT_DIR), { recursive: true });
		process.env.USERTRUST_TEST = "1";
		stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		process.exitCode = undefined;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		process.env.USERTRUST_TEST = "";
		rmSync(dir, { recursive: true, force: true });
	});

	const engine = (opts: { postFails?: boolean } = {}): TrustEngine => ({
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => ({
			transferId: p.transferId,
		})),
		postPendingSpend: vi.fn(async (_id: string, actual?: number) => {
			if (opts.postFails) throw new Error("tb unreachable");
			return { posted: actual ?? 0, shortfall: 0 };
		}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	});

	async function report() {
		const end = new Date(Date.now() + 3_600_000).toISOString();
		stdout = "";
		await run(dir, {}, ["--week", "--end", end, "--budget", "1000000000", "--format", "json"]);
		return JSON.parse(stdout) as {
			budget: {
				recordedSessionWallet: number;
				recordedSessionUncertain: number;
				recordedAttributedWallet: number;
				recordedAttributedUncertain: number;
			};
			spendLedger: { recorded: number | null; differs: boolean };
		};
	}
	const counter = () =>
		(
			JSON.parse(readFileSync(join(dir, VAULT_DIR, "spend-ledger.json"), "utf-8")) as {
				budgetSpent: number;
			}
		).budgetSpent;
	const bracket = (r: Awaited<ReturnType<typeof report>>) => {
		const lower = r.budget.recordedSessionWallet;
		const upper =
			lower +
			r.budget.recordedSessionUncertain +
			r.budget.recordedAttributedWallet +
			r.budget.recordedAttributedUncertain;
		return { lower, upper };
	};

	it("a STANDALONE ambiguity (the llm_call append failed after the POST was attempted): the governor counted it; the report's definite figure includes it", async () => {
		const real = createAuditWriter(dir);
		const flaky = {
			...real,
			appendEvent: (i: Parameters<typeof real.appendEvent>[0]) =>
				i.kind === "llm_call" ? Promise.reject(new Error("disk full")) : real.appendEvent(i),
		};
		const gov = await createGovernor({
			budget: 1_000_000_000,
			vaultBase: dir,
			_engine: engine({ postFails: true }),
			_audit: flaky as typeof real,
		});
		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 50,
		});
		await gov.settle(auth, { inputTokens: 4000, outputTokens: 900, usageSource: "provider" });
		await gov.destroy();
		real.release();
		const r = await report();
		const { lower, upper } = bracket(r);
		expect(counter()).toBeGreaterThan(0);
		expect(lower).toBeLessThanOrEqual(counter());
		expect(counter()).toBeLessThanOrEqual(upper);
		expect(lower).toBe(counter()); // the ambiguity is positive evidence: it is DEFINITE
		expect(r.spendLedger.differs).toBe(false);
	});

	it("a failClosed PRE-COMMIT void (the llm_call append failed under failClosed): the counter never moved, and the counter is inside the interval", async () => {
		writeFileSync(
			join(dir, VAULT_DIR, "usertrust.config.json"),
			JSON.stringify({ budget: 1_000_000_000, audit: { failClosed: true } }),
		);
		const real = createAuditWriter(dir);
		const flaky = {
			...real,
			appendEvent: (i: Parameters<typeof real.appendEvent>[0]) =>
				i.kind === "llm_call" ? Promise.reject(new Error("disk full")) : real.appendEvent(i),
		};
		const client = {
			messages: {
				create: vi.fn(async (_req: unknown) => ({
					id: "m",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 4000, output_tokens: 900 },
				})),
			},
		};
		const g = await trust(client, {
			vaultBase: dir,
			_engine: engine(),
			_audit: flaky as typeof real,
		});
		await expect(
			g.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "hello" }],
			}),
		).rejects.toThrow();
		await g.destroy();
		real.release();
		const r = await report();
		const { lower, upper } = bracket(r);
		const c = existsSync(join(dir, VAULT_DIR, "spend-ledger.json")) ? counter() : 0;
		expect(c).toBe(0);
		expect(lower).toBeLessThanOrEqual(c);
		expect(c).toBeLessThanOrEqual(upper);
	});

	it("a TAMPERED counter outside the interval is flagged; one inside is silent", async () => {
		const gov = await createGovernor({ budget: 1_000_000_000, vaultBase: dir, _engine: engine() });
		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 50,
		});
		await gov.settle(auth, { inputTokens: 40, outputTokens: 9, usageSource: "provider" });
		await gov.destroy();
		const honest = await report();
		expect(honest.spendLedger.differs).toBe(false);
		const real = counter();
		for (const bad of [real + 1000, Math.max(0, real - 1) === real ? real + 1 : real - 1]) {
			writeFileSync(
				join(dir, VAULT_DIR, "spend-ledger.json"),
				JSON.stringify({ budgetSpent: bad }),
			);
			const r = await report();
			expect(r.spendLedger.differs, String(bad)).toBe(true);
		}
	});
});
