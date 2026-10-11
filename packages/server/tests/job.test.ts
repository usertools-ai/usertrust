// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `job`: every record a hold produces carries the job it was authorized for, the usage
 * window it covers, and nothing a later request says.
 *
 * Read back from `events.jsonl` (the positive control): a server that ACCEPTS the fields
 * and drops them would still answer 200, so the only honest check is the chain itself.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedgerEvents } from "usertrust";
import { afterEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";

const KEY = "ut_job_key";
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 10, maxOutputTokens: 10 };
const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-01-01T00:00:05.000Z";

let server: UsertrustServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

async function start(): Promise<{ base: string; stateDir: string }> {
	const stateDir = await mkdtemp(join(tmpdir(), "utsrv-job-"));
	server = createUsertrustServer({
		config: {
			host: "127.0.0.1",
			port: 0,
			stateDir,
			enforcement: "enforce",
			pendingTtlMs: 300_000,
			dryRun: true,
			tenants: [{ id: "acme", keyHash: hashKey(KEY), budget: 1_000_000 }],
		},
	});
	const { port } = await server.listen();
	return { base: `http://127.0.0.1:${port}`, stateDir };
}

async function post(base: string, path: string, body: unknown) {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function chain(stateDir: string) {
	await server?.close();
	server = undefined;
	return readLedgerEvents(join(stateDir, "acme", ".usertrust")) as Array<{
		kind: string;
		data: Record<string, unknown>;
	}>;
}

describe("the `job` capability", () => {
	it("is advertised on /v1/health", async () => {
		const { base } = await start();
		const health = (await (await fetch(`${base}/v1/health`)).json()) as { capabilities: string[] };
		expect(health.capabilities).toContain("job");
	});
});

describe("test 8 — the vault record carries job, usageFrom and usageTo", () => {
	it("a settled call: job + usageFrom from the authorize, usageTo from the settle", async () => {
		const { base, stateDir } = await start();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, job: "job-a", usageFrom: FROM });
		const transferId = auth.json.transferId as string;
		const settled = await post(base, "/v1/settle", {
			transferId,
			job: "job-a",
			usageTo: TO,
			inputTokens: 5,
			outputTokens: 5,
		});
		expect(settled.status).toBe(200);
		const rec = (await chain(stateDir)).find((e) => e.data.transferId === transferId);
		expect(rec?.kind).toBe("llm_call");
		expect(rec?.data).toMatchObject({ job: "job-a", usageFrom: FROM, usageTo: TO });
	});

	it("a released hold inherits the hold's job and usageFrom (release takes no new input)", async () => {
		const { base, stateDir } = await start();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, job: "job-a", usageFrom: FROM });
		const transferId = auth.json.transferId as string;
		expect((await post(base, "/v1/release", { transferId, reason: "no usage" })).status).toBe(200);
		const rec = (await chain(stateDir)).find((e) => e.data.transferId === transferId);
		expect(rec?.kind).toBe("hold_released");
		expect(rec?.data).toMatchObject({ job: "job-a", usageFrom: FROM });
		expect(rec?.data).not.toHaveProperty("usageTo");
	});

	it("an aborted hold carries them too", async () => {
		const { base, stateDir } = await start();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, job: "job-a", usageFrom: FROM });
		const transferId = auth.json.transferId as string;
		await post(base, "/v1/abort", { transferId, error: "boom" });
		const rec = (await chain(stateDir)).find((e) => e.data.transferId === transferId);
		expect(rec?.kind).toBe("llm_call_failed");
		expect(rec?.data).toMatchObject({ job: "job-a", usageFrom: FROM });
	});

	it('jobState: "invalid" is recorded with no job', async () => {
		const { base, stateDir } = await start();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, jobState: "invalid" });
		const transferId = auth.json.transferId as string;
		await post(base, "/v1/settle", { transferId, inputTokens: 1, outputTokens: 1 });
		const rec = (await chain(stateDir)).find((e) => e.data.transferId === transferId);
		expect(rec?.data).toMatchObject({ jobState: "invalid" });
		expect(rec?.data).not.toHaveProperty("job");
	});

	it("test 7 (server side): an unlabelled call's records carry none of the keys", async () => {
		const { base, stateDir } = await start();
		const auth = await post(base, "/v1/authorize", AUTHORIZE);
		const transferId = auth.json.transferId as string;
		await post(base, "/v1/settle", { transferId, inputTokens: 1, outputTokens: 1 });
		const rec = (await chain(stateDir)).find((e) => e.data.transferId === transferId);
		for (const key of ["job", "jobState", "usageFrom", "usageTo"]) {
			expect(rec?.data).not.toHaveProperty(key);
		}
	});
});

