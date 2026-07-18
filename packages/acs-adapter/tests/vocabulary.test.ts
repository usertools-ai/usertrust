import { describe, expect, it } from "vitest";
import { ACS_BUDGET_REASONS, isAcsDecision, runtimeError } from "../src/vocabulary.js";

describe("ACS vocabulary", () => {
	it("runtimeError produces namespaced reasons", () => {
		expect(runtimeError("approval_action_mismatch")).toBe("runtime_error:approval_action_mismatch");
	});

	it("rejects invalid runtime error codes", () => {
		expect(() => runtimeError("")).toThrow();
		expect(() => runtimeError("has space")).toThrow();
		expect(() => runtimeError("runtime_error:double")).toThrow();
	});

	it("budget reason names match the ACS envelope counter vocabulary", () => {
		expect(ACS_BUDGET_REASONS.cost).toBe("budget_cost_usd_exceeded");
		expect(ACS_BUDGET_REASONS.toolCalls).toBe("budget_tool_call_count_exceeded");
	});

	it("isAcsDecision narrows the five-verdict set", () => {
		expect(isAcsDecision("allow")).toBe(true);
		expect(isAcsDecision("transform")).toBe(true);
		expect(isAcsDecision("maybe")).toBe(false);
	});
});
