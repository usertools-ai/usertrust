// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * P1-PARAM-SHADOW, extended to cost-center attribution — the request body must
 * never be able to forge, override, or bootstrap envelope attribution.
 *
 * `param-shadow.test.ts` pins that `tier`/`estimated_cost`/`budget_remaining`
 * survive a request-body shadowing attempt on the primary LLM path. This file
 * pins the SAME property for the fields envelopes added — `cost_center` and the
 * envelope-scoped `budget_remaining` / `budget_remaining_after` /
 * `budgetFractionRemaining` / `budgetRunwayHours` — at ALL THREE re-assertion
 * sites the AGENTS.md table now lists (govern.ts's LLM path, govern.ts's
 * `governAction`, headless.ts's `authorize`), plus two properties specific to
 * attribution that param-shadow has no analogue for:
 *
 *  - **No attribution without a scope.** Attribution is "structurally
 *    un-forgeable" per the source comments at every site — it comes from
 *    `getCurrentCostCenter()`, an AsyncLocalStorage read of the CALLER's own
 *    execution context, never from anything the request body carries. A body
 *    that names a costCenter which genuinely has a funded envelope must still
 *    produce an UNATTRIBUTED call when no `withCostCenter` scope is active: the
 *    hold debits the session wallet, no envelope preflight read is even
 *    attempted, and the policy context's `cost_center` is `undefined` — not the
 *    body's value. Both spellings are tried (`cost_center`, the policy-context
 *    key, and `costCenter`, the TS-surface spelling per A11) because neither
 *    name is ever read back out of a request body at any site.
 *  - **Concurrent isolation holds under the full stack, not just at the ALS
 *    primitive.** `budget/attribution.test.ts` already pins `Promise.all`
 *    isolation at the ALS layer directly; this file re-proves it through the
 *    whole governed call — hold, policy context, audit, and receipt — because a
 *    bug in `resolveEnvelope`/`interceptCall`'s single-read discipline could
 *    still leak across concurrent calls even with a perfectly isolated ALS.
 *  - **A10**: the same costCenter STRING under two different `parentUserId`s
 *    must derive and debit two different accounts — the tuple hash, not the
 *    bare label, is what money is keyed on (AGENTS.md, "Cost-center account ids
 *    hash the (parent, costCenter) TUPLE").
 *
 * SECURITY (mirrors budget-tier.test.ts / envelope-threading.test.ts): never
 * log or snapshot a whole PolicyContext — it carries request-shaped data.
 * Assert on individual fields.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { withCostCenter } from "../../src/budget/attribution.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { TrustTBClient } from "../../src/ledger/client.js";
import { evaluatePolicy, type PolicyContext } from "../../src/policy/gate.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";

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

// The evaluator itself stays REAL — this only records the context each call
// site hands it, so the assertions are about what the gate actually saw, not
// about a stub's opinion of what it should have seen.
vi.mock("../../src/policy/gate.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/policy/gate.js")>();
	return { ...actual, evaluatePolicy: vi.fn(actual.evaluatePolicy) };
});

// ── Fixtures ──

const PARENT = "acme";
// The scope's REAL cost center — has a real, derivable envelope.
const COST_CENTER = "research";
// What the request body claims instead — a syntactically valid costCenter that
// names a DIFFERENT (also derivable) envelope, so a naive implementation that
// read it would silently debit the wrong wallet rather than fail loudly.
const ATTACKER_COST_CENTER = "attacker-picked";

const ENVELOPE_ID = TrustTBClient.deriveCostCenterAccountId(PARENT, COST_CENTER);
const ATTACKER_ENVELOPE_ID = TrustTBClient.deriveCostCenterAccountId(PARENT, ATTACKER_COST_CENTER);
const SCOPE_OPTS = { allocated: 10_000, periodStartMs: Date.UTC(2026, 7, 3, 0, 0, 0) };

