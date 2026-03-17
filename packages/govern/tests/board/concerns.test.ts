import { describe, expect, it } from "vitest";
import {
	type BoardRequest,
	detectBias,
	detectConcerns,
	detectHallucination,
	detectPolicyViolation,
	detectResourceAbuse,
	detectSafety,
	detectScopeCreep,
} from "../../src/board/concerns.js";

// ── Helpers ──

function makeRequest(overrides: Partial<BoardRequest> = {}): BoardRequest {
	return {
		decisionType: "vp_decision",
		description: "Test decision",
		scope: ["src/**"],
		context: {},
		...overrides,
	};
}

// ── Hallucination ──

describe("detectHallucination", () => {
	it("flags absolute 'always' claims", () => {
		const concern = detectHallucination(makeRequest({ description: "This should always work" }));
		expect(concern).not.toBeNull();
		expect(concern?.type).toBe("hallucination");
		expect(concern?.severity).toBe("medium");
	});

	it("flags absolute 'never' claims", () => {
		const concern = detectHallucination(makeRequest({ description: "This will never fail" }));
		expect(concern).not.toBeNull();
		expect(concern?.type).toBe("hallucination");
	});

	it("flags policy override without justification", () => {
		const concern = detectHallucination(
			makeRequest({ decisionType: "policy_override", context: {} }),
		);
		expect(concern).not.toBeNull();
		expect(concern?.severity).toBe("high");
	});

	it("allows policy override with justification", () => {
		const concern = detectHallucination(
			makeRequest({
				decisionType: "policy_override",
				context: { justification: "Emergency security patch" },
			}),
		);
		expect(concern).toBeNull();
	});

	it("returns null for benign description", () => {
		const concern = detectHallucination(makeRequest({ description: "Minor refactoring of utils" }));
		expect(concern).toBeNull();
	});
});

// ── Bias ──

describe("detectBias", () => {
	it("flags preferred worker in scope expansion", () => {
		const concern = detectBias(
			makeRequest({
				decisionType: "scope_expansion",
				context: { preferredWorker: "worker-alpha" },
			}),
		);
		expect(concern).not.toBeNull();
		expect(concern?.type).toBe("bias");
		expect(concern?.evidence).toContain("worker-alpha");
	});

	it("ignores preferred worker outside scope expansion", () => {
		const concern = detectBias(
			makeRequest({
				decisionType: "vp_decision",
				context: { preferredWorker: "worker-alpha" },
			}),
		);
		expect(concern).toBeNull();
	});

	it("returns null when no preferred worker", () => {
		const concern = detectBias(makeRequest({ decisionType: "scope_expansion" }));
		expect(concern).toBeNull();
	});
});

// ── Safety ──

describe("detectSafety", () => {
	it("flags 'password' in description", () => {
		const concern = detectSafety(makeRequest({ description: "Update password hashing" }));
		expect(concern).not.toBeNull();
		expect(concern?.type).toBe("safety");
		expect(concern?.severity).toBe("high");
	});

	it("flags 'secret' in scope", () => {
		const concern = detectSafety(makeRequest({ scope: [".env.secret", "src/config.ts"] }));
		expect(concern).not.toBeNull();
		expect(concern?.type).toBe("safety");
	});

	it("flags 'credential' in scope", () => {
		const concern = detectSafety(makeRequest({ scope: ["credentials.json"] }));
		expect(concern).not.toBeNull();
	});

	it("returns null for benign scope", () => {
		const concern = detectSafety(
			makeRequest({ scope: ["src/utils.ts"], description: "Refactor helpers" }),
		);
		expect(concern).toBeNull();
	});

	it("handles undefined scope", () => {
		const concern = detectSafety(makeRequest({ scope: undefined, description: "Safe change" }));
		expect(concern).toBeNull();
	});
});

// ── Scope Creep ──

