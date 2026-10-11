// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `POST /v1/settle` for a transferId the server holds no hold for.
 *
 * That used to be a bare 404, which dropped real provider spend the ledger would never charge
 * (a TTL sweep ended the hold, the server restarted, or the settle was a retry). It is now:
 *  - `410 settlement_unrecoverable`: RECORDED on the chain (through `recordUnheldSettlement`),
 *    counted on /v1/health, announced over SSE. It moves no money and re-opens nothing.
 *  - `409 already_settled`: a retry of a settle that went through in THIS process, nothing recorded.
 *  - `409 settle_in_progress`: a settle for the id is still running, nothing recorded.
 * The recently-settled memory is bounded (RECENTLY_SETTLED_MEMORY, FIFO): past it a retry reads as
 * an unknown hold and is recorded, a duplicate record of a charged settle and never a lost one.
 * `/v1/abort` and `/v1/release` keep their 404.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import {
	createUsertrustServer,
	RECENTLY_SETTLED_MEMORY,
	type UsertrustServer,
} from "../src/server.js";
import { createFakeGovernor, type FakeGovernorHandle } from "./helpers/fake-governor.js";

const KEY = "ut_srv_key";
const config = (): ServerConfig => ({
	host: "127.0.0.1",
	port: 0,
	stateDir: "/tmp/utsrv-unrecoverable",
	enforcement: "enforce",
	pendingTtlMs: 300_000,
	dryRun: true,
	tenants: [
		{ id: "acme", keyHash: hashKey(KEY) },
		{ id: "other", keyHash: hashKey("ut_srv_other") },
	],
});

let server: UsertrustServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

async function start(
	fakeOpts: Parameters<typeof createFakeGovernor>[0] = {},
): Promise<{ base: string; fake: FakeGovernorHandle }> {
	const fake = createFakeGovernor(fakeOpts);
	server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
	const { port } = await server.listen();
	return { base: `http://127.0.0.1:${port}`, fake };
}

const post = (base: string, path: string, body: unknown, key = KEY): Promise<Response> =>
	fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify(body),
	});
const authorize = async (base: string): Promise<string> =>
	(
		(await (
			await post(base, "/v1/authorize", { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 })
		).json()) as { transferId: string }
	).transferId;
const health = async (base: string) =>
	(await (await fetch(`${base}/v1/health`)).json()) as {
		capabilities: string[];
		settlementsUnrecoverable?: number;
	};
/** The per-tenant count, served only on the authenticated /v1/budget. */
const counted = async (base: string, key = KEY): Promise<number> =>
	(
		(await (
			await fetch(`${base}/v1/budget`, { headers: { authorization: `Bearer ${key}` } })
		).json()) as { settlementsUnrecoverable: number }
	).settlementsUnrecoverable;

