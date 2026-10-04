// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import type { MeteredRoute } from "../src/routes.js";
import { createUsageParser } from "../src/usage.js";

const enc = (s: string) => new TextEncoder().encode(s);
const sse = (events: Array<[string | null, unknown]>) =>
	events
		.map(
			([name, data]) =>
				`${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
		)
		.join("");

/** Multi-byte text, so a cut can land inside a UTF-8 sequence. */
const TEXT = "Héllo — 世界 🌍 ok";

const FIXTURES: Array<{
	name: string;
	route: MeteredRoute;
	mode: "STREAM_BYTES" | "WHOLE_BODY_BYTES";
	body: string;
	want: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
}> = [
	{
		name: "anthropic SSE: input from message_start, cumulative output from message_delta",
		route: "anthropic.messages",
		mode: "STREAM_BYTES",
		body: sse([
			[
				"message_start",
				{
					type: "message_start",
					message: {
						id: "m",
						content: [],
						usage: {
							input_tokens: 25,
							cache_creation_input_tokens: 4,
							cache_read_input_tokens: 10,
							output_tokens: 1,
						},
					},
				},
			],
			[
				"content_block_delta",
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TEXT } },
			],
			[
				"message_delta",
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } },
			],
			["message_stop", { type: "message_stop" }],
		]),
		want: { inputTokens: 25, outputTokens: 15, cacheReadTokens: 10, cacheWriteTokens: 4 },
	},
	{
		name: "openai chat SSE: the final include_usage chunk",
		route: "openai.chat",
		mode: "STREAM_BYTES",
		body: sse([
			[
				null,
				{ object: "chat.completion.chunk", choices: [{ delta: { content: TEXT } }], usage: null },
			],
			[
				null,
				{
					object: "chat.completion.chunk",
					choices: [],
					usage: {
						prompt_tokens: 30,
						completion_tokens: 12,
						prompt_tokens_details: { cached_tokens: 8 },
					},
				},
			],
			[null, "[DONE]"],
		]),
		want: { inputTokens: 22, outputTokens: 12, cacheReadTokens: 8, cacheWriteTokens: 0 },
	},
	{
		name: "openai responses SSE: response.completed",
		route: "openai.responses",
		mode: "STREAM_BYTES",
		body: sse([
			["response.created", { type: "response.created", response: { id: "r", usage: null } }],
			["response.output_text.delta", { type: "response.output_text.delta", delta: TEXT }],
			[
				"response.completed",
				{
					type: "response.completed",
					response: {
						id: "r",
						usage: {
							input_tokens: 40,
							output_tokens: 9,
							input_tokens_details: { cached_tokens: 5 },
							output_tokens_details: { reasoning_tokens: 3 },
						},
					},
				},
			],
		]),
		want: { inputTokens: 35, outputTokens: 9, cacheReadTokens: 5, cacheWriteTokens: 0 },
	},
	{
		name: "anthropic JSON",
		route: "anthropic.messages",
		mode: "WHOLE_BODY_BYTES",
		body: JSON.stringify({
			id: "m",
			content: [{ type: "text", text: TEXT }],
			usage: { input_tokens: 5, output_tokens: 7 },
		}),
		want: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
	},
	{
		name: "openai chat JSON",
		route: "openai.chat",
		mode: "WHOLE_BODY_BYTES",
		body: JSON.stringify({
			choices: [{ message: { content: TEXT } }],
			usage: { prompt_tokens: 6, completion_tokens: 8 },
		}),
		want: { inputTokens: 6, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
	},
	{
		name: "openai responses JSON",
		route: "openai.responses",
		mode: "WHOLE_BODY_BYTES",
		body: JSON.stringify({
			output: [{ content: [{ text: TEXT }] }],
			usage: { input_tokens: 3, output_tokens: 4 },
		}),
		want: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
	},
];

function parse(
	route: MeteredRoute,
	mode: "STREAM_BYTES" | "WHOLE_BODY_BYTES",
	units: Uint8Array[],
) {
	const p = createUsageParser(route, mode);
	for (const u of units) p.push(u);
	return p.end();
}

/** `bytes` cut at the given offsets, plus an EMPTY final unit. */
function split(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
	const units: Uint8Array[] = [];
	let at = 0;
	for (const c of cuts) {
		units.push(bytes.slice(at, c));
		at = c;
	}
	units.push(bytes.slice(at), new Uint8Array());
	return units;
}

describe("usage parsers: the result is identical under ANY split into units", () => {
	for (const f of FIXTURES) {
		it(f.name, () => {
			const bytes = enc(f.body);
			const want = { ...f.want, source: "provider" };
			expect(parse(f.route, f.mode, [bytes])).toEqual(want);
			// Every single cut point.
			for (let i = 0; i <= bytes.length; i++) {
				expect(parse(f.route, f.mode, split(bytes, [i])), `cut ${i}`).toEqual(want);
			}
			// Every pair of cut points on a stride, so cuts land inside lines, inside
			// "data:" prefixes, between CR and LF and inside multi-byte characters.
			for (let i = 0; i <= bytes.length; i += 5) {
				for (let j = i; j <= bytes.length; j += 7) {
					expect(parse(f.route, f.mode, split(bytes, [i, j])), `cuts ${i},${j}`).toEqual(want);
				}
			}
			// One byte at a time.
			expect(
				parse(
					f.route,
					f.mode,
					Array.from(bytes, (b) => Uint8Array.of(b)),
				),
			).toEqual(want);
		});
	}

	it("CRLF line endings parse the same as LF", () => {
		const f = FIXTURES[0];
		if (!f) throw new Error("fixture");
		const crlf = enc(f.body.replaceAll("\n", "\r\n"));
		for (let i = 0; i <= crlf.length; i += 3) {
			expect(parse(f.route, f.mode, split(crlf, [i])), `cut ${i}`).toEqual({
				...f.want,
				source: "provider",
			});
		}
	});
});

describe("usage parsers: no provider usage → null (settle at the hold, never a fabricated count)", () => {
	it("a stream with no usage event", () => {
		expect(
			parse("openai.chat", "STREAM_BYTES", [
				enc(
					sse([
						[null, { choices: [] }],
						[null, "[DONE]"],
					]),
				),
			]),
		).toBeNull();
	});
	it("half-reported usage (output only) is not provider usage", () => {
		const body = sse([["message_delta", { type: "message_delta", usage: { output_tokens: 15 } }]]);
		expect(parse("anthropic.messages", "STREAM_BYTES", [enc(body)])).toBeNull();
	});
	it("a JSON body that is not JSON, not an object, or has no usage", () => {
		expect(parse("openai.chat", "WHOLE_BODY_BYTES", [enc("{nope")])).toBeNull();
		expect(parse("openai.chat", "WHOLE_BODY_BYTES", [enc("[1]")])).toBeNull();
		expect(parse("openai.chat", "WHOLE_BODY_BYTES", [enc("{}")])).toBeNull();
	});
	it("a JSON body over the payload maximum", () => {
		const big = new Uint8Array(4 * 1024 * 1024 + 1);
		expect(parse("openai.chat", "WHOLE_BODY_BYTES", [big])).toBeNull();
	});
	it("an SSE line over the line limit gives up rather than buffering without bound", () => {
		const line = enc(`data: ${"x".repeat(1024 * 1024 + 10)}`);
		const tail = enc(`\n\n${sse([[null, { usage: { prompt_tokens: 1, completion_tokens: 1 } }]])}`);
		expect(parse("openai.chat", "STREAM_BYTES", [line, tail])).toBeNull();
	});
	it("a non-JSON data line and an event with no data are ignored, not fatal", () => {
		const body = `event: ping\n\ndata: not json\n\n${sse([[null, { usage: { prompt_tokens: 2, completion_tokens: 3 } }]])}`;
		expect(parse("openai.chat", "STREAM_BYTES", [enc(body)])).toMatchObject({
			inputTokens: 2,
			outputTokens: 3,
		});
	});
	it("the last event is read even without a trailing blank line", () => {
		const body = `data: ${JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 3 } })}`;
		expect(parse("openai.chat", "STREAM_BYTES", [enc(body)])).toMatchObject({
			inputTokens: 2,
			outputTokens: 3,
		});
	});
});
