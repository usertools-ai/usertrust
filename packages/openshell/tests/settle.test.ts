// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { costFromRates, getModelRates } from "usertrust";
import { describe, expect, it } from "vitest";
import { classifyResponse } from "../src/settle.js";
import { settlementAmounts } from "../src/settlement.js";

const ok = (headers: Record<string, string>, status = 200, method = "POST") =>
	classifyResponse({ status, headers, method });

describe("response classification", () => {
	it("a non-2xx response voids the hold", () => {
		for (const s of [100, 199, 301, 400, 404, 429, 500, 529]) {
			expect(ok({ "content-type": "application/json" }, s), String(s)).toEqual({ action: "void" });
		}
	});

	it("an identity body is read: SSE as a stream, anything else whole", () => {
		expect(ok({ "Content-Type": "text/event-stream; charset=utf-8" })).toEqual({
			action: "read",
			mode: "STREAM_BYTES",
		});
		expect(ok({ "content-type": "application/json", "content-encoding": "identity" })).toEqual({
			action: "read",
			mode: "WHOLE_BODY_BYTES",
		});
	});

	it("every body-unavailable reason settles at the hold with usage_unreadable", () => {
		const cases: Array<[Record<string, string>, number, string, string]> = [
			[{ "Content-Encoding": "gzip" }, 200, "POST", "content-encoding:gzip"],
			[{ "content-encoding": "br" }, 200, "POST", "content-encoding:br"],
			[{}, 206, "POST", "partial"],
			[{ "content-range": "bytes 0-9/100" }, 200, "POST", "partial"],
			[{}, 204, "POST", "no-body"],
			[{}, 200, "HEAD", "no-body"],
			[{ "content-length": "0" }, 200, "POST", "no-body"],
			[{ "cache-control": "no-transform" }, 200, "POST", "no-transform"],
			[{ "Cache-Control": "public, No-Transform, max-age=0" }, 200, "POST", "no-transform"],
			[{ "content-length": String(4 * 1024 * 1024 + 1) }, 200, "POST", "too-large"],
		];
		for (const [headers, status, method, why] of cases) {
			expect(ok(headers, status, method), why).toEqual({
				action: "settle_at_hold",
				finding: "usage_unreadable",
				why,
			});
		}
	});

	it("control: a directive that only CONTAINS the word is not no-transform", () => {
		expect(ok({ "cache-control": "no-transformation" })).toEqual({
			action: "read",
			mode: "WHOLE_BODY_BYTES",
		});
	});
});

describe("settlement amounts", () => {
	const usage = {
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 2000,
		cacheWriteTokens: 300,
		source: "provider" as const,
	};
	const actual = costFromRates(getModelRates("claude-sonnet-4-6"), 1000, 500, 2000, 300);

	it("prices all four tiers; under the hold it posts the actual and has no overage", () => {
		expect(settlementAmounts("claude-sonnet-4-6", usage, actual + 50)).toEqual({
			actual,
			post: actual,
			overage: 0,
		});
	});
	it("over the hold it posts the hold and the excess is overage", () => {
		expect(settlementAmounts("claude-sonnet-4-6", usage, actual - 7)).toEqual({
			actual,
			post: actual - 7,
			overage: 7,
		});
	});
});
