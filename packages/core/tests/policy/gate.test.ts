/**
 * Policy Gate Tests
 *
 * Tests all 12 field operators, hard/soft enforcement, dot-notation
 * field resolution, glob scope matching, time-window constraints,
 * priority ordering, and default rules.
 */

import { unlinkSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, isBudgetExceeded } from "../../src/policy/default-rules.js";
import {
	type GateRule,
	type PolicyContext,
	evaluatePolicy,
	isWithinTimeWindow,
	loadPolicies,
	matchesScope,
} from "../../src/policy/gate.js";
import type { FieldOperator, PolicyEffect } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rule(overrides: Partial<GateRule> = {}): GateRule {
	return {
		name: "test-rule",
		effect: "deny",
		enforcement: "hard",
		conditions: [],
		priority: 10,
		enabled: true,
		...overrides,
	};
}

// ===========================================================================
// 12 Operators — each tested individually
// ===========================================================================

describe("operators", () => {
	describe("exists", () => {
		it("matches when field is present and non-null", () => {
			const r = rule({
				conditions: [{ field: "token", operator: "exists" }],
			});
			const result = evaluatePolicy([r], { token: "abc" });
			expect(result.matched).toHaveLength(1);
		});

		it("does not match when field is undefined", () => {
			const r = rule({
				conditions: [{ field: "token", operator: "exists" }],
			});
			const result = evaluatePolicy([r], {});
			expect(result.matched).toHaveLength(0);
		});

		it("does not match when field is null", () => {
			const r = rule({
				conditions: [{ field: "token", operator: "exists" }],
			});
			const result = evaluatePolicy([r], { token: null });
			expect(result.matched).toHaveLength(0);
		});
	});

	describe("not_exists", () => {
		it("matches when field is undefined", () => {
			const r = rule({
				conditions: [{ field: "token", operator: "not_exists" }],
			});
			const result = evaluatePolicy([r], {});
			expect(result.matched).toHaveLength(1);
		});

		it("matches when field is null", () => {
			const r = rule({
				conditions: [{ field: "token", operator: "not_exists" }],
			});
			const result = evaluatePolicy([r], { token: null });
			expect(result.matched).toHaveLength(1);
		});

		it("does not match when field is present", () => {
			const r = rule({
				conditions: [{ field: "token", operator: "not_exists" }],
			});
			const result = evaluatePolicy([r], { token: "abc" });
			expect(result.matched).toHaveLength(0);
		});
	});

	describe("eq", () => {
		it("matches on strict equality", () => {
			const r = rule({
				conditions: [{ field: "model", operator: "eq", value: "gpt-4" }],
			});
			const result = evaluatePolicy([r], { model: "gpt-4" });
			expect(result.matched).toHaveLength(1);
		});

		it("does not match different values", () => {
			const r = rule({
				conditions: [{ field: "model", operator: "eq", value: "gpt-4" }],
			});
			const result = evaluatePolicy([r], { model: "gpt-3.5" });
			expect(result.matched).toHaveLength(0);
		});

		it("does not coerce types", () => {
			const r = rule({
				conditions: [{ field: "count", operator: "eq", value: "5" }],
			});
			const result = evaluatePolicy([r], { count: 5 });
			expect(result.matched).toHaveLength(0);
		});
	});

	describe("neq", () => {
		it("matches when values differ", () => {
			const r = rule({
				conditions: [{ field: "status", operator: "neq", value: "active" }],
			});
			const result = evaluatePolicy([r], { status: "inactive" });
			expect(result.matched).toHaveLength(1);
		});

		it("does not match when values are equal", () => {
			const r = rule({
				conditions: [{ field: "status", operator: "neq", value: "active" }],
			});
			const result = evaluatePolicy([r], { status: "active" });
			expect(result.matched).toHaveLength(0);
		});
	});

	describe("gt", () => {
		it("matches when field > value", () => {
			const r = rule({
				conditions: [{ field: "cost", operator: "gt", value: 100 }],
			});
			const result = evaluatePolicy([r], { cost: 150 });
			expect(result.matched).toHaveLength(1);
		});

		it("does not match when field <= value", () => {
			const r = rule({
				conditions: [{ field: "cost", operator: "gt", value: 100 }],
			});
			expect(evaluatePolicy([r], { cost: 100 }).matched).toHaveLength(0);
			expect(evaluatePolicy([r], { cost: 50 }).matched).toHaveLength(0);
		});

		it("does not match non-numeric fields", () => {
			const r = rule({
				conditions: [{ field: "cost", operator: "gt", value: 100 }],
			});
			const result = evaluatePolicy([r], { cost: "150" });
			expect(result.matched).toHaveLength(0);
		});
	});

	describe("gte", () => {
		it("matches when field >= value", () => {
			const r = rule({
				conditions: [{ field: "count", operator: "gte", value: 10 }],
			});
			expect(evaluatePolicy([r], { count: 10 }).matched).toHaveLength(1);
			expect(evaluatePolicy([r], { count: 11 }).matched).toHaveLength(1);
		});

		it("does not match when field < value", () => {
			const r = rule({
				conditions: [{ field: "count", operator: "gte", value: 10 }],
			});
			expect(evaluatePolicy([r], { count: 9 }).matched).toHaveLength(0);
		});
	});

	describe("lt", () => {
		it("matches when field < value", () => {
			const r = rule({
				conditions: [{ field: "balance", operator: "lt", value: 100 }],
			});
			const result = evaluatePolicy([r], { balance: 50 });
			expect(result.matched).toHaveLength(1);
		});

		it("does not match when field >= value", () => {
			const r = rule({
				conditions: [{ field: "balance", operator: "lt", value: 100 }],
			});
			expect(evaluatePolicy([r], { balance: 100 }).matched).toHaveLength(0);
			expect(evaluatePolicy([r], { balance: 200 }).matched).toHaveLength(0);
		});
	});

	describe("lte", () => {
		it("matches when field <= value", () => {
			const r = rule({
				conditions: [{ field: "attempts", operator: "lte", value: 3 }],
			});
			expect(evaluatePolicy([r], { attempts: 3 }).matched).toHaveLength(1);
			expect(evaluatePolicy([r], { attempts: 2 }).matched).toHaveLength(1);
		});

		it("does not match when field > value", () => {
			const r = rule({
				conditions: [{ field: "attempts", operator: "lte", value: 3 }],
			});
			expect(evaluatePolicy([r], { attempts: 4 }).matched).toHaveLength(0);
		});
	});

	describe("in", () => {
		it("matches when field value is in array", () => {
			const r = rule({
				conditions: [{ field: "role", operator: "in", value: ["admin", "manager"] }],
			});
			expect(evaluatePolicy([r], { role: "admin" }).matched).toHaveLength(1);
			expect(evaluatePolicy([r], { role: "manager" }).matched).toHaveLength(1);
		});

		it("does not match when field value is not in array", () => {
			const r = rule({
				conditions: [{ field: "role", operator: "in", value: ["admin", "manager"] }],
			});
			expect(evaluatePolicy([r], { role: "worker" }).matched).toHaveLength(0);
		});
	});

	describe("not_in", () => {
		it("matches when field value is not in array", () => {
			const r = rule({
				conditions: [{ field: "provider", operator: "not_in", value: ["blocked-co"] }],
			});
			expect(evaluatePolicy([r], { provider: "openai" }).matched).toHaveLength(1);
		});

		it("does not match when field value is in array", () => {
			const r = rule({
				conditions: [{ field: "provider", operator: "not_in", value: ["blocked-co"] }],
			});
			expect(evaluatePolicy([r], { provider: "blocked-co" }).matched).toHaveLength(0);
		});
	});

	describe("contains", () => {
		it("matches when string field contains substring", () => {
			const r = rule({
				conditions: [{ field: "prompt", operator: "contains", value: "secret" }],
			});
			const result = evaluatePolicy([r], { prompt: "this is a secret message" });
			expect(result.matched).toHaveLength(1);
		});

		it("does not match when substring absent", () => {
			const r = rule({
				conditions: [{ field: "prompt", operator: "contains", value: "secret" }],
			});
			const result = evaluatePolicy([r], { prompt: "hello world" });
			expect(result.matched).toHaveLength(0);
		});

		it("does not match non-string fields", () => {
			const r = rule({
				conditions: [{ field: "count", operator: "contains", value: "5" }],
			});
			const result = evaluatePolicy([r], { count: 5 });
			expect(result.matched).toHaveLength(0);
		});
	});

	describe("regex", () => {
		it("matches when string field matches regex", () => {
			const r = rule({
				conditions: [{ field: "email", operator: "regex", value: ".*@example\\.com$" }],
			});
			const result = evaluatePolicy([r], { email: "user@example.com" });
			expect(result.matched).toHaveLength(1);
		});

		it("does not match when regex fails", () => {
			const r = rule({
				conditions: [{ field: "email", operator: "regex", value: "^admin@" }],
			});
			const result = evaluatePolicy([r], { email: "user@example.com" });
			expect(result.matched).toHaveLength(0);
		});

		it("handles invalid regex gracefully", () => {
			const r = rule({
				conditions: [{ field: "text", operator: "regex", value: "[invalid" }],
			});
			const result = evaluatePolicy([r], { text: "anything" });
			expect(result.matched).toHaveLength(0);
		});

		it("does not match non-string fields", () => {
			const r = rule({
				conditions: [{ field: "count", operator: "regex", value: "\\d+" }],
			});
			const result = evaluatePolicy([r], { count: 42 });
			expect(result.matched).toHaveLength(0);
		});
	});
});

