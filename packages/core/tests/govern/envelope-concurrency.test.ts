// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The envelope preflight read is serialised under the budget mutex, so a hard
 * scarcity tier holds under SINGLE-GOVERNOR concurrency.
 *
 * The bug (Codex P1, found at MAX effort): the attributed-call envelope preflight
 * balance read (`preflightEnvelopeRemaining`) used to run OUTSIDE `budgetMutex`. Two
 * concurrent attributed calls to the SAME envelope therefore both read the
 * pre-first-hold balance, and the envelope-scoped hard tiers
 * (`budgetFractionRemaining` / `budgetRunwayHours`) were evaluated against that stale
 * read. The ledger's atomic `debits_must_not_exceed_credits` rejects an OVERSHOOT but
 * never a fractional/runway tier, so the second call slipped past a hard scarcity
 * tier that should have denied it — defeating the feature's ledger-ENFORCED (not
 * advisory) behaviour-shaping claim under concurrency. The session path is immune
 * because its budget check reads IN-PROCESS counters mutated under the mutex; the
 * envelope path reads the LEDGER and did it before locking.
 *
 * The fix moves the read INSIDE the mutex, before the gate and the hold, on all three
 * attributed entry points (`trust()` LLM, `governAction`, headless `authorize`).
 *
 * WHY THIS IS DETERMINISTIC (no sleeps, no fake timers):
 *  - `AsyncMutex.acquire()` mutates its queue tail SYNCHRONOUSLY before its first
 *    `await`, so the acquisition order equals the call order. With `Promise.all[...]`
 *    the array's first element runs its synchronous prefix — and, on the FIXED code,
 *    calls `acquire()` — before the second element begins, so element 0 always wins
 *    the lock.
 *  - The mock engine is STATEFUL: `spendPending` decrements the envelope's `available`
 *    by a fixed hold (a PENDING TigerBeetle transfer debits the wallet immediately),
 *    and `lookupBalances` reports the CURRENT `available`.
 *
 * The two code paths then diverge with certainty:
 *  - OLD (read outside the lock): both calls issue their preflight read as their
 *    FIRST await, before either acquires the mutex, so both read the pre-hold 35% and
 *    BOTH pass the < 30% tier. Zero denials.
 *  - FIXED (read inside the lock): element 0 acquires, reads 35%, holds (→25%),
 *    releases; element 1 then acquires, reads 25%, and the tier DENIES it. Exactly one
 *    denial.
 *
 * So `expect(rejected).toHaveLength(1)` FAILS on HEAD (0 rejections) and passes after
 * the fix — the failing-first pin this whole change exists for.
 *
 * SECURITY (mirrors the sibling suites): never log or snapshot a whole PolicyContext —
 * it carries request-shaped data. Assert on outcomes and individual fields.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { withCostCenter } from "../../src/budget/attribution.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { TrustTBClient } from "../../src/ledger/client.js";
import { PolicyDeniedError } from "../../src/shared/errors.js";
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

const PARENT = "acme";
const COST_CENTER = "research";
const ENVELOPE_ID = TrustTBClient.deriveCostCenterAccountId(PARENT, COST_CENTER);

/** 1_000_000 allocated: `remaining / allocated` is the tier's `budgetFractionRemaining`. */
const ALLOCATED = 1_000_000;
const SCOPE_OPTS = { allocated: ALLOCATED, periodStartMs: Date.UTC(2026, 7, 3, 0, 0, 0) };
/** Start at 35% and hold 10% at a time: the first hold drops the fraction to 25%. */
const START_AVAILABLE = 350_000;
const HOLD = 100_000;

/**
 * A hard tier keyed ONLY on the envelope fraction — no model condition, so it applies
 * to LLM calls, actions, and headless authorizations alike. The `exists` guard keeps
 * it off unattributed traffic (that field is `undefined` there). This is the rule the
 * ledger cannot enforce: TigerBeetle rejects overshoot, never a fraction below 0.3.
 */
const TIER_RULE = {
	id: "concurrency-envelope-tier",
	name: "deny-below-30pct",
	description: "attributed spend blocked below 30% of the envelope",
	effect: "deny",
	enforcement: "hard",
	severity: "high",
	conditions: [
		{ field: "budgetFractionRemaining", operator: "exists" },
		{ field: "budgetFractionRemaining", operator: "lt", value: 0.3 },
	],
};

const CALL = {
	model: "claude-sonnet-4-6",
	max_tokens: 64,
	messages: [{ role: "user", content: "hello" }],
};

interface EngineHandle extends TrustEngine {
	spendPending: ReturnType<typeof vi.fn>;
	postPendingSpend: ReturnType<typeof vi.fn>;
	voidPendingSpend: ReturnType<typeof vi.fn>;
	lookupBalances: ReturnType<typeof vi.fn>;
}

/**
 * The whole point of the harness: a ledger whose read reflects prior holds. A PENDING
 * hold debits the envelope immediately, so a later `lookupBalances` must see it. The
 * decrement is a FIXED `HOLD` (not the tiny per-call estimate) purely so the fraction
 * crosses the tier boundary cleanly — the SIZE of the drop is not what is under test,
 * only whether the second preflight observes it.
 */
function makeStatefulEnvelopeEngine(): EngineHandle {
	let available = START_AVAILABLE;
	const engine: EngineHandle = {
		spendPending: vi.fn(async (p: { transferId: string; debitAccountId?: bigint }) => {
			// Only an attributed hold moves the envelope; every call here is attributed.
			if (p.debitAccountId === ENVELOPE_ID) available -= HOLD;
			return { transferId: p.transferId };
		}),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		voidAllPending: vi.fn(async () => {}),
		lookupBalances: vi.fn(async (ids: bigint[]) => {
			const map = new Map<bigint, number>();
			for (const id of ids) map.set(id, available);
			return map;
		}),
		destroy: vi.fn(),
	};
	return engine;
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

function makeAnthropicMock() {
	return {
		messages: {
			create: vi.fn(async () => ({
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 10, output_tokens: 5 },
			})),
		},
	};
}

