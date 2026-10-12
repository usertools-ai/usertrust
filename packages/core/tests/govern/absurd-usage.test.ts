// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * One absurd-but-finite usage figure from a provider (or a proxy, or a bug) must not brick a vault.
 *
 * `sanitizeUsage` rejected non-finite and negative counts but had no upper bound, on the reasoning that overstating is
 * fail-safe for MONEY. It is not fail-safe for AVAILABILITY: a single `1e12`-token response priced to 2.77e18 UT in
 * dry-run and 9.22e18 on TigerBeetle, was added to the session counter and persisted to `.usertrust/spend-ledger.json`,
 * and every later call in that vault was refused by the budget rule until someone hand-edited the file. The ledger caps
 * the POSTED amount at the hold, so no money was lost, but the session counter was not clamped.
 *
 * Three rules, each with rows in dry-run and with an engine:
 *  - a count above the plausibility ceiling is not charged: the call settles at the estimate (the same rule as a missing
 *    count), and the anomaly is a chain event, not a silent charge;
 *  - the session counter keeps the METERED cost of a plausible call, even above its hold: the ceiling and the persist
 *    guard are what stop a bad figure, and the shortfall event records the gap to the ledger;
 *  - a value that cannot be represented is never persisted.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { MAX_PLAUSIBLE_TOKENS_PER_TIER } from "../../src/ledger/usage.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";

// tigerbeetle-node is a native module and is never loaded in unit tests.
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
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const PARAMS = {
	model: "claude-sonnet-4-6",
	max_tokens: 64,
	messages: [{ role: "user", content: "hello" }],
};

function client(usage: { input_tokens: number; output_tokens: number }) {
	return {
		messages: {
			create: vi.fn(async (_req: unknown) => ({
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				model: "claude-sonnet-4-6",
				usage,
			})),
		},
	};
}

/** A capped engine, like the real one: the post is `min(actual, hold)` and the truncation comes back as shortfall. */
function cappedEngine() {
	const holds = new Map<string, number>();
	const engine = {
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
			holds.set(p.transferId, p.amount);
			return { transferId: p.transferId };
		}),
		postPendingSpend: vi.fn(async (transferId: string, actual?: number) => {
			const held = holds.get(transferId) ?? 0;
			const want = actual ?? held;
			const posted = Math.min(want, held);
			return { posted, shortfall: want - posted };
		}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	} satisfies TrustEngine;
	return { engine, holds };
}

function makeAudit(): AuditWriter & { events: AppendEventInput[] } {
	const events: AppendEventInput[] = [];
	return {
		events,
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			events.push(input);
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		}),
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

function persistedSpend(vaultBase: string): number {
	return (
		JSON.parse(readFileSync(join(vaultBase, VAULT_DIR, "spend-ledger.json"), "utf-8")) as {
			budgetSpent: number;
		}
	).budgetSpent;
}

