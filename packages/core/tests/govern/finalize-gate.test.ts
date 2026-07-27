// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A2 — one idempotent finalize gate per hold (settle XOR void). This covers the
 * post-commit failure path: once a non-stream call has CLAIMED settle and posted
 * the spend, a later throw (the fail-closed belt-and-suspenders check) must route
 * to the outer catch WITHOUT issuing a void against the already-posted transfer.
 * The complementary pre-commit void path (throw before the settle claim → void is
 * granted) is covered by tests/harden/audit-fail-closed.test.ts.
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
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const VAULT_DIR = ".usertrust";

function makeTmpVault(): string {
	const dir = join(tmpdir(), `finalize-gate-${randomUUID()}`);
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

/**
 * Audit writer that SUCCEEDS on every append (so the critical llm_call event is
 * written and settle is claimed) but reports the writer as degraded — tripping
 * the fail-closed belt-and-suspenders check AFTER the spend has been committed.
 */
function makeDegradedButWritingAudit(): AuditWriter {
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
		getWriteFailures: vi.fn(() => 1),
		isDegraded: vi.fn(() => true),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

describe("A2 finalize gate — post-commit throw does not double-void", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("settle claimed → belt fail-closed throw → posts once, never voids", async () => {
		writeConfig(tmpVault, { budget: 500_000, audit: { failClosed: true } });
		const engine = makeMockEngine();
		const audit = makeDegradedButWritingAudit();

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

		// The llm_call audit SUCCEEDED, so settle was claimed and the spend POSTed
		// exactly once. The belt check then threw — but the outer catch must NOT void
		// an already-settled hold (A2: settle XOR void).
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});
});