function makeTierVault(): string {
	const base = join(tmpdir(), `envelope-concurrency-${randomUUID()}`);
	const usertrustDir = join(base, ".usertrust");
	mkdirSync(join(usertrustDir, "policies"), { recursive: true });
	writeFileSync(
		join(usertrustDir, "policies", "tier.json"),
		JSON.stringify({ rules: [TIER_RULE] }),
	);
	writeFileSync(
		join(usertrustDir, "usertrust.config.json"),
		JSON.stringify({ budget: 100_000_000, policies: "./policies/tier.json" }),
	);
	return base;
}

/** Exactly the calls that were REJECTED, for the "how many denials?" assertions. */
function rejections(results: PromiseSettledResult<unknown>[]): PromiseRejectedResult[] {
	return results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
}

describe("the envelope tier holds under single-governor concurrency", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeTierVault();
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("DENIES the second of two concurrent attributed LLM calls (trust) once the first hold drops the fraction below the tier", async () => {
		const engine = makeStatefulEnvelopeEngine();
		const client = makeAnthropicMock();
		const governed = await trust(client, {
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		// Two attributed calls to the SAME envelope, launched together. On HEAD both
		// read 35% before either hold lands and both pass; after the fix the second
		// reads 25% under the lock and is denied.
		const results = await Promise.allSettled([
			withCostCenter(COST_CENTER, () => governed.messages.create(CALL), SCOPE_OPTS),
			withCostCenter(COST_CENTER, () => governed.messages.create(CALL), SCOPE_OPTS),
		]);

		const denied = rejections(results);
		expect(denied).toHaveLength(1);
		const reason = denied[0]?.reason;
		expect(reason).toBeInstanceOf(PolicyDeniedError);
		expect(String((reason as PolicyDeniedError).message)).toContain("concurrency-envelope-tier");

		// The tier is a PRE-spend deny: exactly one hold reached the ledger, and the
		// blocked call never forwarded to the provider.
		expect(engine.spendPending).toHaveBeenCalledTimes(1);
		expect(client.messages.create).toHaveBeenCalledTimes(1);

		await governed.destroy();
	});

	it("DENIES the second of two concurrent attributed ACTIONS (governAction)", async () => {
		const engine = makeStatefulEnvelopeEngine();
		const execute = vi.fn(async () => "ok");
		const governed = await trust(makeAnthropicMock(), {
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const action = { kind: "tool_use", name: "search", cost: 100 };
		const results = await Promise.allSettled([
			withCostCenter(COST_CENTER, () => governed.governAction(action, execute), SCOPE_OPTS),
			withCostCenter(COST_CENTER, () => governed.governAction(action, execute), SCOPE_OPTS),
		]);

		const denied = rejections(results);
		expect(denied).toHaveLength(1);
		const reason = denied[0]?.reason;
		expect(reason).toBeInstanceOf(PolicyDeniedError);
		expect(String((reason as PolicyDeniedError).message)).toContain("concurrency-envelope-tier");
		// One hold, and the blocked action's body never executed.
		expect(engine.spendPending).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledTimes(1);

		await governed.destroy();
	});

	it("DENIES the second of two concurrent attributed AUTHORIZATIONS (headless authorize)", async () => {
		const engine = makeStatefulEnvelopeEngine();
		const gov = await createGovernor({
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const authorizeParams = {
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 10,
			maxOutputTokens: 64,
		};
		const results = await Promise.allSettled([
			withCostCenter(COST_CENTER, () => gov.authorize(authorizeParams), SCOPE_OPTS),
			withCostCenter(COST_CENTER, () => gov.authorize(authorizeParams), SCOPE_OPTS),
		]);

		const denied = rejections(results);
		expect(denied).toHaveLength(1);
		const reason = denied[0]?.reason;
		expect(reason).toBeInstanceOf(PolicyDeniedError);
		expect(String((reason as PolicyDeniedError).message)).toContain("concurrency-envelope-tier");
		// One hold placed; the blocked authorization returned no handle.
		expect(engine.spendPending).toHaveBeenCalledTimes(1);

		await gov.destroy();
	});

	it("lets BOTH concurrent calls through when neither hold crosses the tier (no false denials)", async () => {
		// Same race, but the tier boundary is never crossed: with 35% start and a 10%
		// hold, 25% is still ABOVE a 0.2 threshold, so the fix must not over-deny. This
		// guards against a fix that simply serialised-and-denied everything.
		const usertrustDir = join(vaultBase, ".usertrust");
		writeFileSync(
			join(usertrustDir, "policies", "tier.json"),
			JSON.stringify({
				rules: [
					{
						...TIER_RULE,
						conditions: [
							{ field: "budgetFractionRemaining", operator: "exists" },
							{ field: "budgetFractionRemaining", operator: "lt", value: 0.2 },
						],
					},
				],
			}),
		);

		const engine = makeStatefulEnvelopeEngine();
		const client = makeAnthropicMock();
		const governed = await trust(client, {
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const results = await Promise.allSettled([
			withCostCenter(COST_CENTER, () => governed.messages.create(CALL), SCOPE_OPTS),
			withCostCenter(COST_CENTER, () => governed.messages.create(CALL), SCOPE_OPTS),
		]);

		expect(rejections(results)).toHaveLength(0);
		expect(engine.spendPending).toHaveBeenCalledTimes(2);
		expect(client.messages.create).toHaveBeenCalledTimes(2);

		await governed.destroy();
	});
});