describe("an unknown transferId on /v1/settle is recorded, not dropped", () => {
	it("410 settlement_unrecoverable, handed to the governor with the reported usage, and counted", async () => {
		const { base, fake } = await start();
		expect(await counted(base)).toBe(0);
		const res = await post(base, "/v1/settle", {
			transferId: "tx_gone",
			inputTokens: 100,
			outputTokens: 20,
			usageSource: "provider",
		});
		expect(res.status).toBe(410);
		expect(await res.json()).toMatchObject({
			error: "settlement_unrecoverable",
			transferId: "tx_gone",
			recorded: true,
		});
		expect(fake.calls.unheld).toEqual([
			expect.objectContaining({
				transferId: "tx_gone",
				inputTokens: 100,
				outputTokens: 20,
				usageSource: "provider",
			}),
		]);
		expect(fake.calls.settled).toEqual([]);
		expect(await counted(base)).toBe(1);
		// ... never on the unauthenticated health, and never another tenant's count
		expect((await health(base)).settlementsUnrecoverable).toBeUndefined();
		expect(await counted(base, "ut_srv_other")).toBe(0);
	});

	it("moves nothing: no settle, no abort, no release, and the budget is untouched", async () => {
		const { base, fake } = await start();
		const before = (await (
			await fetch(`${base}/v1/budget`, { headers: { authorization: `Bearer ${KEY}` } })
		).json()) as { remaining: number };
		await post(base, "/v1/settle", {
			transferId: "tx_gone",
			inputTokens: 5_000_000,
			outputTokens: 5_000_000,
		});
		const after = (await (
			await fetch(`${base}/v1/budget`, { headers: { authorization: `Bearer ${KEY}` } })
		).json()) as { remaining: number };
		expect(after.remaining).toBe(before.remaining);
		expect([
			fake.calls.settled,
			fake.calls.aborted,
			fake.calls.released,
			fake.calls.authorized,
		]).toEqual([[], [], [], []]);
	});

	it("the health capability names it, so a client checks before relying on the new codes", async () => {
		const { base } = await start();
		expect((await health(base)).capabilities).toContain("settle-unrecoverable");
	});

	it("an exact retry the governor already recorded answers recorded: false and is not counted again", async () => {
		const { base } = await start({ unheld: { recorded: false } });
		const res = await post(base, "/v1/settle", { transferId: "tx_gone" });
		expect(res.status).toBe(410);
		expect(await res.json()).toMatchObject({ recorded: false });
		expect(await counted(base)).toBe(0);
	});

	it("a governor that cannot append: not swallowed, a 500, and not counted", async () => {
		const { base } = await start({ unheld: { throws: true } });
		const res = await post(base, "/v1/settle", { transferId: "tx_gone" });
		expect(res.status).toBeGreaterThanOrEqual(500);
		expect(await counted(base)).toBe(0);
	});

	it("a settle racing the TTL sweep (the hold is mid-release) waits and then answers the recorded 410, not a 409", async () => {
		const { base, fake } = await start({ unheld: { heldFor: 2 } });
		const res = await post(base, "/v1/settle", { transferId: "tx_mid_release" });
		expect(res.status).toBe(410);
		expect(await res.json()).toMatchObject({ error: "settlement_unrecoverable", recorded: true });
		expect(fake.calls.unheld.length).toBe(3);
		expect(await counted(base)).toBe(1);
	});

	it("a governor that still holds the id answers 409 hold_active, nothing counted", async () => {
		const { base } = await start({ unheld: { held: true } });
		const res = await post(base, "/v1/settle", { transferId: "tx_live_elsewhere" });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: "hold_active" });
		expect(await counted(base)).toBe(0);
	});

	it("another tenant's live hold is just as unknown: recorded under the caller, never settled", async () => {
		const { base, fake } = await start();
		const mine = await authorize(base);
		const res = await post(base, "/v1/settle", { transferId: mine }, "ut_srv_other");
		expect(res.status).toBe(410);
		expect(fake.calls.settled).toEqual([]);
		// ... and the owner's hold is untouched and still settles
		expect((await post(base, "/v1/settle", { transferId: mine })).status).toBe(200);
	});

	it("is announced over SSE", async () => {
		const { base } = await start();
		const ctrl = new AbortController();
		const stream = await fetch(`${base}/v1/events`, {
			headers: { authorization: `Bearer ${KEY}` },
			signal: ctrl.signal,
		});
		const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
		await post(base, "/v1/settle", { transferId: "tx_gone" });
		let seen = "";
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && !seen.includes("settlement_unrecoverable")) {
			const { value, done } = await reader.read();
			if (done) break;
			seen += new TextDecoder().decode(value);
		}
		ctrl.abort();
		expect(seen).toContain("settlement_unrecoverable");
	});

	it("too many records in the window: 429 rate_limited, nothing counted", async () => {
		const { base } = await start({ unheld: { rateLimited: true } });
		const res = await post(base, "/v1/settle", { transferId: "tx_gone" });
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ error: "rate_limited" });
		expect(await counted(base)).toBe(0);
	});

	it("an over-long transferId is a 400, not a 500", async () => {
		const { base } = await start();
		expect((await post(base, "/v1/settle", { transferId: "x".repeat(257) })).status).toBe(400);
	});

	it("abort and release of an unknown id keep their 404", async () => {
		const { base } = await start();
		expect((await post(base, "/v1/abort", { transferId: "tx_gone" })).status).toBe(404);
		expect((await post(base, "/v1/release", { transferId: "tx_gone" })).status).toBe(404);
	});
});

describe("a retry or a concurrent settle is not an unrecoverable one", () => {
	it("a retry of a settle that went through: 409 already_settled, nothing recorded", async () => {
		const { base, fake } = await start();
		const id = await authorize(base);
		expect((await post(base, "/v1/settle", { transferId: id })).status).toBe(200);
		const res = await post(base, "/v1/settle", { transferId: id });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: "already_settled", transferId: id });
		expect(fake.calls.unheld).toEqual([]);
		expect(await counted(base)).toBe(0);
	});

	it("a settle whose ledger post was AMBIGUOUS (settled: false) may have charged: its retry is a 409 settlement_ambiguous, nothing recorded, never 'authorize again'", async () => {
		const { base, fake } = await start();
		const id = await authorize(base);
		const original = fake.governor.settle;
		fake.governor.settle = async (...args) => ({
			...(await original.apply(fake.governor, args)),
			settled: false,
		});
		expect((await post(base, "/v1/settle", { transferId: id })).status).toBe(200);
		const retry = await post(base, "/v1/settle", { transferId: id });
		expect(retry.status).toBe(409);
		expect(await retry.json()).toMatchObject({ error: "settlement_ambiguous", transferId: id });
		expect(fake.calls.unheld).toEqual([]);
	});

	it("a failed settle stays retryable and is not remembered as settled", async () => {
		const { base, fake } = await start();
		const id = await authorize(base);
		const original = fake.governor.settle;
		let fail = true;
		fake.governor.settle = async (...args) => {
			if (fail) {
				fail = false;
				throw new Error("ledger blip");
			}
			return original.apply(fake.governor, args);
		};
		expect((await post(base, "/v1/settle", { transferId: id })).status).toBeGreaterThanOrEqual(500);
		expect((await post(base, "/v1/settle", { transferId: id })).status).toBe(200);
		expect(fake.calls.unheld).toEqual([]);
	});

	it("a concurrent settle while one is running: 409 settle_in_progress, nothing recorded", async () => {
		const { base, fake } = await start();
		const id = await authorize(base);
		const original = fake.governor.settle;
		let release: (() => void) | undefined;
		fake.governor.settle = async (...args) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return original.apply(fake.governor, args);
		};
		const first = post(base, "/v1/settle", { transferId: id });
		for (let i = 0; i < 100 && release === undefined; i++)
			await new Promise((r) => setTimeout(r, 10));
		const second = await post(base, "/v1/settle", { transferId: id });
		expect(second.status).toBe(409);
		expect(await second.json()).toMatchObject({ error: "settle_in_progress" });
		release?.();
		expect((await first).status).toBe(200);
		expect(fake.calls.unheld).toEqual([]);
	});
});

