// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * 1-hour cache writes through the governed paths (#203).
 *
 * Sonnet 4.6: 30 in / 150 out / 3 read / 37.5 5m write / 60 1h write, per 1k.
 * Hand-computed expectations, never recomputed through the code under test.
 *
 * Pinned here:
 *  1. trust() holds the input leg at the 1h write rate ONLY when the request declares
 *     a 1h TTL (`cache_control.ttl === "1h"`, anywhere in the request); otherwise it
 *     holds as it always did. Positive control: a call that settles with 1h writes
 *     never exceeds its hold, on a capping engine.
 *  2. A stream's 1h share (message_start `cache_creation`) settles at the 1h rate on
 *     both stream surfaces' completion, and lands on the receipt.
 *  3. headless settle() takes `cacheWrite1hTokens` as a SUBSET of `cacheWriteTokens`,
 *     reads it once, clamps it, and refuses to bill it alone.
 *  4. headless authorize() holds the worst case (it cannot see the TTLs).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TrustEngine, trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import type { TrustReceipt } from "../../src/shared/types.js";

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

const MODEL = "claude-sonnet-4-6";

interface Engine {
	spendPending: ReturnType<typeof vi.fn>;
	postPendingSpend: ReturnType<typeof vi.fn>;
	voidPendingSpend: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
}