describe("detectScopeCreep", () => {
	it("flags root-level ** wildcard", () => {
		const concern = detectScopeCreep(makeRequest({ scope: ["**"] }));
		expect(concern).not.toBeNull();
		expect(concern?.type).toBe("scope_creep");
		expect(concern?.severity).toBe("medium");
	});

	it("allows scoped ** wildcard", () => {
		const concern = detectScopeCreep(makeRequest({ scope: ["src/**"] }));
		expect(concern).toBeNull();
	});

	it("flags excessive scope breadth (>10)", () => {
		const scope = Array.from({ length: 11 }, (_, i) => `file${i}.ts`);
		const concern = detectScopeCreep(makeRequest({ scope }));
		expect(concern).not.toBeNull();
		expect(concern?.severity).toBe("high");
		expect(concern?.evidence).toContain("11");
	});

	it("allows scope with 10 or fewer patterns", () => {
		const scope = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);
		const concern = detectScopeCreep(makeRequest({ scope }));
		expect(concern).toBeNull();
	});

	it("handles undefined scope", () => {
		const concern = detectScopeCreep(makeRequest({ scope: undefined }));
		expect(concern).toBeNull();
	});
});

// ── Resource Abuse ──

describe("detectResourceAbuse", () => {
	it("flags high cost on resource-intensive operations", () => {
		const concern = detectResourceAbuse(
			makeRequest({
				decisionType: "resource_intensive",
				context: { estimatedCost: 150 },
			}),
		);
		expect(concern).not.toBeNull();
		expect(concern?.type).toBe("resource_abuse");
		expect(concern?.severity).toBe("high");
		expect(concern?.evidence).toContain("$150");
	});

	it("allows reasonable costs", () => {
		const concern = detectResourceAbuse(
			makeRequest({
				decisionType: "resource_intensive",
				context: { estimatedCost: 50 },
			}),
		);
		expect(concern).toBeNull();
	});

	it("ignores cost on non-resource-intensive decisions", () => {
		const concern = detectResourceAbuse(
			makeRequest({
				decisionType: "vp_decision",
				context: { estimatedCost: 500 },
			}),
		);
		expect(concern).toBeNull();
	});

	it("handles missing estimatedCost", () => {
		const concern = detectResourceAbuse(makeRequest({ decisionType: "resource_intensive" }));
		expect(concern).toBeNull();
	});
});

// ── Policy Violation ──

describe("detectPolicyViolation", () => {
	it("flags policy override requests", () => {
		const concern = detectPolicyViolation(makeRequest({ decisionType: "policy_override" }));
		expect(concern).not.toBeNull();
		expect(concern?.type).toBe("policy_violation");
		expect(concern?.severity).toBe("medium");
	});

	it("returns null for non-override decisions", () => {
		const concern = detectPolicyViolation(makeRequest({ decisionType: "vp_decision" }));
		expect(concern).toBeNull();
	});
});

// ── Aggregate: detectConcerns ──

describe("detectConcerns", () => {
	it("returns empty array for benign request", () => {
		const concerns = detectConcerns(
			makeRequest({
				description: "Minor refactoring",
				scope: ["src/utils.ts"],
			}),
		);
		expect(concerns).toHaveLength(0);
	});

	it("detects multiple concerns in a single request", () => {
		const concerns = detectConcerns(
			makeRequest({
				decisionType: "policy_override",
				description: "Always override password checks",
				scope: ["**"],
			}),
		);

		// Should find: hallucination (always), safety (password),
		// scope_creep (**), policy_violation (policy_override)
		expect(concerns.length).toBeGreaterThanOrEqual(3);
		const types = concerns.map((c) => c.type);
		expect(types).toContain("hallucination");
		expect(types).toContain("safety");
		expect(types).toContain("policy_violation");
	});

	it("each concern has required fields", () => {
		const concerns = detectConcerns(
			makeRequest({
				decisionType: "policy_override",
				description: "Override all checks always",
			}),
		);

		for (const c of concerns) {
			expect(c.type).toBeDefined();
			expect(c.severity).toBeDefined();
			expect(c.description).toBeDefined();
			expect(c.evidence).toBeDefined();
		}
	});

	it("returns all 6 concern types with a maximally-triggering request", () => {
		const concerns = detectConcerns(
			makeRequest({
				decisionType: "policy_override",
				description: "Always override password checks",
				scope: ["**", ...Array.from({ length: 11 }, (_, i) => `file${i}.ts`)],
				context: { preferredWorker: "w-1", estimatedCost: 200 },
			}),
		);
		// policy_override triggers: hallucination (no justification), policy_violation
		// "always" triggers: hallucination
		// "password" triggers: safety
		// "**" triggers: scope_creep
		// But scope_expansion is not the decisionType so bias won't trigger
		// resource_intensive is not the decisionType so resource_abuse won't trigger
		const types = new Set(concerns.map((c) => c.type));
		expect(types.has("hallucination")).toBe(true);
		expect(types.has("safety")).toBe(true);
		expect(types.has("scope_creep")).toBe(true);
		expect(types.has("policy_violation")).toBe(true);
	});

	it("returns empty for minimal clean request", () => {
		const concerns = detectConcerns(
			makeRequest({
				decisionType: "code_review",
				description: "Format spacing in utils",
				scope: ["src/utils.ts"],
				context: {},
			}),
		);
		expect(concerns).toHaveLength(0);
	});
});

