// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * An incomplete usage report never prices below the metered estimate, on every `trust()` path.
 *
 * A report is COMPLETE when input AND output were both reported as usable counts (an explicit 0
 * counts); only then is the call priced from its counts. Anything less (one side absent or
 * unusable, cache tiers alone, a stream cut before both sides arrived) is labelled "estimated",
 * costs max(metered estimate, its usable counts), and publishes no `usage`. The max() runs both
 * ways: the estimate when the counts show less, the counts when they show more. It never sees an
 * absurd count, because plausibility zeroes it first: those rows price at the estimate exactly.
 *
 * Before this, an Anthropic stream marked its usage reported on input OR output, so a stream cut
 * before its message_delta (an error, or a consumer that stopped reading) settled with its output
 * priced at 0 under a "provider" label.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import { trust } from "../../src/govern.js";
import { costFromRates, getModelRates } from "../../src/ledger/pricing.js";
import { fromGeminiUsage } from "../../src/ledger/usage.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";
import { type StreamCompletion, wrapStream } from "../../src/streaming.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

/** The governed surfaces these rows call, typed loosely (the fake clients are not SDK types). */
interface Governed {
	messages: { create: (params: unknown) => Promise<unknown> };
	chat: { completions: { create: (params: unknown) => Promise<unknown> } };
	destroy: () => Promise<void>;
}

const MODEL = "claude-sonnet-4-6";
const RATES = getModelRates(MODEL);
/** A long prompt, so the metered estimate sits well above a call's output-only cost. */
const MESSAGES = [{ role: "user", content: "x".repeat(8000) }];
const ABSURD = 2e9;

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

function makeEngine(): TrustEngine & {
	postPendingSpend: ReturnType<typeof vi.fn>;
	voidPendingSpend: ReturnType<typeof vi.fn>;
} {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	} as never;
}

async function* gen<T>(items: T[], throwAfter?: number): AsyncGenerator<T> {
	let i = 0;
	for (const item of items) {
		if (throwAfter !== undefined && i === throwAfter) throw new Error("connection reset");
		i++;
		yield item;
	}
}

const anthropic = (usage: unknown) => ({
	messages: {
		create: vi.fn(async () => ({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			model: MODEL,
			usage,
		})),
	},
});
const anthropicStream = (chunks: unknown[], throwAfter?: number) => ({
	messages: { create: vi.fn(async () => gen(chunks, throwAfter)) },
});
const start = (usage: Record<string, unknown>) => ({
	type: "message_start",
	message: { id: "msg_1", type: "message", role: "assistant", content: [], model: MODEL, usage },
});
const delta = (usage: Record<string, unknown>) => ({
	type: "message_delta",
	delta: { stop_reason: "end_turn" },
	usage,
});
const STOP = { type: "message_stop" };

