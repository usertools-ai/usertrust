// The hooks against the job log: which job each authorize and settle names, and when
// the usage happened. A fake server records the wire; one test uses a REAL
// usertrust-server and reads the chain back.
//
// Job ids are opaque (`job-a`, `job-b`). Each test names the mutant it kills.

import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costFromRates, getModelRates, readLedgerEvents } from "usertrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashKey } from "../../server/src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../../server/src/server.js";
import { runHook } from "./helpers/run-hook.js";

// Every test here spawns hook processes (some several): a loaded machine needs more than
// the 5 s default, and a timeout is not what these tests are about.
vi.setConfig({ testTimeout: 30_000 });

const HOOKS = join(import.meta.dirname, "..", "hooks");
const SESSION = "11111111-2222-4333-8444-555555555555";
const MODEL = "claude-sonnet-4-6";

let stateDir: string;
let projectDir: string;
let transcript: string;
let fake: Server | undefined;
let real: UsertrustServer | undefined;
let port: number;
let capabilities: string[];
let requests: Array<{ path: string; body: Record<string, unknown>; status: number }>;
let nextTransfer = 0;
/** Replace the fake's answer to one path (default: the ok responder). */
let override:
	| ((path: string, body: Record<string, unknown>) => { status: number; json: unknown } | undefined)
	| undefined;