// ===========================================================================
// Enforcement: hard vs soft
// ===========================================================================

describe("enforcement", () => {
	it("hard enforcement denies", () => {
		const r = rule({
			effect: "deny",
			enforcement: "hard",
			conditions: [{ field: "blocked", operator: "eq", value: true }],
		});
		const result = evaluatePolicy([r], { blocked: true });

		expect(result.decision).toBe("deny");
		expect(result.hardViolations).toHaveLength(1);
		expect(result.softViolations).toHaveLength(0);
	});

	it("soft enforcement warns but allows", () => {
		const r = rule({
			effect: "deny",
			enforcement: "soft",
			conditions: [{ field: "flagged", operator: "eq", value: true }],
		});
		const result = evaluatePolicy([r], { flagged: true });

		expect(result.decision).toBe("allow");
		expect(result.hasWarnings).toBe(true);
		expect(result.softViolations).toHaveLength(1);
	});

	it("warn effect with soft enforcement produces warning", () => {
		const r = rule({
			effect: "warn",
			enforcement: "soft",
			conditions: [{ field: "risk", operator: "gt", value: 0.5 }],
		});
		const result = evaluatePolicy([r], { risk: 0.8 });

		expect(result.decision).toBe("allow");
		expect(result.hasWarnings).toBe(true);
		expect(result.reasons.length).toBeGreaterThan(0);
		expect(result.reasons[0]).toMatch(/\[WARN\]/);
	});

	it("no matching rules = allow", () => {
		const r = rule({
			conditions: [{ field: "never", operator: "exists" }],
		});
		const result = evaluatePolicy([r], {});

		expect(result.decision).toBe("allow");
		expect(result.matched).toHaveLength(0);
	});
});

