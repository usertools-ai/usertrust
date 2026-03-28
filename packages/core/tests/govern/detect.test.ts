import { describe, expect, it } from "vitest";
import { detectClientKind } from "../../src/detect.js";

describe("detectClientKind", () => {
	it("detects Anthropic SDK shape (client.messages.create)", () => {
		const mock = { messages: { create: () => {} } };
		expect(detectClientKind(mock)).toBe("anthropic");
	});

	it("detects OpenAI SDK shape (client.chat.completions.create)", () => {
		const mock = { chat: { completions: { create: () => {} } } };
		expect(detectClientKind(mock)).toBe("openai");
	});

	it("detects Google SDK shape (client.models.generateContent)", () => {
		const mock = { models: { generateContent: () => {} } };
		expect(detectClientKind(mock)).toBe("google");
	});

	it("throws for unknown client shape", () => {
		expect(() => detectClientKind({})).toThrow("Unsupported LLM client");
	});

	it("throws for null", () => {
		expect(() => detectClientKind(null)).toThrow("Unsupported LLM client");
	});

	it("throws for undefined", () => {
		expect(() => detectClientKind(undefined)).toThrow("Unsupported LLM client");
	});

	it("throws for primitive values", () => {
		expect(() => detectClientKind(42)).toThrow("Unsupported LLM client");
		expect(() => detectClientKind("string")).toThrow("Unsupported LLM client");
		expect(() => detectClientKind(true)).toThrow("Unsupported LLM client");
	});

	it("throws when messages exists but create is not a function", () => {
		expect(() => detectClientKind({ messages: { create: "not a fn" } })).toThrow(
			"Unsupported LLM client",
		);
	});

	it("throws when chat.completions exists but create is missing", () => {
		expect(() => detectClientKind({ chat: { completions: {} } })).toThrow("Unsupported LLM client");
	});

	it("throws when models exists but generateContent is not a function", () => {
		expect(() => detectClientKind({ models: { generateContent: 123 } })).toThrow(
			"Unsupported LLM client",
		);
	});

	it("prioritises Anthropic when client has both shapes", () => {
		const mock = {
			messages: { create: () => {} },
			chat: { completions: { create: () => {} } },
		};
		// Anthropic check runs first
		expect(detectClientKind(mock)).toBe("anthropic");
	});

	it("detects Anthropic even with extra properties", () => {
		const mock = { messages: { create: () => {}, list: () => {} }, beta: {} };
		expect(detectClientKind(mock)).toBe("anthropic");
	});

	it("detects OpenAI even with extra properties", () => {
		const mock = {
			chat: { completions: { create: () => {} } },
			models: { list: () => {} },
			embeddings: { create: () => {} },
		};
		expect(detectClientKind(mock)).toBe("openai");
	});
});