describe("trust(): an incomplete report never prices below the metered estimate", () => {
	let vaultBase: string;
	let audit: AuditWriter & { events: AppendEventInput[] };
	beforeEach(() => {
		vaultBase = join(tmpdir(), `incomplete-report-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		audit = makeAudit();
	});
	afterEach(() => {
		rmSync(vaultBase, { recursive: true, force: true });
	});

	async function governed(client: unknown, engine = makeEngine()): Promise<Governed> {
		return (await trust(client as never, {
			budget: 10_000_000,
			vaultBase,
			_engine: engine,
			_audit: audit,
		})) as unknown as Governed;
	}

	/** A non-stream Anthropic call whose response carries `usage`. */
	async function settleAnthropic(usage: unknown): Promise<TrustReceipt> {
		const g = await governed(anthropic(usage));
		const { receipt } = (await g.messages.create({
			model: MODEL,
			max_tokens: 500,
			messages: MESSAGES,
		} as never)) as unknown as { receipt: TrustReceipt };
		await g.destroy();
		return receipt;
	}

	/** An Anthropic stream; `breakAfter` stops reading after that many chunks. */
	async function settleStream(
		chunks: unknown[],
		opts: { breakAfter?: number; engine?: ReturnType<typeof makeEngine> } = {},
	): Promise<TrustReceipt> {
		const g = await governed(anthropicStream(chunks), opts.engine);
		const result = (await g.messages.create({
			model: MODEL,
			max_tokens: 500,
			messages: MESSAGES,
		} as never)) as unknown as {
			response: AsyncIterable<unknown> & { receipt: Promise<TrustReceipt> };
		};
		let n = 0;
		for await (const _ of result.response) {
			n++;
			if (opts.breakAfter !== undefined && n >= opts.breakAfter) break;
		}
		const receipt = await result.response.receipt;
		await g.destroy();
		return receipt;
	}

	/** The metered estimate for these calls: a response that reports no usage at all. */
	const estimate = async (): Promise<number> => (await settleAnthropic(undefined)).cost;

	function expectEstimateClass(receipt: TrustReceipt): void {
		expect(receipt.usageSource).toBe("estimated");
		expect(Object.hasOwn(receipt, "usage")).toBe(false);
		const call = audit.events.filter((e) => e.kind === "llm_call").at(-1);
		expect(Object.hasOwn(call?.data as object, "usage")).toBe(false);
	}

	it("CONTROL: the estimate sits above an output-only or input-only cost", async () => {
		const est = await estimate();
		expect(est).toBeGreaterThan(costFromRates(RATES, 0, 500));
		expect(est).toBeGreaterThan(costFromRates(RATES, 2000, 0));
		expect(est).toBeLessThan(costFromRates(RATES, 100, 0, 1_000_000));
	});

	describe("non-stream", () => {
		it("a complete report prices from its counts and publishes them", async () => {
			const receipt = await settleAnthropic({ input_tokens: 2000, output_tokens: 500 });
			expect(receipt.cost).toBe(costFromRates(RATES, 2000, 500));
			expect(receipt.usageSource).toBe("provider");
			expect(receipt.usage?.outputTokens).toBe(500);
		});

		it("an absent input prices at the estimate", async () => {
			const est = await estimate();
			const receipt = await settleAnthropic({ output_tokens: 500 });
			expect(receipt.cost).toBe(est);
			expectEstimateClass(receipt);
		});

		it("max() picks the counts when they show more: a large cache read with no output", async () => {
			const receipt = await settleAnthropic({
				input_tokens: 100,
				cache_read_input_tokens: 1_000_000,
			});
			expect(receipt.cost).toBe(costFromRates(RATES, 100, 0, 1_000_000));
			expect(receipt.cost).toBeGreaterThan(await estimate());
			expectEstimateClass(receipt);
		});

		it("an absurd count prices at the estimate exactly, never at max() over it", async () => {
			const est = await estimate();
			const receipt = await settleAnthropic({ input_tokens: 2000, output_tokens: ABSURD });
			expect(receipt.cost).toBe(est);
			expectEstimateClass(receipt);
			expect(audit.events.map((e) => e.kind)).toContain("usage_implausible");
		});

		it("an OpenAI chat completion with only completion_tokens prices at the estimate", async () => {
			const client = {
				chat: {
					completions: {
						create: vi.fn(async () => ({
							id: "c",
							object: "chat.completion",
							model: "gpt-4o",
							choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
							usage: { completion_tokens: 500 },
						})),
					},
				},
			};
			const g = await governed(client);
			const { receipt } = (await g.chat.completions.create({
				model: "gpt-4o",
				max_tokens: 500,
				messages: MESSAGES,
			} as never)) as unknown as { receipt: TrustReceipt };
			await g.destroy();
			const gpt = getModelRates("gpt-4o");
			expect(receipt.cost).toBeGreaterThan(costFromRates(gpt, 0, 500));
			expectEstimateClass(receipt);
		});
	});

	describe("Anthropic stream", () => {
		it("a complete stream prices from its counts", async () => {
			const receipt = await settleStream([
				start({ input_tokens: 2000, output_tokens: 1 }),
				delta({ output_tokens: 500 }),
				STOP,
			]);
			expect(receipt.cost).toBe(costFromRates(RATES, 2000, 500));
			expect(receipt.usageSource).toBe("provider");
		});

		it("a stream CUT after message_start (no message_delta) prices at the estimate", async () => {
			const est = await estimate();
			const receipt = await settleStream([start({ input_tokens: 2000 }), STOP]);
			expect(receipt.cost).toBe(est);
			expectEstimateClass(receipt);
		});

		it("a consumer that stops reading after the first chunk prices at the estimate", async () => {
			const est = await estimate();
			const receipt = await settleStream(
				[
					start({ input_tokens: 2000 }),
					{ type: "content_block_delta", delta: { text: "hi" } },
					delta({ output_tokens: 500 }),
					STOP,
				],
				{ breakAfter: 1 },
			);
			expect(receipt.cost).toBe(est);
			expectEstimateClass(receipt);
		});

		it("a message_start without input_tokens prices at the estimate", async () => {
			const est = await estimate();
			const receipt = await settleStream([start({}), delta({ output_tokens: 500 }), STOP]);
			expect(receipt.cost).toBe(est);
			expectEstimateClass(receipt);
		});

		it("an explicit input of 0 is a usable count: the stream is complete", async () => {
			const receipt = await settleStream([
				start({ input_tokens: 0 }),
				delta({ output_tokens: 500 }),
				STOP,
			]);
			expect(receipt.cost).toBe(costFromRates(RATES, 0, 500));
			expect(receipt.usageSource).toBe("provider");
			expect(receipt.usage?.inputTokens).toBe(0);
		});

		it("max() picks the counts when they show more: a cut stream that read a large cache", async () => {
			const receipt = await settleStream(
				[
					start({ input_tokens: 100, cache_read_input_tokens: 1_000_000 }),
					{ type: "content_block_delta", delta: { text: "hi" } },
				],
				{ breakAfter: 1 },
			);
			expect(receipt.cost).toBe(costFromRates(RATES, 100, 0, 1_000_000));
			expectEstimateClass(receipt);
		});

		it("an absurd output count prices at the estimate exactly", async () => {
			const est = await estimate();
			const receipt = await settleStream([
				start({ input_tokens: 2000 }),
				delta({ output_tokens: ABSURD }),
				STOP,
			]);
			expect(receipt.cost).toBe(est);
			expectEstimateClass(receipt);
		});

		it("a stream that throws mid-way voids its hold, as before", async () => {
			const engine = makeEngine();
			const g = await governed(
				anthropicStream([start({ input_tokens: 2000 }), { type: "content_block_delta" }], 1),
				engine,
			);
			const result = (await g.messages.create({
				model: MODEL,
				max_tokens: 500,
				messages: MESSAGES,
			} as never)) as unknown as { response: AsyncIterable<unknown> };
			await expect(
				(async () => {
					for await (const _ of result.response) {
						// drain
					}
				})(),
			).rejects.toThrow("connection reset");
			await g.destroy();
			expect(engine.voidPendingSpend).toHaveBeenCalled();
			expect(engine.postPendingSpend).not.toHaveBeenCalled();
		});
	});
});

describe("trust(), a tiered row (claude-haiku-5-5): an incomplete report is priced no cheaper than the tier authorize held", () => {
	const HAIKU_MODEL = "claude-haiku-5-5";
	const HAIKU = getModelRates(HAIKU_MODEL);
	/**
	 * About 150,000 estimated prompt tokens: over the 100,000-token threshold. Prose-like (a word
	 * and a space): a 400,000-character run with no separator makes the PII scan crawl.
	 */
	const LONG = [{ role: "user", content: "abcd ".repeat(80_000) }];
	const LOW_OUT = HAIKU.outputPer1k;
	const HIGH_OUT = HAIKU.longPrompt?.rates.outputPer1k ?? Number.NaN;
	let vaultBase: string;
	beforeEach(() => {
		vaultBase = join(tmpdir(), `incomplete-tier-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
	});
	afterEach(() => {
		rmSync(vaultBase, { recursive: true, force: true });
	});

	async function settle(client: unknown, stream: boolean): Promise<TrustReceipt> {
		const g = (await trust(client as never, {
			budget: 100_000_000,
			vaultBase,
			_engine: makeEngine(),
			_audit: makeAudit(),
		})) as unknown as Governed;
		const result = (await g.messages.create({
			model: HAIKU_MODEL,
			max_tokens: 10,
			messages: LONG,
		})) as {
			receipt: TrustReceipt;
			response: AsyncIterable<unknown> & { receipt: Promise<TrustReceipt> };
		};
		let receipt = result.receipt;
		if (stream) {
			for await (const _ of result.response) {
				// drain
			}
			receipt = await result.response.receipt;
		}
		await g.destroy();
		return receipt;
	}
	const anthropicHaiku = (usage: unknown) => ({
		messages: {
			create: vi.fn(async () => ({
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				model: HAIKU_MODEL,
				usage,
			})),
		},
	});

	/** The metered estimate at the dearer tier, and the two tiers' prices for 100,000 output tokens. */
	async function bounds(): Promise<{ estimate: number; low: number; high: number }> {
		const estimate = (await settle(anthropicHaiku(undefined), false)).cost;
		const low = (100_000 * LOW_OUT) / 1000;
		const high = (100_000 * HIGH_OUT) / 1000;
		expect(low).toBeLessThan(estimate);
		expect(high).toBeGreaterThan(estimate);
		return { estimate, low, high };
	}

	it("non-stream, input missing, output 100,000: the output at the HIGH tier", async () => {
		const { high } = await bounds();
		const receipt = await settle(anthropicHaiku({ output_tokens: 100_000 }), false);
		expect(receipt.cost).toBe(high);
		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.pricing?.appliedRates.outputPer1k).toBe(HIGH_OUT);
		expect(Object.hasOwn(receipt, "usage")).toBe(false);
	});

	it("stream, no input_tokens, output 100,000: the output at the HIGH tier", async () => {
		const { high } = await bounds();
		const receipt = await settle(
			anthropicStream([start({}), delta({ output_tokens: 100_000 }), STOP]),
			true,
		);
		expect(receipt.cost).toBe(high);
		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.pricing?.appliedRates.outputPer1k).toBe(HIGH_OUT);
		expect(Object.hasOwn(receipt, "usage")).toBe(false);
	});

	it("CONTROL: a complete report under the threshold keeps the LOW tier, whatever authorize held", async () => {
		const receipt = await settle(
			anthropicHaiku({ input_tokens: 1000, output_tokens: 100_000 }),
			false,
		);
		expect(receipt.cost).toBe((1000 * HAIKU.inputPer1k) / 1000 + (100_000 * LOW_OUT) / 1000);
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.pricing?.appliedRates.outputPer1k).toBe(LOW_OUT);
	});
});