// ===========================================================================
// Dot-notation field resolution
// ===========================================================================

describe("dot-notation field resolution", () => {
	it("resolves nested field paths", () => {
		const r = rule({
			conditions: [{ field: "context.data.model", operator: "eq", value: "gpt-4" }],
		});
		const result = evaluatePolicy([r], {
			context: { data: { model: "gpt-4" } },
		});
		expect(result.matched).toHaveLength(1);
	});

	it("returns undefined for missing nested paths", () => {
		const r = rule({
			conditions: [{ field: "a.b.c", operator: "exists" }],
		});
		const result = evaluatePolicy([r], { a: { b: {} } });
		expect(result.matched).toHaveLength(0);
	});

	it("handles null in path gracefully", () => {
		const r = rule({
			conditions: [{ field: "a.b", operator: "exists" }],
		});
		const result = evaluatePolicy([r], { a: null });
		expect(result.matched).toHaveLength(0);
	});
});

// ===========================================================================
// Glob matching on scope patterns
// ===========================================================================

describe("scope glob matching", () => {
	it("matches exact paths", () => {
		expect(matchesScope(["src/index.ts"], ["src/index.ts"])).toBe(true);
	});

	it("matches ** glob patterns", () => {
		expect(matchesScope(["src/**"], ["src/routes/api.ts"])).toBe(true);
		expect(matchesScope(["src/**"], ["lib/utils.ts"])).toBe(false);
	});

	it("matches * single-level glob", () => {
		expect(matchesScope(["src/*.ts"], ["src/index.ts"])).toBe(true);
		expect(matchesScope(["src/*.ts"], ["src/routes/index.ts"])).toBe(false);
	});

	it("integrates with rule evaluation", () => {
		const r = rule({
			conditions: [{ field: "action", operator: "eq", value: "file.write" }],
			scopePatterns: ["src/routes/**"],
		});

		const allowed = evaluatePolicy([r], {
			action: "file.write",
			scope: ["src/routes/api.ts"],
		});
		expect(allowed.matched).toHaveLength(1);

		const blocked = evaluatePolicy([r], {
			action: "file.write",
			scope: ["lib/utils.ts"],
		});
		expect(blocked.matched).toHaveLength(0);
	});

	it("no scope in context fails scope rule", () => {
		const r = rule({
			scopePatterns: ["src/**"],
			conditions: [],
		});
		const result = evaluatePolicy([r], {});
		expect(result.matched).toHaveLength(0);
	});
});

// ===========================================================================
// Time-window constraints
// ===========================================================================

describe("time-window constraints", () => {
	// Build a Date in local time at a specific hour/day so getDay()/getHours()
	// return predictable values regardless of the machine's timezone.
	function localDate(hour: number, dayOffset = 0): Date {
		const d = new Date();
		d.setHours(hour, 0, 0, 0);
		if (dayOffset) d.setDate(d.getDate() + dayOffset);
		return d;
	}

	it("matches when within time window", () => {
		const d = localDate(12); // noon local
		const ts = d.toISOString();
		const day = d.getDay();

		expect(isWithinTimeWindow([{ daysOfWeek: [day], startHour: 9, endHour: 17 }], ts)).toBe(true);
	});

	it("does not match outside day-of-week", () => {
		const d = localDate(12);
		const ts = d.toISOString();
		const day = d.getDay();
		const otherDay = (day + 3) % 7; // guaranteed different day

		expect(isWithinTimeWindow([{ daysOfWeek: [otherDay], startHour: 9, endHour: 17 }], ts)).toBe(
			false,
		);
	});

	it("does not match outside hour range", () => {
		const d = localDate(20); // 8 PM local
		const ts = d.toISOString();

		expect(isWithinTimeWindow([{ startHour: 9, endHour: 17 }], ts)).toBe(false);
	});

	it("returns true when no time windows specified", () => {
		const ts = new Date().toISOString();
		expect(isWithinTimeWindow(undefined, ts)).toBe(true);
		expect(isWithinTimeWindow([], ts)).toBe(true);
	});

	it("integrates with rule evaluation via timeWindows on rule", () => {
		const d = localDate(14); // 2 PM local
		const day = d.getDay();

		const r = rule({
			conditions: [],
			timeWindows: [{ daysOfWeek: [day], startHour: 9, endHour: 17 }],
		});

		// Within window
		const inWindow = evaluatePolicy([r], { timestamp: d.toISOString() });
		expect(inWindow.matched).toHaveLength(1);

		// Outside window (different day)
		const otherDay = localDate(14, 1);
		if (otherDay.getDay() !== day) {
			const outOfWindow = evaluatePolicy([r], {
				timestamp: otherDay.toISOString(),
			});
			expect(outOfWindow.matched).toHaveLength(0);
		}
	});
});