describe.each([
	["dry-run", true],
	["with a capped engine", false],
])("absurd provider usage (%s)", (_label, dryRun) => {
	let vaultBase: string;
	beforeEach(() => {
		vaultBase = join(tmpdir(), `absurd-usage-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
	});
	afterEach(() => {
		rmSync(vaultBase, { recursive: true, force: true });
	});

	async function governed(c: ReturnType<typeof client>, audit: ReturnType<typeof makeAudit>) {
		const { engine } = cappedEngine();
		return trust(c, {
			budget: 100_000,
			vaultBase,
			_audit: audit,
			...(dryRun ? { dryRun: true } : { _engine: engine }),
		});
	}

	it("a 1e12-token response is NOT charged: the call settles at the estimate and the vault stays usable", async () => {
		const audit = makeAudit();
		const g = await governed(client({ input_tokens: 1e12, output_tokens: 1e12 }), audit);
		const { receipt } = (await g.messages.create(PARAMS)) as { receipt: TrustReceipt };

		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.cost).toBeLessThan(100_000);
		expect(persistedSpend(vaultBase)).toBeLessThan(100_000);
		expect(persistedSpend(vaultBase)).toBe(receipt.cost);

		// loud: a chain event naming the call, the tiers and the ceiling, not a silent charge
		const event = audit.events.find((e) => e.kind === "usage_implausible");
		expect(event?.data).toMatchObject({
			transferId: receipt.transferId,
			model: PARAMS.model,
			ceilingTokensPerTier: MAX_PLAUSIBLE_TOKENS_PER_TIER,
			charged: "estimate",
			tiers: { inputTokens: 1e12, outputTokens: 1e12 },
		});

		// the next ordinary call is NOT refused by the budget rule
		const ok = (await g.messages.create(PARAMS)) as { receipt: TrustReceipt };
		expect(ok.receipt.settled).toBe(true);
		await g.destroy();
	});

	it("a count exactly AT the ceiling is real usage; one above it is not", async () => {
		const at = makeAudit();
		const gAt = await governed(
			client({ input_tokens: MAX_PLAUSIBLE_TOKENS_PER_TIER, output_tokens: 1 }),
			at,
		);
		const rAt = (await gAt.messages.create(PARAMS)) as { receipt: TrustReceipt };
		expect(rAt.receipt.usageSource).toBe("provider");
		expect(at.events.some((e) => e.kind === "usage_implausible")).toBe(false);
		await gAt.destroy();

		rmSync(vaultBase, { recursive: true, force: true });
		mkdirSync(vaultBase, { recursive: true });
		const over = makeAudit();
		const gOver = await governed(
			client({ input_tokens: MAX_PLAUSIBLE_TOKENS_PER_TIER + 1, output_tokens: 1 }),
			over,
		);
		const rOver = (await gOver.messages.create(PARAMS)) as { receipt: TrustReceipt };
		expect(rOver.receipt.usageSource).toBe("estimated");
		expect(over.events.some((e) => e.kind === "usage_implausible")).toBe(true);
		await gOver.destroy();
	});
});

describe("the session counter keeps the metered cost", () => {
	let vaultBase: string;
	beforeEach(() => {
		vaultBase = join(tmpdir(), `absurd-usage-cap-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
	});
	afterEach(() => {
		rmSync(vaultBase, { recursive: true, force: true });
	});

	it("a plausible but over-hold usage adds the METERED cost to the counter, not the amount the ledger posted", async () => {
		const { engine, holds } = cappedEngine();
		const g = await trust(client({ input_tokens: 5_000_000, output_tokens: 10 }), {
			budget: 100_000_000,
			vaultBase,
			_engine: engine,
			_audit: makeAudit(),
		});
		const { receipt } = (await g.messages.create(PARAMS)) as { receipt: TrustReceipt };
		const hold = [...holds.values()][0] as number;

		expect(receipt.cost).toBeGreaterThan(hold); // the receipt keeps the TRUE metered cost
		expect(receipt.postedCost).toBe(hold);
		expect(persistedSpend(vaultBase)).toBe(receipt.cost); // the budget enforces the metered spend
		await g.destroy();
	});
});

describe("headless governor: the same three rules", () => {
	let vaultBase: string;
	beforeEach(() => {
		vaultBase = join(tmpdir(), `absurd-usage-headless-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
	});
	afterEach(() => {
		rmSync(vaultBase, { recursive: true, force: true });
	});

	const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 100, maxOutputTokens: 50 };

	for (const dryRun of [true, false]) {
		it(`an absurd settle is charged at the estimate, reported AFTER its llm_call, and leaves the vault usable (${dryRun ? "dry-run" : "capped engine"})`, async () => {
			const audit = makeAudit();
			const { engine } = cappedEngine();
			const gov = await createGovernor({
				budget: 100_000,
				vaultBase,
				_audit: audit,
				...(dryRun ? { dryRun: true } : { _engine: engine }),
			});
			const auth = await gov.authorize(AUTHORIZE);
			const receipt = await gov.settle(auth, { inputTokens: 1e12, outputTokens: 1e12 });

			expect(receipt.usageSource).toBe("estimated");
			expect(receipt.cost).toBeLessThan(100_000);
			// the ESTIMATE, not the 1-usertoken floor that zeroed counts would price at
			expect(receipt.cost).toBeGreaterThan(1);
			expect(persistedSpend(vaultBase)).toBeLessThan(100_000);

			const kinds = audit.events.map((e) => e.kind);
			const llm = kinds.indexOf("llm_call");
			const implausible = kinds.indexOf("usage_implausible");
			expect(implausible).toBeGreaterThan(llm); // first event with the transferId must be the llm_call
			expect(audit.events[implausible]?.data).toMatchObject({
				transferId: auth.transferId,
				charged: "estimate",
				tiers: { inputTokens: 1e12, outputTokens: 1e12 },
			});

			// the vault still works
			const again = await gov.authorize(AUTHORIZE);
			await gov.settle(again, { inputTokens: 10, outputTokens: 5 });
			await gov.destroy();
		});
	}

	it("the counter keeps the metered cost when the ledger truncated at the hold", async () => {
		const { engine, holds } = cappedEngine();
		const gov = await createGovernor({
			budget: 100_000_000,
			vaultBase,
			_audit: makeAudit(),
			_engine: engine,
		});
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { inputTokens: 5_000_000, outputTokens: 10 });
		const hold = [...holds.values()][0] as number;
		expect(receipt.cost).toBeGreaterThan(hold);
		expect(persistedSpend(vaultBase)).toBe(receipt.cost);
		await gov.destroy();
	});
});

describe("a value that cannot be represented is never persisted", () => {
	it("the ledger file keeps its last safe value when the cumulative spend would pass the safe-integer range", async () => {
		const vaultBase = join(tmpdir(), `absurd-usage-persist-${randomUUID()}`);
		mkdirSync(join(vaultBase, VAULT_DIR), { recursive: true });
		const seeded = Number.MAX_SAFE_INTEGER - 100_000;
		writeFileSync(
			join(vaultBase, VAULT_DIR, "spend-ledger.json"),
			JSON.stringify({ budgetSpent: seeded, updatedAt: new Date(0).toISOString() }),
		);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const g = await trust(client({ input_tokens: 50_000_000, output_tokens: 1 }), {
				budget: Number.MAX_SAFE_INTEGER,
				vaultBase,
				dryRun: true,
				_audit: makeAudit(),
			});
			await g.messages.create(PARAMS); // a plausible 50M-token reading costs >100,000 UT: the cumulative value passes MAX_SAFE_INTEGER
			expect(persistedSpend(vaultBase)).toBe(seeded);
			expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(
				/refusing to persist session spend/,
			);
			await g.destroy();
		} finally {
			stderr.mockRestore();
			rmSync(vaultBase, { recursive: true, force: true });
		}
	});
});

describe("a STREAMING settle gets the same rule", () => {
	class Stream extends EventEmitter {
		finalMessage(): Promise<unknown> {
			return Promise.resolve({});
		}
		async *[Symbol.asyncIterator](): AsyncIterator<unknown> {}
	}

	for (const dryRun of [true, false]) {
		it(`an absurd final usage is charged at the estimate and reported after its llm_call (${dryRun ? "dry-run" : "capped engine"})`, async () => {
			const vaultBase = join(tmpdir(), `absurd-usage-stream-${randomUUID()}`);
			mkdirSync(vaultBase, { recursive: true });
			try {
				const audit = makeAudit();
				const { engine } = cappedEngine();
				const stream = new Stream();
				const g = await trust(
					{
						messages: {
							create: vi.fn((_req: unknown) => undefined),
							stream: vi.fn((_req: unknown) => stream),
						},
					},
					{
						budget: 100_000,
						vaultBase,
						_audit: audit,
						...(dryRun ? { dryRun: true } : { _engine: engine }),
					},
				);
				const handle = (await g.messages.stream(PARAMS)) as Stream & {
					receipt: Promise<TrustReceipt>;
				};
				stream.emit("finalMessage", { usage: { input_tokens: 1e12, output_tokens: 1e12 } });
				stream.emit("end");
				const receipt = await handle.receipt;

				expect(receipt.usageSource).toBe("estimated");
				expect(receipt.cost).toBeGreaterThan(1);
				expect(receipt.cost).toBeLessThan(100_000);
				expect(persistedSpend(vaultBase)).toBeLessThan(100_000);
				const kinds = audit.events.map((e) => e.kind);
				expect(kinds.indexOf("usage_implausible")).toBeGreaterThan(kinds.indexOf("llm_call"));
				expect(audit.events.find((e) => e.kind === "usage_implausible")?.data).toMatchObject({
					transferId: receipt.transferId,
					tiers: { inputTokens: 1e12, outputTokens: 1e12 },
				});
				await g.destroy();
			} finally {
				rmSync(vaultBase, { recursive: true, force: true });
			}
		});
	}
});

describe("the ceiling is per provider RESPONSE", () => {
	let vaultBase: string;
	beforeEach(() => {
		vaultBase = join(tmpdir(), `absurd-usage-agg-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
	});
	afterEach(() => {
		rmSync(vaultBase, { recursive: true, force: true });
	});
	const AUTH = { model: "claude-sonnet-4-6", estimatedInputTokens: 100, maxOutputTokens: 50 };

	it("a 600-response window summing past the single-response ceiling is charged in full", async () => {
		const audit = makeAudit();
		const gov = await createGovernor({
			budget: 10_000_000_000,
			vaultBase,
			dryRun: true,
			_audit: audit,
		});
		const auth = await gov.authorize(AUTH);
		const receipt = await gov.settle(auth, {
			inputTokens: 150_000_000,
			outputTokens: 1_000,
			responses: 600,
		});
		expect(receipt.usageSource).toBe("provider");
		expect(audit.events.map((e) => e.kind)).not.toContain("usage_implausible");
		await gov.destroy();
	});

	it("CONTROL: the same total claimed as ONE response is refused", async () => {
		const audit = makeAudit();
		const gov = await createGovernor({
			budget: 10_000_000_000,
			vaultBase,
			dryRun: true,
			_audit: audit,
		});
		const auth = await gov.authorize(AUTH);
		const receipt = await gov.settle(auth, { inputTokens: 150_000_000, outputTokens: 1_000 });
		expect(receipt.usageSource).toBe("estimated");
		expect(audit.events.map((e) => e.kind)).toContain("usage_implausible");
		await gov.destroy();
	});

	it("a count above the scaled bound is still refused, and the event names the scaled ceiling", async () => {
		const audit = makeAudit();
		const gov = await createGovernor({
			budget: 10_000_000_000,
			vaultBase,
			dryRun: true,
			_audit: audit,
		});
		const auth = await gov.authorize(AUTH);
		await gov.settle(auth, { inputTokens: 1e12, outputTokens: 1, responses: 600 });
		expect(audit.events.find((e) => e.kind === "usage_implausible")?.data).toMatchObject({
			ceilingTokensPerTier: MAX_PLAUSIBLE_TOKENS_PER_TIER * 600,
		});
		await gov.destroy();
	});

	it("a model with NO 1-hour tier ignores the share: an absurd one neither refuses nor re-prices valid usage", async () => {
		const audit = makeAudit();
		const gov = await createGovernor({
			budget: 10_000_000_000,
			vaultBase,
			dryRun: true,
			_audit: audit,
		});
		const auth = await gov.authorize({ ...AUTH, model: "gpt-4o" });
		const receipt = await gov.settle(auth, {
			inputTokens: 1_000,
			outputTokens: 500,
			cacheWriteTokens: 5,
			cacheWrite1hTokens: 1e12,
		});
		expect(receipt.usageSource).toBe("provider");
		expect(audit.events.map((e) => e.kind)).not.toContain("usage_implausible");
		await gov.destroy();
	});

	it("an absurd 1-hour share is reported even when it exceeds the write total (the raw figure is checked, not the clamp)", async () => {
		const audit = makeAudit();
		const gov = await createGovernor({
			budget: 10_000_000_000,
			vaultBase,
			dryRun: true,
			_audit: audit,
		});
		const auth = await gov.authorize(AUTH);
		const receipt = await gov.settle(auth, {
			inputTokens: 10,
			outputTokens: 10,
			cacheWriteTokens: 5,
			cacheWrite1hTokens: 1e12,
		});
		expect(receipt.usageSource).toBe("estimated");
		expect(audit.events.find((e) => e.kind === "usage_implausible")?.data).toMatchObject({
			tiers: { cacheWrite1hTokens: 1e12 },
		});
		await gov.destroy();
	});
});
