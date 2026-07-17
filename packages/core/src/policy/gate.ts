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
	/** Rule name */
	name: string;
	/** Effect of the matched rule */
	effect: PolicyEffect;
	/** Enforcement level */
	enforcement: PolicyEnforcement;
	/** Severity if set */
	severity: PolicySeverity | undefined;
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

		case "eq":
			return resolved === fc.value;

		case "neq":
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

		case "in":
			return Array.isArray(fc.value) && fc.value.includes(resolved);

		case "not_in":
			return Array.isArray(fc.value) && !fc.value.includes(resolved);

		case "contains":
			return (
				typeof resolved === "string" && typeof fc.value === "string" && resolved.includes(fc.value)
			);

		case "regex": {
			if (typeof resolved !== "string" || typeof fc.value !== "string") return false;
			const re = safeRegExp(fc.value);
			if (re === null) return false;
			// Layer B (defense-in-depth): bound the scanned input so even a
			// structural miss cannot be fed an unbounded string.
			const input =
				resolved.length > MAX_REGEX_INPUT ? resolved.slice(0, MAX_REGEX_INPUT) : resolved;
			return re.test(input);
		}

		default:
			return false;
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
		if (tw.startHour !== undefined && hour < tw.startHour) return false;
		if (tw.endHour !== undefined && hour >= tw.endHour) return false;
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
	/** Optional timestamp override (defaults to now) */
	timestamp?: string;
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
			name: rule.name,
			effect: rule.effect,
			enforcement: rule.enforcement,
			severity: rule.severity,
		};

		matched.push(match);

		// Classify violation
		const isViolation = rule.effect === "deny" || rule.effect === "warn";
		if (isViolation) {
			const label = rule.id ? `[${rule.id}]` : `[${rule.name}]`;
			const rationale = rule.description ?? rule.name;
			const reason =
				rule.enforcement === "hard" ? `${label} ${rationale}` : `[WARN] ${label} ${rationale}`;

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

/**
 * Load policy rules from a JSON or YAML file.
 *
 * Supports:
 * - `.json` files: expects `{ "rules": [...] }` or a bare array
 * - `.yml` / `.yaml` files: expects `rules: [...]` or a bare sequence
 *
 * Returns an empty array if the file cannot be read or parsed.
 *
 * @param path - Absolute or relative path to the policy file
 * @returns Array of policy rules
 */
export function loadPolicies(path: string): GateRule[] {
	try {
		const raw = readFileSync(path, "utf-8");

		const isYaml = path.endsWith(".yml") || path.endsWith(".yaml");
		const parsed: unknown = isYaml ? parseYaml(raw) : JSON.parse(raw);

		if (Array.isArray(parsed)) return parsed as GateRule[];
		if (parsed !== null && typeof parsed === "object") {
			const obj = parsed as Record<string, unknown>;
			if (Array.isArray(obj.rules)) return obj.rules as GateRule[];
		}

		return [];
	} catch {
		return [];
	}
}
