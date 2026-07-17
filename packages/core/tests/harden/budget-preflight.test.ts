// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * P1-BUDGET-PREFLIGHT — a single call must not overshoot the budget cap.
 *
 * The default `block-budget-overshoot` rule (POLICY) fires on the derived
 * `budget_remaining_after` field (GOVERN-supplied). A single call whose ESTIMATE
 * exceeds the remaining budget must be denied BEFORE it is forwarded, even when
 * `budget_remaining` is still positive.
 *
 * Would-pass-if-broken guard: the control assertions prove the guard is
 * cost-driven (a fits-in-budget call resolves), not a blanket deny.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";
import { PolicyDeniedError } from "../../src/shared/errors.js";

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
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

function makeTmpVault(): string {
	const dir = join(tmpdir(), `harden-preflight-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeAnthropicMock(createSpy: ReturnType<typeof vi.fn>) {
	return { messages: { create: createSpy } };
}

describe("P1-BUDGET-PREFLIGHT (trust end-to-end)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("denies a single call whose estimate overshoots the remaining budget", async () => {
		// opus output rate 250/1k → 4096 max_tokens estimates ≥ 1024 usertokens ≫ 100.
		const createSpy = vi.fn(async () => ({
			id: "msg_1",
			model: "claude-opus-4-6",
			usage: { input_tokens: 10, output_tokens: 5 },
		}));
		const governed = await trust(makeAnthropicMock(createSpy), {
			dryRun: true,
			budget: 100,
			vaultBase: tmpVault,
		});

		await expect(
			governed.messages.create({
				model: "claude-opus-4-6",
				max_tokens: 4096,
				messages: [{ role: "user", content: "hi" }],
			}),
		).rejects.toThrow(/Policy denied/);
		// The overshooting call was NEVER forwarded to the provider.
		expect(createSpy).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("allows a call fully covered by a large budget and never drifts negative", async () => {
		const createSpy = vi.fn(async () => ({
			id: "msg_ok",
			model: "claude-opus-4-6",
			usage: { input_tokens: 10, output_tokens: 5 },
		}));
		const governed = await trust(makeAnthropicMock(createSpy), {
			dryRun: true,
			budget: 500_000,
			vaultBase: tmpVault,
		});

		const r1 = await governed.messages.create({
			model: "claude-opus-4-6",
			max_tokens: 4096,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(r1.response).toBeDefined();
		expect(r1.receipt.budgetRemaining).toBeGreaterThanOrEqual(0);

		// A within-budget follow-up still has a non-negative remaining (no overshoot leak).
		const r2 = await governed.messages.create({
			model: "claude-opus-4-6",
			max_tokens: 4096,
			messages: [{ role: "user", content: "again" }],
		});
		expect(r2.receipt.budgetRemaining).toBeGreaterThanOrEqual(0);

		await governed.destroy();
	});

	it("denies overshoot even when the caller injects an inflated budget_remaining", async () => {
		// Belt-and-suspenders with P1-PARAM-SHADOW: the derived budget_remaining_after
		// is recomputed from trusted state and cannot be shadowed.
		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(makeAnthropicMock(createSpy), {
			dryRun: true,
			budget: 100,
			vaultBase: tmpVault,
		});

		await expect(
			governed.messages.create({
				model: "claude-opus-4-6",
				max_tokens: 4096,
				budget_remaining: 1e9,
				budget_remaining_after: 1e9,
				messages: [{ role: "user", content: "hi" }],
			} as Record<string, unknown>),
		).rejects.toThrow(PolicyDeniedError);
		expect(createSpy).not.toHaveBeenCalled();

		await governed.destroy();
	});
});
