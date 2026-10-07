// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `POST /v1/release` and the release terminal (#238, #204).
 *
 * A hold given back, or one the server ends itself (its life spent, or a shutdown),
 * used to go through `governor.abort()`: a circuit-breaker failure and an
 * `llm_call_failed` record. Five in a row opened the tenant's breaker, and every
 * authorize answered 500 for at least a minute, though nothing had failed.
 *
 * Pinned here, against the REAL governor (dry run) unless a test says otherwise:
 *  - the contract shipped Claude Code plugins already speak: `{ transferId, reason }`,
 *    200 only when this request ended the hold, and a 404 `unknown transferId` (never
 *    `unknown route`, which sends a client whose capability read failed to /v1/abort);
 *  - give-backs and expiries never open the breaker, and are NEUTRAL: they neither count
 *    as failures nor reset the count, nor close a breaker real failures opened;
 *  - real failures still count: five client aborts still open it;
 *  - the sweep, at its monotonic age, and shutdown release, and the budget comes back;
 *  - the chain says `hold_released`, and the `released` event carries the same reason.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedgerEvents } from "usertrust";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig, TenantConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import type { ServerEvent } from "../src/events.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const KEY = "ut_release_key";
const OTHER_KEY = "ut_release_other_key";
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 10, maxOutputTokens: 10 };

let server: UsertrustServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

interface Started {
	base: string;
	stateDir: string;
	tenant: TenantConfig;
	events: ServerEvent[];
}

/** A real dry-run server: two tenants, and a breaker whose reset the test can wait out. */
async function start(
	overrides: Partial<ServerConfig> = {},
	resetTimeoutMs = 60_000,
): Promise<Started> {
	const stateDir = await mkdtemp(join(tmpdir(), "utsrv-release-"));
	const configPath = join(stateDir, "tenant.config.json");
	await writeFile(
		configPath,
		JSON.stringify({ circuitBreaker: { failureThreshold: 5, resetTimeout: resetTimeoutMs } }),
	);
	const tenant: TenantConfig = { id: "acme", keyHash: hashKey(KEY), budget: 1_000_000, configPath };
	server = createUsertrustServer({
		config: {
			host: "127.0.0.1",
			port: 0,
			stateDir,
			enforcement: "enforce",
			pendingTtlMs: 300_000,
			dryRun: true,
			tenants: [tenant, { id: "other", keyHash: hashKey(OTHER_KEY), budget: 1_000_000 }],
			...overrides,
		},
	});
	const events: ServerEvent[] = [];
	server.bus.subscribe("acme", (event) => events.push(event));
	const { port } = await server.listen();
	return { base: `http://127.0.0.1:${port}`, stateDir, tenant, events };
}

