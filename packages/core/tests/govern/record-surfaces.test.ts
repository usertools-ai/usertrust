// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Spec D5 — record surfaces on `trust()`: one snapshot, honest provenance,
 * reconstructable cost.
 *
 * The ship's headline claim is narrow and checkable: **from the record alone an
 * auditor recomputes usertrust's configured metered cost exactly.** That needs
 * three things on the record, and this file pins all three at both `trust()`
 * settle sites (non-stream and stream terminal):
 *
 *  1. `receipt.usage` — the four SANITIZED disjoint tiers, present iff the
 *     settle was provider-sourced and ABSENT on an estimated settle (a record
 *     of counts nobody reported is a fabrication, not a saving).
 *  2. `receipt.meter.appliedRates` — the four RESOLVED per-1k rates, i.e. what
 *     the money was actually computed with after the D1 fallback. Publishing
 *     the raw `ModelRates` instead would hand the auditor `undefined` for
 *     exactly the tiers the fallback makes non-zero.
 *  3. `receipt.meter.pricingTableVersion` — which table those rates came from.
 *
 *  ... plus `llm_call.data.usage`, which MIRRORS `receipt.usage` byte-for-byte:
 *  the receipt is an ephemeral return value, the chain event is the durable
 *  record, and the claim is only worth something on the durable one.
 *
 * **The recompute pin** (`recomputeCost` below) is the claim itself, written
 * the way an auditor would write it — from the record, never through
 * `costFromRates`. A pin that called the production function would prove
 * nothing about whether the RECORD is sufficient.
 *
 * **The divergence probe** is the other half of D5: cost and record must derive
 * from the SAME sanitized snapshot object. It hands the governor a provider
 * `usage` whose every field is a getter that returns a DIFFERENT value on each
 * read, then asserts each field was read exactly once and that the pin still
 * holds. Any second derivation — re-reading `response.usage` for the record
 * after pricing off it, or calling an extractor twice — reads a different
 * number the second time and the pin fails.
 *
 * SECURITY: assert individual fields; never snapshot a whole receipt payload.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { getModelRates, PRICING_TABLE_VERSION } from "../../src/ledger/pricing.js";
import type {
	AppliedRates,
	AuditEvent,
	ReceiptUsage,
	TrustReceipt,
} from "../../src/shared/types.js";

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

// ── Harness ──

