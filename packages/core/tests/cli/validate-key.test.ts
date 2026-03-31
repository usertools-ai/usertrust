import { describe, expect, it, vi } from "vitest";
import { detectProvider, maskKey, validateKey } from "../../src/cli/validate-key.js";

describe("detectProvider", () => {
	it("detects Anthropic from sk-ant- prefix", () => {
		expect(detectProvider("sk-ant-api03-abc123")).toBe("anthropic");
	});

	it("detects OpenAI from sk- prefix (not sk-ant-)", () => {
		expect(detectProvider("sk-proj-abc123def456")).toBe("openai");
	});

	it("detects Google from AIza prefix", () => {
		expect(detectProvider("AIzaSyAbcdef123456")).toBe("google");
	});

	it("returns null for unrecognized key", () => {
		expect(detectProvider("some-random-key-format")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(detectProvider("")).toBeNull();
	});
});

describe("maskKey", () => {
	it("masks key showing first 8 chars", () => {
		expect(maskKey("sk-ant-api03-longkey123")).toBe("sk-ant-a••••••••");
	});

	it("masks short keys entirely", () => {
		expect(maskKey("short")).toBe("••••••••");
	});
});

describe("validateKey", () => {
	it("returns success for valid Anthropic key", async () => {
		global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });
		const result = await validateKey("sk-ant-api03-abc", "anthropic");
		expect(result.valid).toBe(true);
	});

	it("returns failure for invalid Anthropic key", async () => {
		global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 });
		const result = await validateKey("sk-ant-api03-bad", "anthropic");
		expect(result.valid).toBe(false);
	});

	it("returns failure on network error", async () => {
		global.fetch = vi.fn().mockRejectedValueOnce(new Error("fetch failed"));
		const result = await validateKey("sk-ant-api03-abc", "anthropic");
		expect(result.valid).toBe(false);
		expect(result.error).toContain("fetch failed");
	});

	it("returns success for valid OpenAI key", async () => {
		global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });
		const result = await validateKey("sk-proj-abc", "openai");
		expect(result.valid).toBe(true);
	});

	it("returns success for valid Google key", async () => {
		global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });
		const result = await validateKey("AIzaSyAbc", "google");
		expect(result.valid).toBe(true);
	});

	it("returns valid: true for unknown provider (skips validation)", async () => {
		const result = await validateKey("some-key", "custom-provider");
		expect(result.valid).toBe(true);
	});
});
