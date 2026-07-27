// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * P3-AUDIT-FAILCLOSED (HIGH) — when `audit.failClosed` is true, a failed CRITICAL
 * (llm_call) audit write must ABORT the call: the hold is voided, no POST/commit
 * happens, and the caller sees an AuditDegradedError. Default (fail-open) behavior
 * is preserved: the call resolves with a degraded receipt.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { AuditDegradedError } from "../../src/shared/errors.js";
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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const VAULT_DIR = ".usertrust";

function makeTmpVault(): string {
	const dir = join(tmpdir(), `harden-failclosed-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeConfig(vaultBase: string, config: Record<string, unknown>): void {
	const dir = join(vaultBase, VAULT_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "usertrust.config.json"), JSON.stringify(config));
}

function makeMockEngine(): TrustEngine {
	return {
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => ({
			transferId: p.transferId,
		})),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

/** Audit writer that throws for the critical `llm_call` kind and degrades after. */
function makeLlmCallFailingAudit(): AuditWriter {
	let degraded = false;
	return {
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			if (input.kind === "llm_call") {
				degraded = true;
				throw new Error("Audit disk full");
			}
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		}),
		getWriteFailures: vi.fn(() => (degraded ? 1 : 0)),
		isDegraded: vi.fn(() => degraded),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

describe("P3-AUDIT-FAILCLOSED", () => {
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

	it("fail-closed: a failed llm_call audit aborts the call — no POST, hold voided", async () => {
		writeConfig(tmpVault, { budget: 500_000, audit: { failClosed: true } });
		const engine = makeMockEngine();
		const audit = makeLlmCallFailingAudit();

		const governed = await trust(
			{
				messages: {
					create: vi.fn(async () => ({ id: "m", usage: { input_tokens: 10, output_tokens: 5 } })),
				},
			},
			{ dryRun: false, vaultBase: tmpVault, _engine: engine, _audit: audit },
		);

		await expect(
			governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			}),
		).rejects.toBeInstanceOf(AuditDegradedError);

		// Hold was placed then VOIDed; the spend was never POSTed/committed.
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();

		await governed.destroy();
	});

	it("fail-open (default): the call resolves with a degraded receipt (backward compat)", async () => {
		// No failClosed → default false.
		writeConfig(tmpVault, { budget: 500_000 });
		const engine = makeMockEngine();
		const audit = makeLlmCallFailingAudit();

		const governed = await trust(
			{
				messages: {
					create: vi.fn(async () => ({ id: "m", usage: { input_tokens: 10, output_tokens: 5 } })),
				},
			},
			{ dryRun: false, vaultBase: tmpVault, _engine: engine, _audit: audit },
		);

		const r = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: [{ role: "user", content: "hi" }],
		});

		expect(r.receipt.auditDegraded).toBe(true);
		expect(r.receipt.auditHash).toBe("AUDIT_DEGRADED");
		// Fail-open still settles: POST happened, no void.
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});
});
