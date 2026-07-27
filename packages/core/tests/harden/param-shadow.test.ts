// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * P1-PARAM-SHADOW (CRITICAL) — caller request params must NOT override trusted
 * governance context fields in `interceptCall`.
 *
 * A request that injects `tier`, `estimated_cost`, `budget_remaining`, etc. must
 * not defeat a policy rule keyed on the trusted value. The action path was fixed
 * under AUD-467; this locks the primary LLM `interceptCall` path.
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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const VAULT_DIR = ".usertrust";

function makeTmpVault(): string {
	const dir = join(tmpdir(), `harden-shadow-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeConfig(vaultBase: string, config: Record<string, unknown>): void {
	const dir = join(vaultBase, VAULT_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "usertrust.config.json"), JSON.stringify(config));
}

function writePolicy(vaultBase: string, relPath: string, rules: unknown[]): void {
	const full = join(vaultBase, relPath);
	mkdirSync(join(vaultBase, relPath.replace(/\/[^/]+$/, "")), { recursive: true });
	writeFileSync(full, JSON.stringify({ rules }));
}

describe("P1-PARAM-SHADOW (interceptCall)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
		// Trusted tier is "free"; a rule denies free-tier calls.
		writeConfig(tmpVault, {
			budget: 1_000_000,
			tier: "free",
			policies: "./policies/default.yml",
		});
		writePolicy(tmpVault, ".usertrust/policies/default.yml", [
			{
				name: "block-free-tier",
				effect: "deny",
				enforcement: "hard",
				conditions: [{ field: "tier", operator: "eq", value: "free" }],
			},
		]);
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("a caller-injected tier cannot shadow the trusted tier", async () => {
		const createSpy = vi.fn(async () => ({
			id: "x",
			usage: { input_tokens: 1, output_tokens: 1 },
		}));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{ dryRun: true, vaultBase: tmpVault },
		);

		// Inject tier:"enterprise" to try to dodge the free-tier deny rule.
		await expect(
			governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				tier: "enterprise",
				messages: [{ role: "user", content: "hi" }],
			} as Record<string, unknown>),
		).rejects.toThrow(/Policy denied/);
		// Governance bypass would have forwarded the call.
		expect(createSpy).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("the same call without injection is also denied (proves the rule fires on trusted tier)", async () => {
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
});
