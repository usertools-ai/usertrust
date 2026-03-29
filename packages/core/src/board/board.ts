// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Board of Directors — Board Coordination
 *
 * Coordinates two isolated Directors for democratic oversight.
 * Decision matrix:
 *   Both APPROVE        → approved
 *   Unanimous VETO      → blocked  (requires human escalation)
 *   VETO + APPROVE      → escalated (conflict, human review)
 *   Both ABSTAIN        → escalated (insufficient confidence)
 *
 * Persists JSONL session history with a 100-review buffer.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VAULT_DIR } from "../shared/constants.js";
import { trustId } from "../shared/ids.js";
import type { BoardDecision } from "../shared/types.js";
import type { BoardRequest } from "./concerns.js";
import type { DirectorReview } from "./director.js";
import { listDirectors, reviewDecision } from "./director.js";

// ── Types ──

export interface BoardReviewResult {
	request: BoardRequest & { reviewId: string; requestedAt: string };
	reviews: DirectorReview[];
	decision: BoardDecision;
	reasoning: string;
	requiresHumanEscalation: boolean;
	escalationReason?: string | undefined;
	decidedAt: string;
}

interface BoardSession {
	pendingReviews: Record<string, BoardRequest & { reviewId: string; requestedAt: string }>;
	completedReviews: BoardReviewResult[];
	startedAt: string;
	lastActivityAt: string;
}

export interface BoardOpts {
	/** Maximum completed reviews to keep in the session file (default 100) */
	maxHistory?: number | undefined;
}

export interface Board {
	/**
	 * Submit, review, and decide in one synchronous call.
	 * Returns the full review result.
	 */
	reviewNow(
		decisionType: string,
		actor: string,
		description: string,
		options?: {
			scope?: string[];
			context?: Record<string, unknown>;
		},
	): BoardReviewResult;

	/** Get recent completed reviews. */
	getRecentReviews(limit?: number): BoardReviewResult[];

	/** Get aggregate stats. */
	getStats(): BoardStats;
}

export interface BoardStats {
	totalReviews: number;
	approved: number;
	blocked: number;
	escalated: number;
}

// ── Decision Logic ──

/**
 * Determine final Board decision from Director reviews.
 */
export function determineDecision(reviews: DirectorReview[]): {
	decision: BoardDecision;
	requiresHumanEscalation: boolean;
	escalationReason?: string;
} {
	const votes = reviews.map((r) => r.vote);
	const vetoCount = votes.filter((v) => v === "veto").length;
	const approveCount = votes.filter((v) => v === "approve").length;
	const abstainCount = votes.filter((v) => v === "abstain").length;

	// Unanimous veto → blocked
	if (vetoCount === reviews.length) {
		return {
			decision: "blocked",
			requiresHumanEscalation: true,
			escalationReason: "Unanimous Board veto - all Directors flagged critical concerns",
		};
	}

	// Any veto with any approve → conflict, escalate
	if (vetoCount > 0 && approveCount > 0) {
		return {
			decision: "escalated",
			requiresHumanEscalation: true,
			escalationReason: "Director disagreement - veto conflicts with approval",
		};
	}

	// Both abstain → need more info
	if (abstainCount === reviews.length) {
		return {
			decision: "escalated",
			requiresHumanEscalation: true,
			escalationReason: "Both Directors abstained - insufficient confidence",
		};
	}

	// Single veto with abstain → blocked but escalate
	if (vetoCount > 0) {
		return {
			decision: "blocked",
			requiresHumanEscalation: true,
			escalationReason: "Director veto with abstention",
		};
	}

	// Approved (both approve, or approve + abstain)
	return {
		decision: "approved",
		requiresHumanEscalation: false,
	};
}

/**
 * Combine Director reasoning into final reasoning string.
 */
function combineReasoning(reviews: DirectorReview[], decision: BoardDecision): string {
	const parts = reviews.map((r) => `[${r.directorId}] ${r.reasoning}`);
	const prefix =
		decision === "approved"
			? "Board APPROVED:"
			: decision === "blocked"
				? "Board BLOCKED:"
				: "Board ESCALATED:";
	return `${prefix} ${parts.join(" | ")}`;
}

// ── Session Persistence ──

function boardDir(vaultPath: string): string {
	return join(vaultPath, "board");
}

function sessionPath(vaultPath: string): string {
	return join(boardDir(vaultPath), "session.json");
}

function historyPath(vaultPath: string): string {
	return join(boardDir(vaultPath), "history.jsonl");
}

function ensureDir(vaultPath: string): void {
	const dir = boardDir(vaultPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function loadSession(vaultPath: string): BoardSession {
	ensureDir(vaultPath);
	const file = sessionPath(vaultPath);
	if (!existsSync(file)) {
		const now = new Date().toISOString();
		return {
			pendingReviews: {},
			completedReviews: [],
			startedAt: now,
			lastActivityAt: now,
		};
	}
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as BoardSession;
	} catch {
		const now = new Date().toISOString();
		return {
			pendingReviews: {},
			completedReviews: [],
			startedAt: now,
			lastActivityAt: now,
		};
	}
}

function saveSession(vaultPath: string, session: BoardSession): void {
	ensureDir(vaultPath);
	session.lastActivityAt = new Date().toISOString();
	writeFileSync(sessionPath(vaultPath), JSON.stringify(session, null, "\t"));
}

function appendHistory(vaultPath: string, result: BoardReviewResult): void {
	ensureDir(vaultPath);
	appendFileSync(historyPath(vaultPath), `${JSON.stringify(result)}\n`);
}

// ── Factory ──

/**
 * Create a Board of Directors instance backed by a vault directory.
 *
 * @param vaultPath — absolute or relative path to `.usertrust/` (or custom vault)
 * @param opts — optional configuration
 */
export function createBoard(vaultPath: string, opts?: BoardOpts): Board {
	const maxHistory = opts?.maxHistory ?? 100;

	return {
		reviewNow(decisionType, actor, description, options) {
			const reviewId = trustId("BR");
			const request = {
				reviewId,
				decisionType,
				actor,
				description,
				scope: options?.scope,
				context: options?.context ?? {},
				requestedAt: new Date().toISOString(),
			};

			// Each Director reviews independently
			const directors = listDirectors();
			const reviews: DirectorReview[] = [];
			for (const director of directors) {
				reviews.push(reviewDecision(director.id, request));
			}

			// Determine final decision
			const { decision, requiresHumanEscalation, escalationReason } = determineDecision(reviews);
			const reasoning = combineReasoning(reviews, decision);

			const result: BoardReviewResult = {
				request,
				reviews,
				decision,
				reasoning,
				requiresHumanEscalation,
				escalationReason,
				decidedAt: new Date().toISOString(),
			};

			// Persist
			const session = loadSession(vaultPath);
			session.completedReviews.push(result);
			if (session.completedReviews.length > maxHistory) {
				session.completedReviews = session.completedReviews.slice(-maxHistory);
			}
			saveSession(vaultPath, session);
			appendHistory(vaultPath, result);

			return result;
		},

		getRecentReviews(limit = 10) {
			const session = loadSession(vaultPath);
			return session.completedReviews.slice(-limit);
		},

		getStats() {
			const session = loadSession(vaultPath);
			const completed = session.completedReviews;
			return {
				totalReviews: completed.length,
				approved: completed.filter((r) => r.decision === "approved").length,
				blocked: completed.filter((r) => r.decision === "blocked").length,
				escalated: completed.filter((r) => r.decision === "escalated").length,
			};
		},
	};
}