function makeTmpVault(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

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

/** A never-capping engine: the POST always lands in full. */
function makeEngine(): TrustEngine & { spendPending: ReturnType<typeof vi.fn> } {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

/** An Anthropic-shaped mock whose `usage` object the test owns. */
function makeAnthropicMock(usage: unknown) {
	return {
		messages: {
			create: vi.fn(async () => ({
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

/** An Anthropic STREAMING mock — yields the chunks, then ends. */
function makeStreamingAnthropicMock(chunks: unknown[]) {
	return {
		messages: {
			create: vi.fn(async () => {
				async function* gen() {
					for (const c of chunks) yield c;
				}
				return gen();
			}),
		},
	};
}

function llmCalls(audit: { events: AppendEventInput[] }): AppendEventInput[] {
	return audit.events.filter((e) => e.kind === "llm_call");
}

/**
 * THE RECONCILIATION CLAIM, hand-written.
 *
 * `ceil(sum(counts x appliedRates / 1000))`, floored at 1 — the D5 formula,
 * derived from nothing but the record. Deliberately NOT `costFromRates`: this
 * has to fail if the record stops being sufficient to reproduce the money,
 * which a call into the production pricing function could never detect.
 */
function recomputeCost(usage: ReceiptUsage, rates: AppliedRates): number {
	const total =
		(usage.inputTokens * rates.inputPer1k) / 1000 +
		(usage.outputTokens * rates.outputPer1k) / 1000 +
		(usage.cacheReadTokens * rates.cacheReadPer1k) / 1000 +
		(usage.cacheWriteTokens * rates.cacheWritePer1k) / 1000;
	return Math.max(1, Math.ceil(total));
}

/** Assert the pin on a receipt that must be provider-sourced. */
function expectRecomputable(receipt: TrustReceipt): void {
	expect(receipt.usageSource).toBe("provider");
	const usage = receipt.usage;
	const applied = receipt.meter?.appliedRates;
	if (usage === undefined || applied === undefined) {
		throw new Error("receipt is not recomputable: usage or appliedRates missing");
	}
	expect(recomputeCost(usage, applied)).toBe(receipt.cost);
}

const MESSAGES = [{ role: "user", content: "hello" }];

// ── Non-stream settle ──

describe("trust() non-stream record surfaces (spec D5)", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault("record-surfaces-govern");
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("publishes the four sanitized tiers, the resolved rates, and the table version", async () => {
		const audit = makeMockAudit();
		const client = makeAnthropicMock({
			input_tokens: 1000,
			output_tokens: 500,
			cache_read_input_tokens: 200_000,
			cache_creation_input_tokens: 4000,
		});
		const governed = await trust(client, {
			budget: 10_000_000,
			vaultBase: tmpVault,
			_engine: makeEngine(),
			_audit: audit,
		});

		const { receipt } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: MESSAGES,
		});

		expect(receipt.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200_000,
			cacheWriteTokens: 4000,
		});

		const rates = getModelRates("claude-sonnet-4-6");
		expect(receipt.meter?.appliedRates).toEqual({
			inputPer1k: rates.inputPer1k,
			outputPer1k: rates.outputPer1k,
			cacheReadPer1k: rates.cacheReadPer1k,
			cacheWritePer1k: rates.cacheWritePer1k,
		});
		expect(receipt.meter?.pricingTableVersion).toBe(PRICING_TABLE_VERSION);

		// 30 + 75 + 600 + 150 — the cache tiers used to bill at ZERO.
		expect(receipt.cost).toBe(855);
		expectRecomputable(receipt);

		await governed.destroy();
	});

	it("mirrors receipt.usage onto the llm_call chain event", async () => {
		const audit = makeMockAudit();
		const client = makeAnthropicMock({
			input_tokens: 1000,
			output_tokens: 500,
			cache_read_input_tokens: 200_000,
			cache_creation_input_tokens: 4000,
		});
		const governed = await trust(client, {
			budget: 10_000_000,
			vaultBase: tmpVault,
			_engine: makeEngine(),
			_audit: audit,
		});

		const { receipt } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: MESSAGES,
		});

		const events = llmCalls(audit);
		expect(events).toHaveLength(1);
		const data = events[0]?.data as Record<string, unknown>;
		expect(data.usage).toEqual(receipt.usage);
		expect(data.usageSource).toBe("provider");
		// The durable record carries the rates too — a chain event that cannot be
		// repriced is not a reconciliation surface, it is a number to trust.
		expect(data.appliedRates).toEqual(receipt.meter?.appliedRates);
		expect(data.pricingTableVersion).toBe(PRICING_TABLE_VERSION);
		expect(recomputeCost(data.usage as ReceiptUsage, data.appliedRates as AppliedRates)).toBe(
			data.cost,
		);

		await governed.destroy();
	});

	it("recompute pin holds for the D1 fallback tiers (absent cache rates price at inputPer1k)", async () => {
		const audit = makeMockAudit();
		// mistral-large publishes no cache rates; D1 resolves BOTH tiers to
		// inputPer1k. The record must publish that resolution, not `undefined`.
		const client = makeAnthropicMock({
			input_tokens: 1000,
			output_tokens: 200,
			cache_read_input_tokens: 50_000,
			cache_creation_input_tokens: 10_000,
		});
		const governed = await trust(client, {
			budget: 10_000_000,
			vaultBase: tmpVault,
			_engine: makeEngine(),
			_audit: audit,
		});

		const { receipt } = await governed.messages.create({
			model: "mistral-large",
			max_tokens: 64,
			messages: MESSAGES,
		});

		const rates = getModelRates("mistral-large");
		expect(rates.cacheReadPer1k).toBeUndefined();
		expect(rates.cacheWritePer1k).toBeUndefined();
		expect(receipt.meter?.appliedRates?.cacheReadPer1k).toBe(rates.inputPer1k);
		expect(receipt.meter?.appliedRates?.cacheWritePer1k).toBe(rates.inputPer1k);
		expectRecomputable(receipt);

		await governed.destroy();
	});

	it("omits usage entirely on an estimated settle, but still publishes the rates", async () => {
		const audit = makeMockAudit();
		// No usable usage: the D5 provenance rule demotes this to "estimated" and
		// the cost is the metering estimate, which counts x rates CANNOT reproduce.
		// Publishing a usage block here would invite exactly that false recompute.
		const client = makeAnthropicMock({});
		const governed = await trust(client, {
			budget: 10_000_000,
			vaultBase: tmpVault,
			_engine: makeEngine(),
			_audit: audit,
		});

		const { receipt } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: MESSAGES,
		});

		expect(receipt.usageSource).toBe("estimated");
		expect(Object.hasOwn(receipt, "usage")).toBe(false);
		expect(receipt.meter?.appliedRates).toBeDefined();
		expect(receipt.meter?.pricingTableVersion).toBe(PRICING_TABLE_VERSION);

		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(Object.hasOwn(data, "usage")).toBe(false);

		await governed.destroy();
	});

	it("divergence probe: every provider counter is read exactly once, into one snapshot", async () => {
		const audit = makeMockAudit();
		// Every getter answers with a DIFFERENT number each time it is read. A
		// second derivation of the record (or of the cost) reads the second value
		// and the recompute pin below stops matching.
		const reads = {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		};
		const usage = {
			get input_tokens() {
				reads.input_tokens++;
				return 1000 * reads.input_tokens;
			},
			get output_tokens() {
				reads.output_tokens++;
				return 500 * reads.output_tokens;
			},
			get cache_read_input_tokens() {
				reads.cache_read_input_tokens++;
				return 200_000 * reads.cache_read_input_tokens;
			},
			get cache_creation_input_tokens() {
				reads.cache_creation_input_tokens++;
				return 4000 * reads.cache_creation_input_tokens;
			},
		};

		const governed = await trust(makeAnthropicMock(usage), {
			budget: 100_000_000,
			vaultBase: tmpVault,
			_engine: makeEngine(),
			_audit: audit,
		});

		const { receipt } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: MESSAGES,
		});

		expect(reads).toEqual({
			input_tokens: 1,
			output_tokens: 1,
			cache_read_input_tokens: 1,
			cache_creation_input_tokens: 1,
		});
		// First-read values — the snapshot, not a later re-read.
		expect(receipt.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200_000,
			cacheWriteTokens: 4000,
		});
		expectRecomputable(receipt);
		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(data.usage).toEqual(receipt.usage);

		await governed.destroy();
	});

	it("non-finite provider garbage never reaches the record", async () => {
		const audit = makeMockAudit();
		const client = makeAnthropicMock({
			input_tokens: 1000,
			output_tokens: 500,
			cache_read_input_tokens: Number.POSITIVE_INFINITY,
			cache_creation_input_tokens: Number.NaN,
		});
		const governed = await trust(client, {
			budget: 10_000_000,
			vaultBase: tmpVault,
			_engine: makeEngine(),
			_audit: audit,
		});

		const { receipt } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: MESSAGES,
		});

		expect(receipt.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		// canonicalize() throws on non-finite: the chain write only survives
		// because the snapshot sanitized these before emission.
		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(JSON.stringify(data.usage)).toBe(JSON.stringify(receipt.usage));
		expectRecomputable(receipt);

		await governed.destroy();
	});
});

