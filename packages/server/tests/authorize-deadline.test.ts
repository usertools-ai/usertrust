// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `POST /v1/authorize` against a ledger that does not answer, with a stub governor whose
 * authorize settles only when the test lets it. `ledger-outage.tb.test.ts` shows the stub reaches
 * the real failure mode (an authorize against a stopped TigerBeetle answers the same 503 in the
 * same time); here every path of the request's state machine is pinned:
 *  - the deadline refuses with 503 `ledger_unavailable`, once, and a later answer writes nothing;
 *  - a client that hangs up before the answer, or whose socket is already destroyed when the reply
 *    lands, gets nothing delivered, and the late hold is given back, never put in `pending`;
 *  - while a refused authorize has not settled, the next one fails fast without calling the governor;
 *  - a late hold's give-back is visible on /v1/budget (`voidsOwed`), by the exhaustive outcome table.
 */

import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Authorization, AuthorizeParams, Governor, ReleaseOutcome } from "usertrust";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import type { ServerEvent } from "../src/events.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";
import { createFakeGovernor, type FakeGovernorHandle } from "./helpers/fake-governor.js";

const KEY = "ut_deadline_key";
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 10, maxOutputTokens: 10 };
const DEADLINE_MS = 200;
const LATE_REASON = "ledger reply after the authorize was refused";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: UsertrustServer | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await server?.close();
	server = undefined;
});

/** An authorize the test settles: `open()` lets it through, `fail()` rejects it. */
interface Gate {
	open: () => void;
	fail: (err: Error) => void;
	promise: Promise<void>;
}
function gate(): Gate {
	let open: () => void = () => {};
	let fail: (err: Error) => void = () => {};
	const promise = new Promise<void>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { open, fail, promise };
}

interface Started {
	base: string;
	port: number;
	fake: FakeGovernorHandle;
	events: ServerEvent[];
	/** How many times the server called `governor.authorize`. */
	authorizes: () => number;
	/** The next authorize waits on this gate (set it before the request), or passes straight through. */
	next: { gate?: Gate | undefined; afterGate?: (() => void) | undefined };
}

async function start(
	overrides: Partial<ServerConfig> = {},
	fakeOpts: Parameters<typeof createFakeGovernor>[0] = {},
): Promise<Started> {
	const fake = createFakeGovernor({ holdTimeoutMs: 300_000, ...fakeOpts });
	let calls = 0;
	const next: Started["next"] = {};
	const governor: Governor = {
		...fake.governor,
		// Read at each call, so a test can swap the fake's release after the server has its governor.
		release: (...args: Parameters<Governor["release"]>) => fake.governor.release(...args),
		authorize: async (params: AuthorizeParams): Promise<Authorization> => {
			calls += 1;
			const g = next.gate;
			const after = next.afterGate;
			next.gate = undefined;
			next.afterGate = undefined;
			if (g !== undefined) await g.promise;
			const auth = await fake.governor.authorize(params);
			after?.();
			return auth;
		},
	};
	server = createUsertrustServer({
		config: {
			host: "127.0.0.1",
			port: 0,
			stateDir: await mkdtemp(join(tmpdir(), "utsrv-deadline-")),
			enforcement: "enforce",
			pendingTtlMs: 300_000,
			dryRun: false,
			ledgerTimeoutMs: DEADLINE_MS,
			tenants: [{ id: "acme", keyHash: hashKey(KEY), budget: 1_000_000 }],
			...overrides,
		},
		factory: async () => governor,
	});
	const events: ServerEvent[] = [];
	server.bus.subscribe("acme", (event) => events.push(event));
	const { port } = await server.listen();
	return { base: `http://127.0.0.1:${port}`, port, fake, events, authorizes: () => calls, next };
}

async function post(base: string, path: string, body: unknown) {
	const started = performance.now();
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
		ms: performance.now() - started,
	};
}
const budget = async (base: string) =>
	(await (
		await fetch(`${base}/v1/budget`, { headers: { authorization: `Bearer ${KEY}` } })
	).json()) as Record<string, unknown>;

/** An authorize sent on a raw request the test can destroy: resolves once the body is written. */
function rawAuthorize(port: number): {
	destroy: () => void;
	answered: Promise<number | undefined>;
} {
	const body = JSON.stringify(AUTHORIZE);
	const req = httpRequest({
		host: "127.0.0.1",
		port,
		method: "POST",
		path: "/v1/authorize",
		headers: {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(body),
			authorization: `Bearer ${KEY}`,
		},
	});
	const answered = new Promise<number | undefined>((resolve) => {
		req.on("response", (res) => resolve(res.statusCode));
		req.on("error", () => resolve(undefined));
		req.on("close", () => resolve(undefined));
	});
	req.end(body);
	return { destroy: () => req.destroy(), answered };
}

