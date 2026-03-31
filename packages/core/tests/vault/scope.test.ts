// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Tests for credential scope checking — agent, action, and expiry constraints.
 */

import { describe, expect, it } from "vitest";
import type { CredentialScope } from "../../src/shared/types.js";
import { checkScope } from "../../src/vault/scope.js";

describe("checkScope()", () => {
	// ── Agent scope ──

	it("allows all agents when agents list is empty", () => {
		const scope: CredentialScope = { agents: [], actions: [], expiresAt: null };
		const result = checkScope(scope, { agent: "any-agent", action: "llm_call" });
		expect(result.allowed).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it("allows matching agent from specific agents list", () => {
		const scope: CredentialScope = {
			agents: ["agent-1", "agent-2"],
			actions: [],
			expiresAt: null,
		};
		const result = checkScope(scope, { agent: "agent-1", action: "llm_call" });
		expect(result.allowed).toBe(true);
	});

	it("denies non-matching agent from specific agents list", () => {
		const scope: CredentialScope = {
			agents: ["agent-1", "agent-2"],
			actions: [],
			expiresAt: null,
		};
		const result = checkScope(scope, { agent: "agent-3", action: "llm_call" });
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("agent-3");
		expect(result.reason).toContain("not in the allowed agents list");
	});

	// ── Action scope ──

	it("allows all actions when actions list is empty", () => {
		const scope: CredentialScope = { agents: [], actions: [], expiresAt: null };
		const result = checkScope(scope, { agent: "any-agent", action: "shell_command" });
		expect(result.allowed).toBe(true);
	});

	it("allows matching action from specific actions list", () => {
		const scope: CredentialScope = {
			agents: [],
			actions: ["llm_call", "api_request"],
			expiresAt: null,
		};
		const result = checkScope(scope, { agent: "agent-1", action: "api_request" });
		expect(result.allowed).toBe(true);
	});

	it("denies non-matching action from specific actions list", () => {
		const scope: CredentialScope = {
			agents: [],
			actions: ["llm_call", "api_request"],
			expiresAt: null,
		};
		const result = checkScope(scope, { agent: "agent-1", action: "shell_command" });
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("shell_command");
		expect(result.reason).toContain("not in the allowed actions list");
	});

	// ── Expiry ──

	it("allows non-expired credential", () => {
		const futureDate = new Date(Date.now() + 60_000).toISOString();
		const scope: CredentialScope = { agents: [], actions: [], expiresAt: futureDate };
		const result = checkScope(scope, { agent: "agent-1", action: "llm_call" });
		expect(result.allowed).toBe(true);
	});

	it("denies expired credential with reason", () => {
		const pastDate = new Date(Date.now() - 60_000).toISOString();
		const scope: CredentialScope = { agents: [], actions: [], expiresAt: pastDate };
		const result = checkScope(scope, { agent: "agent-1", action: "llm_call" });
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("Credential expired");
	});

	it("allows credential with null expiresAt (no expiry)", () => {
		const scope: CredentialScope = { agents: [], actions: [], expiresAt: null };
		const result = checkScope(scope, { agent: "agent-1", action: "llm_call" });
		expect(result.allowed).toBe(true);
	});

	// ── Combined scope check ──

	it("checks agent + action + expiry together", () => {
		const futureDate = new Date(Date.now() + 60_000).toISOString();
		const scope: CredentialScope = {
			agents: ["agent-1"],
			actions: ["llm_call"],
			expiresAt: futureDate,
		};

		// All conditions met
		expect(checkScope(scope, { agent: "agent-1", action: "llm_call" }).allowed).toBe(true);

		// Wrong agent
		expect(checkScope(scope, { agent: "agent-2", action: "llm_call" }).allowed).toBe(false);

		// Wrong action
		expect(checkScope(scope, { agent: "agent-1", action: "shell_command" }).allowed).toBe(false);

		// Expired scope
		const expiredScope: CredentialScope = {
			agents: ["agent-1"],
			actions: ["llm_call"],
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
		};
		expect(checkScope(expiredScope, { agent: "agent-1", action: "llm_call" }).allowed).toBe(false);
	});
});
