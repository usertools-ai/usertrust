// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * An absurd count on ANY stream path is remembered to the settle. The OpenAI and Google extractors zero an implausible
 * snapshot and mark it unreported, but a plausible EARLIER chunk had already set `usageReported`, so the settle priced
 * zeroed counts under a provider label (the 1-usertoken floor) with no event: an underbill nobody could see.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { trust } from "../../src/govern.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";
import { wrapStream } from "../../src/streaming.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

async function* gen<T>(items: T[]): AsyncGenerator<T> {
	for (const i of items) yield i;
}

async function run(kind: "openai" | "google" | "anthropic", chunks: unknown[]) {
	let completion: Parameters<Parameters<typeof wrapStream>[2]>[0] | undefined;
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

const HUGE = 1e12;

describe("streams keep an implausible count to the settle", () => {
	it("OpenAI chat: a plausible chunk then an absurd one", async () => {
		const c = await run("openai", [
			{ usage: { prompt_tokens: 100, completion_tokens: 10 } },
			{ usage: { prompt_tokens: HUGE, completion_tokens: 10 } },
		]);
		expect(c?.implausible).toMatchObject({ inputTokens: HUGE });
	});

	it("OpenAI responses: the terminal event carries an absurd count", async () => {
		const c = await run("openai", [
			{
				type: "response.completed",
				response: { usage: { input_tokens: 10, output_tokens: HUGE } },
			},
		]);
		expect(c?.implausible).toMatchObject({ outputTokens: HUGE });
	});

	it("Google: a plausible chunk then an absurd one", async () => {
		const c = await run("google", [
			{ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
			{ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: HUGE } },
		]);
		expect(c?.implausible).toMatchObject({ outputTokens: HUGE });
	});

	it("Anthropic: an absurd cache tier on message_start", async () => {
		const c = await run("anthropic", [
			{
				type: "message_start",
				message: { usage: { input_tokens: 10, cache_read_input_tokens: HUGE } },
			},
		]);
		expect(c?.implausible).toMatchObject({ cacheReadTokens: HUGE });
	});

	it("CONTROL: plausible usage on every path leaves no record", async () => {
		expect(
			(await run("openai", [{ usage: { prompt_tokens: 100, completion_tokens: 10 } }]))
				?.implausible,
		).toBeUndefined();
		expect(
			(await run("google", [{ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }]))
				?.implausible,
		).toBeUndefined();
		expect(
			(
				await run("anthropic", [
					{ type: "message_start", message: { usage: { input_tokens: 10 } } },
				])
			)?.implausible,
		).toBeUndefined();
	});
});

function makeAudit(failLlmCall = false): AuditWriter & { events: AppendEventInput[] } {
	const events: AppendEventInput[] = [];
	return {
		events,
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			if (failLlmCall && input.kind === "llm_call") throw new Error("disk full");
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

describe("end to end through trust()", () => {
	it("an OpenAI chat stream whose second chunk is absurd settles at the estimate and records the event", async () => {
		const vaultBase = join(tmpdir(), `absurd-streams-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		try {
			const audit = makeAudit();
			const client = {
				chat: {
					completions: {
						create: vi.fn(async (_req: unknown) =>
							gen([
								{ choices: [{ delta: { content: "hi" } }] },
								{ usage: { prompt_tokens: 100, completion_tokens: 10 } },
								{ usage: { prompt_tokens: HUGE, completion_tokens: 10 } },
							]),
						),
					},
				},
			};
			const g = await trust(client, { budget: 100_000, vaultBase, dryRun: true, _audit: audit });
			const result = (await g.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hello" }],
				stream: true,
			})) as { response: AsyncIterable<unknown> & { receipt: Promise<TrustReceipt> } };
			const stream = result.response;
			for await (const _ of stream) {
				// drain
			}
			const receipt = await stream.receipt;
			expect(receipt.usageSource).toBe("estimated");
			const kinds = audit.events.map((e) => e.kind);
			expect(kinds).toContain("usage_implausible");
			expect(kinds.indexOf("usage_implausible")).toBeGreaterThan(kinds.indexOf("llm_call"));
			await g.destroy();
		} finally {
			rmSync(vaultBase, { recursive: true, force: true });
		}
	});

	it("a FAILED llm_call append is never followed by a usage_implausible event", async () => {
		const vaultBase = join(tmpdir(), `absurd-streams-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		try {
			const audit = makeAudit(true);
			const client = {
				messages: {
					create: vi.fn(async (_req: unknown) => ({
						id: "m",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						model: "claude-sonnet-4-6",
						usage: { input_tokens: HUGE, output_tokens: 1 },
					})),
				},
			};
			const g = await trust(client, { budget: 100_000, vaultBase, dryRun: true, _audit: audit });
			await g.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 16,
				messages: [{ role: "user", content: "hello" }],
			});
			expect(audit.events.map((e) => e.kind)).not.toContain("usage_implausible");
			await g.destroy();
		} finally {
			rmSync(vaultBase, { recursive: true, force: true });
		}
	});
});

describe("an absurd 1-hour share survives every Anthropic stream path", () => {
	const START = {
		type: "message_start",
		message: {
			usage: {
				input_tokens: 10,
				cache_creation_input_tokens: 100,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: HUGE },
			},
		},
	};

	it("wrapStream keeps it in the implausible record", async () => {
		const c = await run("anthropic", [START]);
		expect(c?.implausible).toMatchObject({ cacheWrite1hTokens: HUGE });
	});

	it("two TTL counters near 1e308 sum to Infinity; the finite 1h figure is still reported", async () => {
		const c = await run("anthropic", [
			{
				type: "message_start",
				message: {
					usage: {
						input_tokens: 10,
						cache_creation: {
							ephemeral_5m_input_tokens: 1e308,
							ephemeral_1h_input_tokens: 1e308,
						},
					},
				},
			},
		]);
		expect(c?.implausible).toMatchObject({ cacheWrite1hTokens: 1e308 });
	});

	class Emitter extends EventEmitter {
		finalMessage(): Promise<unknown> {
			return Promise.resolve({});
		}
		async *[Symbol.asyncIterator](): AsyncIterator<unknown> {}
	}

	it("MessageStream emitter: settles at the estimate and records the event on a model with the tier", async () => {
		const vaultBase = join(tmpdir(), `absurd-streams-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		try {
			const audit = makeAudit();
			const stream = new Emitter();
			const g = await trust(
				{
					messages: {
						create: vi.fn((_req: unknown) => undefined),
						stream: vi.fn((_req: unknown) => stream),
					},
				},
				{ budget: 100_000, vaultBase, dryRun: true, _audit: audit },
			);
			const handle = (await g.messages.stream({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "hello" }],
			})) as Emitter & { receipt: Promise<TrustReceipt> };
			stream.emit("streamEvent", START);
			stream.emit("finalMessage", {
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_creation_input_tokens: 100,
					cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: HUGE },
				},
			});
			stream.emit("end");
			const receipt = await handle.receipt;
			expect(receipt.usageSource).toBe("estimated");
			expect(audit.events.find((e) => e.kind === "usage_implausible")?.data).toMatchObject({
				tiers: { cacheWrite1hTokens: HUGE },
			});
			await g.destroy();
		} finally {
			rmSync(vaultBase, { recursive: true, force: true });
		}
	});
});

describe("an absurd chunk never reaches the anomaly detector's observation", () => {
	it("wrapStream: a raw input_tokens above the ceiling is reported and observed as ZERO", async () => {
		const seen: Array<{ deltaTokens: number; cumulativeInputTokens: number }> = [];
		let completion: Parameters<Parameters<typeof wrapStream>[2]>[0] | undefined;
		for await (const _ of wrapStream(
			gen([{ type: "message_start", message: { usage: { input_tokens: HUGE } } }]),
			"anthropic",
			(c) => {
				completion = c;
			},
			() => {},
			(obs) => seen.push(obs),
		)) {
			// drain
		}
		expect(seen[0]).toMatchObject({ deltaTokens: 0, cumulativeInputTokens: 0 });
		expect(completion?.implausible).toMatchObject({ inputTokens: HUGE });
	});

	it("merged behaviours: an absurd chunk is observed as zero AND a failing settle still surfaces in the iteration", async () => {
		const seen: number[] = [];
		const failure = new Error("settle refused (audit degraded)");
		await expect(
			(async () => {
				for await (const _ of wrapStream(
					gen([{ type: "message_start", message: { usage: { input_tokens: HUGE } } }]),
					"anthropic",
					async () => {
						throw failure;
					},
					() => {},
					(obs) => seen.push(obs.deltaTokens),
				)) {
					// drain
				}
			})(),
		).rejects.toBe(failure);
		expect(seen).toEqual([0]);
	});

	class Emitter extends EventEmitter {
		finalMessage(): Promise<unknown> {
			return Promise.resolve({});
		}
		async *[Symbol.asyncIterator](): AsyncIterator<unknown> {}
	}

	it("MessageStream emitter: an absurd chunk settles at the estimate, the call is not voided, and the next call is not tripped", async () => {
		const vaultBase = join(tmpdir(), `absurd-streams-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		try {
			const audit = makeAudit();
			const streams = [new Emitter(), new Emitter()];
			let n = 0;
			const g = await trust(
				{
					messages: {
						create: vi.fn((_req: unknown) => undefined),
						stream: vi.fn((_req: unknown) => streams[n++]),
					},
				},
				{ budget: 100_000, vaultBase, dryRun: true, _audit: audit },
			);
			const req = {
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "hello" }],
			};
			const first = (await g.messages.stream(req)) as Emitter & { receipt: Promise<TrustReceipt> };
			streams[0]?.emit("streamEvent", {
				type: "message_start",
				message: { usage: { input_tokens: HUGE } },
			});
			streams[0]?.emit("finalMessage", { usage: { input_tokens: HUGE, output_tokens: 5 } });
			streams[0]?.emit("end");
			const r1 = await first.receipt;
			expect(r1.settled).toBe(true);
			expect(r1.usageSource).toBe("estimated");
			// the next, normal call is not tripped
			const second = (await g.messages.stream(req)) as Emitter & { receipt: Promise<TrustReceipt> };
			streams[1]?.emit("finalMessage", { usage: { input_tokens: 10, output_tokens: 5 } });
			streams[1]?.emit("end");
			const r2 = await second.receipt;
			expect(r2.usageSource).toBe("provider");
			await g.destroy();
		} finally {
			rmSync(vaultBase, { recursive: true, force: true });
		}
	});

	it("a finalMessage with only an absurd cache tier (no headline counts) still reports it", async () => {
		const vaultBase = join(tmpdir(), `absurd-streams-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		try {
			const audit = makeAudit();
			const stream = new Emitter();
			const g = await trust(
				{
					messages: {
						create: vi.fn((_req: unknown) => undefined),
						stream: vi.fn((_req: unknown) => stream),
					},
				},
				{ budget: 100_000, vaultBase, dryRun: true, _audit: audit },
			);
			const h = (await g.messages.stream({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "hello" }],
			})) as Emitter & { receipt: Promise<TrustReceipt> };
			stream.emit("finalMessage", { usage: { cache_read_input_tokens: HUGE } });
			stream.emit("end");
			await h.receipt;
			expect(audit.events.find((e) => e.kind === "usage_implausible")?.data).toMatchObject({
				tiers: { cacheReadTokens: HUGE },
			});
			await g.destroy();
		} finally {
			rmSync(vaultBase, { recursive: true, force: true });
		}
	});
});