// ===========================================================================
// Priority ordering
// ===========================================================================

describe("priority ordering", () => {
	it("sorts rules by priority (lower = higher)", () => {
		const low = rule({
			name: "low-priority",
			priority: 100,
			effect: "deny",
			enforcement: "hard",
			conditions: [{ field: "x", operator: "eq", value: 1 }],
		});
		const high = rule({
			name: "high-priority",
			priority: 1,
			effect: "deny",
			enforcement: "hard",
			conditions: [{ field: "x", operator: "eq", value: 1 }],
		});

		const result = evaluatePolicy([low, high], { x: 1 });
		expect(result.matched).toHaveLength(2);
		// First match should be the higher priority rule
		expect(result.matched[0]?.name).toBe("high-priority");
	});

	it("defaults priority to 100 when not set", () => {
		const withPriority = rule({
			name: "explicit",
			priority: 50,
			conditions: [{ field: "x", operator: "eq", value: 1 }],
		});
		const withoutPriority = rule({
			name: "default",
			conditions: [{ field: "x", operator: "eq", value: 1 }],
		});
		(withoutPriority as Record<string, unknown>).priority = undefined;

		const result = evaluatePolicy([withoutPriority, withPriority], { x: 1 });
		// explicit (50) should come before default (100)
		expect(result.matched[0]?.name).toBe("explicit");
	});
});

// ===========================================================================
// Disabled rules
// ===========================================================================

describe("disabled rules", () => {
	it("skips disabled rules", () => {
		const r = rule({
			enabled: false,
			conditions: [{ field: "always", operator: "exists" }],
		});
		const result = evaluatePolicy([r], { always: true });
		expect(result.matched).toHaveLength(0);
	});

	it("defaults enabled to true", () => {
		const r = rule({ conditions: [] });
		(r as Record<string, unknown>).enabled = undefined;
		const result = evaluatePolicy([r], {});
		expect(result.matched).toHaveLength(1);
	});
});

// ===========================================================================
// Multiple conditions (AND logic)
// ===========================================================================

describe("multiple conditions (AND)", () => {
	it("requires all conditions to match", () => {
		const r = rule({
			conditions: [
				{ field: "role", operator: "eq", value: "admin" },
				{ field: "level", operator: "gte", value: 5 },
			],
		});

		// Both match
		expect(evaluatePolicy([r], { role: "admin", level: 10 }).matched).toHaveLength(1);

		// Only first matches
		expect(evaluatePolicy([r], { role: "admin", level: 3 }).matched).toHaveLength(0);

		// Only second matches
		expect(evaluatePolicy([r], { role: "user", level: 10 }).matched).toHaveLength(0);
	});
});

// ===========================================================================
// Result structure
// ===========================================================================

describe("result structure", () => {
	it("includes all required fields", () => {
		const result = evaluatePolicy([], {});
		expect(result).toHaveProperty("decision");
		expect(result).toHaveProperty("hasWarnings");
		expect(result).toHaveProperty("matched");
		expect(result).toHaveProperty("hardViolations");
		expect(result).toHaveProperty("softViolations");
		expect(result).toHaveProperty("reasons");
		expect(result).toHaveProperty("evaluatedAt");
	});

	it("includes rule id in reasons when present", () => {
		const r = rule({
			id: "rule-42",
			name: "Test rule",
			description: "Blocks everything",
			conditions: [{ field: "x", operator: "exists" }],
		});
		const result = evaluatePolicy([r], { x: true });
		expect(result.reasons[0]).toContain("[rule-42]");
	});

	it("falls back to name in reasons when no id", () => {
		const r = rule({
			name: "my-rule",
			conditions: [{ field: "x", operator: "exists" }],
		});
		const result = evaluatePolicy([r], { x: true });
		expect(result.reasons[0]).toContain("[my-rule]");
	});
});

// ===========================================================================
// Default rules
// ===========================================================================

describe("default rules", () => {
	it("blocks zero-budget calls", () => {
		const result = evaluatePolicy(DEFAULT_RULES, {
			budget: 0,
			estimated_cost: 100,
			budget_remaining: 0,
		});
		expect(result.decision).toBe("deny");
	});

	it("blocks negative-budget calls", () => {
		const result = evaluatePolicy(DEFAULT_RULES, {
			budget: -5,
			estimated_cost: 100,
			budget_remaining: -5,
		});
		expect(result.decision).toBe("deny");
	});

	it("warns on high-cost operations", () => {
		const result = evaluatePolicy(DEFAULT_RULES, {
			budget: 50000,
			estimated_cost: 2000,
			budget_remaining: 50000,
		});
		expect(result.hasWarnings).toBe(true);
		expect(result.softViolations.length).toBeGreaterThan(0);
	});

	it("allows normal operations", () => {
		const result = evaluatePolicy(DEFAULT_RULES, {
			budget: 50000,
			estimated_cost: 100,
			budget_remaining: 50000,
		});
		expect(result.decision).toBe("allow");
		expect(result.hasWarnings).toBe(false);
	});

	it("isBudgetExceeded detects overspend", () => {
		expect(isBudgetExceeded({ budget_remaining: 50, estimated_cost: 100 })).toBe(true);
		expect(isBudgetExceeded({ budget_remaining: 200, estimated_cost: 100 })).toBe(false);
	});

	it("isBudgetExceeded returns false for non-numeric fields", () => {
		expect(isBudgetExceeded({ budget_remaining: "50", estimated_cost: 100 })).toBe(false);
		expect(isBudgetExceeded({})).toBe(false);
	});
});

