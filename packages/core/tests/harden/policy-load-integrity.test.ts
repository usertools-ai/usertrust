// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A policy that cannot be honoured must never be mistaken for a policy.
 *
 * `loadPolicies` previously resolved unparseable or unrecognised input to an
 * empty rule set, via two mechanisms: `catch { return [] }` absorbed parse
 * failures, and a bare `as GateRule[]` cast admitted a rule whose `operator`,
 * `effect` or `enforcement` was outside its union, which then never matched.
 * Neither reported anything.
 *
 * The cases below are the input classes that produced those outcomes, each now
 * asserted to be refused. They are the harness the fix was developed against,
 * ported rather than rewritten.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_RULES, mergePolicies } from "../../src/policy/default-rules.js";
import {
	evaluatePolicy,
	type GateRule,
	loadPolicies,
	PolicyLoadError,
	validatePolicyFile,
} from "../../src/policy/gate.js";

const dir = mkdtempSync(join(tmpdir(), "ut-policy-integrity-"));
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** The operator's intent: block frontier models outright. */
const GOOD_YAML = `rules:
  - id: no-frontier
    name: Block frontier models
    priority: 1
    enabled: true
    effect: deny
    enforcement: hard
    severity: critical
    conditions:
      - field: model
        operator: contains
        value: opus
`;

function write(name: string, content: string): string {
	const p = join(dir, name);
	writeFileSync(p, content);
	return p;
}

/** Exactly what a governor does: platform defaults + whatever the file yields. */
function verdictFor(rules: GateRule[]): string {
	return evaluatePolicy(mergePolicies(DEFAULT_RULES, rules), {
		model: "claude-opus-5",
		budget_remaining: 1_000_000,
		budget_remaining_after: 999_000,
		estimated_cost: 1000,
	} as never).decision;
}

describe("a malformed policy file is refused, never silently emptied", () => {
	it("the intended policy loads and DENIES (the control case)", () => {
		const rules = loadPolicies(write("policy-good.yaml", GOOD_YAML));
		expect(rules).toHaveLength(1);
		expect(verdictFor(rules)).toBe("deny");
	});

	const parseFailures: [string, string, string][] = [
		[
			"policy-tab.yaml",
			GOOD_YAML.replace("  - id: no-frontier", "\t- id: no-frontier"),
			"a TAB (YAML forbids tabs)",
		],
		[
			"policy-badindent.yaml",
			GOOD_YAML.replace("    name: Block frontier models", "  name: Block frontier models"),
			"one wrong indent level",
		],
		[
			"policy-badjson.json",
			'{"rules":[{"id":"no-frontier","effect":"deny",}]}',
			"a trailing comma in JSON",
		],
	];
	for (const [name, content, what] of parseFailures) {
		it(`THROWS on ${what} — was: 0 rules, call ALLOWED`, () => {
			const p = write(name, content);
			expect(() => loadPolicies(p)).toThrow(PolicyLoadError);
			expect(validatePolicyFile(p).rules).toHaveLength(0);
			expect(validatePolicyFile(p).issues.length).toBeGreaterThan(0);
		});
	}

	it("THROWS on a top-level key that is not `rules` — was: 0 rules, call ALLOWED", () => {
		const p = write("policy-wrongkey.yaml", GOOD_YAML.replace("rules:", "policies:"));
		expect(() => loadPolicies(p)).toThrow(PolicyLoadError);
		// The message must name the keys that WERE found — this is the case an
		// operator is least likely to spot unaided.
		expect(() => loadPolicies(p)).toThrow(/no top-level "rules" key.*policies/s);
	});

	const shapeFailures: [string, string, string][] = [
		[
			"policy-typo-op.yaml",
			GOOD_YAML.replace("operator: contains", "operator: contain"),
			"a misspelled operator",
		],
		[
			"policy-typo-enf.yaml",
			GOOD_YAML.replace("enforcement: hard", "enforcement: HARD"),
			"a wrong-cased enforcement",
		],
		[
			"policy-typo-effect.yaml",
			GOOD_YAML.replace("effect: deny", "effect: block"),
			"an effect that is not deny/warn",
		],
		[
			"policy-missing-effect.yaml",
			GOOD_YAML.replace("    effect: deny\n", ""),
			"a rule with no effect at all",
		],
	];
	for (const [name, content, what] of shapeFailures) {
		it(`THROWS on ${what} — was: rule LOADED but never fired, call ALLOWED`, () => {
			const p = write(name, content);
			// The nastier half of the original defect: these files parse fine. The
			// rule arrived, looked real in the file, and simply never matched.
			expect(() => loadPolicies(p)).toThrow(PolicyLoadError);
		});
	}

	it("names the offending rule and field, so the fix is locatable", () => {
		const p = write(
			"policy-locate.yaml",
			GOOD_YAML.replace("operator: contains", "operator: contain"),
		);
		const { issues } = validatePolicyFile(p);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.at).toBe("rules[0].conditions[0].operator");
	});

	it("refuses ALL rules when only one is bad — no silent partial policy", () => {
		// Loading the survivors would enforce a policy the operator never wrote,
		// which is the same silent-partial-application failure in a new costume.
		const twoRules = `rules:
  - name: good rule
    effect: deny
    enforcement: hard
    conditions:
      - field: model
        operator: contains
        value: opus
  - name: bad rule
    effect: deny
    enforcement: hard
    conditions:
      - field: model
        operator: contain
        value: sonnet
`;
		const p = write("policy-one-bad.yaml", twoRules);
		expect(() => loadPolicies(p)).toThrow(PolicyLoadError);
		expect(validatePolicyFile(p).rules).toHaveLength(0);
	});

	it("a value that the operator cannot use is refused at load", () => {
		const p = write(
			"policy-badvalue.yaml",
			GOOD_YAML.replace(
				"operator: contains\n        value: opus",
				"operator: gt\n        value: opus",
			),
		);
		expect(() => loadPolicies(p)).toThrow(/compares numbers/);
	});

	it("an absent file is NOT an error — running with no policy is legitimate", () => {
		const p = join(dir, "definitely-not-here.yaml");
		expect(loadPolicies(p)).toEqual([]);
		expect(validatePolicyFile(p).issues).toEqual([]);
	});

	it("an empty document is an empty policy, not a broken one", () => {
		expect(loadPolicies(write("policy-empty.yaml", ""))).toEqual([]);
	});

	it("a bare list of rules (no `rules:` wrapper) still loads", () => {
		const bare = GOOD_YAML.replace("rules:\n", "").replace(/^ {2}/gm, "");
		expect(loadPolicies(write("policy-bare.yaml", bare))).toHaveLength(1);
	});
});

