// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { classifyEndpoint } from "../../src/detect.js";
import { type TrustConfig, TrustConfigSchema } from "../../src/shared/types.js";

function makeConfig(overrides: Record<string, unknown> = {}): TrustConfig {
	return TrustConfigSchema.parse({ budget: 1000, ...overrides });
}

/** Minimal OpenAI-SDK-shaped client with an optional baseURL. */
function openaiClient(baseURL?: string | unknown): unknown {
	const client: Record<string, unknown> = {
		chat: { completions: { create: () => Promise.resolve({}) } },
	};
	if (baseURL !== undefined) client.baseURL = baseURL;
	return client;
}

describe("classifyEndpoint — loopback autodetect", () => {
	it("classifies http://localhost:11434/v1 as local/ollama", () => {
		const info = classifyEndpoint(openaiClient("http://localhost:11434/v1"), makeConfig());
		expect(info.class).toBe("local");
		expect(info.runtime).toBe("ollama");
		expect(info.baseURL).toBe("http://localhost:11434/v1");
	});

	it("classifies http://127.0.0.1:1234/v1 as local/lmstudio", () => {
		const info = classifyEndpoint(openaiClient("http://127.0.0.1:1234/v1"), makeConfig());
		expect(info.class).toBe("local");
		expect(info.runtime).toBe("lmstudio");
	});

	it("classifies http://[::1]:8000/v1 as local/vllm (IPv6 brackets normalized)", () => {
		const info = classifyEndpoint(openaiClient("http://[::1]:8000/v1"), makeConfig());
		expect(info.class).toBe("local");
		expect(info.runtime).toBe("vllm");
	});

	it("classifies the IPv4-mapped IPv6 loopback http://[::ffff:127.0.0.1]:11434 as local/ollama (F6)", () => {
		// Node serializes ::ffff:127.0.0.1 to ::ffff:7f00:1 — the loopback set must
		// carry that WHATWG form, not the human dotted spelling, or it classifies cloud.
		const info = classifyEndpoint(openaiClient("http://[::ffff:127.0.0.1]:11434/v1"), makeConfig());
		expect(info.class).toBe("local");
		expect(info.runtime).toBe("ollama");
	});

	it("classifies http://localhost:9999/v1 as local/openai-compat (unknown port)", () => {
		const info = classifyEndpoint(openaiClient("http://localhost:9999/v1"), makeConfig());
		expect(info.class).toBe("local");
		expect(info.runtime).toBe("openai-compat");
	});

	it("is case-insensitive on the hostname", () => {
		const info = classifyEndpoint(openaiClient("http://LOCALHOST:11434/v1"), makeConfig());
		expect(info.class).toBe("local");
		expect(info.runtime).toBe("ollama");
	});

	it("classifies loopback as cloud when autoDetectLoopback is false", () => {
		const config = makeConfig({ local: { autoDetectLoopback: false } });
		const info = classifyEndpoint(openaiClient("http://localhost:11434/v1"), config);
		expect(info.class).toBe("cloud");
		expect(info.runtime).toBe("unknown");
	});
});

describe("classifyEndpoint — config.endpoints matchers", () => {
	it("matches a scheme entry by origin, ignoring path/query/trailing slash", () => {
		const config = makeConfig({
			endpoints: [{ match: "http://gpu-box:8000", class: "local", runtime: "vllm" }],
		});
		for (const baseURL of [
			"http://gpu-box:8000",
			"http://gpu-box:8000/",
			"http://gpu-box:8000/v1",
			"http://gpu-box:8000/v1?x=1",
		]) {
			const info = classifyEndpoint(openaiClient(baseURL), config);
			expect(info.class, baseURL).toBe("local");
			expect(info.runtime, baseURL).toBe("vllm");
		}
	});

	it("scheme entries with a path still match by origin", () => {
		const config = makeConfig({
			endpoints: [{ match: "http://gpu-box:8000/v1/", class: "local", runtime: "vllm" }],
		});
		const info = classifyEndpoint(openaiClient("http://gpu-box:8000/other"), config);
		expect(info.class).toBe("local");
	});

	it("A1 adversarial: http://gpu-box:8000.evil.com does NOT match http://gpu-box:8000", () => {
		const config = makeConfig({
			endpoints: [{ match: "http://gpu-box:8000", class: "local", runtime: "vllm" }],
		});
		// Non-numeric port makes this an invalid URL — treated as absent, never a match.
		let info: ReturnType<typeof classifyEndpoint> | undefined;
		expect(() => {
			info = classifyEndpoint(openaiClient("http://gpu-box:8000.evil.com/v1"), config);
		}).not.toThrow();
		expect(info?.class).toBe("cloud");
		expect(info?.runtime).toBe("unknown");
	});

	it("A1 adversarial: http://gpu-box:8000@evil.com does NOT match http://gpu-box:8000", () => {
		const config = makeConfig({
			endpoints: [{ match: "http://gpu-box:8000", class: "local", runtime: "vllm" }],
		});
		// "gpu-box:8000" parses as userinfo; the real host is evil.com → origin mismatch.
		const info = classifyEndpoint(openaiClient("http://gpu-box:8000@evil.com/v1"), config);
		expect(info.class).toBe("cloud");
		expect(info.runtime).toBe("unknown");
	});

	it("scheme mismatch does not match (https entry vs http baseURL)", () => {
		const config = makeConfig({
			endpoints: [{ match: "https://gpu-box:8000", class: "local", runtime: "vllm" }],
		});
		const info = classifyEndpoint(openaiClient("http://gpu-box:8000/v1"), config);
		expect(info.class).toBe("cloud");
	});

	it("*.gpu.internal matches subdomains at any depth but not the bare domain", () => {
		const config = makeConfig({
			endpoints: [{ match: "*.gpu.internal", class: "local", runtime: "openai-compat" }],
		});
		expect(classifyEndpoint(openaiClient("http://a.gpu.internal:8000/v1"), config).class).toBe(
			"local",
		);
		expect(classifyEndpoint(openaiClient("http://x.y.gpu.internal:1234/v1"), config).class).toBe(
			"local",
		);
		expect(classifyEndpoint(openaiClient("http://gpu.internal:8000/v1"), config).class).toBe(
			"cloud",
		);
	});

	it("A1 adversarial: *.gpu.internal does not match evilgpu.internal or gpu.internal.evil.com", () => {
		const config = makeConfig({
			endpoints: [{ match: "*.gpu.internal", class: "local", runtime: "openai-compat" }],
		});
		expect(classifyEndpoint(openaiClient("http://evilgpu.internal:8000/v1"), config).class).toBe(
			"cloud",
		);
		expect(
			classifyEndpoint(openaiClient("http://a.gpu.internal.evil.com:8000/v1"), config).class,
		).toBe("cloud");
	});

	it("bare hostname entries match case-insensitively on any port", () => {
		const config = makeConfig({
			endpoints: [{ match: "GPU-BOX", class: "local", runtime: "ollama" }],
		});
		const info = classifyEndpoint(openaiClient("http://gpu-box:9999/v1"), config);
		expect(info.class).toBe("local");
		expect(info.runtime).toBe("ollama");
	});

	it("first matching entry wins", () => {
		const config = makeConfig({
			endpoints: [
				{ match: "*.internal", class: "cloud", runtime: "unknown" },
				{ match: "*.gpu.internal", class: "local", runtime: "vllm" },
			],
		});
		const info = classifyEndpoint(openaiClient("http://a.gpu.internal:8000/v1"), config);
		expect(info.class).toBe("cloud");
	});

	it("config.endpoints entries take precedence over loopback autodetect", () => {
		const config = makeConfig({
			endpoints: [{ match: "http://localhost:11434", class: "cloud", runtime: "unknown" }],
		});
		const info = classifyEndpoint(openaiClient("http://localhost:11434/v1"), config);
		expect(info.class).toBe("cloud");
	});

	it("an unparseable scheme entry is skipped without throwing", () => {
		const config = makeConfig({
			endpoints: [{ match: "http://", class: "cloud", runtime: "unknown" }],
		});
		// Entry parse fails → skipped → loopback autodetect still applies.
		const info = classifyEndpoint(openaiClient("http://localhost:11434/v1"), config);
		expect(info.class).toBe("local");
		expect(info.runtime).toBe("ollama");
	});
});

