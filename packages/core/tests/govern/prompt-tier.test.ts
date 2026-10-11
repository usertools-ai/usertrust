// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Per-request prompt tiers through `trust()` (Claude Haiku 5.5, `longPrompt`).
 *
 * The tier is decided per request from the REPORTED prompt length (input + cache reads +
 * cache writes; over 100,000 → the higher tier). Pinned at both settle sites, non-stream
 * and stream terminal:
 *
 *  - the settled cost is the tier the reported prompt selects, never the hold's;
 *  - `receipt.pricing.appliedRates` publishes THAT tier, so the auditor's formula
 *    `ceil(sum(counts x appliedRates / 1000))` reproduces the cost from the record alone;
 *  - the hold is sized at the DEARER tier (the estimate cannot know the side of the
 *    threshold), and the posted amount is the actual-tier cost.
 *
 * The stream case is the one that matters most: the hold is sized at authorize time from
 * an estimate of a tiny prompt, then the stream REPORTS a prompt over 100,000 (cache
 * reads). The settle must take the higher tier from the reported counts.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import type {
	AppliedRates,
	AuditEvent,
	ReceiptUsage,
	TrustReceipt,
} from "../../src/shared/types.js";

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

const MODEL = "claude-haiku-5-5";
// The page's two tiers, as the record must publish them (usertokens per 1k).
const LOW: AppliedRates = {
	inputPer1k: 1,
	outputPer1k: 5,
	cacheReadPer1k: 0.1,
	cacheWritePer1k: 1.25,
};
const HIGH: AppliedRates = {
	inputPer1k: 5,
	outputPer1k: 25,
	cacheReadPer1k: 0.5,
	cacheWritePer1k: 6.25,
};

