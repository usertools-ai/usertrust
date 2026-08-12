// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { evaluatePolicy, type GateRule } from "../../src/policy/gate.js";

describe("hard numeric rules fail closed on missing/mistyped fields", () => {
	const hardRule: GateRule = {
		id: "budget-guard",
		name: "budget guard",
		effect: "deny",
		enforcement: "hard",
		conditions: [{ field: "budget_remaining_after", operator: "lt", value: 0 }],
	};

	it("denies when the guarded field is missing (fail closed)", () => {
		// budget_remaining_after absent — engine failed to supply it.
		expect(evaluatePolicy([hardRule], { model: "x" }).decision).toBe("deny");
	});

	it("denies when the guarded field is non-numeric", () => {
		expect(evaluatePolicy([hardRule], { budget_remaining_after: "oops" }).decision).toBe("deny");
	});

	it("allows when the field is present and satisfies the bound", () => {
		expect(evaluatePolicy([hardRule], { budget_remaining_after: 5 }).decision).toBe("allow");
	});

	it("still denies when the field is present and violates the bound", () => {
		expect(evaluatePolicy([hardRule], { budget_remaining_after: -1 }).decision).toBe("deny");
	});

	it("soft rule with missing field stays lenient (no warning)", () => {
		const soft: GateRule = {
			name: "soft",
			effect: "warn",
			enforcement: "soft",
			conditions: [{ field: "estimated_cost", operator: "gt", value: 1000 }],
		};
		const r = evaluatePolicy([soft], { model: "x" });
		expect(r.hasWarnings).toBe(false);
		expect(r.decision).toBe("allow");
	});

	it("soft rule with non-numeric field stays lenient", () => {
		const soft: GateRule = {
			name: "soft",
			effect: "warn",
			enforcement: "soft",
			conditions: [{ field: "estimated_cost", operator: "gt", value: 1000 }],
		};
		expect(evaluatePolicy([soft], { estimated_cost: "lots" }).hasWarnings).toBe(false);
	});
});

// ===========================================================================
// The other eight operators.
//
// The suite above is titled "hard NUMERIC rules fail closed", and the scope in
// that title was the gap: `gt/gte/lt/lte` were the only operators returning
// "indeterminate" on input they could not read. Every other operator returned a
// bare `false`, which `ruleMatches` reads as "this rule did not match" rather
// than "this rule could not be evaluated", so the guard was skipped rather than
// fired. Measured before the change, hard rule, guarded field absent:
//   gt/gte/lt/lte           -> DENY  (closed)
//   eq, in, contains, regex -> ALLOW
//   unknown operator        -> ALLOW
// ===========================================================================