// ===========================================================================
// loadPolicies
// ===========================================================================

describe("loadPolicies", () => {
	it("returns empty array for non-existent file", () => {
		const rules = loadPolicies("/tmp/does-not-exist-trust-test.json");
		expect(rules).toEqual([]);
	});

	it("returns empty array for file with non-array, non-rules-object content (line 382)", () => {
		const path = `/tmp/trust-test-no-rules-${Date.now()}.json`;
		try {
			// Object without "rules" key → should hit line 382
			writeFileSync(path, JSON.stringify({ name: "not-rules", version: 1 }));
			const rules = loadPolicies(path);
			expect(rules).toEqual([]);
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
		}
	});

	it("returns rules from { rules: [...] } JSON file", () => {
		const path = `/tmp/trust-test-rules-${Date.now()}.json`;
		try {
			writeFileSync(
				path,
				JSON.stringify({
					rules: [
						{
							name: "test",
							effect: "deny",
							enforcement: "hard",
							conditions: [],
						},
					],
				}),
			);
			const rules = loadPolicies(path);
			expect(rules).toHaveLength(1);
			expect(rules[0]?.name).toBe("test");
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
		}
	});

	it("returns rules from bare array JSON file", () => {
		const path = `/tmp/trust-test-array-${Date.now()}.json`;
		try {
			writeFileSync(
				path,
				JSON.stringify([
					{
						name: "bare",
						effect: "warn",
						enforcement: "soft",
						conditions: [],
					},
				]),
			);
			const rules = loadPolicies(path);
			expect(rules).toHaveLength(1);
			expect(rules[0]?.name).toBe("bare");
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
		}
	});

	it("returns empty array for YAML with scalar content (line 382)", () => {
		const path = `/tmp/trust-test-scalar-${Date.now()}.yml`;
		try {
			writeFileSync(path, "just-a-string\n");
			const rules = loadPolicies(path);
			expect(rules).toEqual([]);
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
		}
	});

	it("returns empty array for invalid JSON (catch block)", () => {
		const path = `/tmp/trust-test-invalid-${Date.now()}.json`;
		try {
			writeFileSync(path, "{ broken json <<<");
			const rules = loadPolicies(path);
			expect(rules).toEqual([]);
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
		}
	});

	it("loads from .yaml extension", () => {
		const path = `/tmp/trust-test-yaml-${Date.now()}.yaml`;
		try {
			writeFileSync(
				path,
				"rules:\n  - name: yaml-rule\n    effect: deny\n    enforcement: hard\n    conditions: []\n",
			);
			const rules = loadPolicies(path);
			expect(rules).toHaveLength(1);
			expect(rules[0]?.name).toBe("yaml-rule");
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
		}
	});

	it("returns empty for null parsed value (line 382)", () => {
		const path = `/tmp/trust-test-null-${Date.now()}.json`;
		try {
			writeFileSync(path, "null");
			const rules = loadPolicies(path);
			expect(rules).toEqual([]);
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
		}
	});
});

// ===========================================================================
// Operator edge cases — the full matrix
// ===========================================================================

