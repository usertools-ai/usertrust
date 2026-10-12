// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * An absurd count on ANY stream path is remembered to the settle. The OpenAI and Google extractors zero an implausible
 * snapshot and mark it unreported, but a plausible EARLIER chunk had already set `usageReported`, so the settle priced
 * zeroed counts under a provider label (the 1-usertoken floor) with no event: an underbill nobody could see.
 */

import { randomUUID } from "node:crypto";
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
						create: vi.fn(async () =>
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
					create: vi.fn(async () => ({
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
