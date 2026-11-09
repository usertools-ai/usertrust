// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { providerOf } from "../src/shared/provider.js";
import { detectProvider, toLedgerRows } from "../src/shared/rows.js";

describe("detectProvider", () => {
	it("recognises xAI models by their prefix", () => {
		expect(detectProvider("grok-4.7")).toBe("xai");
	});

	it("keeps the providers it already knew", () => {
		expect(detectProvider("claude-sonnet-4-6")).toBe("anthropic");
		expect(detectProvider("gpt-5")).toBe("openai");
		expect(detectProvider("gemini-2")).toBe("google");
		expect(detectProvider("command-r")).toBe("cohere");
		expect(detectProvider("mistral-large")).toBe("mistral");
		expect(detectProvider("something-else")).toBe("unknown");
	});
});

describe("providerOf", () => {
	it("names xAI from a grok model", () => {
		expect(providerOf({ model: "grok-4.7" })).toBe("xAI");
	});

	it("lets the recorded provider win over the model", () => {
		expect(providerOf({ providerRecorded: "anthropic", model: "x" })).toBe("Anthropic");
		expect(providerOf({ providerRecorded: "openai", model: "claude-sonnet-4-6" })).toBe("OpenAI");
	});

	it("reads the recorded provider case-insensitively and knows each name", () => {
		expect(providerOf({ providerRecorded: "XAI" })).toBe("xAI");
		expect(providerOf({ providerRecorded: "google" })).toBe("Google");
	});

	it("falls to the model prefix when nothing is recorded", () => {
		expect(providerOf({ model: "claude-sonnet-4-6" })).toBe("Anthropic");
		expect(providerOf({ model: "gpt-5" })).toBe("OpenAI");
		expect(providerOf({ model: "o3-mini" })).toBe("OpenAI");
		expect(providerOf({ model: "gemini-2" })).toBe("Google");
		expect(providerOf({ providerRecorded: "", model: "grok-4.7" })).toBe("xAI");
	});

	it("maps cohere, mistral, unknown and a row with neither to Other", () => {
		expect(providerOf({ model: "command-r" })).toBe("Other");
		expect(providerOf({ model: "mistral-large" })).toBe("Other");
		expect(providerOf({ providerRecorded: "cohere" })).toBe("Other");
		expect(providerOf({ providerRecorded: "unknown", model: "x" })).toBe("Other");
		expect(providerOf({})).toBe("Other");
	});

	it("reads the provider a record carried through toLedgerRows", () => {
		const [row] = toLedgerRows(
			[
				{
					id: "e1",
					timestamp: "2026-11-01T00:00:00.000Z",
					kind: "llm_call",
					actor: "a",
					data: { model: "grok-4.7", provider: "xai", cost: 10 },
					hash: "a".repeat(64),
					previousHash: "b".repeat(64),
				} as never,
			],
			{ valid: true, breakIndex: null },
			undefined,
			0,
		);
		expect(row?.provider).toBe("xai");
		expect(row?.providerRecorded).toBe("xai");
		expect(providerOf(row as never)).toBe("xAI");
	});
});
