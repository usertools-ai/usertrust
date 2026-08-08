// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Denial events, written by the SHIPPED writer into a REAL vault, and read back
 * by every consumer that must not regress:
 *
 * - the chain still verifies VALID, in core AND in the zero-dep verifier;
 * - `usertrust health`'s entropy detector COUNTS the denials — that is what the
 *   `decision: "deny"` field is load-bearing for;
 * - `verifyTransaction()` renders DENIED, not a false PENDING receipt: it
 *   selects by `transferId`, and a denial event carries one;
 * - the seeded plaintext never reaches `events.jsonl` or `dead-letters.jsonl`.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyVault as pkgVerifyVault, verifyTransaction } from "../../../verify/src/index.js";
import { computeEntropyScore } from "../../src/audit/entropy.js";
import { readLedgerEvents } from "../../src/audit/read.js";
import { verifyVault as coreVerifyVault } from "../../src/audit/verify.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { InsufficientBalanceError } from "../../src/shared/errors.js";

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
const SSN = "123-45-6789";
const PROMPT_MARKER = "SENTINEL-PROMPT-MARKER-9f3a";

describe("denial events — downstream consumers, on a real vault", () => {
	let vault: string;
	beforeEach(() => {
		vault = join(tmpdir(), `harden-denial-down-${randomUUID()}`);
		mkdirSync(join(vault, VAULT_DIR, "policies"), { recursive: true });
		writeFileSync(
			join(vault, VAULT_DIR, "usertrust.config.json"),
			JSON.stringify({
				budget: 1_000_000,
				pii: "block",
				policies: "./policies/deny.json",
			}),
		);
		writeFileSync(
			join(vault, VAULT_DIR, "policies", "deny.json"),
			JSON.stringify({
				rules: [
					{
						id: "no-frontier",
						name: "No frontier models",
						effect: "deny",
						enforcement: "hard",
						conditions: [{ field: "model", operator: "eq", value: "forbidden-model" }],
					},
				],
			}),
		);
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	it("appends a verifiable chain, counts as entropy, and leaks no plaintext", async () => {
		const rejecting: TrustEngine = {
			spendPending: vi.fn(async (p: { amount: number }) => {
				throw new InsufficientBalanceError("trust:hold", p.amount, 1);
			}),
			postPendingSpend: vi.fn(async () => {}),
			voidPendingSpend: vi.fn(async () => {}),
			destroy: vi.fn(),
		};
		const governed = await trust(
			{ messages: { create: vi.fn(async () => ({ id: "x" })) } },
			{ dryRun: false, vaultBase: vault, _engine: rejecting },
		);

		// policy_denied (policy class)
		await governed.messages
			.create({
				model: "forbidden-model",
				max_tokens: 64,
				messages: [{ role: "user", content: PROMPT_MARKER }],
			})
			.catch(() => {});
		// policy_denied (pii class) — the seeded SSN must never reach disk
		await governed.messages
			.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: `${PROMPT_MARKER} ssn ${SSN}` }],
			})
			.catch(() => {});
		// ledger_rejected
		let rejectedTx = "";
		await governed.messages
			.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "plain" }],
			})
			.catch((e: InsufficientBalanceError) => {
				expect(e).toBeInstanceOf(InsufficientBalanceError);
				expect(e.auditEventHash).toBeDefined();
			});
		await governed.destroy();

		// ── The chain is intact, in BOTH verifiers ──
		const vaultDir = join(vault, VAULT_DIR);
		expect(coreVerifyVault(vaultDir).valid).toBe(true);
		expect(pkgVerifyVault(vaultDir).valid).toBe(true);

		// ── The events are there, with the right kinds ──
		const events = readLedgerEvents(vaultDir);
		const denials = events.filter(
			(e) => e.kind === "policy_denied" || e.kind === "ledger_rejected",
		);
		expect(denials.map((e) => e.kind)).toEqual([
			"policy_denied",
			"policy_denied",
			"ledger_rejected",
		]);
		rejectedTx = String(denials[2]?.data.transferId);
		expect(rejectedTx).toMatch(/^tx_/);

		// ── Entropy counts BOTH kinds ──
		const report = computeEntropyScore(events.map((e) => ({ kind: e.kind, data: e.data })));
		const policySignal = report.signals.find((s) => s.condition === "policy_violations");
		expect(policySignal?.hits).toBe(3);

		// ── verifyTransaction renders DENIED, not a false PENDING ──
		const result = verifyTransaction(vaultDir, rejectedTx);
		expect(result.found).toBe(true);
		expect(result.receipt).toContain("DENIED");
		expect(result.receipt).not.toContain("PENDING");

		// ── Sentinel: no plaintext on disk, in the chain OR the DLQ ──
		const raw = readFileSync(join(vaultDir, "audit", "events.jsonl"), "utf-8");
		expect(raw).toContain("policy_denied");
		expect(raw).not.toContain(SSN);
		expect(raw).not.toContain(PROMPT_MARKER);
		const dlqPath = join(vaultDir, "dlq", "dead-letters.jsonl");
		if (existsSync(dlqPath)) {
			const dlq = readFileSync(dlqPath, "utf-8");
			expect(dlq).not.toContain(SSN);
			expect(dlq).not.toContain(PROMPT_MARKER);
		}
	});
});
