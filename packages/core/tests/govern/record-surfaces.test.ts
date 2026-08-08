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
 *  2. `receipt.pricing.appliedRates` — the four RESOLVED per-1k rates, i.e. what
 *     the money was actually computed with after the D1 fallback. Publishing
 *     the raw `ModelRates` instead would hand the auditor `undefined` for
 *     exactly the tiers the fallback makes non-zero.
 *  3. `receipt.pricing.tableVersion` — which table those rates came from.
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
import { mkdirSync, readFileSync, rmSync } from "node:fs";
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
	const applied = receipt.pricing?.appliedRates;
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
		expect(receipt.pricing?.appliedRates).toEqual({
			inputPer1k: rates.inputPer1k,
			outputPer1k: rates.outputPer1k,
			cacheReadPer1k: rates.cacheReadPer1k,
			cacheWritePer1k: rates.cacheWritePer1k,
		});
		expect(receipt.pricing?.tableVersion).toBe(PRICING_TABLE_VERSION);

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
		expect(data.appliedRates).toEqual(receipt.pricing?.appliedRates);
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
		expect(receipt.pricing?.appliedRates?.cacheReadPer1k).toBe(rates.inputPer1k);
		expect(receipt.pricing?.appliedRates?.cacheWritePer1k).toBe(rates.inputPer1k);
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
		expect(receipt.pricing?.appliedRates).toBeDefined();
		expect(receipt.pricing?.tableVersion).toBe(PRICING_TABLE_VERSION);

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
		expect(receipt.pricing?.tableVersion).toBe(PRICING_TABLE_VERSION);
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
		expect(receipt.pricing?.appliedRates).toBeDefined();

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
		expect(result.receipt.pricing?.appliedRates).toBeDefined();
		expect(result.receipt.pricing?.tableVersion).toBe(PRICING_TABLE_VERSION);

		for await (const _ of result.response as AsyncIterable<unknown>) {
			// consume so the hold resolves
		}
		await (result.response as { receipt: Promise<TrustReceipt> }).receipt;
		await governed.destroy();
	});
});

// ── Codex PR-85 P1-1: the frozen v1 schema still validates new receipts ──

/**
 * `receipt.v1.schema.json` is published at a stable URL and the site's
 * versioning policy says it "stays frozen forever" and "keeps meaning the same
 * thing". Its `meter` object declares `additionalProperties: false`, so ANY new
 * key inside `meter` makes every v1 validator reject every receipt usertrust
 * emits from this ship onward — a silent break of the compatibility promise
 * that no test in this repo would otherwise notice.
 *
 * The receipt ROOT is `additionalProperties: true`, which is why the D5 rate
 * surface lives at `receipt.pricing` instead. These tests read the SHIPPED
 * schema file rather than restating its rules, so they keep telling the truth
 * if the schema is ever edited.
 */
describe("receipt.v1 compatibility of the D5 record surface (Codex PR-85 P1-1)", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault("record-surfaces-v1compat");
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	interface V1Schema {
		additionalProperties?: boolean;
		properties: {
			meter: { additionalProperties?: boolean; properties: Record<string, unknown> };
		};
	}

	function loadV1Schema(): V1Schema {
		const path = join(
			import.meta.dirname,
			"../../../../site/public/schemas/receipt.v1.schema.json",
		);
		return JSON.parse(readFileSync(path, "utf8")) as V1Schema;
	}

	it("still describes a CLOSED meter and an OPEN root — the premise of the relocation", () => {
		const v1 = loadV1Schema();
		// If either of these ever flips, the reasoning behind `receipt.pricing`
		// changes and this whole describe block needs revisiting.
		expect(v1.properties.meter.additionalProperties).toBe(false);
		expect(v1.additionalProperties).toBe(true);
	});

	it("keeps receipt.v2's meter identical to v1's and puts the rate surface at the root", () => {
		const v1 = loadV1Schema();
		const v2 = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "../../../../site/public/schemas/receipt.v2.schema.json"),
				"utf8",
			),
		) as V1Schema & {
			properties: { pricing: { required: string[]; properties: Record<string, unknown> } };
			examples: Array<Record<string, Record<string, unknown>>>;
		};

		// v2 is additive at the ROOT only: `meter` must not have grown a single key,
		// or v2 receipts stop validating against the frozen v1 schema.
		expect(Object.keys(v2.properties.meter.properties).sort()).toEqual(
			Object.keys(v1.properties.meter.properties).sort(),
		);
		expect(v2.properties.pricing.required.sort()).toEqual(["appliedRates", "tableVersion"]);

		// The published example must describe what the code actually emits.
		const example = v2.examples[0];
		if (example === undefined) throw new Error("receipt.v2 schema publishes no example");
		expect(Object.keys(example.pricing ?? {}).sort()).toEqual(["appliedRates", "tableVersion"]);
		const allowed = new Set(Object.keys(v1.properties.meter.properties));
		expect(Object.keys(example.meter ?? {}).filter((k) => !allowed.has(k))).toEqual([]);
	});

	it("emits no meter key that receipt.v1 would reject", async () => {
		const v1 = loadV1Schema();
		const allowed = new Set(Object.keys(v1.properties.meter.properties));

		const audit = makeMockAudit();
		const governed = await trust(
			makeAnthropicMock({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 200_000,
				cache_creation_input_tokens: 4000,
			}),
			{ budget: 10_000_000, vaultBase: tmpVault, _engine: makeEngine(), _audit: audit },
		);
		const { receipt } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: MESSAGES,
		});

		expect(receipt.meter).toBeDefined();
		expect(Object.keys(receipt.meter ?? {}).filter((k) => !allowed.has(k))).toEqual([]);
		// ...and the rate surface is where it can live without breaking anyone.
		expect(receipt.pricing?.appliedRates).toBeDefined();
		expect(receipt.pricing?.tableVersion).toBe(PRICING_TABLE_VERSION);
		expectRecomputable(receipt);

		await governed.destroy();
	});

	it("emits no meter key that receipt.v1 would reject on the stream terminal either", async () => {
		const v1 = loadV1Schema();
		const allowed = new Set(Object.keys(v1.properties.meter.properties));

		const audit = makeMockAudit();
		const governed = await trust(
			makeStreamingAnthropicMock([
				{ type: "message_start", message: { usage: { input_tokens: 1000 } } },
				{ type: "message_delta", usage: { output_tokens: 500 } },
			]),
			{ budget: 10_000_000, vaultBase: tmpVault, _engine: makeEngine(), _audit: audit },
		);
		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: MESSAGES,
		});

		// Both stream surfaces: the pre-settle handle AND the settled receipt.
		expect(Object.keys(result.receipt.meter ?? {}).filter((k) => !allowed.has(k))).toEqual([]);
		for await (const _ of result.response as AsyncIterable<unknown>) {
			// consume
		}
		const settled = await (result.response as { receipt: Promise<TrustReceipt> }).receipt;
		expect(Object.keys(settled.meter ?? {}).filter((k) => !allowed.has(k))).toEqual([]);
		expect(settled.pricing?.tableVersion).toBe(PRICING_TABLE_VERSION);

		await governed.destroy();
	});
});

