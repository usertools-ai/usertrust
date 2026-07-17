import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashKey, loadServerConfig, resolveTenant } from "../src/config.js";

const KEY = "ut_srv_test_key_1";

async function writeConfig(overrides: Record<string, unknown> = {}): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "utsrv-"));
	const path = join(dir, "usertrust-server.config.json");
	await writeFile(
		path,
		JSON.stringify({
			tenants: [{ id: "acme", keyHash: hashKey(KEY), budget: 5000 }],
			...overrides,
		}),
	);
	return path;
}

describe("loadServerConfig", () => {
	it("loads config with defaults applied", async () => {
		const config = await loadServerConfig(await writeConfig());
		expect(config.port).toBe(4519);
		expect(config.host).toBe("127.0.0.1");
		expect(config.enforcement).toBe("enforce");
		expect(config.pendingTtlMs).toBe(300_000);
		expect(config.tenants[0]?.id).toBe("acme");
	});

	it("rejects invalid enforcement mode", async () => {
		const path = await writeConfig({ enforcement: "yolo" });
		await expect(loadServerConfig(path)).rejects.toThrow();
	});

	it("rejects tenants with malformed keyHash", async () => {
		const path = await writeConfig({ tenants: [{ id: "a", keyHash: "nothex" }] });
		await expect(loadServerConfig(path)).rejects.toThrow();
	});

	it("rejects duplicate tenant ids", async () => {
		const path = await writeConfig({
			tenants: [
				{ id: "a", keyHash: hashKey("k1") },
				{ id: "a", keyHash: hashKey("k2") },
			],
		});
		await expect(loadServerConfig(path)).rejects.toThrow(/duplicate tenant id/i);
	});

	it("rejects duplicate tenant keyHashes across distinct ids (auth misrouting)", async () => {
		const path = await writeConfig({
			tenants: [
				{ id: "a", keyHash: hashKey("shared") },
				{ id: "b", keyHash: hashKey("shared") },
			],
		});
		await expect(loadServerConfig(path)).rejects.toThrow(/duplicate tenant keyHash/i);
	});

	it("rejects a tenant id with path-traversal characters (vaultBase safety)", async () => {
		const path = await writeConfig({ tenants: [{ id: "../etc", keyHash: hashKey("k") }] });
		await expect(loadServerConfig(path)).rejects.toThrow();
	});
});

describe("resolveTenant", () => {
	it("resolves the tenant for a valid key and rejects a wrong key", async () => {
		const config = await loadServerConfig(await writeConfig());
		expect(resolveTenant(config, KEY)?.id).toBe("acme");
		expect(resolveTenant(config, "wrong")).toBeNull();
	});
});
