// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `job-type`: which KIND of work a job was (`jobType`) and who declared it (`typeSource`).
 *
 * A server that accepts the fields and drops them would still answer 200, so the chain is read
 * back (the positive control). The settle side is only ever a CHECK against the hold's own
 * authorize capture, taken before the claim. Each group names the mutant it kills.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedgerEvents } from "usertrust";
import { afterEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";
import { AuthorizeRequestSchema, SettleRequestSchema } from "../src/wire.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const KEY = "ut_jobtype_key";
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 10, maxOutputTokens: 10 };
const TYPED = { job: "job-a", jobType: "bugfix", typeSource: "agent" } as const;
const TYPE_KEYS = ["jobType", "typeSource"] as const;
const MISMATCH = "settle job type differs from the hold's";

let server: UsertrustServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

const tenantConfig = (stateDir: string) => ({
	host: "127.0.0.1",
	port: 0,
	stateDir,
	enforcement: "enforce" as const,
	pendingTtlMs: 300_000,
	dryRun: true,
	tenants: [{ id: "acme", keyHash: hashKey(KEY), budget: 1_000_000 }],
});

async function start(): Promise<{ base: string; stateDir: string }> {
	const stateDir = await mkdtemp(join(tmpdir(), "utsrv-jobtype-"));
	server = createUsertrustServer({ config: tenantConfig(stateDir) });
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

describe("the `job-type` capability", () => {
	// Kills: a server that accepts the fields but does not list the capability, which leaves a
	// plugin unable to know it may send them (an older server strips them in silence).
	it("is advertised on /v1/health, beside `job`", async () => {
		const { base } = await start();
		const health = (await (await fetch(`${base}/v1/health`)).json()) as { capabilities: string[] };
		expect(health.capabilities).toContain("job-type");
		expect(health.capabilities).toContain("job");
		expect(health.capabilities.indexOf("job-type")).toBeGreaterThan(
			health.capabilities.indexOf("job"),
		);
	});
});

describe("authorize wire validation", () => {
	// Kills: dropping any refinement, or accepting a value outside the closed lists.
	it.each([
		["an unknown type", { job: "job-a", jobType: "chore" }, /JobType|jobType|Invalid option/i],
		["a differently-cased type", { job: "job-a", jobType: "Bugfix" }, /jobType|Invalid option/i],
		["an empty type", { job: "job-a", jobType: "" }, /jobType|Invalid option/i],
		["a numeric type", { job: "job-a", jobType: 7 }, /jobType|Invalid option/i],
		[
			"an unknown source",
			{ job: "job-a", jobType: "bugfix", typeSource: "inferred" },
			/typeSource|Invalid option/i,
		],
		["a type with no job", { jobType: "bugfix" }, /jobType requires a job/],
		[
			"a source with no type",
			{ job: "job-a", typeSource: "agent" },
			/typeSource requires a jobType/,
		],
		["a source with no job and no type", { typeSource: "agent" }, /typeSource requires a jobType/],
		[
			"a type with jobState invalid",
			{ jobState: "invalid", jobType: "bugfix" },
			/jobType requires a job/,
		],
		[
			"a type and source with jobState invalid",
			{ jobState: "invalid", jobType: "bugfix", typeSource: "agent" },
			/jobType requires a job/,
		],
	])("refuses %s", async (_name, extra, message) => {
		const parsed = AuthorizeRequestSchema.safeParse({ ...AUTHORIZE, ...extra });
		expect(parsed.success).toBe(false);
		if (!parsed.success)
			expect(parsed.error.issues.map((i) => i.message).join("; ")).toMatch(message);
		// …and the HTTP surface answers it as a 400 with no hold made.
		const { base } = await start();
		const res = await post(base, "/v1/authorize", { ...AUTHORIZE, ...extra });
		expect(res.status).toBe(400);
		await server?.close();
		server = undefined;
	});

	it("accepts a type with a job, with or without a source, and nothing else is changed", () => {
		const typed = AuthorizeRequestSchema.parse({ ...AUTHORIZE, ...TYPED });
		expect(typed).toMatchObject(TYPED);
		const sourceless = AuthorizeRequestSchema.parse({
			...AUTHORIZE,
			job: "job-a",
			jobType: "docs",
		});
		expect(sourceless.jobType).toBe("docs");
		expect(sourceless).not.toHaveProperty("typeSource");
		for (const t of ["feature", "bugfix", "review", "test", "docs", "ops", "research", "other"]) {
			expect(
				AuthorizeRequestSchema.safeParse({ ...AUTHORIZE, job: "j", jobType: t }).success,
				t,
			).toBe(true);
		}
		for (const s of ["explicit", "agent"]) {
			expect(
				AuthorizeRequestSchema.safeParse({ ...AUTHORIZE, job: "j", jobType: "docs", typeSource: s })
					.success,
				s,
			).toBe(true);
		}
	});

	// Kills: `.strict()` on the top-level schema, which would turn every request an older
	// client sends with an extra key into a 400. Top-level keys are STRIPPED, as before.
	it("an unknown top-level key is still stripped, not refused", () => {
		const parsed = AuthorizeRequestSchema.safeParse({ ...AUTHORIZE, ...TYPED, somethingNew: 1 });
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data).not.toHaveProperty("somethingNew");
		const settle = SettleRequestSchema.safeParse({ transferId: "tx_1", somethingNew: 1 });
		expect(settle.success).toBe(true);
	});

	it("an untyped request parses exactly as before: no type key appears", () => {
		for (const body of [
			AUTHORIZE,
			{ ...AUTHORIZE, job: "job-a" },
			{ ...AUTHORIZE, jobState: "invalid" },
		]) {
			const parsed = AuthorizeRequestSchema.parse(body);
			for (const key of TYPE_KEYS) expect(parsed, key).not.toHaveProperty(key);
		}
	});
});

