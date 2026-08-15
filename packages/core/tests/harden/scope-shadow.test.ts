// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * AUD-002 — caller-supplied `scope` must not satisfy a `scopePatterns` rule.
 *
 * `ruleMatches` requires a non-empty `context.scope` for any rule carrying
 * `scopePatterns`. Before this ship nothing in `src/` set that field, so the
 * docs' flagship production-only opus deny never fired — unless a remote
 * tenant volunteered `params.params.scope` on the headless HTTP authorize
 * path. Host-owned `TrustOpts.scope` / `TrustConfig.scope` is now the only
 * input: sanitize strips the caller value, and all three evaluatePolicy
 * sites re-assert the operator's value (including `undefined` when they
 * declared none).
 *
 * Three properties, at all three sites:
 *
 *  - Caller-supplied `scope` does NOT satisfy a scoped hard deny.
 *  - Operator `scope: ["production/api"]` DOES deny when other conditions
 *    match.
 *  - Operator unset + scoped rule → the rule does not match (allow).
 *
 * SECURITY (mirrors clock-shadow.test.ts): never log or snapshot a whole
 * PolicyContext — it carries request-shaped data. Assert on individual
 * fields.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { evaluatePolicy, type PolicyContext } from "../../src/policy/gate.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

vi.mock("../../src/policy/gate.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/policy/gate.js")>();
	return { ...actual, evaluatePolicy: vi.fn(actual.evaluatePolicy) };
});

const VAULT_DIR = ".usertrust";
const POLICY_REL = "policies/default.yml";

/** A hard deny gated only by scopePatterns — `tier` is re-asserted everywhere. */
const PROD_ONLY = {
	id: "prod-only",
	name: "prod-only",
	effect: "deny",
	enforcement: "hard",
	scopePatterns: ["production/*"],
	conditions: [{ field: "tier", operator: "exists" }],
};

function makeTmpVault(rules: unknown[]): string {
	const base = join(tmpdir(), `harden-scope-${randomUUID()}`);
	const dir = join(base, VAULT_DIR);
	mkdirSync(join(dir, "policies"), { recursive: true });
	writeFileSync(
		join(dir, "usertrust.config.json"),
		JSON.stringify({ budget: 1_000_000, tier: "pro", policies: `./${POLICY_REL}` }),
	);
	writeFileSync(join(dir, POLICY_REL), JSON.stringify({ rules }));
	return base;
}

function lastPolicyContext(): PolicyContext {
	const calls = vi.mocked(evaluatePolicy).mock.calls;
	const last = calls[calls.length - 1];
	if (last === undefined) throw new Error("the policy evaluator was never called");
	return last[1];
}

const PARAMS = {
	model: "claude-opus-4-6",
	max_tokens: 64,
	messages: [{ role: "user", content: "hi" }],
};

const CALLER_SCOPE = { scope: ["production/api"] };

const vaults: string[] = [];
function vault(rules: unknown[]): string {
	const base = makeTmpVault(rules);
	vaults.push(base);
	return base;
}

beforeEach(() => {
	vi.mocked(evaluatePolicy).mockClear();
});