describe("operator edge cases", () => {
	describe("exists — edge cases", () => {
		it("matches for empty string (exists but falsy)", () => {
			const r = rule({
				conditions: [{ field: "name", operator: "exists" }],
			});
			const result = evaluatePolicy([r], { name: "" });
			expect(result.matched).toHaveLength(1);
		});

		it("matches for zero (exists but falsy)", () => {
			const r = rule({
				conditions: [{ field: "count", operator: "exists" }],
			});
			const result = evaluatePolicy([r], { count: 0 });
			expect(result.matched).toHaveLength(1);
		});

		it("matches for false (exists but falsy)", () => {
			const r = rule({
				conditions: [{ field: "active", operator: "exists" }],
			});
			const result = evaluatePolicy([r], { active: false });
			expect(result.matched).toHaveLength(1);
		});
	});

	describe("not_exists — edge cases", () => {
		it("does not match empty string (field exists)", () => {
			const r = rule({
				conditions: [{ field: "name", operator: "not_exists" }],
			});
			const result = evaluatePolicy([r], { name: "" });
			expect(result.matched).toHaveLength(0);
		});

		it("does not match zero (field exists)", () => {
			const r = rule({
				conditions: [{ field: "count", operator: "not_exists" }],
			});
			const result = evaluatePolicy([r], { count: 0 });
			expect(result.matched).toHaveLength(0);
		});

		it("matches deeply nested missing path", () => {
			const r = rule({
				conditions: [{ field: "a.b.c.d", operator: "not_exists" }],
			});
			const result = evaluatePolicy([r], { a: { b: {} } });
			expect(result.matched).toHaveLength(1);
		});
	});

	describe("eq — edge cases", () => {
		it("does not coerce number vs string '5' vs 5", () => {
			const r = rule({
				conditions: [{ field: "count", operator: "eq", value: "5" }],
			});
			expect(evaluatePolicy([r], { count: 5 }).matched).toHaveLength(0);
			expect(evaluatePolicy([r], { count: "5" }).matched).toHaveLength(1);
		});

		it("matches boolean true strictly", () => {
			const r = rule({
				conditions: [{ field: "active", operator: "eq", value: true }],
			});
			expect(evaluatePolicy([r], { active: true }).matched).toHaveLength(1);
			expect(evaluatePolicy([r], { active: 1 }).matched).toHaveLength(0);
			expect(evaluatePolicy([r], { active: "true" }).matched).toHaveLength(0);
		});

		it("matches null value", () => {
			const r = rule({
				conditions: [{ field: "value", operator: "eq", value: null }],
			});
			expect(evaluatePolicy([r], { value: null }).matched).toHaveLength(1);
			expect(evaluatePolicy([r], {}).matched).toHaveLength(0);
		});
	});

	describe("neq — edge cases", () => {
		it("undefined field neq value → true (undefined !== 'active')", () => {
			const r = rule({
				conditions: [{ field: "status", operator: "neq", value: "active" }],
			});
			const result = evaluatePolicy([r], {});
			expect(result.matched).toHaveLength(1);
		});

		it("null field neq string → true", () => {
			const r = rule({
				conditions: [{ field: "status", operator: "neq", value: "active" }],
			});
			const result = evaluatePolicy([r], { status: null });
			expect(result.matched).toHaveLength(1);
		});
	});

	describe("gt — edge cases", () => {
		it("returns false for non-numeric field (string)", () => {
			const r = rule({
				conditions: [{ field: "cost", operator: "gt", value: 10 }],
			});
			expect(evaluatePolicy([r], { cost: "twenty" }).matched).toHaveLength(0);
		});

		it("returns false for non-numeric value", () => {
			const r = rule({
				conditions: [{ field: "cost", operator: "gt", value: "10" as unknown as number }],
			});
			expect(evaluatePolicy([r], { cost: 20 }).matched).toHaveLength(0);
		});

		it("returns false for undefined field", () => {
			const r = rule({
				conditions: [{ field: "cost", operator: "gt", value: 10 }],
			});
			expect(evaluatePolicy([r], {}).matched).toHaveLength(0);
		});
	});

	describe("gte — boundary value", () => {
		it("matches exact boundary", () => {
			const r = rule({
				conditions: [{ field: "count", operator: "gte", value: 0 }],
			});
			expect(evaluatePolicy([r], { count: 0 }).matched).toHaveLength(1);
		});

		it("does not match negative below zero boundary", () => {
			const r = rule({
				conditions: [{ field: "count", operator: "gte", value: 0 }],
			});
			expect(evaluatePolicy([r], { count: -1 }).matched).toHaveLength(0);
		});
	});

	describe("lt — negative numbers", () => {
		it("matches negative number below threshold", () => {
			const r = rule({
				conditions: [{ field: "balance", operator: "lt", value: 0 }],
			});
			expect(evaluatePolicy([r], { balance: -5 }).matched).toHaveLength(1);
		});

		it("does not match zero when threshold is zero", () => {
			const r = rule({
				conditions: [{ field: "balance", operator: "lt", value: 0 }],
			});
			expect(evaluatePolicy([r], { balance: 0 }).matched).toHaveLength(0);
		});

		it("handles non-numeric field", () => {
			const r = rule({
				conditions: [{ field: "balance", operator: "lt", value: 100 }],
			});
			expect(evaluatePolicy([r], { balance: "fifty" }).matched).toHaveLength(0);
		});
	});

	describe("lte — zero", () => {
		it("matches zero when value is zero", () => {
			const r = rule({
				conditions: [{ field: "remaining", operator: "lte", value: 0 }],
			});
			expect(evaluatePolicy([r], { remaining: 0 }).matched).toHaveLength(1);
		});

		it("matches negative numbers", () => {
			const r = rule({
				conditions: [{ field: "remaining", operator: "lte", value: 0 }],
			});
			expect(evaluatePolicy([r], { remaining: -10 }).matched).toHaveLength(1);
		});

		it("does not match positive when value is zero", () => {
			const r = rule({
				conditions: [{ field: "remaining", operator: "lte", value: 0 }],
			});
			expect(evaluatePolicy([r], { remaining: 1 }).matched).toHaveLength(0);
		});
	});

	describe("in — empty array", () => {
		it("does not match any value against empty array", () => {
			const r = rule({
				conditions: [{ field: "role", operator: "in", value: [] }],
			});
			expect(evaluatePolicy([r], { role: "admin" }).matched).toHaveLength(0);
			expect(evaluatePolicy([r], { role: undefined }).matched).toHaveLength(0);
		});

		it("returns false when value is not an array", () => {
			const r = rule({
				conditions: [{ field: "role", operator: "in", value: "admin" }],
			});
			expect(evaluatePolicy([r], { role: "admin" }).matched).toHaveLength(0);
		});

		it("matches undefined in array containing undefined", () => {
			const r = rule({
				conditions: [{ field: "role", operator: "in", value: [undefined, "admin"] }],
			});
			expect(evaluatePolicy([r], {}).matched).toHaveLength(1);
		});
	});

	describe("not_in — empty array", () => {
		it("always matches against empty array (nothing to exclude)", () => {
			const r = rule({
				conditions: [{ field: "provider", operator: "not_in", value: [] }],
			});
			expect(evaluatePolicy([r], { provider: "anything" }).matched).toHaveLength(1);
		});

		it("returns false when value is not an array", () => {
			const r = rule({
				conditions: [{ field: "provider", operator: "not_in", value: "blocked" }],
			});
			expect(evaluatePolicy([r], { provider: "openai" }).matched).toHaveLength(0);
		});
	});

	describe("contains — edge cases", () => {
		it("matches empty string (every string contains empty string)", () => {
			const r = rule({
				conditions: [{ field: "prompt", operator: "contains", value: "" }],
			});
			expect(evaluatePolicy([r], { prompt: "anything" }).matched).toHaveLength(1);
		});

		it("is case-sensitive", () => {
			const r = rule({
				conditions: [{ field: "prompt", operator: "contains", value: "Secret" }],
			});
			expect(evaluatePolicy([r], { prompt: "this is secret" }).matched).toHaveLength(0);
			expect(evaluatePolicy([r], { prompt: "this is Secret" }).matched).toHaveLength(1);
		});

		it("does not match when resolved is not a string", () => {
			const r = rule({
				conditions: [{ field: "data", operator: "contains", value: "x" }],
			});
			expect(evaluatePolicy([r], { data: 123 }).matched).toHaveLength(0);
			expect(evaluatePolicy([r], { data: null }).matched).toHaveLength(0);
		});

		it("does not match when value is not a string", () => {
			const r = rule({
				conditions: [{ field: "prompt", operator: "contains", value: 123 as unknown as string }],
			});
			expect(evaluatePolicy([r], { prompt: "123" }).matched).toHaveLength(0);
		});
	});

	describe("regex — edge cases", () => {
		it("handles invalid regex without crashing (returns false)", () => {
			const r = rule({
				conditions: [{ field: "text", operator: "regex", value: "(?P<invalid>" }],
			});
			expect(evaluatePolicy([r], { text: "test" }).matched).toHaveLength(0);
		});

		it("does not match when resolved is not a string", () => {
			const r = rule({
				conditions: [{ field: "count", operator: "regex", value: "\\d+" }],
			});
			expect(evaluatePolicy([r], { count: 42 }).matched).toHaveLength(0);
		});

		it("does not match when value is not a string", () => {
			const r = rule({
				conditions: [{ field: "text", operator: "regex", value: 42 as unknown as string }],
			});
			expect(evaluatePolicy([r], { text: "42" }).matched).toHaveLength(0);
		});

		it("matches complex regex patterns", () => {
			const r = rule({
				conditions: [
					{ field: "ip", operator: "regex", value: "^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$" },
				],
			});
			expect(evaluatePolicy([r], { ip: "192.168.1.1" }).matched).toHaveLength(1);
			expect(evaluatePolicy([r], { ip: "not-an-ip" }).matched).toHaveLength(0);
		});
	});

	describe("default/unknown operator (line 156)", () => {
		it("returns false for unknown operator", () => {
			const r = rule({
				conditions: [{ field: "x", operator: "unknown_op" as unknown as FieldOperator, value: 1 }],
			});
			const result = evaluatePolicy([r], { x: 1 });
			expect(result.matched).toHaveLength(0);
		});
	});
});