function startFake(forwardTo?: { url: string; key: string }, listenOn = 0): Promise<void> {
	return new Promise((resolve) => {
		fake = createServer((req, res) => {
			if (req.method === "GET" && req.url === "/v1/health") {
				void (async () => {
					const json =
						forwardTo === undefined
							? { status: "ok", capabilities }
							: await (await fetch(`${forwardTo.url}/v1/health`)).json();
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify(json));
				})();
				return;
			}
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", async () => {
				const path = req.url ?? "";
				const body = JSON.parse(raw || "{}") as Record<string, unknown>;
				let out: { status: number; json: unknown };
				const forced = override?.(path, body);
				if (forced !== undefined) out = forced;
				else if (forwardTo !== undefined) {
					const r = await fetch(`${forwardTo.url}${path}`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${forwardTo.key}`,
						},
						body: raw,
					});
					out = { status: r.status, json: await r.json() };
				} else if (path === "/v1/authorize") {
					nextTransfer += 1;
					out = { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
				} else out = { status: 200, json: { settled: true, aborted: true } };
				requests.push({ path, body, status: out.status });
				res.writeHead(out.status, { "content-type": "application/json" });
				res.end(JSON.stringify(out.json));
			});
		});
		fake.listen(listenOn, "127.0.0.1", () => {
			const a = fake?.address();
			port = typeof a === "object" && a !== null ? a.port : 0;
			resolve();
		});
	});
}

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-jh-state-"));
	projectDir = await mkdtemp(join(tmpdir(), "utcc-jh-proj-"));
	transcript = join(projectDir, `${SESSION}.jsonl`);
	requests = [];
	nextTransfer = 0;
	capabilities = ["job", "principal", "release"];
	override = undefined;
	// Entries older than the state's first run are never posted: back-date it so the
	// synthetic transcript's timeline (all in the past) is eligible.
	await mkdir(join(stateDir, "transcripts"), { recursive: true, mode: 0o700 });
	await writeFile(join(stateDir, "transcripts", "since"), "2000-01-01T00:00:00.000Z");
});
afterEach(async () => {
	fake?.closeAllConnections();
	fake?.close();
	fake = undefined;
	await real?.close();
	real = undefined;
});

const run = (name: string, input: Record<string, unknown>, env: Record<string, string> = {}) =>
	runHook(join(HOOKS, name), input, {
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_URL: `http://127.0.0.1:${port}`,
		UT_SERVER_KEY: "k",
		...env,
	});

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.now();
const at = (offsetS: number) => NOW + offsetS * 1000;

const logLine = (ts: number, op: string, job: string | null) =>
	`${JSON.stringify({ sid: SESSION, ts: iso(ts), op, job })}\n`;
async function writeLog(...lines: string[]) {
	await mkdir(join(stateDir, "jobs"), { recursive: true });
	await writeFile(join(stateDir, "jobs", `${SESSION}.jsonl`), lines.join(""));
}
async function appendLog(line: string) {
	const p = join(stateDir, "jobs", `${SESSION}.jsonl`);
	await writeFile(p, (await readFile(p, "utf-8")) + line);
}

function message(id: string, tsMs: number, input: number, output: number): string {
	const usage = {
		input_tokens: input,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		output_tokens: output,
	};
	return JSON.stringify({
		type: "assistant",
		sessionId: SESSION,
		uuid: `${id}-final`,
		timestamp: iso(tsMs),
		message: {
			id,
			model: MODEL,
			role: "assistant",
			type: "message",
			stop_reason: "end_turn",
			content: [{ type: "text", text: "x" }],
			usage,
		},
	});
}
async function writeTranscript(lines: string[]) {
	await writeFile(transcript, `${lines.join("\n")}\n`);
}

const base = () => ({ session_id: SESSION, transcript_path: transcript });
const pre = (id: string) => ({
	...base(),
	tool_name: "Bash",
	tool_use_id: id,
	tool_input: { command: "ls" },
});
const post = (id: string) => ({ ...base(), tool_use_id: id, tool_response: "eight ch" });
const of = (path: string) => requests.filter((r) => r.path === path);
const JOB_KEYS = ["job", "jobState", "usageFrom", "usageTo"];

describe("test 1 — the switching call bills the previous job, and a settle keeps its hold's job", () => {
	it("authorize, settle and the NEXT call's authorize", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		// The CLI runs as this very call's tool: job-b starts AFTER the hold exists.
		await appendLog(logLine(Date.now() + 5, "start", "job-b"));
		await new Promise((r) => setTimeout(r, 30));
		await run("post-tool-use.mjs", post("tu_1"), env);
		await run("pre-tool-use.mjs", pre("tu_2"), env);
		await run("post-tool-use.mjs", post("tu_2"), env);

		const auths = of("/v1/authorize").map((r) => r.body);
		const settles = of("/v1/settle").map((r) => r.body);
		expect(auths.map((b) => b.job)).toEqual(["job-a", "job-b"]);
		expect(settles.map((b) => b.job)).toEqual(["job-a", "job-b"]); // mutant: resolve at settle time → b, b
		for (const b of auths) expect(typeof b.usageFrom).toBe("string");
		for (const b of settles) {
			expect(typeof b.usageTo).toBe("string");
			expect(b).not.toHaveProperty("usageFrom"); // the capture is the only "from"
		}
	});
});

describe("test 7 — capability off: no job key anywhere", () => {
	it("an older server gets exactly today's bodies, even with an open job", async () => {
		capabilities = ["principal", "release"];
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		await run("post-tool-use.mjs", post("tu_1"), env);
		expect(requests).toHaveLength(2);
		for (const r of requests) for (const k of JOB_KEYS) expect(r.body).not.toHaveProperty(k);
		// ...and nothing was remembered about a server that never offered it.
		expect(await readdir(join(stateDir, "jobs"))).toEqual([`${SESSION}.jsonl`]);
	});
	it("no log at all: no job key, even with the capability", async () => {
		await startFake();
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		await run("post-tool-use.mjs", post("tu_1"), env);
		for (const r of requests)
			for (const k of ["job", "jobState"]) expect(r.body).not.toHaveProperty(k);
	});
});

describe("test 3 (wire) — an invalid log sends jobState invalid and no job", () => {
	it("is on the authorize and the settle", async () => {
		await startFake();
		await writeLog("garbage\n", logLine(at(-40), "start", "job-a"));
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		await run("post-tool-use.mjs", post("tu_1"), env);
		for (const r of requests) {
			expect(r.body.jobState).toBe("invalid");
			expect(r.body).not.toHaveProperty("job");
		}
	});
});

describe("test 9 — the capability bit is remembered only for the job, and a probe that answers wins", () => {
	it("a failed probe uses the remembered bit; an answering probe overwrites it", async () => {
		const env = { UT_CC_USAGE: "estimate" };
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		// 1. Probe answers with job: remembered.
		await startFake();
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		expect(of("/v1/authorize")[0]?.body.job).toBe("job-a");
		// 2. Probe FAILS (503): the remembered bit is used — attribution survives one bad probe.
		capabilities = [];
		const health = fake;
		fake = undefined;
		health?.closeAllConnections();
		health?.close();
		requests = [];
		fake = createServer((req, res) => {
			if (req.method === "GET") {
				res.writeHead(503);
				res.end();
				return;
			}
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", () => {
				requests.push({ path: req.url ?? "", body: JSON.parse(raw || "{}"), status: 200 });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ transferId: "tx_9", estimatedCost: 1 }));
			});
		});
		await new Promise<void>((r) => fake?.listen(port, "127.0.0.1", () => r()));
		await run("pre-tool-use.mjs", pre("tu_2"), env);
		expect(of("/v1/authorize")[0]?.body.job).toBe("job-a");
		// 3. The server is downgraded and ANSWERS without job: the bit is overwritten.
		fake.closeAllConnections();
		fake.close();
		fake = undefined;
		capabilities = [];
		await startFake(undefined, port);
		await run("pre-tool-use.mjs", pre("tu_3"), env);
		expect(of("/v1/authorize").at(-1)?.body).not.toHaveProperty("job");
		const remembered = JSON.parse(
			await readFile(join(stateDir, "jobs", "capability.json"), "utf-8"),
		);
		expect(Object.values(remembered)).toEqual([false]);
	});
	it("the idempotency and release capabilities are never remembered", async () => {
		await startFake();
		await run("pre-tool-use.mjs", pre("tu_1"), { UT_CC_USAGE: "estimate" });
		const files = await readdir(join(stateDir, "jobs")).catch(() => []);
		expect(files.every((f) => f === "capability.json")).toBe(true);
		const text = await readFile(join(stateDir, "jobs", "capability.json"), "utf-8").catch(() => "");
		expect(text).not.toContain("release");
		expect(text).not.toContain("idempotency");
	});
});