afterEach(() => {
	for (const base of vaults.splice(0)) {
		try {
			rmSync(base, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

// ---------------------------------------------------------------------------
// Site 1 — govern.ts's LLM path (interceptCall)
// ---------------------------------------------------------------------------

describe("LLM path (trust()) — request-body scope forgery", () => {
	it("a caller-supplied scope does not satisfy a scopePatterns hard deny", async () => {
		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{ dryRun: true, vaultBase: vault([PROD_ONLY]) },
		);

		await expect(
			governed.messages.create({ ...PARAMS, ...CALLER_SCOPE } as Record<string, unknown>),
		).resolves.toBeDefined();
		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(lastPolicyContext().scope).toBeUndefined();

		await governed.destroy();
	});

	it("operator scope matching production/* denies when other conditions match", async () => {
		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{ dryRun: true, vaultBase: vault([PROD_ONLY]), scope: ["production/api"] },
		);

		await expect(
			governed.messages.create({ ...PARAMS } as Record<string, unknown>),
		).rejects.toThrow(/\[prod-only\]/);
		expect(createSpy).not.toHaveBeenCalled();
		expect(lastPolicyContext().scope).toEqual(["production/api"]);

		await governed.destroy();
	});

	it("operator unset scope leaves a scoped rule unmatched", async () => {
		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{ dryRun: true, vaultBase: vault([PROD_ONLY]) },
		);

		await expect(
			governed.messages.create({ ...PARAMS } as Record<string, unknown>),
		).resolves.toBeDefined();
		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(lastPolicyContext().scope).toBeUndefined();

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// Site 2 — govern.ts's governAction
// ---------------------------------------------------------------------------

describe("governAction — action.params scope forgery", () => {
	const ACTION = { kind: "tool_use" as const, name: "search", cost: 25 };

	it("action.params.scope does not satisfy a scopePatterns hard deny", async () => {
		const governed = await trust(
			{ messages: { create: vi.fn() } },
			{ dryRun: true, vaultBase: vault([PROD_ONLY]) },
		);
		const run = vi.fn(async () => "ok");

		await expect(
			governed.governAction({ ...ACTION, params: CALLER_SCOPE }, run),
		).resolves.toBeDefined();
		expect(run).toHaveBeenCalled();
		expect(lastPolicyContext().scope).toBeUndefined();

		await governed.destroy();
	});

	it("operator scope matching production/* denies an action when other conditions match", async () => {
		const governed = await trust(
			{ messages: { create: vi.fn() } },
			{ dryRun: true, vaultBase: vault([PROD_ONLY]), scope: ["production/api"] },
		);
		const run = vi.fn(async () => "ok");

		await expect(governed.governAction({ ...ACTION, params: {} }, run)).rejects.toThrow(
			/\[prod-only\]/,
		);
		expect(run).not.toHaveBeenCalled();
		expect(lastPolicyContext().scope).toEqual(["production/api"]);

		await governed.destroy();
	});

	it("operator unset scope leaves a scoped action rule unmatched", async () => {
		const governed = await trust(
			{ messages: { create: vi.fn() } },
			{ dryRun: true, vaultBase: vault([PROD_ONLY]) },
		);
		const run = vi.fn(async () => "ok");

		await expect(governed.governAction({ ...ACTION, params: {} }, run)).resolves.toBeDefined();
		expect(run).toHaveBeenCalled();
		expect(lastPolicyContext().scope).toBeUndefined();

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// Site 3 — headless.ts's authorize (widest blast radius: HTTP body)
// ---------------------------------------------------------------------------

describe("headless authorize — params.params scope forgery", () => {
	const AUTHORIZE = { model: "claude-opus-4-6", estimatedInputTokens: 100, maxOutputTokens: 500 };

	it("params.params.scope does not satisfy a scopePatterns hard deny", async () => {
		const gov = await createGovernor({ dryRun: true, vaultBase: vault([PROD_ONLY]) });

		const auth = await gov.authorize({ ...AUTHORIZE, params: CALLER_SCOPE });
		expect(auth.transferId).toEqual(expect.any(String));
		expect(lastPolicyContext().scope).toBeUndefined();

		await gov.destroy();
	});

	it("operator scope matching production/* denies authorize when other conditions match", async () => {
		const gov = await createGovernor({
			dryRun: true,
			vaultBase: vault([PROD_ONLY]),
			scope: ["production/api"],
		});

		await expect(gov.authorize({ ...AUTHORIZE })).rejects.toThrow(/\[prod-only\]/);
		expect(lastPolicyContext().scope).toEqual(["production/api"]);

		await gov.destroy();
	});

	it("operator unset scope leaves a scoped authorize rule unmatched", async () => {
		const gov = await createGovernor({ dryRun: true, vaultBase: vault([PROD_ONLY]) });

		const auth = await gov.authorize({ ...AUTHORIZE });
		expect(auth.transferId).toEqual(expect.any(String));
		expect(lastPolicyContext().scope).toBeUndefined();

		await gov.destroy();
	});
});
