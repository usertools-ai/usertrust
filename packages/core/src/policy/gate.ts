// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Policy Gate — 12 Field Operators
 *
 * Evaluates policy rules against a context to determine allow/deny decisions.
 * Supports both hard (blocking) and soft (warning) enforcement modes.
 *
 * Policy evaluation engine for the usertrust SDK.
 * Uses the shared PolicyRule/FieldCondition types with dot-notation field
 * resolution, glob matching on scope patterns, and time-window constraints.
 *
 * 12 operators: exists, not_exists, eq, neq, gt, gte, lt, lte, in, not_in,
 * contains, regex.
 */

import { readFileSync } from "node:fs";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
	FieldCondition,
	FieldOperator,
	PolicyEffect,
	PolicyEnforcement,
	PolicyRule,
	PolicySeverity,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface RuleMatch {
	/**
	 * Rule id, when the rule declares one. OMITTED (not `undefined`) for an
	 * ID-less rule, so an audit payload built from this carries no empty key
	 * under `exactOptionalPropertyTypes`.
	 */
	id?: string;
	/** Rule name */
	name: string;
	/** Effect of the matched rule */
	effect: PolicyEffect;
	/** Enforcement level */
	enforcement: PolicyEnforcement;
	/** Severity if set */
	severity: PolicySeverity | undefined;
	/** Field names of the rule's conditions — lets a throw site classify the denial. */
	fields: string[];
}

export interface PolicyResult {
	/** Overall decision: deny if any hard violation, otherwise allow */
	decision: "allow" | "deny";
	/** Whether soft violations (warnings) were found */
	hasWarnings: boolean;
	/** All matched rules */
	matched: RuleMatch[];
	/** Hard violations that caused deny */
	hardViolations: RuleMatch[];
	/** Soft violations (warnings only) */
	softViolations: RuleMatch[];
	/** Human-readable reasons */
	reasons: string[];
	/** Evaluation timestamp */
	evaluatedAt: string;
}

/** Policy-context fields whose rules deny for BUDGET reasons, not content reasons. */
const BUDGET_HINT_FIELDS = new Set([
	"budget_remaining",
	"budget_remaining_after",
	"budgetFractionRemaining",
	"budgetRunwayHours",
	"estimated_cost",
]);

/**
 * Does this matched rule deny for BUDGET reasons rather than content reasons?
 *
 * The single source for the budget-family question, shared by `derivePolicyHint`
 * (which remedy to prescribe) and the denial-event classifier (`budget_gate` vs
 * `policy`). Duplicating the field set in the audit module would let the two
 * drift, and then a chain event would classify a denial differently from the
 * hint the same denial printed.
 */
export function isBudgetRuleMatch(match: RuleMatch): boolean {
	return match.fields.some((f) => BUDGET_HINT_FIELDS.has(f));
}

/**
 * Class-aware operator remedy for a gate denial (D6). Returns `undefined` when no
 * hard violation is budget-classed — the error's default hint then applies. PII
 * and injection denials never reach here: they throw from their own detector
 * sites, which pass their own class hints.
 *
 * `attributed` is the caller's own truth about whether an ENVELOPE is in scope for
 * the denied call, and it selects between two remedies that are not
 * interchangeable. An attributed call's hold debits the cost center's wallet, so
 * `allocateBudget` can move it. An UNATTRIBUTED call's hold debits the session
 * holding wallet, which no envelope funds — prescribing `allocateBudget` there
 * sends an operator to a lever that provably cannot lift this denial. Pass
 * `envelope !== undefined` from the gate call site; never guess it from the rule.
 */
export function derivePolicyHint(result: PolicyResult, attributed: boolean): string | undefined {
	const budgetHit = result.hardViolations.some(isBudgetRuleMatch);
	if (!budgetHit) return undefined;
	return attributed
		? "A budget rule denied this call: check the envelope's allocation (allocateBudget) and your budgetFractionRemaining / budgetRunwayHours tiers."
		: "A budget rule denied this call: increase the budget in trust() options or reduce the call's max_tokens, and review your budget_remaining / budget_remaining_after tiers.";
}

// ---------------------------------------------------------------------------
// Dot-notation field resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a dot-separated field path from a nested object.
 * E.g. "context.data.model" traverses { context: { data: { model: "x" } } }.
 */
function resolveFieldPath(path: string, context: Record<string, unknown>): unknown {
	const parts = path.split(".");
	let current: unknown = context;

	for (const part of parts) {
		if (current == null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}

	return current;
}

// ---------------------------------------------------------------------------
// Regex safety guard (AUD-463)
// ---------------------------------------------------------------------------

/** Maximum allowed length for regex patterns in policy rules. */
const MAX_REGEX_LENGTH = 200;

/** Maximum input length the regex engine is allowed to scan (defense-in-depth). */
const MAX_REGEX_INPUT = 4096;

/**
 * Adjacent nested quantifiers, e.g. `a+*`, `a*+`, `a{2,}*`, `a+{2,}`.
 */
const ADJACENT_QUANTIFIER_RE = /[+*?]\{?\d*,?\d*\}?[+*?]/;

/**
 * Structural catastrophic-backtracking guard.
 *
 * Rejects a group `( ... )` that is immediately followed by an unbounded
 * quantifier (`*`, `+`, or `{n,}`) when the group body itself contains a
 * quantifier (`*` `+` `?` `{`) or an alternation (`|`). This is the canonical
 * shape of exponential backtracking: `(a+)+`, `(.*)*`, `(\d+)+`, `(a|a)*`,
 * `(a|ab)*`, etc. Escaped parens (`\(`) and character classes (`[...]`) are
 * handled by tracking escape/class state so real group boundaries are matched.
 *
 * Conservative by design: it may reject some benign patterns, but policy
 * regexes are operator-authored config, so over-rejection is acceptable and
 * fails safe (safeRegExp returns null → condition is non-matching).
 */
function hasNestedQuantifiedGroup(pattern: string): boolean {
	// Per open group, whether its body so far contains a quantifier/alternation.
	const bodyHasAmbiguity: boolean[] = [];
	let escaped = false;
	let inClass = false; // inside a [...] character class

	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];

		if (escaped) {
			escaped = false;
			continue;
		}
		if (c === "\\") {
			escaped = true;
			continue;
		}
		if (inClass) {
			if (c === "]") inClass = false;
			continue;
		}
		if (c === "[") {
			inClass = true;
			continue;
		}

		if (c === "(") {
			bodyHasAmbiguity.push(false);
			continue;
		}

		if (c === "|" || c === "*" || c === "+" || c === "?" || c === "{") {
			// Mark the innermost open group's body as ambiguous.
			if (bodyHasAmbiguity.length > 0) {
				bodyHasAmbiguity[bodyHasAmbiguity.length - 1] = true;
			}
		}

		if (c === ")") {
			const ambiguous = bodyHasAmbiguity.pop() ?? false;
			// Look at the quantifier applied to this group.
			const next = pattern[i + 1];
			const unboundedQuantifier =
				next === "*" ||
				next === "+" ||
				(next === "{" &&
					/^\{\d*,\d*\}/.test(pattern.slice(i + 1)) &&
					!/^\{\d+\}/.test(pattern.slice(i + 1))); // {n,} or {n,m}/{,m}, not {n}
			if (ambiguous && unboundedQuantifier) return true;
			// Propagate ambiguity outward: a quantified group is itself ambiguous
			// content for any enclosing group.
			if (
				bodyHasAmbiguity.length > 0 &&
				(next === "*" || next === "+" || next === "?" || next === "{")
			) {
				bodyHasAmbiguity[bodyHasAmbiguity.length - 1] = true;
			}
		}
	}
	return false;
}

