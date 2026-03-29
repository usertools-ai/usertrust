// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Scope Locking — minimatch-based overlap detection & lease management
 *
 * Prevents conflicts between parallel workers by tracking scope-based leases.
 * Each lease locks a set of glob patterns; overlapping patterns from different
 * actors are rejected.
 *
 * Store path: `.usertrust/leases.json`
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { VAULT_DIR } from "../shared/constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeaseStatus = "active" | "released" | "expired" | "revoked";

export interface Lease {
	lease_id: string;
	actor: string;
	scope: string[];
	intent: string;
	issued_at: string;
	expires_at: string;
	status: LeaseStatus;
	last_renewed_at?: string;
}

export interface LeaseStore {
	[lease_id: string]: Lease;
}

export interface AcquireLeaseOptions {
	actor: string;
	scope: string[];
	intent: string;
	/** Lease time-to-live in minutes (default: 60). */
	ttlMin?: number;
}

export interface LeaseConflict {
	lease: Lease;
	overlappingPatterns: string[];
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

let moduleStoreDir = join(process.cwd(), VAULT_DIR);

/**
 * Set the store directory path (for testing).
 *
 * @deprecated Use the `storeDir` constructor parameter on `ScopeManager` instead.
 * This function mutates module-level state shared by all ScopeManager instances
 * that were created without an explicit storeDir.
 */
export function setStoreDir(dir: string): void {
	moduleStoreDir = dir;
}

/**
 * Get the current module-level store directory.
 *
 * @deprecated Use the `storeDir` constructor parameter on `ScopeManager` instead.
 */
export function getStoreDir(): string {
	return moduleStoreDir;
}

// ---------------------------------------------------------------------------
// File Operations (parameterized by storeDir)
// ---------------------------------------------------------------------------

function getLeasesPath(storeDir: string): string {
	return join(storeDir, "leases.json");
}

function ensureStoreDir(storeDir: string): void {
	if (!existsSync(storeDir)) {
		mkdirSync(storeDir, { recursive: true });
	}
}

function readLeases(storeDir: string): LeaseStore {
	ensureStoreDir(storeDir);
	const path = getLeasesPath(storeDir);
	if (!existsSync(path)) {
		return {};
	}
	try {
		const data = readFileSync(path, "utf-8");
		return JSON.parse(data) as LeaseStore;
	} catch {
		return {};
	}
}

function writeLeases(store: LeaseStore, storeDir: string): void {
	ensureStoreDir(storeDir);
	writeFileSync(getLeasesPath(storeDir), JSON.stringify(store, null, "\t"));
}

// ---------------------------------------------------------------------------
// ID Generation (AUD-466: crypto.randomUUID replaces Math.random)
// ---------------------------------------------------------------------------

function generateLeaseId(): string {
	return `ls_${randomUUID().replace(/-/g, "").substring(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Scope Overlap
// ---------------------------------------------------------------------------

/**
 * Check if two scope patterns overlap.
 *
 * Two patterns overlap when:
 * 1. Either literally matches the other via minimatch, OR
 * 2. They share a common base prefix (e.g. `src/**` and `src/foo/**`)
 */
export function scopesOverlap(scopeA: string[], scopeB: string[]): boolean {
	for (const patternA of scopeA) {
		for (const patternB of scopeB) {
			// Check if either pattern matches the other
			if (minimatch(patternA, patternB) || minimatch(patternB, patternA)) {
				return true;
			}
			// Check for common prefix overlap (e.g., "src/**" and "src/foo/**")
			const baseA = patternA.replace(/\*.*$/, "");
			const baseB = patternB.replace(/\*.*$/, "");
			if (baseA.startsWith(baseB) || baseB.startsWith(baseA)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Check if a file matches any of the scope patterns.
 */
export function fileMatchesScope(file: string, scope: string[]): boolean {
	for (const pattern of scope) {
		if (minimatch(file, pattern)) {
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// ScopeManager
// ---------------------------------------------------------------------------

/**
 * Scope-based lease manager.
 *
 * Provides `acquireLease`, `releaseLease`, `findConflicts`, and `expireStale`
 * for coordinating parallel workers operating on overlapping file scopes.
 *
 * AUD-465: Accepts an optional `storeDir` constructor parameter to avoid
 * reliance on module-level mutable state. Falls back to the module-level
 * `moduleStoreDir` for backward compatibility.
 */
export class ScopeManager {
	private readonly clock: () => number;
	private readonly storeDir: string;

	/**
	 * @param optionsOrClock - Either an options object `{ clock?, storeDir? }`
	 *   or a legacy clock function `() => number` for backward compatibility.
	 */
	constructor(optionsOrClock?: (() => number) | { clock?: () => number; storeDir?: string }) {
		if (typeof optionsOrClock === "function") {
			// Legacy constructor: ScopeManager(clock)
			this.clock = optionsOrClock;
			this.storeDir = moduleStoreDir;
		} else {
			this.clock = optionsOrClock?.clock ?? Date.now;
			this.storeDir = optionsOrClock?.storeDir ?? moduleStoreDir;
		}
	}

	/**
	 * Acquire a lease for the given scope.
	 * Throws if scope overlaps with another actor's active lease.
	 */
	acquireLease(options: AcquireLeaseOptions): Lease {
		const store = readLeases(this.storeDir);
		const ttlMin = options.ttlMin ?? 60;

		// Expire stale leases first
		this.expireStaleInStore(store);

		// Check for scope overlap with other actors' active leases
		const conflicts = this.findConflictsInStore(store, options.scope, options.actor);
		if (conflicts.length > 0) {
			const first = conflicts[0] as LeaseConflict;
			throw new Error(
				`Scope overlap with lease ${first.lease.lease_id} ` +
					`(actor: ${first.lease.actor}, ` +
					`scope: ${first.lease.scope.join(", ")})`,
			);
		}

		const now = new Date(this.clock()).toISOString();
		const expiresAt = new Date(this.clock() + ttlMin * 60_000).toISOString();
		const leaseId = generateLeaseId();

		const lease: Lease = {
			lease_id: leaseId,
			actor: options.actor,
			scope: options.scope,
			intent: options.intent,
			issued_at: now,
			expires_at: expiresAt,
			status: "active",
		};

		store[leaseId] = lease;
		writeLeases(store, this.storeDir);

		return lease;
	}

	/**
	 * Renew an existing lease, extending its TTL.
	 *
	 * AUD-466: When `actor` is provided, verifies the caller matches the lease
	 * owner to prevent unauthorized renewal by a different actor. Callers SHOULD
	 * always pass `actor` — omitting it is supported only for backward
	 * compatibility and will be removed in a future major version.
	 */
	renewLease(leaseId: string, actorOrTtl?: string | number, ttlMin?: number): Lease {
		let actor: string | undefined;
		let ttl: number;

		if (typeof actorOrTtl === "string") {
			actor = actorOrTtl;
			ttl = ttlMin ?? 60;
		} else {
			ttl = actorOrTtl ?? 60;
		}

		const store = readLeases(this.storeDir);
		const lease = store[leaseId];

		if (!lease) {
			throw new Error(`Lease ${leaseId} not found`);
		}
		if (lease.status !== "active") {
			throw new Error(`Lease ${leaseId} is ${lease.status}, cannot renew`);
		}
		if (actor !== undefined && lease.actor !== actor) {
			throw new Error(`Actor "${actor}" cannot renew lease ${leaseId} owned by "${lease.actor}"`);
		}

		lease.expires_at = new Date(this.clock() + ttl * 60_000).toISOString();
		lease.last_renewed_at = new Date(this.clock()).toISOString();
		writeLeases(store, this.storeDir);

		return lease;
	}

	/**
	 * Release a lease, marking it as released.
	 *
	 * AUD-466: When `actor` is provided, verifies the caller matches the lease
	 * owner to prevent unauthorized release by a different actor. Callers SHOULD
	 * always pass `actor` — omitting it is supported only for backward
	 * compatibility and will be removed in a future major version.
	 */
	releaseLease(leaseId: string, actor?: string): Lease {
		const store = readLeases(this.storeDir);
		const lease = store[leaseId];

		if (!lease) {
			throw new Error(`Lease ${leaseId} not found`);
		}
		if (actor !== undefined && lease.actor !== actor) {
			throw new Error(`Actor "${actor}" cannot release lease ${leaseId} owned by "${lease.actor}"`);
		}

		lease.status = "released";
		writeLeases(store, this.storeDir);

		return lease;
	}

	/**
	 * Find conflicts for a proposed scope against active leases.
	 */
	findConflicts(scope: string[], excludeActor?: string): LeaseConflict[] {
		const store = readLeases(this.storeDir);
		this.expireStaleInStore(store);
		return this.findConflictsInStore(store, scope, excludeActor);
	}

	/**
	 * Expire stale leases and persist the result.
	 * Returns the number of leases expired.
	 */
	expireStale(): number {
		const store = readLeases(this.storeDir);
		const count = this.expireStaleInStore(store);
		if (count > 0) {
			writeLeases(store, this.storeDir);
		}
		return count;
	}

	/**
	 * Get all active leases.
	 */
	getActiveLeases(): Lease[] {
		const store = readLeases(this.storeDir);
		return Object.values(store).filter((l) => l.status === "active");
	}

	/**
	 * Get a lease by ID.
	 */
	getLease(leaseId: string): Lease | undefined {
		const store = readLeases(this.storeDir);
		return store[leaseId];
	}

	// ── Private helpers ──

	private findConflictsInStore(
		store: LeaseStore,
		scope: string[],
		excludeActor?: string,
	): LeaseConflict[] {
		const conflicts: LeaseConflict[] = [];

		for (const lease of Object.values(store)) {
			if (lease.status !== "active") continue;
			if (excludeActor && lease.actor === excludeActor) continue;

			if (scopesOverlap(scope, lease.scope)) {
				conflicts.push({
					lease,
					overlappingPatterns: lease.scope,
				});
			}
		}

		return conflicts;
	}

	private expireStaleInStore(store: LeaseStore): number {
		const now = new Date(this.clock());
		let count = 0;

		for (const lease of Object.values(store)) {
			if (lease.status === "active" && new Date(lease.expires_at) < now) {
				lease.status = "expired";
				count++;
			}
		}

		return count;
	}
}
