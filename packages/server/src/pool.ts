// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { join } from "node:path";
import type { Governor, TrustOpts } from "usertrust";
import { createGovernor } from "usertrust";
import type { ServerConfig, TenantConfig } from "./config.js";
import { requestTimeoutOf, shutdownTimeoutOf } from "./config.js";
import { withDeadline } from "./deadline.js";

export type GovernorFactory = (opts: TrustOpts) => Promise<Governor>;

/**
 * Lazy per-tenant Governor instances. Tenant isolation comes from per-tenant
 * vaultBase directories (separate audit chains + spend ledgers) and per-tenant
 * budget/tier overrides. The factory is injectable for tests.
 */
/**
 * What a shutdown teardown actually achieved. `abandoned` is non-empty exactly
 * when a governor's teardown was cut short — the caller must not report a clean
 * shutdown in that case.
 */
export interface TeardownReport {
	completed: number;
	abandoned: Array<{ reason: string }>;
}

export class GovernorPool {
	private readonly governors = new Map<string, Promise<Governor>>();

	constructor(
		private readonly config: ServerConfig,
		private readonly factory: GovernorFactory = (opts) => createGovernor(opts),
	) {}

	get(tenant: TenantConfig): Promise<Governor> {
		const existing = this.governors.get(tenant.id);
		if (existing) return existing;
		const opts: TrustOpts = {
			vaultBase: join(this.config.stateDir, tenant.id),
			dryRun: this.config.dryRun,
		};
		if (tenant.budget !== undefined) opts.budget = tenant.budget;
		if (tenant.tier !== undefined) opts.tier = tenant.tier;
		if (tenant.configPath !== undefined) opts.configPath = tenant.configPath;
		const created = this.factory(opts).catch((err: unknown) => {
			// Failed creation must not poison the cache.
			this.governors.delete(tenant.id);
			throw err;
		});
		this.governors.set(tenant.id, created);
		return created;
	}

	/**
	 * Tear every governor down, and SAY WHETHER IT FINISHED.
	 *
	 * This returned `Promise<void>` over `Promise.allSettled`, which discarded
	 * every outcome — so a teardown cut short by its own deadline was
	 * structurally unreportable, and `close()` resolved identically whether the
	 * money path had flushed or been abandoned mid-void. The CLI then exited 0 on
	 * both. The deadline was not the defect; modelling its EXPIRY AS SUCCESS was.
	 *
	 * The budget still exists and still must: `destroy()` voids pending transfers
	 * before closing the native client, and a void is a ledger request that never
	 * rejects when the cluster is gone, so an unbounded wait is the original
	 * shutdown hang by another route. What changes is that giving up waiting is
	 * now a REPORTED outcome rather than an indistinguishable one.
	 */
	async destroyAll(): Promise<TeardownReport> {
		const all = [...this.governors.values()];
		this.governors.clear();
		const results = await Promise.allSettled(
			all.map(async (p) => {
				// Bounded, because a governor whose CONSTRUCTION never settles would pin
				// close() open forever — the same unbounded await that stopped
				// /v1/authorize from ever answering. There is nothing to destroy until it
				// exists, so give up waiting and let shutdown finish rather than hanging
				// the process on a ledger that is already unreachable.
				// Reclamation is attached to a scope-level ONCE flag rather than to the
				// deadline alone, because the deadline may never wire it up.
				//
				// The previous comment here claimed a fresh budget "is never zero at entry
				// … so this thunk is always invoked and the reclamation below is always
				// wired up". That is false, and it is the reason the gap survived review.
				// `Deadline.run` decides on the CLOCK BEFORE calling `start()` — it throws
				// on `remainingMs() === 0` at deadline.ts:86, ahead of the thunk. With a
				// small but perfectly valid `requestTimeoutMs` (1ms is validated positive),
				// a single clock tick between constructing the deadline and calling `run`
				// exhausts the budget, so the thunk is never invoked and `onAbandoned`
				// never exists. `p` is in flight regardless: it lands, produces a live
				// governor holding a TigerBeetle client, and nothing destroys it —
				// AGENTS.md:118-123 is explicit that an undestroyed client is what keeps
				// the event loop from draining, so this does not merely leak, it can stop
				// the process exiting. Registering cleanup against the wrapper that may
				// never start, instead of the work that is already running, is the bug.
				let reclaimedLate = false;
				const reclaimLate = (late: Awaited<typeof p>): void => {
					if (reclaimedLate) return;
					reclaimedLate = true;
					void late.destroy().catch(() => {});
				};
				let governor: Awaited<typeof p>;
				try {
					governor = await withDeadline(
						"pool.get",
						// `p` is ALREADY in flight — the pool's stored construction promise, so
						// the thunk closes over it rather than starting anything.
						() => p,
						requestTimeoutOf(this.config),
						// The post-start path: construction that lands after shutdown gave up
						// waiting. Still reclaimed here, and the flag makes it once-only.
						reclaimLate,
					);
				} catch (err) {
					// The PRE-START path: the deadline refused before the thunk existed, so
					// `onAbandoned` was never wired. `p` is still running and still owns a
					// client. Observe it here — the flag means this is a no-op when the
					// timeout happened after start and `reclaimLate` already fired.
					void p.then(reclaimLate, () => {});
					throw err;
				}
				// destroy() is bounded too, not just construction. It voids pending transfers
				// BEFORE closing the native client, and that void is a ledger request — which
				// never rejects when the cluster is gone. So a governor built while
				// TigerBeetle was healthy and destroyed after it died hangs close() forever,
				// which is the shutdown hang again by a third route: bounding construction
				// only moved it. AGENTS.md requires every governor to be destroyed; when the
				// ledger will not let that finish, shutdown proceeds regardless.
				await withDeadline(
					"destroy",
					() => governor.destroy(),
					// The TEARDOWN budget, not the request budget. Sharing one number made
					// the collision arithmetic: destroy() waits up to 5s for in-flight work
					// and the request default is 4s, so any shutdown during settlement
					// pre-empted the money-path teardown by construction.
					shutdownTimeoutOf(this.config),
				);
			}),
		);
		const abandoned = results
			.filter((r): r is PromiseRejectedResult => r.status === "rejected")
			.map((r) => ({
				reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
			}));
		return { completed: results.length - abandoned.length, abandoned };
	}
}
