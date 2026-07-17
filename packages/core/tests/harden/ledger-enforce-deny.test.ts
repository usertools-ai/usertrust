// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * P1-LEDGER-ENFORCE (CRITICAL) — an over-budget ledger reservation must surface
 * as an InsufficientBalanceError DENY, NOT as a LedgerUnavailableError.
 *
 * The enforcing engine rejects an over-budget pending hold; GOVERN must re-throw
 * that rejection unwrapped so the caller sees a budget deny (money never moves,
 * provider never called) — never a mislabeled "ledger outage".
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { InsufficientBalanceError, LedgerUnavailableError } from "../../src/shared/errors.js";
import type { AuditEvent } from "../../src/shared/types.js";

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
	const dir = join(tmpdir(), `harden-ledger-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeMockAudit(): AuditWriter {
	return {
		appendEvent: vi.fn(
			async (input: AppendEventInput): Promise<AuditEvent> => ({
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			}),
		),
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

describe("P1-LEDGER-ENFORCE — over-budget hold is a DENY, not an outage", () => {
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

	it("re-throws InsufficientBalanceError unwrapped and never forwards to the provider", async () => {
		// Engine rejects the first hold as over-budget, then accepts subsequent ones.
		let call = 0;
		const engine: TrustEngine = {
			spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
				call++;
				if (call === 1) {
					throw new InsufficientBalanceError("trust:hold", p.amount, 100);
				}
				return { transferId: p.transferId };
			}),
			postPendingSpend: vi.fn(async () => {}),
			voidPendingSpend: vi.fn(async () => {}),
			destroy: vi.fn(),
		};

		const createSpy = vi.fn(async () => ({
			id: "msg_1",
			usage: { input_tokens: 10, output_tokens: 5 },
		}));

		const governed = await trust(
			{ messages: { create: createSpy } },
			{
				dryRun: false,
				budget: 500_000,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: makeMockAudit(),
			},
		);

		let caught: unknown;
		try {
			await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(InsufficientBalanceError);
		expect(caught).not.toBeInstanceOf(LedgerUnavailableError);
		// Provider was never called; no settlement occurred for the denied hold.
		expect(createSpy).not.toHaveBeenCalled();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();

		// A subsequent within-budget call succeeds (proves it was a budget deny, not a fault).
		const ok = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: [{ role: "user", content: "again" }],
		});
		expect(ok.response).toBeDefined();
		expect(createSpy).toHaveBeenCalledOnce();

		await governed.destroy();
	});

	it("still maps a genuine ledger fault to LedgerUnavailableError", async () => {
		const engine: TrustEngine = {
			spendPending: vi.fn(async () => {
				throw new Error("ECONNREFUSED 127.0.0.1:3001");
			}),
			postPendingSpend: vi.fn(async () => {}),
			voidPendingSpend: vi.fn(async () => {}),
			destroy: vi.fn(),
		};
		const createSpy = vi.fn(async () => ({ id: "x" }));
		const governed = await trust(
			{ messages: { create: createSpy } },
			{
				dryRun: false,
				budget: 500_000,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: makeMockAudit(),
			},
		);

		await expect(
			governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			}),
		).rejects.toThrow(LedgerUnavailableError);
		expect(createSpy).not.toHaveBeenCalled();

		await governed.destroy();
	});
});