// ── Stream terminal ──

describe("trust() stream record surfaces (spec D5)", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault("record-surfaces-stream");
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	async function settleStream(
		chunks: unknown[],
		audit: AuditWriter & { events: AppendEventInput[] },
		vault: string,
	): Promise<TrustReceipt> {
		const governed = await trust(makeStreamingAnthropicMock(chunks), {
			budget: 10_000_000,
			vaultBase: vault,
			_engine: makeEngine(),
			_audit: audit,
		});
		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: MESSAGES,
		});
		for await (const _ of result.response as AsyncIterable<unknown>) {
			// consume
		}
		const receipt = await (result.response as { receipt: Promise<TrustReceipt> }).receipt;
		await governed.destroy();
		return receipt;
	}

	it("publishes the four tiers, the resolved rates, and stays recomputable", async () => {
		const audit = makeMockAudit();
		const receipt = await settleStream(
			[
				{
					type: "message_start",
					message: {
						usage: {
							input_tokens: 1000,
							cache_read_input_tokens: 200_000,
							cache_creation_input_tokens: 4000,
						},
					},
				},
				{ type: "content_block_delta", delta: { text: "hi" } },
				{ type: "message_delta", usage: { output_tokens: 500 } },
			],
			audit,
			tmpVault,
		);

		expect(receipt.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200_000,
			cacheWriteTokens: 4000,
		});
		expect(receipt.meter?.pricingTableVersion).toBe(PRICING_TABLE_VERSION);
		expect(receipt.cost).toBe(855);
		expectRecomputable(receipt);

		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(data.usage).toEqual(receipt.usage);
		expect(recomputeCost(data.usage as ReceiptUsage, data.appliedRates as AppliedRates)).toBe(
			data.cost,
		);
	});

	it("omits usage on a stream that reported none", async () => {
		const audit = makeMockAudit();
		const receipt = await settleStream(
			[{ type: "content_block_delta", delta: { text: "hi" } }],
			audit,
			tmpVault,
		);

		expect(receipt.usageSource).toBe("estimated");
		expect(Object.hasOwn(receipt, "usage")).toBe(false);
		expect(receipt.meter?.appliedRates).toBeDefined();

		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(Object.hasOwn(data, "usage")).toBe(false);
	});

	it("the estimate-priced stream handle carries the rates but never a usage block", async () => {
		const audit = makeMockAudit();
		const governed = await trust(
			makeStreamingAnthropicMock([{ type: "content_block_delta", delta: { text: "hi" } }]),
			{
				budget: 10_000_000,
				vaultBase: tmpVault,
				_engine: makeEngine(),
				_audit: audit,
			},
		);
		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: MESSAGES,
		});

		// The settled:false handle returned BEFORE consumption: nothing has been
		// reported yet, so there is nothing honest to publish as usage.
		expect(result.receipt.settled).toBe(false);
		expect(Object.hasOwn(result.receipt, "usage")).toBe(false);
		expect(result.receipt.meter?.appliedRates).toBeDefined();
		expect(result.receipt.meter?.pricingTableVersion).toBe(PRICING_TABLE_VERSION);

		for await (const _ of result.response as AsyncIterable<unknown>) {
			// consume so the hold resolves
		}
		await (result.response as { receipt: Promise<TrustReceipt> }).receipt;
		await governed.destroy();
	});
});