describe("the validator does not itself discard what it cannot understand", () => {
	// The defect this whole branch is about, in miniature, inside the fix: zod
	// strips unrecognised keys by DEFAULT. A first cut of `GateRuleSchema` used
	// `z.object`, and a rule written with `scopePattern` (singular) validated
	// cleanly, loaded, and silently became an UNSCOPED GLOBAL DENY — the author
	// believing it applied to production only. Strict schemas make an unknown key
	// an error. Caught by probing the fix for the shape it was fixing.
	const MISSPELLED = `rules:
  - name: prod only
    effect: deny
    enforcement: hard
    scopePattern: ["production/*"]
    conditions:
      - field: model
        operator: contains
        value: opus
`;

	it("refuses a rule whose scoping key is misspelled, rather than globalising it", () => {
		const p = write("policy-misspelled-key.yaml", MISSPELLED);
		expect(() => loadPolicies(p)).toThrow(PolicyLoadError);
		const { rules, issues } = validatePolicyFile(p);
		expect(rules).toHaveLength(0);
		expect(issues.length).toBeGreaterThan(0);
		expect(issues[0]?.at).toContain("rules[0]");
	});

	it("refuses an unknown key on a condition", () => {
		const p = write(
			"policy-unknown-cond-key.yaml",
			`rules:
  - name: r
    effect: deny
    enforcement: hard
    conditions:
      - field: model
        operator: contains
        value: opus
        caseSensitive: false
`,
		);
		expect(() => loadPolicies(p)).toThrow(PolicyLoadError);
	});

	it("refuses an unknown key on a time window", () => {
		const p = write(
			"policy-unknown-tw-key.yaml",
			`rules:
  - name: r
    effect: deny
    enforcement: hard
    timeWindows:
      - startHour: 22
        endHour: 6
        timezone: UTC
    conditions:
      - field: model
        operator: contains
        value: opus
`,
		);
		// `timezone` is especially worth refusing: windows are LOCAL by contract,
		// so accepting-and-ignoring it would promise a guarantee we do not honour.
		expect(() => loadPolicies(p)).toThrow(PolicyLoadError);
	});
});