describe("the other stream extractors already require both sides (pins)", () => {
	async function complete(
		kind: "openai" | "google",
		chunks: unknown[],
	): Promise<StreamCompletion | undefined> {
		let completion: StreamCompletion | undefined;
		for await (const _ of wrapStream(
			gen(chunks),
			kind,
			(c) => {
				completion = c;
			},
			() => {},
		)) {
			// drain
		}
		return completion;
	}

	it("OpenAI chat: a usage chunk with prompt_tokens only is not reported", async () => {
		expect((await complete("openai", [{ usage: { prompt_tokens: 2000 } }]))?.usageReported).toBe(
			false,
		);
	});

	it("OpenAI chat: a stream cut before its usage chunk is not reported", async () => {
		expect(
			(await complete("openai", [{ choices: [{ delta: { content: "hi" } }] }]))?.usageReported,
		).toBe(false);
	});

	it("OpenAI Responses: a terminal event without usage is not reported", async () => {
		expect(
			(await complete("openai", [{ type: "response.completed", response: {} }]))?.usageReported,
		).toBe(false);
	});

	it("Google: usageMetadata without candidatesTokenCount is not reported, stream or not", async () => {
		expect(
			(await complete("google", [{ usageMetadata: { promptTokenCount: 2000 } }]))?.usageReported,
		).toBe(false);
		expect(fromGeminiUsage({ promptTokenCount: 2000 }).source).toBe("estimated");
	});

	it("CONTROL: each reports when both sides are present", async () => {
		expect(
			(await complete("openai", [{ usage: { prompt_tokens: 2000, completion_tokens: 5 } }]))
				?.usageReported,
		).toBe(true);
		expect(
			(
				await complete("google", [
					{ usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 5 } },
				])
			)?.usageReported,
		).toBe(true);
	});
});
