// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Task 6 — `createGovernor()` threads cost-center attribution through the
 * AUTHORIZATION HANDLE.
 *
 * The structural difference from `trust()`, and the reason this file exists at
 * all: the headless governor has NO closure spanning authorize→settle. `settle()`
 * and `abort()` are separate public calls that a caller makes later, from wherever
 * their own control flow happens to be — routinely a `finally`, a `catch`, or an
 * entirely different task, long after the `withCostCenter` scope exited. So the
 * `Authorization` handle is what a closure is on the SDK path, and the decisive
 * test below asserts `getCurrentCostCenter()` is `undefined` at the moment settle
 * is called and then asserts the settle was STILL attributed: the handle, not the
 * store, is the truth. A governor that re-read the store in `settle()` would
 * attribute the settle to nothing here — and, worse, to a LATER unrelated call's
 * scope in a server that multiplexes callers.
 *
 * Also pinned: D1's pre-I/O throw, the envelope-scoped policy site (the third of
 * the three re-assertion sites AGENTS.md tabulates, now carrying `cost_center`),
 * A7's unfloored `budget_remaining_after`, A2's pre-gate refusal, A1's attributed
 * records on the settle AND abort terminals, D5's label/hint re-wrap, and D7's
 * post-settle receipt snapshot — each with its unattributed counterpart asserted
 * byte-identical to the pre-envelope behaviour.
 *
 * SECURITY: never log or snapshot a whole PolicyContext — it carries
 * request-shaped data. Assert on individual fields.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { getCurrentCostCenter, withCostCenter } from "../../src/budget/attribution.js";
import type { ResolvedEnvelope, TrustEngine } from "../../src/govern.js";
import { type Authorization, createGovernor, type Governor } from "../../src/headless.js";
import { TrustTBClient } from "../../src/ledger/client.js";
import { evaluatePolicy, type PolicyContext } from "../../src/policy/gate.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { InsufficientBalanceError, LedgerUnavailableError } from "../../src/shared/errors.js";
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

// The evaluator itself stays REAL — this only records the context the call site
// hands it, so the assertions are about what the gate actually saw.
vi.mock("../../src/policy/gate.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/policy/gate.js")>();
	return { ...actual, evaluatePolicy: vi.fn(actual.evaluatePolicy) };
});

// ── Fixtures ──

const PARENT = "acme";
const COST_CENTER = "research";
const ENVELOPE_ID = TrustTBClient.deriveCostCenterAccountId(PARENT, COST_CENTER);
const ENVELOPE_LABEL = `${PARENT}::${COST_CENTER}`;
const SCOPE_OPTS = { allocated: 10_000, periodStartMs: Date.UTC(2026, 7, 3, 0, 0, 0) };

const AUTHORIZE = {
	model: "claude-sonnet-4-6",
	estimatedInputTokens: 100,
	maxOutputTokens: 500,
};

interface EngineHandle extends TrustEngine {
	spendPending: ReturnType<typeof vi.fn>;
	postPendingSpend: ReturnType<typeof vi.fn>;
	voidPendingSpend: ReturnType<typeof vi.fn>;
	lookupBalances?: ReturnType<typeof vi.fn>;
}

/**
 * `balance` shapes the seam the governor reads envelope numbers through:
 *   number    → the envelope's live `available`
 *   "missing" → the account is absent from the map (never allocated / fully reclaimed)
 *   "throw"   → the read fails (A2 transport failure)
 *   undefined → the engine has NO `lookupBalances` at all (optional-capability case)
 */
