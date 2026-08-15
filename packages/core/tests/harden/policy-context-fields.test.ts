// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Source-parity guard for the PolicyContext trust classification.
 *
 * The three governor call sites spread caller-supplied params into the policy
 * context. Which of the context's DECLARED fields the caller may contribute is
 * a trust decision, and it has been got wrong in production before: `timestamp`
 * was missing from the hand-maintained re-assertion list (PR #95), so a request
 * body chose the clock a `timeWindows` curfew rule was measured against.
 *
 * A list of literals cannot notice when someone adds a seventh field. This test
 * can: it reads the interface out of the source and requires every declared
 * field to be classified as either host-owned (and therefore stripped) or
 * deliberately caller-supplied (with the reasoning recorded next to it). There
 * is no third option and no default, so the next field added to PolicyContext
 * cannot be quietly left unclassified.
 *
 * Same mechanism as the `shared/ids.ts` ↔ `cli/budget.ts` charset mirror.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CALLER_SUPPLIED_POLICY_FIELDS,
	evaluatePolicy,
	type GateRule,
	HOST_ASSERTED_CONTEXT_KEYS,
	HOST_CONTROLLED_POLICY_FIELDS,
	sanitizePolicyContext,
} from "../../src/policy/gate.js";

const GATE_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src/policy/gate.ts");

/**
 * Field names declared directly on the `PolicyContext` interface body.
 *
 * Deliberately a source read rather than a type-level trick: `PolicyContext`
 * extends `Record<string, unknown>`, which makes `keyof PolicyContext` collapse
 * to `string | number`, so TypeScript cannot enumerate the declared keys for us.
 */
