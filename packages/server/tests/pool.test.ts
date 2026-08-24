import type { TrustOpts } from "usertrust";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig, TenantConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import { GovernorPool } from "../src/pool.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const TENANT_A: TenantConfig = { id: "a", keyHash: hashKey("ka"), budget: 100 };
const TENANT_B: TenantConfig = {
	id: "b",
	keyHash: hashKey("kb"),
	tier: "mini",
	configPath: "/tmp/utsrv-pool/b.config.json",
};

function config(): ServerConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		stateDir: "/tmp/utsrv-pool",
		enforcement: "enforce",
		pendingTtlMs: 300_000,
		requestTimeoutMs: 10_000,
		dryRun: true,
		tenants: [TENANT_A, TENANT_B],
	};
}

describe("GovernorPool", () => {
	it("creates one governor per tenant, lazily, with tenant-scoped opts", async () => {
		const seen: TrustOpts[] = [];
		const pool = new GovernorPool(config(), async (opts) => {
			seen.push(opts);
			return createFakeGovernor().governor;
		});
		const g1 = await pool.get(TENANT_A);
		const g2 = await pool.get(TENANT_A);
		expect(g1).toBe(g2);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.vaultBase).toContain("a");
		expect(seen[0]?.budget).toBe(100);
		expect(seen[0]?.dryRun).toBe(true);
		await pool.get(TENANT_B);
		expect(seen).toHaveLength(2);
		expect(seen[1]?.budget).toBeUndefined();
		expect(seen[1]?.tier).toBe("mini");
		expect(seen[1]?.configPath).toBe("/tmp/utsrv-pool/b.config.json");
	});

	it("concurrent get() for the same tenant creates a single governor", async () => {
		let creations = 0;
		const pool = new GovernorPool(config(), async () => {
			creations += 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return createFakeGovernor().governor;
		});
		const [g1, g2] = await Promise.all([pool.get(TENANT_A), pool.get(TENANT_A)]);
		expect(g1).toBe(g2);
		expect(creations).toBe(1);
	});

	it("a failed factory does not poison the cache — the next get() retries", async () => {
		let attempts = 0;
		const pool = new GovernorPool(config(), async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("governor boot failure");
			return createFakeGovernor().governor;
		});
		await expect(pool.get(TENANT_A)).rejects.toThrow("governor boot failure");
		const governor = await pool.get(TENANT_A);
		expect(governor).toBeDefined();
		expect(attempts).toBe(2);
	});

	it("destroyAll destroys every created governor", async () => {
		let destroyed = 0;
		const pool = new GovernorPool(config(), async () => {
			const { governor } = createFakeGovernor();
			const original = governor.destroy.bind(governor);
			governor.destroy = async () => {
				destroyed += 1;
				await original();
			};
			return governor;
		});
		await pool.get(TENANT_A);
		await pool.get(TENANT_B);
		await pool.destroyAll();
		expect(destroyed).toBe(2);
	});
});

describe("GovernorPool.destroyAll — construction that lands after shutdown", () => {
	it("destroys a governor that resolves after the shutdown deadline", async () => {
		// AGENTS.md: callers MUST destroy every governor or the process hangs on the
		// TigerBeetle client — an open client is exactly what keeps the event loop
		// from draining, so an abandoned late governor does not merely leak, it can
		// stop the process exiting. destroyAll() gave up waiting; the governor still
		// arrived.
		const fake = createFakeGovernor();
		let destroyed = false;
		const governor = {
			...fake.governor,
			destroy: async () => {
				destroyed = true;
			},
		};
		const pool = new GovernorPool({ ...config(), requestTimeoutMs: 100 }, async () => {
			await new Promise((resolve) => setTimeout(resolve, 400));
			return governor;
		});
		void pool.get(TENANT_A);
		await pool.destroyAll();
		// destroyAll returned without waiting it out...
		expect(destroyed).toBe(false);
		// ...but the governor is still destroyed once it exists.
		await vi.waitFor(() => expect(destroyed).toBe(true), { timeout: 5_000 });
	}, 20_000);
});

describe("GovernorPool.destroyAll — teardown REPORTS whether it finished", () => {
	/** A governor whose destroy() takes `ms`, like a settling headless teardown. */
	function slowDestroy(ms: number) {
		const { governor } = createFakeGovernor();
		return {
			...governor,
			destroy: () => new Promise<void>((resolve) => setTimeout(resolve, ms)),
		} as typeof governor;
	}

	it("reports a teardown cut short by the budget as ABANDONED, not as success", async () => {
		// The defect this replaces: destroyAll returned Promise<void> over
		// Promise.allSettled, so a governor abandoned mid-void was indistinguishable
		// from one that flushed. close() resolved identically and the CLI exited 0.
		const cfg = { ...config(), requestTimeoutMs: 10_000, shutdownTimeoutMs: 30 };
		const pool = new GovernorPool(cfg, async () => slowDestroy(300));
		await pool.get(TENANT_A);

		const report = await pool.destroyAll();

		expect(report.abandoned).toHaveLength(1);
		expect(report.completed).toBe(0);
		expect(report.abandoned[0]?.reason).toMatch(/destroy/i);
	}, 10_000);

	it("reports a teardown that FINISHES as completed", async () => {
		// Positive control: a report that always said "abandoned" would pass the test
		// above while making every clean shutdown look like a truncated one.
		const cfg = { ...config(), shutdownTimeoutMs: 5_000 };
		const pool = new GovernorPool(cfg, async () => slowDestroy(10));
		await pool.get(TENANT_A);

		const report = await pool.destroyAll();

		expect(report.abandoned).toHaveLength(0);
		expect(report.completed).toBe(1);
	}, 10_000);

	it("bounds teardown by the SHUTDOWN budget, never the request budget", async () => {
		// The arithmetic certainty this fixes: destroy() waits up to 5s for in-flight
		// work while the request default is 4s, so sharing one number pre-empted the
		// money path on EVERY shutdown during settlement — by construction, not by
		// bad luck. A tiny request timeout must not truncate teardown.
		const cfg = { ...config(), requestTimeoutMs: 20, shutdownTimeoutMs: 5_000 };
		const pool = new GovernorPool(cfg, async () => slowDestroy(200));
		await pool.get(TENANT_A);

		const report = await pool.destroyAll();

		expect(report.completed).toBe(1);
		expect(report.abandoned).toHaveLength(0);
	}, 10_000);
});