async function post(
	base: string,
	path: string,
	body: unknown,
	key = KEY,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function hold(base: string, key = KEY): Promise<string> {
	const res = await post(base, "/v1/authorize", AUTHORIZE, key);
	expect(res.status).toBe(200);
	return res.json.transferId as string;
}

/** The tenant's chain, read after the server has closed (and flushed it). */
async function chain(
	started: Started,
): Promise<Array<{ kind: string; data: Record<string, unknown> }>> {
	await server?.close();
	server = undefined;
	return readLedgerEvents(join(started.stateDir, "acme", ".usertrust")) as Array<{
		kind: string;
		data: Record<string, unknown>;
	}>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("POST /v1/release: the contract shipped plugins rely on", () => {
	it("a live hold: 200 { released: true, transferId }, and the hold is gone", async () => {
		const started = await start();
		const transferId = await hold(started.base);
		const res = await post(started.base, "/v1/release", { transferId, reason: "released at Stop" });
		expect(res).toEqual({ status: 200, json: { released: true, transferId } });
		expect(server?.pendingCount()).toBe(0);
		// Gone for every route: a second release, a settle, an abort.
		for (const path of ["/v1/release", "/v1/settle", "/v1/abort"]) {
			expect((await post(started.base, path, { transferId })).status).toBe(404);
		}
		const records = (await chain(started)).filter((e) => e.data.transferId === transferId);
		expect(records.map((e) => e.kind)).toEqual(["hold_released"]);
		expect(records[0]?.data).toMatchObject({ reason: "released at Stop", source: "headless" });
	});

	it("an unknown id, and another tenant's: 404 `unknown transferId`, never `unknown route`", async () => {
		const started = await start();
		const theirs = await hold(started.base, OTHER_KEY);
		for (const transferId of ["tx_unknown", theirs]) {
			const res = await post(started.base, "/v1/release", { transferId, reason: "x" });
			expect(res).toEqual({
				status: 404,
				json: { error: "not_found", reason: "unknown transferId" },
			});
		}
		// The other tenant's hold is untouched.
		expect(server?.pendingCount()).toBe(1);
	});

	it("a malformed body is a 400, and nothing is claimed", async () => {
		const started = await start();
		const transferId = await hold(started.base);
		for (const body of [{}, { transferId: "" }, { transferId, reason: 42 }]) {
			const res = await post(started.base, "/v1/release", body);
			expect(res).toEqual({
				status: 400,
				json: { error: "bad_request", reason: "invalid release request" },
			});
		}
		expect(server?.pendingCount()).toBe(1);
	});

	it("a long, control-laden reason is clipped and stripped, never refused; the event says what the chain says", async () => {
		const started = await start();
		const transferId = await hold(started.base);
		const reason = `\u001b[2J${"r".repeat(500)}\u0007`;
		expect((await post(started.base, "/v1/release", { transferId, reason })).status).toBe(200);
		const released = started.events.filter((e) => e.type === "released");
		expect(released).toEqual([
			{ type: "released", transferId, reason: `[2J${"r".repeat(197)}`, at: expect.any(String) },
		]);
		const record = (await chain(started)).find((e) => e.kind === "hold_released");
		expect(record?.data.reason).toBe(`[2J${"r".repeat(197)}`);
	});
});

describe("give-backs and expiries never open the circuit breaker", () => {
	it("five releases, then an authorize: 200 (five aborts answered 500)", async () => {
		const { base } = await start();
		for (let i = 0; i < 5; i += 1) {
			expect((await post(base, "/v1/release", { transferId: await hold(base) })).status).toBe(200);
		}
		expect((await post(base, "/v1/authorize", AUTHORIZE)).status).toBe(200);
	});

	it("must still fire: five client aborts after failed calls open it, and four do not", async () => {
		for (const n of [4, 5]) {
			const { base } = await start();
			for (let i = 0; i < n; i += 1) {
				const res = await post(base, "/v1/abort", {
					transferId: await hold(base),
					error: "provider 500",
				});
				expect(res.status).toBe(200);
			}
			const after = await post(base, "/v1/authorize", AUTHORIZE);
			expect(after.status).toBe(n === 4 ? 200 : 500);
			await server?.close();
			server = undefined;
		}
	});

	it("a release is neutral: it does not reset the count (4 aborts, 3 releases, 1 abort → 500)", async () => {
		const { base } = await start();
		for (let i = 0; i < 4; i += 1) {
			await post(base, "/v1/abort", { transferId: await hold(base), error: "provider 500" });
		}
		for (let i = 0; i < 3; i += 1) {
			await post(base, "/v1/release", { transferId: await hold(base) });
		}
		await post(base, "/v1/abort", { transferId: await hold(base), error: "provider 500" });
		expect((await post(base, "/v1/authorize", AUTHORIZE)).status).toBe(500);
	});

	it("half-open: give-backs do not close a breaker that real failures opened", async () => {
		const resetMs = 300;
		const { base } = await start({}, resetMs);
		for (let i = 0; i < 5; i += 1) {
			await post(base, "/v1/abort", { transferId: await hold(base), error: "provider 500" });
		}
		expect((await post(base, "/v1/authorize", AUTHORIZE)).status).toBe(500);
		await sleep(resetMs + 100);
		// Half-open admits calls. Two give-backs there would close it if they counted as
		// successes; then one failure would leave it closed, and the authorize below 200.
		const [a, b, c] = [await hold(base), await hold(base), await hold(base)];
		await post(base, "/v1/release", { transferId: a });
		await post(base, "/v1/release", { transferId: b });
		await post(base, "/v1/abort", { transferId: c, error: "provider 500" });
		expect((await post(base, "/v1/authorize", AUTHORIZE)).status).toBe(500);
	});

	it("20 holds expiring together, one sweep at their monotonic age: the next authorize is 200", async () => {
		const started = await start({ pendingTtlMs: 50 });
		const ids: string[] = [];
		for (let i = 0; i < 20; i += 1) ids.push(await hold(started.base));
		await sleep(80);
		expect(await server?.sweepExpired()).toBe(20);
		expect((await post(started.base, "/v1/authorize", AUTHORIZE)).status).toBe(200);
		expect(started.events.filter((e) => e.type === "pending_expired")).toHaveLength(20);
		const records = await chain(started);
		// The 20 the sweep ended; the probe authorize above is released at close.
		const expired = records.filter(
			(e) => e.kind === "hold_released" && e.data.reason === "pending TTL expired",
		);
		expect(expired.map((e) => e.data.transferId).sort()).toEqual([...ids].sort());
		expect(records.filter((e) => e.kind === "llm_call_failed")).toHaveLength(0);
	});

	it("an expired hold's budget comes back with the sweep", async () => {
		const started = await start({ pendingTtlMs: 50 });
		const governor = await server?.pool.get(started.tenant);
		const before = governor?.budgetRemaining();
		for (let i = 0; i < 3; i += 1) await hold(started.base);
		expect(governor?.budgetRemaining()).toBeLessThan(before as number);
		await sleep(80);
		expect(await server?.sweepExpired()).toBe(3);
		expect(governor?.budgetRemaining()).toBe(before);
	});

	it("close() releases every remaining hold ('server shutdown'), and announces `released`", async () => {
		const started = await start();
		const ids = [await hold(started.base), await hold(started.base)];
		const records = await chain(started);
		const released = records.filter((e) => e.kind === "hold_released");
		expect(released.map((e) => e.data.transferId).sort()).toEqual([...ids].sort());
		for (const e of released) expect(e.data.reason).toBe("server shutdown");
		expect(records.filter((e) => e.kind === "llm_call_failed")).toHaveLength(0);
		expect(
			started.events.filter((e) => e.type === "released").map((e) => [e.transferId, e.reason]),
		).toEqual(ids.map((id) => [id, "server shutdown"]));
		expect(started.events.filter((e) => e.type === "aborted")).toHaveLength(0);
	});
});

describe("the 200 is earned: it says the governor ended the hold", () => {
	async function startFake(release: { notHeld?: boolean; voidError?: string; throws?: boolean }) {
		const fake = createFakeGovernor({ release });
		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir: "/tmp/utsrv-release-fake",
				enforcement: "enforce",
				pendingTtlMs: 50,
				dryRun: true,
				tenants: [{ id: "acme", keyHash: hashKey(KEY) }],
			},
			factory: async () => fake.governor,
		});
		const { port } = await server.listen();
		return { base: `http://127.0.0.1:${port}`, fake };
	}

	it("a governor that no longer holds it: 404 `unknown transferId`, and the entry stays out", async () => {
		const { base, fake } = await startFake({ notHeld: true });
		const transferId = await hold(base);
		const res = await post(base, "/v1/release", { transferId, reason: "given back" });
		expect(res).toEqual({
			status: 404,
			json: { error: "not_found", reason: "unknown transferId" },
		});
		expect(fake.calls.releaseReasons).toEqual(["given back"]);
		// Not put back: the sweep never meets it again.
		expect(server?.pendingCount()).toBe(0);
		await sleep(80);
		expect(await server?.sweepExpired()).toBe(0);
		expect(fake.calls.releaseReasons).toEqual(["given back"]);
	});

	it("a release whose ledger void failed still ended the hold: 200, with voidError", async () => {
		const { base } = await startFake({ voidError: "pending_transfer_not_found" });
		const transferId = await hold(base);
		const res = await post(base, "/v1/release", { transferId });
		expect(res).toEqual({
			status: 200,
			json: { released: true, transferId, voidError: "pending_transfer_not_found" },
		});
	});

	it("a governor that THROWS: the entry is put back, so the release stays retryable", async () => {
		const { base } = await startFake({ throws: true });
		const transferId = await hold(base);
		const res = await post(base, "/v1/release", { transferId });
		expect(res.status).toBe(500);
		expect(server?.pendingCount()).toBe(1);
	});
});
