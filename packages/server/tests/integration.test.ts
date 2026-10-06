import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
				pendingTtlMs: 240_000,
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

describe("integration: #204 and #205 through the real governor (dryRun)", () => {
	const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };

	async function realServer(): Promise<{ base: string; stateDir: string }> {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-int-"));
		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir,
				enforcement: "enforce",
				pendingTtlMs: 240_000,
				dryRun: true,
				tenants: [{ id: "real", keyHash: hashKey(KEY), budget: 50_000 }],
			},
		});
		const { port } = await server.listen();
		return { base: `http://127.0.0.1:${port}`, stateDir };
	}

	/** The tenant's own hash chain, as written to disk. */
	function chain(stateDir: string): Array<{ kind: string; data: Record<string, unknown> }> {
		const raw = readFileSync(
			join(stateDir, "real", ".usertrust", "audit", "events.jsonl"),
			"utf-8",
		);
		return raw
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
	}

	async function authorize(base: string, extra: Record<string, unknown> = {}): Promise<Response> {
		return await fetch(`${base}/v1/authorize`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				estimatedInputTokens: 100,
				maxOutputTokens: 50,
				...extra,
			}),
		});
	}

	it("five swept holds are RELEASED: no llm_call_failed, and the breaker stays closed (#204)", async () => {
		// The CONTROL is the bug itself: the sweep used to abort, and the default
		// breaker opens on the fifth consecutive failure, so the sixth authorize
		// below was refused for a tenant whose provider never failed.
		const { base, stateDir } = await realServer();
		for (let i = 0; i < 5; i++) expect((await authorize(base)).status).toBe(200);

		expect(await server?.sweepExpired(Date.now() + 600_000)).toBe(5);

		const kinds = chain(stateDir).map((e) => e.kind);
		expect(kinds.filter((k) => k === "hold_released")).toHaveLength(5);
		expect(kinds).not.toContain("llm_call_failed");
		expect((await authorize(base)).status).toBe(200);
	});

	it("POST /v1/release records hold_released with the reason sanitized", async () => {
		const { base, stateDir } = await realServer();
		const auth = (await (await authorize(base)).json()) as { transferId: string };

		const res = await fetch(`${base}/v1/release`, {
			method: "POST",
			headers,
			body: JSON.stringify({ transferId: auth.transferId, reason: `user cancelled${"\u001b"}[2J` }),
		});

		expect(res.status).toBe(200);
		const released = chain(stateDir).find((e) => e.kind === "hold_released");
		expect(released?.data.transferId).toBe(auth.transferId);
		expect(released?.data.reason).toBe("user cancelled[2J");
	});

	it("a keyed replay answers the same transferId; a late keyed settle is recorded (410)", async () => {
		const { base, stateDir } = await realServer();
		const first = (await (await authorize(base, { idempotencyKey: "call-1" })).json()) as {
			transferId: string;
		};
		const replay = (await (await authorize(base, { idempotencyKey: "call-1" })).json()) as {
			transferId: string;
		};
		expect(replay.transferId).toBe(first.transferId);

		// The client takes longer than the TTL: the sweep releases the hold, and its
		// settle arrives late.
		await server?.sweepExpired(Date.now() + 600_000);
		const late = await fetch(`${base}/v1/settle`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				transferId: first.transferId,
				idempotencyKey: "call-1",
				inputTokens: 80,
				outputTokens: 200,
				principal: { id: "user-42", type: "human" },
			}),
		});

		expect(late.status).toBe(410);
		const record = chain(stateDir).find((e) => e.kind === "settlement_unrecoverable");
		// The scope is the tenant vault's own persisted id, created on its first keyed call.
		const scope = readFileSync(
			join(stateDir, "real", ".usertrust", "idempotency-scope"),
			"utf-8",
		).trim();
		expect(scope).toMatch(/^vault:[0-9a-f-]{36}$/);
		expect(record?.data.idempotencyKeyHash).toBe(
			createHash("sha256").update(`${scope}\u0000call-1`, "utf8").digest("hex"),
		);
		expect(record?.data.principal).toEqual({ id: "user-42", type: "human" });
		expect(record?.data.usage).toEqual({
			inputTokens: 80,
			outputTokens: 200,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		expect(JSON.stringify(chain(stateDir))).not.toContain("call-1");
		const health = (await (await fetch(`${base}/v1/health`)).json()) as {
			settlementsUnrecoverable: number;
		};
		expect(health.settlementsUnrecoverable).toBe(1);
	});
});
