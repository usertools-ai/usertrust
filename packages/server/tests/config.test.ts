import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashKey, loadServerConfig, MAX_PENDING_TTL_MS, resolveTenant } from "../src/config.js";

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
		// Inside the ledger's own 300 s pending timeout by a full sweep interval.
		expect(config.pendingTtlMs).toBe(240_000);
		expect(config.tenants[0]?.id).toBe("acme");
	});

	it("refuses a pendingTtlMs the sweep could not honour before the ledger expires the hold", async () => {
		// 300 s is the ledger's pending timeout; the sweep runs every 30 s, so a hold
		// with this TTL could still be pending here when TigerBeetle voids it.
		await expect(loadServerConfig(await writeConfig({ pendingTtlMs: 300_000 }))).rejects.toThrow();
		// A full sweep interval to claim the hold, and a second one of margin.
		expect(MAX_PENDING_TTL_MS).toBe(300_000 - 2 * 30_000);
		await expect(loadServerConfig(await writeConfig({ pendingTtlMs: 269_999 }))).rejects.toThrow();
		await expect(
			loadServerConfig(await writeConfig({ pendingTtlMs: MAX_PENDING_TTL_MS })),
		).resolves.toBeDefined();
		await expect(
			loadServerConfig(await writeConfig({ pendingTtlMs: MAX_PENDING_TTL_MS + 1 })),
		).rejects.toThrow();
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