// Fabricated, deliberately implausible numbers a forged body would supply to
// try to manufacture headroom or dodge a scarcity-keyed tier. None of these
// may ever reach a policy context, an audit record, or a receipt.
const SPOOFED_BUDGET_REMAINING = 987_654_321;
const SPOOFED_BUDGET_REMAINING_AFTER = 987_654_321;
const SPOOFED_FRACTION = 1;
const SPOOFED_RUNWAY = 999_999;

/** What a forged request body looks like, for a given claimed costCenter. */
function spoofedBody(claimedCostCenter: string): Record<string, unknown> {
	return {
		cost_center: claimedCostCenter, // the policy-context spelling
		costCenter: claimedCostCenter, // the TS-surface spelling (A11) — also tried
		budget_remaining: SPOOFED_BUDGET_REMAINING,
		budget_remaining_after: SPOOFED_BUDGET_REMAINING_AFTER,
		budgetFractionRemaining: SPOOFED_FRACTION,
		budgetRunwayHours: SPOOFED_RUNWAY,
	};
}

const PARAMS = {
	model: "claude-sonnet-4-6",
	max_tokens: 64,
	messages: [{ role: "user", content: "hello" }],
};

interface EngineHandle extends TrustEngine {
	spendPending: ReturnType<typeof vi.fn>;
	postPendingSpend: ReturnType<typeof vi.fn>;
	voidPendingSpend: ReturnType<typeof vi.fn>;
	lookupBalances?: ReturnType<typeof vi.fn>;
}

/**
 * `balance` shapes the seam the governor reads envelope numbers through: a flat
 * number answers `available` for WHATEVER account ids are requested — enough to
 * prove a spoofed body cannot change which account gets debited or read,
 * without needing per-account bookkeeping in every test.
 */
