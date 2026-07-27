// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HEADLESS harden — Finding 2
 *
 * Spend-ledger persistence must be monotonic and atomic-per-writer so a stale or
 * concurrent writer can never regress the on-disk cumulative spend to a lower
 * value. A regressed total is silently under-counted on restart → overspend.
 *
 * Reconciled fix (RECON #4, mirroring govern.ts): persistSpendLedger writes to a
 * UNIQUE tmp path (`spend-ledger.json.<pid>.<uuid>.tmp`) and refuses to write a
 * value lower than the total already on disk (monotonic guard reads the current
 * on-disk total before committing). The governor persists the LIVE cumulative
 * budgetSpent (not a stale snapshot), so concurrent settles converge on the max.
 *
 * The primary adversarial check is the monotonic guard: a lower persist that
 * races/lags behind a higher on-disk total must be dropped, not applied. We
 * simulate a writer that got ahead (another process / a prior run) by putting a
 * higher total on disk, then drive this governor's lower persist and assert the
 * on-disk total never regresses.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { VAULT_DIR } from "../../src/shared/constants.js";

let vaultBase: string;

function ledgerPath(): string {
	return join(vaultBase, VAULT_DIR, "spend-ledger.json");
}

beforeEach(() => {
	vaultBase = join(tmpdir(), `headless-persist-race-${randomUUID()}`);
	mkdirSync(join(vaultBase, VAULT_DIR), { recursive: true });
});

afterEach(() => {
	try {
		rmSync(vaultBase, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

it("never regresses the on-disk cumulative spend below a higher persisted total", async () => {
	const gov = await createGovernor({ dryRun: true, budget: 1_000_000, vaultBase });

	// First settle records a small cumulative spend on disk.
	const a1 = await gov.authorize({
		model: "claude-sonnet-4-6",
		estimatedInputTokens: 100,
		maxOutputTokens: 500,
	});
	await gov.settle(a1, { inputTokens: 100, outputTokens: 500 });
	const firstOnDisk = JSON.parse(readFileSync(ledgerPath(), "utf-8")).budgetSpent as number;
	expect(firstOnDisk).toBeGreaterThan(0);

	// Simulate another writer (a second process, or a prior run) that got ahead
	// and recorded a much higher cumulative total on disk.
	const higher = 500_000;
	expect(higher).toBeGreaterThan(firstOnDisk);
	writeFileSync(
		ledgerPath(),
		JSON.stringify({ budgetSpent: higher, updatedAt: new Date().toISOString() }),
		"utf-8",
	);

	// This governor's LIVE cumulative spend is still tiny; a second settle persists
	// a value far below `higher`. The monotonic guard must DROP that write so the
	// on-disk total never regresses.
	const a2 = await gov.authorize({
		model: "claude-sonnet-4-6",
		estimatedInputTokens: 100,
		maxOutputTokens: 500,
	});
	await gov.settle(a2, { inputTokens: 100, outputTokens: 500 });

	const afterOnDisk = JSON.parse(readFileSync(ledgerPath(), "utf-8")).budgetSpent as number;
	expect(afterOnDisk).toBe(higher);

	await gov.destroy();
});

it("does not leave a fixed shared tmp file and keeps the ledger valid under concurrent settles", async () => {
	const gov = await createGovernor({ dryRun: true, budget: 10_000_000, vaultBase });

	// Fire a batch of concurrent settles racing the persist path.
	const auths = await Promise.all(
		Array.from({ length: 12 }, (_, i) =>
			gov.authorize({
				model: "claude-sonnet-4-6",
				estimatedInputTokens: 100 + i * 25,
				maxOutputTokens: 400 + i * 50,
			}),
		),
	);
	await Promise.all(auths.map((a) => gov.settle(a, { inputTokens: 120, outputTokens: 300 })));

	// The ledger must be valid JSON and equal the final in-memory cumulative spend.
	const onDisk = JSON.parse(readFileSync(ledgerPath(), "utf-8")).budgetSpent as number;
	const expectedSpent = gov.config.budget - gov.budgetRemaining();
	expect(onDisk).toBe(expectedSpent);

	// No fixed shared staging file must survive (unique-tmp isolates each writer).
	expect(existsSync(join(vaultBase, VAULT_DIR, "spend-ledger.json.tmp"))).toBe(false);
	const leftoverTmp = readdirSync(join(vaultBase, VAULT_DIR)).filter(
		(f) => f.startsWith("spend-ledger.json.") && f.endsWith(".tmp"),
	);
	expect(leftoverTmp).toEqual([]);

	await gov.destroy();
});
