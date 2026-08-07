// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * budget/context.ts — `budgetContext()`, the scarcity READ API for an agent's own envelopes.
 *
 * This is the PULL half of visibility (the design's other half, `receipt.budget`, is a
 * PUSH on the settled receipt — see `govern.ts`/`headless.ts`). A caller who wants to
 * see where it stands across every envelope it holds — before deciding whether to make
 * another call, not after one already happened — awaits this once.
 *
 * READ-ONLY, LIKE `getBudgetStatus`: no transfer, so no `resolveAccounts` and no
 * self-transfer refusal (there is nothing to refuse — a read cannot debit and credit the
 * same account). Unlike `getBudgetStatus`, which reads one cost center per call via
 * `costCenterBalance` (up to two `lookupAccounts`/`lookupBalance` round trips), this reads
 * an entire batch — the parent plus every envelope — in exactly ONE
 * {@link TrustTBClient.lookupBalances} round trip.
 *
 * DERIVE, NEVER LOOK UP: this is the FOURTH call site of the one-static invariant
 * (`createCostCenterWallet`, `resolveAccounts`, `getBudgetStatus`, and now this) —
 * `TrustTBClient.deriveAccountId` for the parent, `TrustTBClient.deriveCostCenterAccountId`
 * for each envelope. Never `getAccountId`, never a cache, never a hand-rolled join of the
 * `parent::costCenter` label. A join or a cache here would be a second source of truth
 * that a client in another process does not share — see AGENTS.md's "Budget account ids
 * are derived, never looked up."
 *
 * OBSERVATIONAL, NOT AUTHORITATIVE (A8): every number this returns is a snapshot read at
 * call time. It can race a concurrent settlement — a hold posting, another caller
 * spending from the same envelope, a reclaim — landing between the ledger read and the
 * caller observing the returned object. That is by design, the same way any balance read
 * races the ledger it reads from. It reports "what the ledger holds right now", never "the
 * result of a specific spend", and it is not part of the audit chain: `packages/verify`
 * never sees this shape, and nothing here is a hash pre-image. See `receipt.budget` for
 * the analogous push-side snapshot and its own read-failure-degrades-safely contract.
 */

import { TrustTBClient } from "../ledger/client.js";
import { parentUserIdRefusal } from "../shared/ids.js";
import { costCenterUserId } from "./allocation.js";
import { computeRunway, runwayHours } from "./runway.js";

/**
 * Amplification guard on the batch size. `envelopes` drives both the id list handed to
 * `lookupBalances` and a `computeRunway` call per entry — an unbounded array turns one
 * `budgetContext` call into unbounded ledger and CPU work per caller. 128 is generous for
 * a single agent's own envelope set and arbitrary beyond that; it is named so a future
 * adjustment has exactly one place to change, never a magic number re-typed at the door.
 */
export const MAX_ENVELOPES = 128;

/**
 * One envelope to read, as the caller's own bookkeeping — there is no cost-center
 * registry (see `budget/allocation.ts`'s module doc), so `allocated` and the period
 * bounds are supplied here, not read from the ledger. Mirrors `getBudgetStatus`'s
 * per-call params, batched.
 */
export interface EnvelopeDescriptor {
	costCenter: string;
	/** UT. Non-finite or negative reads as zero — see {@link EnvelopeStatus} below. */
	allocated: number;
	/** Epoch ms. Must be finite — `computeRunway` throws otherwise; see its doc comment. */
	periodStartMs: number;
	/** Epoch ms when present; absent means an open-ended period. */
	periodEndMs?: number | undefined;
}

/**
 * One envelope's scarcity snapshot.
 *
 * CLAMP SEMANTICS (A5), pinned by tests — read this before touching the arithmetic below:
 *  - `remaining` is the envelope's ledger `available` balance at read time, or `0` when
 *    the envelope has no TigerBeetle account at all (never allocated, or fully reclaimed
 *    — the same implicit-zero equivalence `getBudgetStatus` documents). It can never be
 *    negative: `lookupBalances` already floors `available` at 0 upstream, in the ONE
 *    place that computation lives (`ledger/client.ts`'s `accountBalance`).
 *  - `spent = max(0, allocated − remaining)` — the same clamp `getBudgetStatus` applies,
 *    for the same reason: an over-funded envelope (funded outside `allocateBudget`, which
 *    the LEDGER INVARIANT in `allocation.ts` calls a breach) must not invert into negative
 *    spend.
 *  - `fraction = clamp(remaining / allocated, 0, 1)`, and `allocated <= 0` reads as
 *    `fraction: 0` — no headroom, not a division by zero. A non-finite or negative
 *    `allocated` on the descriptor normalizes to `0` before any of the above runs (the
 *    same normalization `runway.ts`'s `normalizeAllocated` applies), so a malformed
 *    descriptor cannot produce a non-finite `spent`, `remaining`, or `fraction` — Runway
 *    TOTALITY holds for this whole batch, not only for what `computeRunway` itself
 *    returns.
 *
 * RUNWAY TYPING (A6): `runwayHours` follows `budget/runway.ts`'s `runwayHours()` function
 * verbatim — `number | null`, `null` meaning "not projectable" (nothing spent yet in the
 * window). This is a DIFFERENT convention from the `budgetRunwayHours` POLICY field
 * `govern.ts`/`headless.ts` assert into `PolicyContext` (which uses explicit `undefined`
 * for "no D4 allocation metadata was supplied to the active scope"). Two surfaces, two
 * pre-existing conventions — do not unify them.
 */
