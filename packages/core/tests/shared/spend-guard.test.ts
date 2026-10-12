// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { isPersistableSpend, isRunawaySpend } from "../../src/shared/spend-guard.js";

describe("isPersistableSpend", () => {
	it("accepts ordinary and exactly-maximal safe counts", () => {
		for (const v of [0, 1, 12_345.5, Number.MAX_SAFE_INTEGER])
			expect(isPersistableSpend(v), String(v)).toBe(true);
	});
	it("refuses a value the vault could not recover from, and anything unrepresentable", () => {
		for (const v of [
			Number.MAX_SAFE_INTEGER + 2,
			2.77e18,
			9.22e18,
			Number.POSITIVE_INFINITY,
			Number.NaN,
			-1,
		]) {
			expect(isPersistableSpend(v), String(v)).toBe(false);
		}
	});
});

describe("isRunawaySpend", () => {
	it("an unrepresentable spend is a runaway whatever the budget", () => {
		expect(isRunawaySpend(2.77e18, 100_000)).toBe(true);
		expect(isRunawaySpend(2.77e18, 0)).toBe(true);
	});
	it("a spend more than 1000x the budget is a runaway; an exhausted budget is not", () => {
		expect(isRunawaySpend(100_000_001, 100_000)).toBe(true);
		expect(isRunawaySpend(100_000_000, 100_000)).toBe(false);
		expect(isRunawaySpend(100_000, 100_000)).toBe(false);
		expect(isRunawaySpend(250_000, 100_000)).toBe(false);
	});
	it("no configured budget and a representable spend is not a runaway; non-finite is unknown, not a runaway", () => {
		expect(isRunawaySpend(5_000_000, 0)).toBe(false);
		expect(isRunawaySpend(Number.NaN, 100)).toBe(false);
	});
});
