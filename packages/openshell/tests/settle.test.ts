// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { costFromRates, getModelRates } from "usertrust";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATE_CONFIG, evaluateRequest } from "../src/gate.js";
import { classifyResponse } from "../src/settle.js";
import { settleHold, settlementAmounts } from "../src/settlement.js";

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
	const rates = getModelRates("claude-sonnet-4-6");
	const actual = costFromRates(rates, 1000, 500, 2000, 300);

	it("prices all four tiers; under the hold it posts the actual and has no overage", () => {
		expect(settlementAmounts(rates, usage, actual + 50)).toEqual({
			actual,
			post: actual,
			overage: 0,
		});
	});
	it("prices the 1-hour share of the write tier at the 1-hour rate", () => {
		// 300 written, 200 of them 1h: 100 x 37.5 + 200 x 60 = 3,750 + 12,000 = 15,750 / 1000.
		const withHour = { ...usage, cacheWrite1hTokens: 200 };
		const withHourActual = costFromRates(rates, 1000, 500, 2000, 300, 200);
		expect(withHourActual).toBeGreaterThan(actual);
		expect(settlementAmounts(rates, withHour, withHourActual + 5).actual).toBe(withHourActual);
		// Dropping the field falls back to the all-5-minute price: that is the bug this pins.
		expect(settlementAmounts(rates, usage, withHourActual + 5).actual).toBe(actual);
	});
	it("over the hold it posts the hold and the excess is overage", () => {
		expect(settlementAmounts(rates, usage, actual - 7)).toEqual({
			actual,
			post: actual - 7,
			overage: 7,
		});
	});
	it("#166 P1: settles with the HOLD'S rate snapshot — operator rates made cheaper after the reservation do not lower the settlement", () => {
		const held = { inputPer1k: 10, outputPer1k: 40 };
		const config = { ...DEFAULT_GATE_CONFIG, customRates: { "op-model": held } };
		const r = evaluateRequest(
			{
				method: "POST",
				host: "api.openai.com",
				path: "/v1/chat/completions",
				body: new TextEncoder().encode(
					JSON.stringify({ model: "op-model", max_tokens: 100, messages: [] }),
				),
			},
			config,
		);
		if (r.decision !== "allow") throw new Error(`expected allow: ${JSON.stringify(r)}`);
		expect(r.hold.rates).toEqual(held);
		// The operator lowers the rate between reserve and settle.
		config.customRates["op-model"] = { inputPer1k: 1, outputPer1k: 1 };
		const u = {
			inputTokens: 1000,
			outputTokens: 1000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			source: "provider" as const,
		};
		const settled = settlementAmounts(r.hold.rates, u, r.hold.amount);
		expect(settled.actual).toBe(costFromRates(held, 1000, 1000));
		expect(settled.actual).toBeGreaterThan(
			costFromRates(config.customRates["op-model"], 1000, 1000),
		);
	});
	it("#166 P2: the snapshot is a FROZEN COPY — editing the operator's rate object in place after reserve does not change the settlement", () => {
		const opRates = { inputPer1k: 10, outputPer1k: 40 };
		const config = { ...DEFAULT_GATE_CONFIG, customRates: { "op-model": opRates } };
		const r = evaluateRequest(
			{
				method: "POST",
				host: "api.openai.com",
				path: "/v1/chat/completions",
				body: new TextEncoder().encode(
					JSON.stringify({ model: "op-model", max_tokens: 100, messages: [] }),
				),
			},
			config,
		);
		if (r.decision !== "allow") throw new Error(`expected allow: ${JSON.stringify(r)}`);
		opRates.inputPer1k = 1; // the operator edits the SAME object in place
		opRates.outputPer1k = 1;
		expect(r.hold.rates).toEqual({ inputPer1k: 10, outputPer1k: 40 });
		expect(Object.isFrozen(r.hold.rates)).toBe(true);
		const u = {
			inputTokens: 1000,
			outputTokens: 1000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			source: "provider" as const,
		};
		expect(settleHold(r.hold, u).actual).toBe(
			costFromRates({ inputPer1k: 10, outputPer1k: 40 }, 1000, 1000),
		);
	});
});