describe("findings from the Codex gate on this branch", () => {
	// Each of these was the branch's own defect class reappearing inside the fix.

	it("P1 — an absent path cannot answer `eq: null` for a HARD rule", () => {
		// `isUnresolved` treated undefined and null alike, so the exemption meant
		// to keep an explicit `value: null` determinate also let an ABSENT field
		// answer it: `undefined === null` is false, the guard was skipped, and the
		// call was allowed.
		const r = {
			name: "deny when unset",
			effect: "deny",
			enforcement: "hard",
			conditions: [{ field: "guarded", operator: "eq", value: null }],
		} as unknown as GateRule;
		expect(evaluatePolicy([r], {}).decision).toBe("deny");
		expect(evaluatePolicy([r], { guarded: null }).decision).toBe("deny");
		expect(evaluatePolicy([r], { guarded: "set" }).decision).toBe("allow");
	});

	it("P1 — an unknown key on the policy ROOT is refused, not dropped", () => {
		// `scopePatterns` written at the document root instead of on the rule it
		// was meant to narrow: the key was silently discarded and the rules it was
		// supposed to scope applied everywhere.
		const p = write(
			"policy-root-key.yaml",
			`scopePatterns: ["production/*"]
rules:
  - name: r
    effect: deny
    enforcement: hard
    conditions:
      - field: model
        operator: contains
        value: opus
`,
		);
		expect(() => loadPolicies(p)).toThrow(PolicyLoadError);
		expect(() => loadPolicies(p)).toThrow(/unknown top-level key/);
	});

	it("the root check does not reject a legitimate document", () => {
		expect(loadPolicies(write("policy-root-ok.yaml", GOOD_YAML))).toHaveLength(1);
	});
});

describe("round-2 findings from the Codex gate", () => {
	it("P1 — a non-finite threshold is refused; NaN would silence the guard", () => {
		// `typeof NaN === "number"` and YAML spells it `.nan`, so the rule validated
		// and then never fired: every comparison against NaN is false, so a hard
		// budget guard let an overspend through while `policy validate` said ok.
		const p = write(
			"policy-nan.yaml",
			`rules:
  - name: budget guard
    effect: deny
    enforcement: hard
    conditions:
      - field: budget_remaining_after
        operator: lt
        value: .nan
`,
		);
		expect(() => loadPolicies(p)).toThrow(/cannot use NaN as an operand/);
	});

	it("P1 — an unreadable policy file is refused, not treated as absent", () => {
		// The call sites used to guard with `existsSync`, which answers false for a
		// file inside a directory it cannot traverse — reporting an unreadable
		// policy as no policy and falling back to the built-in defaults.
		const locked = join(dir, "locked");
		mkdirSync(locked, { recursive: true });
		const p = join(locked, "default.yml");
		writeFileSync(p, GOOD_YAML);
		chmodSync(locked, 0o000);
		try {
			expect(existsSync(p), "existsSync cannot see it, which is the trap").toBe(false);
			expect(() => loadPolicies(p)).toThrow(PolicyLoadError);
		} finally {
			chmodSync(locked, 0o755);
		}
	});

	it("an ABSENT file is still legitimately absent", () => {
		expect(loadPolicies(join(dir, "not-here-at-all.yaml"))).toEqual([]);
	});

	it("P2 — a root-key problem does not hide a malformed rule", () => {
		// `policy validate` promises every problem in one pass; returning early on
		// the root key made the operator fix it and come back for the next one.
		const p = write(
			"policy-root-and-rule.yaml",
			`scopePatterns: ["production/*"]
rules:
  - name: r
    effect: deny
    enforcement: hard
    conditions:
      - field: model
        operator: contain
        value: opus
`,
		);
		const { issues } = validatePolicyFile(p);
		expect(issues.length).toBeGreaterThanOrEqual(2);
		expect(issues.some((i) => i.at === "scopePatterns")).toBe(true);
		expect(issues.some((i) => i.at.startsWith("rules[0]"))).toBe(true);
	});
});

describe("round-4 findings", () => {
	it("C1 controls are neutralised, not just C0", () => {
		// U+009B is the 8-bit CSI introducer: a terminal honouring it can be
		// repainted by a string the common C0-only regex passes untouched.
		// AGENTS.md records why budget.ts's sanitizer is deliberately stronger.
		const p = write(
			"policy-c1.yaml",
			`rules:\n  - name: "r\u009b[2Jok"\n    effect: deny\n    enforcement: hard\n    conditions: []\n`,
		);
		const { rules } = validatePolicyFile(p);
		expect(rules).toHaveLength(1);
		// The scrubbing happens at render; assert the raw value still carries it so
		// this test fails loudly if the fixture ever stops exercising the case.
		expect(rules[0]?.name).toContain("\u009b");
	});

	it("root issues survive a wrong-typed rules value", () => {
		const p = write(
			"policy-root-and-badrules.yaml",
			`scopePatterns: ["production/*"]\nrules: {}\n`,
		);
		const { issues } = validatePolicyFile(p);
		expect(issues.some((i) => i.at === "scopePatterns")).toBe(true);
		expect(issues.some((i) => i.at === "rules")).toBe(true);
	});

	it("reports presence explicitly, so no caller re-derives it with existsSync", () => {
		expect(validatePolicyFile(join(dir, "nope.yaml")).present).toBe(false);
		expect(validatePolicyFile(write("policy-present.yaml", GOOD_YAML)).present).toBe(true);
		const locked = join(dir, "locked2");
		mkdirSync(locked, { recursive: true });
		const p = join(locked, "default.yml");
		writeFileSync(p, GOOD_YAML);
		chmodSync(locked, 0o000);
		try {
			// Present but unreadable: present=true and an issue, NOT absent.
			const r = validatePolicyFile(p);
			expect(r.present).toBe(true);
			expect(r.issues.length).toBeGreaterThan(0);
		} finally {
			chmodSync(locked, 0o755);
		}
	});
});

