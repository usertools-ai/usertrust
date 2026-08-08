// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `Governor.budgetContext(envelopes)` — the reporting-only scarcity read the OpenClaw
 * plugin injects into a turn's system prompt.
 *
 * TWO LAYERS, and the whole point of this file is that they are NOT the same layer:
 *
 *  - PRE-I/O validation THROWS. The cap, the per-descriptor cost-center door and the
 *    duplicate rejection are caller/config bugs — a plugin that asks for 200 envelopes
 *    or names the same one twice is misconfigured, and answering `[]` would hide that
 *    forever. The messages are asserted IDENTICAL to core `budgetContext`'s, because
 *    both call the same exported helpers; a second copy of either door is exactly what
 *    the assertion is there to catch.
 *  - THE LEDGER READ NEVER THROWS. dryRun, no engine, an engine with no
 *    `lookupBalances`, a rejected lookup, and a governor with no `parentUserId` all
 *    answer `[]` quietly. This is A8: a scarcity report must never gate, delay, or
 *    throw into the money path, and it is the MIRROR of `snapshotEnvelopeRemaining`'s
 *    post-settle policy — deliberately the OPPOSITE of A2's pre-gate refusal, which
 *    guards a number the policy gate decides on. Do not unify the two.
 *
 * The post-read mapping is outside the catch on purpose, so a bad clock still surfaces
 * as the caller bug it is rather than as an empty report.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import {
	budgetContext as coreBudgetContext,
	type EnvelopeDescriptor,
	envelopeStatusFrom,
	MAX_ENVELOPES,
} from "../../src/budget/context.js";
import type { TrustEngine } from "../../src/govern.js";
import { createGovernor, type Governor } from "../../src/headless.js";
import { TrustTBClient } from "../../src/ledger/client.js";
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
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const RESEARCH: EnvelopeDescriptor = {
	costCenter: "research",
	allocated: 10_000,
	periodStartMs: NOW - 4 * HOUR,
};
const VERIFICATION: EnvelopeDescriptor = {
	costCenter: "verification",
	allocated: 4_000,
	periodStartMs: NOW - 2 * HOUR,
	periodEndMs: NOW + 22 * HOUR,
};
const DESCRIPTORS = [RESEARCH, VERIFICATION];

const RESEARCH_ID = TrustTBClient.deriveCostCenterAccountId(PARENT, RESEARCH.costCenter);
const VERIFICATION_ID = TrustTBClient.deriveCostCenterAccountId(PARENT, VERIFICATION.costCenter);

interface EngineHandle extends TrustEngine {
	lookupBalances?: ReturnType<typeof vi.fn>;
}

/**
 * `balances` shapes the read seam:
 *   Map       → the balances TigerBeetle answers with (omitted id ⇒ implicit zero)
 *   "throw"   → the batch read fails
 *   undefined → the engine has NO `lookupBalances` at all
 */