/** Caps a post at the reserved hold, like TigerBeetle, and reports the shortfall. */
function makeCappingEngine(): Engine {
	const reserved = new Map<string, number>();
	return {
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
			reserved.set(p.transferId, p.amount);
			return { transferId: p.transferId };
		}),
		postPendingSpend: vi.fn(async (transferId: string, actual?: number) => {
			const cap = reserved.get(transferId) ?? 0;
			const posted = Math.min(actual ?? cap, cap);
			return { posted, shortfall: (actual ?? cap) - posted };
		}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

/** The mock engine as the governors take it (the capping stub implements the whole contract). */
const asEngine = (e: Engine): TrustEngine => e as unknown as TrustEngine;

const heldAmount = (e: Engine): number => {
	const call = e.spendPending.mock.calls[0]?.[0] as { amount: number } | undefined;
	if (call === undefined) throw new Error("no hold was reserved");
	return call.amount;
};

function anthropic(usage: Record<string, unknown>) {
	return {
		messages: {
			create: vi.fn(async (_params?: unknown) => ({
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				model: MODEL,
				stop_reason: "end_turn",
				usage,
			})),
		},
	};
}

describe("1-hour cache writes: governed paths", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = join(tmpdir(), `cw1h-${randomUUID()}`);
		mkdirSync(tmpVault, { recursive: true });
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	// ── 1. trust(): the hold covers the worst case THIS REQUEST can produce ──

	async function holdFor(extra: Record<string, unknown>, content = "x".repeat(2000)) {
		const engine = makeCappingEngine();
		const governed = await trust(anthropic({ input_tokens: 10, output_tokens: 1 }), {
			budget: 1_000_000,
			vaultBase: tmpVault,
			_engine: asEngine(engine),
		});
		await governed.messages.create({
			model: MODEL,
			max_tokens: 1,
			messages: [{ role: "user", content }],
			...extra,
		});
		await governed.destroy();
		return heldAmount(engine);
	}

	// 2000 chars -> estimateInputTokens = ceil((16 + 2000) / 4) x 1.5 = 756; max_tokens 1.
	// 756 x 37.5 / 1000 = 28.35 (+ 0.15 output) -> 29;  756 x 60 / 1000 = 45.36 (+ 0.15) -> 46.
	it("no 1h marker: held at the 5-minute rate, exactly as before", async () => {
		expect(await holdFor({})).toBe(29);
		// A 5-minute marker is not a 1-hour one.
		expect(
			await holdFor({
				system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "5m" } }],
			}),
		).toBe(29);
	});

	it("a 1h marker anywhere in the request holds the input leg at the 1h rate", async () => {
		const marker = { type: "ephemeral", ttl: "1h" };
		for (const extra of [
			{ system: [{ type: "text", text: "s", cache_control: marker }] },
			{ tools: [{ name: "t", input_schema: {}, cache_control: marker }] },
			{ cache_control: marker }, // top-level automatic caching
		]) {
			expect(await holdFor(extra), JSON.stringify(extra)).toBe(46);
		}
		// A marker on a message content block.
		const block = [{ type: "text", text: "x".repeat(2000), cache_control: marker }];
		expect(await holdFor({ messages: [{ role: "user", content: block }] })).toBe(46);
	});

	it("positive control: a call that settles WITH 1h writes never exceeds its hold", async () => {
		const marker = { type: "ephemeral", ttl: "1h" };
		const engine = makeCappingEngine();
		const governed = await trust(
			anthropic({
				input_tokens: 700,
				output_tokens: 1,
				cache_creation_input_tokens: 5_000,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5_000 },
			}),
			{ budget: 1_000_000, vaultBase: tmpVault, _engine: asEngine(engine) },
		);
		const { receipt } = (await governed.messages.create({
			model: MODEL,
			max_tokens: 1,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "s".repeat(20_000), cache_control: marker }],
				},
			],
		})) as { receipt: TrustReceipt };
		await governed.destroy();
		// cost = 700 x 30 + 1 x 150 + 5,000 x 60 = 21,000 + 150 + 300,000 = 321,150 / 1000 -> 322.
		expect(receipt.cost).toBe(322);
		expect(receipt.cacheWrite1h).toEqual({ tokens: 5_000, ratePer1k: 60 });
		expect(receipt.postedCost).toBeUndefined(); // no shortfall: the hold covered the 1h write
		expect(heldAmount(engine)).toBeGreaterThanOrEqual(receipt.cost);
	});

	it("contrast: the same settle against a 5-minute-sized hold WOULD cap (why the marker matters)", async () => {
		const engine = makeCappingEngine();
		const governed = await trust(
			anthropic({
				input_tokens: 700,
				output_tokens: 1,
				cache_creation_input_tokens: 5_000,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5_000 },
			}),
			{ budget: 1_000_000, vaultBase: tmpVault, _engine: asEngine(engine) },
		);
		// The request declares NO 1h TTL, yet the response reports 1h writes (a provider
		// default or a proxy): the 5-minute-sized hold is smaller than the settle and is
		// capped, which is the audited shortfall path rather than a silent under-debit.
		const { receipt } = (await governed.messages.create({
			model: MODEL,
			max_tokens: 1,
			messages: [{ role: "user", content: "hi" }],
		})) as { receipt: TrustReceipt };
		await governed.destroy();
		expect(receipt.cost).toBe(322);
		expect(receipt.postedCost).toBeLessThan(receipt.cost);
	});

	// ── 2. streams ──

	it("a stream's 1h share (message_start cache_creation) settles at the 1h rate", async () => {
		const chunks = [
			{
				type: "message_start",
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 0,
						cache_creation_input_tokens: 4_000,
						cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 3_000 },
					},
				},
			},
			{ type: "message_delta", usage: { output_tokens: 200 } },
			{ type: "message_stop" },
		];
		const client = {
			messages: {
				create: vi.fn(async (_params?: unknown) => {
					async function* gen() {
						for (const c of chunks) yield c;
					}
					return gen();
				}),
			},
		};
		const governed = await trust(client, {
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: asEngine(makeCappingEngine()),
		});
		const result = (await governed.messages.create({
			model: MODEL,
			max_tokens: 1024,
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		})) as unknown as { response: AsyncIterable<unknown> & { receipt: Promise<TrustReceipt> } };
		for await (const _ of result.response) {
			// drain
		}
		const receipt = await result.response.receipt;
		// 100 x 30 + 200 x 150 + 1,000 x 37.5 + 3,000 x 60 = 3,000 + 30,000 + 37,500 + 180,000
		// = 250,500 / 1000 -> 251.
		expect(receipt.cost).toBe(251);
		expect(receipt.usage?.cacheWriteTokens).toBe(4_000);
		expect(receipt.cacheWrite1h).toEqual({ tokens: 3_000, ratePer1k: 60 });
		await governed.destroy();
	});

	// ── 3 + 4. headless ──

	it("headless settle(): cacheWrite1hTokens is a subset of the write total", async () => {
		const gov = await createGovernor({ budget: 1_000_000, vaultBase: tmpVault, dryRun: true });
		const settle = async (p: Record<string, number>) => {
			const auth = await gov.authorize({
				model: MODEL,
				estimatedInputTokens: 10,
				maxOutputTokens: 10,
			});
			return gov.settle(auth, { ...p, usageSource: "provider" });
		};
		// 4,000 written, 1,000 of them 1h: 3,000 x 37.5 + 1,000 x 60 = 112,500 + 60,000 = 172.5 -> 173.
		const split = await settle({
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 4_000,
			cacheWrite1hTokens: 1_000,
		});
		expect(split.cost).toBe(173);
		expect(split.usage?.cacheWriteTokens).toBe(4_000);
		expect(split.cacheWrite1h).toEqual({ tokens: 1_000, ratePer1k: 60 });
		// Omitted -> priced entirely at the 5-minute rate, record shape unchanged.
		const plain = await settle({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 4_000 });
		expect(plain.cost).toBe(150);
		expect("cacheWrite1h" in plain).toBe(false);
		// Clamped to the write total; alone it bills nothing and records nothing.
		const over = await settle({
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 1_000,
			cacheWrite1hTokens: 9_999,
		});
		expect(over.cost).toBe(60);
		expect(over.cacheWrite1h).toEqual({ tokens: 1_000, ratePer1k: 60 });
		const alone = await settle({ inputTokens: 5, outputTokens: 5, cacheWrite1hTokens: 9_999 });
		expect(alone.cacheWrite1h).toBeUndefined();
		// A 1h share with NO other count is not usage: the settle meters at the pre-call
		// estimate, exactly as a settle that carries nothing does.
		const bare = await settle({ cacheWrite1hTokens: 9_999 });
		const nothing = await settle({});
		expect(bare.cost).toBe(nothing.cost);
		expect(bare.usage).toBeUndefined();
		expect(bare.cacheWrite1h).toBeUndefined();
		await gov.destroy();
	});

	it("headless settle() reads cacheWrite1hTokens ONCE (a live getter cannot change the bill)", async () => {
		const gov = await createGovernor({ budget: 1_000_000, vaultBase: tmpVault, dryRun: true });
		const auth = await gov.authorize({
			model: MODEL,
			estimatedInputTokens: 10,
			maxOutputTokens: 10,
		});
		let reads = 0;
		const params = {
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 4_000,
			usageSource: "provider" as const,
			get cacheWrite1hTokens() {
				reads += 1;
				return reads === 1 ? 1_000 : 4_000;
			},
		};
		const receipt = await gov.settle(auth, params);
		expect(reads).toBe(1);
		expect(receipt.cost).toBe(173);
		await gov.destroy();
	});

	it("a legacy custom row (write tier, no 1h rate): the hold covers the 1-hour settle, no shortfall", async () => {
		const dir = join(tmpVault, ".usertrust");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "usertrust.config.json"),
			JSON.stringify({
				budget: 10_000_000,
				pricing: "custom",
				customRates: { "my-claude": { inputPer1k: 30, outputPer1k: 150, cacheWritePer1k: 37.5 } },
			}),
		);
		const engine = makeCappingEngine();
		const gov = await createGovernor({ vaultBase: tmpVault, _engine: asEngine(engine) });
		const auth = await gov.authorize({
			model: "my-claude",
			estimatedInputTokens: 10_000,
			maxOutputTokens: 1,
		});
		// 10,000 x 60 / 1000 + 1 x 150 / 1000 = 600.15 -> 601: the derived 1h rate (2x input),
		// not the 5-minute 376 a hold on explicit-only silence would reserve.
		expect(heldAmount(engine)).toBe(601);
		const receipt = await gov.settle(auth, {
			inputTokens: 0,
			outputTokens: 1,
			cacheWriteTokens: 10_000,
			cacheWrite1hTokens: 10_000,
			usageSource: "provider",
		});
		expect(receipt.cost).toBe(601);
		expect(receipt.postedCost).toBeUndefined();
		await gov.destroy();
	});

	it("an UNKNOWN model (fallback rate): the hold covers a 1-hour settle, no shortfall", async () => {
		const engine = makeCappingEngine();
		const gov = await createGovernor({
			budget: 10_000_000,
			vaultBase: tmpVault,
			_engine: asEngine(engine),
		});
		const auth = await gov.authorize({
			model: "claude-made-up-9",
			estimatedInputTokens: 10_000,
			maxOutputTokens: 1,
		});
		// Fallback 250 / 1250, 1h write 500: 10,000 x 500 / 1000 + 1 x 1250 / 1000 = 5,001.25 -> 5,002.
		expect(heldAmount(engine)).toBe(5_002);
		const receipt = await gov.settle(auth, {
			inputTokens: 0,
			outputTokens: 1,
			cacheWriteTokens: 10_000,
			cacheWrite1hTokens: 10_000,
			usageSource: "provider",
		});
		expect(receipt.cost).toBe(5_002);
		expect(receipt.postedCost).toBeUndefined();
		await gov.destroy();
	});

	it("a custom row with only input/output rates: the hold covers a 1-hour settle", async () => {
		const dir = join(tmpVault, ".usertrust");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "usertrust.config.json"),
			JSON.stringify({
				budget: 10_000_000,
				pricing: "custom",
				customRates: { "my-claude": { inputPer1k: 30, outputPer1k: 150 } },
			}),
		);
		const engine = makeCappingEngine();
		const gov = await createGovernor({ vaultBase: tmpVault, _engine: asEngine(engine) });
		const auth = await gov.authorize({
			model: "my-claude",
			estimatedInputTokens: 10_000,
			maxOutputTokens: 1,
		});
		expect(heldAmount(engine)).toBe(601); // 10,000 x 60 / 1000 + 0.15: the derived 2x input
		const receipt = await gov.settle(auth, {
			inputTokens: 0,
			outputTokens: 1,
			cacheWriteTokens: 10_000,
			cacheWrite1hTokens: 10_000,
			usageSource: "provider",
		});
		expect(receipt.cost).toBe(601);
		expect(receipt.postedCost).toBeUndefined();
		await gov.destroy();
	});

	it("a model with NO 1-hour tier (gpt-4o): a reported 1h share is ignored, so the hold covers the settle", async () => {
		const engine = makeCappingEngine();
		const gov = await createGovernor({
			budget: 10_000_000,
			vaultBase: tmpVault,
			_engine: asEngine(engine),
		});
		const auth = await gov.authorize({
			model: "gpt-4o",
			estimatedInputTokens: 10_000,
			maxOutputTokens: 1,
		});
		const held = heldAmount(engine);
		const receipt = await gov.settle(auth, {
			inputTokens: 0,
			outputTokens: 1,
			cacheWriteTokens: 10_000,
			cacheWrite1hTokens: 10_000,
			usageSource: "provider",
		});
		// gpt-4o has one write rate (its input rate, 25/1k): 10,000 x 25 / 1000 + 0.1 -> 251. Not 2x input.
		expect(receipt.cost).toBe(251);
		expect(receipt.cost).toBeLessThanOrEqual(held);
		expect(receipt.postedCost).toBeUndefined();
		expect(receipt.cacheWrite1h).toBeUndefined();
		expect(receipt.usage?.cacheWriteTokens).toBe(10_000);
		await gov.destroy();
	});

	it("headless authorize() holds the worst case: input leg and stated writes at the 1h rate", async () => {
		const engine = makeCappingEngine();
		const gov = await createGovernor({
			budget: 1_000_000,
			vaultBase: tmpVault,
			_engine: asEngine(engine),
		});
		// input 1,000 x 60 + write 2,000 x 60 + output 500 x 150 = 60,000 + 120,000 + 75,000 = 255,000 -> 255.
		await gov.authorize({
			model: MODEL,
			estimatedInputTokens: 1_000,
			estimatedCacheWriteTokens: 2_000,
			maxOutputTokens: 500,
		});
		expect(heldAmount(engine)).toBe(255);
		await gov.destroy();
	});
});