describe("test 2 — a remainder spanning a switch settles once per job", () => {
	const A = { model: MODEL, m1: [100, 50], m2: [200, 80], m3: [300, 120] } as const;

	async function layout() {
		await writeLog(
			logLine(at(-60), "session-start", null),
			logLine(at(-50), "start", "job-a"),
			logLine(at(-20), "start", "job-b"),
		);
		await writeTranscript([
			message("m1", at(-40), ...(A.m1 as [number, number])),
			message("m2", at(-30), ...(A.m2 as [number, number])),
			message("m3", at(-10), ...(A.m3 as [number, number])),
		]);
	}

	it("two settles, tokens split exactly per class, UT within the split bound", async () => {
		await startFake();
		await layout();
		await run("stop.mjs", base());
		const auths = of("/v1/authorize").map((r) => r.body);
		const settles = of("/v1/settle").map((r) => r.body);
		expect(auths.map((b) => b.job)).toEqual(["job-a", "job-b"]); // mutant: one settle, the settle-time job
		expect(settles.map((b) => [b.job, b.inputTokens, b.outputTokens])).toEqual([
			["job-a", 300, 130],
			["job-b", 300, 120],
		]);
		// usage times come from the messages, never from the append time
		expect(auths[0]?.usageFrom).toBe(iso(at(-40)));
		expect(settles[0]?.usageTo).toBe(iso(at(-30)));
		expect(auths[1]?.usageFrom).toBe(iso(at(-10)));
		expect(settles[1]?.usageTo).toBe(iso(at(-10)));
		const rates = getModelRates(MODEL);
		const unsplit = costFromRates(rates, 600, 250, 0, 0);
		const split = costFromRates(rates, 300, 130, 0, 0) + costFromRates(rates, 300, 120, 0, 0);
		expect(split - unsplit).toBeGreaterThanOrEqual(0);
		expect(split - unsplit).toBeLessThanOrEqual(1); // N - 1 with N = 2
	});

	it("a per-call hold never takes a message from before the switch (split, not a 400)", async () => {
		await startFake();
		await layout();
		// This call happens now: job-b is open. m1 and m2 are job-a's; only m3 may ride it.
		await run("pre-tool-use.mjs", pre("tu_1"));
		const hold = of("/v1/authorize")[0]?.body;
		expect(hold?.job).toBe("job-b");
		expect((hold as { params: { messages: number } }).params.messages).toBe(1); // mutant: no eligibility filter → 3
		await run("post-tool-use.mjs", post("tu_1"));
		await run("stop.mjs", base());
		const settles = of("/v1/settle").map((r) => r.body);
		expect(settles.map((b) => [b.job, b.inputTokens, b.outputTokens])).toEqual([
			["job-b", 300, 120],
			["job-a", 300, 130],
		]);
		// Σ tokens unchanged: nothing lost, nothing counted twice.
		const sum = (k: string) => settles.reduce((n, b) => n + (b[k] as number), 0);
		expect([sum("inputTokens"), sum("outputTokens")]).toEqual([600, 250]);
		expect(settles.every((b) => !("usageFrom" in b))).toBe(true);
	});
});

