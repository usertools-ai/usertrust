import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoard, determineDecision, type BoardReviewResult } from "../../src/board/board.js";
import {
	DIRECTOR_CONFIGS,
	listDirectors,
	reviewDecision,
	determineVote,
} from "../../src/board/director.js";
import type { BoardRequest } from "../../src/board/concerns.js";

// ── Helpers ──

let testDir: string;

function freshVault(): string {
	const dir = join(tmpdir(), `govern-board-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeRequest(overrides: Partial<BoardRequest> = {}): BoardRequest {
	return {
		decisionType: "vp_decision",
		description: "Test decision for unit testing",
		scope: ["src/**"],
		context: {},
		...overrides,
	};
}

beforeEach(() => {
	testDir = freshVault();
});

afterEach(() => {
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

// ── Director Configuration ──

describe("Director configuration", () => {
	it("has two Directors configured", () => {
		const directors = listDirectors();
		expect(directors).toHaveLength(2);
	});

	it("Directors have complementary focus areas", () => {
		const directorA = DIRECTOR_CONFIGS["director-a"];
		const directorB = DIRECTOR_CONFIGS["director-b"];

		expect(directorA?.focusAreas).toContain("hallucination");
		expect(directorA?.focusAreas).toContain("safety");
		expect(directorA?.focusAreas).toContain("policy_violation");
		expect(directorB?.focusAreas).toContain("bias");
		expect(directorB?.focusAreas).toContain("scope_creep");
		expect(directorB?.focusAreas).toContain("resource_abuse");
	});
});

// ── Director Reviews ──

describe("Director review", () => {
	it("approves benign decisions", () => {
		const request = makeRequest({
			description: "Minor code refactoring",
			scope: ["src/utils/helpers.ts"],
		});
		const review = reviewDecision("director-a", request);

		expect(review.directorId).toBe("director-a");
		expect(review.vote).toBe("approve");
		expect(review.concerns).toHaveLength(0);
		expect(review.confidence).toBeGreaterThan(0.5);
	});

	it("detects safety concerns for security-sensitive scope", () => {
		const request = makeRequest({
			description: "Update password hashing",
			scope: ["src/auth/password.ts"],
		});
		const review = reviewDecision("director-a", request);

		expect(review.concerns.some((c) => c.type === "safety")).toBe(true);
	});

	it("detects scope creep for broad patterns", () => {
		const request = makeRequest({ scope: ["**"] });
		const review = reviewDecision("director-b", request);

		expect(review.concerns.some((c) => c.type === "scope_creep")).toBe(true);
	});

	it("detects policy violation for overrides without justification", () => {
		const request = makeRequest({
			decisionType: "policy_override",
			description: "Override security policy",
			context: {},
		});
		const review = reviewDecision("director-a", request);

		const hasPolicyOrHallucination = review.concerns.some(
			(c) => c.type === "policy_violation" || c.type === "hallucination",
		);
		expect(hasPolicyOrHallucination).toBe(true);
	});

	it("throws for unknown director ID", () => {
		expect(() => reviewDecision("director-z", makeRequest())).toThrow("Unknown director");
	});
});

// ── Vote Determination ──

describe("determineVote", () => {
	it("returns approve when no concerns", () => {
		expect(determineVote([], "high")).toBe("approve");
	});

	it("returns veto when concern severity meets threshold", () => {
		const concerns = [
			{ type: "safety" as const, severity: "high" as const, description: "x", evidence: "y" },
		];
		expect(determineVote(concerns, "high")).toBe("veto");
	});

	it("returns abstain for medium concerns below high threshold", () => {
		const concerns = [
			{ type: "bias" as const, severity: "medium" as const, description: "x", evidence: "y" },
		];
		expect(determineVote(concerns, "high")).toBe("abstain");
	});

	it("returns approve for low concerns below high threshold", () => {
		const concerns = [
			{ type: "bias" as const, severity: "low" as const, description: "x", evidence: "y" },
		];
		expect(determineVote(concerns, "high")).toBe("approve");
	});
});

// ── Director Independence ──

describe("Director independence", () => {
	it("Directors review independently with different focus", () => {
		const request = makeRequest({
			decisionType: "scope_expansion",
			description: "Assign task to preferred worker",
			scope: ["src/**", "tests/**"],
			context: { preferredWorker: "worker-alpha" },
		});

		const reviewA = reviewDecision("director-a", request);
		const reviewB = reviewDecision("director-b", request);

		// Director B detects bias (preferredWorker in scope_expansion)
		expect(reviewB.concerns.some((c) => c.type === "bias")).toBe(true);
		// Directors are distinct
		expect(reviewA.directorId).not.toBe(reviewB.directorId);
	});
});

// ── Decision Matrix ──

describe("Decision matrix (determineDecision)", () => {
	function fakeReview(vote: "approve" | "veto" | "abstain", id: string): ReturnType<typeof reviewDecision> {
		return {
			directorId: id,
			vote,
			reasoning: `${vote} reasoning`,
			concerns: [],
			confidence: 0.9,
			reviewedAt: new Date().toISOString(),
		};
	}

	it("both approve → approved", () => {
		const result = determineDecision([
			fakeReview("approve", "director-a"),
			fakeReview("approve", "director-b"),
		]);
		expect(result.decision).toBe("approved");
		expect(result.requiresHumanEscalation).toBe(false);
	});

	it("unanimous veto → blocked", () => {
		const result = determineDecision([
			fakeReview("veto", "director-a"),
			fakeReview("veto", "director-b"),
		]);
		expect(result.decision).toBe("blocked");
		expect(result.requiresHumanEscalation).toBe(true);
		expect(result.escalationReason).toContain("Unanimous");
	});

	it("veto + approve → escalated", () => {
		const result = determineDecision([
			fakeReview("veto", "director-a"),
			fakeReview("approve", "director-b"),
		]);
		expect(result.decision).toBe("escalated");
		expect(result.requiresHumanEscalation).toBe(true);
		expect(result.escalationReason).toContain("disagreement");
	});

	it("both abstain → escalated", () => {
		const result = determineDecision([
			fakeReview("abstain", "director-a"),
			fakeReview("abstain", "director-b"),
		]);
		expect(result.decision).toBe("escalated");
		expect(result.requiresHumanEscalation).toBe(true);
		expect(result.escalationReason).toContain("abstained");
	});

	it("approve + abstain → approved", () => {
		const result = determineDecision([
			fakeReview("approve", "director-a"),
			fakeReview("abstain", "director-b"),
		]);
		expect(result.decision).toBe("approved");
		expect(result.requiresHumanEscalation).toBe(false);
	});

	it("veto + abstain → blocked", () => {
		const result = determineDecision([
			fakeReview("veto", "director-a"),
			fakeReview("abstain", "director-b"),
		]);
		expect(result.decision).toBe("blocked");
		expect(result.requiresHumanEscalation).toBe(true);
	});
});

// ── Board Integration (createBoard) ──

describe("createBoard", () => {
	it("reviewNow approves benign request", () => {
		const board = createBoard(testDir);
		const result = board.reviewNow(
			"vp_decision",
			"agent-1",
			"Minor refactoring",
			{ scope: ["src/utils.ts"] },
		);

		expect(result.decision).toBe("approved");
		expect(result.reviews).toHaveLength(2);
		expect(result.request.reviewId).toMatch(/^BR_/);
		expect(result.decidedAt).toBeDefined();
	});

	it("reviewNow blocks on high-severity safety concern", () => {
		const board = createBoard(testDir);
		const result = board.reviewNow(
			"security_sensitive",
			"agent-1",
			"Modify password storage credentials",
			{ scope: ["src/auth/credentials.ts"] },
		);

		// Both directors should find safety concerns → at least one veto
		expect(["blocked", "escalated"]).toContain(result.decision);
		expect(result.requiresHumanEscalation).toBe(true);
	});

	it("persists completed reviews to session", () => {
		const board = createBoard(testDir);
		board.reviewNow("vp_decision", "agent-1", "Change A", { scope: ["a.ts"] });
		board.reviewNow("vp_decision", "agent-1", "Change B", { scope: ["b.ts"] });

		const recent = board.getRecentReviews(10);
		expect(recent).toHaveLength(2);
	});

	it("respects maxHistory buffer", () => {
		const board = createBoard(testDir, { maxHistory: 3 });

		for (let i = 0; i < 5; i++) {
			board.reviewNow("vp_decision", "agent-1", `Change ${i}`, {
				scope: [`file${i}.ts`],
			});
		}

		const recent = board.getRecentReviews(100);
		expect(recent).toHaveLength(3);
	});

	it("getStats returns accurate counts", () => {
		const board = createBoard(testDir);

		// Benign → approved
		board.reviewNow("vp_decision", "agent-1", "Safe change", { scope: ["a.ts"] });

		const stats = board.getStats();
		expect(stats.totalReviews).toBe(1);
		expect(stats.approved).toBe(1);
		expect(stats.blocked).toBe(0);
		expect(stats.escalated).toBe(0);
	});
});

// ── JSONL History ──

describe("JSONL history logging", () => {
	it("appends each review to history.jsonl", () => {
		const board = createBoard(testDir);
		board.reviewNow("vp_decision", "agent-1", "First", { scope: ["a.ts"] });
		board.reviewNow("vp_decision", "agent-1", "Second", { scope: ["b.ts"] });

		const historyFile = join(testDir, "board", "history.jsonl");
		expect(existsSync(historyFile)).toBe(true);

		const lines = readFileSync(historyFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);

		// Each line is valid JSON
		for (const line of lines) {
			const parsed = JSON.parse(line) as BoardReviewResult;
			expect(parsed.decision).toBeDefined();
			expect(parsed.reviews).toBeDefined();
		}
	});

	it("history survives across board instances", () => {
		const board1 = createBoard(testDir);
		board1.reviewNow("vp_decision", "agent-1", "From instance 1");

		const board2 = createBoard(testDir);
		board2.reviewNow("vp_decision", "agent-1", "From instance 2");

		const historyFile = join(testDir, "board", "history.jsonl");
		const lines = readFileSync(historyFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});
});

// ── Review Structure ──

describe("Review structure", () => {
	it("includes all required fields", () => {
		const review = reviewDecision("director-a", makeRequest());

		expect(review).toHaveProperty("directorId");
		expect(review).toHaveProperty("vote");
		expect(review).toHaveProperty("reasoning");
		expect(review).toHaveProperty("concerns");
		expect(review).toHaveProperty("confidence");
		expect(review).toHaveProperty("reviewedAt");
	});

	it("reasoning explains the vote", () => {
		const review = reviewDecision("director-a", makeRequest({
			description: "Safe minor change",
			scope: ["src/utils.ts"],
		}));

		expect(review.reasoning).toContain("Approved");
	});

	it("board result reasoning prefixes decision", () => {
		const board = createBoard(testDir);
		const result = board.reviewNow("vp_decision", "agent-1", "Safe change");

		expect(result.reasoning).toContain("Board APPROVED:");
	});
});
