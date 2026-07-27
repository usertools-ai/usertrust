import { mkdtemp } from "node:fs/promises";
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
			}),
		});
		expect(settleRes.status).toBe(200);
		const receipt = (await settleRes.json()) as {
			settled: boolean;
			auditHash: string;
			transferId: string;
		};
		expect(receipt.settled).toBe(true);
		expect(receipt.transferId).toBe(auth.transferId);
		expect(receipt.auditHash).toMatch(/^[0-9a-f]{16,}$/);
	});
});
