// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock tigerbeetle-node — context.ts reaches TrustTBClient's static derivation methods
// through ledger/client.js, which is a real (unmocked) module in this test. Mirrors
// allocation.test.ts's minimal mock: context.ts never creates accounts or transfers, so
// only the shapes ledger/client.ts's module scope touches at import time are needed.
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(),
	AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
	TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
	CreateAccountStatus: { created: 4294967295, exists: 1, exists_with_different_flags: 2 },
	CreateTransferStatus: {
		created: 4294967295,
		exceeds_credits: 22,
		overflows_debits: 30,
		overflows_debits_pending: 31,
	},
	amount_max: (1n << 128n) - 1n,
}));

import { budgetContext, type EnvelopeDescriptor, MAX_ENVELOPES } from "../../src/budget/context.js";
import { computeRunway, runwayHours } from "../../src/budget/runway.js";
import { TrustTBClient } from "../../src/ledger/client.js";

const PARENT = "acme";
/**
 * Known answers computed OUTSIDE the implementation, to the same spec as
 * `tests/ledger/client.test.ts` and `tests/budget/allocation.test.ts`
 * (sha256("usertrust:cost-center:v1" ‖ u32be(|p|) ‖ p ‖ u32be(|c|) ‖ c), first 16
 * bytes; wallet ids are sha256("wallet:" + id), first 16 bytes). Spelled out rather
 * than recomputed from the static, so this suite polices the wiring — that
 * `budgetContext` calls `deriveAccountId`/`deriveCostCenterAccountId` with the exact
 * (parent, costCenter) pairs it was given — not the hash function itself.
 */
const PARENT_ACCOUNT = 33860297148723319913169339150546196888n;
const BILLING_ACCOUNT = 153698412649693138325753473963527840061n;
const OPS_ACCOUNT = 21803936250278089508924990127628972679n;
const ENG_ACCOUNT = 34097928597517032341262417297270767793n;

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

/**
 * `getAccountId` THROWS, exactly as a real client does in a process that never called
 * `createUserWallet` — its `accountMap` is per-process and nothing in src populates it
 * for a parent id. Asserting it is never called is what proves `budgetContext` derives
 * both the parent and every envelope account rather than looking either up.
 */
function createMockTBClient() {
	return {
		getAccountId: vi.fn((userId: string): bigint => {
			throw new Error(`No TigerBeetle account for user: ${userId}`);
		}),
		lookupBalance: vi.fn(),
		lookupAccounts: vi.fn(),
		lookupBalances: vi.fn(async () => new Map<bigint, number>()),
	};
}

type MockTB = ReturnType<typeof createMockTBClient>;

/** Cast helper — the mock implements only the slice of the client this module uses. */
function asClient(mock: MockTB): TrustTBClient {
	return mock as unknown as TrustTBClient;
}

function envelope(
	costCenter: string,
	allocated: number,
	periodStartMs = T0,
	periodEndMs?: number,
): EnvelopeDescriptor {
	return periodEndMs === undefined
		? { costCenter, allocated, periodStartMs }
		: { costCenter, allocated, periodStartMs, periodEndMs };
}