describe("classifyEndpoint — override", () => {
	it("override.class wins over loopback autodetect", () => {
		const info = classifyEndpoint(openaiClient("http://localhost:11434/v1"), makeConfig(), {
			class: "cloud",
		});
		expect(info.class).toBe("cloud");
		expect(info.runtime).toBe("unknown");
	});

	it("override.class wins over config.endpoints matchers", () => {
		const config = makeConfig({
			endpoints: [{ match: "http://gpu-box:8000", class: "local", runtime: "vllm" }],
		});
		const info = classifyEndpoint(openaiClient("http://gpu-box:8000/v1"), config, {
			class: "cloud",
		});
		expect(info.class).toBe("cloud");
	});

	it("override can force local on a cloud URL, defaulting runtime to unknown", () => {
		const info = classifyEndpoint(openaiClient("https://api.openai.com/v1"), makeConfig(), {
			class: "local",
		});
		expect(info.class).toBe("local");
		expect(info.runtime).toBe("unknown");
	});

	it("override carries an explicit runtime", () => {
		const info = classifyEndpoint(openaiClient("https://api.openai.com/v1"), makeConfig(), {
			class: "local",
			runtime: "vllm",
		});
		expect(info.runtime).toBe("vllm");
	});

	it("override without class does not short-circuit classification", () => {
		const info = classifyEndpoint(openaiClient("http://localhost:11434/v1"), makeConfig(), {
			runtime: "vllm",
		});
		// No override.class → normal flow; loopback wins and port hint applies.
		expect(info.class).toBe("local");
		expect(info.runtime).toBe("ollama");
	});
});

describe("classifyEndpoint — cloud defaults and malformed input", () => {
	it("classifies a client without baseURL as cloud", () => {
		const info = classifyEndpoint(openaiClient(), makeConfig());
		expect(info).toEqual({ class: "cloud", runtime: "unknown" });
	});

	it("classifies a non-string baseURL as cloud", () => {
		const info = classifyEndpoint(openaiClient(42), makeConfig());
		expect(info).toEqual({ class: "cloud", runtime: "unknown" });
	});

	it("treats a malformed baseURL string as absent (cloud, no throw)", () => {
		let info: ReturnType<typeof classifyEndpoint> | undefined;
		expect(() => {
			info = classifyEndpoint(openaiClient("not a url at all"), makeConfig());
		}).not.toThrow();
		expect(info?.class).toBe("cloud");
		expect(info?.runtime).toBe("unknown");
	});

	it("classifies https://api.openai.com/v1 as cloud", () => {
		const info = classifyEndpoint(openaiClient("https://api.openai.com/v1"), makeConfig());
		expect(info.class).toBe("cloud");
		expect(info.runtime).toBe("unknown");
		expect(info.baseURL).toBe("https://api.openai.com/v1");
	});

	it("classifies a non-object client as cloud", () => {
		expect(classifyEndpoint(null, makeConfig())).toEqual({ class: "cloud", runtime: "unknown" });
		expect(classifyEndpoint("client", makeConfig())).toEqual({
			class: "cloud",
			runtime: "unknown",
		});
	});
});