describe("hard rules fail closed on EVERY operator, not just the numeric four", () => {
	const hard = (operator: string, value: unknown): GateRule =>
		({
			id: `guard-${operator}`,
			name: `hard guard using ${operator}`,
			effect: "deny",
			enforcement: "hard",
			conditions: [{ field: "guarded", operator, value }],
		}) as unknown as GateRule;

	// `exists`/`not_exists` are excluded deliberately: an unresolved field is
	// precisely what they measure, so for them absence is a determinate answer.
	const valueOperators: [string, unknown][] = [
		["eq", "secret"],
		["neq", "secret"],
		["gt", 10],
		["gte", 10],
		["lt", 10],
		["lte", 10],
		["in", ["a", "b"]],
		["not_in", ["a", "b"]],
		["contains", "opus"],
		["regex", "opus"],
	];

	for (const [op, value] of valueOperators) {
		it(`${op}: denies when the guarded field is ABSENT`, () => {
			expect(evaluatePolicy([hard(op, value)], { model: "x" }).decision).toBe("deny");
		});
	}

	// Only some operators impose a TYPE on their subject: the numerics need a
	// number, `contains`/`regex` need a string. `eq`/`neq`/`in`/`not_in` compare
	// any value against any value, so an object subject is a determinate "not
	// equal" / "not in" rather than an unreadable one — and must stay allow, or
	// the fix would deny every call that carries a structured field.
	for (const [op, value] of [
		["gt", 10],
		["gte", 10],
		["lt", 10],
		["lte", 10],
		["contains", "opus"],
		["regex", "opus"],
	] as [string, unknown][]) {
		it(`${op}: denies when the guarded field is the WRONG SHAPE`, () => {
			// A subject of the wrong type — an object or array where the rule expects
			// a string — is unreadable, so the guard fires rather than being skipped.
			expect(evaluatePolicy([hard(op, value)], { guarded: { nested: 1 } }).decision).toBe("deny");
			expect(evaluatePolicy([hard(op, value)], { guarded: ["opus"] }).decision).toBe("deny");
		});
	}

	it("an unknown operator denies rather than disabling its own guard", () => {
		expect(evaluatePolicy([hard("greaterThan", 10)], { guarded: 999_999 }).decision).toBe("deny");
		expect(evaluatePolicy([hard("GTE", 10)], { guarded: 999_999 }).decision).toBe("deny");
		expect(evaluatePolicy([hard("", 10)], { guarded: 999_999 }).decision).toBe("deny");
	});

	it("exists/not_exists keep their presence-test meaning", () => {
		const exists = hard("exists", true);
		expect(evaluatePolicy([exists], {}).decision).toBe("allow");
		expect(evaluatePolicy([exists], { guarded: "here" }).decision).toBe("deny");
		const notExists = hard("not_exists", true);
		expect(evaluatePolicy([notExists], {}).decision).toBe("deny");
		expect(evaluatePolicy([notExists], { guarded: "here" }).decision).toBe("allow");
	});

	it("a determinate NO is still a no — the fix must not deny everything", () => {
		// The failure mode of over-correcting: if unresolvable and simply-not-matching
		// collapsed together, every rule would fire on every call.
		expect(evaluatePolicy([hard("contains", "opus")], { guarded: "claude-haiku" }).decision).toBe(
			"allow",
		);
		expect(evaluatePolicy([hard("eq", "secret")], { guarded: "not-secret" }).decision).toBe(
			"allow",
		);
		expect(evaluatePolicy([hard("in", ["a", "b"])], { guarded: "c" }).decision).toBe("allow");
		expect(evaluatePolicy([hard("regex", "^opus")], { guarded: "sonnet" }).decision).toBe("allow");
	});

	it("SOFT rules stay lenient on every operator (unchanged behaviour)", () => {
		for (const [op, value] of valueOperators) {
			const soft = {
				...(hard(op, value) as unknown as Record<string, unknown>),
				effect: "warn",
				enforcement: "soft",
			} as unknown as GateRule;
			expect(evaluatePolicy([soft], { model: "x" }).decision, `${op} soft`).toBe("allow");
		}
	});
});

describe("explicit null is a document value, not an unresolved path", () => {
	// Third round on the same helper, and the reason it is gone. Round 1 conflated
	// `undefined` with `null` so a hard rule skipped its guard; the fix then
	// over-corrected, making an explicit `null` unreadable — so `not_in: [null]`,
	// which says "null is permitted", denied the very value it permits. The
	// conflation was in the CONCEPT, so the concept was removed rather than
	// patched again: membership reads the array, and only `undefined` is
	// unanswerable.
	const mk = (operator: string, value: unknown, enforcement = "hard"): GateRule =>
		({
			name: `r-${operator}`,
			effect: "deny",
			enforcement,
			conditions: [{ field: "guarded", operator, value }],
		}) as unknown as GateRule;

	it("not_in [null] ALLOWS an explicit null — it is in the exclusion list", () => {
		expect(evaluatePolicy([mk("not_in", [null])], { guarded: null }).decision).toBe("allow");
	});

	it("not_in [null] still denies a value that is not excluded", () => {
		expect(evaluatePolicy([mk("not_in", [null])], { guarded: "x" }).decision).toBe("deny");
	});

	it("not_in [null] still denies an ABSENT field — unanswerable, not permitted", () => {
		expect(evaluatePolicy([mk("not_in", [null])], {}).decision).toBe("deny");
	});

	it("in [null] MATCHES an explicit null", () => {
		expect(evaluatePolicy([mk("in", [null])], { guarded: null }).decision).toBe("deny");
	});

	it("a soft in [null] rule keeps its warning on an explicit null", () => {
		expect(evaluatePolicy([mk("in", [null], "soft")], { guarded: null }).matched).toHaveLength(1);
	});

	it("in [null] is still indeterminate for an ABSENT field", () => {
		expect(evaluatePolicy([mk("in", [null])], {}).decision).toBe("deny");
	});
});
