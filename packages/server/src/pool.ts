// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { join } from "node:path";
import type { Governor, TrustOpts } from "usertrust";
import { createGovernor } from "usertrust";
import type { ServerConfig, TenantConfig } from "./config.js";

export type GovernorFactory = (opts: TrustOpts) => Promise<Governor>;

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

	async destroyAll(): Promise<void> {
		const all = [...this.governors.values()];
		this.governors.clear();
		await Promise.allSettled(all.map(async (p) => (await p).destroy()));
	}
}
