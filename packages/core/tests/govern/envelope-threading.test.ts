// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Task 5 — `trust()` threads cost-center attribution through the whole call.
 *
 * What is pinned here, and why each pin exists:
 *
 *  - ONE `getCurrentCostCenter()` read, at `interceptCall`'s top, captured into the
 *    closure. The decisive case is the stream test: the `withCostCenter` scope has
 *    already EXITED (asserted, not assumed) by the time the emitter's terminal fires
 *    from the test body, so a governor that re-read the store in its terminal would
 *    attribute the settle to nothing. Both the hold and the settle-time records are
 *    checked on that path.
 *  - D1: an active scope with no `parentUserId` throws BEFORE any I/O. Silently
 *    falling back to the session wallet would un-enforce the envelope the caller
 *    asked for, and it would do it invisibly.
 *  - The attributed hold names the ENVELOPE account — `deriveCostCenterAccountId`,
 *    never a lookup, never a joined string.
 *  - The policy context is envelope-scoped whenever the hold will debit an envelope,
 *    and the UNATTRIBUTED construction is byte-identical to what it was before
 *    envelopes existed (regression pin: this file is the only place that comparison
 *    lives). `budget_remaining_after` is UNFLOORED on both paths (A7) — it has to be
 *    able to go negative or `block-budget-overshoot`, the one non-disableable
 *    pre-spend deny, can never fire on attributed traffic.
 *  - A2: an attributed call whose envelope cannot be read is REFUSED before the
 *    policy gate with the ledger-unavailable classification — never gated on the
 *    session wallet its hold would not have touched, and never continued with the
 *    field absent (which the hard overshoot rule would turn into a deny that names
 *    the wrong cause).
 *  - Attributed audit records carry `costCenter` (A1) — settle AND void terminals.
 *  - Settled receipts carry the D7 post-settle `budget` snapshot, and a failed
 *    snapshot read OMITS the block rather than failing a settlement that already
 *    committed.
 *
 * SECURITY (mirrors budget-tier.test.ts): never log or snapshot a whole
 * PolicyContext — it carries request-shaped data. Assert on individual fields.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { getCurrentCostCenter, withCostCenter } from "../../src/budget/attribution.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { TrustTBClient } from "../../src/ledger/client.js";
import { evaluatePolicy, type PolicyContext } from "../../src/policy/gate.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { InsufficientBalanceError, LedgerUnavailableError } from "../../src/shared/errors.js";
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

// The evaluator itself stays REAL — this only records the context each call site
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
 * `balance` shapes the seam the governor reads envelope numbers through:
 *   number   → the envelope's live `available`
 *   "missing"→ the account is absent from the map (never allocated / fully reclaimed)
 *   "throw"  → the read fails (A2 transport failure)
 *   undefined→ the engine has NO `lookupBalances` at all (the optional-capability case)
 */
