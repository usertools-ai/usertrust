// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Concern Detection Library
 *
 * 6 pure-function detectors for Board of Directors oversight.
 * Each detector: (request) => Concern | null
 */

import type { ConcernType, PolicySeverity } from "../shared/types.js";

// ── Types ──

export interface Concern {
	type: ConcernType;
	severity: PolicySeverity;
	description: string;
	evidence: string;
}

export interface BoardRequest {
	/** Type of decision under review */
	decisionType: string;
	/** Human-readable description of the action */
	description: string;
	/** File/resource scope affected */
	scope?: string[] | undefined;
	/** Arbitrary context for detection heuristics */
	context: Record<string, unknown>;
}

// ── Individual Detectors ──

/**
 * Hallucination — absolute claims, factual assertions without evidence.
 * Triggers on "always"/"never" overgeneralizations and policy overrides lacking justification.
 */
export function detectHallucination(request: BoardRequest): Concern | null {
	const description = request.description.toLowerCase();

	if (description.includes("always") || description.includes("never")) {
		return {
			type: "hallucination",
			severity: "medium",
			description: "Absolute claims detected - may be overgeneralization",
			evidence: "Contains 'always' or 'never' statements",
		};
	}

	if (request.decisionType === "policy_override" && !request.context.justification) {
		return {
			type: "hallucination",
			severity: "high",
			description: "Policy override without justification",
			evidence: "Missing justification field in context",
		};
	}

	return null;
}

/**
 * Bias — preferential routing, demographic skew.
 * Triggers when a preferred worker is specified during scope expansion.
 */
export function detectBias(request: BoardRequest): Concern | null {
	if (request.context.preferredWorker && request.decisionType === "scope_expansion") {
		return {
			type: "bias",
			severity: "medium",
			description: "Potential worker preference bias in scope assignment",
			evidence: `Preferred worker: ${request.context.preferredWorker}`,
		};
	}

	return null;
}

/**
 * Safety — credentials in scope, dangerous content.
 * Scans scope paths and description for security-sensitive patterns.
 */
export function detectSafety(request: BoardRequest): Concern | null {
	const sensitivePatterns = ["password", "credential", "secret", "token", "key"];
	const scopeStr = (request.scope ?? []).join(" ").toLowerCase();
	const description = request.description.toLowerCase();

	for (const pattern of sensitivePatterns) {
		if (scopeStr.includes(pattern) || description.includes(pattern)) {
			return {
				type: "safety",
				severity: "high",
				description: `Security-sensitive operation: ${pattern}`,
				evidence: `Pattern '${pattern}' found in scope or description`,
			};
		}
	}

	return null;
}

/**
 * Scope creep — root wildcards, unbounded scope.
 * Triggers on root-level ** wildcards or excessive scope breadth (>10 patterns).
 */
export function detectScopeCreep(request: BoardRequest): Concern | null {
	const scope = request.scope ?? [];

	// Root-level ** wildcard (not scoped under a directory)
	if (scope.some((s) => s.includes("**") && !s.includes("/"))) {
		return {
			type: "scope_creep",
			severity: "medium",
			description: "Overly broad scope pattern detected",
			evidence: "Contains root-level ** wildcard",
		};
	}

	if (scope.length > 10) {
		return {
			type: "scope_creep",
			severity: "high",
			description: "Excessive scope breadth",
			evidence: `${scope.length} scope patterns`,
		};
	}

	return null;
}

/**
 * Resource abuse — cost exceeds threshold, excessive token usage.
 * Triggers when estimated cost exceeds $100 on resource-intensive operations.
 */
export function detectResourceAbuse(request: BoardRequest): Concern | null {
	if (request.decisionType === "resource_intensive") {
		const estimatedCost = request.context.estimatedCost as number | undefined;
		if (estimatedCost !== undefined && estimatedCost > 100) {
			return {
				type: "resource_abuse",
				severity: "high",
				description: "High resource cost operation",
				evidence: `Estimated cost: $${estimatedCost}`,
			};
		}
	}

	return null;
}

/**
 * Policy violation — explicit policy override attempts.
 * Triggers on any policy_override decision type.
 */
export function detectPolicyViolation(request: BoardRequest): Concern | null {
	if (request.decisionType === "policy_override") {
		return {
			type: "policy_violation",
			severity: "medium",
			description: "Policy override requested",
			evidence: "Explicit policy override decision type",
		};
	}

	return null;
}

// ── Aggregate Detector ──

/** All individual detectors in order. */
const ALL_DETECTORS = [
	detectHallucination,
	detectBias,
	detectSafety,
	detectScopeCreep,
	detectResourceAbuse,
	detectPolicyViolation,
] as const;

/**
 * Run all concern detectors against a request.
 * Returns every concern found (zero or more).
 */
export function detectConcerns(request: BoardRequest): Concern[] {
	const concerns: Concern[] = [];
	for (const detect of ALL_DETECTORS) {
		const concern = detect(request);
		if (concern) {
			concerns.push(concern);
		}
	}
	return concerns;
}
