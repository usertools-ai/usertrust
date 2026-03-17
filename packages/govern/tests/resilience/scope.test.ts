/**
 * Scope Locking tests
 *
 * Tests scope overlap detection with minimatch patterns,
 * lease creation/renewal/expiry, conflict detection, and stale cleanup.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ScopeManager,
	fileMatchesScope,
	scopesOverlap,
	setStoreDir,
} from "../../src/resilience/scope.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
	testDir = join(
		tmpdir(),
		`govern-scope-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(testDir, { recursive: true });
	setStoreDir(testDir);
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// transient cleanup race — not a real failure
	}
});

// ---------------------------------------------------------------------------
// scopesOverlap — minimatch-based pattern matching
// ---------------------------------------------------------------------------

describe("scopesOverlap", () => {
	it("detects literal match overlap", () => {
		expect(scopesOverlap(["src/index.ts"], ["src/index.ts"])).toBe(true);
	});

	it("detects glob matching file path", () => {
		expect(scopesOverlap(["src/**/*.ts"], ["src/index.ts"])).toBe(true);
	});

	it("detects common prefix overlap", () => {
		expect(scopesOverlap(["src/**"], ["src/foo/**"])).toBe(true);
	});

	it("returns false for non-overlapping patterns", () => {
		expect(scopesOverlap(["src/**/*.ts"], ["tests/**/*.ts"])).toBe(false);
	});

	it("returns false for disjoint literal paths", () => {
		expect(scopesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
	});

	it("handles multiple patterns in each scope", () => {
		expect(scopesOverlap(["src/**/*.ts", "lib/**/*.ts"], ["tests/**/*.ts", "lib/utils.ts"])).toBe(
			true,
		);
	});

	it("empty scopes do not overlap", () => {
		expect(scopesOverlap([], ["src/**"])).toBe(false);
		expect(scopesOverlap(["src/**"], [])).toBe(false);
		expect(scopesOverlap([], [])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// fileMatchesScope
// ---------------------------------------------------------------------------

describe("fileMatchesScope", () => {
	it("matches file against glob", () => {
		expect(fileMatchesScope("src/index.ts", ["src/**/*.ts"])).toBe(true);
	});

	it("no match for unrelated file", () => {
		expect(fileMatchesScope("tests/foo.ts", ["src/**/*.ts"])).toBe(false);
	});

	it("matches exact literal", () => {
		expect(fileMatchesScope("README.md", ["README.md"])).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// ScopeManager — lease lifecycle
// ---------------------------------------------------------------------------

describe("ScopeManager", () => {
	it("acquires a lease", () => {
		const mgr = new ScopeManager();
		const lease = mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**/*.ts"],
			intent: "refactor",
		});

		expect(lease.actor).toBe("agent-1");
		expect(lease.scope).toEqual(["src/**/*.ts"]);
		expect(lease.status).toBe("active");
		expect(lease.lease_id).toMatch(/^ls_/);
	});

	it("retrieves a lease by ID", () => {
		const mgr = new ScopeManager();
		const lease = mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "test",
		});

		const fetched = mgr.getLease(lease.lease_id);
		expect(fetched).toBeDefined();
		expect(fetched?.lease_id).toBe(lease.lease_id);
	});

	it("releases a lease", () => {
		const mgr = new ScopeManager();
		const lease = mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "test",
		});

		const released = mgr.releaseLease(lease.lease_id);
		expect(released.status).toBe("released");
	});

	it("throws when releasing a non-existent lease", () => {
		const mgr = new ScopeManager();
		expect(() => mgr.releaseLease("ls_nonexistent")).toThrow("not found");
	});

	it("renews a lease", () => {
		const mgr = new ScopeManager();
		const lease = mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "test",
			ttlMin: 10,
		});

		const renewed = mgr.renewLease(lease.lease_id, 120);
		expect(renewed.status).toBe("active");
		expect(renewed.last_renewed_at).toBeDefined();
		// New expiry should be later than original
		expect(new Date(renewed.expires_at).getTime()).toBeGreaterThan(
			new Date(lease.expires_at).getTime(),
		);
	});

	it("throws when renewing a released lease", () => {
		const mgr = new ScopeManager();
		const lease = mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "test",
		});
		mgr.releaseLease(lease.lease_id);

		expect(() => mgr.renewLease(lease.lease_id)).toThrow("released");
	});

	it("throws when renewing a non-existent lease", () => {
		const mgr = new ScopeManager();
		expect(() => mgr.renewLease("ls_nonexistent")).toThrow("not found");
	});
});

