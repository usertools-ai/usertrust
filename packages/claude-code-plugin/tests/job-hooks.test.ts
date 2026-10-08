// The hooks against the job log: which job each authorize and settle names, and when
// the usage happened. A fake server records the wire; one test uses a REAL
// usertrust-server and reads the chain back.
//
// Job ids are opaque (`job-a`, `job-b`). Each test names the mutant it kills.

import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
/** How long the fake holds its /v1/health answer: a hook awaiting it is awaiting a probe. */
let healthDelayMs = 0;
/** Replace the fake's answer to one path (default: the ok responder). */
let override:
	| ((path: string, body: Record<string, unknown>) => { status: number; json: unknown } | undefined)
	| undefined;

function startFake(forwardTo?: { url: string; key: string }, listenOn = 0): Promise<void> {
	return new Promise((resolve) => {
		fake = createServer((req, res) => {
			if (req.method === "GET" && req.url === "/v1/health") {
				void (async () => {
					if (healthDelayMs > 0) await new Promise((r) => setTimeout(r, healthDelayMs));
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
	healthDelayMs = 0;
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

describe("a call belongs to the job open when the hook RECEIVED it", () => {
	it("a switch that lands while the hook awaits its health probe does not move the call", async () => {
		await startFake();
		healthDelayMs = 700;
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		const running = run("pre-tool-use.mjs", pre("tu_1"), { UT_CC_USAGE: "estimate" });
		// The CLI lands during the probe: after the call began, before the hook resolves.
		await new Promise((r) => setTimeout(r, 300));
		await appendLog(logLine(Date.now(), "start", "job-b"));
		await running;
		// mutant: the time is read after the awaits → job-b
		expect(of("/v1/authorize")[0]?.body.job).toBe("job-a");
	});
});

describe("an unresolved keyed settle is retried under the job it was authorized with", () => {
	it("the .done journal keeps the labels, and the retry's authorize carries them", async () => {
		capabilities = ["job", "principal", "release", "idempotency-key"];
		await startFake();
		await writeLog(logLine(at(-60), "session-start", null), logLine(at(-50), "start", "job-a"));
		await writeTranscript([message("m1", at(-40), 100, 50)]);
		await run("pre-tool-use.mjs", pre("tu_1"));
		// The settle comes back 503: the charge's fate is unknown, so it stays unresolved.
		override = (path) =>
			path === "/v1/settle" ? { status: 503, json: { error: "down" } } : undefined;
		await run("post-tool-use.mjs", post("tu_1"));
		// The job moves on before the retry.
		await appendLog(logLine(Date.now() + 5, "start", "job-b"));
		await new Promise((r) => setTimeout(r, 30));
		override = undefined;
		await run("stop.mjs", base());
		const retried = of("/v1/authorize")
			.slice(1)
			.map((r) => r.body);
		// mutant: the journal drops the labels → the retry carries no job (or the new one)
		expect(retried.length).toBeGreaterThan(0);
		for (const body of retried) {
			expect(body.job).toBe("job-a");
			expect(body.usageFrom).toBe(iso(at(-40)));
		}
	});
});

describe("the switching call's window stays inside the job it bills", () => {
	it("an estimate hold's usageTo is clamped to the switch, and never before its usageFrom", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		const switchedAt = Date.now() + 5;
		await appendLog(logLine(switchedAt, "start", "job-b"));
		await new Promise((r) => setTimeout(r, 200));
		await run("post-tool-use.mjs", post("tu_1"), env);
		const from = Date.parse(of("/v1/authorize")[0]?.body.usageFrom as string);
		const to = Date.parse(of("/v1/settle")[0]?.body.usageTo as string);
		// mutant: usageTo = now → after the switch, across the boundary into job-b
		expect(to).toBeLessThanOrEqual(switchedAt);
		expect(to).toBeGreaterThanOrEqual(from);
	});
	it("with no switch it is simply now", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		await run("post-tool-use.mjs", post("tu_1"), env);
		const to = Date.parse(of("/v1/settle")[0]?.body.usageTo as string);
		expect(Date.now() - to).toBeLessThan(15_000);
		expect(to).toBeGreaterThan(Date.parse(of("/v1/authorize")[0]?.body.usageFrom as string) - 1);
	});
});

describe("a gap records when the call STARTED", () => {
	it("started is the hook's start, at is later", async () => {
		await startFake();
		healthDelayMs = 400;
		// The server is unreachable for the authorize itself: watch mode records a gap.
		override = (path) =>
			path === "/v1/authorize" ? { status: 503, json: { error: "down" } } : undefined;
		await run("pre-tool-use.mjs", pre("tu_1"), { UT_CC_USAGE: "estimate" });
		const events = (await readFile(join(stateDir, "watch.jsonl"), "utf-8"))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const gap = events.find((e) => e.kind === "gap");
		expect(gap).toBeDefined();
		expect(Date.parse(gap.started)).toBeLessThanOrEqual(Date.parse(gap.at));
		expect(Date.parse(gap.at) - Date.parse(gap.started)).toBeGreaterThanOrEqual(300);
	});
});

describe("a give-back of a hold is classified by what the client KNOWS, and a ran call is a gap", () => {
	const env = { UT_CC_USAGE: "estimate" };
	const watch = async () =>
		(await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	const releases = () => of("/v1/release").map((r) => r.body);

	it("an unanswered settle left `.settling` at Stop: released as call-ran, and written down as a gap", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		override = (path) =>
			path === "/v1/settle" ? { status: 503, json: { error: "down" } } : undefined;
		await run("post-tool-use.mjs", post("tu_1"), env);
		override = undefined;
		await run("stop.mjs", base(), env);
		expect(releases().map((b) => b.releaseClass)).toEqual(["call-ran"]);
		// mutant: the give-back writes no gap
		const gap = (await watch()).find((e) => e.kind === "gap");
		expect(gap).toMatchObject({ releaseClass: "call-ran", session: SESSION });
		expect(gap.started).toBe(of("/v1/authorize")[0]?.body.usageFrom);
	});
	it("a hold still `.json` at Stop in estimate mode (PostToolUse never ran): call-unconfirmed, and a gap", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		await run("stop.mjs", base(), env);
		expect(releases().map((b) => b.releaseClass)).toEqual(["call-unconfirmed"]);
		expect((await watch()).filter((e) => e.kind === "gap")).toHaveLength(1);
	});
	it("a transcript hold with no assigned usage: `unused`, and NO gap (nothing hides behind it)", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		await writeTranscript([]);
		await run("pre-tool-use.mjs", pre("tu_1"));
		await run("post-tool-use.mjs", post("tu_1"));
		expect(releases().map((b) => b.releaseClass)).toEqual(["unused"]);
		expect((await watch()).filter((e) => e.kind === "gap")).toEqual([]);
	});
	it("the free-text reason is not the class: it is unchanged, and the class is its own field", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		await run("stop.mjs", base(), env);
		expect(releases()[0]).toMatchObject({
			reason: "session ended with unsettled hold",
			releaseClass: "call-unconfirmed",
		});
	});
	it("capability off: no releaseClass is sent (an older server would strip it)", async () => {
		capabilities = ["principal", "release"];
		await startFake();
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		await run("stop.mjs", base(), env);
		expect(releases()).toHaveLength(1);
		expect(releases()[0]).not.toHaveProperty("releaseClass");
	});
});

describe("an expired estimate hold's replacement: the call RAN, so every way it fails is a gap", () => {
	const env = { UT_CC_USAGE: "estimate" };
	const gone = { status: 404, json: { error: "not_found", reason: "unknown transferId" } };
	const watch = async () =>
		(await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	const releases = () => of("/v1/release").map((r) => r.body);

	/** pre → the settle of tx_1 answers 404 (the hold expired) → the replacement path runs. */
	async function expired(
		replacement: (
			path: string,
			body: Record<string, unknown>,
		) => { status: number; json: unknown } | undefined,
	) {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		let settles = 0;
		override = (path, body) => {
			if (path === "/v1/settle") {
				settles += 1;
				if (settles === 1) return gone;
			}
			return replacement(path, body);
		};
		await run("post-tool-use.mjs", post("tu_1"), env);
	}

	it("the replacement authorize is refused: a call-ran gap (B-91)", async () => {
		await expired((path) =>
			path === "/v1/authorize" ? { status: 503, json: { error: "down" } } : undefined,
		);
		// mutant: no gap is written
		expect(
			(await watch()).filter((e) => e.kind === "gap" && e.releaseClass === "call-ran"),
		).toHaveLength(1);
	});
	it("the replacement authorize is a shadow: a call-ran gap", async () => {
		await expired((path) =>
			path === "/v1/authorize"
				? { status: 200, json: { shadow: true, shadowId: "shadow_1" } }
				: undefined,
		);
		expect(
			(await watch()).filter((e) => e.kind === "gap" && e.releaseClass === "call-ran"),
		).toHaveLength(1);
	});
	it("the replacement's id is malformed: released as call-ran (not unused), and a gap (B-87)", async () => {
		await expired((path) =>
			path === "/v1/authorize"
				? { status: 200, json: { transferId: "bad id!", estimatedCost: 1 } }
				: undefined,
		);
		expect(releases().map((b) => b.releaseClass)).toEqual(["call-ran"]); // mutant: unused
		expect(
			(await watch()).filter((e) => e.kind === "gap" && e.releaseClass === "call-ran"),
		).toHaveLength(1);
	});
	it("the replacement's record cannot be written: released as call-ran, and a gap", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		// A directory squats on the fresh hold's file name, so its record cannot be written.
		await mkdir(join(stateDir, `${SESSION}__main__tu_1.tx_2.settling`, "x"), { recursive: true });
		let settles = 0;
		override = (path) => {
			if (path === "/v1/settle") {
				settles += 1;
				if (settles === 1) return gone;
			}
			return undefined;
		};
		await run("post-tool-use.mjs", post("tu_1"), env);
		expect(releases().map((b) => b.releaseClass)).toEqual(["call-ran"]);
		expect(
			(await watch()).filter((e) => e.kind === "gap" && e.releaseClass === "call-ran"),
		).toHaveLength(1); // mutant: no gap
	});
	it("a replacement whose settle goes unanswered carries the call's job and start, so Stop's gap is placed by them (B-89)", async () => {
		await expired((path) =>
			path === "/v1/settle" ? { status: 503, json: { error: "down" } } : undefined,
		);
		const startedAt = of("/v1/authorize")[0]?.body.usageFrom;
		override = undefined;
		await appendLog(logLine(Date.now() + 5, "start", "job-b"));
		await new Promise((r) => setTimeout(r, 30));
		await run("stop.mjs", base(), env);
		const gap = (await watch()).find((e) => e.kind === "gap" && e.releaseClass === "call-ran");
		// mutant: the replacement is recorded without the labels → placed by the Stop's time, in job-b
		expect(gap?.started).toBe(startedAt);
	});
});

describe("a resumed call's earlier hold is only ENDED, so an unconfirmed release reads unused (B-103)", () => {
	it("the earlier hold's release gets a 500: at Stop it is given back as unused, with no call-ran gap", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		const env = { UT_CC_USAGE: "estimate", UT_CC_MODE: "enforce" };
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		let releases = 0;
		override = (path) => {
			if (path !== "/v1/release") return undefined;
			releases += 1;
			return releases === 1 ? { status: 500, json: { error: "ledger unavailable" } } : undefined;
		};
		// The deferred call fires PreToolUse again: its earlier hold is claimed, its release fails.
		const resumed = await run("pre-tool-use.mjs", pre("tu_1"), env);
		expect(resumed.code).not.toBe(0);
		// The intent is in the NAME the hold was claimed into: no `.settling` ever existed for it.
		const left = await readdir(stateDir);
		expect(left.some((n) => n.endsWith(".releasing"))).toBe(true);
		expect(left.some((n) => n.endsWith(".settling"))).toBe(false);
		await run("stop.mjs", base(), env);
		const sent = of("/v1/release").map((r) => r.body);
		expect(sent.map((b) => b.releaseClass)).toEqual(["unused", "unused"]); // mutant: call-ran
		const gaps = (await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((e) => e.kind === "gap");
		expect(gaps).toEqual([]);
	});
	it("a settle attempt left unanswered is still call-ran (the claim carries no release intent)", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		override = (path) =>
			path === "/v1/settle" ? { status: 503, json: { error: "down" } } : undefined;
		await run("post-tool-use.mjs", post("tu_1"), env);
		override = undefined;
		await run("stop.mjs", base(), env);
		expect(of("/v1/release").map((r) => r.body.releaseClass)).toEqual(["call-ran"]);
	});
});

describe("a give-back's gap is placed by when the call STARTED, even with no job capability (B-104)", () => {
	const env = { UT_CC_USAGE: "estimate" };
	const gapsOf = async () =>
		(await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((e) => e.kind === "gap");

	it("a server without `job`: the hold still records when the call began, and Stop's gap uses it", async () => {
		capabilities = ["principal", "release"];
		await startFake();
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		await new Promise((r) => setTimeout(r, 700));
		await run("stop.mjs", base(), env);
		const [gap] = await gapsOf();
		// mutant: no start stored → null, or the Stop's own time (700 ms later)
		expect(typeof gap?.started).toBe("string");
		expect(Date.parse(gap.at) - Date.parse(gap.started)).toBeGreaterThanOrEqual(600);
	});
	it("a hold that carries no time at all (an older hold) writes a gap with NO time, not the Stop's", async () => {
		capabilities = ["principal", "release"];
		await startFake();
		await mkdir(stateDir, { recursive: true });
		await writeFile(
			join(stateDir, `${SESSION}__main__tu_9.tx_9.json`),
			JSON.stringify({ gate: 1, toolUseId: "tu_9", transferId: "tx_9", agentId: "main" }),
		);
		await run("stop.mjs", base(), env);
		const [gap] = await gapsOf();
		expect(gap?.started).toBeNull(); // mutant: stamped with the Stop's time
	});
});

describe("a watch record never defaults its start to the hook that wrote it (B-108)", () => {
	const watch = async () =>
		(await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));

	it("a refused, timestamp-less remainder at Stop after a job switch: would_block with started null, a gap for BOTH jobs", async () => {
		await startFake();
		override = (path) =>
			path === "/v1/authorize"
				? { status: 402, json: { error: "budget_exceeded", reason: "need 9" } }
				: undefined;
		await writeLog(
			logLine(at(-60), "session-start", null),
			logLine(at(-50), "start", "job-a"),
			logLine(at(-5), "start", "job-b"),
		);
		// A message with NO timestamp: its time, and so its job, cannot be known.
		const noTime = JSON.parse(message("m1", at(-40), 100, 50));
		delete noTime.timestamp;
		await writeTranscript([JSON.stringify(noTime)]);
		await run("stop.mjs", base());
		const wb = (await watch()).find((e) => e.kind === "would_block");
		// mutant: `started` omitted → the helper defaults it to the Stop's time, inside job-b
		expect(wb?.started).toBeNull();
		const { jobCoverage } = (await import(pathToFileURL(join(HOOKS, "job-log.mjs")).href)) as {
			jobCoverage(a: {
				job: string;
				logs: Record<string, string>;
				records: unknown[];
				watch: unknown[];
			}): {
				knownGaps: Array<{ gap: string }>;
			};
		};
		const log = await readFile(join(stateDir, "jobs", `${SESSION}.jsonl`), "utf-8");
		for (const job of ["job-a", "job-b"]) {
			const r = jobCoverage({ job, logs: { [SESSION]: log }, records: [], watch: await watch() });
			expect(r.knownGaps.map((g) => g.gap).join(" "), job).toContain("its time is unreadable");
		}
	});
	it("every PreToolUse watch record states the call's own start", async () => {
		await startFake();
		override = (path) =>
			path === "/v1/authorize" ? { status: 503, json: { error: "down" } } : undefined;
		await run("pre-tool-use.mjs", pre("tu_1"), { UT_CC_USAGE: "estimate" });
		const gap = (await watch()).find((e) => e.kind === "gap");
		expect(typeof gap?.started).toBe("string");
	});
});

describe("a `.releasing` hold is given back by Stop in EVERY mode (B-113)", () => {
	it("an EMPTY transcript hold whose resume-time release fails: Stop gives it back unused, the file is gone, and the call is no longer refused", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		await writeTranscript([]);
		const env = { UT_CC_MODE: "enforce" };
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		let releases = 0;
		override = (path) => {
			if (path !== "/v1/release") return undefined;
			releases += 1;
			return releases === 1 ? { status: 500, json: { error: "ledger unavailable" } } : undefined;
		};
		const isRefused = (r: { code: number; stdout: string }) =>
			r.code !== 0 || r.stdout.includes('"permissionDecision":"deny"');
		const refused = await run("pre-tool-use.mjs", pre("tu_1"), env);
		expect(isRefused(refused)).toBe(true);
		expect((await readdir(stateDir)).some((n) => n.endsWith(".releasing"))).toBe(true);
		// still refused until Stop resolves it
		expect(isRefused(await run("pre-tool-use.mjs", pre("tu_1"), env))).toBe(true);
		await run("stop.mjs", base(), env);
		// mutant: the transcript filter drops it → never given back, never removed
		expect(
			of("/v1/release")
				.map((r) => r.body.releaseClass)
				.at(-1),
		).toBe("unused");
		expect((await readdir(stateDir)).some((n) => n.endsWith(".releasing"))).toBe(false);
		const again = await run("pre-tool-use.mjs", pre("tu_1"), env);
		expect(isRefused(again)).toBe(false);
		expect(again.stdout).toBe("");
	});
});

describe("the skew check uses the clock that READ the log (B-114)", () => {
	it("a sibling that switches jobs while this hook waits on a slow probe does not make the known job unknown", async () => {
		await startFake();
		healthDelayMs = 1600;
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		const running = run("pre-tool-use.mjs", pre("tu_1"), { UT_CC_USAGE: "estimate" });
		await new Promise((r) => setTimeout(r, 1200));
		await appendLog(logLine(Date.now(), "start", "job-b")); // a real stamp, after this hook began
		await running;
		// mutant: compared with the hook's START → 1.2 s "ahead" → jobState invalid
		const body = of("/v1/authorize")[0]?.body;
		expect(body?.job).toBe("job-a");
		expect(body).not.toHaveProperty("jobState");
	}, 30_000);
});

describe("estimate holds left behind are never lost silently (B-111, B-112)", () => {
	it("an estimate `.settling` stale enough for the journal's sweep still leaves its call-ran gap (B-111)", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		await mkdir(stateDir, { recursive: true });
		const file = join(stateDir, `${SESSION}__main__tu_9.tx_9.settling`);
		await writeFile(
			file,
			JSON.stringify({
				gate: 1,
				toolUseId: "tu_9",
				transferId: "tx_9",
				agentId: "main",
				usageFrom: iso(at(-30)),
			}),
		);
		const old = new Date(Date.now() - 20 * 60_000);
		await utimes(file, old, old);
		await writeTranscript([]);
		await run("stop.mjs", base());
		const gaps = (await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((e) => e.kind === "gap");
		// mutant: the sweep deletes the file and writes no gap
		expect(gaps).toHaveLength(1);
		expect(gaps[0]).toMatchObject({ releaseClass: "call-ran", started: iso(at(-30)) });
		expect(await readdir(stateDir)).not.toContain(`${SESSION}__main__tu_9.tx_9.settling`);
	});
	it("a log stamped by a clock far AHEAD of this one makes the call's job unknown (B-112)", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(60), "start", "job-a"));
		await run("pre-tool-use.mjs", pre("tu_1"), { UT_CC_USAGE: "estimate" });
		const body = of("/v1/authorize")[0]?.body;
		// mutant: no check → the log is read as if its clock were right
		expect(body?.jobState).toBe("invalid");
		expect(body).not.toHaveProperty("job");
	});
	it("a stamp less than a clock step ahead is not suspect", async () => {
		await startFake();
		await writeLog(logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a"));
		await run("pre-tool-use.mjs", pre("tu_1"), { UT_CC_USAGE: "estimate" });
		expect(of("/v1/authorize")[0]?.body.job).toBe("job-a");
	});
});

