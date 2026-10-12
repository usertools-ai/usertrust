import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBudgetConfig, type TrustOpts } from "usertrust";
import { describe, expect, it } from "vitest";
import type { ServerConfig, TenantConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import { GovernorPool, tenantVaultBase } from "../src/pool.js";
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

describe.skipIf(process.platform === "win32")("tenantVaultBase", () => {
	const base = (stateDir: string): string => tenantVaultBase({ ...config(), stateDir }, TENANT_A);

	it("strips trailing separators, so no `//` reaches a path or a message", () => {
		expect(base("/srv/state/")).toBe("/srv/state/a");
		expect(base("/srv/state//")).toBe("/srv/state/a");
		expect(base("/srv/state")).toBe("/srv/state/a");
	});

	it("keeps a root's own separator, and reads an empty stateDir as the working directory", () => {
		expect(base("/")).toBe("/a");
		expect(base("")).toBe("a");
	});

	it("resolves nothing: a `..` reaches the governor as written", () => {
		expect(base("link/../state/")).toBe("link/../state/a");
		expect(base("./state")).toBe("./state/a");
	});
});

// A tenant's budget reaches its governor in memory only (`opts.budget`), so the tenant vault's config file never held
// it: the ledger UI and `inspect` read "no budget set" and a negative remaining. The governor records the budget it
// ENFORCES in the tenant vault, where those readers look.
describe("a tenant vault carries the tenant's enforced budget (red-first: read as none)", () => {
	it("the real governor, through the pool: the tenant vault reads budget 2000 from the governor", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-pool-budget-"));
		try {
			const tenant: TenantConfig = { id: "acme", keyHash: hashKey("k"), budget: 2_000 };
			const pool = new GovernorPool({ ...config(), stateDir, tenants: [tenant] });
			const governor = await pool.get(tenant);
			// Published from its first append: the process then holds the tenant vault's writer lock.
			const auth = await governor.authorize({
				model: "claude-haiku-5-5",
				estimatedInputTokens: 10,
				maxOutputTokens: 1,
			});
			await governor.settle(auth, { inputTokens: 1, outputTokens: 1 });
			await pool.destroyAll();
			const vault = join(tenantVaultBase({ ...config(), stateDir }, tenant), ".usertrust");
			expect(loadBudgetConfig(vault)).toMatchObject({ budget: 2_000, source: "governor" });
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});
});
