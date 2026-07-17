// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * P1-CUSTOM-POLICY-REPLACES (CRITICAL) — a user policy file must NOT drop the
 * platform DEFAULT_RULES. GOVERN merges via mergePolicies(DEFAULT_RULES, loaded)
 * (safe concat) so budget enforcement survives a custom policy file, and user
 * rules are still honored.
 *
 * This is the trust() end-to-end counterpart to the mergePolicies unit test.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";

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

const VAULT_DIR = ".usertrust";

function makeTmpVault(): string {
	const dir = join(tmpdir(), `harden-merge-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeConfig(vaultBase: string, config: Record<string, unknown>): void {
	const dir = join(vaultBase, VAULT_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "usertrust.config.json"), JSON.stringify(config));
}

function writePolicy(vaultBase: string, relPath: string, rules: unknown[]): void {
	mkdirSync(join(vaultBase, relPath.replace(/\/[^/]+$/, "")), { recursive: true });
	writeFileSync(join(vaultBase, relPath), JSON.stringify({ rules }));
}

function seedSpendLedger(vaultBase: string, budgetSpent: number): void {
	const dir = join(vaultBase, VAULT_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "spend-ledger.json"),
		JSON.stringify({ budgetSpent, updatedAt: new Date().toISOString() }),
	);
}

describe("P1-CUSTOM-POLICY-REPLACES (trust end-to-end merge)", () => {
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

	it("keeps the default budget-exhausted rule even when a custom policy file exists", async () => {
		// budget_remaining === 0 → the default block-budget-exhausted rule must fire
		// despite a custom policy file that says nothing about budget.
		seedSpendLedger(tmpVault, 50_000);
		writeConfig(tmpVault, { budget: 50_000, policies: "./policies/default.yml" });
		writePolicy(tmpVault, ".usertrust/policies/default.yml", [
			{
				name: "block-foo",
				effect: "deny",
				enforcement: "hard",
				conditions: [{ field: "model", operator: "eq", value: "foo-model" }],
			},
		]);

		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{ dryRun: true, vaultBase: tmpVault },
		);

		await expect(
			governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			}),
		).rejects.toThrow(/Policy denied/);
		expect(createSpy).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("still enforces the user rule from the custom file (merge kept both)", async () => {
		writeConfig(tmpVault, { budget: 1_000_000, policies: "./policies/default.yml" });
		writePolicy(tmpVault, ".usertrust/policies/default.yml", [
			{
				name: "block-foo",
				effect: "deny",
				enforcement: "hard",
				conditions: [{ field: "model", operator: "eq", value: "foo-model" }],
			},
		]);

		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{ dryRun: true, vaultBase: tmpVault },
		);

		// User rule blocks foo-model even though budget is huge.
		await expect(
			governed.messages.create({
				model: "foo-model",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			}),
		).rejects.toThrow(/Policy denied/);
		expect(createSpy).not.toHaveBeenCalled();

		// A normal in-budget call to a different model is allowed (merge did not over-block).
		const ok = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(ok.response).toBeDefined();
		expect(createSpy).toHaveBeenCalledOnce();

		await governed.destroy();
	});
});
