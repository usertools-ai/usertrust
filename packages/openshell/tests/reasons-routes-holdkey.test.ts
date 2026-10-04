// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { holdKey } from "../src/hold-key.js";
import { DenyReason, REASON_CODE_PATTERN } from "../src/reasons.js";
import { DEFAULT_ROUTE_CONFIG, matchRoute, normalizeHost, normalizePath } from "../src/routes.js";

describe("reason codes", () => {
	it("every deny reason matches OpenShell's reason_code grammar and is distinct", () => {
		const codes = Object.values(DenyReason);
		for (const c of codes) expect(c, c).toMatch(REASON_CODE_PATTERN);
		expect(new Set(codes).size).toBe(codes.length);
	});
	it("control: the grammar rejects what OpenShell rejects", () => {
		for (const bad of ["", "Budget", "1x", "a-b", "a".repeat(65)]) {
			expect(bad).not.toMatch(REASON_CODE_PATTERN);
		}
	});
});

describe("route matching — default-deny", () => {
	const m = (method: string, host: string, path: string) =>
		matchRoute(method, host, path, DEFAULT_ROUTE_CONFIG);

	it("the three v1 routes are metered", () => {
		expect(m("POST", "api.anthropic.com", "/v1/messages")).toEqual({
			kind: "metered",
			provider: "anthropic",
			route: "anthropic.messages",
		});
		expect(m("POST", "api.openai.com", "/v1/chat/completions")).toMatchObject({
			route: "openai.chat",
		});
		expect(m("POST", "api.openai.com", "/v1/responses")).toMatchObject({
			route: "openai.responses",
		});
	});

	it("host case, :443, a query string and a trailing slash do not change the match", () => {
		expect(m("post", "API.OpenAI.com:443", "/v1/responses/?x=1")).toMatchObject({
			route: "openai.responses",
		});
		expect(normalizeHost(" Api.Anthropic.COM:443 ")).toBe("api.anthropic.com");
		expect(normalizePath("/")).toBe("/");
	});

	it("every other route on a metered host is unsupported — billable endpoints are never default-allowed", () => {
		for (const p of [
			"/v1/embeddings",
			"/v1/images/generations",
			"/v1/audio/speech",
			"/v1/batches",
			"/v1/files",
			"/v1/messages/batches",
			"/v1/messages/count_tokens",
		]) {
			expect(m("POST", "api.openai.com", p).kind, p).toBe("unsupported");
			expect(m("POST", "api.anthropic.com", p).kind, p).toBe("unsupported");
		}
		expect(m("GET", "api.openai.com", "/v1/models").kind).toBe("unsupported");
		expect(m("GET", "api.anthropic.com", "/v1/messages").kind, "GET on a metered path").toBe(
			"unsupported",
		);
	});

	it("a route of the OTHER provider's wire, an unknown host and prototype names are unsupported", () => {
		expect(m("POST", "api.anthropic.com", "/v1/chat/completions").kind).toBe("unsupported");
		expect(m("POST", "evil.example", "/v1/messages").kind).toBe("unsupported");
		expect(m("POST", "constructor", "/v1/messages").kind).toBe("unsupported");
		expect(m("POST", "api.openai.com", "/constructor").kind).toBe("unsupported");
		expect(m("POST", "__proto__", "/__proto__").kind).toBe("unsupported");
	});

	it("an allowlisted non-billable route passes through; the allowlist is empty by default", () => {
		expect(DEFAULT_ROUTE_CONFIG.passthrough).toEqual([]);
		const config = {
			...DEFAULT_ROUTE_CONFIG,
			passthrough: [{ method: "get", path: "/v1/models" }],
		};
		expect(matchRoute("GET", "api.openai.com", "/v1/models", config)).toEqual({
			kind: "passthrough",
		});
		expect(matchRoute("POST", "api.openai.com", "/v1/models", config).kind).toBe("unsupported");
	});
});

describe("hold key", () => {
	it("is deterministic, 64 hex, and distinct per sandbox and per request", () => {
		const k = holdKey("sb-1", "req-1");
		expect(k).toMatch(/^[0-9a-f]{64}$/);
		expect(holdKey("sb-1", "req-1")).toBe(k);
		expect(holdKey("sb-2", "req-1")).not.toBe(k);
		expect(holdKey("sb-1", "req-2")).not.toBe(k);
	});
	it("is prefix-free: moving bytes across the boundary changes the key", () => {
		expect(holdKey("ab", "c")).not.toBe(holdKey("a", "bc"));
	});
	it("refuses an empty id", () => {
		expect(() => holdKey("", "r")).toThrow(RangeError);
		expect(() => holdKey("s", "")).toThrow(RangeError);
	});
});