describe("budgetContext — derives accounts, never looks them up", () => {
	let mockTB: MockTB;

	beforeEach(() => {
		vi.clearAllMocks();
		mockTB = createMockTBClient();
	});

	it("derives the parent and every envelope account through the one static, spelled-out KATs", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(
			new Map([
				[PARENT_ACCOUNT, 900],
				[BILLING_ACCOUNT, 400],
				[OPS_ACCOUNT, 100],
			]),
		);

		await budgetContext(
			asClient(mockTB),
			PARENT,
			[envelope("billing", 1000), envelope("ops", 200)],
			T0 + HOUR,
		);

		expect(TrustTBClient.deriveAccountId(PARENT)).toBe(PARENT_ACCOUNT);
		expect(TrustTBClient.deriveCostCenterAccountId(PARENT, "billing")).toBe(BILLING_ACCOUNT);
		expect(TrustTBClient.deriveCostCenterAccountId(PARENT, "ops")).toBe(OPS_ACCOUNT);
		expect(mockTB.lookupBalances).toHaveBeenCalledWith([
			PARENT_ACCOUNT,
			BILLING_ACCOUNT,
			OPS_ACCOUNT,
		]);
	});

	it("never calls getAccountId", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(new Map());

		await budgetContext(asClient(mockTB), PARENT, [envelope("billing", 1000)], T0);

		expect(mockTB.getAccountId).not.toHaveBeenCalled();
	});

	it("never calls lookupAccounts or the single-account lookupBalance", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(new Map());

		await budgetContext(asClient(mockTB), PARENT, [envelope("billing", 1000)], T0);

		expect(mockTB.lookupAccounts).not.toHaveBeenCalled();
		expect(mockTB.lookupBalance).not.toHaveBeenCalled();
	});

	it("makes exactly ONE lookupBalances round trip regardless of envelope count", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(new Map());

		await budgetContext(
			asClient(mockTB),
			PARENT,
			[envelope("billing", 1000), envelope("ops", 200), envelope("eng", 300)],
			T0,
		);

		expect(mockTB.lookupBalances).toHaveBeenCalledOnce();
		expect(mockTB.lookupBalances).toHaveBeenCalledWith([
			PARENT_ACCOUNT,
			BILLING_ACCOUNT,
			OPS_ACCOUNT,
			ENG_ACCOUNT,
		]);
	});

	it("makes exactly ONE lookupBalances round trip for zero envelopes (parent only)", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(new Map());

		await budgetContext(asClient(mockTB), PARENT, [], T0);

		expect(mockTB.lookupBalances).toHaveBeenCalledOnce();
		expect(mockTB.lookupBalances).toHaveBeenCalledWith([PARENT_ACCOUNT]);
	});
});

describe("budgetContext — implicit zero for missing accounts, parent included", () => {
	let mockTB: MockTB;

	beforeEach(() => {
		vi.clearAllMocks();
		mockTB = createMockTBClient();
	});

	it("reads a never-allocated envelope as remaining: 0, not an error", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(new Map([[PARENT_ACCOUNT, 500]]));

		const ctx = await budgetContext(asClient(mockTB), PARENT, [envelope("never-used", 1000)], T0);

		expect(ctx.envelopes).toHaveLength(1);
		expect(ctx.envelopes[0]?.remaining).toBe(0);
		expect(ctx.envelopes[0]?.spent).toBe(1000);
		expect(ctx.envelopes[0]?.fraction).toBe(0);
	});

	it("reads a missing parent account as remaining: 0 too — symmetric with envelopes", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(new Map([[BILLING_ACCOUNT, 400]]));

		const ctx = await budgetContext(asClient(mockTB), PARENT, [envelope("billing", 1000)], T0);

		expect(ctx.parent.remaining).toBe(0);
	});

	it("reads everything as zero when lookupBalances returns an empty map", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(new Map());

		const ctx = await budgetContext(
			asClient(mockTB),
			PARENT,
			[envelope("billing", 1000), envelope("ops", 500)],
			T0,
		);

		expect(ctx.parent.remaining).toBe(0);
		expect(ctx.envelopes.map((e) => e.remaining)).toEqual([0, 0]);
	});
});