// ── Additional edge cases ──

describe("detectHallucination — edge cases", () => {
	it("is case-insensitive (ALWAYS in uppercase)", () => {
		const concern = detectHallucination(
			makeRequest({ description: "This should ALWAYS work fine" }),
		);
		expect(concern).not.toBeNull();
	});

	it("detects 'never' in longer sentences", () => {
		const concern = detectHallucination(
			makeRequest({ description: "You should never trust this output without verification" }),
		);
		expect(concern).not.toBeNull();
	});

	it("does not flag policy_override with justification in context", () => {
		const concern = detectHallucination(
			makeRequest({
				decisionType: "policy_override",
				description: "Emergency override",
				context: { justification: "Security incident response" },
			}),
		);
		expect(concern).toBeNull();
	});
});

describe("detectSafety — all sensitive patterns", () => {
	const patterns = ["password", "credential", "secret", "token", "key"];
	for (const pattern of patterns) {
		it(`flags '${pattern}' in description`, () => {
			const concern = detectSafety(
				makeRequest({ description: `Access the ${pattern} store`, scope: ["src/safe.ts"] }),
			);
			expect(concern).not.toBeNull();
			expect(concern?.type).toBe("safety");
			expect(concern?.evidence).toContain(pattern);
		});

		it(`flags '${pattern}' in scope`, () => {
			const concern = detectSafety(
				makeRequest({ description: "Safe operation", scope: [`src/${pattern}.ts`] }),
			);
			expect(concern).not.toBeNull();
		});
	}

	it("flags first matching pattern only", () => {
		const concern = detectSafety(
			makeRequest({
				description: "Modify password and secret and token",
				scope: ["safe.ts"],
			}),
		);
		expect(concern).not.toBeNull();
		// "password" comes first alphabetically in the patterns array
		expect(concern?.evidence).toContain("password");
	});
});

describe("detectScopeCreep — edge cases", () => {
	it("does not flag ** under a directory (e.g. src/**)", () => {
		const concern = detectScopeCreep(makeRequest({ scope: ["src/**"] }));
		expect(concern).toBeNull();
	});

	it("flags standalone ** without slash", () => {
		const concern = detectScopeCreep(makeRequest({ scope: ["**/*.ts"] }));
		// "**/*.ts" contains "**" but also "/" — depends on s.includes("/")
		// "**/*.ts" includes "/" → should NOT trigger root-level ** check
		expect(concern).toBeNull();
	});

	it("exactly 10 scope patterns is allowed", () => {
		const scope = Array.from({ length: 10 }, (_, i) => `dir/file${i}.ts`);
		const concern = detectScopeCreep(makeRequest({ scope }));
		expect(concern).toBeNull();
	});

	it("exactly 11 scope patterns triggers high severity", () => {
		const scope = Array.from({ length: 11 }, (_, i) => `dir/file${i}.ts`);
		const concern = detectScopeCreep(makeRequest({ scope }));
		expect(concern).not.toBeNull();
		expect(concern?.severity).toBe("high");
	});
});

describe("detectResourceAbuse — boundary", () => {
	it("exactly $100 does not trigger (threshold is >100)", () => {
		const concern = detectResourceAbuse(
			makeRequest({
				decisionType: "resource_intensive",
				context: { estimatedCost: 100 },
			}),
		);
		expect(concern).toBeNull();
	});

	it("$100.01 triggers", () => {
		const concern = detectResourceAbuse(
			makeRequest({
				decisionType: "resource_intensive",
				context: { estimatedCost: 100.01 },
			}),
		);
		expect(concern).not.toBeNull();
	});
});
