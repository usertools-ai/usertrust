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
import { join } from "node:path";
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

describe("claim refuses an entry that is no longer the one in pending", () => {
	it("a settle that lands mid-shutdown is charged once and is never released under, nor put back", async () => {
		// close() snapshots `pending` and releases [A, B, C] one at a time (each void takes 150 ms). A
		// client settles B in that window; B's settle is slow. When the loop reaches B it must find B
		// claimed already: a second claim would release B under the settle, and a failed settle would
		// then restore B into `pending` on a closing server (usage neither charged nor recorded).
		const fake = createFakeGovernor({ releaseDelayMs: 150, settleDelayMs: 250 });
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
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
		const closing = server.close();
		await new Promise((r) => setTimeout(r, 30)); // the loop is parked on A's release
		const settle = await post(base, "/v1/settle", {
			transferId: b,
			inputTokens: 5,
			outputTokens: 5,
		});
		await closing;
		server = undefined;
		expect(settle.status).toBe(200);
		expect(fake.calls.settled).toEqual([b]);
		expect(fake.calls.released).toEqual([a, c]);
	}, 20_000);
});