// ── Codex PR-85 P1-2: a caller cannot rewrite the rates the chain recorded ──

/**
 * One rate snapshot is resolved per governed call and reaches three surfaces:
 * the estimate-priced stream handle (returned to the caller BEFORE the stream
 * is consumed), the `llm_call` chain event, and the settled receipt. Shared by
 * reference and mutable, the handle would be a writable back door into the
 * audit record: the caller edits the rates it holds, the terminal writes the
 * edited object into the chain, and the cost stays computed from the untouched
 * `ModelRates`. The chain hashes and verifies perfectly around rates that
 * priced nothing, and the receipt's own recompute contradicts its own cost.
 */
describe("applied rates are immutable and unshared across record surfaces (Codex PR-85 P1-2)", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault("record-surfaces-frozen");
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("a caller mutating the pre-settle stream handle cannot change the audited or receipted rates", async () => {
		const audit = makeMockAudit();
		const governed = await trust(
			makeStreamingAnthropicMock([
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
				{ type: "message_delta", usage: { output_tokens: 500 } },
			]),
			{ budget: 10_000_000, vaultBase: tmpVault, _engine: makeEngine(), _audit: audit },
		);
		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: MESSAGES,
		});

		const handleRates = result.receipt.pricing?.appliedRates as AppliedRates;
		const truth = { ...handleRates };
		expect(Object.isFrozen(handleRates)).toBe(true);

		// The attack, in both the shapes a caller can reach for. Strict-mode ESM
		// makes the assignment throw; a non-strict host silently no-ops. Either
		// way the recorded rates must be untouched, so both are tolerated here
		// and only the OUTCOME is asserted.
		try {
			(handleRates as { cacheReadPer1k: number }).cacheReadPer1k = 0;
			(handleRates as { inputPer1k: number }).inputPer1k = 0;
		} catch {
			// frozen object in strict mode — the good path
		}
		try {
			Object.assign(handleRates, { outputPer1k: 0, cacheWritePer1k: 0 });
		} catch {
			// likewise
		}
		expect(handleRates).toEqual(truth);

		for await (const _ of result.response as AsyncIterable<unknown>) {
			// consume so the terminal writes the chain event
		}
		const settled = await (result.response as { receipt: Promise<TrustReceipt> }).receipt;

		// The chain event and the settled receipt carry the REAL rates...
		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(data.appliedRates).toEqual(truth);
		expect(settled.pricing?.appliedRates).toEqual(truth);
		// ...and the money still reconciles against them, which is the point.
		expectRecomputable(settled);
		expect(recomputeCost(data.usage as ReceiptUsage, data.appliedRates as AppliedRates)).toBe(
			data.cost,
		);

		// No two surfaces share object identity, so no future escape from the
		// freeze can turn one mutation into three.
		expect(settled.pricing?.appliedRates).not.toBe(handleRates);
		expect(data.appliedRates).not.toBe(handleRates);
		expect(data.appliedRates).not.toBe(settled.pricing?.appliedRates);
		expect(Object.isFrozen(settled.pricing?.appliedRates)).toBe(true);
		expect(Object.isFrozen(data.appliedRates)).toBe(true);

		await governed.destroy();
	});

	it("a caller mutating a settled non-stream receipt cannot rewrite the chain event beside it", async () => {
		const audit = makeMockAudit();
		const governed = await trust(
			makeAnthropicMock({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 200_000,
				cache_creation_input_tokens: 4000,
			}),
			{ budget: 10_000_000, vaultBase: tmpVault, _engine: makeEngine(), _audit: audit },
		);
		const { receipt } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: MESSAGES,
		});

		const receiptRates = receipt.pricing?.appliedRates as AppliedRates;
		const truth = { ...receiptRates };
		expect(Object.isFrozen(receiptRates)).toBe(true);
		try {
			(receiptRates as { cacheReadPer1k: number }).cacheReadPer1k = 0;
		} catch {
			// frozen in strict mode
		}

		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(data.appliedRates).toEqual(truth);
		expect(data.appliedRates).not.toBe(receiptRates);
		expectRecomputable(receipt);

		await governed.destroy();
	});
});
