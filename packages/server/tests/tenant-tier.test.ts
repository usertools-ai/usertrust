import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyDeniedError, VAULT_DIR } from "usertrust";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerConfig, TenantConfig } from "../src/config.js";
import { hashKey, loadServerConfig } from "../src/config.js";
import { GovernorPool, tenantVaultBase } from "../src/pool.js";

/**
 * A tenant's tier reaches the policy rules that match on `tier`. It was handed to the governor and
 * ignored, so every tenant was evaluated at the config file's tier and a deny rule for the tenant's
 * own tier never fired.
 */

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "utsrv-tier-"));
	process.env.USERTRUST_TEST = "1";
});

afterEach(async () => {
	process.env.USERTRUST_TEST = "";
	await rm(dir, { recursive: true, force: true });
});

async function writeServerConfig(tenants: unknown[]): Promise<string> {
	const path = join(dir, "usertrust-server.config.json");
	await writeFile(path, JSON.stringify({ tenants, dryRun: true, stateDir: join(dir, "state") }));
	return path;
}

/** A tenant config file (no tier in it) that points at the tenant's policy file. */
async function tenantConfigFile(): Promise<string> {
	const path = join(dir, "tenant.config.json");
	await writeFile(path, JSON.stringify({ budget: 50_000, policies: "./policies/default.yml" }));
	return path;
}

/** Put in each tenant's own vault a policy whose only rule denies every call evaluated at "free". */
async function seedDenyFree(config: ServerConfig): Promise<void> {
	for (const tenant of config.tenants) {
		const policies = join(tenantVaultBase(config, tenant), VAULT_DIR, "policies");
		await mkdir(policies, { recursive: true, mode: 0o700 });
		await writeFile(
			join(policies, "default.yml"),
			JSON.stringify({
				rules: [
					{
						name: "deny-free",
						effect: "deny",
						enforcement: "hard",
						conditions: [{ field: "tier", operator: "eq", value: "free" }],
					},
				],
			}),
		);
	}
}

const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 100, maxOutputTokens: 50 };

describe("a tenant's tier", () => {
	it("a tenant configured 'free' is denied by a rule on tier 'free'", async () => {
		const configPath = await tenantConfigFile();
		const tenant: TenantConfig = { id: "t-free", keyHash: hashKey("k1"), tier: "free", configPath };
		const config = (await loadServerConfig(await writeServerConfig([tenant]))) as ServerConfig;
		await seedDenyFree(config);
		const pool = new GovernorPool(config);
		const governor = await pool.get(tenant);
		await expect(governor.authorize(AUTHORIZE)).rejects.toBeInstanceOf(PolicyDeniedError);
		await pool.destroyAll();
	});

	it("a tenant configured 'pro' is not denied by that rule", async () => {
		const configPath = await tenantConfigFile();
		const tenant: TenantConfig = { id: "t-pro", keyHash: hashKey("k2"), tier: "pro", configPath };
		const config = (await loadServerConfig(await writeServerConfig([tenant]))) as ServerConfig;
		await seedDenyFree(config);
		const pool = new GovernorPool(config);
		const governor = await pool.get(tenant);
		await expect(governor.authorize(AUTHORIZE)).resolves.toBeDefined();
		await pool.destroyAll();
	});

	it("two tenants on one server are each evaluated at their own tier", async () => {
		const configPath = await tenantConfigFile();
		const free: TenantConfig = { id: "t-a", keyHash: hashKey("k3"), tier: "free", configPath };
		const pro: TenantConfig = { id: "t-b", keyHash: hashKey("k4"), tier: "pro", configPath };
		const config = (await loadServerConfig(await writeServerConfig([free, pro]))) as ServerConfig;
		await seedDenyFree(config);
		const pool = new GovernorPool(config);
		await expect((await pool.get(free)).authorize(AUTHORIZE)).rejects.toBeInstanceOf(
			PolicyDeniedError,
		);
		await expect((await pool.get(pro)).authorize(AUTHORIZE)).resolves.toBeDefined();
		await pool.destroyAll();
	});

	for (const bad of ["enterprise", "Pro", ""]) {
		it(`the server refuses to load a tenant with the tier ${JSON.stringify(bad)}`, async () => {
			const path = await writeServerConfig([{ id: "t", keyHash: hashKey("k5"), tier: bad }]);
			await expect(loadServerConfig(path)).rejects.toThrow();
		});
	}

	it("loads every tier the core config knows", async () => {
		const tenants = ["free", "mini", "pro", "mega", "ultra"].map((tier, i) => ({
			id: `t${i}`,
			keyHash: hashKey(`kk${i}`),
			tier,
		}));
		const config = await loadServerConfig(await writeServerConfig(tenants));
		expect(config.tenants.map((t) => t.tier)).toEqual(["free", "mini", "pro", "mega", "ultra"]);
	});
});
