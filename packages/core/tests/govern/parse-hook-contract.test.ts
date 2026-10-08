// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The fidelity contract of `graftParseHooks` (govern.ts), pinned against the real SDK.
 *
 * The stream helper's parsers read EXACTLY these things off the structured-output format:
 *   1. `'parse' in format`            a `has` check, which a non-enumerable property satisfies;
 *   2. `format.type === 'json_schema'` wire data, which the request snapshot carries;
 *   3. `format.parse(content)`         a METHOD call, so `this` is the object the SDK holds
 *                                      (the graft binds the hook to the original format).
 * The format lives at `params.output_config.format` (stable) or
 * `params.output_format ?? params.output_config.format` (beta).
 *
 * If a future SDK reads anything else (a symbol, a brand check, `instanceof`, an own-key
 * walk), the recorded set below changes and this test fails, so the graft is re-reviewed
 * instead of silently breaking.
 *
 * Verified against @anthropic-ai/sdk 0.116.0.
 */

import { maybeParseBetaMessage } from "@anthropic-ai/sdk/lib/beta-parser.js";
import { maybeParseMessage } from "@anthropic-ai/sdk/lib/parser.js";
import { describe, expect, it } from "vitest";

const MESSAGE = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-sonnet-4-6",
	content: [{ type: "text", text: '{"a":1}' }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 1, output_tokens: 1 },
} as never;

/** A format that records EVERY proxy trap the SDK triggers on it. */
function recordingFormat(log: string[]): object {
	const target = { type: "json_schema", schema: {}, parse: (c: string) => JSON.parse(c) };
	const trap =
		(name: string) =>
		(...args: unknown[]) => {
			const key = args[1];
			log.push(typeof key === "undefined" ? name : `${name}:${String(key)}`);
			return (Reflect as unknown as Record<string, (...a: unknown[]) => unknown>)[name]?.(...args);
		};
	return new Proxy(target, {
		has: trap("has") as never,
		get: trap("get") as never,
		getOwnPropertyDescriptor: trap("getOwnPropertyDescriptor") as never,
		ownKeys: trap("ownKeys") as never,
		getPrototypeOf: trap("getPrototypeOf") as never,
		set: trap("set") as never,
		defineProperty: trap("defineProperty") as never,
		deleteProperty: trap("deleteProperty") as never,
		isExtensible: trap("isExtensible") as never,
		setPrototypeOf: trap("setPrototypeOf") as never,
		preventExtensions: trap("preventExtensions") as never,
	}) as object;
}

const OPTS = { logger: { warn: () => {} } } as never;

describe("graftParseHooks contract: what the SDK's parsers read off a structured-output format", () => {
	it("stable parser reads exactly has(parse), get(type), get(parse)", () => {
		const log: string[] = [];
		const out = maybeParseMessage(
			MESSAGE,
			{ output_config: { format: recordingFormat(log) } } as never,
			OPTS,
		) as { parsed_output: unknown };
		expect(out.parsed_output).toEqual({ a: 1 }); // positive control: the hook really ran
		expect(new Set(log)).toEqual(new Set(["has:parse", "get:type", "get:parse"]));
		// The `in` check is a has-trap, not a get: the non-enumerable graft must satisfy it.
		expect(log).toContain("has:parse");
	});

	it("beta parser reads the same three, from output_format or output_config.format", () => {
		for (const params of [
			(f: object) => ({ output_config: { format: f } }),
			(f: object) => ({ output_format: f }),
		]) {
			const log: string[] = [];
			const out = maybeParseBetaMessage(MESSAGE, params(recordingFormat(log)) as never, OPTS) as {
				parsed_output: unknown;
			};
			expect(out.parsed_output).toEqual({ a: 1 });
			expect(new Set(log)).toEqual(new Set(["has:parse", "get:type", "get:parse"]));
		}
	});

	it("a non-enumerable, bound hook satisfies every one of those reads", () => {
		// What graftParseHooks builds: wire data enumerable, `parse` non-enumerable and bound.
		const original = {
			type: "json_schema",
			schema: {},
			parse(this: unknown, c: string) {
				return { ...JSON.parse(c), ok: this === original };
			},
		};
		const snapshot = { type: "json_schema", schema: {} };
		Object.defineProperty(snapshot, "parse", {
			value: original.parse.bind(original),
			enumerable: false,
			configurable: true,
		});
		expect(JSON.stringify(snapshot)).toBe('{"type":"json_schema","schema":{}}');
		const out = maybeParseMessage(MESSAGE, { output_config: { format: snapshot } } as never, OPTS);
		expect((out as { parsed_output: unknown }).parsed_output).toEqual({ a: 1, ok: true });
	});
});
