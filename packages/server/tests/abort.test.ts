// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `POST /v1/abort` answers 200 only when the governor ended the hold (#240).
 *
 * It answered `200 { aborted: true }` whatever the governor did, so an abort of a hold
 * the governor no longer held (its settle in flight, or already ended) said it aborted
 * something it had not, and the server published an `aborted` event for it. It now keeps
 * `/v1/release`'s rule: a hold the governor no longer held is a 404 `unknown transferId`,
 * with no event, and the entry stays out (the sweep never meets it again). A void the
 * ledger refused still ended the hold: 200, with the fixed `voidError`.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Authorization, readLedgerEvents } from "usertrust";
import { afterEach, describe, expect, it } from "vitest";
import type { TenantConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import type { ServerEvent } from "../src/events.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const KEY = "ut_abort_key";
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 10, maxOutputTokens: 10 };

let server: UsertrustServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

async function post(
	base: string,
	path: string,
	body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function hold(base: string): Promise<string> {
	const res = await post(base, "/v1/authorize", AUTHORIZE);
	expect(res.status).toBe(200);
	return res.json.transferId as string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("POST /v1/abort against the real governor (dry run)", () => {
	async function start(): Promise<{
		base: string;
		stateDir: string;
		tenant: TenantConfig;
		events: ServerEvent[];
	}> {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-abort-"));
		const tenant: TenantConfig = { id: "acme", keyHash: hashKey(KEY), budget: 1_000_000 };
		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir,
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				dryRun: true,
				tenants: [tenant],
			},
		});
		const events: ServerEvent[] = [];
		server.bus.subscribe("acme", (event) => events.push(event));
		const { port } = await server.listen();
		return { base: `http://127.0.0.1:${port}`, stateDir, tenant, events };
	}

	async function chainOf(stateDir: string, transferId: string): Promise<string[]> {
		await server?.close();
		server = undefined;
		const events = readLedgerEvents(join(stateDir, "acme", ".usertrust")) as Array<{
			kind: string;
			data: Record<string, unknown>;
		}>;
		return events.filter((e) => e.data.transferId === transferId).map((e) => e.kind);
	}

	it("a live hold: 200 { aborted: true, transferId }, the `aborted` event, and llm_call_failed", async () => {
		const { base, stateDir, events } = await start();
		const transferId = await hold(base);
		const res = await post(base, "/v1/abort", { transferId, error: "provider 500" });
		expect(res).toEqual({ status: 200, json: { aborted: true, transferId } });
		expect(events.filter((e) => e.type === "aborted").map((e) => e.transferId)).toEqual([
			transferId,
		]);
		expect(await chainOf(stateDir, transferId)).toEqual(["llm_call_failed"]);
	});

	it("a hold the governor already ended: 404 `unknown transferId`, no event, no second record, and the entry stays out", async () => {
		const { base, stateDir, tenant, events } = await start();
		const authorized = await post(base, "/v1/authorize", AUTHORIZE);
		const { transferId, estimatedCost, model, createdAt } = authorized.json as {
			transferId: string;
			estimatedCost: number;
			model: string;
			createdAt: number;
		};
		// The governor ends the hold itself, through the handle it answered with; the
		// server's entry for it is still pending.
		const handle: Authorization = { transferId, estimatedCost, model, createdAt };
		const governor = await server?.pool.get(tenant);
		expect(await governor?.release(handle, "ended by the governor")).toEqual({ released: true });
		expect(server?.pendingCount()).toBe(1);

		const res = await post(base, "/v1/abort", { transferId, error: "provider 500" });
		expect(res).toEqual({
			status: 404,
			json: { error: "not_found", reason: "unknown transferId" },
		});
		expect(events.filter((e) => e.type === "aborted")).toEqual([]);
		// Not put back: no route and no sweep meets it again.
		expect(server?.pendingCount()).toBe(0);
		expect(await chainOf(stateDir, transferId)).toEqual(["hold_released"]);
	});
});

describe("the abort 200 is earned: it says the governor ended the hold", () => {
	async function startFake(abort: { notHeld?: boolean; voidError?: string; throws?: boolean }) {
		const fake = createFakeGovernor({ abort });
		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir: "/tmp/utsrv-abort-fake",
				enforcement: "enforce",
				pendingTtlMs: 50,
				dryRun: true,
				tenants: [{ id: "acme", keyHash: hashKey(KEY) }],
			},
			factory: async () => fake.governor,
		});
		const events: ServerEvent[] = [];
		server.bus.subscribe("acme", (event) => events.push(event));
		const { port } = await server.listen();
		return { base: `http://127.0.0.1:${port}`, fake, events };
	}

	it("a governor that no longer holds it: 404 `unknown transferId`, no event, and the sweep never meets it", async () => {
		const { base, events } = await startFake({ notHeld: true });
		const transferId = await hold(base);
		const res = await post(base, "/v1/abort", { transferId, error: "provider 500" });
		expect(res).toEqual({
			status: 404,
			json: { error: "not_found", reason: "unknown transferId" },
		});
		expect(events.filter((e) => e.type === "aborted")).toEqual([]);
		expect(server?.pendingCount()).toBe(0);
		await sleep(80);
		expect(await server?.sweepExpired()).toBe(0);
	});

	it("an abort whose ledger void failed still ended the hold: 200, with voidError", async () => {
		const { base, events } = await startFake({ voidError: "pending_transfer_not_found" });
		const transferId = await hold(base);
		const res = await post(base, "/v1/abort", { transferId, error: "provider 500" });
		expect(res).toEqual({
			status: 200,
			json: { aborted: true, transferId, voidError: "pending_transfer_not_found" },
		});
		expect(events.filter((e) => e.type === "aborted").map((e) => e.transferId)).toEqual([
			transferId,
		]);
	});

	it("a governor that THROWS: 500, and the entry is put back, so the abort stays retryable", async () => {
		const { base } = await startFake({ throws: true });
		const transferId = await hold(base);
		expect((await post(base, "/v1/abort", { transferId })).status).toBe(500);
		expect(server?.pendingCount()).toBe(1);
	});
});
