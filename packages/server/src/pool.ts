// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { join } from "node:path";
import type { Governor, GovernorOpts } from "usertrust";
import { createGovernor } from "usertrust";
import type { ServerConfig, TenantConfig } from "./config.js";

export type GovernorFactory = (opts: GovernorOpts) => Promise<Governor>;

/**
 * Lazy per-tenant Governor instances. Tenant isolation comes from per-tenant
 * vaultBase directories (separate audit chains + spend ledgers) and per-tenant
 * budget/tier overrides. The factory is injectable for tests.
 */
export class GovernorPool {
	private readonly governors = new Map<string, Promise<Governor>>();

	constructor(
		private readonly config: ServerConfig,
		private readonly factory: GovernorFactory = (opts) => createGovernor(opts),
	) {}

	get(tenant: TenantConfig): Promise<Governor> {
		const existing = this.governors.get(tenant.id);
		if (existing) return existing;
		// No `idempotencyScope`: each tenant's own vault persists a random one on its
		// first keyed call. A tenant id would collide across deployments sharing a
		// ledger cluster (two servers that each serve an "acme"), and a vault path
		// would change with `stateDir` or the working directory; the vault's own id
		// is unique where vaults differ and stable wherever the vault persists.
		const opts: GovernorOpts = {
			vaultBase: join(this.config.stateDir, tenant.id),
			dryRun: this.config.dryRun,
		};
		if (tenant.budget !== undefined) opts.budget = tenant.budget;
		if (tenant.tier !== undefined) opts.tier = tenant.tier;
		if (tenant.configPath !== undefined) opts.configPath = tenant.configPath;
		const created = this.factory(opts)
			.then((governor) => {
				// A factory written against the pre-release Governor (plain JS, or cast)
				// would make every TTL sweep fail inside a best-effort catch, silently.
				// Refuse it here, loudly, where the operator sees it.
				if (
					typeof governor.release !== "function" ||
					typeof governor.recordUnheldSettlement !== "function"
				) {
					// Destroyed before it is dropped: it may already hold a ledger client,
					// and once the cache forgets it nothing else could ever close it.
					return Promise.resolve(governor.destroy?.())
						.catch(() => {})
						.then(() => {
							throw new Error(
								"governor factory returned a Governor without release() or recordUnheldSettlement(); build it with usertrust's createGovernor() of this version",
							);
						});
				}
				return governor;
			})
			.catch((err: unknown) => {
				// Failed creation must not poison the cache.
				this.governors.delete(tenant.id);
				throw err;
			});
		this.governors.set(tenant.id, created);
		return created;
	}

	async destroyAll(): Promise<void> {
		const all = [...this.governors.values()];
		this.governors.clear();
		await Promise.allSettled(all.map(async (p) => (await p).destroy()));
	}
}