describe("a job stopped and started again (a, b, a) keeps its intervals apart", () => {
	it("a remainder settles three times, each window inside its own interval", async () => {
		await startFake();
		await writeLog(
			logLine(at(-60), "session-start", null),
			logLine(at(-50), "start", "job-a"),
			logLine(at(-30), "start", "job-b"),
			logLine(at(-10), "start", "job-a"),
		);
		await writeTranscript([
			message("m1", at(-40), 100, 50),
			message("m2", at(-20), 200, 80),
			message("m3", at(-5), 300, 120),
		]);
		await run("stop.mjs", base());
		const auths = of("/v1/authorize").map((r) => r.body);
		const settles = of("/v1/settle").map((r) => r.body);
		// mutant: group by job id only → job-a's two intervals merge into one window across job-b
		expect(auths.map((b) => [b.job, b.usageFrom])).toEqual([
			["job-a", iso(at(-40))],
			["job-b", iso(at(-20))],
			["job-a", iso(at(-5))],
		]);
		expect(settles.map((b) => b.usageTo)).toEqual([iso(at(-40)), iso(at(-20)), iso(at(-5))]);
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
		// mutant: stamped with the Stop's time → a refusal during another job lands in ITS interval
		expect(wb.started).toBe(iso(at(-40)));
		expect(wb).toMatchObject({
			job: "job-a",
			status: 402,
			tokens: { inputTokens: 100, outputTokens: 50 },
		});
	});
});