export interface EnvelopeStatus {
	costCenter: string;
	/** Normalized per the clamp semantics above — never non-finite or negative. */
	allocated: number;
	spent: number;
	remaining: number;
	/** 0..1 inclusive. */
	fraction: number;
	runwayHours: number | null;
}

/** The full scarcity picture `budgetContext` returns: the parent wallet plus every
 * requested envelope, all read from the SAME `lookupBalances` round trip. */
export interface BudgetContext {
	/** `remaining` here is the parent's own ledger `available` balance — implicit zero
	 * (no account) reads as 0, symmetric with every envelope below. There is no
	 * `allocated`/`spent`/`fraction` for the parent: those are envelope-relative
	 * concepts and the parent is not itself an envelope. */
	parent: { remaining: number };
	envelopes: EnvelopeStatus[];
}

/** Non-finite or negative allocations read as zero. Mirrors `runway.ts`'s
 * `normalizeAllocated`, which is module-private there — duplicated here (not imported)
 * because this file's `spent`/`fraction` are computed from the caller-truth `remaining`
 * BEFORE `computeRunway` ever normalizes anything, so this module needs its own safe
 * `allocated` a step earlier than `computeRunway` provides one. */
function safeAllocated(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** `Math.min(1, Math.max(0, value))`, named for what A5 calls it — `fraction` can
 * legitimately exceed 1 before clamping (an over-funded envelope's raw
 * `remaining / allocated`), so the clamp needs both bounds, unlike `spent`'s
 * one-sided floor. */
function clampFraction(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * The amplification guard, on its own so a second batch reader enforces the SAME cap
 * with the SAME message rather than re-typing {@link MAX_ENVELOPES} at its own door.
 * Cheapest check first: it runs before any per-entry work.
 *
 * @throws Error when `envelopes.length` exceeds {@link MAX_ENVELOPES}.
 */
export function assertEnvelopeCap(envelopes: EnvelopeDescriptor[]): void {
	if (envelopes.length > MAX_ENVELOPES) {
		throw new Error(
			`budgetContext: envelopes.length (${envelopes.length}) exceeds the ${MAX_ENVELOPES} cap`,
		);
	}
}

/**
 * Per-descriptor validation: every `costCenter` passes {@link costCenterUserId}'s door
 * (reused, never a second charset check), and no two descriptors name the same envelope
 * — two entries would resolve to one account, so a duplicate can only mean caller
 * confusion, never two distinct envelopes to report.
 *
 * Split from {@link assertEnvelopeCap} because the two doors are not adjacent for every
 * caller: `budgetContext` below refuses a bad `parentUserId` between them, and
 * `Governor.budgetContext` returns quietly when the governor has no `parentUserId` at
 * all (there is nothing to validate a cost center against).
 *
 * @throws Error when any `costCenter` (or `parentUserId`) fails {@link costCenterUserId},
 * or when `envelopes` contains a duplicate `costCenter`.
 */
export function assertDistinctValidCostCenters(
	parentUserId: string,
	envelopes: EnvelopeDescriptor[],
): void {
	const seen = new Set<string>();
	for (const envelope of envelopes) {
		// Throws pre-I/O on an invalid costCenter (or, redundantly but harmlessly, on
		// an already-checked parentUserId).
		costCenterUserId(parentUserId, envelope.costCenter);
		if (seen.has(envelope.costCenter)) {
			throw new Error(`budgetContext: duplicate costCenter descriptor: "${envelope.costCenter}"`);
		}
		seen.add(envelope.costCenter);
	}
}

/**
 * The ONE place one envelope's scarcity numbers are computed, given its ledger
 * `remaining` and the batch's single clock reading. Every clamp semantic documented on
 * {@link EnvelopeStatus} lives here and nowhere else — a second reader of the same
 * ledger balances (`Governor.budgetContext`) calls this rather than repeating the
 * arithmetic, so `spent`/`fraction`/`runwayHours` can never drift between the two
 * surfaces.
 *
 * `remaining` is the caller's truth: `0` stands for "no TigerBeetle account", which is
 * exactly what `lookupBalances` omitting an id means.
 *
 * @throws Error (from `computeRunway`) when `periodStartMs` or `nowMs` is not finite —
 * a bad clock is a caller bug, and substituting a value would fabricate a runway.
 */
export function envelopeStatusFrom(
	descriptor: EnvelopeDescriptor,
	remaining: number,
	nowMs: number,
): EnvelopeStatus {
	const allocated = safeAllocated(descriptor.allocated);
	const spent = Math.max(0, allocated - remaining);
	const fraction = allocated <= 0 ? 0 : clampFraction(remaining / allocated);

	// Reused, not reimplemented: computeRunway/runwayHours already own the burn-rate
	// and projection math (and its own TOTALITY guarantees) — this call exists only
	// to get runwayHours, since remaining/spent/fraction above are already final.
	const runway = computeRunway({
		allocated,
		spent,
		periodStartMs: descriptor.periodStartMs,
		periodEndMs: descriptor.periodEndMs,
		nowMs,
	});

	return {
		costCenter: descriptor.costCenter,
		allocated,
		spent,
		remaining,
		fraction,
		runwayHours: runwayHours(runway, nowMs),
	};
}

/**
 * Read the parent's balance and every requested envelope's scarcity, in one round trip.
 *
 * VALIDATION DOORS, all pre-I/O (A3): `parentUserId` is refused by the same
 * `parentUserIdRefusal` every other budget door uses — checked once up front so an empty
 * `envelopes` array cannot skip it (a bad parent id still drives the parent's own account
 * derivation and read below). Every descriptor's `costCenter` is validated through
 * {@link costCenterUserId} — the same per-entry door `getBudgetStatus` uses, reused rather
 * than re-implementing the charset check — which incidentally re-validates `parentUserId`
 * per entry too (cheap and pure; harmless once the top-level check has already passed).
 * A duplicate `costCenter` across descriptors throws: two entries resolve to the same
 * envelope account, so a duplicate could only mean caller confusion, never two distinct
 * envelopes to report. `envelopes.length` over {@link MAX_ENVELOPES} throws before any of
 * the above runs — the amplification guard fires first, cheapest check first.
 *
 * @throws Error when `parentUserId` fails `parentUserIdRefusal`, any `costCenter` fails
 * {@link costCenterUserId}'s validation, `envelopes` contains a duplicate `costCenter`, or
 * `envelopes.length` exceeds {@link MAX_ENVELOPES} — all before any ledger I/O.
 * @throws Error (from `computeRunway`) when a descriptor's `periodStartMs`, or `nowMs`
 * (explicit or the wall clock read here), is not finite — see AGENTS.md: "a bad clock is a
 * caller bug, and silently substituting a value would fabricate a runway." This check runs
 * per-entry inside the batch, after the `lookupBalances` read, mirroring `getBudgetStatus`.
 */
export async function budgetContext(
	tb: TrustTBClient,
	parentUserId: string,
	envelopes: EnvelopeDescriptor[],
	nowMs?: number,
): Promise<BudgetContext> {
	assertEnvelopeCap(envelopes);

	const parentRefusal = parentUserIdRefusal(parentUserId);
	if (parentRefusal !== null) {
		throw new Error(`budget: parentUserId ${parentRefusal}`);
	}

	assertDistinctValidCostCenters(parentUserId, envelopes);

	// ONE clock read for the whole batch — every envelope's runway is computed against
	// the same instant, so two envelopes in one response never disagree about "now".
	const clock = nowMs ?? Date.now();

	const parentAccount = TrustTBClient.deriveAccountId(parentUserId);
	const childAccounts = envelopes.map((envelope) =>
		TrustTBClient.deriveCostCenterAccountId(parentUserId, envelope.costCenter),
	);

	// The ONE round trip: parent + every envelope, together. `lookupBalances` dedupes
	// its input and omits any account TigerBeetle does not return — that omission IS
	// the implicit-zero reading below, for the parent exactly as for every envelope.
	const balances = await tb.lookupBalances([parentAccount, ...childAccounts]);

	const envelopeStatuses: EnvelopeStatus[] = envelopes.map((envelope, i) =>
		envelopeStatusFrom(envelope, balances.get(childAccounts[i] as bigint) ?? 0, clock),
	);

	return {
		parent: { remaining: balances.get(parentAccount) ?? 0 },
		envelopes: envelopeStatuses,
	};
}
