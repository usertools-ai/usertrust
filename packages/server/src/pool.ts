// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { sep } from "node:path";
import type { Governor, TrustOpts } from "usertrust";
import { createGovernor, securePrivateVault, VAULT_DIR } from "usertrust";
import type { ServerConfig, TenantConfig } from "./config.js";

export type GovernorFactory = (opts: TrustOpts) => Promise<Governor>;

/** Trailing separators on `stateDir`: `/` on POSIX, either separator on Windows. */
const TRAILING_SEPARATORS = process.platform === "win32" ? /[\\/]+$/ : /\/+$/;

/**
 * The directory a tenant's governor keeps its vault under. Concatenated, never `join`ed: `join`
 * folds a `..` in `stateDir` lexically before the governor sees it, and the governor resolves
 * the base where the kernel does. The tenant id cannot hold `..` (config.ts). Trailing
 * separators are stripped first, so `state/` gives `state/<id>`, not `state//<id>`; that
 * removes no `..` and resolves nothing. A root (`/`, `C:\`) keeps its separator, and an empty
 * `stateDir` is the working directory, as `join` read it.
 */
export function tenantVaultBase(config: ServerConfig, tenant: TenantConfig): string {
	if (config.stateDir === "") return tenant.id;
	return `${config.stateDir.replace(TRAILING_SEPARATORS, "")}${sep}${tenant.id}`;
}

/**
 * Refuse to start when a tenant's vault would be refused at that tenant's first request:
 * each configured tenant's `<stateDir>/<tenant>/.usertrust` gets the check a governor
 * gives it (`securePrivateVault`), now, before the port opens. A loose real directory is
 * tightened, as the governor would; a symbolic link to a loose target, a dangling link and
 * a non-directory throw, every tenant's reason named. A vault that does not exist yet is
 * CREATED here, owner-only, as its governor would create it: one that cannot be created (a
 * read-only state dir, say) refuses the start instead of failing every request once the
 * port is open.
 */
export function secureTenantVaults(config: ServerConfig): void {
	const refusals: string[] = [];
	for (const tenant of config.tenants) {
		try {
			securePrivateVault(join(tenantVaultBase(config, tenant), VAULT_DIR), { create: true });
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