describe("settle echo wire validation", () => {
	it("accepts either field alone, without a job, and refuses a value outside the lists", () => {
		expect(SettleRequestSchema.safeParse({ transferId: "t", jobType: "bugfix" }).success).toBe(
			true,
		);
		expect(SettleRequestSchema.safeParse({ transferId: "t", typeSource: "agent" }).success).toBe(
			true,
		);
		expect(SettleRequestSchema.safeParse({ transferId: "t", jobType: "chore" }).success).toBe(
			false,
		);
		expect(SettleRequestSchema.safeParse({ transferId: "t", typeSource: "inferred" }).success).toBe(
			false,
		);
	});
});

describe("the vault record carries jobType and typeSource", () => {
	it("a settled call carries both from the authorize; the settle's echo changes nothing", async () => {
		const { base, stateDir } = await start();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, ...TYPED });
		expect(auth.status).toBe(200);
		const transferId = auth.json.transferId as string;
		const settled = await post(base, "/v1/settle", {
			transferId,
			...TYPED,
			inputTokens: 5,
			outputTokens: 5,
		});
		expect(settled.status).toBe(200);
		const rec = (await chain(stateDir)).find((e) => e.data.transferId === transferId);
		expect(rec?.kind).toBe("llm_call");
		expect(rec?.data).toMatchObject(TYPED);
	});

	it("a released hold, an aborted hold and a hold given back carry them without any new input", async () => {
		const { base, stateDir } = await start();
		const ids: Record<string, string> = {};
		for (const name of ["release", "abort"]) {
			const a = await post(base, "/v1/authorize", { ...AUTHORIZE, ...TYPED });
			ids[name] = a.json.transferId as string;
		}
		expect((await post(base, "/v1/release", { transferId: ids.release, reason: "x" })).status).toBe(
			200,
		);
		expect((await post(base, "/v1/abort", { transferId: ids.abort, error: "boom" })).status).toBe(
			200,
		);
		const events = await chain(stateDir);
		const released = events.find((e) => e.data.transferId === ids.release);
		const aborted = events.find((e) => e.data.transferId === ids.abort);
		expect(released?.kind).toBe("hold_released");
		expect(released?.data).toMatchObject(TYPED);
		expect(aborted?.kind).toBe("llm_call_failed");
		expect(aborted?.data).toMatchObject(TYPED);
	});

	it("a type without a source records no source key", async () => {
		const { base, stateDir } = await start();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, job: "job-a", jobType: "docs" });
		const transferId = auth.json.transferId as string;
		await post(base, "/v1/settle", { transferId, inputTokens: 1, outputTokens: 1 });
		const rec = (await chain(stateDir)).find((e) => e.data.transferId === transferId);
		expect(rec?.data).toMatchObject({ job: "job-a", jobType: "docs" });
		expect(rec?.data).not.toHaveProperty("typeSource");
	});

	it("untyped, job-only and invalid-state calls record no type key at all", async () => {
		const { base, stateDir } = await start();
		const ids: string[] = [];
		for (const extra of [{}, { job: "job-a" }, { jobState: "invalid" }]) {
			const a = await post(base, "/v1/authorize", { ...AUTHORIZE, ...extra });
			const transferId = a.json.transferId as string;
			ids.push(transferId);
			await post(base, "/v1/settle", { transferId, inputTokens: 1, outputTokens: 1 });
		}
		const events = await chain(stateDir);
		for (const id of ids) {
			const rec = events.find((e) => e.data.transferId === id);
			expect(rec?.kind).toBe("llm_call");
			const text = JSON.stringify(rec?.data);
			for (const key of TYPE_KEYS) expect(text, key).not.toContain(key);
		}
	});
});

