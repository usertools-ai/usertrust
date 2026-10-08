// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The request snapshot must not strip the SDK's structured-output parse hook.
 *
 * trust() forwards the plain-data parse of the request it scanned, and JSON drops a function.
 * The Anthropic stream helper reads `output_config.format.parse` (`zodOutputFormat`) off its
 * params to build `parsed_output`, so a stripped snapshot would silently return
 * `parsed_output: null`. Driven through the REAL SDK's MessageStream over a fake fetch.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type TrustEngine, trust } from "../../src/govern.js";

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

const sse = (events: Array<[string, unknown]>): string =>
	events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

function fakeFetch(): typeof fetch {
	const body = sse([
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: MODEL,
					content: [],
					stop_reason: null,
					usage: { input_tokens: 10, output_tokens: 1 },
				},
			},
		],
		[
			"content_block_start",
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		],
		[
			"content_block_delta",
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: '{"city":"Paris","days":3}' },
			},
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 9 },
			},
		],
		["message_stop", { type: "message_stop" }],
	]);
	return (async () =>
		new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		})) as unknown as typeof fetch;
}

function engine(): TrustEngine {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async (_id: string, actual?: number) => ({
			posted: actual ?? 0,
			shortfall: 0,
		})),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	} as unknown as TrustEngine;
}

describe("stream helper keeps the SDK's structured-output parse hook", () => {
	let vault: string;
	beforeEach(() => {
		vault = join(tmpdir(), `sph-${randomUUID()}`);
		mkdirSync(vault, { recursive: true });
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	it("parsed_output is the parsed object, not null", async () => {
		const client = new Anthropic({ apiKey: "k", fetch: fakeFetch(), maxRetries: 0 });
		const governed = await trust(client, {
			budget: 1_000_000,
			vaultBase: vault,
			_engine: engine(),
		});
		const schema = z.object({ city: z.string(), days: z.number() });
		const stream = governed.messages.stream({
			model: MODEL,
			max_tokens: 100,
			messages: [{ role: "user", content: "plan" }],
			output_config: { format: zodOutputFormat(schema) },
		});
		const final = await (await stream).finalMessage();
		await governed.destroy();
		const text = final.content.find((b) => b.type === "text") as
			| { parsed_output?: unknown }
			| undefined;
		// Positive control for the assertion: the unwrapped SDK parses this same payload.
		expect(text?.parsed_output).toEqual({ city: "Paris", days: 3 });
	});
});