function makeMockEngine(opts: { balance?: number | "throw" | "missing" } = {}): EngineHandle {
	const engine: EngineHandle = {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
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

/** A MessageStream-shaped emitter that emits NOTHING until the test says so. */
class ManualMessageStream extends EventEmitter {
	abort(): void {
		this.emit("abort", new Error("aborted"));
	}
	finalMessage(): Promise<unknown> {
		return Promise.resolve({ usage: { input_tokens: 10, output_tokens: 5 } });
	}
	async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
		// The caller owns the iterator; governance never touches it.
	}
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

describe("attributed calls spend from the cost-center envelope", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `envelope-threading-${randomUUID()}`);
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

	it("routes the PENDING hold to the derived envelope account", async () => {
		const engine = makeMockEngine({ balance: 5_000 });
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
			() => governed.messages.create(PARAMS),
			SCOPE_OPTS,
		)) as { receipt: TrustReceipt };

		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.spendPending.mock.calls[0]?.[0]).toMatchObject({ debitAccountId: ENVELOPE_ID });
		expect(receipt.settled).toBe(true);

		await governed.destroy();
	});

	it("leaves an UNATTRIBUTED hold and its policy numbers exactly as they were", async () => {
		const engine = makeMockEngine({ balance: 5_000 });
		const audit = makeMockAudit();
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		const { receipt } = (await governed.messages.create(PARAMS)) as { receipt: TrustReceipt };

		// No debit account: the session holding wallet, exactly as before envelopes.
		expect(engine.spendPending.mock.calls[0]?.[0].debitAccountId).toBeUndefined();
		// No envelope read is even attempted for an unattributed call.
		expect(engine.lookupBalances).not.toHaveBeenCalled();

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBeUndefined();
		expect(ctx.budget_remaining).toBe(100_000);
		expect(ctx.budget_remaining_after).toBe(100_000 - (ctx.estimated_cost as number));
		expect(ctx.budgetFractionRemaining).toBeUndefined();
		expect(ctx.budgetRunwayHours).toBeUndefined();

		// Nothing envelope-shaped reaches the audit chain or the receipt either.
		expect(auditData(audit, "llm_call").costCenter).toBeUndefined();
		expect(receipt.budget).toBeUndefined();

		await governed.destroy();
	});

	it("throws BEFORE any I/O when a scope is active and the governor has no parentUserId (D1)", async () => {
		const engine = makeMockEngine({ balance: 5_000 });
		const audit = makeMockAudit();
		const client = makeAnthropicMock();
		const governed = await trust(client, {
			budget: 100_000,
			vaultBase,
			_engine: engine,
			_audit: audit,
		});

		await expect(
			withCostCenter(COST_CENTER, () => governed.messages.create(PARAMS), SCOPE_OPTS),
		).rejects.toThrow(/parentUserId/);

		// Pre-I/O means pre-EVERYTHING: no hold, no provider call, no audit record,
		// and not even a policy evaluation.
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(engine.lookupBalances).not.toHaveBeenCalled();
		expect(client.messages.create).not.toHaveBeenCalled();
		expect(audit.events).toHaveLength(0);
		expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("gives the policy gate ENVELOPE-scoped numbers, from the live ledger read", async () => {
		const engine = makeMockEngine({ balance: 2_500 });
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await withCostCenter(COST_CENTER, () => governed.messages.create(PARAMS), SCOPE_OPTS);

		// Exactly one preflight read, of exactly the envelope account.
		expect(engine.lookupBalances).toHaveBeenCalledTimes(2); // preflight + post-settle (D7)
		expect(engine.lookupBalances?.mock.calls[0]?.[0]).toEqual([ENVELOPE_ID]);

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBe(COST_CENTER);
		expect(ctx.budget_remaining).toBe(2_500);
		expect(ctx.budget_remaining_after).toBe(2_500 - (ctx.estimated_cost as number));
		// 2500 / 10000 allocated.
		expect(ctx.budgetFractionRemaining).toBeCloseTo(0.25);
		expect(ctx.budgetRunwayHours).toBeTypeOf("number");

		await governed.destroy();
	});

	it("reads a never-allocated envelope as zero and denies the spend at the gate", async () => {
		const engine = makeMockEngine({ balance: "missing" });
		const client = makeAnthropicMock();
		const governed = await trust(client, {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await expect(
			withCostCenter(COST_CENTER, () => governed.messages.create(PARAMS), SCOPE_OPTS),
		).rejects.toThrow(/Policy denied/);

		// The default hard rules now guard the ENVELOPE: an empty envelope is a
		// pre-spend deny, before the hold and before the provider call.
		expect(lastPolicyContext().budget_remaining).toBe(0);
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(client.messages.create).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("denies an over-envelope call at the gate, BEFORE any hold, on an UNFLOORED remaining_after (A7)", async () => {
		// Five usertokens left, an estimate far above it: the envelope has funds, so
		// `block-budget-exhausted` does not apply and `block-budget-overshoot` is the
		// only rule that can fire — which it can only do if the governor let
		// `budget_remaining_after` go NEGATIVE. Flooring it at 0 would leave this
		// call authorised and structurally disable the one non-disableable pre-spend
		// deny on every attributed call.
		const engine = makeMockEngine({ balance: 5 });
		const client = makeAnthropicMock();
		const governed = await trust(client, {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await expect(
			withCostCenter(COST_CENTER, () => governed.messages.create(PARAMS), SCOPE_OPTS),
		).rejects.toThrow(/Policy denied/);

		const ctx = lastPolicyContext();
		expect(ctx.budget_remaining).toBe(5);
		expect(ctx.budget_remaining_after).toBe(5 - (ctx.estimated_cost as number));
		expect(ctx.budget_remaining_after as number).toBeLessThan(0);
		// Pre-spend means pre-everything downstream of the gate.
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(client.messages.create).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("REFUSES an attributed call whose envelope read fails, before the gate (A2)", async () => {
		const engine = makeMockEngine({ balance: "throw" });
		const client = makeAnthropicMock();
		const audit = makeMockAudit();
		const governed = await trust(client, {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		const err = await withCostCenter(
			COST_CENTER,
			() => governed.messages.create(PARAMS),
			SCOPE_OPTS,
		).catch((e: unknown) => e);

		// The existing ledger-unavailable classification, naming the envelope that
		// could not be read. NOT a policy denial: the policy gate never ran.
		expect(err).toBeInstanceOf(LedgerUnavailableError);
		expect((err as LedgerUnavailableError).message).toContain(ENVELOPE_LABEL);

		// Why refusal rather than the session numbers: the preflight and the hold
		// share one TigerBeetle transport, so a read that genuinely failed means the
		// hold was doomed anyway — and gating the call on the SESSION wallet while
		// the hold debits the ENVELOPE would clear it against a wallet the money
		// never came from, in the one record an auditor reads.
		expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(client.messages.create).not.toHaveBeenCalled();
		expect(audit.events).toHaveLength(0);

		await governed.destroy();
	});

	it("REFUSES an attributed call when the engine cannot read balances at all (A2)", async () => {
		// Same refusal, different cause: an engine with no `lookupBalances` would
		// place the envelope hold and be unable to report on it. Both `createTBEngine`
		// factories implement the method, so this is the injected-engine case — and
		// it must not degrade into session-scoped policy numbers either.
		const engine = makeMockEngine();
		expect(engine.lookupBalances).toBeUndefined();
		const client = makeAnthropicMock();
		const governed = await trust(client, {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await expect(
			withCostCenter(COST_CENTER, () => governed.messages.create(PARAMS), SCOPE_OPTS),
		).rejects.toThrow(LedgerUnavailableError);

		expect(vi.mocked(evaluatePolicy)).not.toHaveBeenCalled();
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(client.messages.create).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("stamps costCenter on the llm_call record and the settled receipt", async () => {
		const engine = makeMockEngine({ balance: 4_000 });
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
			() => governed.messages.create(PARAMS),
			SCOPE_OPTS,
		)) as { receipt: TrustReceipt };

		expect(auditData(audit, "llm_call").costCenter).toBe(COST_CENTER);
		expect(receipt.budget).toEqual({
			costCenter: COST_CENTER,
			remaining: 4_000,
			fraction: 0.4,
		});

		await governed.destroy();
	});

	it("OMITS the receipt budget block when the post-settle read fails, without touching the settlement", async () => {
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
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const { receipt } = (await withCostCenter(
			COST_CENTER,
			() => governed.messages.create(PARAMS),
			SCOPE_OPTS,
		)) as { receipt: TrustReceipt };

		expect(receipt.budget).toBeUndefined();
		// Receipt degradation NEVER unwinds committed money.
		expect(receipt.settled).toBe(true);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("OMITS the budget block on an AMBIGUOUS settlement (settled:false), without a post-settle read", async () => {
		const engine = makeMockEngine({ balance: 4_000 });
		// The POST after the audit fails: the transfer may still be pending and be
		// posted or voided later, so the envelope balance is transient. `receipt.budget`
		// is a POST-SETTLEMENT observation (D7/A8) — a receipt marked settled:false must
		// not carry it, and the ambiguous path must not even read the ledger for it.
		engine.postPendingSpend.mockRejectedValueOnce(new Error("tb: postTransfer socket reset"));
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
			() => governed.messages.create(PARAMS),
			SCOPE_OPTS,
		)) as { receipt: TrustReceipt };

		expect(receipt.settled).toBe(false);
		expect(receipt.budget).toBeUndefined();
		// The ambiguous settlement is still an attributed forensic record.
		expect(auditData(audit, "settlement_ambiguous").costCenter).toBe(COST_CENTER);
		// Only the authorize-time preflight ran — no pointless post-settle snapshot.
		expect(engine.lookupBalances).toHaveBeenCalledTimes(1);

		await governed.destroy();
	});

	it("carries the attribution into the VOID terminal's audit record (A1)", async () => {
		const engine = makeMockEngine({ balance: 4_000 });
		const audit = makeMockAudit();
		const client = {
			messages: { create: vi.fn(async () => Promise.reject(new Error("provider exploded"))) },
		};
		const governed = await trust(client, {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		await expect(
			withCostCenter(COST_CENTER, () => governed.messages.create(PARAMS), SCOPE_OPTS),
		).rejects.toThrow(/provider exploded/);

		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		// Attributed hold ⇒ attributed terminal record: forensic continuity.
		expect(auditData(audit, "llm_call_failed").costCenter).toBe(COST_CENTER);

		await governed.destroy();
	});

	it("names the envelope LABEL and the right remedy when the ledger rejects the hold", async () => {
		const engine = makeMockEngine({ balance: 10 });
		// What the T4 engine seam throws for an exhausted envelope: the derived
		// ACCOUNT id, because the label lives in the governor.
		engine.spendPending.mockRejectedValueOnce(
			new InsufficientBalanceError(`envelope:${ENVELOPE_ID}`, 999, 10),
		);
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const err = await withCostCenter(
			COST_CENTER,
			() => governed.messages.create(PARAMS),
			SCOPE_OPTS,
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(InsufficientBalanceError);
		const balanceErr = err as InsufficientBalanceError;
		// The operator reads `acme::research`, not a 39-digit account id.
		expect(balanceErr.userId).toBe(ENVELOPE_LABEL);
		expect(balanceErr.message).toContain(ENVELOPE_LABEL);
		// And is told the remedy that actually funds an envelope.
		expect(balanceErr.hint).toMatch(/allocateBudget/);
		expect(balanceErr.hint).not.toMatch(/Increase the budget in trust\(\) options/);
		// The ledger's own numbers survive the re-wrap.
		expect(balanceErr.required).toBe(999);
		expect(balanceErr.available).toBe(10);

		await governed.destroy();
	});

	it("leaves an UNATTRIBUTED ledger rejection byte-identical", async () => {
		const engine = makeMockEngine({ balance: 10 });
		const thrown = new InsufficientBalanceError("trust:hold", 999, 10);
		engine.spendPending.mockRejectedValueOnce(thrown);
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const err = await governed.messages.create(PARAMS).catch((e: unknown) => e);

		// The SAME error object, not a re-wrap: nothing on this path changed.
		expect(err).toBe(thrown);
		expect((err as InsufficientBalanceError).hint).toBe(
			"Increase the budget in trust() options or add funds via the ledger.",
		);

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// The decisive one: the settle happens on an emitter tick, OUTSIDE the scope
// ---------------------------------------------------------------------------

describe("stream settlement survives the scope exit", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `envelope-stream-${randomUUID()}`);
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

	it("attributes a MessageStream settle fired after withCostCenter returned", async () => {
		const engine = makeMockEngine({ balance: 6_000 });
		const audit = makeMockAudit();
		const stream = new ManualMessageStream();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(() => stream),
			},
		};
		const governed = await trust(client, {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		const handle = (await withCostCenter(
			COST_CENTER,
			() => governed.messages.stream(PARAMS),
			SCOPE_OPTS,
		)) as ManualMessageStream & { receipt: Promise<TrustReceipt> };

		// The hold was placed while the scope was live.
		expect(engine.spendPending.mock.calls[0]?.[0]).toMatchObject({ debitAccountId: ENVELOPE_ID });

		// THE PIN: we are outside every scope now. An `AsyncLocalStorage` read from
		// inside the terminal below would see exactly this — nothing.
		expect(getCurrentCostCenter()).toBeUndefined();

		stream.emit("streamEvent", { type: "message_start", message: { usage: { input_tokens: 10 } } });
		stream.emit("finalMessage", { usage: { input_tokens: 10, output_tokens: 5 } });
		stream.emit("end");

		const receipt = await handle.receipt;

		expect(receipt.settled).toBe(true);
		// The capture, not the store, is what the terminal read.
		expect(auditData(audit, "llm_call").costCenter).toBe(COST_CENTER);
		expect(receipt.budget).toMatchObject({ costCenter: COST_CENTER, remaining: 6_000 });

		await governed.destroy();
	});

	it("OMITS the budget block on an AMBIGUOUS stream settlement (settled:false)", async () => {
		const engine = makeMockEngine({ balance: 6_000 });
		engine.postPendingSpend.mockRejectedValueOnce(new Error("tb: postTransfer socket reset"));
		const audit = makeMockAudit();
		const stream = new ManualMessageStream();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(() => stream),
			},
		};
		const governed = await trust(client, {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		const handle = (await withCostCenter(
			COST_CENTER,
			() => governed.messages.stream(PARAMS),
			SCOPE_OPTS,
		)) as ManualMessageStream & { receipt: Promise<TrustReceipt> };

		stream.emit("streamEvent", { type: "message_start", message: { usage: { input_tokens: 10 } } });
		stream.emit("finalMessage", { usage: { input_tokens: 10, output_tokens: 5 } });
		stream.emit("end");

		const receipt = await handle.receipt;

		expect(receipt.settled).toBe(false);
		expect(receipt.budget).toBeUndefined();
		expect(auditData(audit, "settlement_ambiguous").costCenter).toBe(COST_CENTER);
		expect(engine.lookupBalances).toHaveBeenCalledTimes(1);

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// governAction — its own governor entry point, its own single ALS read
// ---------------------------------------------------------------------------

describe("governAction attribution", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `envelope-action-${randomUUID()}`);
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

	it("debits the envelope, stamps the record, and snapshots the receipt", async () => {
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
			() => governed.governAction({ kind: "tool_use", name: "search", cost: 25 }, async () => "ok"),
			SCOPE_OPTS,
		);

		expect(engine.spendPending.mock.calls[0]?.[0]).toMatchObject({ debitAccountId: ENVELOPE_ID });

		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBe(COST_CENTER);
		expect(ctx.budget_remaining).toBe(3_000);
		expect(ctx.budget_remaining_after).toBe(3_000 - 25);
		expect(ctx.budgetFractionRemaining).toBeCloseTo(0.3);

		expect(auditData(audit, "tool_use").costCenter).toBe(COST_CENTER);
		expect(receipt.budget).toMatchObject({ costCenter: COST_CENTER, remaining: 3_000 });

		await governed.destroy();
	});

	it("OMITS the budget block on an AMBIGUOUS action settlement (settled:false)", async () => {
		const engine = makeMockEngine({ balance: 3_000 });
		engine.postPendingSpend.mockRejectedValueOnce(new Error("tb: postTransfer socket reset"));
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
			() => governed.governAction({ kind: "tool_use", name: "search", cost: 25 }, async () => "ok"),
			SCOPE_OPTS,
		);

		expect(receipt.settled).toBe(false);
		expect(receipt.budget).toBeUndefined();
		expect(auditData(audit, "settlement_ambiguous").costCenter).toBe(COST_CENTER);
		expect(engine.lookupBalances).toHaveBeenCalledTimes(1);

		await governed.destroy();
	});

	it("throws pre-I/O on an attributed action with no parentUserId (D1)", async () => {
		const engine = makeMockEngine({ balance: 3_000 });
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			_engine: engine,
			_audit: makeMockAudit(),
		});
		const execute = vi.fn(async () => "ok");

		await expect(
			withCostCenter(
				COST_CENTER,
				() => governed.governAction({ kind: "tool_use", name: "search", cost: 25 }, execute),
				SCOPE_OPTS,
			),
		).rejects.toThrow(/parentUserId/);

		expect(execute).not.toHaveBeenCalled();
		expect(engine.spendPending).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("carries the attribution into the action's VOID terminal record (A1)", async () => {
		const engine = makeMockEngine({ balance: 3_000 });
		const audit = makeMockAudit();
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit,
		});

		await expect(
			withCostCenter(
				COST_CENTER,
				() =>
					governed.governAction({ kind: "tool_use", name: "search", cost: 25 }, async () => {
						throw new Error("tool exploded");
					}),
				SCOPE_OPTS,
			),
		).rejects.toThrow(/tool exploded/);

		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		// Attributed hold ⇒ attributed terminal record, on the void side too.
		expect(auditData(audit, "tool_use_failed").costCenter).toBe(COST_CENTER);

		await governed.destroy();
	});

	it("keeps an attributed ACTION out of the session budget (mixed traffic)", async () => {
		const engine = makeMockEngine({ balance: 50_000 });
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const attributed = await withCostCenter(
			COST_CENTER,
			() =>
				governed.governAction({ kind: "tool_use", name: "search", cost: 250 }, async () => "ok"),
			SCOPE_OPTS,
		);
		expect(attributed.receipt.budgetRemaining).toBe(100_000);

		const unattributed = await governed.governAction(
			{ kind: "tool_use", name: "search", cost: 250 },
			async () => "ok",
		);
		// The unattributed action was gated on a session remaining the envelope
		// spend never moved, and only its own cost came off it.
		expect(lastPolicyContext().budget_remaining).toBe(100_000);
		expect(unattributed.receipt.budgetRemaining).toBe(100_000 - 250);

		await governed.destroy();
	});

	it("leaves an unattributed action exactly as it was", async () => {
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
			{ kind: "tool_use", name: "search", cost: 25 },
			async () => "ok",
		);

		expect(engine.spendPending.mock.calls[0]?.[0].debitAccountId).toBeUndefined();
		expect(engine.lookupBalances).not.toHaveBeenCalled();
		const ctx = lastPolicyContext();
		expect(ctx.cost_center).toBeUndefined();
		expect(ctx.budget_remaining).toBe(100_000);
		expect(auditData(audit, "tool_use").costCenter).toBeUndefined();
		expect(receipt.budget).toBeUndefined();

		await governed.destroy();
	});
});

// ---------------------------------------------------------------------------
// Session accounting tracks SESSION-WALLET money only
// ---------------------------------------------------------------------------
//
// Whole-branch review, finding 3. `budgetSpent` and `inFlightHoldTotal` describe
// the per-session HOLDING wallet: they gate every unattributed call, they are what
// `receipt.budgetRemaining` reports, and `persistSpendLedger` carries `budgetSpent`
// across restarts as the `max(0, budget - budgetSpent)` seed of that wallet. An
// attributed hold debits the `(parent, costCenter)` ENVELOPE and never touches the
// holding wallet, so moving those counters for it charges the session for money it
// did not pay. The drift is fail-closed — over-deny, never loss — but silent: the
// session eventually hard-denies unattributed calls against a wallet TigerBeetle
// would still have held against, and it survives a restart, and nothing reports it.

describe("session accounting excludes envelope spend", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `envelope-session-${randomUUID()}`);
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

	it("keeps an attributed LLM call out of the session budget, and gates the next unattributed call on it", async () => {
		const engine = makeMockEngine({ balance: 50_000 });
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const attributed = (await withCostCenter(
			COST_CENTER,
			() => governed.messages.create(PARAMS),
			SCOPE_OPTS,
		)) as { receipt: TrustReceipt };

		expect(attributed.receipt.cost).toBeGreaterThan(0);
		// A settled attributed receipt still reports SESSION headroom — the envelope's
		// own number is `receipt.budget` — and this spend did not consume any of it.
		expect(attributed.receipt.budgetRemaining).toBe(100_000);
		expect(attributed.receipt.budget?.remaining).toBe(50_000);

		const unattributed = (await governed.messages.create(PARAMS)) as { receipt: TrustReceipt };

		// THE PIN: the unattributed call is gated on a session remaining the
		// attributed spend never moved.
		expect(lastPolicyContext().budget_remaining).toBe(100_000);
		expect(unattributed.receipt.budgetRemaining).toBe(100_000 - unattributed.receipt.cost);
		// Only session-wallet spend is persisted, because only it belongs in the next
		// run's `max(0, budget - budgetSpent)` holding-wallet seed.
		expect(await readPersistedSpend(vaultBase)).toBe(unattributed.receipt.cost);

		await governed.destroy();
	});

	it("keeps an attributed STREAM settle out of the session budget", async () => {
		const engine = makeMockEngine({ balance: 6_000 });
		const stream = new ManualMessageStream();
		const client = {
			messages: { create: vi.fn(), stream: vi.fn(() => stream) },
		};
		const governed = await trust(client, {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const handle = (await withCostCenter(
			COST_CENTER,
			() => governed.messages.stream(PARAMS),
			SCOPE_OPTS,
		)) as ManualMessageStream & { receipt: Promise<TrustReceipt> };

		stream.emit("finalMessage", { usage: { input_tokens: 10, output_tokens: 5 } });
		stream.emit("end");
		const receipt = await handle.receipt;

		// The stream terminal commits the spend on its own path (finalizeStreamSettle);
		// it must skip the session commit for the same reason the non-stream settle does.
		expect(receipt.settled).toBe(true);
		expect(receipt.budgetRemaining).toBe(100_000);
		expect(await readPersistedSpend(vaultBase)).toBeUndefined();

		await governed.destroy();
	});

	it("never persists a spend ledger for an attributed-only session", async () => {
		const engine = makeMockEngine({ balance: 50_000 });
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await withCostCenter(COST_CENTER, () => governed.messages.create(PARAMS), SCOPE_OPTS);

		// Nothing to record: the session wallet paid nothing. A ledger written here
		// would shrink the next run's holding-wallet seed by envelope money — and
		// `loadSpendLedger` has no way to tell the two apart.
		expect(await readPersistedSpend(vaultBase)).toBeUndefined();

		await governed.destroy();
	});

	it("restores nothing to the session on an attributed VOID terminal", async () => {
		const engine = makeMockEngine({ balance: 50_000 });
		const client = makeAnthropicMock();
		// Only the FIRST (attributed) call fails; the unattributed readout below has
		// to reach its own settle.
		client.messages.create.mockRejectedValueOnce(new Error("provider exploded"));
		const governed = await trust(client, {
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await expect(
			withCostCenter(COST_CENTER, () => governed.messages.create(PARAMS), SCOPE_OPTS),
		).rejects.toThrow(/provider exploded/);

		// The increment was skipped, so the matching decrement must be too: an
		// asymmetric release drives `inFlightHoldTotal` negative and hands the session
		// MORE headroom than its budget. An unattributed call is the readout.
		const { receipt } = (await governed.messages.create(PARAMS)) as { receipt: TrustReceipt };
		expect(lastPolicyContext().budget_remaining).toBe(100_000);
		expect(receipt.budgetRemaining).toBe(100_000 - receipt.cost);

		await governed.destroy();
	});
});