describe("settle may echo the type only to be CHECKED against the hold's", () => {
	async function typedHold(extra: Record<string, unknown> = TYPED) {
		const ctx = await start();
		const auth = await post(ctx.base, "/v1/authorize", { ...AUTHORIZE, ...extra });
		return { ...ctx, transferId: auth.json.transferId as string };
	}

	// Kills: a check that runs after the claim (the hold would be consumed by the refusal), a
	// check that is missing, and a reason string that drifts from the one clients match on.
	it("a different jobType is a 400, writes nothing, and the hold stays settleable", async () => {
		const { base, stateDir, transferId } = await typedHold();
		const bad = await post(base, "/v1/settle", { transferId, jobType: "ops", inputTokens: 1 });
		expect(bad.status).toBe(400);
		expect(bad.json.reason).toBe(MISMATCH);
		const ok = await post(base, "/v1/settle", { transferId, jobType: "bugfix", inputTokens: 1 });
		expect(ok.status).toBe(200);
		const recs = (await chain(stateDir)).filter((e) => e.data.transferId === transferId);
		expect(recs.map((e) => e.kind)).toEqual(["llm_call"]);
		expect(recs[0]?.data).toMatchObject(TYPED);
	});

	it("typeSource ALONE is an allowed assertion: a different one is a 400, the same one settles", async () => {
		const { base, transferId } = await typedHold();
		const bad = await post(base, "/v1/settle", {
			transferId,
			typeSource: "explicit",
			inputTokens: 1,
		});
		expect(bad.status).toBe(400);
		expect(bad.json.reason).toBe(MISMATCH);
		const ok = await post(base, "/v1/settle", { transferId, typeSource: "agent", inputTokens: 1 });
		expect(ok.status).toBe(200);
	});

	it("a PARTIAL echo (the type, not the source, and no job) is checked and accepted when it agrees", async () => {
		const { base, stateDir, transferId } = await typedHold();
		const ok = await post(base, "/v1/settle", { transferId, jobType: "bugfix", inputTokens: 1 });
		expect(ok.status).toBe(200);
		const rec = (await chain(stateDir)).find((e) => e.data.transferId === transferId);
		expect(rec?.data).toMatchObject(TYPED);
	});

	it("an echo of one field that agrees does not excuse another that differs", async () => {
		const { base, transferId } = await typedHold();
		const bad = await post(base, "/v1/settle", {
			transferId,
			jobType: "bugfix",
			typeSource: "explicit",
			inputTokens: 1,
		});
		expect(bad.status).toBe(400);
		expect(bad.json.reason).toBe(MISMATCH);
	});

	it("a type on a hold authorized WITHOUT one is a 400, as a job on a jobless hold is", async () => {
		const { base, stateDir, transferId } = await typedHold({ job: "job-a" });
		for (const echo of [{ jobType: "bugfix" }, { typeSource: "agent" }]) {
			const bad = await post(base, "/v1/settle", { transferId, ...echo, inputTokens: 1 });
			expect(bad.status, JSON.stringify(echo)).toBe(400);
			expect(bad.json.reason).toBe(MISMATCH);
		}
		const ok = await post(base, "/v1/settle", { transferId, job: "job-a", inputTokens: 1 });
		expect(ok.status).toBe(200);
		const rec = (await chain(stateDir)).find((e) => e.data.transferId === transferId);
		for (const key of TYPE_KEYS) expect(rec?.data).not.toHaveProperty(key);
	});

	it("the job check still answers first, with its own reason", async () => {
		const { base, transferId } = await typedHold();
		const bad = await post(base, "/v1/settle", { transferId, job: "job-z", jobType: "ops" });
		expect(bad.status).toBe(400);
		expect(bad.json.reason).toBe("settle job differs from the hold's job");
	});

	// Kills: a refusal for an unknown hold (it must keep recording the spend), and a type or
	// attribution invented from the request body onto a record whose hold is gone.
	it("a settle for an unknown hold keeps today's behaviour: usage recorded, no type invented", async () => {
		const { base, stateDir } = await start();
		const without = await post(base, "/v1/settle", {
			transferId: "tx_gone_1",
			inputTokens: 5,
			outputTokens: 5,
		});
		const withEcho = await post(base, "/v1/settle", {
			transferId: "tx_gone_2",
			jobType: "bugfix",
			typeSource: "agent",
			inputTokens: 5,
			outputTokens: 5,
		});
		expect(without.status).toBe(410);
		expect(withEcho.status).toBe(without.status);
		expect(withEcho.json.error).toBe(without.json.error);
		const events = await chain(stateDir);
		const recorded = events.filter((e) => e.kind === "settlement_unrecoverable");
		expect(recorded).toHaveLength(2);
		for (const e of recorded) {
			const text = JSON.stringify(e.data);
			for (const key of TYPE_KEYS) expect(text, `${e.kind} ${key}`).not.toContain(key);
		}
	});
});

