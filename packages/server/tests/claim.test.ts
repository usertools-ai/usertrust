// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * One way out of `pending`.
 *
 * An entry used to leave `pending` in four places (settle, abort, release, the sweep) and only the sweep
 * registered a terminal for a racing settle to wait on, so a settle landing mid-void on a client release or
 * abort polled 2 s and answered a 409 the plugin reads as "claimed": the usage was never charged or
 * recorded. Two rounds of that class were patched by handler. `claim` is now the only code that removes an
 * entry, and it registers the terminal in the same step. This pins the structure: a handler that takes an
 * entry out on its own is the regression, whatever it is called.
 */

import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { Governor } from "usertrust";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const source = readFileSync(join(import.meta.dirname, "..", "src", "server.ts"), "utf-8");
// Comments may name the calls; only code counts.
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the claim is the only way an entry leaves pending", () => {
	it("server.ts holds exactly one delete call on pending, and no clear call", () => {
		expect(code.match(/\bpending\.delete\(/g)?.length).toBe(1);
		expect(code.match(/\bpending\.clear\(/g) ?? []).toEqual([]);
	});

	it("the one delete sits inside claim, beside the registration of its terminal", () => {
		const start = code.indexOf("function claim<");
		const del = code.indexOf("pending.delete(");
		const register = code.indexOf("claimed.set(");
		expect(start).toBeGreaterThan(-1);
		expect(del).toBeGreaterThan(start);
		expect(register).toBeGreaterThan(del);
		// Nothing can yield between the delete and the registration: claim itself never awaits (the
		// terminal runs inside an async wrapper that is started, not awaited, before `claimed.set`).
		const end = code.indexOf("\n\t}\n", start);
		const body = code.slice(start, end);
		// the only await is the terminal's own, inside the wrapper that is started (not awaited) here
		expect(body.match(/\bawait\b/g)?.length).toBe(1);
		expect(body).toContain("await work()");
		expect(body).not.toMatch(/\)\.then\(/);
	});
});

const KEY = "ut_srv_key";
const config = (): ServerConfig => ({
	host: "127.0.0.1",
	port: 0,
	stateDir: "/tmp/utsrv-claim",
	enforcement: "enforce",
	pendingTtlMs: 300_000,
	dryRun: true,
	tenants: [{ id: "acme", keyHash: hashKey(KEY) }],
});
let server: UsertrustServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});
const post = (base: string, path: string, body: unknown): Promise<Response> =>
	fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify(body),
	});

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}
function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** POST on a new connection that closes after its answer: no keep-alive socket is reused. */
function postOnFreshConnection(
	port: number,
	path: string,
	body: unknown,
): Promise<{ status: number; body: string }> {
	const payload = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "POST",
				agent: false,
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payload),
					authorization: `Bearer ${KEY}`,
					connection: "close",
				},
			},
			(res) => {
				let text = "";
				res.setEncoding("utf-8");
				res.on("data", (chunk: string) => {
					text += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

describe("claim refuses an entry that is no longer the one in pending", () => {
	it("a settle that lands mid-shutdown is charged once and is never released under, nor put back", async () => {
		// A client settles B, and B's settle is slow and still in flight when close() snapshots `pending`
		// and releases [A, B, C] all at once (each release is parked here until the test lets it go). B
		// is claimed by its settle already: a second claim would release B under the settle, and a
		// failed settle would then restore B into `pending` on a closing server (usage neither charged
		// nor recorded).
		//
		// The order is driven by the governor's own signals, never by timers: each step waits for the
		// one before it to have STARTED. (A 30 ms timer here raced shutdown's closeAllConnections and cut
		// the settle's socket now and then.)
		const fake = createFakeGovernor();
		const releaseStarted = new Map<string, Deferred>();
		const releaseGo = new Map<string, Deferred>();
		const settleStarted = deferred();
		const settleGo = deferred();
		const governor: Governor = {
			...fake.governor,
			async release(auth, reason, o) {
				releaseStarted.get(auth.transferId)?.resolve();
				// An id with no gate (B, if a regression ever released it) is not parked: the
				// `released` assertion below catches it instead of a hang.
				await releaseGo.get(auth.transferId)?.promise;
				return fake.governor.release(auth, reason, o);
			},
			async settle(auth, params) {
				settleStarted.resolve();
				await settleGo.promise;
				return fake.governor.settle(auth, params);
			},
		};
		server = createUsertrustServer({ config: config(), factory: async () => governor });
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const auth = async (): Promise<string> => {
			const r = await post(base, "/v1/authorize", {
				model: "m",
				estimatedInputTokens: 1,
				maxOutputTokens: 1,
			});
			return ((await r.json()) as { transferId: string }).transferId;
		};
		const a = await auth();
		const b = await auth();
		const c = await auth();
		for (const id of [a, c]) {
			releaseStarted.set(id, deferred());
			releaseGo.set(id, deferred());
		}
		// On a connection of its own, so it never rides a keep-alive socket shutdown may cut.
		const settle = postOnFreshConnection(port, "/v1/settle", {
			transferId: b,
			inputTokens: 5,
			outputTokens: 5,
		});
		await settleStarted.promise; // B is claimed by the settle, which is in flight
		const closing = server.close();
		// Both other releases have started: close() does not wait for A before it reaches C.
		await releaseStarted.get(a)?.promise;
		await releaseStarted.get(c)?.promise;
		settleGo.resolve();
		const settled = await settle; // answered before close() can reach closeAllConnections
		releaseGo.get(a)?.resolve();
		releaseGo.get(c)?.resolve();
		await closing;
		server = undefined;
		expect(settled.status).toBe(200);
		expect(fake.calls.settled).toEqual([b]);
		expect(fake.calls.released).toEqual([a, c]);
	}, 20_000);
});
