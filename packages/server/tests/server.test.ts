import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import * as api from "../src/index.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";
import { createFakeGovernor, type FakeGovernorHandle } from "./helpers/fake-governor.js";

const KEY = "ut_srv_key";

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		stateDir: "/tmp/utsrv-http",
		enforcement: "enforce",
		pendingTtlMs: 300_000,
		dryRun: true,
		tenants: [{ id: "acme", keyHash: hashKey(KEY) }],
		...overrides,
	};
}

let server: UsertrustServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

async function start(
	overrides: Partial<ServerConfig> = {},
	fakeOpts: { budget?: number; denyReason?: string } = {},
): Promise<{ base: string; fake: FakeGovernorHandle }> {
	const fake = createFakeGovernor(fakeOpts);
	server = createUsertrustServer({ config: config(overrides), factory: async () => fake.governor });
	const { port } = await server.listen();
	return { base: `http://127.0.0.1:${port}`, fake };
}

function post(base: string, path: string, body: unknown, key = KEY): Promise<Response> {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify(body),
	});
}

describe("HTTP control plane", () => {
	it("health is public and reports ok", async () => {
		const { base } = await start();
		const res = await fetch(`${base}/v1/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; name: string };
		expect(body.ok).toBe(true);
		expect(body.name).toBe("usertrust-server");
	});

	it("rejects missing or wrong bearer key with 401", async () => {
		const { base } = await start();
		expect((await fetch(`${base}/v1/budget`)).status).toBe(401);
		expect((await post(base, "/v1/authorize", { model: "m" }, "wrong-key")).status).toBe(401);
	});

	it("rejects empty or whitespace-only bearer tokens with 401", async () => {
		const { base } = await start();
		// "Bearer \u00A0" survives fetch's ASCII-whitespace header normalization,
		// exercising the whitespace-only token guard behind it.
		for (const header of ["Bearer", "Bearer ", "Bearer    ", "Bearer \u00A0"]) {
			const res = await fetch(`${base}/v1/budget`, { headers: { authorization: header } });
			expect(res.status).toBe(401);
		}
	});

	it("authorize -> settle happy path returns a receipt", async () => {
		const { base, fake } = await start();
		const authRes = await post(base, "/v1/authorize", {
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 10,
			maxOutputTokens: 5,
		});
		expect(authRes.status).toBe(200);
		const auth = (await authRes.json()) as { transferId: string; estimatedCost: number };
		expect(auth.estimatedCost).toBe(15);
		const settleRes = await post(base, "/v1/settle", {
			transferId: auth.transferId,
			inputTokens: 10,
			outputTokens: 2,
		});
		expect(settleRes.status).toBe(200);
		const receipt = (await settleRes.json()) as { cost: number; settled: boolean };
		expect(receipt.settled).toBe(true);
		expect(receipt.cost).toBe(12);
		expect(fake.calls.settled).toHaveLength(1);
	});

	it("/v1/health advertises its capabilities — in dryRun AND with a ledger", async () => {
		// A client sends `principal` only to a server that lists it (an older server
		// strips the key and records the call as nobody's), so a missing entry here
		// silently loses all attribution.
		for (const dryRun of [true, false]) {
			const { base } = await start({ dryRun });
			const body = (await (await fetch(`${base}/v1/health`)).json()) as { capabilities?: unknown };
			expect(body.capabilities).toEqual([
				"principal",
				"authorize-cache-tiers",
				"hold-expiry",
				"release",
			]);
			await server?.close();
			server = undefined;
		}
	});

	it("a plugin-shaped principal ({ id, type, origin }) is accepted and forwarded, alone or with unit and role", async () => {
		const { base, fake } = await start();
		const plugin = { id: "a7f3", type: "Explore", origin: "claude-code:0b9e-4c11" };
		for (const principal of [plugin, { ...plugin, unit: "receipts", role: "reviewer" }]) {
			const res = await post(base, "/v1/authorize", {
				model: "m",
				estimatedInputTokens: 1,
				maxOutputTokens: 1,
				principal,
			});
			expect(res.status).toBe(200);
		}
		expect(fake.calls.authorizeParams.map((p) => p.principal)).toEqual([
			plugin,
			{ ...plugin, unit: "receipts", role: "reviewer" },
		]);
	});

	it("forwards the per-tier estimates to governor.authorize(), and refuses invalid counts with a 400", async () => {
		// Without the two fields on the wire schema, zod strips them and a mostly-cache-read
		// window is held at the cache-WRITE rate — a false 402 near a budget.
		const { base, fake } = await start();
		const res = await post(base, "/v1/authorize", {
			model: "m",
			estimatedInputTokens: 150,
			estimatedCacheReadTokens: 82_000,
			estimatedCacheWriteTokens: 2_000,
			maxOutputTokens: 1_000,
		});
		expect(res.status).toBe(200);
		expect(fake.calls.authorizeParams[0]).toMatchObject({
			estimatedInputTokens: 150,
			estimatedCacheReadTokens: 82_000,
			estimatedCacheWriteTokens: 2_000,
			maxOutputTokens: 1_000,
		});
		for (const bad of [-1, 1.5, "82000"]) {
			for (const field of ["estimatedCacheReadTokens", "estimatedCacheWriteTokens"]) {
				const r = await post(base, "/v1/authorize", { model: "m", [field]: bad });
				expect(r.status).toBe(400);
			}
		}
		expect(fake.calls.authorizeParams).toHaveLength(1);
	});

	it("forwards the actor and the principal to governor.authorize()", async () => {
		// Without `principal` on the wire schema, zod strips it and the request still
		// returns 200: the D4 silent-strip failure, for WHO did the work.
		const { base, fake } = await start();
		const principal = { id: "a7f3", type: "Explore", unit: "receipts", role: "reviewer" };
		const res = await post(base, "/v1/authorize", {
			model: "m",
			estimatedInputTokens: 1,
			maxOutputTokens: 1,
			actor: "claude-code:s-1:Explore:a7f3",
			principal,
		});
		expect(res.status).toBe(200);
		expect(fake.calls.authorizeParams[0]).toMatchObject({
			actor: "claude-code:s-1:Explore:a7f3",
			principal,
		});
	});

	it("a principal the governor would refuse is a 400 BEFORE the governor is asked", async () => {
		const { base, fake } = await start();
		for (const principal of [
			{ unit: "has space" },
			{ role: "" },
			{ id: "x".repeat(129) },
			{ unit: "receipts", extra: "never silently stripped" },
			{ id: "a7f3", type: "Explore", origin: "claude-code:s-1", session: "unknown key" },
			{ origin: "has space" },
			"receipts",
		]) {
			const res = await post(base, "/v1/authorize", { model: "m", principal });
			expect(res.status).toBe(400);
		}
		expect(fake.calls.authorizeParams).toHaveLength(0);
	});

	it("forwards computeMs from the settle body to governor.settle()", async () => {
		const { base, fake } = await start();
		const auth = (await (
			await post(base, "/v1/authorize", {
				model: "llama3.2",
				estimatedInputTokens: 10,
				maxOutputTokens: 5,
			})
		).json()) as { transferId: string };
		const settleRes = await post(base, "/v1/settle", {
			transferId: auth.transferId,
			inputTokens: 10,
			outputTokens: 2,
			computeMs: 4709,
		});
		expect(settleRes.status).toBe(200);
		expect(fake.calls.settleParams).toHaveLength(1);
		expect(fake.calls.settleParams[0]?.computeMs).toBe(4709);
	});

	it("abort voids the pending hold", async () => {
		const { base, fake } = await start();
		const auth = (await (
			await post(base, "/v1/authorize", { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 })
		).json()) as { transferId: string };
		const res = await post(base, "/v1/abort", { transferId: auth.transferId, error: "boom" });
		expect(res.status).toBe(200);
		expect(fake.calls.aborted).toEqual([auth.transferId]);
	});

	it("policy denial maps to 403 and budget exhaustion to 402", async () => {
		const denied = await start({}, { denyReason: "blocked by rule" });
		const res403 = await post(denied.base, "/v1/authorize", { model: "m" });
		expect(res403.status).toBe(403);
		await server?.close();
		const broke = await start({}, { budget: 1 });
		const res402 = await post(broke.base, "/v1/authorize", {
			model: "m",
			estimatedInputTokens: 10,
			maxOutputTokens: 10,
		});
		expect(res402.status).toBe(402);
	});

	it("settle/abort of unknown transferId returns 404", async () => {
		const { base } = await start();
		expect((await post(base, "/v1/settle", { transferId: "tx_nope" })).status).toBe(404);
		expect((await post(base, "/v1/abort", { transferId: "tx_nope" })).status).toBe(404);
	});

	it("settling the same transferId twice returns 404 the second time", async () => {
		const { base } = await start();
		const auth = (await (
			await post(base, "/v1/authorize", { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 })
		).json()) as { transferId: string };
		expect((await post(base, "/v1/settle", { transferId: auth.transferId })).status).toBe(200);
		expect((await post(base, "/v1/settle", { transferId: auth.transferId })).status).toBe(404);
	});

	it("a failed settle re-inserts the pending entry so it is retryable", async () => {
		const fake = createFakeGovernor();
		const originalSettle = fake.governor.settle.bind(fake.governor);
		let failures = 1;
		fake.governor.settle = async (auth, params) => {
			if (failures > 0) {
				failures -= 1;
				throw new Error("transient governor failure");
			}
			return originalSettle(auth, params);
		};
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const auth = (await (
			await post(base, "/v1/authorize", { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 })
		).json()) as { transferId: string };
		const first = await post(base, "/v1/settle", { transferId: auth.transferId });
		expect(first.status).toBe(500);
		expect(server.pendingCount()).toBe(1);
		const second = await post(base, "/v1/settle", { transferId: auth.transferId });
		expect(second.status).toBe(200);
		expect(server.pendingCount()).toBe(0);
	});

	it("close() RELEASES remaining pending holds: a shutdown is no failure", async () => {
		const { base, fake } = await start();
		const auth = (await (
			await post(base, "/v1/authorize", { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 })
		).json()) as { transferId: string };
		expect(server?.pendingCount()).toBe(1);
		await server?.close();
		expect(fake.calls.released).toEqual([auth.transferId]);
		expect(fake.calls.releaseReasons).toEqual(["server shutdown"]);
		expect(fake.calls.aborted).toEqual([]);
		expect(server?.pendingCount()).toBe(0);
		server = undefined;
	});

	it("malformed JSON body returns 400", async () => {
		const { base } = await start();
		const res = await fetch(`${base}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: "{not json",
		});
		expect(res.status).toBe(400);
	});

	it("budget endpoint reports remaining budget", async () => {
		const { base } = await start();
		const res = await fetch(`${base}/v1/budget`, {
			headers: { authorization: `Bearer ${KEY}` },
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { remaining: number }).remaining).toBe(10_000);
	});

	it("unknown route returns 404", async () => {
		const { base } = await start();
		expect(
			(await fetch(`${base}/v1/nope`, { headers: { authorization: `Bearer ${KEY}` } })).status,
		).toBe(404);
	});
});

