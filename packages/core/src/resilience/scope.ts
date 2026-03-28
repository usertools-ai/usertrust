// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Scope Locking — minimatch-based overlap detection & lease management
 *
 * Prevents conflicts between parallel workers by tracking scope-based leases.
 * Each lease locks a set of glob patterns; overlapping patterns from different
 * actors are rejected.
 *
 * Store path: `.usertools/leases.json`
 */

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

let storeDir = join(process.cwd(), VAULT_DIR);

/**
 * Set the store directory path (for testing).
 */
export function setStoreDir(dir: string): void {
	storeDir = dir;
}

/**
 * Get the current store directory.
 */
export function getStoreDir(): string {
	return storeDir;
}

function getLeasesPath(): string {
	return join(storeDir, "leases.json");
}

function ensureStoreDir(): void {
	if (!existsSync(storeDir)) {
		mkdirSync(storeDir, { recursive: true });
	}
}

// ---------------------------------------------------------------------------
// File Operations
// ---------------------------------------------------------------------------

function readLeases(): LeaseStore {
	ensureStoreDir();
	const path = getLeasesPath();
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

function writeLeases(store: LeaseStore): void {
	ensureStoreDir();
	writeFileSync(getLeasesPath(), JSON.stringify(store, null, "\t"));
}

// ---------------------------------------------------------------------------
// ID Generation
// ---------------------------------------------------------------------------

function generateLeaseId(): string {
	const hex = Math.random().toString(16).substring(2, 10);
	return `ls_${hex}`;
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
 */
export class ScopeManager {
	private readonly clock: () => number;

	constructor(clock?: () => number) {
		this.clock = clock ?? Date.now;
	}

	/**
	 * Acquire a lease for the given scope.
	 * Throws if scope overlaps with another actor's active lease.
	 */
	acquireLease(options: AcquireLeaseOptions): Lease {
		const store = readLeases();
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
		writeLeases(store);

		return lease;
	}

	/**
	 * Renew an existing lease, extending its TTL.
	 */
	renewLease(leaseId: string, ttlMin = 60): Lease {
		const store = readLeases();
		const lease = store[leaseId];

		if (!lease) {
			throw new Error(`Lease ${leaseId} not found`);
		}
		if (lease.status !== "active") {
			throw new Error(`Lease ${leaseId} is ${lease.status}, cannot renew`);
		}

		lease.expires_at = new Date(this.clock() + ttlMin * 60_000).toISOString();
		lease.last_renewed_at = new Date(this.clock()).toISOString();
		writeLeases(store);

		return lease;
	}

	/**
	 * Release a lease, marking it as released.
	 */
	releaseLease(leaseId: string): Lease {
		const store = readLeases();
		const lease = store[leaseId];

		if (!lease) {
			throw new Error(`Lease ${leaseId} not found`);
		}

		lease.status = "released";
		writeLeases(store);

		return lease;
	}

	/**
	 * Find conflicts for a proposed scope against active leases.
	 */
	findConflicts(scope: string[], excludeActor?: string): LeaseConflict[] {
		const store = readLeases();
		this.expireStaleInStore(store);
		return this.findConflictsInStore(store, scope, excludeActor);
	}

	/**
	 * Expire stale leases and persist the result.
	 * Returns the number of leases expired.
	 */
	expireStale(): number {
		const store = readLeases();
		const count = this.expireStaleInStore(store);
		if (count > 0) {
			writeLeases(store);
		}
		return count;
	}

	/**
	 * Get all active leases.
	 */
	getActiveLeases(): Lease[] {
		const store = readLeases();
		return Object.values(store).filter((l) => l.status === "active");
	}

	/**
	 * Get a lease by ID.
	 */
	getLease(leaseId: string): Lease | undefined {
		const store = readLeases();
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
