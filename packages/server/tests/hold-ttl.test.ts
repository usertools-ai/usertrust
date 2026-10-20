// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `hold-ttl`: an authorize may ask its hold to live longer (`holdTtlMs`), for a call expected
 * to run past the default.
 *
 * Pinned here:
 *  - the asked life is clamped to [`pendingTtlMs`, `maxPendingTtlMs`] (default one hour), and the
 *    governor is asked for exactly that, so the ledger's timeout and the server's sweep agree;
 *  - the answer's `expiresInMs` and the sweep both read the hold's own life, not `pendingTtlMs`;
 *  - an authorize that asks for none is unchanged: no `holdTtlMs` reaches the governor, and its
 *    life is `pendingTtlMs`;
 *  - `/v1/health` lists `hold-ttl` and states the ceiling, `maxHoldTtlMs`.
 */

import type { GovernorOpts } from "usertrust";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DEFAULT_MAX_PENDING_TTL_MS, hashKey } from "../src/config.js";
import { createUsertrustServer, holdLife, type UsertrustServer } from "../src/server.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const KEY = "ut_srv_ttl_key";
const MINUTE = 60_000;

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		stateDir: "/tmp/utsrv-hold-ttl",
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

async function start(overrides: Partial<ServerConfig> = {}) {
	const fake = createFakeGovernor();
	server = createUsertrustServer({ config: config(overrides), factory: async () => fake.governor });
	const { port } = await server.listen();
	return { base: `http://127.0.0.1:${port}`, fake };
}

async function authorize(base: string, extra: Record<string, unknown> = {}) {
	const res = await fetch(`${base}/v1/authorize`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify({ model: "claude-sonnet-4-6", estimatedInputTokens: 10, ...extra }),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("an authorize may ask its hold to live longer (`holdTtlMs`)", () => {
	it("the asked life reaches the governor, the answer states it, and the sweep keeps the hold for it", async () => {
		const { base, fake } = await start();
		const { json } = await authorize(base, { holdTtlMs: 15 * MINUTE });
		expect(fake.calls.authorizeParams[0]?.holdTtlMs).toBe(15 * MINUTE);
		expect(json.expiresInMs).toBeLessThanOrEqual(15 * MINUTE);
		expect(json.expiresInMs).toBeGreaterThan(14 * MINUTE);
		// Past the default life, but within its own: kept.
		expect(await server?.sweepExpired(Date.now() + 10 * MINUTE)).toBe(0);
		expect(server?.pendingCount()).toBe(1);
		// Past its own life: swept.
		expect(await server?.sweepExpired(Date.now() + 16 * MINUTE)).toBe(1);
	});

	it("a life above maxPendingTtlMs is the ceiling, and one below pendingTtlMs is pendingTtlMs", async () => {
		const { base, fake } = await start({ maxPendingTtlMs: 20 * MINUTE });
		const long = await authorize(base, { holdTtlMs: 24 * 60 * MINUTE });
		const short = await authorize(base, { holdTtlMs: 1_000 });
		expect(fake.calls.authorizeParams.map((p) => p.holdTtlMs)).toEqual([20 * MINUTE, 300_000]);
		expect(long.json.expiresInMs).toBeLessThanOrEqual(20 * MINUTE);
		expect(long.json.expiresInMs).toBeGreaterThan(19 * MINUTE);
		expect(short.json.expiresInMs).toBeLessThanOrEqual(300_000);
	});

	it("unasked, nothing changes: no holdTtlMs reaches the governor, and the life is pendingTtlMs", async () => {
		const { base, fake } = await start();
		const { json } = await authorize(base);
		expect(Object.hasOwn(fake.calls.authorizeParams[0] ?? {}, "holdTtlMs")).toBe(false);
		expect(json.expiresInMs).toBeLessThanOrEqual(300_000);
		expect(await server?.sweepExpired(Date.now() + 6 * MINUTE)).toBe(1);
	});

	it.each([0, -1, 1.5, "900000"])("holdTtlMs %s is a 400, and nothing is held", async (bad) => {
		const { base, fake } = await start();
		const { status } = await authorize(base, { holdTtlMs: bad });
		expect(status).toBe(400);
		expect(fake.calls.authorizeParams).toEqual([]);
	});

	it("each tenant's governor is created with the server's ceiling, so the ledger's timeout can reach it", async () => {
		const fake = createFakeGovernor();
		let opts: GovernorOpts | undefined;
		server = createUsertrustServer({
			config: config({ maxPendingTtlMs: 45 * MINUTE }),
			factory: async (given) => {
				opts = given;
				return fake.governor;
			},
		});
		const { port } = await server.listen();
		await authorize(`http://127.0.0.1:${port}`);
		expect(opts?.maxHoldTtlMs).toBe(45 * MINUTE);
	});

	it("/v1/health lists `hold-ttl` and states the ceiling", async () => {
		const { base } = await start({ maxPendingTtlMs: 45 * MINUTE });
		const health = (await (await fetch(`${base}/v1/health`)).json()) as Record<string, unknown>;
		expect(health.capabilities).toContain("hold-ttl");
		expect(health.maxHoldTtlMs).toBe(45 * MINUTE);
	});

	it("the clamp, directly: unset ceiling is one hour, and a ceiling below pendingTtlMs never shortens it", () => {
		expect(holdLife(undefined, { pendingTtlMs: 300_000 })).toBe(300_000);
		expect(holdLife(Number.MAX_SAFE_INTEGER, { pendingTtlMs: 300_000 })).toBe(
			DEFAULT_MAX_PENDING_TTL_MS,
		);
		expect(holdLife(10 * MINUTE, { pendingTtlMs: 300_000, maxPendingTtlMs: 300_000 })).toBe(
			300_000,
		);
		expect(holdLife(10 * MINUTE, { pendingTtlMs: 20 * MINUTE, maxPendingTtlMs: 300_000 })).toBe(
			20 * MINUTE,
		);
	});
});
