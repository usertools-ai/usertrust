import { describe, expect, it } from "vitest";
import { CompositeEvaluator, type PolicyDecider } from "../src/composite.js";
import { createMockGovernor } from "../src/mock.js";
import { ACS_BUDGET_REASONS } from "../src/vocabulary.js";

const ACTION = {
	kind: "tool_call",
	model: "mock-1",
	estimatedInputTokens: 10,
	maxOutputTokens: 10,
};

describe("CompositeEvaluator", () => {
	it("policy allow -> ledger reserves -> settle completes two-phase", async () => {
		const { governor } = createMockGovernor({ budget: 1000 });
		const evaluator = new CompositeEvaluator({ policy: () => ({ decision: "allow" }), governor });
		const result = await evaluator.evaluate(ACTION);
		expect(result.verdict.decision).toBe("allow");
		expect(result.enforced).toBe(true);
		expect(result.authorization).not.toBeNull();
		expect(governor.budgetRemaining()).toBeLessThan(1000);
		const receipt = await evaluator.settle(result, { inputTokens: 10, outputTokens: 5 });
		expect(receipt?.settled).toBe(true);
		const budgets = evaluator.budgetsEnvelope();
		expect(budgets.tool_call_count).toBe(1);
		expect(budgets.token_count).toBe(15);
		expect(budgets.cost_usd).toBeGreaterThan(0);
	});

	it("policy deny never consumes a reservation", async () => {
		const { governor } = createMockGovernor({ budget: 1000 });
		const evaluator = new CompositeEvaluator({
			policy: () => ({ decision: "deny", reason: "content_hash_mismatch" }),
			governor,
		});
		const result = await evaluator.evaluate(ACTION);
		expect(result.verdict.decision).toBe("deny");
		expect(result.authorization).toBeNull();
		expect(governor.budgetRemaining()).toBe(1000);
	});

	it("reservation failure converts allow into deny with the ACS budget reason", async () => {
		const { governor } = createMockGovernor({ budget: 5 });
		const evaluator = new CompositeEvaluator({ policy: () => ({ decision: "allow" }), governor });
		const result = await evaluator.evaluate(ACTION);
		expect(result.verdict.decision).toBe("deny");
		expect(result.verdict.reason).toBe(ACS_BUDGET_REASONS.cost);
		expect(result.authorization).toBeNull();
		expect(governor.budgetRemaining()).toBe(5);
	});

	it("evaluate_only mode never reserves and marks enforced=false", async () => {
		const { governor } = createMockGovernor({ budget: 5 });
		const evaluator = new CompositeEvaluator({
			policy: () => ({ decision: "allow" }),
			governor,
			mode: "evaluate_only",
		});
		const result = await evaluator.evaluate(ACTION);
		expect(result.verdict.decision).toBe("allow");
		expect(result.enforced).toBe(false);
		expect(result.authorization).toBeNull();
		expect(governor.budgetRemaining()).toBe(5);
		expect(await evaluator.settle(result)).toBeNull();
	});

	it("abort voids the reservation and restores budget", async () => {
		const { governor } = createMockGovernor({ budget: 1000 });
		const evaluator = new CompositeEvaluator({ policy: () => ({ decision: "allow" }), governor });
		const result = await evaluator.evaluate(ACTION);
		await evaluator.abort(result, new Error("provider 500"));
		expect(governor.budgetRemaining()).toBe(1000);
	});

	it("passes inputIdentity and live budgets to the policy", async () => {
		const { governor } = createMockGovernor({ budget: 1000 });
		let seenIdentity = "";
		let seenCount = -1;
		const evaluator = new CompositeEvaluator({
			policy: (_action, context) => {
				seenIdentity = context.inputIdentity;
				seenCount = context.budgets.tool_call_count;
				return { decision: "allow" };
			},
			governor,
		});
		await evaluator.evaluate({ ...ACTION, input: { path: "/etc/passwd" } });
		expect(seenIdentity).toMatch(/^[0-9a-f]{64}$/);
		expect(seenCount).toBe(0);
	});

	it("elapsed_seconds derives from the injected clock", async () => {
		const { governor } = createMockGovernor({ budget: 1000 });
		let now = 1_000_000;
		const evaluator = new CompositeEvaluator({
			policy: () => ({ decision: "allow" }),
			governor,
			clock: () => now,
		});
		now += 42_000;
		expect(evaluator.budgetsEnvelope().elapsed_seconds).toBe(42);
	});

	it("invalid policy output fails closed with runtime_error:policy_output_invalid", async () => {
		const { governor } = createMockGovernor({ budget: 1000 });
		const invalidOutputs: unknown[] = [{ decision: "maybe" }, null, "allow", 42, undefined];
		for (const output of invalidOutputs) {
			const evaluator = new CompositeEvaluator({
				policy: (() => output) as unknown as PolicyDecider,
				governor,
			});
			const result = await evaluator.evaluate(ACTION);
			expect(result.verdict.decision).toBe("deny");
			expect(result.verdict.reason).toBe("runtime_error:policy_output_invalid");
			expect(result.authorization).toBeNull();
		}
		expect(governor.budgetRemaining()).toBe(1000);
	});

	it("guards double-settle: the second settle returns null and counters accrue once", async () => {
		const { governor } = createMockGovernor({ budget: 1000 });
		const evaluator = new CompositeEvaluator({ policy: () => ({ decision: "allow" }), governor });
		const result = await evaluator.evaluate(ACTION);
		const receipt = await evaluator.settle(result, { inputTokens: 10, outputTokens: 5 });
		expect(receipt?.settled).toBe(true);
		const budgetAfterFirst = governor.budgetRemaining();
		expect(await evaluator.settle(result, { inputTokens: 10, outputTokens: 5 })).toBeNull();
		expect(governor.budgetRemaining()).toBe(budgetAfterFirst);
		expect(evaluator.budgetsEnvelope().token_count).toBe(15);
	});

	it("token_count sums all four tiers, not just input+output (D4 row 7 — the undercount)", async () => {
		const { governor } = createMockGovernor({ budget: 1000 });
		const evaluator = new CompositeEvaluator({ policy: () => ({ decision: "allow" }), governor });
		const result = await evaluator.evaluate(ACTION);
		await evaluator.settle(result, {
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 900_000,
			cacheWriteTokens: 1_200,
		});
		const budgets = evaluator.budgetsEnvelope();
		// Pre-fix this was 15 (input+output only) — the cache-read flood vanished.
		expect(budgets.token_count).toBe(10 + 5 + 900_000 + 1_200);
		expect(evaluator.tokenCounts()).toEqual({
			inputTokenCount: 10,
			outputTokenCount: 5,
			cacheReadTokenCount: 900_000,
			cacheWriteTokenCount: 1_200,
		});
	});

	it("guards abort-after-settle, settle-after-abort, and double-abort", async () => {
		const { governor } = createMockGovernor({ budget: 1000 });
		const evaluator = new CompositeEvaluator({ policy: () => ({ decision: "allow" }), governor });
		const aborted = await evaluator.evaluate(ACTION);
		await evaluator.abort(aborted, new Error("provider 500"));
		expect(governor.budgetRemaining()).toBe(1000);
		await evaluator.abort(aborted, new Error("again"));
		expect(governor.budgetRemaining()).toBe(1000);
		expect(await evaluator.settle(aborted, { inputTokens: 10, outputTokens: 5 })).toBeNull();
		expect(governor.budgetRemaining()).toBe(1000);
		const settled = await evaluator.evaluate(ACTION);
		await evaluator.settle(settled, { inputTokens: 10, outputTokens: 5 });
		const budgetAfterSettle = governor.budgetRemaining();
		await evaluator.abort(settled, new Error("late abort"));
		expect(governor.budgetRemaining()).toBe(budgetAfterSettle);
	});
});