// ---------------------------------------------------------------------------
// ScopeManager — conflict detection
// ---------------------------------------------------------------------------

describe("ScopeManager — conflicts", () => {
	it("detects conflict when patterns overlap", () => {
		const mgr = new ScopeManager();
		mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**/*.ts"],
			intent: "refactor",
		});

		expect(() =>
			mgr.acquireLease({
				actor: "agent-2",
				scope: ["src/index.ts"],
				intent: "fix bug",
			}),
		).toThrow("Scope overlap");
	});

	it("allows non-overlapping scopes from different actors", () => {
		const mgr = new ScopeManager();
		mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**/*.ts"],
			intent: "refactor",
		});

		const lease2 = mgr.acquireLease({
			actor: "agent-2",
			scope: ["tests/**/*.ts"],
			intent: "add tests",
		});
		expect(lease2.status).toBe("active");
	});

	it("allows same actor to acquire overlapping scopes", () => {
		const mgr = new ScopeManager();
		mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**/*.ts"],
			intent: "refactor",
		});

		// Same actor — no conflict
		const lease2 = mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/index.ts"],
			intent: "fix bug",
		});
		expect(lease2.status).toBe("active");
	});

	it("findConflicts returns matching leases", () => {
		const mgr = new ScopeManager();
		mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "refactor",
		});

		const conflicts = mgr.findConflicts(["src/index.ts"]);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]?.lease.actor).toBe("agent-1");
	});

	it("findConflicts excludes specified actor", () => {
		const mgr = new ScopeManager();
		mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "refactor",
		});

		const conflicts = mgr.findConflicts(["src/index.ts"], "agent-1");
		expect(conflicts).toHaveLength(0);
	});

	it("released leases don't cause conflicts", () => {
		const mgr = new ScopeManager();
		const lease = mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "refactor",
		});
		mgr.releaseLease(lease.lease_id);

		// No conflict since the lease was released
		const lease2 = mgr.acquireLease({
			actor: "agent-2",
			scope: ["src/index.ts"],
			intent: "fix",
		});
		expect(lease2.status).toBe("active");
	});
});

// ---------------------------------------------------------------------------
// ScopeManager — stale lease cleanup
// ---------------------------------------------------------------------------

describe("ScopeManager — expiry", () => {
	it("expires stale leases", () => {
		let now = 1_000_000;
		const mgr = new ScopeManager(() => now);

		const lease = mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "test",
			ttlMin: 1, // 1 minute TTL
		});

		// Advance past expiry (> 1 minute)
		now += 2 * 60_000;

		const expired = mgr.expireStale();
		expect(expired).toBe(1);

		const fetched = mgr.getLease(lease.lease_id);
		expect(fetched?.status).toBe("expired");
	});

	it("does not expire non-stale leases", () => {
		let now = 1_000_000;
		const mgr = new ScopeManager(() => now);

		mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "test",
			ttlMin: 60,
		});

		// Advance only 30 seconds — not past expiry
		now += 30_000;

		const expired = mgr.expireStale();
		expect(expired).toBe(0);
	});

	it("expired leases don't block new acquisitions", () => {
		let now = 1_000_000;
		const mgr = new ScopeManager(() => now);

		mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "test",
			ttlMin: 1,
		});

		// Advance past expiry
		now += 2 * 60_000;

		// Should succeed — stale lease gets expired during acquire
		const lease2 = mgr.acquireLease({
			actor: "agent-2",
			scope: ["src/index.ts"],
			intent: "fix",
		});
		expect(lease2.status).toBe("active");
	});

	it("getActiveLeases returns only active leases", () => {
		const mgr = new ScopeManager();
		mgr.acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "test",
		});
		const lease2 = mgr.acquireLease({
			actor: "agent-2",
			scope: ["tests/**"],
			intent: "test",
		});
		mgr.releaseLease(lease2.lease_id);

		const active = mgr.getActiveLeases();
		expect(active).toHaveLength(1);
		expect(active[0]?.actor).toBe("agent-1");
	});
});
