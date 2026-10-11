// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The gate's hold for a per-request prompt tier (Claude Haiku 5.5, `longPrompt`).
 *
 * The gate prices a request at an UPPER bound on its prompt (`inputTokenBound`, from the
 * forwarded bytes), and the cost function selects the tier from the count it is given. A
 * bound at or under the 100,000-token threshold proves the request cannot cross it, so the
 * hold is exact at the lower tier. A bound over it holds the higher tier. Settlement always
 * prices the reported usage at the tier its own prompt selects.
 */

import { costFromRates, getModelRates } from "usertrust";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATE_CONFIG, evaluateRequest, type GateResult } from "../src/gate.js";
import { settleHold } from "../src/settlement.js";

const MODEL = "claude-haiku-5-5";
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

function gate(body: unknown): GateResult {
	return evaluateRequest(
		{ method: "POST", host: "api.anthropic.com", path: "/v1/messages", body: enc(body) },
		DEFAULT_GATE_CONFIG,
	);
}

/** A request whose forwarded body is close to `targetBytes` long. */
function bodyOfAbout(targetBytes: number) {
	const frame = { model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: "" }] };
	const overhead = enc(frame).byteLength;
	return {
		...frame,
		messages: [{ role: "user", content: "a".repeat(Math.max(0, targetBytes - overhead)) }],
	};
}

/** The gate's own bound arithmetic for a text-only body: its forwarded byte length. */
function bound(r: GateResult): number {
	if (r.decision !== "allow" || r.mutations.body === undefined) throw new Error("not allowed");
	return r.mutations.body.byteLength;
}

describe("the gate holds Haiku 5.5 at the tier its prompt BOUND selects", () => {
	it("a bound under 100,000 holds at the lower tier, exactly", () => {
		const r = gate(bodyOfAbout(50_000));
		if (r.decision !== "allow") throw new Error("not allowed");
		const b = bound(r);
		expect(b).toBeLessThanOrEqual(100_000);
		const rates = getModelRates(MODEL);
		// The dearest input leg at the lower tier is the 5-minute write (1.25/1k).
		expect(r.hold.amount).toBe(costFromRates(rates, 0, 1024, 0, b));
		expect(r.hold.amount).toBe(Math.ceil((b * 1.25) / 1000 + (1024 * 5) / 1000));
	});

	it("a bound over 100,000 holds at the higher tier", () => {
		const r = gate(bodyOfAbout(150_000));
		if (r.decision !== "allow") throw new Error("not allowed");
		const b = bound(r);
		expect(b).toBeGreaterThan(100_000);
		// The dearest input leg at the higher tier is its 5-minute write (6.25/1k).
		expect(r.hold.amount).toBe(Math.ceil((b * 6.25) / 1000 + (1024 * 25) / 1000));
	});

	it("settlement prices the REPORTED usage at its own tier, within the hold", () => {
		const r = gate(bodyOfAbout(150_000));
		if (r.decision !== "allow") throw new Error("not allowed");
		// The provider reports a 40,000-token prompt: the lower tier, far below the hold.
		const small = settleHold(r.hold, {
			inputTokens: 40_000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			source: "provider",
		});
		expect(small.actual).toBe(Math.ceil((40_000 * 1) / 1000 + (500 * 5) / 1000));
		expect(small.overage).toBe(0);
		// A 120,000-token prompt: the higher tier.
		const large = settleHold(r.hold, {
			inputTokens: 120_000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			source: "provider",
		});
		expect(large.actual).toBe(Math.ceil((120_000 * 5) / 1000 + (500 * 25) / 1000));
		expect(large.overage).toBe(0);
	});

	it("an operator row spread from the tiered table row is priced FLAT: its hold covers the settle", () => {
		// The override an operator writes by spreading the table row: base rates raised to 100,
		// the table's (now cheaper) `longPrompt` carried along. Priced by that tier, a bound over
		// 100,000 would hold a few hundred units for a call that settles at over 10,000.
		const customRates = {
			[MODEL]: { ...getModelRates(MODEL), inputPer1k: 100, outputPer1k: 100 },
		};
		const r = evaluateRequest(
			{
				method: "POST",
				host: "api.anthropic.com",
				path: "/v1/messages",
				body: enc(bodyOfAbout(110_000)),
			},
			{ ...DEFAULT_GATE_CONFIG, customRates },
		);
		if (r.decision !== "allow") throw new Error("not allowed");
		expect(bound(r)).toBeGreaterThan(100_000);
		expect(r.hold.rates.longPrompt).toBeUndefined();
		const settled = settleHold(r.hold, {
			inputTokens: 100_000,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			source: "provider",
		});
		expect(settled.actual).toBe(Math.ceil((100_000 * 100) / 1000 + (100 * 100) / 1000));
		expect(r.hold.amount).toBeGreaterThanOrEqual(settled.actual);
		expect(settled.overage).toBe(0);
	});

	it("the hold's rate snapshot is deep-frozen (its tier cannot be edited after authorize)", () => {
		const r = gate(bodyOfAbout(1000));
		if (r.decision !== "allow") throw new Error("not allowed");
		expect(Object.isFrozen(r.hold.rates)).toBe(true);
		expect(Object.isFrozen(r.hold.rates.longPrompt)).toBe(true);
		expect(Object.isFrozen(r.hold.rates.longPrompt?.rates)).toBe(true);
	});
});
