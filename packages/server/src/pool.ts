// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { join, resolve, sep } from "node:path";
import type { Governor, GovernorOpts } from "usertrust";
import { createGovernor, kernelVaultBase, securePrivateVault, VAULT_DIR } from "usertrust";
import { maxHoldLife, type ServerConfig, type TenantConfig } from "./config.js";

/** core's `LEDGER_HOLD_TIMEOUT_MS`: the shortest ceiling `createGovernor()` accepts. */
const DEFAULT_HOLD_LIFE_MS = 300_000;

export type GovernorFactory = (opts: GovernorOpts) => Promise<Governor>;

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
 *
 * The vault judged is the one the governor opens. `createGovernor` computes it as
 * `join(resolve(governorVaultBase(base)), VAULT_DIR)` over the base `GovernorPool` hands it: the
 * base resolved where the kernel resolves it (a `..` after a symbolic link is the link target's
 * parent), and only then joined. A `join` of the raw base would fold that `..` lexically and judge
 * another directory than the first request opens. `governorVaultBase` is `kernelVaultBase` plus a
 * stderr line naming the mapping, printed on every call; this check uses `kernelVaultBase`, the
 * same resolution without the line, so the governor's own call prints it once.
 */
export function secureTenantVaults(config: ServerConfig): void {
	const refusals: string[] = [];
	for (const tenant of config.tenants) {
		try {
			const vaultBase = resolve(kernelVaultBase(tenantVaultBase(config, tenant)));
			securePrivateVault(join(vaultBase, VAULT_DIR), { create: true });
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
 *
 * `onCreate`, when given, is called exactly once each time `get()` CREATES a governor (never when
 * it returns a cached one), with the tenant and the governor's PROMISE, not a resolved governor:
 * it is called before the governor exists, so a caller that needs the governor `then`s the promise.
 * That lets a caller track every creation however it was reached. It must not throw.
 */
export class GovernorPool {
	private readonly governors = new Map<string, Promise<Governor>>();

	constructor(
		private readonly config: ServerConfig,
		private readonly factory: GovernorFactory = (opts) => createGovernor(opts),
		private readonly onCreate?: (tenant: TenantConfig, governor: Promise<Governor>) => void,
	) {}

	get(tenant: TenantConfig): Promise<Governor> {
		const existing = this.governors.get(tenant.id);
		if (existing) return existing;
		const opts: GovernorOpts = {
			vaultBase: tenantVaultBase(this.config, tenant),
			dryRun: this.config.dryRun,
			// The longest hold an authorize may ask for (`holdTtlMs`): the server's own effective
			// ceiling, so a hold's ledger timeout and its sweep life agree. Never below core's default
			// hold life, which createGovernor() refuses.
			maxHoldTtlMs: Math.max(maxHoldLife(this.config), DEFAULT_HOLD_LIFE_MS),
			// The server's own shutdown (`close()`, run by the command line's signal handler) ends every
			// hold and awaits it. A governor that also listened for the signal would start its teardown
			// first and leave `close()` waiting on a teardown it did not start.
			installSignalHandlers: false,
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
		this.onCreate?.(tenant, created);
		return created;
	}

	async destroyAll(): Promise<void> {
		const all = [...this.governors.values()];
		this.governors.clear();
		await Promise.allSettled(all.map(async (p) => (await p).destroy()));
	}
}
