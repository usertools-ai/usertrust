// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * budget/attribution.ts — the `withCostCenter()` attribution scope.
 *
 * Attribution comes from CODE STRUCTURE, never from request content: a governed
 * call is attributed to a cost center only because it executed lexically inside a
 * `withCostCenter(cc, fn)` call, propagated by `node:async_hooks`'
 * `AsyncLocalStorage` — the repo's first use of it. Nothing an agent's request
 * body can carry (a `cost_center` field, a header, a tool argument) can forge or
 * override this: the store is keyed off the calling code's own async execution
 * context, which caller-supplied text never touches.
 * *Prevents:* an agent relabeling its own calls to drain the fattest envelope —
 * the exact failure a request-content-derived attribution scheme would open.
 *
 * ALS DISCIPLINE (the invariant this file establishes, see AGENTS.md): storage is
 * module-private — nothing outside this file may read or write it — and a
 * governor may call {@link getCurrentCostCenter} exactly ONCE per call, at the top
 * of its own synchronous entry point (`interceptCall`, headless `authorize`).
 * Every terminal, listener, and `finally` after that point must read a closure
 * capture of that one read, never call {@link getCurrentCostCenter} itself. The
 * reason is mechanical, not stylistic: `AsyncLocalStorage` context follows a
 * *chain of async continuations* (awaits, promise `.then`s, timers, microtasks
 * scheduled while the store is active) — it does NOT follow an `EventEmitter`
 * listener from its `on()`-time context into its `emit()`-time context, because
 * `emit()` invokes listeners synchronously in whatever context calls `emit()`.
 * SDK stream consumption is emitter-shaped (`streamEvent` / `finalMessage` /
 * `error` / `end`), and those ticks fire on the SDK's own pump, strictly after
 * the governor's synchronous entry point has already returned. A `getStore()`
 * call from inside one of those listeners would silently see the WRONG scope (a
 * later, unrelated call's) or no scope at all — never a loud failure. This file's
 * own test suite pins that exact hazard as a negative case so the failure mode
 * stays documented next to the primitive that makes it possible, not just in a
 * comment a future edit can drift away from.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { COST_CENTER_PATTERN } from "../shared/ids.js";

/**
 * Envelope metadata captured alongside a scope (D4). Optional because there is no
 * cost-center registry: a caller that only wants attribution (routing the spend to
 * the right envelope) need not also state the envelope's size. When present, it is
 * what lets `govern.ts`/`headless.ts` compute `budgetFractionRemaining` and
 * `budgetRunwayHours` for the active envelope; when absent, those policy fields
 * are asserted explicitly `undefined` rather than guessed at (fail closed — an
 * `exists`-guarded tier simply does not match, never matches a fabricated number).
 */
export interface CostCenterScopeOpts {
	/** UT, finite, >= 0. Not validated against a real allocation — see above. */
	allocated: number;
	/** Finite epoch ms. */
	periodStartMs: number;
	/** Finite epoch ms when present; absent means an open-ended period. */
	periodEndMs?: number | undefined;
}

/**
 * The record threaded through one `withCostCenter` scope. Frozen at construction
 * (see {@link withCostCenter}) so a caller holding a reference — intentionally or
 * by mistake — cannot mutate it and have that mutation observed by a later
 * `getCurrentCostCenter()` read in the same or a nested scope.
 */
export interface CostCenterAttribution {
	readonly costCenter: string;
	readonly allocated?: number | undefined;
	readonly periodStartMs?: number | undefined;
	readonly periodEndMs?: number | undefined;
}

// Module-private. This is the ONE mutable module-level piece of state this file
// owns, and the ALS-discipline invariant above exists entirely to keep every read
// of it confined to a governor's single synchronous entry point.
const costCenterStorage = new AsyncLocalStorage<CostCenterAttribution>();

/**
 * Run `fn` with `costCenter` attributed for every governed call `fn` makes,
 * directly or through any `await`, timer, or microtask it schedules while it is
 * still executing. Nesting is native `AsyncLocalStorage` stack behavior: the
 * innermost active `withCostCenter` wins, and exiting it — by returning OR by
 * throwing/rejecting — restores whatever scope (or no scope) was active before it
 * was entered.
 *
 * Validation runs before any of `fn` executes (fail-fast, pre-I/O): an invalid
 * `costCenter` or a non-finite `opts` field must never reach a call already in
 * flight, and `costCenter` becomes an audit-event field and a display label
 * downstream — `canonicalize` (audit) throws on `NaN`/`Infinity`, so a non-finite
 * `opts` number is refused HERE rather than surfacing as an audit-write failure
 * three call frames away. The rejection message is deliberately distinct from the
 * two other costCenter charset-door messages in this repo
 * (`ledger/client.ts`'s `"Invalid costCenter: ..."` and
 * `budget/allocation.ts`'s `"budget: costCenter ..."`) so a caller can tell which
 * door refused their id from the message alone.
 *
 * @throws Error when `costCenter` fails {@link COST_CENTER_PATTERN}, or when
 * `opts` is present and `allocated` is not a finite number `>= 0`, or
 * `periodStartMs`/`periodEndMs` (when given) is not a finite number.
 */
export function withCostCenter<T>(costCenter: string, fn: () => T, opts?: CostCenterScopeOpts): T {
	if (typeof costCenter !== "string" || !COST_CENTER_PATTERN.test(costCenter)) {
		throw new Error(
			`withCostCenter: costCenter must match ${COST_CENTER_PATTERN.source}, got ${JSON.stringify(
				costCenter,
			)}`,
		);
	}
	if (opts !== undefined) {
		if (!Number.isFinite(opts.allocated) || opts.allocated < 0) {
			throw new Error("withCostCenter: opts.allocated must be a finite number >= 0");
		}
		if (!Number.isFinite(opts.periodStartMs)) {
			throw new Error("withCostCenter: opts.periodStartMs must be a finite number");
		}
		if (opts.periodEndMs !== undefined && !Number.isFinite(opts.periodEndMs)) {
			throw new Error("withCostCenter: opts.periodEndMs must be a finite number when present");
		}
	}

	const store: CostCenterAttribution = Object.freeze({ costCenter, ...opts });
	return costCenterStorage.run(store, fn);
}

/**
 * Read the active scope's attribution, or `undefined` outside any scope.
 *
 * INTERNAL ONLY (D8) — not re-exported from `index.ts` this ship. `govern.ts` and
 * `headless.ts` import it directly by relative path. Per the ALS-discipline
 * invariant documented at the top of this file, each of them may call this
 * exactly once, at the very top of its own synchronous entry point, and must
 * thread the result through as a closure/handle capture from there — never call
 * this again inside a terminal, a stream emitter listener, or a `finally` block.
 */
export function getCurrentCostCenter(): CostCenterAttribution | undefined {
	return costCenterStorage.getStore();
}