describe("round-7 findings", () => {
	it("a non-finite operand is refused for EVERY operator, not just the numeric four", () => {
		// The finite guard was scoped to gt/gte/lt/lte, so `eq: .nan` still loaded —
		// and `NaN === NaN` is false, so that rule can never match either. Scoping a
		// check to the operators it was written for left exactly that hole.
		for (const op of ["eq", "neq", "gt", "gte", "lt", "lte"]) {
			const p = write(
				`policy-nan-${op}.yaml`,
				`rules:\n  - name: guard\n    effect: deny\n    enforcement: hard\n    conditions:\n      - field: risk_score\n        operator: ${op}\n        value: .nan\n`,
			);
			expect(() => loadPolicies(p), `${op} must refuse NaN`).toThrow(
				/cannot use NaN as an operand/,
			);
		}
	});

	it("an array operand containing NaN is still allowed — includes() matches it", () => {
		// SameValueZero: [NaN].includes(NaN) is true, so `in: [.nan]` is a rule that
		// works and must not be refused alongside the ones that cannot.
		const p = write(
			"policy-nan-in.yaml",
			`rules:\n  - name: guard\n    effect: deny\n    enforcement: hard\n    conditions:\n      - field: risk_score\n        operator: in\n        value: [.nan]\n`,
		);
		expect(loadPolicies(p)).toHaveLength(1);
		expect(evaluatePolicy(loadPolicies(p), { risk_score: Number.NaN } as never).decision).toBe(
			"deny",
		);
	});

	it("root issues survive a document with no rules key at all", () => {
		const p = write("policy-root-no-rules.yaml", `scopePatterns: ["p/*"]\ntimeWindows: []\n`);
		const { issues } = validatePolicyFile(p);
		expect(issues.some((i) => i.at === "scopePatterns")).toBe(true);
		expect(issues.some((i) => i.at === "timeWindows")).toBe(true);
		expect(issues.some((i) => i.at === "file")).toBe(true);
	});
});

describe("one-pass reporting holds for structural AND semantic faults together", () => {
	it("reports an unknown key and a bad operand on the same condition", () => {
		// zod skips `.superRefine` when the object parse fails, so a strict schema
		// reported only the unknown key and the operator had to fix it and re-run to
		// discover the second fault. The key check now lives inside the refinement,
		// over a `looseObject` — `object` would strip the unknown key before the
		// check could see it, which is the same silently-discarded-input shape.
		const p = write(
			"policy-both-faults.json",
			JSON.stringify({
				rules: [
					{
						name: "r",
						effect: "deny",
						enforcement: "hard",
						conditions: [{ field: "x", operator: "gt", value: "not-a-number", typo: 1 }],
					},
				],
			}),
		);
		const { issues } = validatePolicyFile(p);
		expect(issues.some((i) => i.at.endsWith(".typo"))).toBe(true);
		expect(issues.some((i) => i.at.endsWith(".value"))).toBe(true);
		expect(issues.length).toBeGreaterThanOrEqual(2);
	});

	it("still refuses an unknown key on its own", () => {
		const p = write(
			"policy-unknown-key-alone.json",
			JSON.stringify({
				rules: [
					{
						name: "r",
						effect: "deny",
						enforcement: "hard",
						conditions: [{ field: "x", operator: "eq", value: 1, caseSensitive: false }],
					},
				],
			}),
		);
		expect(() => loadPolicies(p)).toThrow(/unknown key on a condition/);
	});

	it("a valid condition still loads carrying only its own keys", () => {
		const rules = loadPolicies(write("policy-clean-cond.yaml", GOOD_YAML));
		expect(Object.keys(rules[0]?.conditions[0] ?? {})).toEqual(["field", "operator", "value"]);
	});
});
