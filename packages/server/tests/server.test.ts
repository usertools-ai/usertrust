import type { Governor } from "usertrust";
import { afterEach, describe, expect, it, vi } from "vitest";
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
		requestTimeoutMs: 10_000,
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

	it("close() aborts remaining pending holds", async () => {
		const { base, fake } = await start();
		const auth = (await (
			await post(base, "/v1/authorize", { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 })
		).json()) as { transferId: string };
		expect(server?.pendingCount()).toBe(1);
		await server?.close();
		expect(fake.calls.aborted).toEqual([auth.transferId]);
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

/**
 * The server's OWN deadline, as distinct from the ledger's.
 *
 * `tigerbeetle.connectTimeoutMs` only bounds governor CONSTRUCTION. A cluster that
 * dies AFTER a governor is built stalls inside `authorize()` instead, where no
 * construction-time deadline can see it — and the ledger client still never
 * rejects. This is the backstop for that, and for any other way a governor call
 * can fail to return.
 *
 * Driven through the injectable factory rather than a real dead cluster, because
 * the point under test is the SERVER's timeout, and a real cluster would trip the
 * earlier core deadline first and never reach this code.
 */
describe("request deadline — a stalled governor answers, it does not hang", () => {
	/** A governor whose authorize() never settles: the post-construction stall. */
	function hangingGovernor(): Governor {
		const fake = createFakeGovernor().governor;
		return {
			...fake,
			authorize: () => new Promise<never>(() => {}),
		};
	}

	it("answers 503 governor_timeout instead of holding the request open", async () => {
		const governor = hangingGovernor();
		server = createUsertrustServer({
			config: config({ requestTimeoutMs: 300 }),
			factory: async () => governor,
		});
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;

		const startedAt = Date.now();
		const res = await post(base, "/v1/authorize", { model: "claude-sonnet-4-6" });
		const elapsedMs = Date.now() - startedAt;

		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string; reason: string };
		expect(body.error).toBe("governor_timeout");
		// Name what stalled — "internal error" would not tell an operator which
		// dependency to look at.
		expect(body.reason).toContain("authorize");
		expect(elapsedMs).toBeLessThan(10_000);
	}, 20_000);

	it("does not shadow the timeout into a 200 would_deny under evaluate_only", async () => {
		// An unanswered call has an UNKNOWN outcome. Reporting it as `would_deny`
		// would claim enforcement reached a verdict it never reached.
		const governor = hangingGovernor();
		server = createUsertrustServer({
			config: config({ requestTimeoutMs: 300, enforcement: "evaluate_only" }),
			factory: async () => governor,
		});
		const { port } = await server.listen();
		const res = await post(`http://127.0.0.1:${port}`, "/v1/authorize", {
			model: "claude-sonnet-4-6",
		});
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string; shadow?: boolean };
		expect(body.shadow).toBeUndefined();
		expect(body.error).toBe("governor_timeout");
	}, 20_000);

	it("voids an authorization that lands AFTER the deadline gave up on it", async () => {
		// A deadline abandons the call; it does not cancel it. The ledger hold is real
		// and its transferId reached nobody, so nothing can ever settle it. AGENTS.md
		// gives every hold exactly one terminal outcome — abandoning it silently
		// retires part of the tenant's budget on every timeout.
		const fake = createFakeGovernor();
		const slow: Governor = {
			...fake.governor,
			authorize: async (params) => {
				await new Promise((resolve) => setTimeout(resolve, 400));
				return fake.governor.authorize(params);
			},
		};
		server = createUsertrustServer({
			config: config({ requestTimeoutMs: 150 }),
			factory: async () => slow,
		});
		const { port } = await server.listen();
		const res = await post(`http://127.0.0.1:${port}`, "/v1/authorize", {
			model: "claude-sonnet-4-6",
		});
		expect(res.status).toBe(503);
		// Nothing settleable was handed back, so nothing is pending server-side...
		expect(server.pendingCount()).toBe(0);
		// ...and the hold the ledger did take must be given back.
		await vi.waitFor(() => expect(fake.calls.aborted).toHaveLength(1), { timeout: 5_000 });
		expect(fake.calls.aborted[0]).toBe(fake.calls.authorized[0]);
	}, 20_000);

	it("applies the default timeout for a config that never saw the schema", async () => {
		// createUsertrustServer is exported, so a caller can hand it a hand-built
		// config — including one written before requestTimeoutMs existed. Only
		// loadServerConfig applies the schema defaults, and setTimeout(fn, undefined)
		// fires on the next tick: without a runtime fallback, adding this field would
		// have turned every request from such a caller into an instant
		// governor_timeout. Adding a field must not break the callers who predate it.
		const { requestTimeoutMs: _omitted, ...withoutTimeout } = config();
		const fake = createFakeGovernor();
		// Deliberately NOT instant. `setTimeout(fn, undefined)` coerces to 1ms rather
		// than to "no timeout", so an authorize that resolves in the same tick wins
		// that race and the missing default stays invisible. Any real governor takes
		// longer than a tick — a ledger round trip is milliseconds at best — so the
		// test has to as well, or it pins nothing.
		const realistic: Governor = {
			...fake.governor,
			authorize: async (params) => {
				await new Promise((resolve) => setTimeout(resolve, 60));
				return fake.governor.authorize(params);
			},
		};
		server = createUsertrustServer({
			config: withoutTimeout,
			factory: async () => realistic,
		});
		const { port } = await server.listen();
		const res = await post(`http://127.0.0.1:${port}`, "/v1/authorize", {
			model: "claude-sonnet-4-6",
		});
		expect(res.status).toBe(200);
		expect(fake.calls.authorized).toHaveLength(1);
	}, 20_000);

	it("shuts down even when the shutdown abort itself stalls", async () => {
		// close() awaits the best-effort abort of every pending hold BEFORE
		// pool.destroyAll(). An unbounded abort there does not merely fail to void a
		// hold — it stops teardown from ever reaching the governor destroy that would
		// have voided it, so a stalled ledger hangs shutdown. Same defect as the one
		// this PR exists to fix, one path over.
		const fake = createFakeGovernor();
		const stalling: Governor = {
			...fake.governor,
			abort: () => new Promise<never>(() => {}),
		};
		server = createUsertrustServer({
			config: config({ requestTimeoutMs: 200 }),
			factory: async () => stalling,
		});
		const { port } = await server.listen();
		const res = await post(`http://127.0.0.1:${port}`, "/v1/authorize", {
			model: "claude-sonnet-4-6",
		});
		expect(res.status).toBe(200);
		expect(server.pendingCount()).toBe(1);

		const closed = server.close().then(() => "closed" as const);
		const outcome = await Promise.race([
			closed,
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 8_000)),
		]);
		expect(outcome).toBe("closed");
		server = undefined; // already closed; afterEach must not close it twice
	}, 20_000);

	it("spends ONE budget across construction and the call, not one each", async () => {
		// Per-await timeouts do not bound a request. A cold tenant waits for the
		// governor and THEN for authorize, so two 4s timeouts are an 8s request — past
		// the 5s at which usertrust-claude-code aborts. The client would be gone before
		// its own server answered, and an authorize landing in that window records a
		// hold whose transferId nobody ever received.
		const fake = createFakeGovernor();
		const slowBoth: Governor = {
			...fake.governor,
			authorize: async (params) => {
				await new Promise((resolve) => setTimeout(resolve, 400));
				return fake.governor.authorize(params);
			},
		};
		server = createUsertrustServer({
			config: config({ requestTimeoutMs: 500 }),
			factory: async () => {
				await new Promise((resolve) => setTimeout(resolve, 400));
				return slowBoth;
			},
		});
		const { port } = await server.listen();

		const startedAt = Date.now();
		const res = await post(`http://127.0.0.1:${port}`, "/v1/authorize", {
			model: "claude-sonnet-4-6",
		});
		const elapsedMs = Date.now() - startedAt;

		// 400ms construction + 400ms authorize = 800ms of work against a 500ms budget.
		// Shared, that is a timeout; restarted per await it would be two 500ms windows
		// and a 200 at ~800ms.
		expect(res.status).toBe(503);
		expect(elapsedMs).toBeLessThan(750);
	}, 20_000);

	it("sweeps N stalled holds within ONE budget, not N budgets", async () => {
		// close() awaits pending holds sequentially. A per-entry budget makes shutdown
		// N x requestTimeoutMs — which the code comment in abortEntry predicted and the
		// code then did anyway. Shutdown must be bounded by the number the operator
		// configured, not that number times however many holds happened to be open.
		const fake = createFakeGovernor({ budget: 1_000_000 });
		const stalling: Governor = {
			...fake.governor,
			abort: () => new Promise<never>(() => {}),
		};
		server = createUsertrustServer({
			config: config({ requestTimeoutMs: 300 }),
			factory: async () => stalling,
		});
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		for (let i = 0; i < 4; i++) {
			expect((await post(base, "/v1/authorize", { model: "claude-sonnet-4-6" })).status).toBe(200);
		}
		expect(server.pendingCount()).toBe(4);

		const startedAt = Date.now();
		await server.close();
		const elapsedMs = Date.now() - startedAt;
		server = undefined;
		// One 300ms budget for all four, not 4 x 300ms. Bounded well below the 1200ms
		// the per-entry version took, with room for a loaded machine.
		expect(elapsedMs).toBeLessThan(900);
	}, 20_000);

	it("shuts down when the governor's own destroy() stalls", async () => {
		// destroy() voids pending transfers BEFORE closing the native client, and that
		// void is a ledger request — which never rejects when the cluster is gone. So a
		// governor built while TigerBeetle was healthy and destroyed after it died hung
		// close() forever: bounding construction only moved the hang.
		const fake = createFakeGovernor();
		const stalling: Governor = {
			...fake.governor,
			destroy: () => new Promise<never>(() => {}),
		};
		server = createUsertrustServer({
			config: config({ requestTimeoutMs: 250 }),
			factory: async () => stalling,
		});
		const { port } = await server.listen();
		// Force the pool to actually hold a governor.
		expect(
			(
				await fetch(`http://127.0.0.1:${port}/v1/budget`, {
					headers: { authorization: `Bearer ${KEY}` },
				})
			).status,
		).toBe(200);

		const outcome = await Promise.race([
			server.close().then(() => "closed" as const),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 8_000)),
		]);
		expect(outcome).toBe("closed");
		server = undefined;
	}, 20_000);

	it("bounds governor CONSTRUCTION too, not just the call", async () => {
		// pool.get() is where the reported outage actually lived: createGovernor()
		// never returned, so the request never reached authorize() at all.
		server = createUsertrustServer({
			config: config({ requestTimeoutMs: 300 }),
			factory: () => new Promise<never>(() => {}),
		});
		const { port } = await server.listen();
		const res = await post(`http://127.0.0.1:${port}`, "/v1/authorize", {
			model: "claude-sonnet-4-6",
		});
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string; reason: string };
		expect(body.error).toBe("governor_timeout");
		expect(body.reason).toContain("pool.get");
	}, 20_000);
});
