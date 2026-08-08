import { InsufficientBalanceError } from "usertrust";
import { describe, expect, it } from "vitest";
import { CompositeEvaluator } from "../src/composite.js";
import { createMockGovernor, mockPolicyDecider, runDemo } from "../src/mock.js";

describe("createMockGovernor", () => {
	it("implements two-phase semantics: authorize holds, abort restores, settle adjusts", async () => {
		const { governor } = createMockGovernor({ budget: 100 });
		const auth = await governor.authorize({
			model: "m",
			estimatedInputTokens: 10,
			maxOutputTokens: 10,
		});
		expect(governor.budgetRemaining()).toBe(80);
		await governor.abort(auth);
		expect(governor.budgetRemaining()).toBe(100);
		const auth2 = await governor.authorize({
			model: "m",
			estimatedInputTokens: 10,
			maxOutputTokens: 10,
		});
		const receipt = await governor.settle(auth2, { inputTokens: 10, outputTokens: 2 });
		expect(receipt.cost).toBe(12);
		expect(governor.budgetRemaining()).toBe(88);
	});

	it("throws InsufficientBalanceError when the hold exceeds budget", async () => {
		const { governor } = createMockGovernor({ budget: 5 });
		await expect(
			governor.authorize({ model: "m", estimatedInputTokens: 10, maxOutputTokens: 10 }),
		).rejects.toThrow(InsufficientBalanceError);
	});

	// Codex PR-85 [P2-6]. The mock's stated cost model is "1 token = 1 usertoken",
	// and since spec D4 row 7 the ACS token counters carry four disjoint tiers.
	// Pricing only input+output made a demo receipt disagree with the very envelope
	// the demo shows beside it: CompositeEvaluator.budgetsEnvelope().token_count
	// sums all four tiers, so a cache-heavy settle reported N tokens spent and
	// charged for a fraction of them.
	it("charges all four disjoint token tiers, not just input+output", async () => {
		const { governor } = createMockGovernor({ budget: 1000 });
		const auth = await governor.authorize({
			model: "m",
			estimatedInputTokens: 100,
			maxOutputTokens: 100,
		});
		const receipt = await governor.settle(auth, {
			inputTokens: 10,
			outputTokens: 2,
			cacheReadTokens: 40,
			cacheWriteTokens: 8,
		});
		expect(receipt.cost).toBe(60);
		expect(governor.budgetRemaining()).toBe(940);
	});

	it("still settles a cache-only call at its real usage, not at the estimate", async () => {
		// Pre-fix this hit the `actual > 0 ? actual : estimatedCost` fallback and
		// silently billed the whole hold, because input+output were both zero.
		const { governor } = createMockGovernor({ budget: 1000 });
		const auth = await governor.authorize({
			model: "m",
			estimatedInputTokens: 100,
			maxOutputTokens: 100,
		});
		const receipt = await governor.settle(auth, {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 25,
			cacheWriteTokens: 0,
		});
		expect(receipt.cost).toBe(25);
	});

	it("leaves two-tier settles unchanged (the cache params default to 0)", async () => {
		const { governor } = createMockGovernor({ budget: 100 });
		const auth = await governor.authorize({
			model: "m",
			estimatedInputTokens: 10,
			maxOutputTokens: 10,
		});
		expect((await governor.settle(auth, { inputTokens: 10, outputTokens: 2 })).cost).toBe(12);
	});
});

describe("mock governor cost agrees with the ACS budgets envelope (Codex PR-85 P2-6)", () => {
	it("settles a cache-heavy composite action at exactly token_count usertokens", async () => {
		const { governor } = createMockGovernor({ budget: 5000 });
		const evaluator = new CompositeEvaluator({
			policy: mockPolicyDecider([]),
			governor,
		});
		const result = await evaluator.evaluate({
			kind: "tool_call",
			model: "mock-1",
			estimatedInputTokens: 100,
			maxOutputTokens: 100,
		});
		const receipt = await evaluator.settle(result, {
			inputTokens: 30,
			outputTokens: 12,
			cacheReadTokens: 500,
			cacheWriteTokens: 60,
		});
		// The invariant: at 1 token = 1 usertoken, the receipt the demo prints and
		// the envelope the policy decider reads must be the SAME number.
		expect(evaluator.budgetsEnvelope().token_count).toBe(602);
		expect(receipt?.cost).toBe(602);
	});
});

describe("mockPolicyDecider", () => {
	it("denies listed kinds and allows everything else", async () => {
		const decide = mockPolicyDecider(["exfiltrate"]);
		const context = {
			inputIdentity: "0".repeat(64),
			budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 },
		};
		const denied = await decide({ kind: "exfiltrate", model: "m" }, context);
		expect(denied.decision).toBe("deny");
		expect(denied.reason).toBe("demo_policy:kind_exfiltrate_denied");
		const allowed = await decide({ kind: "tool_call", model: "m" }, context);
		expect(allowed.decision).toBe("allow");
	});
});

describe("runDemo", () => {
	it("produces the canonical transcript: allow+settle, policy deny (no reservation), budget deny", async () => {
		const transcript = await runDemo();
		const decisions = transcript.map((step) => step.decision);
		expect(decisions).toContain("allow");
		expect(decisions).toContain("deny");
		const policyDenyIndex = transcript.findIndex((step) => step.reason?.includes("demo_policy"));
		expect(policyDenyIndex).toBeGreaterThan(0);
		const budgetDeny = transcript.find((step) => step.reason === "budget_cost_usd_exceeded");
		expect(budgetDeny).toBeDefined();
		expect(transcript[policyDenyIndex]?.budgetRemaining).toBe(
			transcript[policyDenyIndex - 1]?.budgetRemaining,
		);
		expect(transcript[0]?.label).toBeTruthy();
	});
});