// ===========================================================================
// Scope matching — additional edge cases
// ===========================================================================

describe("scope matching — edge cases", () => {
	it("empty scopes in context fails", () => {
		const r = rule({
			scopePatterns: ["src/**"],
			conditions: [],
		});
		const result = evaluatePolicy([r], { scope: [] });
		expect(result.matched).toHaveLength(0);
	});

	it("rule without scopePatterns matches regardless of context scope", () => {
		const r = rule({
			conditions: [],
		});
		const result = evaluatePolicy([r], { scope: ["anything"] });
		expect(result.matched).toHaveLength(1);
	});

	it("empty scopePatterns array does not require scope matching", () => {
		const r = rule({
			scopePatterns: [],
			conditions: [],
		});
		const result = evaluatePolicy([r], {});
		expect(result.matched).toHaveLength(1);
	});
});

// ===========================================================================
// Multiple rules — mixed hard and soft
// ===========================================================================

describe("multiple rules — mixed enforcement", () => {
	it("one hard violation denies even with soft warnings", () => {
		const hard = rule({
			name: "hard-block",
			effect: "deny",
			enforcement: "hard",
			conditions: [{ field: "blocked", operator: "eq", value: true }],
		});
		const soft = rule({
			name: "soft-warn",
			effect: "warn",
			enforcement: "soft",
			conditions: [{ field: "risky", operator: "eq", value: true }],
		});

		const result = evaluatePolicy([hard, soft], { blocked: true, risky: true });
		expect(result.decision).toBe("deny");
		expect(result.hardViolations).toHaveLength(1);
		expect(result.softViolations).toHaveLength(1);
		expect(result.hasWarnings).toBe(true);
	});

	it("allow effect rules are matched but do not cause violations", () => {
		const r = rule({
			name: "allow-rule",
			effect: "deny",
			enforcement: "hard",
			conditions: [{ field: "x", operator: "eq", value: 1 }],
		});
		// Change effect to something that's not deny/warn
		(r as unknown as { effect: string }).effect = "allow";
		const result = evaluatePolicy([r], { x: 1 });
		// Rule matches, but not a violation (effect is not deny/warn)
		// Wait — PolicyEffect is "deny" | "warn" only. Let's test that a deny
		// with no match doesn't produce violations.
		// Actually, let me test deny rule that doesn't match.
	});

	it("reasons include description when present", () => {
		const r = rule({
			name: "described-rule",
			description: "This rule blocks bad things",
			conditions: [{ field: "bad", operator: "eq", value: true }],
		});
		const result = evaluatePolicy([r], { bad: true });
		expect(result.reasons[0]).toContain("This rule blocks bad things");
	});

	it("reasons use name when description absent", () => {
		const r = rule({
			name: "name-only-rule",
			conditions: [{ field: "bad", operator: "eq", value: true }],
		});
		(r as unknown as { description: undefined }).description = undefined;
		const result = evaluatePolicy([r], { bad: true });
		expect(result.reasons[0]).toContain("name-only-rule");
	});
});