/**
 * Validate that a regex pattern is safe to compile and execute.
 *
 * **Security** (AUD-463): prevents ReDoS (Regular Expression Denial of Service).
 * - Patterns longer than 200 characters are rejected.
 * - Adjacent nested quantifiers (`a+*`, `x{2,}+`) are rejected.
 * - A quantified group whose body contains a quantifier/alternation
 *   (`(a+)+`, `(.*)*`, `(\d+)+`, `(a|a)*`) is rejected structurally at compile
 *   time — this eliminates the exponential-backtracking class deterministically.
 * - Invalid regex syntax is caught and treated as non-matching.
 *
 * @returns The compiled RegExp, or null if the pattern is unsafe or invalid.
 */
function safeRegExp(pattern: string): RegExp | null {
	if (pattern.length > MAX_REGEX_LENGTH) return null;
	if (ADJACENT_QUANTIFIER_RE.test(pattern)) return null;
	if (hasNestedQuantifiedGroup(pattern)) return null;
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Field condition evaluation (12 operators)
// ---------------------------------------------------------------------------

/**
 * Tri-state result of evaluating a single condition:
 * - `true`  — the condition is satisfied.
 * - `false` — the field is present and comparable but does NOT satisfy.
 * - `"indeterminate"` — the field is missing or the wrong type, so the
 *   comparison cannot be evaluated. Numeric operators produce this instead of
 *   silently returning `false`; `ruleMatches` decides the safe direction based
 *   on enforcement (hard rules fail closed, soft rules stay lenient).
 */
type CondResult = boolean | "indeterminate";

/**
 * Evaluate a single field condition against the evaluation context.
 * Supports all 12 operators from the FieldOperator union.
 *
 * Numeric operators (`gt`/`gte`/`lt`/`lte`) return `"indeterminate"` when the
 * field is absent or non-numeric — the distinction between "present but does not
 * satisfy" (`false`) and "cannot be evaluated" (`"indeterminate"`) is what lets
 * hard rules fail closed instead of silently allowing an unbounded operation.
 */
function evaluateFieldCondition(fc: FieldCondition, context: Record<string, unknown>): CondResult {
	const resolved = resolveFieldPath(fc.field, context);

	switch (fc.operator) {
		case "exists":
			return resolved !== undefined && resolved !== null;

		case "not_exists":
			return resolved === undefined || resolved === null;

		// Every operator below COMPARES a resolved value. If the field did not
		// resolve, the comparison is not false — it is unanswerable, and only
		// "indeterminate" carries that to `ruleMatches`, which is what makes a hard
		// rule fail closed. Returning bare `false` here (the prior behaviour for
		// eq/in/contains/regex) reads as "the rule did not match", which skips the
		// guard rather than firing it.
		//
		// `exists`/`not_exists` are deliberately NOT in this set: an unresolved
		// field is precisely what they measure, so for them it is a determinate
		// answer, not a missing one.
		// `undefined` here means the PATH did not resolve — the key is absent, or
		// the walk ran off a non-object. That is unanswerable. An explicit `null`
		// is different: it is a value the document actually carries, so a rule
		// written `value: null` compares against it determinately. Conflating the
		// two let a hard `eq: null` rule read an ABSENT field as "not null" and
		// allow the call, which is the fail-open shape this file is fixing.
		case "eq":
			if (resolved === undefined) return "indeterminate";
			return resolved === fc.value;

		case "neq":
			if (resolved === undefined) return "indeterminate";
			return resolved !== fc.value;

		case "gt":
			if (typeof resolved !== "number" || typeof fc.value !== "number") return "indeterminate";
			return resolved > fc.value;

		case "gte":
			if (typeof resolved !== "number" || typeof fc.value !== "number") return "indeterminate";
			return resolved >= fc.value;

		case "lt":
			if (typeof resolved !== "number" || typeof fc.value !== "number") return "indeterminate";
			return resolved < fc.value;

		case "lte":
			if (typeof resolved !== "number" || typeof fc.value !== "number") return "indeterminate";
			return resolved <= fc.value;

		// Membership reads the ARRAY, so an explicit `null` in the list is a value
		// the author put there on purpose: `not_in: [null]` says "null is allowed".
		// Only a path that did not resolve is unanswerable here.
		case "in":
			if (!Array.isArray(fc.value)) return "indeterminate";
			if (resolved === undefined) return "indeterminate";
			return fc.value.includes(resolved);

		case "not_in":
			if (!Array.isArray(fc.value)) return "indeterminate";
			if (resolved === undefined) return "indeterminate";
			return !fc.value.includes(resolved);

		case "contains":
			if (typeof fc.value !== "string") return "indeterminate";
			// A non-string subject (absent, or an array/object the caller sent in
			// place of the string the rule expects) cannot answer "contains".
			if (typeof resolved !== "string") return "indeterminate";
			return resolved.includes(fc.value);

		case "regex": {
			if (typeof fc.value !== "string") return "indeterminate";
			if (typeof resolved !== "string") return "indeterminate";
			const re = safeRegExp(fc.value);
			// An unusable pattern is refused at load time; reaching here means the
			// rule was built programmatically. Unanswerable, not "no".
			if (re === null) return "indeterminate";
			// Layer B (defense-in-depth): bound the scanned input so even a
			// structural miss cannot be fed an unbounded string.
			const input =
				resolved.length > MAX_REGEX_INPUT ? resolved.slice(0, MAX_REGEX_INPUT) : resolved;
			return re.test(input);
		}

		default:
			// Unreachable for a rule that came through `loadPolicies`, which rejects
			// an unknown operator at load time. Still fails CLOSED rather than
			// returning `false`, because `evaluatePolicy` is also called with
			// programmatically-built rules that never touch the loader: a typo'd
			// operator there used to disable the rule outright and allow the call.
			return "indeterminate";
	}
}

// ---------------------------------------------------------------------------
// Glob matching for scope patterns
// ---------------------------------------------------------------------------

/**
 * Test if any scope in the context matches any scope pattern from the rule.
 * Uses minimatch for full glob support (**, *, brace expansion, etc.).
 */
export function matchesScope(patterns: string[], scopes: string[]): boolean {
	return scopes.some((scope) => patterns.some((pattern) => minimatch(scope, pattern)));
}

// ---------------------------------------------------------------------------
// Time-window constraint
// ---------------------------------------------------------------------------

export interface TimeWindow {
	/** Days of week (0=Sun, 6=Sat) */
	daysOfWeek?: number[];
	/** Start hour (0-23, inclusive) */
	startHour?: number;
	/** End hour (0-23, exclusive) */
	endHour?: number;
}

/**
 * Check if a timestamp falls within any of the given time windows.
 * Returns true if timeWindows is empty/undefined (no constraint).
 */
export function isWithinTimeWindow(
	timeWindows: TimeWindow[] | undefined,
	timestamp: string,
): boolean {
	if (!timeWindows || timeWindows.length === 0) return true;

	const date = new Date(timestamp);
	const dayOfWeek = date.getDay();
	const hour = date.getHours();

	return timeWindows.some((tw) => {
		if (tw.daysOfWeek && !tw.daysOfWeek.includes(dayOfWeek)) return false;

		const { startHour, endHour } = tw;

		// A window that WRAPS MIDNIGHT — `startHour > endHour`, e.g. an overnight
		// window {startHour: 22, endHour: 6}.
		//
		// This was previously evaluated with the two half-open tests below applied
		// independently, which for a wrapping window cannot both pass at any hour:
		// 23 fails `hour >= endHour`, 02 fails `hour < startHour`. Such a window
		// therefore imposed no constraint. Verified across all 24 hours.
		//
		// The day gate above is applied to the timestamp's OWN local day, so an
		// overnight window restricted to Monday covers Monday 22:00-23:59 and
		// Monday 00:00-05:59 — not Tuesday's small hours. That is the reading with
		// the fewest surprises, and the only one that does not require inventing a
		// notion of which day a wrapped window "belongs" to.
		if (startHour !== undefined && endHour !== undefined && startHour > endHour) {
			return hour >= startHour || hour < endHour;
		}

		// Non-wrapping: each bound is independent, and either may be omitted.
		// `startHour === endHour` stays a zero-width window that matches nothing,
		// which is what it did before; read it as "no hours", not "all hours".
		if (startHour !== undefined && hour < startHour) return false;
		if (endHour !== undefined && hour >= endHour) return false;
		return true;
	});
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/**
 * Context passed into evaluatePolicy. Fields are available for dot-notation
 * resolution. The special keys `scope` and `timeWindows` enable glob and
 * time-window matching respectively.
 */
export interface PolicyContext extends Record<string, unknown> {
	/** Optional scope patterns to match against rule scope conditions */
	scope?: string[];
	/** Optional time windows for temporal constraints */
	timeWindows?: TimeWindow[];
	/**
	 * Optional evaluation-time override (defaults to now).
	 *
	 * TRUSTED HOST INPUT ONLY, exactly like the budget fields below: it is what
	 * `ruleMatches` feeds to {@link isWithinTimeWindow}, so whoever writes it
	 * decides whether a `timeWindows` rule fires at all. All three SDK call sites
	 * spread the caller's params first and then re-assert this field as explicit
	 * `undefined`, so a body carrying `{"timestamp": "..."}` cannot walk a call
	 * out of a curfew window — or into one. A host driving `evaluatePolicy`
	 * directly (a replay, a what-if, a backfilled audit) may still set it; that
	 * host owns its own clock.
	 *
	 * Declared `| undefined` so a call site under `exactOptionalPropertyTypes`
	 * can write the field explicitly as `undefined` to overwrite an untrusted
	 * inbound value; the `??` fallback reads the result as absent either way.
	 */
	timestamp?: string | undefined;

	/**
	 * Budget telemetry for the cost center funding this call. Both fields are
	 * OPTIONAL and purely additive: they let the existing numeric operators
	 * express a degradation ladder, so no new operator and no evaluator change
	 * is involved.
	 *
	 * TRUSTED HOST INPUT ONLY. They are governance inputs, so only the host that
	 * owns the allocation may write them — never a request body. `trust()` and
	 * `createGovernor()` spread the caller's LLM params into the context and then
	 * re-assert BOTH fields, so a client posting
	 * `{"budgetFractionRemaining": 0.95}` cannot make a budget tier look
	 * satisfied. What they re-assert depends on the call: one made inside a
	 * `withCostCenter(cc, fn, { allocated, periodStartMs })` scope carries the live
	 * envelope numbers (see {@link PolicyContext.cost_center}); every other call
	 * re-asserts explicit `undefined`, because without a scope the SDK genuinely
	 * does not know which allocation funds the call and "absent" is the honest
	 * answer. A host that owns the allocation itself can still read it and call
	 * `evaluatePolicy` with a context it built:
	 *
	 * ```ts
	 * const status = await getBudgetStatus(tb, {
	 *   parentUserId, costCenter, allocated, periodStartMs,
	 * });
	 * const hours = runwayHours(status.runway, nowMs); // null when not projectable
	 * evaluatePolicy(rules, {
	 *   model,
	 *   budgetFractionRemaining: status.runway.fractionRemaining,
	 *   // omit rather than coerce: null means "no projection", not "0 hours left"
	 *   ...(hours === null ? {} : { budgetRunwayHours: hours }),
	 * });
	 * ```
	 *
	 * ```ts
	 * // deny frontier models below 30% of the allocation
	 * { effect: "deny", enforcement: "hard", conditions: [
	 *     { field: "budgetFractionRemaining", operator: "exists" },
	 *     { field: "budgetFractionRemaining", operator: "lt", value: 0.3 },
	 *     { field: "model", operator: "in", value: ["claude-opus-4-6"] } ] }
	 * // escalate to a human under 12h of runway (warn + soft = non-blocking)
	 * { effect: "warn", enforcement: "soft", conditions: [
	 *     { field: "budgetRunwayHours", operator: "lt", value: 12 } ] }
	 * ```
	 *
	 * IMPORTANT — absent fields are NOT neutral for hard rules. A numeric
	 * operator on a missing field is `"indeterminate"`, which hard rules treat
	 * as fail-closed (the condition is skipped and the guard still fires), so a
	 * HARD budget tier DENIES any context that never populated these fields.
	 * Lead such a rule with an `exists` condition (as above) when it must only
	 * apply to budget-aware call sites; soft rules already stay lenient.
	 */

	/**
	 * 0..1 share of the cost center's allocation still available —
	 * `getBudgetStatus(...).runway.fractionRemaining`, already clamped to 0..1 by
	 * `computeRunway`. It is nested under `runway`; the `BudgetStatus` root
	 * carries only `costCenterUserId`, `balance`, and `runway`.
	 *
	 * Declared `| undefined` so a call site under `exactOptionalPropertyTypes`
	 * can write the field explicitly as `undefined` to overwrite an untrusted
	 * inbound value; `exists` reads the result as absent either way.
	 *
	 * WHERE THE NUMBER COMES FROM, and what it is worth. A governed call made
	 * inside `withCostCenter(cc, fn, { allocated, periodStartMs })` populates this
	 * from the envelope's LIVE ledger balance read at authorize, divided by the
	 * `allocated` the scope declared and clamped to 0..1. That is what makes a
	 * `budgetFractionRemaining lt 0.3` rule a real pre-spend control: the metering
	 * path now debits the `(parent, costCenter)` wallet `allocateBudget` funds, so
	 * the balance actually falls as the agent burns it.
	 *
	 * It is still ABSENT — explicitly `undefined` — for a call outside any scope,
	 * for one whose scope declared no `allocated` (there is no cost-center
	 * registry, so the SDK does not know the envelope's size and will not invent
	 * one), and in dry-run. Absent is fail-closed for a hard rule, so lead a tier
	 * that must apply only to attributed traffic with an `exists` guard, exactly as
	 * the example above does.
	 *
	 * The one thing it is NOT is a number the caller chose: see the trust-boundary
	 * paragraph above, and {@link PolicyContext.cost_center} for why the
	 * attribution behind it cannot be forged either.
	 *
	 * OPERATOR NOTE — this is a lagging number, twice over. It is computed before
	 * the call's own hold and excludes its estimated cost (only
	 * `budget_remaining_after` is estimate-inclusive), and `receipt.budget` /
	 * `budgetContext()` are post-settle snapshots, so any dashboard built on
	 * either one reads one call behind the gate. In practice: an `lt` tier
	 * starts denying with the call *after* the one whose settle crossed the
	 * threshold, not the crossing call itself — a fraction sitting exactly on
	 * the boundary still reads as inside it under `lt`. Write `lte` where the
	 * tier must also catch that edge call.
	 */
	budgetFractionRemaining?: number | undefined;
	/**
	 * Hours until projected exhaustion at the current burn rate. A naive linear
	 * extrapolation — noisy early in a period, so prefer it for escalation
	 * rather than irreversible action.
	 *
	 * There is no hours field on `BudgetStatus`: derive it with
	 * `runwayHours(status.runway, nowMs)` from `budget/runway.js`, and leave the
	 * field ABSENT when that returns null. `Runway` exposes only
	 * `projectedExhaustionMs: number | null`, and computing hours inline as
	 * `(projectedExhaustionMs - nowMs) / 3.6e6` coerces the not-projectable case
	 * — `null`, which is what a period with nothing spent yet reports — to a
	 * large negative number, which makes every `lt` threshold match and escalates
	 * a budget that is merely idle.
	 *
	 * `| undefined` for the same reason as
	 * {@link PolicyContext.budgetFractionRemaining}, and populated from the same
	 * place: `computeRunway` over the scope's declared allocation and period plus
	 * the envelope's live balance, on an attributed call. `runwayHours` answers
	 * `null` for "not projectable"; this field's convention for unknown is
	 * explicit `undefined`, so the governor converts. The two conventions are
	 * deliberate and per-surface — `budgetContext()`'s `EnvelopeStatus.runwayHours`
	 * keeps `null`, matching `Runway` itself. Do not unify them.
	 */
	budgetRunwayHours?: number | undefined;

	/**
	 * The cost center funding this call — the `withCostCenter(cc, …)` scope the
	 * governed call executed inside, or `undefined` when it ran inside none.
	 *
	 * snake_case is deliberate and matches this context's other governance fields
	 * (`estimated_cost`, `budget_remaining`, `action_kind`) — a rule file reads
	 * `cost_center`, while every TypeScript surface spells the same thing
	 * `costCenter` (A11). Do not "unify" the two.
	 *
	 * TRUSTED HOST INPUT ONLY, and structurally so: its value comes from the
	 * caller's own async execution context, never from the request body. All three
	 * SDK call sites spread the caller's params first and then re-assert this field
	 * — including asserting `undefined` when no scope is active — so a body carrying
	 * `{"cost_center": "research"}` cannot make a rule believe a call it never
	 * attributed is spending someone else's envelope.
	 *
	 * ENVELOPE-SCOPED SIBLINGS: when this field is set on a call that will actually
	 * place a ledger hold, `budget_remaining` / `budget_remaining_after` above
	 * describe THAT ENVELOPE rather than the session budget, and
	 * {@link PolicyContext.budgetFractionRemaining} /
	 * {@link PolicyContext.budgetRunwayHours} are populated from it whenever the
	 * scope supplied allocation metadata. The gate and the hold therefore always
	 * name the same wallet: an attributed call whose envelope balance cannot be
	 * read is refused with a ledger-unavailable error BEFORE this context is ever
	 * built, rather than being cleared against a session wallet its money would not
	 * have come from. A rule that must apply only to attributed traffic should lead
	 * with `{ field: "cost_center", operator: "exists" }`.
	 */
	cost_center?: string | undefined;
}

/**
 * The {@link PolicyContext} fields the HOST owns — a caller must never supply
 * one, because each steers whether a rule fires rather than being data a rule
 * reads, and for each there is a trustworthy host-side source that a
 * caller-supplied value would displace.
 *
 * WHY THIS LIST EXISTS AS A VALUE. The three SDK call sites spread caller params
 * and then re-assert the trusted fields by hand, one literal at a time, per the
 * re-assertion invariant in AGENTS.md. That hand-maintained list has already been
 * found incomplete once — `timestamp` was added to it in PR #95. Re-asserting a
 * field only holds if somebody remembers to. STRIPPING the set covers the next
 * one too, because a field absent from the explicit assignments after the spread
 * is simply absent, and absent is the fail-closed value.
 *
 * `tests/harden/policy-context-fields.test.ts` reads this file and asserts that
 * every field `PolicyContext` declares appears in EITHER this array or
 * {@link CALLER_SUPPLIED_POLICY_FIELDS}, so adding a field to the interface
 * without classifying it fails the suite. That is the same source-parity
 * mechanism `shared/ids.ts` and `cli/budget.ts` are held together with.
 */
export const HOST_CONTROLLED_POLICY_FIELDS = [
	"timestamp",
	"budgetFractionRemaining",
	"budgetRunwayHours",
	"cost_center",
] as const;

/**
 * Declared {@link PolicyContext} fields deliberately NOT stripped, and why.
 *
 * The parity test requires every declared field to appear in exactly one of
 * these two lists, so a newly added field cannot be quietly omitted from both —
 * whoever adds it has to make the trust call explicitly and record it here.
 *
 * - `scope` — CALLER-DECLARED CONTEXT, not a host secret. Unlike `timestamp`
 *   (where the gate has a real clock to fall back on) there is no host-side
 *   source for it on any SDK path: no call site in `src/` ever sets
 *   `context.scope`, and the patterns it is matched against are file globs
 *   (`src/routes/**`) describing where an agent is working — something only the
 *   caller knows. Stripping it would not close a hole; it would make every
 *   `scopePatterns` rule permanently inert, since `ruleMatches` requires a
 *   non-empty context scope for such a rule to match at all. That trade is a
 *   product decision (wire a host-side scope, or document scope as
 *   self-declared and unsuitable for adversarial guards) and is tracked
 *   separately rather than being made silently here.
 * - `timeWindows` — read by nothing. `ruleMatches` consults `rule.timeWindows`;
 *   `context.timeWindows` has no reader anywhere in the repo despite the
 *   interface doc claiming it "enables time-window matching". Stripping a field
 *   nothing reads would imply it once mattered. It wants deleting or wiring, not
 *   sanitising.
 */
export const CALLER_SUPPLIED_POLICY_FIELDS = ["scope", "timeWindows"] as const;

/**
 * Context keys a governor ASSERTS itself, which `PolicyContext` does not declare.
 *
 * These ride the interface's index signature rather than being declared fields,
 * so the parity test cannot see them — and **the three call sites assert
 * different subsets**. `governAction` sets `action_kind`/`action_name` and
 * deliberately no `model`; the LLM and headless paths set `model` and neither
 * action key. A field one surface asserts is therefore unprotected on the
 * surfaces that do not, and arrives from `...params` like any other caller key.
 *
 * Measured before this list existed: a hard `model contains opus` rule denied an
 * action call with no model (absent -> indeterminate -> guard fires), and
 * ALLOWED the same call when the caller supplied `model: "safe"` in
 * `action.params` — the caller turning a hard guard off by answering a question
 * that surface never asks. `action_kind` injected onto the LLM path likewise.
 *
 * So the UNION is stripped everywhere, not the per-surface subset. A key that is
 * host-owned anywhere is caller-forbidden everywhere; each site then asserts the
 * ones it genuinely knows.
 */
export const HOST_ASSERTED_CONTEXT_KEYS = [
	"model",
	"tier",
	"estimated_cost",
	"budget_remaining",
	"budget_remaining_after",
	"action_kind",
	"action_name",
] as const;

/**
 * Strip every host-owned field from caller-supplied params.
 *
 * Use this at the boundary, BEFORE the spread — `{ ...sanitizePolicyContext(params), … }` —
 * rather than re-asserting fields after it. The difference matters: a
 * re-assertion that someone forgets to write silently lets the caller's value
 * through, whereas a field missing from the explicit set after this call is
 * simply absent, and absent is the fail-closed answer for a hard rule.
 *
 * Arbitrary caller keys survive on purpose. They are what a policy addresses by
 * dot-notation (`params.metadata.team`), and they steer nothing on their own —
 * only the declared fields above do.
 */
export function sanitizePolicyContext<T extends Record<string, unknown>>(
	callerSupplied: T | undefined,
): Record<string, unknown> {
	if (callerSupplied === undefined || callerSupplied === null) return {};
	const out: Record<string, unknown> = { ...callerSupplied };
	for (const field of HOST_CONTROLLED_POLICY_FIELDS) {
		delete out[field];
	}
	for (const key of HOST_ASSERTED_CONTEXT_KEYS) {
		delete out[key];
	}
	return out;
}

/**
 * Extended policy rule for the gate. Adds optional `id`, `description`,
 * `priority`, `enabled`, `scopePatterns`, and `timeWindows` fields to the
 * shared PolicyRule type.
 */
export interface GateRule extends PolicyRule {
	/** Unique rule identifier */
	id?: string;
	/** Human-readable description */
	description?: string;
	/** Rule priority (lower = higher priority). Default: 100 */
	priority?: number;
	/** Whether the rule is active. Default: true */
	enabled?: boolean;
	/** Glob patterns for scope matching */
	scopePatterns?: string[];
	/** Time windows for temporal constraints */
	timeWindows?: TimeWindow[];
}

/**
 * Evaluate all conditions of a rule against the context.
 */
function ruleMatches(rule: GateRule, context: PolicyContext): boolean {
	const enabled = rule.enabled ?? true;
	if (!enabled) return false;

	// Hard rules fail CLOSED: a condition that cannot be evaluated (a missing or
	// mistyped guarded field) is treated as satisfied so the guard still fires,
	// rather than silently allowing an unbounded/ungoverned operation. Soft rules
	// stay lenient (indeterminate → unmet) to preserve warning-only behavior.
	const failClosed = rule.enforcement === "hard";

	// All field conditions must match
	for (const fc of rule.conditions) {
		const res = evaluateFieldCondition(fc, context);
		if (res === "indeterminate") {
			if (failClosed) continue;
			return false;
		}
		if (!res) return false;
	}

	// Scope matching (if rule has scope patterns)
	if (rule.scopePatterns && rule.scopePatterns.length > 0) {
		const ctxScopes = context.scope;
		if (!ctxScopes || ctxScopes.length === 0) return false;
		if (!matchesScope(rule.scopePatterns, ctxScopes)) return false;
	}

	// Time window matching
	if (rule.timeWindows && rule.timeWindows.length > 0) {
		const timestamp = (context.timestamp as string | undefined) ?? new Date().toISOString();
		if (!isWithinTimeWindow(rule.timeWindows, timestamp)) return false;
	}

	return true;
}

// ---------------------------------------------------------------------------
// Policy evaluation (main entry point)
// ---------------------------------------------------------------------------

/**
 * Evaluate policy rules against a context.
 *
 * Rules are sorted by priority (lower = higher priority, default 100).
 * All matching rules are evaluated. The overall decision is "deny" if any
 * hard violation is found. Soft violations produce warnings but allow.
 *
 * @param rules - Policy rules to evaluate
 * @param context - Evaluation context with arbitrary fields
 * @returns Policy evaluation result
 */
export function evaluatePolicy(rules: GateRule[], context: PolicyContext): PolicyResult {
	const timestamp = (context.timestamp as string | undefined) ?? new Date().toISOString();

	// Sort by priority (ascending — lower number = higher priority)
	const sortedRules = [...rules].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

	const matched: RuleMatch[] = [];
	const hardViolations: RuleMatch[] = [];
	const softViolations: RuleMatch[] = [];
	const reasons: string[] = [];

	for (const rule of sortedRules) {
		if (!ruleMatches(rule, context)) continue;

		const match: RuleMatch = {
			...(rule.id !== undefined ? { id: rule.id } : {}),
			name: rule.name,
			effect: rule.effect,
			enforcement: rule.enforcement,
			severity: rule.severity,
			fields: rule.conditions.map((fc) => fc.field),
		};

		matched.push(match);

		// Classify violation
		const isViolation = rule.effect === "deny" || rule.effect === "warn";
		if (isViolation) {
			const label = rule.id ? `[${rule.id}]` : `[${rule.name}]`;
			// A description-less rule would render its identifier twice
			// ("[scarcity-brake] scarcity-brake"): the rationale falls back to
			// rule.name, which the label already shows unless a distinct id exists.
			const rationale = rule.description ?? ((rule.id ?? rule.name) === rule.name ? "" : rule.name);
			const body = rationale === "" ? label : `${label} ${rationale}`;
			const reason = rule.enforcement === "hard" ? body : `[WARN] ${body}`;

			reasons.push(reason);

			if (rule.enforcement === "hard") {
				hardViolations.push(match);
			} else {
				softViolations.push(match);
			}
		}
	}

	return {
		decision: hardViolations.length > 0 ? "deny" : "allow",
		hasWarnings: softViolations.length > 0,
		matched,
		hardViolations,
		softViolations,
		reasons,
		evaluatedAt: timestamp,
	};
}

// ---------------------------------------------------------------------------
// Policy file loading
// ---------------------------------------------------------------------------

/** One thing wrong with a policy file, addressed to the operator who wrote it. */
export interface PolicyLoadIssue {
	/** Dotted path to the offending node, e.g. `rules[2].conditions[0].operator`. */
	readonly at: string;
	readonly message: string;
}

/**
 * A policy file exists but cannot be honoured as written.
 *
 * This is deliberately a THROW and not an empty rule set. The previous
 * behaviour — `catch { return [] }` around a bare `as GateRule[]` — meant a tab
 * character in the YAML, one wrong indent, a trailing comma, or a top-level key
 * of `policies:` instead of `rules:` silently produced ZERO custom rules. Only
 * the platform DEFAULT_RULES survived, every content/model/PII deny rule was
 * gone, and nothing anywhere said so: no throw, no log, no audit event. The
 * governor started normally, and `usertrust health` reported
 * `Policy violations (30d): 0 [ok]` in green — because it counts violations,
 * not rules, so the indicator read HEALTHIER the moment governance stopped
 * existing.
 *
 * A policy that cannot be parsed is not a policy. Refusing to start is the only
 * answer that cannot be mistaken for enforcement.
 */
export class PolicyLoadError extends Error {
	readonly file: string;
	readonly issues: readonly PolicyLoadIssue[];

	constructor(file: string, issues: readonly PolicyLoadIssue[]) {
		const detail = issues.map((i) => `  ${i.at}: ${i.message}`).join("\n");
		super(`usertrust: policy file cannot be loaded: ${file}\n${detail}`);
		this.name = "PolicyLoadError";
		this.file = file;
		this.issues = issues;
	}
}

/** Outcome of reading a policy file without committing to throwing. */
export interface PolicyLoadResult {
	/** Rules that validated. Empty when `issues` is non-empty. */
	readonly rules: GateRule[];
	readonly issues: readonly PolicyLoadIssue[];
	/**
	 * Whether a file was actually there — ENOENT, and nothing else, answers false.
	 *
	 * Reported rather than left for the caller to re-derive, because the obvious
	 * way to re-derive it is `existsSync`, which answers false for a file inside a
	 * directory it cannot traverse. Every caller that asked that question
	 * separately got "absent" for a file that was present and unreadable.
	 */
	readonly present: boolean;
}

/**
 * The 12 operators, as a runtime value.
 *
 * `satisfies` pins it to {@link FieldOperator}, so adding a member to the type
 * without adding it here is a compile error rather than a rule that loads and
 * then never fires.
 */
export const FIELD_OPERATORS = [
	"exists",
	"not_exists",
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"not_in",
	"contains",
	"regex",
] as const satisfies readonly FieldOperator[];

/**
 * Exhaustiveness in the OTHER direction.
 *
 * `satisfies readonly FieldOperator[]` only checks that everything listed is a
 * member of the union — it does not check that every member is listed. A new
 * `FieldOperator` would therefore compile cleanly while `z.enum(FIELD_OPERATORS)`
 * rejected every policy file using it, which is the same shape as the defects
 * this file exists to close: the guard reports success for a set it does not
 * cover. This assertion fails to compile until the new member is added here,
 * naming it in the error.
 */
type UnlistedOperator = Exclude<FieldOperator, (typeof FIELD_OPERATORS)[number]>;
const _FIELD_OPERATORS_EXHAUSTIVE: UnlistedOperator extends never ? true : UnlistedOperator = true;
void _FIELD_OPERATORS_EXHAUSTIVE;

/** Operators whose `value` must be a number. */
const NUMERIC_VALUE_OPERATORS = new Set<FieldOperator>(["gt", "gte", "lt", "lte"]);
/** Operators whose `value` must be an array. */
const ARRAY_VALUE_OPERATORS = new Set<FieldOperator>(["in", "not_in"]);
/** Operators whose `value` must be a string. */
const STRING_VALUE_OPERATORS = new Set<FieldOperator>(["contains", "regex"]);
/** Operators that read no `value` at all — they test presence. */
const VALUELESS_OPERATORS = new Set<FieldOperator>(["exists", "not_exists"]);

/** Keys a condition may carry. Checked inside the refinement, not by `strictObject`. */
const FIELD_CONDITION_KEYS = new Set(["field", "operator", "value"]);

/**
 * NOT `strictObject`, deliberately.
 *
 * zod skips `.superRefine` when the object parse itself fails, so a condition
 * carrying BOTH an unknown key and an unusable operand reported only the key —
 * and the operator had to fix it and re-run to discover the second fault. That
 * breaks the one-pass contract `policy validate` promises, in the same way the
 * early returns did: a diagnostic that stops at the first problem makes the
 * caller iterate.
 *
 * The unknown-key check therefore lives INSIDE the refinement alongside the
 * semantic checks, so structural and semantic faults are collected together.
 * `looseObject` rather than `object` because the latter STRIPS unknown keys
 * before the refinement runs — the check would see a clean object and pass,
 * which is the silently-discarded-input defect this file exists to close.
 */
const FieldConditionSchema = z
	.looseObject({
		field: z.string().min(1, "must be a non-empty field path"),
		operator: z.enum(FIELD_OPERATORS),
		value: z.unknown().optional(),
	})
	.superRefine((fc, ctx) => {
		for (const key of Object.keys(fc)) {
			if (FIELD_CONDITION_KEYS.has(key)) continue;
			ctx.addIssue({
				code: "custom",
				path: [key],
				message: `unknown key on a condition. A condition carries only field, operator and value.`,
			});
		}
		const op = fc.operator;
		if (VALUELESS_OPERATORS.has(op)) return;
		if (fc.value === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["value"],
				message: `operator "${op}" requires a value`,
			});
			return;
		}
		if (NUMERIC_VALUE_OPERATORS.has(op) && typeof fc.value !== "number") {
			ctx.addIssue({
				code: "custom",
				path: ["value"],
				message: `operator "${op}" compares numbers, but value is ${typeof fc.value}`,
			});
		}
		// `typeof NaN === "number"`, and YAML spells it `.nan`. A non-finite operand
		// makes a rule that validates cleanly and can never fire — the guard present
		// in the file and absent in effect.
		//
		// Checked for EVERY operator, not only the numeric comparisons: `NaN === NaN`
		// is false, so `eq: .nan` never matches either, and scoping this to
		// `NUMERIC_VALUE_OPERATORS` left exactly that hole. Infinity is refused on
		// the same grounds — a threshold nothing can cross is not a threshold.
		//
		// Array operands are deliberately NOT covered: `includes` uses SameValueZero,
		// so `in: [.nan]` does match a NaN subject and is a rule that works.
		if (typeof fc.value === "number" && !Number.isFinite(fc.value)) {
			ctx.addIssue({
				code: "custom",
				path: ["value"],
				message: `operator "${op}" cannot use ${Number.isNaN(fc.value) ? "NaN" : String(fc.value)} as an operand: no value compares equal to it, so the rule would never fire`,
			});
		}
		if (ARRAY_VALUE_OPERATORS.has(op) && !Array.isArray(fc.value)) {
			ctx.addIssue({
				code: "custom",
				path: ["value"],
				message: `operator "${op}" needs an array value, but value is ${typeof fc.value}`,
			});
		}
		if (STRING_VALUE_OPERATORS.has(op) && typeof fc.value !== "string") {
			ctx.addIssue({
				code: "custom",
				path: ["value"],
				message: `operator "${op}" needs a string value, but value is ${typeof fc.value}`,
			});
		}
		// A pattern the evaluator would refuse at runtime is refused here instead,
		// where the author can still see which rule it belonged to. `safeRegExp`
		// rejects over-long patterns and catastrophic-backtracking shapes as well
		// as syntactically invalid ones.
		if (op === "regex" && typeof fc.value === "string" && safeRegExp(fc.value) === null) {
			ctx.addIssue({
				code: "custom",
				path: ["value"],
				message: "not a usable regular expression (invalid, too long, or unsafe to evaluate)",
			});
		}
	});

