// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `hold-expiry`: every authorize answers `expiresInMs`, the hold's remaining life,
 * so a client never has to guess it from the defaults.
 *
 * Pinned here:
 *  - the life is the SHORTER of the server's `pendingTtlMs` sweep and the ledger's
 *    pending timeout (`Authorization.holdTimeoutMs`; absent in dry run);
 *  - it is the REMAINING life: a hold already some way into its life answers what it
 *    has left, never its total;
 *  - the answer and the sweep read a hold's age on the monotonic clock: a wall clock
 *    stepped back neither lengthens the answer nor keeps an expired hold, and a wall
 *    clock stepped FORWARD never sweeps a hold before its advertised life;
 *  - the sweep ends a hold when its advertised life runs out, the ledger's timeout
 *    included, so the two are one rule;
 *  - a ledger hold whose handle does not state its timeout advertises NO life, and is
 *    swept at `pendingTtlMs`, as before.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, remainingLifeMs, type UsertrustServer } from "../src/server.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const KEY = "ut_srv_key";
const MINUTE = 60_000;

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		stateDir: "/tmp/utsrv-hold-expiry",
		enforcement: "enforce",
		pendingTtlMs: 300_000,
		dryRun: true,
		tenants: [{ id: "acme", keyHash: hashKey(KEY) }],
		...overrides,
	};
}

let server: UsertrustServer | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await server?.close();
	server = undefined;
});

async function start(
	overrides: Partial<ServerConfig>,
	fakeOpts: Parameters<typeof createFakeGovernor>[0] = {},
): Promise<string> {
	const fake = createFakeGovernor(fakeOpts);
	server = createUsertrustServer({ config: config(overrides), factory: async () => fake.governor });
	const { port } = await server.listen();
	return `http://127.0.0.1:${port}`;
}

async function authorize(base: string): Promise<{ transferId: string; expiresInMs: unknown }> {
	const res = await fetch(`${base}/v1/authorize`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify({ model: "claude-sonnet-4-6", estimatedInputTokens: 10 }),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { transferId: string; expiresInMs: unknown };
}

describe("an authorize answers the hold's remaining life (`expiresInMs`)", () => {
	it("dry run: the server's own sweep is the life", async () => {
		const base = await start({ pendingTtlMs: 300_000 });
		const { expiresInMs } = await authorize(base);
		expect(Number.isSafeInteger(expiresInMs)).toBe(true);
		expect(expiresInMs).toBeLessThanOrEqual(300_000);
		expect(expiresInMs).toBeGreaterThan(290_000);
	});

	it("a ledger hold whose handle does not state its timeout advertises NO life", async () => {
		// An absence is never read as "no limit": a client must then treat the hold as one
		// it cannot reuse.
		const base = await start({ pendingTtlMs: 300_000, dryRun: false });
		const answer = await authorize(base);
		expect(Object.hasOwn(answer, "expiresInMs")).toBe(false);
		expect(answer.transferId).toBe("tx_fake_1");
	});

	it("a short pendingTtlMs is the life, below the ledger's timeout", async () => {
		const base = await start({ pendingTtlMs: 10_000, dryRun: false }, { holdTimeoutMs: 300_000 });
		const { expiresInMs } = await authorize(base);
		expect(expiresInMs).toBeLessThanOrEqual(10_000);
		expect(expiresInMs).toBeGreaterThan(9_000);
	});

	it("a ledger timeout shorter than the sweep is the life", async () => {
		const base = await start({ pendingTtlMs: 300_000, dryRun: false }, { holdTimeoutMs: 5_000 });
		const { expiresInMs } = await authorize(base);
		expect(expiresInMs).toBeLessThanOrEqual(5_000);
		expect(expiresInMs).toBeGreaterThan(4_000);
	});

	it("the life counts from the request's ARRIVAL: a slow authorize uses it up", async () => {
		// The ledger's timeout starts when the reserve commits, inside the authorize. Counted
		// only from when the authorize RETURNED, the life would include time the hold has
		// already spent.
		const base = await start(
			{ pendingTtlMs: 10_000 },
			{
				duringAuthorize: () => {
					const until = performance.now() + 150;
					while (performance.now() < until) {
						// A slow reserve.
					}
				},
			},
		);
		const { expiresInMs } = await authorize(base);
		expect(expiresInMs).toBeLessThanOrEqual(10_000 - 150);
	});

	it("a wall-clock step BACK during the authorize does not lengthen the life", async () => {
		// The governor's authorize runs after the request arrived: the clock steps back a
		// minute right there. Read on the wall clock, the hold would look a minute YOUNGER
		// than new, and the answer would promise a minute it does not have.
		const realNow = Date.now.bind(Date);
		const base = await start(
			{ pendingTtlMs: 10_000 },
			{ duringAuthorize: () => vi.spyOn(Date, "now").mockImplementation(() => realNow() - MINUTE) },
		);
		const { expiresInMs } = await authorize(base);
		expect(expiresInMs).toBeLessThanOrEqual(10_000);
		expect(expiresInMs).toBeGreaterThan(9_000);
	});
});

describe("the sweep reads the same monotonic clock", () => {
	it("a wall clock stepped back an hour does not keep an expired hold from being swept", async () => {
		const base = await start({ pendingTtlMs: 50 });
		await authorize(base);
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => realNow() - 60 * MINUTE);
		await new Promise((r) => setTimeout(r, 80));
		expect(await server?.sweepExpired()).toBe(1);
		expect(server?.pendingCount()).toBe(0);
	});

	it("control: a hold younger than pendingTtlMs is left alone", async () => {
		const base = await start({ pendingTtlMs: 60_000 });
		await authorize(base);
		expect(await server?.sweepExpired()).toBe(0);
		expect(server?.pendingCount()).toBe(1);
	});

	it("a wall clock stepped FORWARD past the life (the monotonic clock held) does NOT sweep the hold", async () => {
		// A forward step and a host's sleep look alike from inside the process. Sweeping on
		// the wall clock would void a hold before its advertised life: a client reusing it,
		// or a tool still running, would get a 404. So the sweep waits for the monotonic
		// clock, and after a real sleep it comes late (declared).
		const base = await start({ pendingTtlMs: 60_000 });
		await authorize(base);
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + 61_000);
		expect(await server?.sweepExpired()).toBe(0);
		expect(server?.pendingCount()).toBe(1);
	});

	it("a ledger timeout shorter than pendingTtlMs ends the hold at the ledger's timeout", async () => {
		// The ledger has expired the hold by then: kept until pendingTtlMs, its budget would
		// stay reserved in the governor, and later calls could be refused for it.
		const base = await start({ pendingTtlMs: 300_000, dryRun: false }, { holdTimeoutMs: 50 });
		await authorize(base);
		await new Promise((r) => setTimeout(r, 80));
		expect(await server?.sweepExpired()).toBe(1);
		expect(server?.pendingCount()).toBe(0);
	});

	it("control: a hold within its ledger timeout is left alone", async () => {
		const base = await start({ pendingTtlMs: 300_000, dryRun: false }, { holdTimeoutMs: 60_000 });
		await authorize(base);
		await new Promise((r) => setTimeout(r, 80));
		expect(await server?.sweepExpired()).toBe(0);
	});

	it("an explicit `now` follows the same rule: the ledger's timeout, before pendingTtlMs", async () => {
		const base = await start({ pendingTtlMs: 300_000, dryRun: false }, { holdTimeoutMs: 50 });
		await authorize(base);
		expect(await server?.sweepExpired(Date.now() + 10)).toBe(0);
		expect(await server?.sweepExpired(Date.now() + 100)).toBe(1);
	});

	it("a ledger hold with no stated timeout is swept at pendingTtlMs, and not before", async () => {
		const base = await start({ pendingTtlMs: 50, dryRun: false });
		await authorize(base);
		expect(await server?.sweepExpired()).toBe(0);
		await new Promise((r) => setTimeout(r, 80));
		expect(await server?.sweepExpired()).toBe(1);
	});
});