function makeMockEngine(opts: { balance?: number } = {}): EngineHandle {
	const engine: EngineHandle = {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
	if (opts.balance !== undefined) {
		engine.lookupBalances = vi.fn(async (ids: bigint[]) => {
			const map = new Map<bigint, number>();
			for (const id of ids) map.set(id, opts.balance as number);
			return map;
		});
	}
	return engine;
}

interface AuditHandle extends AuditWriter {
	events: AppendEventInput[];
}

function makeMockAudit(): AuditHandle {
	const events: AppendEventInput[] = [];
	return {
		events,
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
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

function auditData(audit: AuditHandle, kind: string): Record<string, unknown> {
	const event = audit.events.find((e) => e.kind === kind);
	if (event === undefined) {
		throw new Error(
			`no ${kind} audit event was appended (saw: ${audit.events.map((e) => e.kind).join(", ")})`,
		);
	}
	return event.data as Record<string, unknown>;
}

/** The context the (real) evaluator saw for the most recent gate call. */
function lastPolicyContext(): PolicyContext {
	const calls = vi.mocked(evaluatePolicy).mock.calls;
	const last = calls[calls.length - 1];
	if (last === undefined) throw new Error("the policy evaluator was never called");
	return last[1];
}

// ---------------------------------------------------------------------------
// Site 1 — govern.ts's LLM path (interceptCall)
// ---------------------------------------------------------------------------

describe("LLM path (trust()) — request-body cost-center forgery", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `spoof-llm-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		vi.mocked(evaluatePolicy).mockClear();
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("an unattributed call ignores a body claiming a REAL envelope — no attribution without a scope", async () => {
		const engine = makeMockEngine({ balance: 5_000 });
		const audit = makeMockAudit();
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		// The body's cost_center names COST_CENTER — a genuinely fundable
		// envelope — but no withCostCenter scope wraps this call. Naming a real
		// envelope from the body must not be enough to attribute to it.
		const { receipt } = (await governed.messages.create({
			...PARAMS,
			...spoofedBody(COST_CENTER),
		} as Record<string, unknown>)) as { receipt: TrustReceipt };

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBeUndefined();
		// Session numbers, not the body's fabricated 987,654,321.
		expect(ctx.budget_remaining).toBe(100_000);
		expect(ctx.budget_remaining_after).toBe(100_000 - (ctx.estimated_cost as number));
		expect(ctx.budgetFractionRemaining).toBeUndefined();
		expect(ctx.budgetRunwayHours).toBeUndefined();

		// No envelope preflight is even attempted for an unattributed call — the
		// body's cost_center never got far enough to trigger a ledger read.
		expect(engine.lookupBalances).not.toHaveBeenCalled();
		expect(engine.spendPending.mock.calls[0]?.[0].debitAccountId).toBeUndefined();
		expect(auditData(audit, "llm_call").costCenter).toBeUndefined();
		expect(receipt.budget).toBeUndefined();

		await governed.destroy();
	});

	it("an attributed call ignores a forged body cost_center and forged envelope numbers — scope truth wins everywhere", async () => {
		const engine = makeMockEngine({ balance: 2_500 });
		const audit = makeMockAudit();
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		const { receipt } = (await withCostCenter(
			COST_CENTER,
			() =>
				governed.messages.create({
					...PARAMS,
					...spoofedBody(ATTACKER_COST_CENTER),
				} as Record<string, unknown>),
			SCOPE_OPTS,
		)) as { receipt: TrustReceipt };

		// The hold debited the SCOPE's envelope, never the attacker's.
		expect(engine.spendPending.mock.calls[0]?.[0]).toMatchObject({ debitAccountId: ENVELOPE_ID });
		expect(engine.spendPending.mock.calls[0]?.[0].debitAccountId).not.toBe(ATTACKER_ENVELOPE_ID);
		// Only the SCOPE's envelope was ever read — the attacker's account was
		// never even looked up.
		expect(engine.lookupBalances?.mock.calls.every((c) => c[0][0] === ENVELOPE_ID)).toBe(true);

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBe(COST_CENTER);
		expect(ctx.cost_center).not.toBe(ATTACKER_COST_CENTER);
		// The live ledger read (2,500 / 10,000 allocated), not the body's forged
		// 987,654,321 / fraction 1 / runway 999,999.
		expect(ctx.budget_remaining).toBe(2_500);
		expect(ctx.budget_remaining_after).toBe(2_500 - (ctx.estimated_cost as number));
		expect(ctx.budgetFractionRemaining).toBeCloseTo(0.25);
		expect(ctx.budgetRunwayHours).not.toBe(SPOOFED_RUNWAY);

		expect(auditData(audit, "llm_call").costCenter).toBe(COST_CENTER);
		expect(receipt.budget).toEqual({ costCenter: COST_CENTER, remaining: 2_500, fraction: 0.25 });

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// Site 2 — govern.ts's governAction (its own governor entry point)
// ---------------------------------------------------------------------------

describe("governAction — request-body cost-center forgery", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `spoof-action-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		vi.mocked(evaluatePolicy).mockClear();
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("an unattributed action ignores action.params claiming a REAL envelope — no attribution without a scope", async () => {
		const engine = makeMockEngine({ balance: 3_000 });
		const audit = makeMockAudit();
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		const { receipt } = await governed.governAction(
			{ kind: "tool_use", name: "search", cost: 25, params: spoofedBody(COST_CENTER) },
			async () => "ok",
		);

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBeUndefined();
		expect(ctx.budget_remaining).toBe(100_000);
		expect(ctx.budget_remaining_after).toBe(100_000 - 25);
		expect(ctx.budgetFractionRemaining).toBeUndefined();
		expect(ctx.budgetRunwayHours).toBeUndefined();

		expect(engine.lookupBalances).not.toHaveBeenCalled();
		expect(engine.spendPending.mock.calls[0]?.[0].debitAccountId).toBeUndefined();
		expect(auditData(audit, "tool_use").costCenter).toBeUndefined();
		expect(receipt.budget).toBeUndefined();

		await governed.destroy();
	});

	it("an attributed action ignores a forged action.params cost_center and forged envelope numbers", async () => {
		const engine = makeMockEngine({ balance: 3_000 });
		const audit = makeMockAudit();
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		const { receipt } = await withCostCenter(
			COST_CENTER,
			() =>
				governed.governAction(
					{
						kind: "tool_use",
						name: "search",
						cost: 25,
						params: spoofedBody(ATTACKER_COST_CENTER),
					},
					async () => "ok",
				),
			SCOPE_OPTS,
		);

		expect(engine.spendPending.mock.calls[0]?.[0]).toMatchObject({ debitAccountId: ENVELOPE_ID });
		expect(engine.spendPending.mock.calls[0]?.[0].debitAccountId).not.toBe(ATTACKER_ENVELOPE_ID);

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBe(COST_CENTER);
		expect(ctx.cost_center).not.toBe(ATTACKER_COST_CENTER);
		expect(ctx.budget_remaining).toBe(3_000);
		expect(ctx.budget_remaining_after).toBe(3_000 - 25);
		expect(ctx.budgetFractionRemaining).toBeCloseTo(0.3);
		expect(ctx.budgetRunwayHours).not.toBe(SPOOFED_RUNWAY);

		expect(auditData(audit, "tool_use").costCenter).toBe(COST_CENTER);
		expect(receipt.budget).toMatchObject({ costCenter: COST_CENTER, remaining: 3_000 });

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// Site 3 — headless.ts's authorize
// ---------------------------------------------------------------------------

describe("headless authorize — request-body cost-center forgery", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `spoof-headless-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		process.env.USERTRUST_TEST = "1";
		vi.mocked(evaluatePolicy).mockClear();
	});

	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	const AUTHORIZE = {
		model: "claude-sonnet-4-6",
		estimatedInputTokens: 100,
		maxOutputTokens: 500,
	};

	it("an unattributed authorize ignores params.params claiming a REAL envelope — no attribution without a scope", async () => {
		const engine = makeMockEngine({ balance: 2_500 });
		const audit = makeMockAudit();
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		const auth = await gov.authorize({ ...AUTHORIZE, params: spoofedBody(COST_CENTER) });

		expect("costCenter" in auth).toBe(false);
		expect("envelope" in auth).toBe(false);

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBeUndefined();
		expect(ctx.budget_remaining).toBe(100_000);
		expect(ctx.budget_remaining_after).toBe(100_000 - (ctx.estimated_cost as number));
		expect(ctx.budgetFractionRemaining).toBeUndefined();
		expect(ctx.budgetRunwayHours).toBeUndefined();

		expect(engine.lookupBalances).not.toHaveBeenCalled();
		expect(engine.spendPending.mock.calls[0]?.[0].debitAccountId).toBeUndefined();

		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });
		expect(receipt.budget).toBeUndefined();
		expect(auditData(audit, "llm_call").costCenter).toBeUndefined();

		await gov.destroy();
	});

	it("an attributed authorize ignores a forged params.params cost_center and forged envelope numbers", async () => {
		const engine = makeMockEngine({ balance: 2_500 });
		const audit = makeMockAudit();
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		const auth = await withCostCenter(
			COST_CENTER,
			() => gov.authorize({ ...AUTHORIZE, params: spoofedBody(ATTACKER_COST_CENTER) }),
			SCOPE_OPTS,
		);

		// The handle carries the SCOPE's truth, never the body's claim. The account id
		// itself no longer rides the public handle (it is a bigint, kept on the
		// governor's internal capture) — the debit account is asserted on the engine.
		expect(auth.costCenter).toBe(COST_CENTER);
		expect(auth.costCenter).not.toBe(ATTACKER_COST_CENTER);
		expect(engine.spendPending.mock.calls[0]?.[0]).toMatchObject({ debitAccountId: ENVELOPE_ID });
		expect(engine.spendPending.mock.calls[0]?.[0].debitAccountId).not.toBe(ATTACKER_ENVELOPE_ID);

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBe(COST_CENTER);
		expect(ctx.cost_center).not.toBe(ATTACKER_COST_CENTER);
		expect(ctx.budget_remaining).toBe(2_500);
		expect(ctx.budget_remaining_after).toBe(2_500 - (ctx.estimated_cost as number));
		expect(ctx.budgetFractionRemaining).toBeCloseTo(0.25);
		expect(ctx.budgetRunwayHours).not.toBe(SPOOFED_RUNWAY);

		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });
		expect(receipt.budget).toMatchObject({ costCenter: COST_CENTER, remaining: 2_500 });
		expect(auditData(audit, "llm_call").costCenter).toBe(COST_CENTER);

		await gov.destroy();
	});
});

// ---------------------------------------------------------------------------
// Concurrent isolation, re-proved through the FULL governed call
// ---------------------------------------------------------------------------

describe("concurrent calls under different scopes never bleed into each other", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `spoof-concurrent-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		vi.mocked(evaluatePolicy).mockClear();
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("Promise.all across two scopes on one governor: each call's hold, policy context, audit, and receipt show ONLY its own scope", async () => {
		const ALPHA = "alpha-scope";
		const BETA = "beta-scope";
		const ALPHA_ID = TrustTBClient.deriveCostCenterAccountId(PARENT, ALPHA);
		const BETA_ID = TrustTBClient.deriveCostCenterAccountId(PARENT, BETA);

		const engine = makeMockEngine({ balance: 50_000 });
		const audit = makeMockAudit();
		// Invert the resolution order — the SECOND call (beta) finishes before
		// the FIRST (alpha) — so a store read from the wrong tick would show up
		// as a swapped or blended attribution rather than passing by accident.
		let callIndex = 0;
		const delays = [20, 0];
		const client = {
			messages: {
				create: vi.fn(async () => {
					const delay = delays[callIndex] ?? 0;
					callIndex++;
					await new Promise((r) => setTimeout(r, delay));
					return {
						id: "msg",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						model: "claude-sonnet-4-6",
						usage: { input_tokens: 10, output_tokens: 5 },
					};
				}),
			},
		};
		const governed = await trust(client, {
			budget: 200_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		const [alphaResult, betaResult] = (await Promise.all([
			withCostCenter(ALPHA, () => governed.messages.create(PARAMS), SCOPE_OPTS),
			withCostCenter(BETA, () => governed.messages.create(PARAMS), SCOPE_OPTS),
		])) as [{ receipt: TrustReceipt }, { receipt: TrustReceipt }];

		// Two holds, each on its OWN envelope — never the other's, never a third.
		const debitIds = engine.spendPending.mock.calls.map((c) => c[0].debitAccountId);
		expect(debitIds).toHaveLength(2);
		expect(new Set(debitIds)).toEqual(new Set([ALPHA_ID, BETA_ID]));

		// Every policy evaluation saw exactly ONE of the two scopes — never both
		// (a merge bug), never neither (a drop bug).
		const seenCostCenters = vi.mocked(evaluatePolicy).mock.calls.map((c) => c[1].cost_center);
		expect(seenCostCenters.sort()).toEqual([ALPHA, BETA].sort());

		// Receipts and audit records: attribution followed its OWN call all the
		// way to settlement, regardless of resolution order.
		const receiptCostCenters = [
			alphaResult.receipt.budget?.costCenter,
			betaResult.receipt.budget?.costCenter,
		];
		expect(receiptCostCenters.sort()).toEqual([ALPHA, BETA].sort());

		const llmCostCenters = audit.events
			.filter((e) => e.kind === "llm_call")
			.map((e) => (e.data as Record<string, unknown>).costCenter);
		expect(llmCostCenters.sort()).toEqual([ALPHA, BETA].sort());

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// A10 — same costCenter string, different parentUserId → isolated accounts
// ---------------------------------------------------------------------------

describe("A10 — same costCenter, different parentUserId → isolated envelope accounts", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `spoof-a10-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		vi.mocked(evaluatePolicy).mockClear();
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("two governors sharing one ledger engine derive and debit DISTINCT accounts for the same costCenter label, run concurrently, with zero cross-talk", async () => {
		const PARENT_A = "acme";
		const PARENT_B = "globex";
		const SHARED_CC = "research"; // identical costCenter STRING for both parents

		const ACCOUNT_A = TrustTBClient.deriveCostCenterAccountId(PARENT_A, SHARED_CC);
		const ACCOUNT_B = TrustTBClient.deriveCostCenterAccountId(PARENT_B, SHARED_CC);
		// Sanity: the tuple hash, not the bare costCenter string, is what money
		// is keyed on (AGENTS.md — "Cost-center account ids hash the (parent,
		// costCenter) TUPLE"). If this ever failed, every assertion below would
		// be vacuous.
		expect(ACCOUNT_A).not.toBe(ACCOUNT_B);

		// ONE physical engine behind both governors, as if they shared a single
		// TigerBeetle cluster — balances keyed strictly per ACCOUNT id, never
		// per costCenter string, so a wrong-parent bug would read or debit the
		// OTHER company's envelope and this test would catch it directly.
		const balances = new Map<bigint, number>([
			[ACCOUNT_A, 4_000],
			[ACCOUNT_B, 9_000],
		]);
		const spendPending = vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId }));
		const postPendingSpend = vi.fn(async () => {});
		const voidPendingSpend = vi.fn(async () => {});
		const lookupBalances = vi.fn(async (ids: bigint[]) => {
			const map = new Map<bigint, number>();
			for (const id of ids) {
				const bal = balances.get(id);
				if (bal !== undefined) map.set(id, bal);
			}
			return map;
		});
		const sharedEngine: TrustEngine = {
			spendPending,
			postPendingSpend,
			voidPendingSpend,
			lookupBalances,
			destroy: vi.fn(),
		};

		const auditA = makeMockAudit();
		const auditB = makeMockAudit();
		mkdirSync(join(vaultBase, "a"), { recursive: true });
		mkdirSync(join(vaultBase, "b"), { recursive: true });

		const governedA = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase: join(vaultBase, "a"),
			parentUserId: PARENT_A,
			_engine: sharedEngine,
			_audit: auditA,
		});
		const governedB = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase: join(vaultBase, "b"),
			parentUserId: PARENT_B,
			_engine: sharedEngine,
			_audit: auditB,
		});

		const [resultA, resultB] = (await Promise.all([
			withCostCenter(SHARED_CC, () => governedA.messages.create(PARAMS), SCOPE_OPTS),
			withCostCenter(SHARED_CC, () => governedB.messages.create(PARAMS), SCOPE_OPTS),
		])) as [{ receipt: TrustReceipt }, { receipt: TrustReceipt }];

		// Each hold debited ITS OWN company's account — never the other's.
		const debitIds = spendPending.mock.calls.map((c) => c[0].debitAccountId);
		expect(new Set(debitIds)).toEqual(new Set([ACCOUNT_A, ACCOUNT_B]));

		// Each governor's receipt shows ITS OWN envelope's true balance — a swap
		// would show 9,000 on A's receipt or 4,000 on B's.
		expect(resultA.receipt.budget?.remaining).toBe(4_000);
		expect(resultB.receipt.budget?.remaining).toBe(9_000);

		// The SAME identifying label appears in both audit chains — that part is
		// deliberately not secret — but it is backed by genuinely different
		// money, which is the property that matters.
		expect(auditData(auditA, "llm_call").costCenter).toBe(SHARED_CC);
		expect(auditData(auditB, "llm_call").costCenter).toBe(SHARED_CC);

		await governedA.destroy();
		await governedB.destroy();
	});
});
