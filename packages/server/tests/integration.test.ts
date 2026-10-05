import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";

const KEY = "ut_integration_key";

let server: UsertrustServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

describe("integration: real governor in dryRun mode", () => {
	it("authorize -> settle writes a real receipt with an audit hash", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-int-"));
		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir,
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				requestTimeoutMs: 10_000,
				dryRun: true,
				tenants: [{ id: "real", keyHash: hashKey(KEY), budget: 50_000 }],
			},
		});
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
		const authRes = await fetch(`${base}/v1/authorize`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				estimatedInputTokens: 200,
				maxOutputTokens: 100,
				actor: "integration-test",
			}),
		});
		expect(authRes.status).toBe(200);
		const auth = (await authRes.json()) as { transferId: string; estimatedCost: number };
		expect(auth.estimatedCost).toBeGreaterThan(0);
		const settleRes = await fetch(`${base}/v1/settle`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				transferId: auth.transferId,
				inputTokens: 200,
				outputTokens: 40,
				usageSource: "provider",
				computeMs: 4709,
			}),
		});
		expect(settleRes.status).toBe(200);
		const receipt = (await settleRes.json()) as {
			settled: boolean;
			auditHash: string;
			transferId: string;
			meter?: { computeMs?: number };
		};
		expect(receipt.settled).toBe(true);
		expect(receipt.transferId).toBe(auth.transferId);
		expect(receipt.auditHash).toMatch(/^[0-9a-f]{16,}$/);
		expect(receipt.meter?.computeMs).toBe(4709);
	});
});

/**
 * The DEFAULT configuration — `dryRun: false` — end to end.
 *
 * The suite above is the only other end-to-end coverage of a real governor, and it
 * runs in dryRun, which skips ledger construction entirely. Every remaining server
 * test injects `createFakeGovernor`. So the one configuration that had never been
 * exercised end to end was the one every real deployment runs, and it was broken:
 * `/v1/authorize` never responded at all (usertools-ai/usertrust#130).
 *
 * This asks for the minimum that makes a governance server usable when its ledger
 * is down — an ANSWER. The status code matters less than the fact that one arrives:
 * a fail-closed client can act on 503 and can only stall on silence.
 */
describe("integration: real governor in the DEFAULT (non-dryRun) config", () => {
	/** A port nothing is listening on: bind an ephemeral port, then give it back. */
	async function closedPort(): Promise<number> {
		const probe = createServer();
		await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const address = probe.address();
		if (address === null || typeof address === "string") {
			throw new Error("could not acquire an ephemeral port");
		}
		const { port } = address;
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		return port;
	}

	it("answers 503 when the ledger is unreachable, instead of hanging the client", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-default-"));
		// Point the tenant's governor at a cluster that is not there. 400ms keeps the
		// test quick; the shipped default is 5s.
		const configPath = join(stateDir, "usertrust.config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				budget: 50_000,
				tigerbeetle: {
					addresses: [`127.0.0.1:${await closedPort()}`],
					connectTimeoutMs: 400,
				},
			}),
			"utf-8",
		);
		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir,
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				requestTimeoutMs: 10_000,
				// The default, and the whole point of this suite. Do not set dryRun here.
				dryRun: false,
				tenants: [{ id: "real", keyHash: hashKey(KEY), budget: 50_000, configPath }],
			},
		});
		const { port } = await server.listen();

		const startedAt = Date.now();
		const res = await fetch(`http://127.0.0.1:${port}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				estimatedInputTokens: 200,
				maxOutputTokens: 100,
				actor: "integration-test",
			}),
		});
		const elapsedMs = Date.now() - startedAt;

		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string; reason: string };
		// Name the failing dependency. "internal error" would send the operator
		// looking for a bug in the server.
		expect(body.error).toBe("ledger_unavailable");
		expect(body.reason).toMatch(/TigerBeetle/i);
		expect(elapsedMs).toBeLessThan(10_000);
	}, 20_000);

	it("does not shadow a ledger outage into a 200 would_deny under evaluate_only", async () => {
		// evaluate_only reports what enforcement WOULD have decided. An outage is not
		// a decision, and reporting one as `would_deny` tells an operator their policy
		// is working at the exact moment their ledger is unreachable.
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-default-shadow-"));
		const configPath = join(stateDir, "usertrust.config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				budget: 50_000,
				tigerbeetle: {
					addresses: [`127.0.0.1:${await closedPort()}`],
					connectTimeoutMs: 400,
				},
			}),
			"utf-8",
		);
		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir,
				enforcement: "evaluate_only",
				pendingTtlMs: 300_000,
				requestTimeoutMs: 10_000,
				dryRun: false,
				tenants: [{ id: "real", keyHash: hashKey(KEY), budget: 50_000, configPath }],
			},
		});
		const { port } = await server.listen();
		const res = await fetch(`http://127.0.0.1:${port}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ model: "claude-sonnet-4-6", actor: "integration-test" }),
		});
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string; shadow?: boolean };
		expect(body.shadow).toBeUndefined();
		expect(body.error).toBe("ledger_unavailable");
	}, 20_000);
});