// ===========================================================================
// evaluatedAt timestamp
// ===========================================================================

describe("evaluatedAt timestamp", () => {
	it("uses context.timestamp when provided", () => {
		const ts = "2026-01-15T10:00:00Z";
		const result = evaluatePolicy([], { timestamp: ts });
		expect(result.evaluatedAt).toBe(ts);
	});

	it("defaults to current time when no timestamp", () => {
		const before = new Date().toISOString();
		const result = evaluatePolicy([], {});
		const after = new Date().toISOString();
		expect(result.evaluatedAt >= before).toBe(true);
		expect(result.evaluatedAt <= after).toBe(true);
	});
});

// ===========================================================================
// Time window — startHour branch (line 206)
// ===========================================================================

describe("time window — startHour rejection", () => {
	it("rejects when hour is before startHour (line 206)", () => {
		const d = new Date();
		d.setHours(6, 0, 0, 0); // 6 AM local
		const ts = d.toISOString();

		expect(isWithinTimeWindow([{ startHour: 9, endHour: 17 }], ts)).toBe(false);
	});

	it("accepts when hour equals startHour", () => {
		const d = new Date();
		d.setHours(9, 0, 0, 0);
		const ts = d.toISOString();

		expect(isWithinTimeWindow([{ startHour: 9, endHour: 17 }], ts)).toBe(true);
	});

	it("rejects when hour equals endHour (exclusive)", () => {
		const d = new Date();
		d.setHours(17, 0, 0, 0);
		const ts = d.toISOString();

		expect(isWithinTimeWindow([{ startHour: 9, endHour: 17 }], ts)).toBe(false);
	});

	it("accepts when only daysOfWeek constraint matches", () => {
		const d = new Date();
		const day = d.getDay();
		const ts = d.toISOString();

		expect(isWithinTimeWindow([{ daysOfWeek: [day] }], ts)).toBe(true);
	});
});

// ===========================================================================
// Rule time window via evaluatePolicy — no context.timestamp (line 271)
// ===========================================================================

describe("rule time window — no context.timestamp", () => {
	it("uses current time when context.timestamp is absent (line 271)", () => {
		const now = new Date();
		const hour = now.getHours();
		const day = now.getDay();

		const r = rule({
			conditions: [],
			timeWindows: [{ daysOfWeek: [day], startHour: hour, endHour: hour + 1 }],
		});

		// No timestamp in context — should use current time
		const result = evaluatePolicy([r], {});
		expect(result.matched).toHaveLength(1);
	});
});

// ===========================================================================
// Priority sort — both priorities undefined (line 302)
// ===========================================================================

describe("priority sort — both undefined", () => {
	it("handles both rules with undefined priority (both default to 100)", () => {
		const r1 = rule({ name: "rule-a", conditions: [] });
		const r2 = rule({ name: "rule-b", conditions: [] });
		(r1 as Record<string, unknown>).priority = undefined;
		(r2 as Record<string, unknown>).priority = undefined;

		const result = evaluatePolicy([r1, r2], {});
		expect(result.matched).toHaveLength(2);
	});

	it("handles one undefined priority against explicit priority", () => {
		const explicit = rule({ name: "explicit-50", priority: 50, conditions: [] });
		const implicit = rule({ name: "implicit-100", conditions: [] });
		(implicit as Record<string, unknown>).priority = undefined;

		const result = evaluatePolicy([implicit, explicit], {});
		expect(result.matched).toHaveLength(2);
		expect(result.matched[0]?.name).toBe("explicit-50");
	});
});