describe("remainingLifeMs (the life left at a given age)", () => {
	const hold = (holdTimeoutMs?: number) => (holdTimeoutMs === undefined ? {} : { holdTimeoutMs });

	const ledger = (pendingTtlMs: number) => ({ pendingTtlMs, dryRun: false });
	const dry = (pendingTtlMs: number) => ({ pendingTtlMs, dryRun: true });

	it("is the shorter of the sweep and the ledger timeout, at the start", () => {
		expect(remainingLifeMs(hold(300_000), ledger(300_000), 0)).toBe(300_000);
		expect(remainingLifeMs(hold(300_000), ledger(10_000), 0)).toBe(10_000);
		expect(remainingLifeMs(hold(5_000), ledger(300_000), 0)).toBe(5_000);
		// Dry run: no ledger hold, so the sweep alone.
		expect(remainingLifeMs(hold(), dry(300_000), 0)).toBe(300_000);
	});

	it("is UNKNOWN (null) for a ledger hold whose handle does not state its timeout", () => {
		expect(remainingLifeMs(hold(), ledger(300_000), 0)).toBeNull();
	});

	it("is what is LEFT, never the total: a hold 100 s old has 200 s of 300", () => {
		expect(remainingLifeMs(hold(300_000), ledger(300_000), 100_000)).toBe(200_000);
		expect(remainingLifeMs(hold(), dry(300_000), 100_000)).toBe(200_000);
	});

	it("is whole milliseconds, and never negative", () => {
		expect(remainingLifeMs(hold(300_000), ledger(300_000), 0.4)).toBe(299_999);
		expect(remainingLifeMs(hold(300_000), ledger(300_000), 300_000)).toBe(0);
		expect(remainingLifeMs(hold(300_000), ledger(300_000), 900_000)).toBe(0);
	});

	it("reads anything unusable as no life left", () => {
		expect(remainingLifeMs(hold(Number.NaN), ledger(300_000), 0)).toBe(0);
		expect(remainingLifeMs(hold(300_000), ledger(300_000), Number.NaN)).toBe(0);
	});
});