function makeMockAudit(): AuditWriter & { events: AppendEventInput[] } {
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

/** A never-capping engine that records the hold and the post. */
function makeEngine(): TrustEngine & {
	spendPending: ReturnType<typeof vi.fn>;
	postPendingSpend: ReturnType<typeof vi.fn>;
} {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

/** The auditor's formula, from the record alone. Never through the pricer. */
function recomputeCost(usage: ReceiptUsage, rates: AppliedRates): number {
	const total =
		(usage.inputTokens * rates.inputPer1k) / 1000 +
		(usage.outputTokens * rates.outputPer1k) / 1000 +
		(usage.cacheReadTokens * rates.cacheReadPer1k) / 1000 +
		(usage.cacheWriteTokens * rates.cacheWritePer1k) / 1000;
	return Math.max(1, Math.ceil(total));
}

function expectRecomputable(receipt: TrustReceipt): void {
	const usage = receipt.usage;
	const applied = receipt.pricing?.appliedRates;
	if (usage === undefined || applied === undefined) throw new Error("receipt not recomputable");
	expect(recomputeCost(usage, applied)).toBe(receipt.cost);
}

const MESSAGES = [{ role: "user", content: "hello" }];

describe("trust(): Haiku 5.5 is priced per request by its reported prompt length", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = join(tmpdir(), `prompt-tier-${randomUUID()}`);
		mkdirSync(tmpVault, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	async function nonStream(usage: Record<string, number>) {
		const engine = makeEngine();
		const client = {
			messages: {
				create: vi.fn(async (_params: unknown) => ({
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					model: MODEL,
					usage,
				})),
			},
		};
		const governed = await trust(client, {
			budget: 10_000_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});
		const { receipt } = await governed.messages.create({
			model: MODEL,
			max_tokens: 64,
			messages: MESSAGES,
		});
		await governed.destroy();
		return { receipt, engine };
	}

	it("non-stream, small prompt: the lower tier, published and recomputable", async () => {
		const { receipt } = await nonStream({ input_tokens: 2000, output_tokens: 500 });
		expect(receipt.pricing?.appliedRates).toEqual(LOW);
		// 2 + 2.5 → 5 (the old flat row charged 10 + 12.5 → 23).
		expect(receipt.cost).toBe(5);
		expectRecomputable(receipt);
	});

	it("non-stream, prompt of EXACTLY 100,000 (input + cache reads): still the lower tier", async () => {
		const { receipt } = await nonStream({
			input_tokens: 40_000,
			cache_read_input_tokens: 60_000,
			output_tokens: 100,
		});
		expect(receipt.pricing?.appliedRates).toEqual(LOW);
		expectRecomputable(receipt);
	});

	it("non-stream, prompt of 100,001: the higher tier, published and recomputable", async () => {
		const { receipt } = await nonStream({
			input_tokens: 40_000,
			cache_read_input_tokens: 60_000,
			cache_creation_input_tokens: 1,
			output_tokens: 100,
		});
		expect(receipt.pricing?.appliedRates).toEqual(HIGH);
		expectRecomputable(receipt);
	});

	it("the hold is sized at the DEARER tier even for a tiny estimated prompt", async () => {
		// A call that reports LESS than its estimate, so the settle sits inside the hold.
		const { engine, receipt } = await nonStream({ input_tokens: 1, output_tokens: 10 });
		const hold = engine.spendPending.mock.calls[0]?.[0] as { amount: number } | undefined;
		if (hold === undefined) throw new Error("no hold was placed");
		const held = hold.amount;
		// The 64-token output limit alone, held at the higher tier's 25/1k, is 1.6 → at least
		// 2 once the (tiny) input leg is added and the sum is rounded up. Held at the lower
		// tier's 5/1k the same output is 0.32, and a "hello" estimate's input leg could not
		// lift the hold to 2.
		expect(held).toBeGreaterThanOrEqual(2);
		expect(held).toBeGreaterThanOrEqual(receipt.cost);
		expect(engine.postPendingSpend).toHaveBeenCalledWith(expect.any(String), receipt.cost);
	});

	it("STREAM: the reported prompt crosses 100,000 AFTER the hold was sized; the settle uses the ACTUAL tier", async () => {
		const audit = makeMockAudit();
		const engine = makeEngine();
		const chunks = [
			{
				type: "message_start",
				message: {
					usage: {
						// 1,000 fresh + 120,000 cache reads = 121,000 prompt tokens: the higher
						// tier. The authorize-time estimate saw only "hello".
						input_tokens: 1000,
						cache_read_input_tokens: 120_000,
					},
				},
			},
			{ type: "content_block_delta", delta: { text: "hi" } },
			{ type: "message_delta", usage: { output_tokens: 500 } },
		];
		const governed = await trust(
			{
				messages: {
					create: vi.fn(async (_params: unknown) => {
						async function* gen() {
							for (const c of chunks) yield c;
						}
						return gen();
					}),
				},
			},
			{ budget: 10_000_000, vaultBase: tmpVault, _engine: engine, _audit: audit },
		);
		const result = await governed.messages.create({
			model: MODEL,
			max_tokens: 64,
			messages: MESSAGES,
		});
		// The estimate-priced handle, before any usage: the tier the ESTIMATE selects.
		expect(result.receipt.pricing?.appliedRates).toEqual(LOW);
		for await (const _ of result.response as AsyncIterable<unknown>) {
			// consume
		}
		const receipt = await (result.response as { receipt: Promise<TrustReceipt> }).receipt;
		await governed.destroy();

		// 1,000 x 5 + 120,000 x 0.5 + 500 x 25 = 5 + 60 + 12.5 → 78 at the higher tier
		// (the lower tier would be 1 + 12 + 2.5 → 16).
		expect(receipt.cost).toBe(78);
		expect(receipt.pricing?.appliedRates).toEqual(HIGH);
		expectRecomputable(receipt);
		// The post is the actual-tier cost.
		expect(engine.postPendingSpend).toHaveBeenCalledWith(expect.any(String), 78);
		// The durable chain event carries the same tier.
		const data = audit.events.find((e) => e.kind === "llm_call")?.data as Record<string, unknown>;
		expect(data.appliedRates).toEqual(HIGH);
		expect(recomputeCost(data.usage as ReceiptUsage, data.appliedRates as AppliedRates)).toBe(
			data.cost,
		);
	});
});
