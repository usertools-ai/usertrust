import { InsufficientBalanceError } from "usertrust";
import { describe, expect, it } from "vitest";
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