describe("the authorize capture is the only source", () => {
	it("a settle naming a different job is a 400, writes nothing, and the hold stays settleable", async () => {
		const { base, stateDir } = await start();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, job: "job-a" });
		const transferId = auth.json.transferId as string;
		const bad = await post(base, "/v1/settle", { transferId, job: "job-b", inputTokens: 1 });
		expect(bad.status).toBe(400);
		const none = await post(base, "/v1/settle", { transferId, jobState: "invalid" });
		expect(none.status).toBe(400);
		const ok = await post(base, "/v1/settle", { transferId, job: "job-a", inputTokens: 1 });
		expect(ok.status).toBe(200);
		const recs = (await chain(stateDir)).filter((e) => e.data.transferId === transferId);
		expect(recs.map((e) => e.kind)).toEqual(["llm_call"]);
		expect(recs[0]?.data.job).toBe("job-a");
	});

	it("a settle naming a job on a hold authorized with none is a 400", async () => {
		const { base } = await start();
		const auth = await post(base, "/v1/authorize", AUTHORIZE);
		const bad = await post(base, "/v1/settle", {
			transferId: auth.json.transferId,
			job: "job-a",
			inputTokens: 1,
		});
		expect(bad.status).toBe(400);
	});

	it("a settle that includes usageFrom is refused and writes nothing", async () => {
		const { base, stateDir } = await start();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, job: "job-a", usageFrom: FROM });
		const transferId = auth.json.transferId as string;
		const bad = await post(base, "/v1/settle", {
			transferId,
			usageFrom: "2026-01-01T00:00:01.000Z",
			usageTo: TO,
			inputTokens: 1,
		});
		expect(bad.status).toBe(400);
		await post(base, "/v1/settle", { transferId, usageTo: TO, inputTokens: 1 });
		const recs = (await chain(stateDir)).filter((e) => e.data.transferId === transferId);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.data.usageFrom).toBe(FROM);
	});

	it("a usageTo before the hold's usageFrom is a 400", async () => {
		const { base } = await start();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, usageFrom: TO });
		const bad = await post(base, "/v1/settle", {
			transferId: auth.json.transferId,
			usageTo: FROM,
			inputTokens: 1,
		});
		expect(bad.status).toBe(400);
	});
});

describe("release carries a structured class, never inferred from the reason", () => {
	it("is recorded verbatim on hold_released; an unknown class is a 400", async () => {
		const { base, stateDir } = await start();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, job: "job-a", usageFrom: FROM });
		const transferId = auth.json.transferId as string;
		const bad = await post(base, "/v1/release", { transferId, releaseClass: "because" });
		expect(bad.status).toBe(400);
		const ok = await post(base, "/v1/release", {
			transferId,
			reason: "session ended with unsettled hold",
			releaseClass: "call-unconfirmed",
		});
		expect(ok.status).toBe(200);
		const rec = (await chain(stateDir)).find((e) => e.data.transferId === transferId);
		expect(rec?.data).toMatchObject({ releaseClass: "call-unconfirmed", job: "job-a" });
	});
	it("a release stating none records none (an expiry or an older client proves nothing)", async () => {
		const { base, stateDir } = await start();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, job: "job-a", usageFrom: FROM });
		const transferId = auth.json.transferId as string;
		await post(base, "/v1/release", { transferId, reason: "unused" });
		const rec = (await chain(stateDir)).find((e) => e.data.transferId === transferId);
		expect(rec?.data).not.toHaveProperty("releaseClass");
	});
});

describe("validation", () => {
	it.each([
		["a job with a space", { job: "job a" }],
		["an empty job", { job: "" }],
		["a non-UTC usageFrom", { usageFrom: "2026-01-01T00:00:00+02:00" }],
		["a date-only usageFrom", { usageFrom: "2026-01-01" }],
		["a usageFrom finer than a millisecond", { usageFrom: "2026-01-01T00:00:00.000000009Z" }],
		["an impossible date", { usageFrom: "2026-02-31T00:00:00.000Z" }],
		["a jobState other than invalid", { jobState: "valid" }],
		["a job together with jobState", { job: "job-a", jobState: "invalid" }],
	])("authorize refuses %s", async (_name, extra) => {
		const { base } = await start();
		const res = await post(base, "/v1/authorize", { ...AUTHORIZE, ...extra });
		expect(res.status).toBe(400);
	});
});