function makeMockEngine(opts: { balance?: number | "throw" | "missing" } = {}): EngineHandle {
	const engine: EngineHandle = {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		voidAllPending: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
	if (opts.balance !== undefined) {
		engine.lookupBalances = vi.fn(async (ids: bigint[]) => {
			if (opts.balance === "throw") throw new Error("tb: lookupAccounts timed out");
			const map = new Map<bigint, number>();
			if (opts.balance !== "missing") {
				for (const id of ids) map.set(id, opts.balance as number);
			}
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

function auditData(audit: AuditHandle, kind: string): Record<string, unknown> {
	const event = audit.events.find((e) => e.kind === kind);
	if (event === undefined) {
		throw new Error(
			`no ${kind} audit event was appended (saw: ${audit.events.map((e) => e.kind).join(", ")})`,
		);
	}
	return event.data as Record<string, unknown>;
}

/**
 * The cumulative session spend persisted to disk, or `undefined` when no ledger
 * was ever written. That file is what seeds the next run's holding wallet with
 * `max(0, budget - budgetSpent)`, which is why envelope money must never reach it.
 */
async function readPersistedSpend(vaultBase: string): Promise<number | undefined> {
	try {
		const raw = await readFile(join(vaultBase, VAULT_DIR, "spend-ledger.json"), "utf-8");
		return (JSON.parse(raw) as { budgetSpent: number }).budgetSpent;
	} catch {
		return undefined;
	}
}

/** The context the (real) evaluator saw for the most recent gate call. */
function lastPolicyContext(): PolicyContext {
	const calls = vi.mocked(evaluatePolicy).mock.calls;
	const last = calls[calls.length - 1];
	if (last === undefined) throw new Error("the policy evaluator was never called");
	return last[1];
}

// ── Tests ──

describe("headless authorize routes attributed holds to the envelope", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-envelope-${randomUUID()}`);
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

	// `parentUserId: null` means "construct this governor with NO ledger identity"
	// — a default parameter could not express that, because passing `undefined`
	// explicitly is what selects a default.
	async function governorWith(
		engine: EngineHandle,
		audit: AuditHandle,
		parentUserId: string | null = PARENT,
	): Promise<Governor> {
		return await createGovernor({
			budget: 100_000,
			vaultBase,
			...(parentUserId !== null ? { parentUserId } : {}),
			_engine: engine,
			_audit: audit,
		});
	}

	it("places the PENDING hold against the derived envelope account", async () => {
		const engine = makeMockEngine({ balance: 5_000 });
		const gov = await governorWith(engine, makeMockAudit());

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);

		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.spendPending.mock.calls[0]?.[0]).toMatchObject({ debitAccountId: ENVELOPE_ID });
		// The handle carries the capture forward — this is the ONLY thing settle and
		// abort will have to go on.
		expect(auth.costCenter).toBe(COST_CENTER);
		expect(auth.envelope?.accountId).toBe(ENVELOPE_ID);
		expect(auth.envelope?.label).toBe(ENVELOPE_LABEL);

		await gov.destroy();
	});

	it("leaves an UNATTRIBUTED authorize exactly as it was", async () => {
		const engine = makeMockEngine({ balance: 5_000 });
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);

		// No debit account: the session holding wallet, exactly as before envelopes.
		expect(engine.spendPending.mock.calls[0]?.[0].debitAccountId).toBeUndefined();
		// No envelope read is even attempted for an unattributed call.
		expect(engine.lookupBalances).not.toHaveBeenCalled();
		// Spread-omission, not `undefined`: the handle keeps its pre-envelope shape.
		expect("costCenter" in auth).toBe(false);
		expect("envelope" in auth).toBe(false);

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBeUndefined();
		expect(ctx.budget_remaining).toBe(100_000);
		expect(ctx.budget_remaining_after).toBe(100_000 - (ctx.estimated_cost as number));
		expect(ctx.budgetFractionRemaining).toBeUndefined();
		expect(ctx.budgetRunwayHours).toBeUndefined();

		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });
		expect(receipt.budget).toBeUndefined();
		expect(auditData(audit, "llm_call").costCenter).toBeUndefined();

		await gov.destroy();
	});

	it("throws BEFORE any I/O when a scope is active and the governor has no parentUserId (D1)", async () => {
		const engine = makeMockEngine({ balance: 5_000 });
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit, null);

		await expect(
			withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS),
		).rejects.toThrow(/parentUserId/);

		// Pre-I/O means pre-EVERYTHING: no envelope read, no policy evaluation, no
		// hold, no audit record. Silently spending from the session wallet instead is
		// the exact failure the throw exists to prevent — it would leave the envelope
		// reporting a full balance while the agent burned the session budget.
		expect(engine.lookupBalances).not.toHaveBeenCalled();
		expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(audit.events).toHaveLength(0);

		await gov.destroy();
	});

	it("gives the policy gate ENVELOPE-scoped numbers, from the live ledger read", async () => {
		const engine = makeMockEngine({ balance: 2_500 });
		const gov = await governorWith(engine, makeMockAudit());

		await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);

		// Exactly one preflight read, of exactly the envelope account.
		expect(engine.lookupBalances).toHaveBeenCalledOnce();
		expect(engine.lookupBalances?.mock.calls[0]?.[0]).toEqual([ENVELOPE_ID]);

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBe(COST_CENTER);
		expect(ctx.budget_remaining).toBe(2_500);
		expect(ctx.budget_remaining_after).toBe(2_500 - (ctx.estimated_cost as number));
		// 2500 / 10000 allocated.
		expect(ctx.budgetFractionRemaining).toBeCloseTo(0.25);
		expect(ctx.budgetRunwayHours).toBeTypeOf("number");

		await gov.destroy();
	});

	it("asserts the tier fields UNDEFINED when the scope carried no allocation metadata (D4)", async () => {
		const engine = makeMockEngine({ balance: 2_500 });
		const gov = await governorWith(engine, makeMockAudit());

		// No opts: attribution without an allocation. There is no cost-center
		// registry, so the governor genuinely does not know the envelope's size — and
		// a fabricated number is worse than an absent one. A hard tier on these
		// fields then fires (indeterminate ⇒ fail closed); a soft one stays lenient.
		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE));

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBe(COST_CENTER);
		// The envelope-scoped ledger numbers are still real — they need no metadata.
		expect(ctx.budget_remaining).toBe(2_500);
		expect(ctx.budgetFractionRemaining).toBeUndefined();
		expect(ctx.budgetRunwayHours).toBeUndefined();

		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });
		// `remaining` is knowable, `fraction` is not — omitted rather than guessed.
		expect(receipt.budget).toEqual({ costCenter: COST_CENTER, remaining: 2_500 });

		await gov.destroy();
	});

	it("reads a never-allocated envelope as zero and denies the spend at the gate", async () => {
		const engine = makeMockEngine({ balance: "missing" });
		const gov = await governorWith(engine, makeMockAudit());

		await expect(
			withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS),
		).rejects.toThrow(/Policy denied/);

		// Never-allocated and fully-reclaimed are the same observable state, so the
		// default hard rules now guard the ENVELOPE: an empty one is a pre-spend deny.
		expect(lastPolicyContext().budget_remaining).toBe(0);
		expect(engine.spendPending).not.toHaveBeenCalled();

		await gov.destroy();
	});

	it("denies an over-envelope call at the gate on an UNFLOORED remaining_after (A7)", async () => {
		// Five usertokens left against a much larger estimate: the envelope has funds,
		// so `block-budget-exhausted` cannot apply and `block-budget-overshoot` is the
		// only rule that can fire — which it can only do if the governor let
		// `budget_remaining_after` go NEGATIVE. Flooring it at 0 would leave this call
		// authorised and structurally disarm the one non-disableable pre-spend deny on
		// every attributed call, forking the field's semantics across the two paths.
		const engine = makeMockEngine({ balance: 5 });
		const gov = await governorWith(engine, makeMockAudit());

		await expect(
			withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS),
		).rejects.toThrow(/Policy denied/);

		const ctx = lastPolicyContext();
		expect(ctx.budget_remaining).toBe(5);
		expect(ctx.budget_remaining_after).toBe(5 - (ctx.estimated_cost as number));
		expect(ctx.budget_remaining_after as number).toBeLessThan(0);
		expect(engine.spendPending).not.toHaveBeenCalled();

		await gov.destroy();
	});

	it("REFUSES an attributed authorize whose envelope read fails, before the gate (A2)", async () => {
		const engine = makeMockEngine({ balance: "throw" });
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const err = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS).catch(
			(e: unknown) => e,
		);

		// The existing ledger-unavailable classification, naming the envelope that
		// could not be read. NOT a policy denial: the policy gate never ran.
		expect(err).toBeInstanceOf(LedgerUnavailableError);
		expect((err as LedgerUnavailableError).message).toContain(ENVELOPE_LABEL);

		// Why refusal rather than the session numbers: the preflight and the hold
		// share one TigerBeetle transport, so a read that genuinely failed means the
		// hold was doomed anyway — and gating on the SESSION wallet while the hold
		// debits the ENVELOPE would clear the call against a wallet the money never
		// came from, in the one record an auditor reads.
		expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(audit.events).toHaveLength(0);

		await gov.destroy();
	});

	it("REFUSES an attributed authorize when the engine cannot read balances at all (A2)", async () => {
		// Same refusal, different cause: an engine with no `lookupBalances` would
		// place the envelope hold and be unable to report on it. Both `createTBEngine`
		// factories implement the method, so this is the injected-engine case — and it
		// must not degrade into session-scoped policy numbers either.
		const engine = makeMockEngine();
		expect(engine.lookupBalances).toBeUndefined();
		const gov = await governorWith(engine, makeMockAudit());

		await expect(
			withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS),
		).rejects.toThrow(LedgerUnavailableError);

		expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
		expect(engine.spendPending).not.toHaveBeenCalled();

		await gov.destroy();
	});

	it("names the envelope LABEL and the right remedy when the ledger rejects the hold (D5)", async () => {
		const engine = makeMockEngine({ balance: 10 });
		// What the engine seam throws for an exhausted envelope: the derived ACCOUNT
		// id, because the `parent::costCenter` label lives in the governor.
		engine.spendPending.mockRejectedValueOnce(
			new InsufficientBalanceError(`envelope:${ENVELOPE_ID}`, 999, 10),
		);
		const gov = await governorWith(engine, makeMockAudit());

		const err = await withCostCenter(
			COST_CENTER,
			() => gov.authorize({ ...AUTHORIZE, maxOutputTokens: 1 }),
			SCOPE_OPTS,
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(InsufficientBalanceError);
		const balanceErr = err as InsufficientBalanceError;
		// The operator reads `acme::research`, not a 39-digit account id.
		expect(balanceErr.userId).toBe(ENVELOPE_LABEL);
		expect(balanceErr.message).toContain(ENVELOPE_LABEL);
		// And is told the remedy that actually funds an envelope — raising the
		// createGovernor() budget funds the session wallet this hold never debits.
		expect(balanceErr.hint).toMatch(/allocateBudget/);
		expect(balanceErr.hint).not.toMatch(/Increase the budget in trust\(\) options/);
		// The ledger's own numbers survive the re-wrap.
		expect(balanceErr.required).toBe(999);
		expect(balanceErr.available).toBe(10);

		await gov.destroy();
	});

	it("leaves an UNATTRIBUTED ledger rejection byte-identical", async () => {
		const engine = makeMockEngine({ balance: 10 });
		const thrown = new InsufficientBalanceError("trust:hold", 999, 10);
		engine.spendPending.mockRejectedValueOnce(thrown);
		const gov = await governorWith(engine, makeMockAudit());

		const err = await gov.authorize(AUTHORIZE).catch((e: unknown) => e);

		// The SAME error object, not a re-wrap: nothing on this path changed.
		expect(err).toBe(thrown);
		expect((err as InsufficientBalanceError).hint).toBe(
			"Increase the budget in trust() options or add funds via the ledger.",
		);

		await gov.destroy();
	});
});

// ---------------------------------------------------------------------------
// The decisive one: settle/abort run OUTSIDE every scope, on the handle alone
// ---------------------------------------------------------------------------

describe("headless settle and abort attribute from the handle, not the store", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-envelope-settle-${randomUUID()}`);
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

	async function governorWith(engine: EngineHandle, audit: AuditHandle): Promise<Governor> {
		return await createGovernor({
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});
	}

	it("attributes a settle called outside any withCostCenter scope", async () => {
		const engine = makeMockEngine({ balance: 4_000 });
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);

		// THE PIN: we are outside every scope now. An `AsyncLocalStorage` read from
		// inside settle() would see exactly this — nothing. Unlike `trust()`, this
		// governor has no closure to fall back on, so the handle is the only carrier.
		expect(getCurrentCostCenter()).toBeUndefined();

		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		expect(receipt.settled).toBe(true);
		// The handle, not the store, is what the settle read.
		expect(auditData(audit, "llm_call").costCenter).toBe(COST_CENTER);
		expect(receipt.budget).toEqual({
			costCenter: COST_CENTER,
			remaining: 4_000,
			fraction: 0.4,
		});
		// One read at authorize (preflight), one after the POST (D7 snapshot).
		expect(engine.lookupBalances).toHaveBeenCalledTimes(2);

		await gov.destroy();
	});

	it("does NOT pick up a DIFFERENT scope that happens to be active at settle time", async () => {
		// The failure a store read in settle() would produce in a server that
		// multiplexes callers: the settle lands on whichever scope the settling task
		// is standing in, which is not the scope that placed the hold. Here the hold
		// is `research` and the settle runs inside `marketing`; the record must still
		// say `research`, because that is the envelope the money actually came from.
		const engine = makeMockEngine({ balance: 4_000 });
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);

		const receipt = await withCostCenter("marketing", () =>
			gov.settle(auth, { inputTokens: 80, outputTokens: 200 }),
		);

		expect(receipt.budget?.costCenter).toBe(COST_CENTER);
		expect(auditData(audit, "llm_call").costCenter).toBe(COST_CENTER);
		// And the money followed the same handle: the D7 snapshot read the envelope
		// the hold debited, not the one the settling task was standing in.
		expect(engine.lookupBalances?.mock.calls.at(-1)?.[0]).toEqual([ENVELOPE_ID]);

		await gov.destroy();
	});

	it("OMITS the receipt budget block when the post-settle read fails, without touching the settlement (D7)", async () => {
		const engine = makeMockEngine({ balance: 4_000 });
		// Preflight succeeds; the post-settle snapshot read fails.
		engine.lookupBalances?.mockImplementationOnce(async (ids: bigint[]) => {
			const map = new Map<bigint, number>();
			for (const id of ids) map.set(id, 4_000);
			return map;
		});
		engine.lookupBalances?.mockImplementationOnce(async () => {
			throw new Error("tb: lookupAccounts timed out");
		});
		const gov = await governorWith(engine, makeMockAudit());

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);
		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		expect(receipt.budget).toBeUndefined();
		// Receipt degradation NEVER unwinds committed money.
		expect(receipt.settled).toBe(true);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await gov.destroy();
	});

	it("stamps the attribution on a settlement_ambiguous record (A1)", async () => {
		const engine = makeMockEngine({ balance: 4_000 });
		engine.postPendingSpend.mockRejectedValueOnce(new Error("tb: postTransfer socket reset"));
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);
		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		expect(receipt.settled).toBe(false);
		// An ambiguous settlement is precisely the record an auditor reconstructs a
		// cost center's history from — it must name the envelope.
		expect(auditData(audit, "settlement_ambiguous").costCenter).toBe(COST_CENTER);
		expect(auditData(audit, "llm_call").costCenter).toBe(COST_CENTER);

		await gov.destroy();
	});

	it("carries the attribution into the abort terminal's record (A1)", async () => {
		const engine = makeMockEngine({ balance: 4_000 });
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);

		// abort() is normally called from a `catch` outside the scope, exactly here.
		expect(getCurrentCostCenter()).toBeUndefined();
		await gov.abort(auth, new Error("provider exploded"));

		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		// Attributed hold ⇒ attributed terminal record: forensic continuity.
		expect(auditData(audit, "llm_call_failed").costCenter).toBe(COST_CENTER);

		await gov.destroy();
	});

	it("leaves an unattributed abort record byte-identical", async () => {
		const engine = makeMockEngine({ balance: 4_000 });
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		await gov.abort(auth, new Error("provider exploded"));

		const data = auditData(audit, "llm_call_failed");
		expect("costCenter" in data).toBe(false);

		await gov.destroy();
	});
});

