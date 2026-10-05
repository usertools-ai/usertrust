import { AlreadySettledError, LedgerUnavailableError, sanitizeReleaseReason } from "usertrust";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { hashKey, MAX_PENDING_TTL_MS } from "../src/config.js";
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
		pendingTtlMs: 240_000,
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
	fakeOpts: Parameters<typeof createFakeGovernor>[0] = {},
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

	it("health names the capabilities a client must not assume an older server has", async () => {
		// An older server strips unknown request keys, so a client that retried a
		// settle under an idempotencyKey that server silently dropped would post twice.
		const { base } = await start();
		const body = (await (await fetch(`${base}/v1/health`)).json()) as { capabilities: string[] };
		expect(body.capabilities).toEqual([
			"release",
			"idempotency-key",
			"principal",
			"settlement-unrecoverable",
		]);
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

	it("close() RELEASES remaining pending holds — a shutdown is not a failed call (#204)", async () => {
		const { base, fake } = await start();
		const seen: Array<{ type: string; reason?: string }> = [];
		server?.bus.subscribe("acme", (e) => seen.push(e as { type: string; reason?: string }));
		const auth = (await (
			await post(base, "/v1/authorize", { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 })
		).json()) as { transferId: string };
		expect(server?.pendingCount()).toBe(1);
		await server?.close();
		expect(fake.calls.released).toEqual([
			{ transferId: auth.transferId, reason: "server shutdown" },
		]);
		expect(fake.calls.aborted).toEqual([]);
		expect(seen.find((e) => e.type === "released")?.reason).toBe("server shutdown");
		expect(seen.some((e) => e.type === "aborted")).toBe(false);
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

describe("evaluate_only shadows governance decisions only", () => {
	it.each([
		["a ledger outage", () => new LedgerUnavailableError("tb down"), 503],
		["a key already charged", () => new AlreadySettledError(), 409],
	])("never shadows %s: the client must not go ahead", async (_label, error, status) => {
		const fake = createFakeGovernor();
		fake.governor.authorize = async () => {
			throw error();
		};
		server = createUsertrustServer({
			config: config({ enforcement: "evaluate_only" }),
			factory: async () => fake.governor,
		});
		const { port } = await server.listen();
		const res = await post(`http://127.0.0.1:${port}`, "/v1/authorize", { model: "m" });
		expect(res.status).toBe(status);
		expect(((await res.json()) as { shadow?: boolean }).shadow).toBeUndefined();
	});

	it("still shadows a policy denial (the control)", async () => {
		const { base } = await start({ enforcement: "evaluate_only" }, { denyReason: "no" });
		const res = await post(base, "/v1/authorize", { model: "m" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { shadow?: boolean }).shadow).toBe(true);
	});
});

describe("the TTL sweep must beat the ledger's own expiry", () => {
	it("refuses a pendingTtlMs past MAX_PENDING_TTL_MS, even when the config is built in code", () => {
		expect(() =>
			createUsertrustServer({
				config: config({ pendingTtlMs: MAX_PENDING_TTL_MS + 1 }),
				factory: async () => createFakeGovernor().governor,
			}),
		).toThrow(/pendingTtlMs/);
	});
});

describe("release (#204)", () => {
	async function authorize(base: string, extra: Record<string, unknown> = {}) {
		const res = await post(base, "/v1/authorize", {
			model: "m",
			estimatedInputTokens: 1,
			maxOutputTokens: 1,
			...extra,
		});
		return { res, body: (await res.json()) as { transferId: string; error?: string } };
	}

	it("POST /v1/release gives the hold back, neutrally, and announces it", async () => {
		const { base, fake } = await start();
		const seen: Array<{ type: string; transferId?: string; reason?: string }> = [];
		server?.bus.subscribe("acme", (e) => seen.push(e as never));
		const { body: auth } = await authorize(base);

		const res = await post(base, "/v1/release", {
			transferId: auth.transferId,
			reason: "not needed",
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ released: true, transferId: auth.transferId });
		expect(fake.calls.released).toEqual([{ transferId: auth.transferId, reason: "not needed" }]);
		expect(fake.calls.aborted).toEqual([]);
		expect(seen.find((e) => e.type === "released")).toMatchObject({
			transferId: auth.transferId,
			reason: "not needed",
		});
		expect(server?.pendingCount()).toBe(0);
	});

	it("announces the reason the CHAIN recorded — control characters stripped, clipped — never the raw body", async () => {
		const { base } = await start();
		const seen: Array<{ type: string; reason?: string }> = [];
		server?.bus.subscribe("acme", (e) => seen.push(e as never));
		const { body: auth } = await authorize(base);

		const reason = `user cancelled${String.fromCharCode(0x1b)}[2J${"x".repeat(400)}`;
		await post(base, "/v1/release", { transferId: auth.transferId, reason });

		const announced = seen.find((e) => e.type === "released")?.reason ?? "";
		expect(announced).toBe(sanitizeReleaseReason(reason));
		expect(announced).not.toContain(String.fromCharCode(0x1b));
		expect([...announced]).toHaveLength(200);
	});

	it("an unknown transferId is 404, a malformed body 400, and a second release 404", async () => {
		const { base } = await start();
		expect((await post(base, "/v1/release", { transferId: "tx_nope" })).status).toBe(404);
		expect((await post(base, "/v1/release", { transferId: 5 })).status).toBe(400);
		const { body: auth } = await authorize(base);
		expect((await post(base, "/v1/release", { transferId: auth.transferId })).status).toBe(200);
		expect((await post(base, "/v1/release", { transferId: auth.transferId })).status).toBe(404);
	});

	it("a failed release re-inserts the pending entry so it is retryable", async () => {
		const fake = createFakeGovernor();
		const original = fake.governor.release.bind(fake.governor);
		let failures = 1;
		fake.governor.release = async (auth, reason) => {
			if (failures > 0) {
				failures -= 1;
				throw new Error("transient governor failure");
			}
			return original(auth, reason);
		};
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const { body: auth } = await authorize(base);
		expect((await post(base, "/v1/release", { transferId: auth.transferId })).status).toBe(500);
		expect(server.pendingCount()).toBe(1);
		expect((await post(base, "/v1/release", { transferId: auth.transferId })).status).toBe(200);
		expect(server.pendingCount()).toBe(0);
	});

	it("the sweep CLAIMS every due hold at once, then releases them concurrently", async () => {
		// Released one after another, a batch of expired holds eats the margin before
		// the ledger's own timeout; and a hold still in `pending` when the ledger
		// expires it can reach a normal settle and be recorded only as ambiguous.
		const fake = createFakeGovernor();
		const started: string[] = [];
		let openGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const original = fake.governor.release.bind(fake.governor);
		fake.governor.release = async (auth, reason) => {
			started.push(auth.transferId);
			await gate;
			return original(auth, reason);
		};
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) ids.push((await authorize(base)).body.transferId);

		const sweeping = server.sweepExpired(Date.now() + 600_000);
		// Claimed before any release has run, let alone finished.
		expect(server.pendingCount()).toBe(0);
		// All three releases in flight together while the gate is shut.
		await vi.waitFor(() => expect(started.sort()).toEqual([...ids].sort()));
		// A settle that arrives meanwhile is never a normal settle of a claimed hold.
		expect((await post(base, "/v1/settle", { transferId: ids[0] })).status).toBe(404);
		expect(fake.calls.settled).toHaveLength(0);

		openGate();
		expect(await sweeping).toBe(3);
		expect(fake.calls.released.map((r) => r.transferId).sort()).toEqual([...ids].sort());
	});

	it("the TTL sweep releases — never aborts — and keeps its pending_expired event", async () => {
		const { base, fake } = await start();
		const seen: Array<{ type: string }> = [];
		server?.bus.subscribe("acme", (e) => seen.push(e));
		const { body: auth } = await authorize(base);

		expect(await server?.sweepExpired(Date.now() + 600_000)).toBe(1);

		expect(fake.calls.released).toEqual([
			{ transferId: auth.transferId, reason: "pending TTL expired" },
		]);
		expect(fake.calls.aborted).toEqual([]);
		expect(seen.map((e) => e.type)).toContain("pending_expired");
	});
});

describe("caller idempotency keys and principal (#205)", () => {
	const PRINCIPAL = { id: "user-42", type: "human", origin: "cli" };

	it("forwards idempotencyKey and principal to the governor, extra principal keys stripped", async () => {
		const { base, fake } = await start();
		const res = await post(base, "/v1/authorize", {
			model: "m",
			idempotencyKey: "call-1",
			principal: { ...PRINCIPAL, apiKey: "sk-secret" },
		});
		expect(res.status).toBe(200);
		expect(fake.calls.authorizeParams[0]?.idempotencyKey).toBe("call-1");
		expect(fake.calls.authorizeParams[0]?.principal).toEqual(PRINCIPAL);
	});

	it.each([
		["a space in the key", { idempotencyKey: "call 1" }],
		["a 257-character key", { idempotencyKey: "k".repeat(257) }],
		["a non-ASCII key", { idempotencyKey: "cäll" }],
		["a principal with a space", { principal: { id: "user 42", type: "human" } }],
		["a principal missing its type", { principal: { id: "user-42" } }],
	])("refuses %s with 400, before the governor is asked", async (_label, extra) => {
		const { base, fake } = await start();
		const res = await post(base, "/v1/authorize", { model: "m", ...extra });
		expect(res.status).toBe(400);
		expect(fake.calls.authorizeParams).toHaveLength(0);
	});

	it("a replayed authorize answers with the same transferId: one pending entry, one announcement", async () => {
		const { base } = await start();
		const seen: Array<{ type: string }> = [];
		server?.bus.subscribe("acme", (e) => seen.push(e));

		const first = (await (
			await post(base, "/v1/authorize", { model: "m", idempotencyKey: "call-1" })
		).json()) as { transferId: string };
		const replay = (await (
			await post(base, "/v1/authorize", { model: "m", idempotencyKey: "call-1" })
		).json()) as { transferId: string };

		expect(replay.transferId).toBe(first.transferId);
		expect(server?.pendingCount()).toBe(1);
		expect(seen.filter((e) => e.type === "authorized")).toHaveLength(1);
	});

	it("a replay that returns a hold MID-terminal does not re-insert it", async () => {
		// A governor may hand back the same handle while that hold's settle is still
		// running; the hold is being resolved, so it must not reappear as pending.
		const fake = createFakeGovernor();
		let finishSettle: () => void = () => {};
		const settleGate = new Promise<void>((resolve) => {
			finishSettle = resolve;
		});
		const original = fake.governor.settle.bind(fake.governor);
		fake.governor.settle = async (auth, params) => {
			await settleGate;
			return original(auth, params);
		};
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const auth = (await (
			await post(base, "/v1/authorize", { model: "m", idempotencyKey: "call-1" })
		).json()) as { transferId: string };

		const settling = post(base, "/v1/settle", { transferId: auth.transferId });
		await vi.waitFor(() => expect(server?.pendingCount()).toBe(0));
		const replay = (await (
			await post(base, "/v1/authorize", { model: "m", idempotencyKey: "call-1" })
		).json()) as { transferId: string };

		expect(replay.transferId).toBe(auth.transferId);
		expect(server.pendingCount()).toBe(0);
		finishSettle();
		expect((await settling).status).toBe(200);
		expect(server.pendingCount()).toBe(0);
	});

	it("a replay does not restart the hold's TTL clock", async () => {
		const { base } = await start({ pendingTtlMs: 1_000 });
		await post(base, "/v1/authorize", { model: "m", idempotencyKey: "call-1" });
		const firstSeen = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 20));
		await post(base, "/v1/authorize", { model: "m", idempotencyKey: "call-1" });

		// Due by the FIRST authorize's clock; a refreshed createdAt would not be.
		expect(await server?.sweepExpired(firstSeen + 1_005)).toBe(1);
	});

	it("an already-charged key is 409 already_settled at authorize", async () => {
		const fake = createFakeGovernor();
		fake.governor.authorize = async () => {
			throw new AlreadySettledError();
		};
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const { port } = await server.listen();
		const res = await post(`http://127.0.0.1:${port}`, "/v1/authorize", {
			model: "m",
			idempotencyKey: "call-1",
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toBe("already_settled");
	});

	it("a settle the ledger refuses as a duplicate is 409 — and the released hold is NOT re-inserted", async () => {
		const fake = createFakeGovernor();
		const original = fake.governor.release.bind(fake.governor);
		fake.governor.settle = async (auth) => {
			// What the real governor does: release its own hold, then refuse.
			await original(auth, "already settled under this idempotency key");
			throw new AlreadySettledError();
		};
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const seen: Array<{ type: string }> = [];
		server.bus.subscribe("acme", (e) => seen.push(e));
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const auth = (await (
			await post(base, "/v1/authorize", { model: "m", idempotencyKey: "call-1" })
		).json()) as { transferId: string };

		const res = await post(base, "/v1/settle", { transferId: auth.transferId, inputTokens: 1 });

		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toBe("already_settled");
		expect(server.pendingCount()).toBe(0);
		expect(seen.map((e) => e.type)).toContain("released");
	});
});

describe("a late settle is recorded, never lost (settlement_unrecoverable)", () => {
	async function health(base: string): Promise<{ settlementsUnrecoverable: number }> {
		return (await (await fetch(`${base}/v1/health`)).json()) as {
			settlementsUnrecoverable: number;
		};
	}

	it("unknown transferId + key → 410, recorded by the governor, counted on /v1/health, announced", async () => {
		const { base, fake } = await start();
		const seen: Array<{ type: string; transferId?: string }> = [];
		server?.bus.subscribe("acme", (e) => seen.push(e as never));
		expect((await health(base)).settlementsUnrecoverable).toBe(0);

		const res = await post(base, "/v1/settle", {
			transferId: "tx_before_restart",
			idempotencyKey: "call-1",
			inputTokens: 80,
			outputTokens: 200,
			principal: { id: "user-42", type: "human" },
		});

		expect(res.status).toBe(410);
		expect(((await res.json()) as { error: string }).error).toBe("settlement_unrecoverable");
		expect(fake.calls.unheld).toEqual([
			{
				idempotencyKey: "call-1",
				usage: { inputTokens: 80, outputTokens: 200 },
				principal: { id: "user-42", type: "human" },
			},
		]);
		expect((await health(base)).settlementsUnrecoverable).toBe(1);
		expect(seen).toContainEqual(
			expect.objectContaining({
				type: "settlement_unrecoverable",
				transferId: "tx_before_restart",
			}),
		);
	});

	it("a key whose charge stands is 409 already_settled, and nothing is counted", async () => {
		const { base } = await start({}, { unheld: "already_settled" });
		const res = await post(base, "/v1/settle", { transferId: "tx_gone", idempotencyKey: "call-1" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toBe("already_settled");
		expect((await health(base)).settlementsUnrecoverable).toBe(0);
	});

	it("a key with a live hold under another transferId is 409 hold_active, naming that hold", async () => {
		const { base } = await start({}, { unheld: "held" });
		const res = await post(base, "/v1/settle", {
			transferId: "tx_wrong",
			idempotencyKey: "call-1",
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string; transferId: string };
		expect(body.error).toBe("hold_active");
		expect(body.transferId).toBe("tx_live_hold");
		expect((await health(base)).settlementsUnrecoverable).toBe(0);
	});

	it("an exact retry the governor had already recorded is answered 410 — and not counted twice", async () => {
		const { base } = await start({}, { unheld: "retry" });
		const seen: Array<{ type: string }> = [];
		server?.bus.subscribe("acme", (e) => seen.push(e));
		const res = await post(base, "/v1/settle", { transferId: "tx_gone", idempotencyKey: "call-1" });
		expect(res.status).toBe(410);
		expect((await health(base)).settlementsUnrecoverable).toBe(0);
		expect(seen.some((e) => e.type === "settlement_unrecoverable")).toBe(false);
	});

	it("an unreadable ledger is 503 ledger_unavailable — retryable, and distinguishable from a bug", async () => {
		const fake = createFakeGovernor();
		fake.governor.recordUnheldSettlement = async () => {
			throw new LedgerUnavailableError("tb: 10.0.0.7:3000 refused");
		};
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const { port } = await server.listen();
		const res = await post(`http://127.0.0.1:${port}`, "/v1/settle", {
			transferId: "tx_gone",
			idempotencyKey: "call-1",
		});
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string; reason: string };
		expect(body.error).toBe("ledger_unavailable");
		expect(body.reason).not.toContain("10.0.0.7");
	});

	it("without a key an unknown transferId stays a plain 404, and the governor is not asked", async () => {
		const { base, fake } = await start();
		expect((await post(base, "/v1/settle", { transferId: "tx_gone", inputTokens: 1 })).status).toBe(
			404,
		);
		expect(fake.calls.unheld).toHaveLength(0);
	});

	it("a HELD settle ignores the key and the principal: the hold's own capture is authoritative", async () => {
		const { base, fake } = await start();
		const auth = (await (await post(base, "/v1/authorize", { model: "m" })).json()) as {
			transferId: string;
		};
		const res = await post(base, "/v1/settle", {
			transferId: auth.transferId,
			idempotencyKey: "other-key",
			principal: { id: "someone-else", type: "human" },
			inputTokens: 3,
		});
		expect(res.status).toBe(200);
		expect(fake.calls.unheld).toHaveLength(0);
		expect(fake.calls.settleParams[0]).toEqual({ inputTokens: 3 });
	});
});
