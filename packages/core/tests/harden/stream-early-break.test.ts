// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * P4-STREAM-LEAK (CRITICAL) — a consumer that breaks out of the `for await`
 * early (driving generator `.return()`) must settle EXACTLY like a normal end of
 * stream: release the hold, POST the consumed cost, write the audit event, and
 * resolve `.receipt`. The pre-fix code had no `finally`, so an early break ran
 * neither callback — the hold leaked forever and destroy() blocked for 5s.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";

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
	const dir = join(tmpdir(), `harden-streambreak-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
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

function makeStreamingMock(chunks: unknown[]) {
	return {
		messages: {
			create: vi.fn(async () => {
				async function* gen() {
					for (const c of chunks) yield c;
				}
				return gen();
			}),
		},
	};
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms),
		),
	]);
}

describe("P4-STREAM-LEAK — early break settles instead of leaking", () => {
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

	it("settles the hold, posts, audits, and resolves .receipt when the consumer breaks early", async () => {
		const chunks = [
			{ type: "message_start", message: { usage: { input_tokens: 100 } } },
			{ type: "content_block_delta", delta: { text: "Hel" } },
			{ type: "content_block_delta", delta: { text: "lo" } },
			{ type: "message_delta", usage: { output_tokens: 30 } },
		];
		const engine = makeMockEngine();
		const audit = makeMockAudit();

		const governed = await trust(makeStreamingMock(chunks), {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: audit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// Read exactly ONE chunk, then break.
		let seen = 0;
		for await (const _ of result.response as AsyncIterable<unknown>) {
			seen++;
			break;
		}
		expect(seen).toBe(1);

		// Pre-fix, this never resolves (no finally → neither callback runs).
		const receipt = await withTimeout(
			(result.response as { receipt: Promise<TrustReceipt> }).receipt,
			1000,
			"stream.receipt",
		);
		expect(receipt.transferId).toMatch(/^tx_/);

		// Early break SETTLES (POST), it does not VOID.
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		// An llm_call audit event was written for the (partial) stream.
		const kinds = (audit.appendEvent as ReturnType<typeof vi.fn>).mock.calls.map(
			(c: unknown[]) => (c[0] as AppendEventInput).kind,
		);
		expect(kinds).toContain("llm_call");

		// destroy() returns promptly — the stream counter returned to zero.
		await withTimeout(governed.destroy(), 1000, "destroy");
	});
});