// ---------------------------------------------------------------------------
// The handle is CALLER-OWNED; the attribution the governor reads is not
// ---------------------------------------------------------------------------
//
// Whole-branch review, finding 2. `activeAuths.set(transferId, auth)` stores the
// caller's own object, and `settle()`/`abort()` established liveness with
// `has(transferId)` and then read `auth.costCenter` / `auth.envelope` off that same
// caller-mutable object. Money never moved wrong — `postPendingSpend` is
// transferId-bound and the hold was placed at authorize — but AGENTS.md's rule is
// that EVERY audit record comes from the authorize-time capture and never from
// caller input, and a relabelled `llm_call` / `llm_call_failed` is exactly the
// record an auditor reconstructs a cost center's history from. The second-order
// effect is worse than the label: `snapshotEnvelopeRemaining` reads whatever
// account the envelope names, so a forged `auth.envelope` turns the receipt's
// budget block into an arbitrary account's balance.
//
// `trust()` was already immune — its attribution is a closure `const`. This pins
// the same immutability for the handle-based governor.

describe("headless settle and abort read an INTERNAL capture, not the caller's handle", () => {
	let vaultBase: string;

	const FORGED_COST_CENTER = "marketing";
	const FORGED_ID = TrustTBClient.deriveCostCenterAccountId(PARENT, FORGED_COST_CENTER);
	const FORGED_LABEL = `${PARENT}::${FORGED_COST_CENTER}`;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-envelope-forge-${randomUUID()}`);
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

	async function governorWith(engine: EngineHandle, audit: AuditHandle): Promise<Governor> {
		return await createGovernor({
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});
	}

	/** The relabelling a caller can attempt between authorize and settle/abort. */
	function forge(auth: Authorization): void {
		auth.costCenter = FORGED_COST_CENTER;
		auth.envelope = {
			attribution: {
				costCenter: FORGED_COST_CENTER,
				allocated: 1_000_000,
				periodStartMs: SCOPE_OPTS.periodStartMs,
			},
			accountId: FORGED_ID,
			label: FORGED_LABEL,
		};
	}

	it("IGNORES a handle relabelled between authorize and settle", async () => {
		const engine = makeMockEngine({ balance: 4_000 });
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);
		forge(auth);

		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		// The record still names the envelope the hold actually debited.
		expect(auditData(audit, "llm_call").costCenter).toBe(COST_CENTER);
		expect(receipt.budget?.costCenter).toBe(COST_CENTER);
		// And the D7 snapshot read THAT envelope's account — not the arbitrary
		// account the forged handle named.
		expect(engine.lookupBalances?.mock.calls.at(-1)?.[0]).toEqual([ENVELOPE_ID]);
		expect(receipt.budget?.remaining).toBe(4_000);

		await gov.destroy();
	});

	it("IGNORES a handle relabelled between authorize and abort", async () => {
		const engine = makeMockEngine({ balance: 4_000 });
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);
		forge(auth);

		await gov.abort(auth, new Error("provider exploded"));

		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(auditData(audit, "llm_call_failed").costCenter).toBe(COST_CENTER);

		await gov.destroy();
	});

	it("cannot be relabelled by mutating the envelope object the handle exposes", async () => {
		// The narrower attack: not replacing `auth.envelope`, but editing the object
		// in place — which would reach the governor too if the handle and the
		// governor's capture were the same mutable object.
		const engine = makeMockEngine({ balance: 4_000 });
		const audit = makeMockAudit();
		const gov = await governorWith(engine, audit);

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);

		expect(Object.isFrozen(auth.envelope)).toBe(true);
		expect(Object.isFrozen(auth.envelope?.attribution)).toBe(true);
		expect(() => {
			(auth.envelope as ResolvedEnvelope).accountId = FORGED_ID;
		}).toThrow(TypeError);

		const receipt = await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		expect(receipt.budget?.costCenter).toBe(COST_CENTER);
		expect(engine.lookupBalances?.mock.calls.at(-1)?.[0]).toEqual([ENVELOPE_ID]);

		await gov.destroy();
	});

	it("still refuses a settle for an authorization that is no longer active", async () => {
		// The liveness/one-shot semantics are unchanged by the capture lookup: the
		// first terminal claims the entry, the second is refused.
		const engine = makeMockEngine({ balance: 4_000 });
		const gov = await governorWith(engine, makeMockAudit());

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);
		await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		await expect(gov.settle(auth, { inputTokens: 80, outputTokens: 200 })).rejects.toThrow(
			/is not active/,
		);
		// abort stays idempotent-silent rather than throwing.
		await expect(gov.abort(auth)).resolves.toBeUndefined();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await gov.destroy();
	});
});

// ---------------------------------------------------------------------------
// Session accounting tracks SESSION-WALLET money only
// ---------------------------------------------------------------------------
//
// Whole-branch review, finding 3. `inFlightHoldTotal` and `budgetSpent` are the
// SESSION holding wallet's accounting — the numbers `budgetRemaining()`, the
// receipt, the unattributed policy gate and the restart seed
// (`max(0, budget - budgetSpent)`) are all computed from. An ATTRIBUTED hold
// debits the ENVELOPE wallet and never touches the session wallet, so moving those
// counters for it charges the session for money it did not pay: unattributed calls
// eventually hard-deny against a wallet TigerBeetle would still have held against,
// and every attributed receipt reports a session `budgetRemaining` decremented by
// envelope money. Fail-closed, but unrecorded and wrong.

describe("headless session accounting excludes envelope spend", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-envelope-session-${randomUUID()}`);
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

	it("leaves the session budget untouched by an attributed call, and gates the next unattributed call on it", async () => {
		const engine = makeMockEngine({ balance: 50_000 });
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const attributed = await withCostCenter(
			COST_CENTER,
			() => gov.authorize(AUTHORIZE),
			SCOPE_OPTS,
		);
		// The hold went to the envelope, so the session wallet has no in-flight
		// exposure to report.
		expect(gov.budgetRemaining()).toBe(100_000);

		const attributedReceipt = await gov.settle(attributed, {
			inputTokens: 80,
			outputTokens: 200,
		});
		expect(attributedReceipt.cost).toBeGreaterThan(0);
		// A settled attributed receipt reports SESSION headroom, which this spend did
		// not consume — the envelope's own number is `receipt.budget`.
		expect(attributedReceipt.budgetRemaining).toBe(100_000);
		expect(attributedReceipt.budget?.remaining).toBe(50_000);

		// Mixed traffic: the unattributed call that follows is gated on a session
		// remaining the envelope spend never moved.
		const unattributed = await gov.authorize(AUTHORIZE);
		expect(lastPolicyContext().budget_remaining).toBe(100_000);

		const unattributedReceipt = await gov.settle(unattributed, {
			inputTokens: 80,
			outputTokens: 200,
		});
		expect(unattributedReceipt.budgetRemaining).toBe(100_000 - unattributedReceipt.cost);
		// Only the session-wallet spend is persisted, because only it survives a
		// restart as `max(0, budget - budgetSpent)` seeding of the holding wallet.
		expect(await readPersistedSpend(vaultBase)).toBe(unattributedReceipt.cost);

		await gov.destroy();
	});

	it("never persists a spend ledger for an attributed-only session", async () => {
		const engine = makeMockEngine({ balance: 50_000 });
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);
		await gov.settle(auth, { inputTokens: 80, outputTokens: 200 });

		// Nothing to record: the session wallet paid nothing. A ledger written here
		// would shrink the next run's holding-wallet seed by envelope money.
		expect(await readPersistedSpend(vaultBase)).toBeUndefined();

		await gov.destroy();
	});

	it("restores the in-flight hold on an attributed abort without moving session numbers", async () => {
		const engine = makeMockEngine({ balance: 50_000 });
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const auth = await withCostCenter(COST_CENTER, () => gov.authorize(AUTHORIZE), SCOPE_OPTS);
		await gov.abort(auth, new Error("provider exploded"));

		// The increment was skipped, so the matching decrement must be too — an
		// asymmetric release would drive `inFlightHoldTotal` negative and hand the
		// session MORE headroom than its budget.
		expect(gov.budgetRemaining()).toBe(100_000);

		await gov.destroy();
	});
});