describe("the settled memory is PER TENANT", () => {
	it("one tenant settling past the bound never evicts another tenant's remembered id", async () => {
		const { base } = await start({ budget: 10 ** 12 });
		const mine = await authorize(base);
		expect((await post(base, "/v1/settle", { transferId: mine })).status).toBe(200);
		for (let i = 0; i < RECENTLY_SETTLED_MEMORY + 1; i++) {
			const id = (
				(await (
					await post(
						base,
						"/v1/authorize",
						{ model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 },
						"ut_srv_other",
					)
				).json()) as { transferId: string }
			).transferId;
			expect((await post(base, "/v1/settle", { transferId: id }, "ut_srv_other")).status).toBe(200);
		}
		expect((await post(base, "/v1/settle", { transferId: mine })).status).toBe(409);
	}, 120_000);
});

describe("the recently-settled memory is bounded, and eviction is a recorded duplicate, not a loss", () => {
	it(`holds ${RECENTLY_SETTLED_MEMORY}; the oldest settled id falls out FIFO and a retry of it is then recorded (410)`, async () => {
		const { base, fake } = await start({ budget: 10 ** 12 });
		const ids: string[] = [];
		const N = RECENTLY_SETTLED_MEMORY;
		for (let i = 0; i < N + 1; i++) {
			const id = await authorize(base);
			expect((await post(base, "/v1/settle", { transferId: id })).status).toBe(200);
			ids.push(id);
		}
		// the newest N are remembered: 409, nothing recorded
		expect((await post(base, "/v1/settle", { transferId: ids[N] as string })).status).toBe(409);
		expect((await post(base, "/v1/settle", { transferId: ids[1] as string })).status).toBe(409);
		expect(fake.calls.unheld).toEqual([]);
		// the oldest was evicted by the (N+1)th: its retry reads as an unknown hold and is RECORDED
		const evicted = await post(base, "/v1/settle", { transferId: ids[0] as string });
		expect(evicted.status).toBe(410);
		expect(fake.calls.unheld).toHaveLength(1);
	}, 120_000);
});

describe("adjudicated review threads", () => {
	it("a settle that finds its hold mid-release waits for a SLOW ledger void (longer than the poll window) and is recorded, never a 409", async () => {
		const { base, fake } = await start({ releaseDelayMs: 3_000 });
		const id = await authorize(base);
		// the TTL sweep takes the entry out of `pending` and starts the (slow) release
		const sweeping = server?.sweepExpired(Date.now() + 10 * 60_000);
		await new Promise((r) => setTimeout(r, 50));
		const res = await post(base, "/v1/settle", { transferId: id });
		expect(res.status).toBe(410);
		expect(await res.json()).toMatchObject({ error: "settlement_unrecoverable", recorded: true });
		expect(fake.calls.unheld.length).toBeGreaterThan(0);
		await sweeping;
	}, 20_000);

	it("a RETRY of an already-settled settle with a long id is 409 already_settled, not 'names no hold here'", async () => {
		const { base } = await start({ idLength: 300 });
		const id = await authorize(base);
		expect((await post(base, "/v1/settle", { transferId: id })).status).toBe(200);
		const retry = await post(base, "/v1/settle", { transferId: id });
		expect(retry.status).toBe(409);
		expect(await retry.json()).toMatchObject({ error: "already_settled" });
	});

	it("a live hold whose factory issued a long transferId still settles; only the unknown-hold record path refuses an over-long id", async () => {
		const { base } = await start({ idLength: 300 });
		const id = await authorize(base);
		expect(id.length).toBe(300);
		expect((await post(base, "/v1/settle", { transferId: id })).status).toBe(200);
		// an unknown id that long is refused on the recording path (400), not recorded or 500
		expect((await post(base, "/v1/settle", { transferId: "y".repeat(300) })).status).toBe(400);
	});
});