const TimeWindowSchema = z.strictObject({
	daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
	startHour: z.number().int().min(0).max(23).optional(),
	endHour: z.number().int().min(0).max(24).optional(),
});

/**
 * STRICT on purpose — an unknown key is an ERROR, not something to drop.
 *
 * zod strips unrecognised keys by default, and that default is this very defect
 * in miniature: a rule written with `scopePattern` (singular) would validate
 * cleanly, load, and silently become an UNSCOPED global deny — the author
 * believing it applies to production only, while it applies everywhere. The same
 * default already bit this repo once on the settle wire, where two cache-token
 * tiers "vanished silently on the wire" (packages/server/src/wire.ts).
 *
 * A validator that quietly discards what it does not understand is not a
 * validator.
 */
const GateRuleSchema = z.strictObject({
	id: z.string().optional(),
	name: z.string().min(1),
	description: z.string().optional(),
	priority: z.number().optional(),
	enabled: z.boolean().optional(),
	effect: z.enum(["deny", "warn"]),
	enforcement: z.enum(["hard", "soft"]),
	severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
	conditions: z.array(FieldConditionSchema),
	// A glob minimatch cannot compile is refused here rather than throwing from
	// `matchesScope` mid-evaluation: a rule that raises `TypeError: pattern is too
	// long` when a call happens to supply a scope replaces a policy VERDICT with an
	// exception, which is a worse outcome than either allow or deny. minimatch's
	// own ceiling is 65536.
	scopePatterns: z
		.array(
			z
				.string()
				.max(65_535, "glob is too long for minimatch to compile (limit 65536)")
				.refine(
					(p) => {
						try {
							minimatch("probe", p);
							return true;
						} catch {
							return false;
						}
					},
					{ message: "is not a glob minimatch can compile" },
				),
		)
		.optional(),
	timeWindows: z.array(TimeWindowSchema).optional(),
});

