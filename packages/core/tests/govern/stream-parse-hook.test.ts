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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type TrustEngine, trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

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

const PAYLOAD = '{"city":"Paris","days":3}';

/** Request bodies the fake provider received, in order. */
const sentBodies: string[] = [];

function fakeFetch(): typeof fetch {
	const stream = sse([
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
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: PAYLOAD } },
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
	const message = {
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: MODEL,
		content: [{ type: "text", text: PAYLOAD }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 9 },
	};
	return (async (_url: unknown, init?: { body?: unknown }) => {
		sentBodies.push(String(init?.body ?? ""));
		const wantsStream = String(init?.body ?? "").includes('"stream":true');
		return wantsStream
			? new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
			: new Response(JSON.stringify(message), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
	}) as unknown as typeof fetch;
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

type StreamCall = (p: unknown) => Promise<{ finalMessage: () => Promise<unknown> }>;
type ParseCall = (p: unknown) => Promise<unknown>;

const EXPECTED = { city: "Paris", days: 3 };
const schema = z.object({ city: z.string(), days: z.number() });
const base = {
	model: MODEL,
	max_tokens: 100,
	messages: [{ role: "user" as const, content: "plan" }],
};

/** The structured output the SDK parsed onto a message (block-level, or message-level). */
function parsedOutput(message: unknown): unknown {
	const m = message as { parsed_output?: unknown; content?: Array<{ parsed_output?: unknown }> };
	return m.content?.find((b) => b.parsed_output != null)?.parsed_output ?? m.parsed_output;
}

describe("a governed call keeps the structured-output parse hook the SDK reads client-side", () => {
	let vault: string;
	beforeEach(() => {
		vault = join(tmpdir(), `sph-${randomUUID()}`);
		mkdirSync(vault, { recursive: true });
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	async function governedClient(config: Record<string, unknown> = {}) {
		// Policy knobs such as `pii` are read from the vault's config file, not from trust()'s opts.
		const dir = join(vault, VAULT_DIR);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "usertrust.config.json"),
			JSON.stringify({ budget: 1_000_000, ...config }),
		);
		const client = new Anthropic({ apiKey: "k", fetch: fakeFetch(), maxRetries: 0 });
		return trust(client, { budget: 1_000_000, vaultBase: vault, _engine: engine() });
	}

	// Governed surfaces that hand the SDK a function off the params: the stream helper (stable
	// and beta) reads `output_config.format.parse` while building the message, and is the one
	// path that receives the request snapshot. The parse helpers run the SDK transform on the
	// caller's ORIGINAL params, and create reads no parse hook, so neither can lose one.
	const cases: Array<
		[string, (g: Awaited<ReturnType<typeof governedClient>>) => Promise<unknown>]
	> = [
		[
			"messages.stream",
			async (g) =>
				(
					await (g as unknown as { messages: { stream: StreamCall } }).messages.stream({
						...base,
						output_config: { format: zodOutputFormat(schema) },
					})
				).finalMessage(),
		],
		[
			"beta.messages.stream",
			async (g) =>
				(
					await (
						g as unknown as { beta: { messages: { stream: StreamCall } } }
					).beta.messages.stream({
						...base,
						output_config: { format: betaZodOutputFormat(schema) },
					})
				).finalMessage(),
		],
		[
			"messages.parse",
			async (g) =>
				(g as unknown as { messages: { parse: ParseCall } }).messages.parse({
					...base,
					output_config: { format: zodOutputFormat(schema) },
				}),
		],
		[
			"beta.messages.parse",
			async (g) =>
				(g as unknown as { beta: { messages: { parse: ParseCall } } }).beta.messages.parse({
					...base,
					output_config: { format: betaZodOutputFormat(schema) },
				}),
		],
	];
	for (const [name, call] of cases) {
		it(`${name}: parsed_output is the parsed object, not null`, async () => {
			const governed = await governedClient();
			const message = await call(governed);
			await governed.destroy();
			// The SDK parses this same payload when ungoverned; null here is the lost hook.
			expect(parsedOutput(message)).toEqual(EXPECTED);
		});
	}

	// pii: "redact" forwards a redacted DEEP CLONE, which copies enumerable properties only.
	const redactCases: Array<[string, (g: unknown, format: unknown) => Promise<unknown>]> = [
		[
			"messages.stream",
			async (g, format) =>
				(
					await (g as { messages: { stream: StreamCall } }).messages.stream({
						...base,
						messages: [{ role: "user", content: "mail me at jane.doe@example.com" }],
						output_config: { format },
					})
				).finalMessage(),
		],
		[
			"beta.messages.stream",
			async (g, format) =>
				(
					await (g as { beta: { messages: { stream: StreamCall } } }).beta.messages.stream({
						...base,
						messages: [{ role: "user", content: "mail me at jane.doe@example.com" }],
						output_config: { format },
					})
				).finalMessage(),
		],
	];
	for (const [name, call] of redactCases) {
		it(`${name} with PII redaction on: the redacted body is sent AND the parse hook survives`, async () => {
			sentBodies.length = 0;
			const governed = await governedClient({ pii: "redact" });
			const format = name.startsWith("beta")
				? betaZodOutputFormat(schema)
				: zodOutputFormat(schema);
			const message = await call(governed, format);
			await governed.destroy();
			// Positive control: redaction really ran on what left the process...
			expect(sentBodies.join("")).toContain("[REDACTED:email]");
			expect(sentBodies.join("")).not.toContain("jane.doe@example.com");
			// ...and the structured output still parsed.
			expect(parsedOutput(message)).toEqual(EXPECTED);
		});
	}

	// A custom format whose `parse` keeps private state must run against ITS OWN receiver, not
	// the plain-data snapshot the hook was grafted onto.
	it("messages.stream with a receiver-dependent parser: parse runs on the original format", async () => {
		class StatefulFormat {
			readonly type = "json_schema";
			readonly schema = { type: "object", properties: {} };
			#seen = 0;
			parse(content: string): unknown {
				this.#seen += 1; // throws a TypeError if `this` is not a StatefulFormat
				return { ...(JSON.parse(content) as object), seen: this.#seen };
			}
		}
		const governed = await governedClient();
		const stream = await (
			governed as unknown as { messages: { stream: StreamCall } }
		).messages.stream({
			...base,
			output_config: { format: new StatefulFormat() },
		});
		const message = await stream.finalMessage();
		await governed.destroy();
		expect(parsedOutput(message)).toEqual({ ...EXPECTED, seen: 1 });
	});
});