describe("edge cases and failure paths", () => {
	it("invalid authorize/settle/abort payloads return 400", async () => {
		const { base } = await start();
		expect((await post(base, "/v1/authorize", { model: 123 })).status).toBe(400);
		expect((await post(base, "/v1/settle", {})).status).toBe(400);
		expect((await post(base, "/v1/abort", { transferId: 5 })).status).toBe(400);
	});

	it("an empty POST body is treated as an empty object", async () => {
		const { base } = await start();
		const res = await fetch(`${base}/v1/settle`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		});
		expect(res.status).toBe(400);
	});

	it("a body over 1 MiB returns 413", async () => {
		const { base } = await start();
		const res = await fetch(`${base}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: `{"model":"${"x".repeat(1024 * 1024 + 64)}"}`,
		});
		expect(res.status).toBe(413);
	});

	it("abort without an error field records the default reason", async () => {
		const { base, fake } = await start();
		const seen: unknown[] = [];
		server?.bus.subscribe("acme", (e) => seen.push(e));
		const auth = (await (
			await post(base, "/v1/authorize", { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 })
		).json()) as { transferId: string };
		expect((await post(base, "/v1/abort", { transferId: auth.transferId })).status).toBe(200);
		expect(fake.calls.aborted).toEqual([auth.transferId]);
		const aborted = seen.find((e) => (e as { type: string }).type === "aborted") as
			| { reason: string }
			| undefined;
		expect(aborted?.reason).toBe("aborted");
	});

	it("a failed abort re-inserts the pending entry so it is retryable", async () => {
		const fake = createFakeGovernor();
		const originalAbort = fake.governor.abort.bind(fake.governor);
		let failures = 1;
		fake.governor.abort = async (auth, error) => {
			if (failures > 0) {
				failures -= 1;
				throw new Error("transient governor failure");
			}
			return originalAbort(auth, error);
		};
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const auth = (await (
			await post(base, "/v1/authorize", { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 })
		).json()) as { transferId: string };
		expect((await post(base, "/v1/abort", { transferId: auth.transferId })).status).toBe(500);
		expect(server.pendingCount()).toBe(1);
		expect((await post(base, "/v1/abort", { transferId: auth.transferId })).status).toBe(200);
		expect(server.pendingCount()).toBe(0);
	});

	it("one tenant cannot settle another tenant's transfer", async () => {
		const KEY2 = "ut_srv_key_2";
		const { base } = await start({
			tenants: [
				{ id: "acme", keyHash: hashKey(KEY) },
				{ id: "globex", keyHash: hashKey(KEY2) },
			],
		});
		const auth = (await (
			await post(base, "/v1/authorize", { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 })
		).json()) as { transferId: string };
		expect((await post(base, "/v1/settle", { transferId: auth.transferId }, KEY2)).status).toBe(
			404,
		);
		expect((await post(base, "/v1/settle", { transferId: auth.transferId })).status).toBe(200);
	});

	it("sweepExpired leaves fresh pending holds alone", async () => {
		const { base } = await start();
		await post(base, "/v1/authorize", { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 });
		expect(server?.pendingCount()).toBe(1);
		expect(await server?.sweepExpired()).toBe(0);
		expect(server?.pendingCount()).toBe(1);
	});

	it("a governor factory failure surfaces as an opaque 500", async () => {
		server = createUsertrustServer({
			config: config(),
			factory: async () => {
				throw new Error("factory down: /secret/path");
			},
		});
		const { port } = await server.listen();
		const res = await fetch(`http://127.0.0.1:${port}/v1/budget`, {
			headers: { authorization: `Bearer ${KEY}` },
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string; reason: string };
		expect(body.error).toBe("internal");
		expect(body.reason).not.toContain("secret");
	});

	it("close() before listen() resolves cleanly", async () => {
		const fake = createFakeGovernor();
		const unstarted = createUsertrustServer({
			config: config(),
			factory: async () => fake.governor,
		});
		await expect(unstarted.close()).resolves.toBeUndefined();
	});

	it("listen() rejects when the port is already taken", async () => {
		const { createServer: createNetServer } = await import("node:net");
		const blocker = createNetServer();
		const port = await new Promise<number>((resolve) => {
			blocker.listen(0, "127.0.0.1", () => {
				const address = blocker.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		try {
			const fake = createFakeGovernor();
			const clashing = createUsertrustServer({
				config: config({ port }),
				factory: async () => fake.governor,
			});
			await expect(clashing.listen()).rejects.toThrow();
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("the public index re-exports the full server surface", () => {
		expect(api.createUsertrustServer).toBeTypeOf("function");
		expect(api.loadServerConfig).toBeTypeOf("function");
		expect(api.resolveTenant).toBeTypeOf("function");
		expect(api.hashKey).toBeTypeOf("function");
		expect(api.GovernorPool).toBeTypeOf("function");
		expect(api.EventBus).toBeTypeOf("function");
		expect(api.toHttpError).toBeTypeOf("function");
		expect(api.AuthorizeRequestSchema).toBeDefined();
		expect(api.SettleRequestSchema).toBeDefined();
		expect(api.AbortRequestSchema).toBeDefined();
	});
});