/**
 * Read and fully validate a policy file, reporting problems instead of throwing.
 *
 * This is the form the `policy validate` command and the health report use, so
 * an operator can see every problem in one pass rather than fixing them one
 * exception at a time. {@link loadPolicies} is the same work with a throw on the
 * end.
 *
 * A file that is absent is NOT an issue — no policy file is a legitimate
 * deployment. A file that is present and unreadable IS an issue, and the two are
 * told apart by `ENOENT` rather than by an `existsSync` preflight: `existsSync`
 * answers false for a file inside a directory it cannot traverse, which would
 * report an unreadable policy as an absent one. Callers must therefore call this
 * unconditionally rather than guarding it.
 */
export function validatePolicyFile(path: string): PolicyLoadResult {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		// A file that is not there is not a broken policy — "no policy file" is a
		// legitimate deployment, and both governor call sites already guard with
		// `existsSync`. Anything else (permissions, a directory, an I/O fault) IS a
		// problem: the operator put a policy there and we cannot read it, which is
		// exactly the case that must not degrade to "no rules".
		if ((err as NodeJS.ErrnoException).code === "ENOENT")
			return { rules: [], issues: [], present: false };
		return {
			rules: [],
			issues: [{ at: "file", message: `cannot be read: ${(err as Error).message}` }],
			present: true,
		};
	}

	const rootIssues: PolicyLoadIssue[] = [];
	const isYaml = path.endsWith(".yml") || path.endsWith(".yaml");
	let parsed: unknown;
	try {
		parsed = isYaml ? parseYaml(raw) : JSON.parse(raw);
	} catch (err) {
		return {
			rules: [],
			issues: [
				{
					at: "file",
					message: `is not valid ${isYaml ? "YAML" : "JSON"}: ${(err as Error).message}`,
				},
			],
			present: true,
		};
	}

	// An empty document is an empty policy, not a broken one.
	if (parsed === null || parsed === undefined) return { rules: [], issues: [], present: true };

	let rawRules: unknown;
	if (Array.isArray(parsed)) {
		rawRules = parsed;
	} else if (typeof parsed === "object") {
		const obj = parsed as Record<string, unknown>;
		// The root is strict for the same reason every rule is: a misplaced
		// top-level key — `scopePatterns` written outside the rule it was meant to
		// narrow — would otherwise be dropped in silence, and the rules it was
		// supposed to scope would apply everywhere.
		// Root problems are ACCUMULATED, not returned early: `policy validate`
		// promises every problem in one pass, and an operator who fixes the root
		// key only to be shown a malformed rule next has been made to iterate.
		for (const k of Object.keys(obj)) {
			if (k === "rules") continue;
			rootIssues.push({
				at: `${k}`,
				message: `unknown top-level key. A policy document carries only "rules"; a key placed here is not applied to anything.`,
			});
		}
		if (!("rules" in obj)) {
			// The silent-empty case that hid a whole policy file: a document keyed
			// `policies:` (or anything else) used to parse fine and yield nothing.
			// Name the keys we DID find so the fix is obvious.
			const found = Object.keys(obj);
			return {
				rules: [],
				// `rootIssues` first: the loop above already named every misplaced key,
				// and replacing them with only the synthetic missing-key issue loses
				// their locations — the one-pass contract broken a third way.
				issues: [
					...rootIssues,
					{
						at: "file",
						message: `has no top-level "rules" key (found: ${found.length > 0 ? found.join(", ") : "no keys"}). Expected \`rules: [...]\` or a bare list of rules.`,
					},
				],
				present: true,
			};
		}
		rawRules = obj.rules;
	} else {
		return {
			rules: [],
			issues: [{ at: "file", message: `must be a list of rules or an object with a "rules" key` }],
			present: true,
		};
	}

	if (!Array.isArray(rawRules)) {
		// Keep whatever the root check already found: discarding it here would make
		// the operator fix `rules` and come back for the root key, which is the
		// one-pass contract broken in the other direction.
		return {
			rules: [],
			issues: [...rootIssues, { at: "rules", message: "must be a list" }],
			present: true,
		};
	}

	const issues: PolicyLoadIssue[] = [...rootIssues];
	const rules: GateRule[] = [];
	for (let i = 0; i < rawRules.length; i++) {
		const result = GateRuleSchema.safeParse(rawRules[i]);
		if (result.success) {
			rules.push(result.data as GateRule);
			continue;
		}
		for (const issue of result.error.issues) {
			const segs = issue.path
				.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
				.join("");
			issues.push({ at: `rules[${i}]${segs}`, message: issue.message });
		}
	}

	// All-or-nothing: a file with one bad rule loads none of them. Loading the
	// survivors would enforce a policy the operator never wrote, which is the
	// same silent-partial-application failure in a new costume.
	return issues.length > 0
		? { rules: [], issues, present: true }
		: { rules, issues: [], present: true };
}

/**
 * Load policy rules from a JSON or YAML file.
 *
 * Supports:
 * - `.json` files: expects `{ "rules": [...] }` or a bare array
 * - `.yml` / `.yaml` files: expects `rules: [...]` or a bare sequence
 *
 * @throws {PolicyLoadError} if the file is present but unreadable, unparseable,
 * shaped wrongly, or contains a rule that would not enforce as written. It never
 * returns a silently-empty rule set — see {@link PolicyLoadError}.
 *
 * @param path - Absolute or relative path to the policy file
 * @returns Array of validated policy rules
 */
export function loadPolicies(path: string): GateRule[] {
	const { rules, issues } = validatePolicyFile(path);
	if (issues.length > 0) throw new PolicyLoadError(path, issues);
	return rules;
}
