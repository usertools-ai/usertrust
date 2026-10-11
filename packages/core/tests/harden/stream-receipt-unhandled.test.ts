// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A governed stream that fails mid-iteration must never end the process with an
 * unhandled `.receipt` rejection.
 *
 * The documented pattern catches the iteration error and need not await
 * `response.receipt`. When a stream was cut, or the provider sent an error event,
 * `.receipt` rejected too, nobody had attached a handler, and Node ended the process
 * with exit code 1. Each crash row therefore runs a CUSTOMER process
 * (fixtures/stream-fault-child.ts: a real SDK against a local SSE server), because an
 * unhandled rejection ends a process, which an in-process test cannot observe.
 *
 * The in-process rows pin what the failure does to the ledger: the hold is voided
 * exactly once, never posted, and the partial delivery is audited.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
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

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const TSX = join(repoRoot, "node_modules", ".bin", "tsx");
const CHILD = join(import.meta.dirname, "..", "fixtures", "stream-fault-child.ts");
const CORE = join(repoRoot, "packages", "core", "src", "index.ts");

interface ChildOutcome {
	outerReceiptSettled?: boolean;
	iteration?: "ended" | "threw";
	iterationError?: string;
	receipt?: "resolved" | "rejected";
	receiptSettled?: boolean;
	receiptError?: string;
	receiptIsIterationError?: boolean;
}

function runCustomer(
	surface: string,
	fault: string,
	caller: "docs" | "receipt",
): { code: number | null; stderr: string; outcome: ChildOutcome | null } {
	const r = spawnSync(TSX, [CHILD, CORE, surface, fault, caller], {
		encoding: "utf-8",
		timeout: 60_000,
	});
	const line = r.stdout.trim().split("\n").at(-1) ?? "";
	let outcome: ChildOutcome | null = null;
	try {
		outcome = JSON.parse(line) as ChildOutcome;
	} catch {
		// a crashed process printed no outcome
	}
	return { code: r.status, stderr: r.stderr, outcome };
}

/**
 * The faults that make each surface's ITERATION throw. A Responses stream's mid-stream
 * error event does not: the OpenAI SDK yields it as an ordinary event (its type is
 * "error"), so it has a row of its own below.
 */
const THROWING_FAULTS = {
	anthropic: ["cut", "error"],
	openai: ["cut", "error"],
	"openai-responses": ["cut"],
} as const;

describe("a stream that fails mid-way never crashes the caller's process", () => {
	for (const surface of ["anthropic", "openai", "openai-responses"] as const) {
		for (const fault of THROWING_FAULTS[surface]) {
			it(`${surface}, ${fault}: the docs pattern (catch the iteration, never await .receipt) exits 0`, () => {
				const { code, stderr, outcome } = runCustomer(surface, fault, "docs");
				// Node's crash report ends with its version banner; a clean exit prints none.
				expect(stderr, stderr).not.toMatch(/Node\.js v\d+/);
				expect(code, stderr).toBe(0);
				expect(outcome?.iteration).toBe("threw");
			}, 60_000);

			it(`${surface}, ${fault}: a caller that awaits .receipt gets the iteration's own error`, () => {
				const { code, stderr, outcome } = runCustomer(surface, fault, "receipt");
				expect(code, stderr).toBe(0);
				expect(outcome?.iteration).toBe("threw");
				expect(outcome?.receipt).toBe("rejected");
				expect(outcome?.receiptIsIterationError).toBe(true);
			}, 60_000);
		}

		it(`${surface}, control: a clean stream ends, and .receipt resolves settled`, () => {
			const { code, stderr, outcome } = runCustomer(surface, "ok", "receipt");
			expect(code, stderr).toBe(0);
			expect(outcome).toEqual({
				outerReceiptSettled: false,
				iteration: "ended",
				receipt: "resolved",
				receiptSettled: true,
			});
		}, 60_000);
	}

	it("openai-responses, error event: the SDK yields it, so nothing throws and nothing crashes", () => {
		const docs = runCustomer("openai-responses", "error", "docs");
		expect(docs.stderr, docs.stderr).not.toMatch(/Node\.js v\d+/);
		expect(docs.code, docs.stderr).toBe(0);
		expect(docs.outcome?.iteration).toBe("ended");
		// Today the stream simply ends, so it settles like any stream that ends: the error
		// event carries no usage, so at the estimate. Pinned as current behaviour, not as
		// a ruling on whether a failed Responses stream should be charged.
		const awaited = runCustomer("openai-responses", "error", "receipt");
		expect(awaited.code, awaited.stderr).toBe(0);
		expect(awaited.outcome?.receipt).toBe("resolved");
		expect(awaited.outcome?.receiptSettled).toBe(true);
	}, 60_000);

	it("anthropic messages.stream(), cut: the docs pattern exits 0", () => {
		const { code, stderr, outcome } = runCustomer("anthropic-helper", "cut", "docs");
		expect(code, stderr).toBe(0);
		expect(outcome?.iteration).toBe("threw");
	}, 60_000);
});

// ── The ledger, in process ──

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

/** An Anthropic-shaped client whose stream delivers two events, then fails with `error`. */
function failingStreamClient(error: Error) {
	return {
		messages: {
			create: vi.fn(async (_params: unknown) => {
				async function* gen() {
					yield { type: "message_start", message: { usage: { input_tokens: 100 } } };
					yield { type: "content_block_delta", delta: { text: "Hel" } };
					throw error;
				}
				return gen();
			}),
		},
	};
}

describe("a stream that fails mid-way voids its hold exactly once", () => {
	let vaultBase: string;
	beforeEach(() => {
		vaultBase = join(tmpdir(), `stream-receipt-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
	});
	afterEach(() => {
		rmSync(vaultBase, { recursive: true, force: true });
	});

	for (const [label, error] of [
		["a cut connection", new TypeError("terminated")],
		["a provider error event", new Error("Internal server error")],
	] as const) {
		it(`${label}: voided once, never posted, audited, and .receipt rejects with it`, async () => {
			const engine = makeMockEngine();
			const audit = makeMockAudit();
			const governed = await trust(failingStreamClient(error), {
				dryRun: false,
				budget: 50_000,
				vaultBase,
				_engine: engine,
				_audit: audit,
			});
			const { response } = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "Hello" }],
				stream: true,
			});
			const stream = response as AsyncIterable<unknown> & { receipt: Promise<unknown> };

			// The docs pattern: catch the iteration, do not await .receipt yet.
			let caught: unknown;
			try {
				for await (const _ of stream) {
					// consume
				}
			} catch (err) {
				caught = err;
			}
			expect(caught).toBe(error);
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(engine.voidPendingSpend).toHaveBeenCalledTimes(1);
			expect(engine.postPendingSpend).not.toHaveBeenCalled();
			const partial = vi
				.mocked(audit.appendEvent)
				.mock.calls.filter(([e]) => e.kind === "stream_partial_delivery");
			expect(partial).toHaveLength(1);
			expect(partial[0]?.[0].data).toMatchObject({ chunksDelivered: 2, partialInputTokens: 100 });

			// A caller who awaits .receipt later still sees the failure, as the same error.
			await expect(stream.receipt).rejects.toBe(error);
			expect(engine.voidPendingSpend).toHaveBeenCalledTimes(1);

			await governed.destroy();
		});
	}
});
