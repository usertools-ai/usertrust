import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedgerEvents } from "usertrust";
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

	it("the real governor records the wire's actor and principal on llm_call", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-int-"));
		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir,
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				dryRun: true,
				tenants: [{ id: "real", keyHash: hashKey(KEY), budget: 50_000 }],
			},
		});
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
		const principal = { id: "a7f3", type: "Explore", unit: "receipts", role: "reviewer" };
		const auth = (await (
			await fetch(`${base}/v1/authorize`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: "claude-sonnet-4-6",
					estimatedInputTokens: 200,
					maxOutputTokens: 100,
					actor: "claude-code:s-1:Explore:a7f3",
					principal,
				}),
			})
		).json()) as { transferId: string };
		const settleRes = await fetch(`${base}/v1/settle`, {
			method: "POST",
			headers,
			body: JSON.stringify({ transferId: auth.transferId, inputTokens: 150, outputTokens: 40 }),
		});
		expect(settleRes.status).toBe(200);
		await server.close();
		server = undefined;

		const events = readLedgerEvents(join(stateDir, "real", ".usertrust"));
		const call = events.find(
			(e) =>
				e.kind === "llm_call" && (e.data as { transferId?: string }).transferId === auth.transferId,
		);
		expect(call).toBeDefined();
		expect(call?.actor).toBe("claude-code:s-1:Explore:a7f3");
		expect(call?.data).toMatchObject({ principal });
	});
});
