// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * F1 — the budget write API must be callable from the *published* package root.
 *
 * These imports resolve through `packages/core/package.json` `exports` into the
 * emitted `dist/*.d.ts`, not through `src/`, so a name the package root fails to
 * re-export is a compile error here even when the source module exports it. That
 * is the point: all three entry points take a `TrustTBClient` as their required
 * first argument, and a consumer who cannot name or construct that argument
 * cannot call them at all.
 *
 * Enforced by `npm run typecheck`, which builds `dist` (`tsc -b`) before running
 * `tsc -p packages/core/tsconfig.type-tests.json`. Run against a missing or stale
 * `dist`, this file reports a module-resolution failure rather than a pass.
 */

import type {
	AllocateResult,
	BudgetAuditWriter,
	BudgetContext,
	BudgetStatus,
	EnvelopeDescriptor,
	EnvelopeStatus,
	ReclaimResult,
	Runway,
} from "usertrust";
import {
	allocateBudget,
	budgetContext,
	getBudgetStatus,
	reclaimBudget,
	TrustTBClient,
	withCostCenter,
} from "usertrust";

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// Value position on purpose: a type-only re-export of the class would satisfy the
// annotations below but leave `new TrustTBClient(...)` — the only way a consumer
// obtains the first argument — a compile error.
declare const addresses: string[];
const tb = new TrustTBClient({ addresses });

declare const writer: BudgetAuditWriter;

export const _allocate: Promise<AllocateResult> = allocateBudget(tb, {
	parentUserId: "acme",
	costCenter: "research",
	amount: 1_000,
	auditWriter: writer,
});

export const _reclaim: Promise<ReclaimResult> = reclaimBudget(tb, {
	parentUserId: "acme",
	costCenter: "research",
	auditWriter: writer,
});

export const _status: Promise<BudgetStatus> = getBudgetStatus(tb, {
	parentUserId: "acme",
	costCenter: "research",
	allocated: 1_000,
	periodStartMs: 0,
});

export type _StatusCarriesRunway = Assert<Extends<Awaited<typeof _status>, { runway: Runway }>>;

// The scarcity read API: EnvelopeDescriptor is constructible by a consumer without
// importing anything else — the whole point of the F1 guard extended to this surface.
declare const envelopes: EnvelopeDescriptor[];

export const _context: Promise<BudgetContext> = budgetContext(tb, "acme", envelopes, Date.now());

export type _ContextCarriesEnvelopes = Assert<
	Extends<Awaited<typeof _context>, { parent: { remaining: number }; envelopes: EnvelopeStatus[] }>
>;

// withCostCenter closes over the same TrustTBClient-holding governor a caller already
// constructed above; its own signature takes no TrustTBClient, so this asserts only
// that the scope runs `fn` and returns its value, sync and with options both accepted.
export const _withCostCenter: number = withCostCenter("billing", () => 42, {
	allocated: 1_000,
	periodStartMs: 0,
});
