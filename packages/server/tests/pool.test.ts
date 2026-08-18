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