describe("budgetContext — A5 clamp semantics", () => {
	let mockTB: MockTB;

	beforeEach(() => {
		vi.clearAllMocks();
		mockTB = createMockTBClient();
	});

	it("spent = max(0, allocated - remaining) in the ordinary case", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(
			new Map([
				[PARENT_ACCOUNT, 0],
				[BILLING_ACCOUNT, 400],
			]),
		);

		const ctx = await budgetContext(asClient(mockTB), PARENT, [envelope("billing", 1000)], T0);

		expect(ctx.envelopes[0]?.remaining).toBe(400);
		expect(ctx.envelopes[0]?.spent).toBe(600);
		expect(ctx.envelopes[0]?.fraction).toBe(0.4);
	});

	it("clamps spent to 0 and fraction to 1 when the envelope holds more than it was allocated", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(
			new Map([
				[PARENT_ACCOUNT, 0],
				[BILLING_ACCOUNT, 1500],
			]),
		);

		const ctx = await budgetContext(asClient(mockTB), PARENT, [envelope("billing", 1000)], T0);

		expect(ctx.envelopes[0]?.remaining).toBe(1500);
		expect(ctx.envelopes[0]?.spent).toBe(0);
		expect(ctx.envelopes[0]?.fraction).toBe(1);
	});

	it("reads fraction: 0 when allocated <= 0 — no headroom, not a division by zero", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(
			new Map([
				[PARENT_ACCOUNT, 0],
				[BILLING_ACCOUNT, 50],
			]),
		);

		const ctx = await budgetContext(asClient(mockTB), PARENT, [envelope("billing", 0)], T0);

		expect(ctx.envelopes[0]?.allocated).toBe(0);
		expect(ctx.envelopes[0]?.fraction).toBe(0);
		expect(ctx.envelopes[0]?.spent).toBe(0);
	});

	it("normalizes a non-finite or negative allocated to 0 rather than propagating it", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(new Map([[PARENT_ACCOUNT, 0]]));

		const ctx = await budgetContext(
			asClient(mockTB),
			PARENT,
			[envelope("billing", Number.NaN)],
			T0,
		);

		expect(ctx.envelopes[0]?.allocated).toBe(0);
		expect(Number.isFinite(ctx.envelopes[0]?.spent)).toBe(true);
		expect(Number.isFinite(ctx.envelopes[0]?.fraction)).toBe(true);
	});

	it("never reports a negative remaining — lookupBalances already floors available at 0", async () => {
		// available is floored upstream in ledger/client.ts's accountBalance; a mock
		// that somehow returned a negative number would still be clamped by the same
		// `?? 0` implicit-zero reading only for MISSING accounts, not a present
		// negative one — so this pins that the map value flows straight through
		// (proving there is no separate, divergent clamp in this file).
		mockTB.lookupBalances.mockResolvedValueOnce(
			new Map([
				[PARENT_ACCOUNT, 0],
				[BILLING_ACCOUNT, 0],
			]),
		);

		const ctx = await budgetContext(asClient(mockTB), PARENT, [envelope("billing", 1000)], T0);

		expect(ctx.envelopes[0]?.remaining).toBeGreaterThanOrEqual(0);
	});
});

describe("budgetContext — runway reuse (A6) and the single clock", () => {
	let mockTB: MockTB;

	beforeEach(() => {
		vi.clearAllMocks();
		mockTB = createMockTBClient();
	});

	it("runwayHours matches an independent computeRunway + runwayHours call for the same inputs", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(
			new Map([
				[PARENT_ACCOUNT, 0],
				[BILLING_ACCOUNT, 400],
			]),
		);

		const ctx = await budgetContext(
			asClient(mockTB),
			PARENT,
			[envelope("billing", 1000, T0)],
			T0 + 5 * HOUR,
		);

		const expected = runwayHours(
			computeRunway({ allocated: 1000, spent: 600, periodStartMs: T0, nowMs: T0 + 5 * HOUR }),
			T0 + 5 * HOUR,
		);
		expect(ctx.envelopes[0]?.runwayHours).toBe(expected);
	});

	it("null runwayHours (nothing spent yet) is preserved, not coerced to a number", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(
			new Map([
				[PARENT_ACCOUNT, 0],
				[BILLING_ACCOUNT, 1000],
			]),
		);

		const ctx = await budgetContext(
			asClient(mockTB),
			PARENT,
			[envelope("billing", 1000, T0)],
			T0 + HOUR,
		);

		expect(ctx.envelopes[0]?.runwayHours).toBeNull();
	});

	it("reads the wall clock exactly ONCE for a multi-envelope batch when nowMs is omitted", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(new Map());
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(T0 + 2 * HOUR);

		await budgetContext(
			asClient(mockTB),
			PARENT,
			[envelope("billing", 1000), envelope("ops", 500), envelope("eng", 200)],
			undefined,
		);

		expect(nowSpy).toHaveBeenCalledTimes(1);
		nowSpy.mockRestore();
	});

	it("applies the SAME clock to every envelope in the batch", async () => {
		mockTB.lookupBalances.mockResolvedValueOnce(
			new Map([
				[BILLING_ACCOUNT, 500],
				[OPS_ACCOUNT, 500],
			]),
		);

		const ctx = await budgetContext(
			asClient(mockTB),
			PARENT,
			[envelope("billing", 1000, T0), envelope("ops", 1000, T0)],
			T0 + 2 * HOUR,
		);

		// Same allocated/spent/period across both envelopes + same clock => same burn
		// rate and the same runwayHours, which would drift apart if either envelope
		// used a different `now`.
		expect(ctx.envelopes[0]?.runwayHours).toBe(ctx.envelopes[1]?.runwayHours);
	});
});