const until = async (check: () => boolean, ms = 2_000): Promise<void> => {
	const started = performance.now();
	while (!check()) {
		if (performance.now() - started > ms) throw new Error("timed out waiting");
		await sleep(10);
	}
};

describe("authorize against a ledger that does not answer: the deadline", () => {
	it("refuses with 503 ledger_unavailable at the deadline, says nothing was authorized, and publishes one denied event", async () => {
		const s = await start();
		s.next.gate = gate();
		const res = await post(s.base, "/v1/authorize", AUTHORIZE);
		expect(res.status).toBe(503);
		expect(res.json).toEqual({
			error: "ledger_unavailable",
			reason: "the ledger did not answer within the deadline; nothing was authorized; retry later",
			retryAfterMs: DEADLINE_MS,
		});
		expect(res.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
		expect(res.ms).toBeLessThan(DEADLINE_MS + 1_000);
		expect(s.events.filter((e) => e.type === "denied")).toEqual([
			expect.objectContaining({ type: "denied", error: "ledger_unavailable", shadow: false }),
		]);
	});

	it("is never a shadow, even in evaluate_only: nothing was evaluated", async () => {
		const s = await start({ enforcement: "evaluate_only" });
		s.next.gate = gate();
		const res = await post(s.base, "/v1/authorize", AUTHORIZE);
		expect(res.status).toBe(503);
		expect(s.events.find((e) => e.type === "denied")).toMatchObject({ shadow: false });
	});

	it("a policy denial answers 403 at once, and the deadline later writes nothing", async () => {
		const s = await start({}, { denyReason: "blocked by policy" });
		const res = await post(s.base, "/v1/authorize", AUTHORIZE);
		expect(res.status).toBe(403);
		await sleep(DEADLINE_MS * 2);
		expect(s.events.filter((e) => e.type === "denied")).toHaveLength(1);
		expect(s.events.some((e) => e.type === "denied" && e.error === "ledger_unavailable")).toBe(
			false,
		);
	});

	it("a rejection after the deadline writes nothing and publishes nothing more", async () => {
		const s = await start();
		const g = gate();
		s.next.gate = g;
		const res = await post(s.base, "/v1/authorize", AUTHORIZE);
		expect(res.status).toBe(503);
		g.fail(new Error("the ledger said no, late"));
		await sleep(50);
		expect(s.events.filter((e) => e.type === "denied")).toHaveLength(1);
		expect(s.fake.calls.released).toEqual([]);
	});

	it("an evaluate-only shadow 200 clears the timer: no 503 and no second event after the deadline", async () => {
		const s = await start({ enforcement: "evaluate_only" }, { denyReason: "would deny" });
		const res = await post(s.base, "/v1/authorize", AUTHORIZE);
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ shadow: true, decision: "would_deny" });
		await sleep(DEADLINE_MS * 2);
		expect(s.events.filter((e) => e.type === "denied")).toHaveLength(1);
	});

	it("dryRun: no deadline, a slow authorize still answers 200", async () => {
		const s = await start({ dryRun: true });
		const g = gate();
		s.next.gate = g;
		setTimeout(() => g.open(), DEADLINE_MS * 2);
		const res = await post(s.base, "/v1/authorize", AUTHORIZE);
		expect(res.status).toBe(200);
		expect(res.ms).toBeGreaterThanOrEqual(DEADLINE_MS * 2 - 20);
		expect(server?.pendingCount()).toBe(1);
	});
});

