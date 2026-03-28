// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Board Director — Heuristic Concern Review
 *
 * Each Director independently reviews decisions using the concern
 * detection library. No LLM calls — pure heuristic pattern matching.
 *
 * Two default Directors with complementary focus areas:
 *   Alpha: hallucination, safety, policy_violation
 *   Beta:  bias, scope_creep, resource_abuse
 */

import type { ConcernType, DirectorVote, PolicySeverity } from "../shared/types.js";
import type { BoardRequest, Concern } from "./concerns.js";
import {
	detectBias,
	detectHallucination,
	detectPolicyViolation,
	detectResourceAbuse,
	detectSafety,
	detectScopeCreep,
} from "./concerns.js";

// ── Types ──

export interface DirectorConfig {
	/** Director ID */
	id: string;
	/** Director name for display */
	name: string;
	/** Review focus areas */
	focusAreas: ConcernType[];
	/** Veto threshold — concerns at or above this severity trigger veto */
	vetoThreshold: PolicySeverity;
}

export interface DirectorReview {
	directorId: string;
	vote: DirectorVote;
	reasoning: string;
	concerns: Concern[];
	/** Confidence 0-1 (lower with more concerns) */
	confidence: number;
	reviewedAt: string;
}

// ── Default Configurations ──

export const DIRECTOR_CONFIGS: Record<string, DirectorConfig> = {
	"director-a": {
		id: "director-a",
		name: "Director Alpha",
		focusAreas: ["hallucination", "safety", "policy_violation"],
		vetoThreshold: "high",
	},
	"director-b": {
		id: "director-b",
		name: "Director Beta",
		focusAreas: ["bias", "scope_creep", "resource_abuse"],
		vetoThreshold: "high",
	},
};

// ── Concern routing by type ──

const DETECTOR_BY_TYPE: Record<ConcernType, (req: BoardRequest) => Concern | null> = {
	hallucination: detectHallucination,
	bias: detectBias,
	safety: detectSafety,
	scope_creep: detectScopeCreep,
	resource_abuse: detectResourceAbuse,
	policy_violation: detectPolicyViolation,
};

// ── Severity ranking ──

const SEVERITY_RANK: Record<PolicySeverity, number> = {
	info: 0,
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
};

// ── Core Logic ──

/**
 * Detect concerns scoped to a Director's focus areas.
 */
function detectForDirector(request: BoardRequest, focusAreas: ConcernType[]): Concern[] {
	const concerns: Concern[] = [];
	for (const area of focusAreas) {
		const detector = DETECTOR_BY_TYPE[area];
		const concern = detector(request);
		if (concern) {
			concerns.push(concern);
		}
	}
	return concerns;
}

/**
 * Determine vote based on concern severities relative to the veto threshold.
 */
export function determineVote(concerns: Concern[], vetoThreshold: PolicySeverity): DirectorVote {
	const thresholdRank = SEVERITY_RANK[vetoThreshold];

	for (const concern of concerns) {
		if (SEVERITY_RANK[concern.severity] >= thresholdRank) {
			return "veto";
		}
	}

	if (concerns.some((c) => c.severity === "medium")) {
		return "abstain";
	}

	return "approve";
}

/**
 * Generate human-readable reasoning from vote and concerns.
 */
function generateReasoning(vote: DirectorVote, concerns: Concern[], request: BoardRequest): string {
	if (concerns.length === 0) {
		return `Approved: No concerns detected for ${request.decisionType} decision.`;
	}

	const summary = concerns
		.map((c) => `[${c.severity.toUpperCase()}] ${c.type}: ${c.description}`)
		.join("; ");

	switch (vote) {
		case "veto":
			return `VETO: Critical concerns detected. ${summary}`;
		case "abstain":
			return `ABSTAIN: Moderate concerns require attention. ${summary}`;
		case "approve":
			return `Approved with minor notes: ${summary}`;
	}
}

// ── Public API ──

/**
 * A Director reviews a request independently.
 */
export function reviewDecision(directorId: string, request: BoardRequest): DirectorReview {
	const config = DIRECTOR_CONFIGS[directorId];
	if (!config) {
		throw new Error(`Unknown director: ${directorId}`);
	}

	const concerns = detectForDirector(request, config.focusAreas);
	const vote = determineVote(concerns, config.vetoThreshold);
	const reasoning = generateReasoning(vote, concerns, request);
	const confidence = Math.max(0.5, 1 - concerns.length * 0.15);

	return {
		directorId,
		vote,
		reasoning,
		concerns,
		confidence,
		reviewedAt: new Date().toISOString(),
	};
}

/**
 * Get Director configuration by ID.
 */
export function getDirectorConfig(directorId: string): DirectorConfig | undefined {
	return DIRECTOR_CONFIGS[directorId];
}

/**
 * List all Directors.
 */
export function listDirectors(): DirectorConfig[] {
	return Object.values(DIRECTOR_CONFIGS);
}
