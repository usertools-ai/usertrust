// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { join } from "node:path";
import type { Governor, TrustOpts } from "usertrust";
import { createGovernor, securePrivateVault, VAULT_DIR } from "usertrust";
import type { ServerConfig, TenantConfig } from "./config.js";

export type GovernorFactory = (opts: TrustOpts) => Promise<Governor>;

/** The directory a tenant's governor keeps its vault under. */
export function tenantVaultBase(config: ServerConfig, tenant: TenantConfig): string {
	return join(config.stateDir, tenant.id);
}

/**
 * Refuse to start when a tenant's vault would be refused at that tenant's first request:
 * each configured tenant's `<stateDir>/<tenant>/.usertrust` gets the check a governor
 * gives it (`securePrivateVault`), now, before the port opens. A loose real directory is
 * tightened, as the governor would; a symbolic link to a loose target, a dangling link and
 * a non-directory throw, every tenant's reason named. A vault that does not exist yet
 * passes: its governor creates it owner-only.
 */
export function secureTenantVaults(config: ServerConfig): void {
	const refusals: string[] = [];
	for (const tenant of config.tenants) {
		try {
			securePrivateVault(join(tenantVaultBase(config, tenant), VAULT_DIR));
		} catch (err) {
			refusals.push(`tenant ${tenant.id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (refusals.length > 0) throw new Error(refusals.join("\n"));
}

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
			vaultBase: tenantVaultBase(this.config, tenant),
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
