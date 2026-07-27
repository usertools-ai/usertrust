// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HEADLESS harden — Finding 1 + Finding 3
 *
 * Finding 1: with NO policies file on disk, createGovernor() must still enforce
 * the platform DEFAULT_RULES budget gate (parity with trust()). Before the fix
 * headless set policyRules = [], so evaluatePolicy always returned allow and
 * authorize() granted unbounded spend.
 *
 * Reconciled behavior (RECON #1/#2): DEFAULT_RULES are ALWAYS merged
 * (mergePolicies), and the derived `budget_remaining_after` field is injected by
 * the governor, so the `block-budget-overshoot` HARD rule denies a single call
 * that would drive remaining budget below zero — PRE-spend.
 *
 * Finding 3: caller-supplied `params` must not be able to shadow the trusted
 * governance fields (budget_remaining / budget_remaining_after / tier /
 * estimated_cost) — the governor spreads caller params FIRST, then overwrites
 * with trusted values.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Mock tigerbeetle-node (native module, never loaded in tests)
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: {
		linked: 1,
		pending: 2,
		post_pending_transfer: 4,
		void_pending_transfer: 8,
	},
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

import { createGovernor } from "../../src/headless.js";
import { PolicyDeniedError } from "../../src/shared/errors.js";

let vaultBase: string;

beforeEach(() => {
	vaultBase = join(tmpdir(), `headless-harden-gate-${randomUUID()}`);
	mkdirSync(vaultBase, { recursive: true });
});

afterEach(() => {
	try {
		rmSync(vaultBase, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

it("enforces the default budget gate with NO policies file (parity with trust())", async () => {
	// No policies file written to vaultBase — the no-file path is exactly the hole.
	const gov = await createGovernor({ dryRun: true, budget: 1, vaultBase });

	// A single normal call costs far more than the 1-usertoken budget, so
	// budget_remaining_after < 0 and block-budget-overshoot (HARD) must DENY it.
	await expect(
		gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		}),
	).rejects.toThrow(PolicyDeniedError);

	await expect(
		gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		}),
	).rejects.toThrow(/budget|block-budget/i);

	await gov.destroy();
});

it("denies once the ledger is driven non-positive, with NO policies file", async () => {
	// The first call reserves a trivial estimate (allowed: budget_remaining_after
	// == 0, not < 0), but SETTLES far above the tiny budget, driving remaining
	// non-positive. The SECOND call must then trip block-budget-exhausted
	// (budget_remaining <= 0) even though no policies file exists.
	const gov = await createGovernor({ dryRun: true, budget: 1, vaultBase });

	const auth1 = await gov.authorize({
		model: "claude-sonnet-4-6",
		estimatedInputTokens: 1,
		maxOutputTokens: 1,
	});
	await gov.settle(auth1, { inputTokens: 5000, outputTokens: 5000 });

	// Remaining budget is now <= 0 (actual settle cost far exceeded the budget).
	expect(gov.budgetRemaining()).toBeLessThanOrEqual(0);

	await expect(
		gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 1,
			maxOutputTokens: 1,
		}),
	).rejects.toThrow(/budget|block-budget/i);

	await gov.destroy();
});

it("allows calls while budget remains, with no policies file (no false-positive denial)", async () => {
	const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
	const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 100 });
	const receipt = await gov.settle(auth);
	expect(receipt.settled).toBe(true);
	await gov.destroy();
});

it("caller params cannot shadow budget_remaining_after to bypass the gate", async () => {
	const gov = await createGovernor({ dryRun: true, budget: 1, vaultBase });

	// Attempted injection: a caller trying to fake a healthy remaining balance.
	// Governance fields are written AFTER the spread, so the trusted (negative)
	// budget_remaining_after wins and the overshoot rule still denies.
	await expect(
		gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
			params: {
				budget_remaining_after: 10_000_000,
				budget_remaining: 10_000_000,
				estimated_cost: 0,
			},
		}),
	).rejects.toThrow(/budget|block-budget/i);

	await gov.destroy();
});
