// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Spec D4, headless mirror of `tests/govern/settle-shortfall.test.ts` — the
 * headless governor reports a TRUNCATED settlement instead of hiding it.
 *
 * TigerBeetle rejects (never caps) a post above the pending transfer, so the
 * engine caps the settle at the reserved hold and hands the truncation back as
 * `{ posted, shortfall }`. What that costs the caller is visibility: the
 * ledger moved less money than the call actually consumed. This file pins
 * where that gap surfaces on `createGovernor()`'s explicit authorize/settle
 * lifecycle — same event/receipt names as `trust()` (Task 4), same contract.
 *
 *  - `receipt.cost` stays the TRUE metered cost. `receipt.postedCost` carries
 *    the ledger side, and ONLY when the two differ.
 *  - One `settlement_shortfall` event per truncated settle.
 *  - The event is advisory: an audit chain that cannot take it degrades the
 *    receipt (`auditDegraded: true`) and NEVER unwinds a settlement that
 *    committed.
 *  - An injected engine whose `postPendingSpend` resolves `void` is
 *    posted-in-full.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import { createGovernor, type Governor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { AuditEvent } from "../../src/shared/types.js";

// tigerbeetle-node is a native module and is never loaded in unit tests.
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

// ── Fixtures ──

const AUTHORIZE = {
	model: "claude-sonnet-4-6",
	estimatedInputTokens: 100,
	maxOutputTokens: 500,
};

/** What the capped engine claims to have posted; deliberately not the metered cost. */
const POSTED = 78;
const SHORTFALL = 6;

interface EngineHandle extends TrustEngine {
	spendPending: ReturnType<typeof vi.fn>;
	postPendingSpend: ReturnType<typeof vi.fn>;
	voidPendingSpend: ReturnType<typeof vi.fn>;
}

/**
 * `post` is the whole point of this harness: it is the Task 3 return shape the
 * governor has to read. `undefined` (the default) models the injected engine
 * that predates the shape and resolves `void`.
 */
function makeMockEngine(post?: TrustEngine["postPendingSpend"]): EngineHandle {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(post ?? (async () => {})),
		voidPendingSpend: vi.fn(async () => {}),
		voidAllPending: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

interface AuditHandle extends AuditWriter {
	events: AppendEventInput[];
}

/** `failOnCall` is 1-based: the Nth append throws, every other one succeeds. */
function makeMockAudit(opts: { failOnCall?: number } = {}): AuditHandle {
	const events: AppendEventInput[] = [];
	let calls = 0;
	return {
		events,
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			calls++;
			if (calls === opts.failOnCall) throw new Error("audit disk full");
			events.push(input);
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
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

function shortfallEvents(audit: AuditHandle): AppendEventInput[] {
	return audit.events.filter((e) => e.kind === "settlement_shortfall");
}

/**
 * Read the REAL hash-linked chain — not a mock's call log. `verifyTransaction`
 * resolves a transfer by the FIRST event whose `data.transferId` matches
 * (packages/verify/src/index.ts), so the on-disk ORDER is the contract: a
 * `settlement_shortfall` written ahead of its `llm_call` renders a settled call
 * as PENDING with no cost.
 */
function readChain(vaultBase: string): AuditEvent[] {
	const chainPath = join(vaultBase, VAULT_DIR, "audit", "events.jsonl");
	return readFileSync(chainPath, "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as AuditEvent);
}

/** Index of the first chain event of `kind` carrying `transferId`, or -1. */
function chainIndexOf(events: AuditEvent[], kind: string, transferId: string): number {
	return events.findIndex((e) => e.kind === kind && e.data?.transferId === transferId);
}

// ── Tests ──

describe("headless settlement_shortfall threading", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-settle-shortfall-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	async function governorWith(engine: EngineHandle, audit: AuditHandle): Promise<Governor> {
		return await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: engine,
			_audit: audit,
		});
	}

	it("audits settlement_shortfall and sets receipt.postedCost when the engine reports truncation", async () => {
		const engine = makeMockEngine(async () => ({ posted: POSTED, shortfall: SHORTFALL }));
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		expect(receipt.settled).toBe(true);
		expect(receipt.postedCost).toBe(POSTED);
		// The receipt keeps the METERED cost — the ledger's number lives beside it.
		expect(receipt.cost).not.toBe(POSTED);
		expect(receipt.cost).toBeGreaterThan(0);

		const events = shortfallEvents(audit);
		expect(events).toHaveLength(1);
		expect(events[0]?.data).toMatchObject({
			model: AUTHORIZE.model,
			actual: receipt.cost,
			posted: POSTED,
			shortfall: SHORTFALL,
			transferId: auth.transferId,
		});

		await gov.destroy();
	});

	it("omits postedCost and the event when shortfall is zero", async () => {
		const engine = makeMockEngine(async (_transferId, actualAmount) => ({
			posted: actualAmount ?? 0,
			shortfall: 0,
		}));
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		expect(receipt.settled).toBe(true);
		// An ABSENT key, not an undefined one: consumers read the presence.
		expect(Object.hasOwn(receipt, "postedCost")).toBe(false);
		expect(shortfallEvents(audit)).toHaveLength(0);

		await gov.destroy();
	});

	it("treats a void-returning engine as posted-in-full (injected-engine compatibility)", async () => {
		const engine = makeMockEngine();
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		expect(receipt.settled).toBe(true);
		expect(Object.hasOwn(receipt, "postedCost")).toBe(false);
		expect(shortfallEvents(audit)).toHaveLength(0);

		await gov.destroy();
	});

	it("writes llm_call BEFORE settlement_shortfall on the real chain", async () => {
		const engine = makeMockEngine(async () => ({ posted: POSTED, shortfall: SHORTFALL }));
		// No `_audit`: this test needs the REAL writer so the on-disk order is what
		// is asserted, exactly as `verifyTransaction` will read it.
		const gov = await createGovernor({ budget: 100_000, vaultBase, _engine: engine });

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		expect(receipt.postedCost).toBe(POSTED);
		const events = readChain(vaultBase);
		const llmCallIdx = chainIndexOf(events, "llm_call", auth.transferId);
		const shortfallIdx = chainIndexOf(events, "settlement_shortfall", auth.transferId);
		expect(llmCallIdx).toBeGreaterThanOrEqual(0);
		expect(shortfallIdx).toBeGreaterThanOrEqual(0);
		expect(llmCallIdx).toBeLessThan(shortfallIdx);

		await gov.destroy();
	});

	it("audit-append failure on the shortfall event degrades without unsettling", async () => {
		const engine = makeMockEngine(async () => ({ posted: POSTED, shortfall: SHORTFALL }));
		// Headless settle appends llm_call FIRST and the settlement_shortfall
		// correction AFTER it — the same order as trust()'s non-stream path, and the
		// order `verifyTransaction` depends on — so llm_call is call #1 here and the
		// shortfall append is call #2.
		const audit = makeMockAudit({ failOnCall: 2 });
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		// The money committed; only the record of the gap was lost.
		expect(receipt.settled).toBe(true);
		expect(receipt.auditDegraded).toBe(true);
		expect(receipt.postedCost).toBe(POSTED);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(shortfallEvents(audit)).toHaveLength(0);

		await gov.destroy();
	});
});