describe("a late reply is given back, never delivered", () => {
	it("refused at the deadline, then answered: the hold is released at once and never enters pending or the authorized event", async () => {
		const s = await start();
		const g = gate();
		s.next.gate = g;
		expect((await post(s.base, "/v1/authorize", AUTHORIZE)).status).toBe(503);
		g.open();
		await until(() => s.fake.calls.released.length === 1);
		expect(s.fake.calls.releaseReasons).toEqual([LATE_REASON]);
		expect(server?.pendingCount()).toBe(0);
		expect(s.events.some((e) => e.type === "authorized")).toBe(false);
		await until(() => true);
		expect((await budget(s.base)).voidsOwed).toBe(0);
	});

	it("a client that hangs up while the ledger is down: no answer is written, and once its authorize is past the deadline, the next authorize fails fast", async () => {
		const s = await start();
		const g = gate();
		s.next.gate = g;
		const raw = rawAuthorize(s.port);
		await until(() => s.authorizes() === 1);
		raw.destroy();
		expect(await raw.answered).toBeUndefined();
		// Past the deadline with its authorize still unanswered: abandoned, so the deadline wrote and
		// published nothing for it, and the ledger is now known not to have answered.
		await sleep(DEADLINE_MS + 50);
		expect(s.events.some((e) => e.type === "denied")).toBe(false);
		const next = await post(s.base, "/v1/authorize", AUTHORIZE);
		expect(next.status).toBe(503);
		expect(next.ms).toBeLessThan(DEADLINE_MS / 2);
		expect(s.authorizes()).toBe(1);
		g.open();
		await until(() => s.fake.calls.released.length === 1);
		expect(s.fake.calls.releaseReasons).toEqual([LATE_REASON]);
		expect(server?.pendingCount()).toBe(0);
		expect(s.events.some((e) => e.type === "authorized")).toBe(false);
		// Settled: authorize works again.
		expect((await post(s.base, "/v1/authorize", AUTHORIZE)).status).toBe(200);
	});

	it("a client that hangs up on a healthy ledger engages no fast-fail: a concurrent authorize gets its 200, and the abandoned hold is still given back", async () => {
		const s = await start();
		const g = gate();
		s.next.gate = g;
		// The abandoned authorize answers at half the deadline: slow, not down.
		setTimeout(() => g.open(), DEADLINE_MS * 0.5);
		const raw = rawAuthorize(s.port);
		await until(() => s.authorizes() === 1);
		setTimeout(() => raw.destroy(), DEADLINE_MS * 0.2);
		await sleep(DEADLINE_MS * 0.3);
		const concurrent = await post(s.base, "/v1/authorize", AUTHORIZE);
		expect(concurrent.status).toBe(200);
		expect(s.authorizes()).toBe(2);
		expect(await raw.answered).toBeUndefined();
		await until(() => s.fake.calls.released.length === 1);
		expect(s.fake.calls.releaseReasons).toEqual([LATE_REASON]);
		// Only the concurrent hold is pending; nothing was refused.
		expect(server?.pendingCount()).toBe(1);
		expect(s.events.some((e) => e.type === "denied")).toBe(false);
	});

	it("a normal POST that completes is not a hang-up: 200, and the hold is in pending", async () => {
		const s = await start({ ledgerTimeoutMs: 60_000 });
		const res = await post(s.base, "/v1/authorize", AUTHORIZE);
		expect(res.status).toBe(200);
		expect(server?.pendingCount()).toBe(1);
		expect(s.fake.calls.released).toEqual([]);
		expect(s.events.some((e) => e.type === "authorized")).toBe(true);
	});

	it("a socket destroyed with its close event still pending when the reply lands: given back, not delivered", async () => {
		const sockets: Array<{ destroy: () => void }> = [];
		const emit = Server.prototype.emit;
		vi.spyOn(Server.prototype, "emit").mockImplementation(function (
			this: Server,
			event: string | symbol,
			...args: unknown[]
		) {
			if (event === "connection") sockets.push(args[0] as { destroy: () => void });
			return emit.call(this, event, ...args);
		});
		const s = await start({ ledgerTimeoutMs: 60_000 });
		const g = gate();
		s.next.gate = g;
		// The server's own socket is destroyed in the same tick the reply lands: its close event
		// (emitted on the next tick) has not run when the server reads the answer.
		s.next.afterGate = () => {
			for (const socket of sockets) socket.destroy();
		};
		const raw = rawAuthorize(s.port);
		await until(() => s.authorizes() === 1);
		g.open();
		expect(await raw.answered).toBeUndefined();
		await until(() => s.fake.calls.released.length === 1);
		expect(s.fake.calls.releaseReasons).toEqual([LATE_REASON]);
		expect(server?.pendingCount()).toBe(0);
		expect(s.events.some((e) => e.type === "authorized")).toBe(false);
	});
});