function makeMockEngine(balances?: Map<bigint, number> | "throw"): EngineHandle {
	const engine: EngineHandle = {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		voidAllPending: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
	if (balances !== undefined) {
		engine.lookupBalances = vi.fn(async () => {
			if (balances === "throw") throw new Error("tb: lookupAccounts timed out");
			return balances;
		});
	}
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

/**
 * The message core `budgetContext` produces for the same bad input, read from a client
 * that would THROW if the call ever reached I/O — which is itself the pin that these
 * doors are pre-I/O on the core path too.
 */
async function coreRefusal(envelopes: EnvelopeDescriptor[]): Promise<string> {
	const client = {
		lookupBalances: () => {
			throw new Error("core budgetContext reached I/O for an input that must be refused pre-I/O");
		},
	} as unknown as TrustTBClient;
	try {
		await coreBudgetContext(client, PARENT, envelopes, NOW);
	} catch (err) {
		return (err as Error).message;
	}
	throw new Error("core budgetContext did not refuse the input");
}

describe("Governor.budgetContext", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-budget-context-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		process.env.USERTRUST_TEST = "1";
		vi.spyOn(Date, "now").mockReturnValue(NOW);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env.USERTRUST_TEST = "";
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	// `parentUserId: null` means "construct this governor with NO ledger identity" —
	// a default parameter could not express that, because passing `undefined`
	// explicitly is what selects a default.
	async function governorWith(
		engine: EngineHandle | null,
		parentUserId: string | null = PARENT,
	): Promise<Governor> {
		return await createGovernor({
			budget: 100_000,
			vaultBase,
			...(parentUserId !== null ? { parentUserId } : {}),
			...(engine !== null ? { _engine: engine } : { dryRun: true }),
			_audit: makeMockAudit(),
		});
	}

	// ── Layer 1: pre-I/O validation THROWS, with core's exact messages ──

	describe("pre-I/O validation (caller bugs — these throw)", () => {
		it("refuses a batch over MAX_ENVELOPES, before any ledger read", async () => {
			const engine = makeMockEngine(new Map());
			const gov = await governorWith(engine);

			const tooMany: EnvelopeDescriptor[] = Array.from(
				{ length: MAX_ENVELOPES + 1 },
				(_, i): EnvelopeDescriptor => ({
					costCenter: `cc-${i}`,
					allocated: 100,
					periodStartMs: NOW - HOUR,
				}),
			);

			await expect(gov.budgetContext(tooMany)).rejects.toThrow(await coreRefusal(tooMany));
			expect(engine.lookupBalances).not.toHaveBeenCalled();

			await gov.destroy();
		});

		it("refuses a descriptor whose costCenter fails the ledger door", async () => {
			const engine = makeMockEngine(new Map());
			const gov = await governorWith(engine);

			const bad: EnvelopeDescriptor[] = [{ ...RESEARCH, costCenter: "not a cost center" }];

			await expect(gov.budgetContext(bad)).rejects.toThrow(await coreRefusal(bad));
			expect(engine.lookupBalances).not.toHaveBeenCalled();

			await gov.destroy();
		});

		it("refuses a duplicate costCenter", async () => {
			const engine = makeMockEngine(new Map());
			const gov = await governorWith(engine);

			// Two entries resolve to ONE envelope account, so a duplicate can only be
			// caller confusion — never two distinct envelopes to report on.
			const dupes = [RESEARCH, VERIFICATION, { ...RESEARCH }];

			await expect(gov.budgetContext(dupes)).rejects.toThrow(await coreRefusal(dupes));
			expect(engine.lookupBalances).not.toHaveBeenCalled();

			await gov.destroy();
		});
	});

	// ── Layer 2: every read failure is quiet (A8) ──

	describe("read failures degrade to [] (A8 — reporting only)", () => {
		it("answers [] in dryRun, where there is no engine to read", async () => {
			// dryRun and "no engine" are ONE leg through `createGovernor`: a dry-run
			// governor builds no engine at all, and a non-dry-run one always has one.
			const gov = await governorWith(null);

			await expect(gov.budgetContext(DESCRIPTORS)).resolves.toEqual([]);

			await gov.destroy();
		});

		it("answers [] when the engine cannot read balances at all", async () => {
			const engine = makeMockEngine();
			expect(engine.lookupBalances).toBeUndefined();
			const gov = await governorWith(engine);

			await expect(gov.budgetContext(DESCRIPTORS)).resolves.toEqual([]);

			await gov.destroy();
		});

		it("answers [] when the batch read rejects", async () => {
			const engine = makeMockEngine("throw");
			const gov = await governorWith(engine);

			await expect(gov.budgetContext(DESCRIPTORS)).resolves.toEqual([]);
			expect(engine.lookupBalances).toHaveBeenCalledOnce();

			await gov.destroy();
		});

		it("answers [] when the governor has no parentUserId", async () => {
			// No ledger identity means no envelope account is derivable — and, unlike
			// `authorize()`'s D1 throw, nothing is about to spend, so there is nothing to
			// refuse. The report is simply empty.
			const engine = makeMockEngine(new Map([[RESEARCH_ID, 3_400]]));
			const gov = await governorWith(engine, null);

			await expect(gov.budgetContext(DESCRIPTORS)).resolves.toEqual([]);
			expect(engine.lookupBalances).not.toHaveBeenCalled();

			await gov.destroy();
		});
	});

	// ── The happy path ──

	describe("the read", () => {
		it("derives every envelope account and reads them in ONE batched call", async () => {
			const engine = makeMockEngine(
				new Map([
					[RESEARCH_ID, 3_400],
					[VERIFICATION_ID, 3_560],
				]),
			);
			const gov = await governorWith(engine);

			await gov.budgetContext(DESCRIPTORS);

			expect(engine.lookupBalances).toHaveBeenCalledOnce();
			// Derived, never looked up — and in descriptor order, which is what lets the
			// mapping below pair a balance with its descriptor by index.
			expect(engine.lookupBalances?.mock.calls[0]?.[0]).toEqual([RESEARCH_ID, VERIFICATION_ID]);

			await gov.destroy();
		});

		it("returns exactly `envelopeStatusFrom` on the same inputs — one money-math source", async () => {
			const engine = makeMockEngine(
				new Map([
					[RESEARCH_ID, 3_400],
					[VERIFICATION_ID, 3_560],
				]),
			);
			const gov = await governorWith(engine);

			const statuses = await gov.budgetContext(DESCRIPTORS);

			// Not a hand-recomputed expectation: the SHARED helper is the expectation, so
			// a second copy of the clamp/runway arithmetic in the governor would fail here.
			expect(statuses).toEqual([
				envelopeStatusFrom(RESEARCH, 3_400, NOW),
				envelopeStatusFrom(VERIFICATION, 3_560, NOW),
			]);

			await gov.destroy();
		});

		it("reads an envelope TigerBeetle omits as an implicit zero", async () => {
			// Never allocated and fully reclaimed are the same observable state — the
			// batch read omits the account and this reports 0, exactly as core does.
			const engine = makeMockEngine(new Map([[RESEARCH_ID, 3_400]]));
			const gov = await governorWith(engine);

			const statuses = await gov.budgetContext(DESCRIPTORS);

			expect(statuses[1]).toEqual(envelopeStatusFrom(VERIFICATION, 0, NOW));
			expect(statuses[1]?.remaining).toBe(0);
			expect(statuses[1]?.fraction).toBe(0);

			await gov.destroy();
		});

		it("lets a bad clock on a descriptor propagate — the mapping is OUTSIDE the catch", async () => {
			// The catch covers the awaited `lookupBalances` and nothing else. A non-finite
			// `periodStartMs` is a caller bug that `computeRunway` refuses to paper over,
			// and swallowing it into `[]` would silently drop every OTHER envelope's
			// report too — the caller would read "no envelopes" and never learn why.
			const engine = makeMockEngine(new Map([[RESEARCH_ID, 3_400]]));
			const gov = await governorWith(engine);

			await expect(
				gov.budgetContext([{ ...RESEARCH, periodStartMs: Number.NaN }]),
			).rejects.toThrow();
			expect(engine.lookupBalances).toHaveBeenCalledOnce();

			await gov.destroy();
		});
	});
});
