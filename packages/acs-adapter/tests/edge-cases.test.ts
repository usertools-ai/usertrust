import { InsufficientBalanceError, PolicyDeniedError } from "usertrust";
import type { Governor } from "usertrust/headless";
import { describe, expect, it } from "vitest";
import { CompositeEvaluator } from "../src/composite.js";
import { canonicalJson } from "../src/identity.js";
import { createMockGovernor, mockPolicyDecider } from "../src/mock.js";

describe("createMockGovernor defaults", () => {
	it("defaults the budget to 10_000 usertokens", () => {
		const { governor } = createMockGovernor();
		expect(governor.budgetRemaining()).toBe(10_000);
	});

	it("authorize defaults to 100 input + 4096 output tokens when unspecified", async () => {
		const { governor } = createMockGovernor();
		const auth = await governor.authorize({ model: "mock-1" });
		expect(auth.estimatedCost).toBe(100 + 4096);
		expect(governor.budgetRemaining()).toBe(10_000 - 4196);
	});

	it("settle without params charges the full estimated cost", async () => {
		const { governor } = createMockGovernor();
		const auth = await governor.authorize({ model: "mock-1" });
		const receipt = await governor.settle(auth);
		expect(receipt.cost).toBe(auth.estimatedCost);
		expect(receipt.budgetRemaining).toBe(10_000 - auth.estimatedCost);
	});

	it("abort of an already-settled hold is a no-op", async () => {
		const { governor } = createMockGovernor();
		const auth = await governor.authorize({ model: "mock-1" });
		await governor.settle(auth);
		const before = governor.budgetRemaining();
		await governor.abort(auth);
		expect(governor.budgetRemaining()).toBe(before);
	});

	it("destroy voids outstanding holds and restores the budget", async () => {
		const { governor } = createMockGovernor({ budget: 500 });
		await governor.authorize({ model: "mock-1", estimatedInputTokens: 10, maxOutputTokens: 20 });
		expect(governor.budgetRemaining()).toBe(470);
		await governor.destroy();
		expect(governor.budgetRemaining()).toBe(500);
	});

	it("estimateCost is token-sum and estimateInputTokens is chars/4", () => {
		const { governor } = createMockGovernor();
		expect(governor.estimateCost("mock-1", 3, 4)).toBe(7);
		expect(governor.estimateInputTokens([])).toBe(1); // "[]" is 2 chars -> ceil(2/4)
	});
});

describe("canonicalJson booleans", () => {
	it("serializes true and false", () => {
		expect(canonicalJson(true)).toBe("true");
		expect(canonicalJson(false)).toBe("false");
		expect(canonicalJson({ a: true, b: false })).toBe('{"a":true,"b":false}');
	});
});

describe("CompositeEvaluator reservation failure mapping", () => {
	const action = {
		kind: "tool_call",
		model: "mock-1",
		estimatedInputTokens: 10,
		maxOutputTokens: 10,
	};

	it("maps PolicyDeniedError from the governor to a usertrust:policy_denied reason", async () => {
		const { governor } = createMockGovernor();
		const denying: Governor = {
			...governor,
			authorize: async () => {
				throw new PolicyDeniedError("pii_detected");
			},
		};
		const evaluator = new CompositeEvaluator({ policy: mockPolicyDecider([]), governor: denying });
		const result = await evaluator.evaluate(action);
		expect(result.verdict).toEqual({
			decision: "deny",
			reason: "usertrust:policy_denied:pii_detected",
		});
		expect(result.enforced).toBe(true);
		expect(result.authorization).toBeNull();
	});

	it("rethrows unknown governor errors", async () => {
		const { governor } = createMockGovernor();
		const broken: Governor = {
			...governor,
			authorize: async () => {
				throw new Error("tigerbeetle down");
			},
		};
		const evaluator = new CompositeEvaluator({ policy: mockPolicyDecider([]), governor: broken });
		await expect(evaluator.evaluate(action)).rejects.toThrow("tigerbeetle down");
	});

	it("still maps InsufficientBalanceError (sanity, exercised via mock budget)", async () => {
		const { governor } = createMockGovernor({ budget: 1 });
		const evaluator = new CompositeEvaluator({ policy: mockPolicyDecider([]), governor });
		const result = await evaluator.evaluate(action);
		expect(result.verdict.decision).toBe("deny");
		expect(result.authorization).toBeNull();
		// direct instance check to pin the error class the mapping relies on
		await expect(governor.authorize({ model: "mock-1" })).rejects.toBeInstanceOf(
			InsufficientBalanceError,
		);
	});

	it("settle without usage settles at estimated cost and counts no tokens", async () => {
		const { governor } = createMockGovernor();
		const evaluator = new CompositeEvaluator({ policy: mockPolicyDecider([]), governor });
		const result = await evaluator.evaluate(action);
		expect(result.authorization).not.toBeNull();
		const receipt = await evaluator.settle(result);
		expect(receipt?.cost).toBe(20);
		expect(evaluator.budgetsEnvelope().token_count).toBe(0);
		expect(evaluator.budgetsEnvelope().cost_usd).toBe(20);
	});

	it("a failed settle stays retryable and a failed abort stays retryable", async () => {
		const { governor } = createMockGovernor();
		let settleFailures = 1;
		let abortFailures = 1;
		const flaky: Governor = {
			...governor,
			settle: async (auth, params) => {
				if (settleFailures > 0) {
					settleFailures -= 1;
					throw new Error("transient settle failure");
				}
				return governor.settle(auth, params);
			},
			abort: async (auth, error) => {
				if (abortFailures > 0) {
					abortFailures -= 1;
					throw new Error("transient abort failure");
				}
				return governor.abort(auth, error);
			},
		};
		const evaluator = new CompositeEvaluator({ policy: mockPolicyDecider([]), governor: flaky });

		const settleable = await evaluator.evaluate(action);
		await expect(evaluator.settle(settleable, { inputTokens: 5, outputTokens: 5 })).rejects.toThrow(
			"transient settle failure",
		);
		const receipt = await evaluator.settle(settleable, { inputTokens: 5, outputTokens: 5 });
		expect(receipt?.cost).toBe(10);

		const abortable = await evaluator.evaluate(action);
		await expect(evaluator.abort(abortable)).rejects.toThrow("transient abort failure");
		await expect(evaluator.abort(abortable)).resolves.toBeUndefined();
	});
});