describe("fast-fail while an authorize the ledger has not answered is outstanding", () => {
	it("a second authorize answers 503 at once, without calling the governor; once the first settles, authorize works again", async () => {
		const s = await start();
		const g = gate();
		s.next.gate = g;
		expect((await post(s.base, "/v1/authorize", AUTHORIZE)).status).toBe(503);
		const second = await post(s.base, "/v1/authorize", AUTHORIZE);
		expect(second.status).toBe(503);
		expect(second.json).toMatchObject({ error: "ledger_unavailable", retryAfterMs: DEADLINE_MS });
		expect(second.ms).toBeLessThan(DEADLINE_MS / 2);
		expect(s.authorizes()).toBe(1);
		g.open();
		await until(() => s.fake.calls.released.length === 1);
		const third = await post(s.base, "/v1/authorize", AUTHORIZE);
		expect(third.status).toBe(200);
		expect(s.authorizes()).toBe(2);
	});

	it("an authorize that settles by rejecting also ends the fast-fail", async () => {
		const s = await start();
		const g = gate();
		s.next.gate = g;
		expect((await post(s.base, "/v1/authorize", AUTHORIZE)).status).toBe(503);
		g.fail(new Error("closed"));
		await sleep(20);
		expect((await post(s.base, "/v1/authorize", AUTHORIZE)).status).toBe(200);
	});
});

describe("the late give-back's outcome, by the exhaustive table, on /v1/budget", () => {
	async function lateHold(
		release: (auth: Authorization, reason?: string) => Promise<ReleaseOutcome>,
	): Promise<Started> {
		const s = await start();
		s.fake.governor.release = release;
		const g = gate();
		s.next.gate = g;
		expect((await post(s.base, "/v1/authorize", AUTHORIZE)).status).toBe(503);
		g.open();
		return s;
	}

	it("/v1/budget carries voidsOwed beside its existing fields, unchanged", async () => {
		const s = await start();
		expect(await budget(s.base)).toEqual({
			remaining: 10_000,
			settlementsUnrecoverable: 0,
			voidsOwed: 0,
		});
	});

	it("a release still waiting on the ledger counts at once (voiding), and leaves when it lands", async () => {
		let land: (o: ReleaseOutcome) => void = () => {};
		const s = await lateHold(() => new Promise<ReleaseOutcome>((resolve) => (land = resolve)));
		await until(() => true);
		await sleep(20);
		expect((await budget(s.base)).voidsOwed).toBe(1);
		land({ released: true });
		await sleep(20);
		expect((await budget(s.base)).voidsOwed).toBe(0);
	});

	it("a void the ledger reports already expired or already voided is done", async () => {
		for (const voidError of ["pending_transfer_expired", "pending_transfer_already_voided"]) {
			const s = await lateHold(async () => ({ released: true, voidError }));
			await sleep(30);
			expect((await budget(s.base)).voidsOwed).toBe(0);
			await server?.close();
			server = undefined;
		}
	});

	it("released:false (another terminal, or teardown, took it): removed as taken, with a log line, not stuck", async () => {
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		});
		const s = await lateHold(async () => ({ released: false }));
		await sleep(30);
		expect((await budget(s.base)).voidsOwed).toBe(0);
		expect(written.some((line) => line.includes("taken by another terminal"))).toBe(true);
	});

	it("a void refused with another code stays counted (refused) until the hold's life is spent, then expires with a log line", async () => {
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		});
		const s = await lateHold(async () => ({ released: true, voidError: "exceeds_credits" }));
		await sleep(30);
		expect((await budget(s.base)).voidsOwed).toBe(1);
		expect(written.some((line) => line.includes("exceeds_credits"))).toBe(true);
		// The transfer id is never logged, only a short hash of it.
		expect(written.some((line) => line.includes("tx_fake_"))).toBe(false);
		await server?.sweepExpired(Date.now() + 60_000);
		expect((await budget(s.base)).voidsOwed).toBe(1);
		await server?.sweepExpired(Date.now() + 300_000 + 30_000 + 1_000);
		expect((await budget(s.base)).voidsOwed).toBe(0);
		expect(written.some((line) => line.includes("has expired"))).toBe(true);
	});

	it("a release that rejects is refused under the error's class name, and counted", async () => {
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		});
		class LedgerGone extends Error {}
		const s = await lateHold(async () => {
			throw new LedgerGone("secret detail never logged");
		});
		await sleep(30);
		expect((await budget(s.base)).voidsOwed).toBe(1);
		expect(written.some((line) => line.includes("LedgerGone"))).toBe(true);
		expect(written.some((line) => line.includes("secret detail"))).toBe(false);
	});
});