function declaredPolicyContextFields(): string[] {
	const src = readFileSync(GATE_SRC, "utf-8");
	const start = src.indexOf("export interface PolicyContext");
	expect(start, "PolicyContext interface not found in gate.ts").toBeGreaterThan(-1);
	const open = src.indexOf("{", start);
	const end = src.indexOf("\n}", open);
	expect(end, "PolicyContext interface has no closing brace").toBeGreaterThan(open);
	const body = src.slice(open, end);

	const fields: string[] = [];
	for (const line of body.split("\n")) {
		// A declaration line: exactly one tab of indent, then `name?:` or `name:`.
		const m = /^\t([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
		if (m?.[1] !== undefined) fields.push(m[1]);
	}
	return fields;
}

describe("PolicyContext trust classification is exhaustive", () => {
	it("finds the interface and its fields (guards against a vacuous test)", () => {
		const declared = declaredPolicyContextFields();
		// If a refactor renames or reshapes the interface this test must fail loudly
		// rather than pass over an empty set — a vacuous parity test is exactly the
		// silent-success shape it exists to prevent.
		expect(declared.length).toBeGreaterThanOrEqual(6);
		expect(declared).toContain("timestamp");
		expect(declared).toContain("cost_center");
	});

	it("classifies EVERY declared field as host-controlled or caller-supplied", () => {
		const declared = declaredPolicyContextFields();
		const classified = new Set<string>([
			...HOST_CONTROLLED_POLICY_FIELDS,
			...CALLER_SUPPLIED_POLICY_FIELDS,
		]);
		const unclassified = declared.filter((f) => !classified.has(f));
		expect(
			unclassified,
			`PolicyContext declares ${unclassified.join(", ")} but neither HOST_CONTROLLED_POLICY_FIELDS ` +
				"nor CALLER_SUPPLIED_POLICY_FIELDS names it. Every declared field is a trust decision: add it " +
				"to HOST_CONTROLLED_POLICY_FIELDS if a caller must not supply it (it will then be stripped " +
				"before the spread at all three governor sites), or to CALLER_SUPPLIED_POLICY_FIELDS with a " +
				"comment recording why the caller legitimately owns it.",
		).toEqual([]);
	});

	it("names nothing that PolicyContext does not declare", () => {
		const declared = new Set(declaredPolicyContextFields());
		for (const f of [...HOST_CONTROLLED_POLICY_FIELDS, ...CALLER_SUPPLIED_POLICY_FIELDS]) {
			expect(declared.has(f), `${f} is classified but no longer declared on PolicyContext`).toBe(
				true,
			);
		}
	});

	it("keeps the two lists disjoint", () => {
		const host = new Set<string>(HOST_CONTROLLED_POLICY_FIELDS);
		const both = CALLER_SUPPLIED_POLICY_FIELDS.filter((f) => host.has(f));
		expect(both, "a field cannot be both host-controlled and caller-supplied").toEqual([]);
	});

	it("classifies scope as host-controlled — a caller must not satisfy scopePatterns", () => {
		expect(HOST_CONTROLLED_POLICY_FIELDS).toContain("scope");
		expect(CALLER_SUPPLIED_POLICY_FIELDS).not.toContain("scope");
	});
});

const GOVERN_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src/govern.ts");
const HEADLESS_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src/headless.ts");

describe("host scope is re-asserted at all three evaluatePolicy sites", () => {
	function evaluatePolicyBlocks(src: string): string[] {
		const blocks: string[] = [];
		let from = 0;
		while (from < src.length) {
			const at = src.indexOf("evaluatePolicy(", from);
			if (at < 0) break;
			const open = src.indexOf("{", at);
			if (open < 0) break;
			// Each call site is a single object literal closed by `});`.
			const close = src.indexOf("});", open);
			if (close < 0) break;
			blocks.push(src.slice(open, close));
			from = close + 3;
		}
		return blocks;
	}

	it("every evaluatePolicy object literal asserts scope: config.scope", () => {
		const blocks = [
			...evaluatePolicyBlocks(readFileSync(GOVERN_SRC, "utf-8")),
			...evaluatePolicyBlocks(readFileSync(HEADLESS_SRC, "utf-8")),
		];
		// Three sites: LLM path, governAction, headless authorize. A fourth
		// would be a new surface that forgot the table in AGENTS.md.
		expect(blocks.length).toBe(3);
		for (const [i, block] of blocks.entries()) {
			expect(block, `site ${i + 1} does not assert host scope`).toMatch(/scope:\s*config\.scope/);
		}
	});
});

describe("sanitizePolicyContext", () => {
	it("strips every host-controlled field a caller tried to supply", () => {
		const hostile: Record<string, unknown> = {
			timestamp: "2020-01-01T00:00:00.000Z",
			budgetFractionRemaining: 0.95,
			budgetRunwayHours: 999,
			cost_center: "someone-elses-envelope",
			scope: ["production/api"],
		};
		const clean = sanitizePolicyContext(hostile);
		for (const f of HOST_CONTROLLED_POLICY_FIELDS) {
			expect(Object.hasOwn(clean, f), `${f} survived sanitisation`).toBe(false);
		}
	});

	it("preserves arbitrary caller keys, which are what rules address by dot-notation", () => {
		const clean = sanitizePolicyContext({
			metadata: { team: "payments" },
			messages: ["hello"],
			timestamp: "2020-01-01T00:00:00.000Z",
		});
		expect(clean.metadata).toEqual({ team: "payments" });
		expect(clean.messages).toEqual(["hello"]);
		expect(Object.hasOwn(clean, "timestamp")).toBe(false);
	});

	it("strips caller-supplied scope — it is host-owned, not caller-declared", () => {
		const clean = sanitizePolicyContext({ scope: ["prod/api"] });
		expect(Object.hasOwn(clean, "scope")).toBe(false);
	});

	it("preserves the deliberately caller-supplied fields", () => {
		const windows = [{ startHour: 9, endHour: 17 }];
		const clean = sanitizePolicyContext({ timeWindows: windows });
		expect(clean.timeWindows).toEqual(windows);
	});

	it("does not mutate its input", () => {
		const input = { timestamp: "2020-01-01T00:00:00.000Z", model: "x" };
		sanitizePolicyContext(input);
		expect(input.timestamp).toBe("2020-01-01T00:00:00.000Z");
	});

	it("tolerates undefined", () => {
		expect(sanitizePolicyContext(undefined)).toEqual({});
	});
});

describe("host-asserted context keys are stripped on EVERY surface", () => {
	// The three call sites assert different subsets: `governAction` sets
	// action_kind/action_name and deliberately no `model`; the LLM and headless
	// paths set `model` and neither action key. A key one surface asserts was
	// therefore unprotected on the surfaces that do not, and arrived from
	// `...params` like any other caller key.
	const noFrontier = {
		name: "no-frontier",
		effect: "deny",
		enforcement: "hard",
		conditions: [{ field: "model", operator: "contains", value: "opus" }],
	} as unknown as GateRule;

	it("a caller cannot answer a question its surface never asks", () => {
		// The action surface sets no `model`, so a hard model rule must stay
		// indeterminate — fail closed — no matter what the caller sends.
		const honest = { ...sanitizePolicyContext(undefined), action_kind: "tool" };
		const injected = { ...sanitizePolicyContext({ model: "safe" }), action_kind: "tool" };
		expect(evaluatePolicy([noFrontier], honest as never).decision).toBe("deny");
		expect(evaluatePolicy([noFrontier], injected as never).decision).toBe("deny");
	});

	it("strips every host-asserted key regardless of surface", () => {
		const hostile: Record<string, unknown> = {};
		for (const k of HOST_ASSERTED_CONTEXT_KEYS) hostile[k] = "forged";
		const clean = sanitizePolicyContext(hostile);
		for (const k of HOST_ASSERTED_CONTEXT_KEYS) {
			expect(Object.hasOwn(clean, k), `${k} survived sanitisation`).toBe(false);
		}
	});

	it("still preserves arbitrary caller keys a policy may address", () => {
		const clean = sanitizePolicyContext({ metadata: { team: "payments" }, model: "forged" });
		expect(clean.metadata).toEqual({ team: "payments" });
		expect(Object.hasOwn(clean, "model")).toBe(false);
	});
});