describe("what the governor is handed", () => {
	it("a settle for an unknown hold hands the governor no type either", async () => {
		const fake = createFakeGovernor();
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-jobtype-unheld-"));
		server = createUsertrustServer({
			config: tenantConfig(stateDir),
			factory: async () => fake.governor,
		});
		const { port } = await server.listen();
		const res = await post(`http://127.0.0.1:${port}`, "/v1/settle", {
			transferId: "tx_gone",
			...TYPED,
			inputTokens: 5,
		});
		expect(res.status).toBe(410);
		expect(fake.calls.unheld).toHaveLength(1);
		for (const key of ["job", ...TYPE_KEYS]) {
			expect(fake.calls.unheld[0], key).not.toHaveProperty(key);
		}
	});

	async function viaFake() {
		const fake = createFakeGovernor();
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-jobtype-fake-"));
		server = createUsertrustServer({
			config: tenantConfig(stateDir),
			factory: async () => fake.governor,
		});
		const { port } = await server.listen();
		return { base: `http://127.0.0.1:${port}`, fake };
	}

	it("authorize hands the type to the governor; settle's echo fields are stripped out of the usage", async () => {
		const { base, fake } = await viaFake();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, ...TYPED });
		expect(auth.status).toBe(200);
		expect(fake.calls.authorizeParams[0]).toMatchObject(TYPED);
		const settled = await post(base, "/v1/settle", {
			transferId: auth.json.transferId,
			...TYPED,
			jobState: undefined,
			inputTokens: 5,
			outputTokens: 5,
		});
		expect(settled.status).toBe(200);
		const params = fake.calls.settleParams[0] as Record<string, unknown>;
		expect(params).toMatchObject({ inputTokens: 5, outputTokens: 5 });
		for (const key of ["job", "jobState", ...TYPE_KEYS])
			expect(params, key).not.toHaveProperty(key);
	});

	it("a refused echo never reaches the governor's settle", async () => {
		const { base, fake } = await viaFake();
		const auth = await post(base, "/v1/authorize", { ...AUTHORIZE, ...TYPED });
		const bad = await post(base, "/v1/settle", {
			transferId: auth.json.transferId,
			jobType: "ops",
			inputTokens: 5,
		});
		expect(bad.status).toBe(400);
		expect(fake.calls.settled).toEqual([]);
	});
});