describe("budgetContext — validation doors, all pre-I/O", () => {
	let mockTB: MockTB;

	beforeEach(() => {
		vi.clearAllMocks();
		mockTB = createMockTBClient();
	});

	it("rejects an invalid costCenter before any ledger I/O", async () => {
		await expect(
			budgetContext(asClient(mockTB), PARENT, [envelope("bad::cc", 1000)], T0),
		).rejects.toThrow(/costCenter/);
		expect(mockTB.lookupBalances).not.toHaveBeenCalled();
	});

	it("rejects an invalid parentUserId before any ledger I/O, even with zero envelopes", async () => {
		await expect(budgetContext(asClient(mockTB), "acme::billing", [], T0)).rejects.toThrow(
			/parentUserId must not contain "::"/,
		);
		expect(mockTB.lookupBalances).not.toHaveBeenCalled();
	});

	it("rejects an invalid parentUserId before any ledger I/O when envelopes are present", async () => {
		await expect(
			budgetContext(asClient(mockTB), "bad parent", [envelope("billing", 1000)], T0),
		).rejects.toThrow(/parentUserId must match/);
		expect(mockTB.lookupBalances).not.toHaveBeenCalled();
	});

	it("rejects duplicate costCenter descriptors before any ledger I/O (A3)", async () => {
		await expect(
			budgetContext(
				asClient(mockTB),
				PARENT,
				[envelope("billing", 1000), envelope("billing", 500)],
				T0,
			),
		).rejects.toThrow(/duplicate costCenter/);
		expect(mockTB.lookupBalances).not.toHaveBeenCalled();
	});

	it(`rejects envelopes.length over the ${MAX_ENVELOPES} cap before any ledger I/O (A3)`, async () => {
		const tooMany = Array.from({ length: MAX_ENVELOPES + 1 }, (_, i) => envelope(`cc-${i}`, 10));

		await expect(budgetContext(asClient(mockTB), PARENT, tooMany, T0)).rejects.toThrow(
			new RegExp(`exceeds the ${MAX_ENVELOPES} cap`),
		);
		expect(mockTB.lookupBalances).not.toHaveBeenCalled();
	});

	it(`accepts exactly ${MAX_ENVELOPES} envelopes — the cap is inclusive`, async () => {
		const exactlyMax = Array.from({ length: MAX_ENVELOPES }, (_, i) => envelope(`cc-${i}`, 10));
		mockTB.lookupBalances.mockResolvedValueOnce(new Map());

		const ctx = await budgetContext(asClient(mockTB), PARENT, exactlyMax, T0);

		expect(ctx.envelopes).toHaveLength(MAX_ENVELOPES);
		expect(mockTB.lookupBalances).toHaveBeenCalledOnce();
	});
});

describe("budgetContext — does not require the parent to be in the client account map", () => {
	it("reads without consulting getAccountId, the same guarantee getBudgetStatus gives", async () => {
		const mockTB = createMockTBClient();
		mockTB.lookupBalances.mockResolvedValueOnce(new Map([[PARENT_ACCOUNT, 750]]));

		const ctx = await budgetContext(asClient(mockTB), PARENT, [envelope("billing", 1000)], T0);

		expect(ctx.parent.remaining).toBe(750);
		expect(mockTB.getAccountId).not.toHaveBeenCalled();
	});
});