describe("test 8 (plugin → vault) and the G2(c) guard, against a REAL usertrust-server", () => {
	const KEY = "ut_jobhooks_key";
	async function realServer() {
		const stateRoot = await mkdtemp(join(tmpdir(), "utcc-jh-srv-"));
		real = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir: stateRoot,
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				dryRun: true,
				tenants: [{ id: "t", keyHash: hashKey(KEY), budget: 10_000_000 }],
			},
		});
		const { port: realPort } = await real.listen();
		await startFake({ url: `http://127.0.0.1:${realPort}`, key: KEY });
		return stateRoot;
	}
	const chain = async (root: string) => {
		await real?.close();
		real = undefined;
		return readLedgerEvents(join(root, "t", ".usertrust")) as Array<{
			kind: string;
			data: Record<string, unknown>;
		}>;
	};

	it("the chain carries job, usageFrom and usageTo for a hold's settle and a remainder", async () => {
		const root = await realServer();
		await writeLog(
			logLine(at(-60), "session-start", null),
			logLine(at(-50), "start", "job-a"),
			logLine(at(-20), "start", "job-b"),
		);
		await writeTranscript([message("m1", at(-40), 100, 50), message("m3", at(-10), 300, 120)]);
		await run("stop.mjs", base());
		const calls = (await chain(root)).filter((e) => e.kind === "llm_call");
		expect(calls.map((e) => e.data.job).sort()).toEqual(["job-a", "job-b"]);
		const a = calls.find((e) => e.data.job === "job-a")?.data;
		expect(a).toMatchObject({ usageFrom: iso(at(-40)), usageTo: iso(at(-40)) });
	});

	it("a forced mismatch is a 400; the usage still arrives under the RIGHT job, once", async () => {
		const root = await realServer();
		await writeLog(logLine(at(-60), "session-start", null), logLine(at(-50), "start", "job-a"));
		await writeTranscript([message("m1", at(-40), 100, 50)]);
		await run("pre-tool-use.mjs", pre("tu_1"));
		// Tamper with the recorded hold's job, as only a bug could.
		const holdFile = (await readdir(stateDir)).find(
			(n) => n.endsWith(".json") && n.includes("tu_1"),
		);
		expect(holdFile).toBeDefined();
		const holdPath = join(stateDir, holdFile as string);
		const hold = JSON.parse(await readFile(holdPath, "utf-8"));
		await writeFile(holdPath, JSON.stringify({ ...hold, job: "job-x" }));
		await run("post-tool-use.mjs", post("tu_1"));
		expect(of("/v1/settle").map((r) => r.status)).toContain(400);
		await run("stop.mjs", base());
		const events = await chain(root);
		const calls = events.filter((e) => e.kind === "llm_call");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.data).toMatchObject({ job: "job-a", usageFrom: iso(at(-40)) });
		expect(events.some((e) => e.data.job === "job-x")).toBe(false);
	});
});

describe("test 10 — a refused remainder names its job and tokens", () => {
	it("a 402 on a job's remainder is a would_block record, not a silent drop", async () => {
		await startFake();
		override = (path) =>
			path === "/v1/authorize"
				? { status: 402, json: { error: "budget_exceeded", reason: "need 9, have 1" } }
				: undefined;
		await writeLog(logLine(at(-60), "session-start", null), logLine(at(-50), "start", "job-a"));
		await writeTranscript([message("m1", at(-40), 100, 50)]);
		await run("stop.mjs", base());
		const events = (await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const wb = events.find((e) => e.kind === "would_block");
		expect(wb).toMatchObject({
			job: "job-a",
			status: 402,
			tokens: { inputTokens: 100, outputTokens: 50 },
		});
	});
});
