// Typed jobs in the plugin: what KIND of work a job is (`feature`, `bugfix`, ...), declared by
// `usertrust-job.mjs start --type`, written to the job log, carried on the holds, and asked of
// the agent at SessionStart.
//
// Job ids and types here are opaque test values. Each group names the mutant it kills; the
// mutants were run against this file and reverted (see the pull request).

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWD_HOME_PRELOAD, passwdHomeFor, runHook } from "./helpers/run-hook.js";

// Every test here spawns hook processes (some several): a loaded machine needs more than
// the 5 s default, and a timeout is not what these tests are about.
vi.setConfig({ testTimeout: 30_000 });

const HOOKS = join(import.meta.dirname, "..", "hooks");
const CLI = join(import.meta.dirname, "..", "bin", "usertrust-job.mjs");
const SID = "sess-1";
const SESSION = "11111111-2222-4333-8444-555555555555";
const MODEL = "claude-sonnet-4-6";
const TYPES = ["feature", "bugfix", "review", "test", "docs", "ops", "research", "other"];

let state: string;
const saved = { ...process.env };

beforeEach(async () => {
	state = await mkdtemp(join(tmpdir(), "utcc-jt-"));
	process.env.UT_CC_STATE_DIR = state;
});
afterEach(() => {
	process.env = { ...saved };
});

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const logFile = (sid = SID) => join(state, "jobs", `${sid}.jsonl`);
const sessionStartLine = (sid: string, ts: number) =>
	line({ sid, ts: iso(ts), op: "session-start", job: null });
const startLine = (sid: string, ts: number, job: string, extra: Record<string, unknown> = {}) =>
	line({ sid, ts: iso(ts), op: "start", job, ...extra });
const stopLine = (sid: string, ts: number) => line({ sid, ts: iso(ts), op: "stop", job: null });

async function writeLog(text: string, sid = SID) {
	await mkdir(join(state, "jobs"), { recursive: true });
	await writeFile(logFile(sid), text);
}

type Event = Record<string, unknown>;
type Parsed =
	| { state: "none" }
	| { state: "invalid"; reason: string }
	| { state: "ok"; events: Event[] };
interface JobLogLib {
	JOB_TYPES: string[];
	TYPE_SOURCES: string[];
	JOB_TYPE_INSTRUCTION: string;
	parseJobLog(text: string, sid: string): Parsed;
	labelsAt(parsed: Parsed, tMs: number): Record<string, string>;
	resolveJob(
		sid: string,
		opts?: { types?: boolean },
	): Promise<{ at(t: number): Record<string, string>; keyAt(t: number): string }>;
	appendJobOp(
		sid: string,
		op: string,
		job: string | null,
		opts?: { waitMs?: number; type?: string; typeSource?: string },
	): Promise<{ ok: boolean }>;
}
interface PluginLib {
	JOB_TYPES: string[];
	jobHoldFields(entry: unknown): Record<string, string>;
	withoutJobType(labels: unknown): Record<string, string>;
}
// Computed specifiers: the hooks are plain .mjs with no declarations.
const jobLog = async () =>
	(await import(pathToFileURL(join(HOOKS, "job-log.mjs")).href)) as JobLogLib;
const pluginLib = async () =>
	(await import(pathToFileURL(join(HOOKS, "lib.mjs")).href)) as PluginLib;

/** The CLI as a Bash call in a session runs it: no `UT_*` variable or session id from the shell. */
function cli(args: string[], env: Record<string, string>) {
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(
			([k]) => !k.startsWith("UT_") && k !== "CLAUDE_CODE_SESSION_ID",
		),
	);
	const given = { UT_CC_STATE_DIR: state, ...env };
	return new Promise<{ code: number; stderr: string }>((resolve) => {
		const child = spawn(process.execPath, ["--import", PASSWD_HOME_PRELOAD, CLI, ...args], {
			env: { ...inherited, ...given, TEST_PASSWD_HOME: passwdHomeFor(given) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
	});
}
const logLines = async (sid = SID) =>
	(await readFile(logFile(sid), "utf-8"))
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);

// ── 2.1: the CLI ──

describe("usertrust-job.mjs start --type: refusals write nothing", () => {
	beforeEach(async () => {
		await writeLog(sessionStartLine(SID, T0));
	});
	const env = { CLAUDE_CODE_SESSION_ID: SID };
	const untouched = async () => expect(await logLines()).toHaveLength(1);

	it("an unknown type is refused (2), the list is printed, nothing is written", async () => {
		const r = await cli(["start", "--type", "chore", "job-a"], env);
		// mutant: the type is not checked against the list → exit 0 and a line with `chore`
		expect(r.code).toBe(2);
		for (const t of TYPES) expect(r.stderr).toContain(t);
		await untouched();
	});
	it("--source without --type is refused (2), whatever the source", async () => {
		for (const source of ["agent", "explicit", "bogus"]) {
			const r = await cli(["start", "--source", source, "job-a"], env);
			// mutant: --source alone is accepted (or defaults a type) → exit 0
			expect(r.code, source).toBe(2);
			expect(r.stderr).toContain("--source needs --type");
		}
		await untouched();
	});
	it("an unknown source is refused (2)", async () => {
		const r = await cli(["start", "--type", "bugfix", "--source", "inferred", "job-a"], env);
		// mutant: the source is not checked → the log is written, then invalid for every reader
		expect(r.code).toBe(2);
		await untouched();
	});
	it("a flag with no value, or given twice, is refused (2)", async () => {
		for (const args of [
			["start", "job-a", "--type"],
			["start", "--type", "bugfix", "--type", "docs", "job-a"],
			["start", "--type=", "job-a"],
			["start", "--type", "bugfix", "--source", "agent", "--source", "agent", "job-a"],
		]) {
			expect((await cli(args, env)).code, args.join(" ")).toBe(2);
		}
		await untouched();
	});
	it("a flag with no job id, or with two, is refused (2)", async () => {
		expect((await cli(["start", "--type", "bugfix"], env)).code).toBe(2);
		expect((await cli(["start", "--type", "bugfix", "a", "b"], env)).code).toBe(2);
		await untouched();
	});
	it("stop takes no flag", async () => {
		expect((await cli(["stop", "--type", "bugfix"], env)).code).toBe(2);
		await untouched();
	});
	it("the usage text names the flags and the types", async () => {
		const r = await cli(["start"], env);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("start [--type <type>] [--source agent|explicit] <job-id>");
		for (const t of TYPES) expect(r.stderr).toContain(t);
	});
});

describe("usertrust-job.mjs start --type: what is written", () => {
	const env = { CLAUDE_CODE_SESSION_ID: SID };
	beforeEach(async () => {
		await writeLog(sessionStartLine(SID, T0));
	});

	it("a type with no --source records `explicit`", async () => {
		expect((await cli(["start", "--type", "bugfix", "job-a"], env)).code).toBe(0);
		const last = (await logLines()).at(-1);
		// mutant: no default → typeSource absent; mutant: default `agent`
		expect(last).toMatchObject({
			op: "start",
			job: "job-a",
			type: "bugfix",
			typeSource: "explicit",
		});
	});
	it("--source agent is recorded; the flags may come before, after or around the id; `=` works", async () => {
		const forms = [
			["start", "--type", "docs", "--source", "agent", "j1"],
			["start", "j2", "--type", "ops", "--source", "agent"],
			["start", "--type=research", "j3", "--source=agent"],
		];
		for (const args of forms) expect((await cli(args, env)).code, args.join(" ")).toBe(0);
		expect((await logLines()).slice(1).map((l) => [l.job, l.type, l.typeSource])).toEqual([
			["j1", "docs", "agent"],
			["j2", "ops", "agent"],
			["j3", "research", "agent"],
		]);
	});
	it("every type on the list is accepted, and the log stays valid", async () => {
		for (const t of TYPES)
			expect((await cli(["start", "--type", t, `job-${t}`], env)).code).toBe(0);
		const { parseJobLog } = await jobLog();
		expect(parseJobLog(await readFile(logFile(), "utf-8"), SID).state).toBe("ok");
	});
	it("an untyped start writes exactly the line it always did: no type key, no source key", async () => {
		expect((await cli(["start", "job-a"], env)).code).toBe(0);
		const raw = (await readFile(logFile(), "utf-8")).trimEnd().split("\n").at(-1) ?? "";
		const rec = JSON.parse(raw) as Record<string, unknown>;
		// mutant: `type: undefined`/`typeSource: "explicit"` synthesized for an untyped record
		expect(Object.keys(rec)).toEqual(["sid", "ts", "op", "job"]);
		expect(raw).not.toContain("type");
	});
	it("the id stays free-form: a job id that looks like a type is still just an id", async () => {
		expect((await cli(["start", "bugfix"], env)).code).toBe(0);
		expect((await logLines()).at(-1)).toMatchObject({ job: "bugfix" });
		expect(Object.keys((await logLines()).at(-1) ?? {})).not.toContain("type");
	});
	it("appendJobOp refuses a bad pair itself, before it writes", async () => {
		const { appendJobOp } = await jobLog();
		for (const opts of [
			{ type: "chore" },
			{ typeSource: "agent" },
			{ type: "bugfix", typeSource: "inferred" },
		]) {
			await expect(appendJobOp(SID, "start", "job-a", opts), JSON.stringify(opts)).rejects.toThrow(
				TypeError,
			);
		}
		await expect(appendJobOp(SID, "stop", null, { type: "bugfix" })).rejects.toThrow(TypeError);
		expect(await logLines()).toHaveLength(1);
	});
});

// ── 2.2: the parser ──

describe("the job log parser: a bad type or source makes the WHOLE log invalid", () => {
	const ss = sessionStartLine(SID, T0);
	const parse = async (...lines: string[]) =>
		(await jobLog()).parseJobLog([ss, ...lines].join(""), SID);

	for (const [what, extra, reason] of [
		["a type outside the list", { type: "chore", typeSource: "agent" }, "unknown type"],
		["a type that is not a string", { type: 7, typeSource: "agent" }, "unknown type"],
		["a null type", { type: null }, "unknown type"],
		["a type in other case", { type: "Bugfix" }, "unknown type"],
		["a typeSource without a type", { typeSource: "agent" }, "typeSource without a type"],
		[
			"a typeSource outside {agent, explicit}",
			{ type: "bugfix", typeSource: "inferred" },
			"unknown typeSource",
		],
		["a null typeSource", { type: "bugfix", typeSource: null }, "unknown typeSource"],
	] as const) {
		it(`${what}`, async () => {
			const parsed = await parse(
				startLine(SID, T0 + 1, "job-a"),
				startLine(SID, T0 + 2, "job-b", extra),
			);
			// mutant: the rule is dropped → "ok" and the bad value reaches the wire
			expect(parsed).toMatchObject({ state: "invalid" });
			expect((parsed as { reason: string }).reason).toContain(reason);
			expect((parsed as { reason: string }).reason).toContain("line 3");
		});
	}
	it("a type on a stop, on a session-start, or on a start's neighbours is invalid", async () => {
		const typedStop = line({ sid: SID, ts: iso(T0 + 2), op: "stop", job: null, type: "bugfix" });
		expect(await parse(startLine(SID, T0 + 1, "job-a"), typedStop)).toMatchObject({
			state: "invalid",
			reason: "line 3 has a type on a stop",
		});
		const typedSessionStart = line({
			sid: SID,
			ts: iso(T0),
			op: "session-start",
			job: null,
			type: "bugfix",
		});
		expect((await jobLog()).parseJobLog(typedSessionStart, SID)).toMatchObject({
			state: "invalid",
			reason: "line 1 has a type on a session-start",
		});
		// a typeSource alone on a stop is the "without a type" rule, still invalid
		const sourceStop = line({
			sid: SID,
			ts: iso(T0 + 2),
			op: "stop",
			job: null,
			typeSource: "agent",
		});
		expect((await parse(sourceStop)).state).toBe("invalid");
	});
	it("the bad line poisons the log wherever it sits, and nothing after it is guessed", async () => {
		const parsed = await parse(
			startLine(SID, T0 + 1, "job-a", { type: "bugfix", typeSource: "agent" }),
			startLine(SID, T0 + 2, "job-b", { type: "chore" }),
			startLine(SID, T0 + 3, "job-c", { type: "docs", typeSource: "agent" }),
		);
		expect(parsed.state).toBe("invalid");
		expect((await jobLog()).labelsAt(parsed, T0 + 10)).toEqual({ jobState: "invalid" });
	});
	it("every type on the list and both sources parse; a type with no source parses, with no source invented", async () => {
		const { parseJobLog, labelsAt } = await jobLog();
		for (const t of TYPES) {
			for (const typeSource of ["agent", "explicit"]) {
				const p = parseJobLog(ss + startLine(SID, T0 + 1, "job-a", { type: t, typeSource }), SID);
				expect(labelsAt(p, T0 + 5), `${t}/${typeSource}`).toEqual({
					job: "job-a",
					jobType: t,
					typeSource,
				});
			}
		}
		const bare = parseJobLog(ss + startLine(SID, T0 + 1, "job-a", { type: "docs" }), SID);
		expect(bare.state).toBe("ok");
		// mutant: a missing source is filled in as `explicit`
		expect(labelsAt(bare, T0 + 5)).toEqual({ job: "job-a", jobType: "docs" });
	});
	it("old logs parse exactly as before: events keep their old shape, labels are { job }", async () => {
		const text = ss + startLine(SID, T0 + 1, "job-a") + stopLine(SID, T0 + 2);
		const p = (await jobLog()).parseJobLog(text, SID) as { state: "ok"; events: Event[] };
		expect(p.state).toBe("ok");
		// mutant: `jobType: undefined` / `typeSource: null` keys on every event
		expect(p.events.map((e) => Object.keys(e).sort())).toEqual(
			p.events.map(() => ["index", "job", "op", "ts", "tsMs"]),
		);
		expect((await jobLog()).labelsAt(p, T0 + 1.5)).toEqual({ job: "job-a" });
		expect((await jobLog()).labelsAt(p, T0 + 5)).toEqual({});
	});
	it("the type list the plugin carries is the list the spec closes", async () => {
		const lib = await jobLog();
		expect(lib.JOB_TYPES).toEqual(TYPES);
		expect(lib.TYPE_SOURCES).toEqual(["explicit", "agent"]);
		expect((await pluginLib()).JOB_TYPES).toEqual(TYPES);
	});
});

// ── labelsAt, keyAt and the resolver's one gate ──

describe("labelsAt returns the open job's type; keyAt is unchanged by it", () => {
	const ss = sessionStartLine(SID, T0);

	it("labelsAt follows the open interval: the type of the START that opened it, none after a stop", async () => {
		const { parseJobLog, labelsAt } = await jobLog();
		const p = parseJobLog(
			ss +
				startLine(SID, T0 + 100, "job-a", { type: "bugfix", typeSource: "agent" }) +
				startLine(SID, T0 + 200, "job-a", { type: "docs", typeSource: "explicit" }) +
				startLine(SID, T0 + 300, "job-b") +
				stopLine(SID, T0 + 400),
			SID,
		);
		expect(labelsAt(p, T0 + 150)).toEqual({ job: "job-a", jobType: "bugfix", typeSource: "agent" });
		// the same job id, restarted with another type: the NEW start's type
		expect(labelsAt(p, T0 + 250)).toEqual({
			job: "job-a",
			jobType: "docs",
			typeSource: "explicit",
		});
		// an untyped start after a typed one does not inherit its type
		expect(labelsAt(p, T0 + 350)).toEqual({ job: "job-b" });
		expect(labelsAt(p, T0 + 450)).toEqual({});
	});
	it("successive starts of the SAME id with different types do not share a key", async () => {
		await writeLog(
			ss +
				startLine(SID, T0 + 100, "job-a", { type: "bugfix", typeSource: "agent" }) +
				startLine(SID, T0 + 200, "job-a", { type: "docs", typeSource: "agent" }) +
				startLine(SID, T0 + 300, "job-a"),
		);
		const { resolveJob } = await jobLog();
		const jobs = await resolveJob(SID, { types: true });
		const keys = [150, 250, 350].map((o) => jobs.keyAt(T0 + o));
		// mutant: the key is built from the job id alone → one key for all three
		expect(new Set(keys).size).toBe(3);
		for (const k of keys) expect(k).toContain("job:job-a#");
	});
	it("keyAt is the same whether or not types are asked for, and holds the old shape", async () => {
		await writeLog(ss + startLine(SID, T0 + 100, "job-a", { type: "bugfix", typeSource: "agent" }));
		const { resolveJob } = await jobLog();
		const withTypes = await resolveJob(SID, { types: true });
		const without = await resolveJob(SID);
		// mutant: the type is appended to the key → keys differ by the flag, and old keys change
		expect(withTypes.keyAt(T0 + 150)).toBe(without.keyAt(T0 + 150));
		expect(without.keyAt(T0 + 150)).toBe("job:job-a#1");
	});
	it("the resolver gives no type unless asked: the default is the job alone", async () => {
		await writeLog(ss + startLine(SID, T0 + 100, "job-a", { type: "bugfix", typeSource: "agent" }));
		const { resolveJob } = await jobLog();
		// mutant: `at` ignores the flag → a labeller that forgot to ask sends a type anyway
		expect((await resolveJob(SID)).at(T0 + 150)).toEqual({ job: "job-a" });
		expect((await resolveJob(SID, { types: false })).at(T0 + 150)).toEqual({ job: "job-a" });
		expect((await resolveJob(SID, { types: true })).at(T0 + 150)).toEqual({
			job: "job-a",
			jobType: "bugfix",
			typeSource: "agent",
		});
	});
});

describe("jobHoldFields: a type is carried only as the server would accept it", () => {
	it("old hold files (no type fields) read exactly as before", async () => {
		const { jobHoldFields } = await pluginLib();
		const old = { job: "job-a", jobState: "x", usageFrom: "f", usageTo: "t", transferId: "tx_1" };
		expect(jobHoldFields(old)).toEqual({
			job: "job-a",
			jobState: "x",
			usageFrom: "f",
			usageTo: "t",
		});
		expect(jobHoldFields({})).toEqual({});
		expect(jobHoldFields(undefined)).toEqual({});
	});
	it("a valid pair is kept; a source needs a type; a type needs a job and a listed value", async () => {
		const { jobHoldFields } = await pluginLib();
		expect(jobHoldFields({ job: "j", jobType: "ops", typeSource: "agent" })).toEqual({
			job: "j",
			jobType: "ops",
			typeSource: "agent",
		});
		expect(jobHoldFields({ job: "j", jobType: "ops" })).toEqual({ job: "j", jobType: "ops" });
		// mutant: no pairing → the server would refuse the request, and the settle with it
		expect(jobHoldFields({ job: "j", typeSource: "agent" })).toEqual({ job: "j" });
		expect(jobHoldFields({ jobType: "ops", typeSource: "agent" })).toEqual({});
		expect(jobHoldFields({ jobState: "invalid", jobType: "ops" })).toEqual({ jobState: "invalid" });
		for (const bad of ["chore", "", 7, null, {}, ["ops"]]) {
			expect(jobHoldFields({ job: "j", jobType: bad, typeSource: "agent" }), String(bad)).toEqual({
				job: "j",
			});
		}
		expect(jobHoldFields({ job: "j", jobType: "ops", typeSource: "inferred" })).toEqual({
			job: "j",
			jobType: "ops",
		});
	});
	it("withoutJobType strips exactly the two type keys", async () => {
		const { withoutJobType } = await pluginLib();
		expect(
			withoutJobType({ job: "j", jobType: "ops", typeSource: "agent", usageFrom: "f" }),
		).toEqual({ job: "j", usageFrom: "f" });
		expect(withoutJobType(undefined)).toEqual({});
	});
});

// ── 2.3: SessionStart ──

interface Fake {
	server: Server;
	port: number;
	requests: Array<{ method: string; path: string }>;
}
let fakes: Server[] = [];
afterEach(() => {
	for (const f of fakes) {
		f.closeAllConnections();
		f.close();
	}
	fakes = [];
});

/** A server whose /v1/health answers as `health` says: a status and a body, after `delayMs`. */
function healthServer(health: { status?: number; body?: string; delayMs?: number }): Promise<Fake> {
	const requests: Fake["requests"] = [];
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			requests.push({ method: req.method ?? "", path: req.url ?? "" });
			setTimeout(() => {
				res.writeHead(health.status ?? 200, { "content-type": "application/json" });
				res.end(health.body ?? "{}");
			}, health.delayMs ?? 0);
		});
		fakes.push(server);
		server.listen(0, "127.0.0.1", () => {
			const a = server.address();
			resolve({ server, port: typeof a === "object" && a !== null ? a.port : 0, requests });
		});
	});
}
const caps = (...list: string[]) => JSON.stringify({ status: "ok", capabilities: list });

async function sessionStart(env: Record<string, string>, source = "startup") {
	const began = Date.now();
	const result = await runHook(
		join(HOOKS, "session-start.mjs"),
		{ hook_event_name: "SessionStart", source, session_id: SESSION },
		{ UT_CC_STATE_DIR: state, UT_SERVER_KEY: "k", ...env },
	);
	return { ...result, ms: Date.now() - began };
}
/** The WHOLE stdout as ONE JSON document, or the parse failure: two writes would fail here. */
function wholeJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}
const contextOf = (out: Record<string, unknown>) =>
	(out.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const BANNER = "usertrust: watch-only — nothing is blocked";

describe("SessionStart: ONE JSON object, the agent's instruction only for a server that lists job-type", () => {
	it("capable: one object holding the banner and the instruction", async () => {
		const fake = await healthServer({ body: caps("job", "job-type", "principal") });
		const r = await sessionStart({ UT_SERVER_URL: `http://127.0.0.1:${fake.port}` });
		expect(r.code).toBe(0);
		const out = wholeJson(r.stdout); // mutant: two announce calls → two documents → a parse error
		expect(Object.keys(out).sort()).toEqual(["hookSpecificOutput", "systemMessage"]);
		expect((out.hookSpecificOutput as Record<string, unknown>).hookEventName).toBe("SessionStart");
		const context = contextOf(out) ?? "";
		const { JOB_TYPE_INSTRUCTION } = await jobLog();
		expect(context).toBe(JOB_TYPE_INSTRUCTION);
		// the banner, exactly once, as it always was
		expect(count(r.stdout, BANNER)).toBe(1);
		expect(count(r.stdout, '"systemMessage"')).toBe(1);
		// SessionStart sends nothing to the server but the probe
		expect(fake.requests).toEqual([{ method: "GET", path: "/v1/health" }]);
	});

	it("the instruction names the SHIPPED command, every type, and what to do on resume", async () => {
		const fake = await healthServer({ body: caps("job", "job-type") });
		const r = await sessionStart({ UT_SERVER_URL: `http://127.0.0.1:${fake.port}` });
		const context = contextOf(wholeJson(r.stdout)) ?? "";
		// the file name the README's permission rule `Bash(usertrust-job.mjs:*)` allows
		expect(context).toContain("usertrust-job.mjs start --type <type> --source agent <short-id>");
		expect(context).not.toMatch(/usertrust-job(?!\.mjs)/);
		for (const t of TYPES) expect(context).toContain(t);
		expect(context).toMatch(/task changes/);
		expect(context).toMatch(/Do not ask the user/);
		expect(context).toMatch(/resumed or compacted/);
		expect(context).toMatch(/keep it/);
	});

	it("fixed text under 1,000 characters, with nothing of the session, server or user in it", async () => {
		const fake = await healthServer({ body: caps("job", "job-type") });
		const url = `http://127.0.0.1:${fake.port}`;
		const plain = contextOf(wholeJson((await sessionStart({ UT_SERVER_URL: url })).stdout)) ?? "";
		expect(plain.length).toBeGreaterThan(200);
		// mutant: the instruction grows past the bound (an example list, user text)
		expect(plain.length).toBeLessThan(1000);
		// the same text under a hostile state dir, mode, session and key: nothing is interpolated
		const hostileState = join(state, "state\u001b[2J\u009bdir");
		const hostile = await sessionStart({
			UT_SERVER_URL: url,
			UT_SERVER_KEY: "secret-key-xyz",
			UT_CC_STATE_DIR: hostileState,
			UT_CC_MODE: "enforcing\u001b[31m",
			UT_CC_UNIT: "unit-q",
		});
		const other = contextOf(wholeJson(hostile.stdout)) ?? "";
		expect(other).toBe(plain);
		for (const secret of [url, "secret-key-xyz", SESSION, state, "unit-q", String(fake.port)]) {
			expect(plain).not.toContain(secret);
		}
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting there are none
		expect(plain).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
	});

	it("every `source` gets it: startup, resume, clear, compact, fork", async () => {
		const fake = await healthServer({ body: caps("job", "job-type") });
		for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
			const r = await sessionStart({ UT_SERVER_URL: `http://127.0.0.1:${fake.port}` }, source);
			// mutant: emitted only on startup
			expect(contextOf(wholeJson(r.stdout)), source).toContain("usertrust-job.mjs start");
			expect(count(r.stdout, BANNER), source).toBe(1);
		}
	});

	it("a server that lists job but not job-type: the banner alone, no hookSpecificOutput", async () => {
		const fake = await healthServer({ body: caps("job", "principal", "release") });
		const r = await sessionStart({ UT_SERVER_URL: `http://127.0.0.1:${fake.port}` });
		const out = wholeJson(r.stdout);
		// mutant: the instruction is emitted without the probe → an old-server session is told to label
		expect(Object.keys(out)).toEqual(["systemMessage"]);
		expect(count(r.stdout, BANNER)).toBe(1);
	});

	it("a server that lists no capabilities at all: the banner alone", async () => {
		const fake = await healthServer({ body: JSON.stringify({ status: "ok" }) });
		const r = await sessionStart({ UT_SERVER_URL: `http://127.0.0.1:${fake.port}` });
		expect(Object.keys(wholeJson(r.stdout))).toEqual(["systemMessage"]);
		expect(count(r.stdout, BANNER)).toBe(1);
	});

	describe("a probe that does not answer cleanly: NO instruction, the banner still emitted exactly once", () => {
		const cases: Array<[string, () => Promise<{ url: string }>]> = [
			[
				"health answers 503",
				async () => ({
					url: `http://127.0.0.1:${(await healthServer({ status: 503, body: caps("job", "job-type") })).port}`,
				}),
			],
			[
				"health output is not JSON",
				async () => ({
					url: `http://127.0.0.1:${(await healthServer({ body: "<html>job-type</html>" })).port}`,
				}),
			],
			[
				"capabilities is a string, not a list",
				async () => ({
					url: `http://127.0.0.1:${(await healthServer({ body: JSON.stringify({ capabilities: "job-type" }) })).port}`,
				}),
			],
			[
				"capabilities holds non-strings",
				async () => ({
					url: `http://127.0.0.1:${(await healthServer({ body: JSON.stringify({ capabilities: [1, null, { x: "job-type" }] }) })).port}`,
				}),
			],
			[
				"the server is not there",
				async () => {
					const dead = await healthServer({});
					const url = `http://127.0.0.1:${dead.port}`;
					dead.server.closeAllConnections();
					await new Promise((r) => dead.server.close(r));
					return { url };
				},
			],
		];
		for (const [what, make] of cases) {
			it(what, async () => {
				const { url } = await make();
				const r = await sessionStart({ UT_SERVER_URL: url });
				expect(r.code).toBe(0);
				const out = wholeJson(r.stdout);
				expect(Object.keys(out), what).toEqual(["systemMessage"]);
				expect(count(r.stdout, BANNER), what).toBe(1);
			});
		}

		it("a capable server too slow to answer within the bound: no instruction, and the hook is bounded", async () => {
			// Answers job-type after 1.8 s: past the probe's 1.5 s, well inside the hook's 5 s.
			const slow = await healthServer({ body: caps("job", "job-type"), delayMs: 1800 });
			const r = await sessionStart({ UT_SERVER_URL: `http://127.0.0.1:${slow.port}` });
			// mutant: the probe waits the general 2 s (or longer) → the slow answer is taken
			expect(Object.keys(wholeJson(r.stdout))).toEqual(["systemMessage"]);
			expect(count(r.stdout, BANNER)).toBe(1);
			expect(r.stderr).toContain("capabilities are unknown");
		});

		it("a server that never answers: the hook ends well inside its 5 s timeout", async () => {
			const hung = await healthServer({ body: caps("job", "job-type"), delayMs: 60_000 });
			const r = await sessionStart({ UT_SERVER_URL: `http://127.0.0.1:${hung.port}` });
			// mutant: no time box on the probe → the hook runs to the harness kill
			expect(r.code).toBe(0);
			expect(r.ms).toBeLessThan(4_500);
			expect(Object.keys(wholeJson(r.stdout))).toEqual(["systemMessage"]);
			expect(count(r.stdout, BANNER)).toBe(1);
		});

		it("a refused configuration sends nothing and gets no instruction", async () => {
			const fake = await healthServer({ body: caps("job", "job-type") });
			const home = await mkdtemp(join(tmpdir(), "utcc-jt-home-"));
			const anchor = join(home, ".config", "usertrust");
			await mkdir(anchor, { recursive: true, mode: 0o700 });
			const config = join(anchor, "session.json");
			await writeFile(config, "this is not json", { mode: 0o600 });
			const r = await runHook(
				join(HOOKS, "session-start.mjs"),
				{ hook_event_name: "SessionStart", source: "startup", session_id: SESSION },
				{
					TEST_PASSWD_HOME: home,
					UT_CC_CONFIG: config,
					UT_SERVER_URL: `http://127.0.0.1:${fake.port}`,
					UT_SERVER_KEY: "k",
				},
			);
			expect(r.code).toBe(0);
			expect(Object.keys(wholeJson(r.stdout))).toEqual(["systemMessage"]);
			// the banner is still the one announcement
			expect(count(r.stdout, '"systemMessage"')).toBe(1);
			// mutant: the probe ignores the refusal → a request reaches the server
			expect(fake.requests).toEqual([]);
		});
	});
});

describe("announce: one write, one object, and the old numeric call form still works", () => {
	const announceRun = (script: string) =>
		new Promise<{ code: number; stdout: string }>((resolve) => {
			const child = spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`import { announce } from ${JSON.stringify(pathToFileURL(join(HOOKS, "lib.mjs")).href)};\n${script}`,
				],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
			let stdout = "";
			child.stdout.on("data", (c) => {
				stdout += c;
			});
			child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
		});

	it("announce(text) and announce(text, max): the systemMessage alone, clipped at max", async () => {
		const plain = await announceRun('announce("hello world");');
		expect(JSON.parse(plain.stdout)).toEqual({ systemMessage: "hello world" });
		// mutant: the numeric second argument is read as an options object → max ignored
		const clipped = await announceRun('announce("hello world", 5);');
		expect(JSON.parse(clipped.stdout)).toEqual({ systemMessage: "hello" });
	});
	it("announce(text, { max, additionalContext }): both in one object, each sanitized then clipped", async () => {
		const r = await announceRun(
			'announce("banner\\u001b[2J text", { max: 12, additionalContext: "ctx\\u009b\\u0007 ok" });',
		);
		const out = JSON.parse(r.stdout);
		expect(out).toEqual({
			systemMessage: "banner [2J t",
			hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx   ok" },
		});
		// one write: the whole stdout is that one document
		expect(r.stdout).toBe(JSON.stringify(out));
	});
	it("announce(text, {}) and { additionalContext: undefined } add nothing", async () => {
		const a = await announceRun('announce("x", {}); ');
		const b = await announceRun('announce("x", { additionalContext: undefined });');
		expect(JSON.parse(a.stdout)).toEqual({ systemMessage: "x" });
		expect(JSON.parse(b.stdout)).toEqual({ systemMessage: "x" });
	});
	it("the context is clipped at its own bound, after sanitizing", async () => {
		const r = await announceRun('announce("x", { additionalContext: "y".repeat(5000) });');
		const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
		const { MAX_CONTEXT_CHARS } = (await import(pathToFileURL(join(HOOKS, "lib.mjs")).href)) as {
			MAX_CONTEXT_CHARS: number;
		};
		expect(context).toHaveLength(MAX_CONTEXT_CHARS);
	});

	it("session-start.mjs calls announce ONCE and has no write of its own", async () => {
		const text = await readFile(join(HOOKS, "session-start.mjs"), "utf-8");
		const source = ts.createSourceFile("session-start.mjs", text, ts.ScriptTarget.Latest, true);
		const calls: string[] = [];
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
			ts.forEachChild(node, visit);
		};
		visit(source);
		// mutant: a second announce (the instruction announced apart from the banner)
		expect(calls.filter((c) => c === "announce")).toHaveLength(1);
		expect(calls.filter((c) => /stdout|stderr|console/.test(c))).toEqual([]);
		// ...nor does the module that builds the instruction write anywhere
		const log = await readFile(join(HOOKS, "job-log.mjs"), "utf-8");
		expect(log).not.toMatch(/process\.(stdout|stderr)\.write|console\./);
	});
});

// ── 2.4 / 10.6: the hold fields, sent vs recorded ──

describe("hold labels: what the authorize SENT is what the hold records and the settle names", () => {
	let fake: Server | undefined;
	let port = 0;
	let capabilities: string[] = [];
	let healthStatus = 200;
	let requests: Array<{ path: string; body: Record<string, unknown>; status: number }> = [];
	let nextTransfer = 0;
	let override:
		| ((
				path: string,
				body: Record<string, unknown>,
		  ) => { status: number; json: unknown } | undefined)
		| undefined;
	let stateDir = "";
	let projectDir = "";
	let transcript = "";
	const env = { UT_CC_USAGE: "estimate" };

	function startFake(listenOn = 0): Promise<void> {
		return new Promise((resolve) => {
			fake = createServer((req, res) => {
				if (req.method === "GET" && req.url === "/v1/health") {
					res.writeHead(healthStatus, { "content-type": "application/json" });
					res.end(JSON.stringify({ status: "ok", capabilities }));
					return;
				}
				let raw = "";
				req.on("data", (c) => {
					raw += c;
				});
				req.on("end", () => {
					const path = req.url ?? "";
					const body = JSON.parse(raw || "{}") as Record<string, unknown>;
					let out = override?.(path, body);
					if (out === undefined) {
						if (path === "/v1/authorize") {
							nextTransfer += 1;
							out = { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
						} else out = { status: 200, json: { settled: true, aborted: true, released: true } };
					}
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
		stateDir = await mkdtemp(join(tmpdir(), "utcc-jt-hold-"));
		projectDir = await mkdtemp(join(tmpdir(), "utcc-jt-proj-"));
		transcript = join(projectDir, `${SESSION}.jsonl`);
		requests = [];
		nextTransfer = 0;
		capabilities = ["job", "job-type", "principal", "release"];
		healthStatus = 200;
		override = undefined;
		await mkdir(join(stateDir, "transcripts"), { recursive: true, mode: 0o700 });
		await writeFile(join(stateDir, "transcripts", "since"), "2000-01-01T00:00:00.000Z");
		await mkdir(join(stateDir, "transcripts", "since-session"), { recursive: true, mode: 0o700 });
		await writeFile(
			join(stateDir, "transcripts", "since-session", SESSION),
			"2000-01-01T00:00:00.000Z",
		);
	});
	afterEach(() => {
		fake?.closeAllConnections();
		fake?.close();
		fake = undefined;
	});

	const run = (name: string, input: Record<string, unknown>, extra: Record<string, string> = {}) =>
		runHook(join(HOOKS, name), input, {
			UT_CC_STATE_DIR: stateDir,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
			UT_SERVER_KEY: "k",
			...extra,
		});
	const NOW = Date.now();
	const at = (offsetS: number) => NOW + offsetS * 1000;
	const base = () => ({ session_id: SESSION, transcript_path: transcript });
	const pre = (id: string) => ({
		...base(),
		tool_name: "Bash",
		tool_use_id: id,
		tool_input: { command: "ls" },
	});
	const post = (id: string) => ({ ...base(), tool_use_id: id, tool_response: "eight ch" });
	const of = (path: string) => requests.filter((r) => r.path === path).map((r) => r.body);
	const logLine = (
		ts: number,
		op: string,
		job: string | null,
		extra: Record<string, unknown> = {},
	) => `${JSON.stringify({ sid: SESSION, ts: iso(ts), op, job, ...extra })}\n`;
	const writeSessionLog = async (...lines: string[]) => {
		await mkdir(join(stateDir, "jobs"), { recursive: true });
		await writeFile(join(stateDir, "jobs", `${SESSION}.jsonl`), lines.join(""));
	};
	const TYPED = { type: "bugfix", typeSource: "agent" };
	const typedLog = () =>
		writeSessionLog(
			logLine(at(-50), "session-start", null),
			logLine(at(-40), "start", "job-a", TYPED),
		);
	const TYPE_KEYS = ["jobType", "typeSource"];
	const holdFiles = async () =>
		(await readdir(stateDir)).filter((n) => n.startsWith(SESSION) && /\.(json|settling)$/.test(n));
	const holdBody = async (name: string) =>
		JSON.parse(await readFile(join(stateDir, name), "utf-8")) as Record<string, unknown>;
	const watch = async () =>
		(await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Record<string, unknown>);

	it("a server that lists job-type: authorize, hold file and settle carry the type beside the job", async () => {
		await startFake();
		await typedLog();
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		const [file] = await holdFiles();
		const hold = await holdBody(file ?? "");
		await run("post-tool-use.mjs", post("tu_1"), env);
		const [auth] = of("/v1/authorize");
		const [settle] = of("/v1/settle");
		// mutant (one per site): authorizeLabels / holdAuthorizeLabels / jobHoldFields / settleLabels
		// drops the type → one of these four lines fails
		expect(auth).toMatchObject({ job: "job-a", jobType: "bugfix", typeSource: "agent" });
		expect(hold).toMatchObject({ job: "job-a", jobType: "bugfix", typeSource: "agent" });
		expect(settle).toMatchObject({ job: "job-a", jobType: "bugfix", typeSource: "agent" });
		expect(settle).not.toHaveProperty("usageFrom");
	});

	it("a job with no type sends the old bodies: no type key anywhere", async () => {
		await startFake();
		await writeSessionLog(
			logLine(at(-50), "session-start", null),
			logLine(at(-40), "start", "job-a"),
		);
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		const hold = await holdBody((await holdFiles())[0] ?? "");
		await run("post-tool-use.mjs", post("tu_1"), env);
		// mutant: `explicit`/`other` synthesized for an untyped job
		for (const body of [...of("/v1/authorize"), ...of("/v1/settle"), hold]) {
			for (const key of TYPE_KEYS) expect(body).not.toHaveProperty(key);
			expect(body.job).toBe("job-a");
		}
		expect(JSON.stringify(of("/v1/authorize")[0])).not.toContain("jobType");
	});

	it("untyped, job-only and invalid-log requests serialize to the same payload with and without job-type listed", async () => {
		// The same inputs against a server that lists job-type and one that does not: the bodies
		// must be byte-identical, so an untyped call is untouched by the feature.
		const bodies: string[][] = [];
		let samePort = 0; // a session is pinned to its server's URL: both rounds use one port
		for (const listed of [false, true]) {
			capabilities = listed
				? ["job", "job-type", "principal", "release"]
				: ["job", "principal", "release"];
			await startFake(samePort);
			samePort = port;
			const logs: Array<[string, string[]]> = [
				["job-only", [logLine(at(-50), "session-start", null), logLine(at(-40), "start", "job-a")]],
				["invalid", [`garbage\n`, logLine(at(-40), "start", "job-a")]],
				["no log", []],
			];
			const got: string[] = [];
			for (const [label, lines] of logs) {
				requests = [];
				if (lines.length > 0) await writeSessionLog(...lines);
				else await rmLog();
				await run("pre-tool-use.mjs", pre(`tu_${label}`), env);
				await run("post-tool-use.mjs", post(`tu_${label}`), env);
				got.push(
					JSON.stringify(
						requests.map((r) => [r.path, { ...r.body, usageFrom: 0, usageTo: 0, transferId: 0 }]),
					),
				);
			}
			bodies.push(got);
			fake?.closeAllConnections();
			await new Promise((r) => (fake ? fake.close(r) : r(undefined)));
		}
		expect(bodies[1]).toEqual(bodies[0]);
	});
	const rmLog = async () => {
		const { rm } = await import("node:fs/promises");
		await rm(join(stateDir, "jobs", `${SESSION}.jsonl`), { force: true });
	};

	it("job listed, job-type NOT: the job is sent and the type is not, anywhere", async () => {
		capabilities = ["job", "principal", "release"];
		await startFake();
		await typedLog();
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		const hold = await holdBody((await holdFiles())[0] ?? "");
		await run("post-tool-use.mjs", post("tu_1"), env);
		// mutant: the type is gated by `job` alone → an older server strips it silently and the hold records it
		for (const body of [...of("/v1/authorize"), ...of("/v1/settle"), hold]) {
			for (const key of TYPE_KEYS) expect(body, key).not.toHaveProperty(key);
			expect(body.job).toBe("job-a");
		}
		// ...and nothing is remembered about a bit the server never offered
		expect((await readdir(join(stateDir, "jobs"))).sort()).toEqual(
			["capability.json", `${SESSION}.jsonl`].sort(),
		);
	});

	it("a failed health probe between authorize and settle: the settle still names the type its authorize sent", async () => {
		await startFake();
		await typedLog();
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		healthStatus = 503; // the settle's probe fails: capabilities unknown
		await run("post-tool-use.mjs", post("tu_1"), env);
		// mutant: the settle echoes the type only if the CURRENT probe lists job-type
		expect(of("/v1/settle")[0]).toMatchObject({
			job: "job-a",
			jobType: "bugfix",
			typeSource: "agent",
		});
	});

	it("a type the authorize OMITTED is never named by the settle, even once the server lists job-type", async () => {
		capabilities = ["job", "principal", "release"];
		await startFake();
		await typedLog();
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		capabilities = ["job", "job-type", "principal", "release"]; // upgraded between the two
		await run("post-tool-use.mjs", post("tu_1"), env);
		// mutant: the settle re-reads the job log and names the open job's type
		expect(of("/v1/authorize")[0]).not.toHaveProperty("jobType");
		expect(of("/v1/settle")[0]).not.toHaveProperty("jobType");
		expect(of("/v1/settle")[0]).not.toHaveProperty("typeSource");
		expect(of("/v1/settle")[0]?.job).toBe("job-a");
	});

	it("an OLD hold file (written before types existed) settles exactly as before", async () => {
		capabilities = ["job", "principal", "release"];
		await startFake();
		await typedLog();
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		const file = (await holdFiles())[0] ?? "";
		const hold = await holdBody(file);
		for (const key of TYPE_KEYS) expect(hold).not.toHaveProperty(key);
		capabilities = ["job", "job-type", "principal", "release"];
		await run("post-tool-use.mjs", post("tu_1"), env);
		const settle = of("/v1/settle")[0] ?? {};
		expect(settle).toMatchObject({ job: "job-a", transferId: "tx_1" });
		expect(Object.keys(settle).filter((k) => TYPE_KEYS.includes(k))).toEqual([]);
	});

	it("a hold file whose type is corrupt loses the type, never the job or the settle", async () => {
		await startFake();
		await typedLog();
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		const file = (await holdFiles())[0] ?? "";
		const hold = await holdBody(file);
		await writeFile(
			join(stateDir, file),
			JSON.stringify({ ...hold, jobType: "chore", typeSource: { x: 1 } }),
		);
		await run("post-tool-use.mjs", post("tu_1"), env);
		const settle = of("/v1/settle")[0] ?? {};
		expect(settle.job).toBe("job-a");
		for (const key of TYPE_KEYS) expect(settle).not.toHaveProperty(key);
	});

	it("job-type is remembered per server like job: a probe that fails keeps the type, one that answers overwrites it", async () => {
		await startFake();
		await typedLog();
		// 1. answers with job-type: remembered
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		expect(of("/v1/authorize")[0]).toMatchObject({ jobType: "bugfix" });
		const remembered = async () =>
			Object.values(
				JSON.parse(await readFile(join(stateDir, "jobs", "type-capability.json"), "utf-8")),
			);
		expect(await remembered()).toEqual([true]);
		// 2. the probe FAILS (503): the remembered bit is used, so the type survives one bad probe
		healthStatus = 503;
		await run("pre-tool-use.mjs", pre("tu_2"), env);
		// mutant: the type bit is not remembered → the type is dropped whenever a probe fails
		expect(of("/v1/authorize")[1]).toMatchObject({
			job: "job-a",
			jobType: "bugfix",
			typeSource: "agent",
		});
		// 3. downgraded and ANSWERING: overwritten, and the type is dropped
		healthStatus = 200;
		capabilities = ["job", "principal", "release"];
		await run("pre-tool-use.mjs", pre("tu_3"), env);
		expect(of("/v1/authorize")[2]).not.toHaveProperty("jobType");
		expect(of("/v1/authorize")[2]?.job).toBe("job-a");
		expect(await remembered()).toEqual([false]);
	});

	it("a failed probe with NOTHING remembered sends the job and no type", async () => {
		await startFake();
		await typedLog();
		// Remember `job` alone: an older server that answered once.
		capabilities = ["job", "principal", "release"];
		await run("pre-tool-use.mjs", pre("tu_0"), env);
		healthStatus = 503;
		capabilities = ["job", "job-type", "principal", "release"];
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		const second = of("/v1/authorize")[1] ?? {};
		expect(second.job).toBe("job-a");
		expect(second).not.toHaveProperty("jobType");
	});

	it("a would_block record names the type beside the job (and none for a job-only server)", async () => {
		await startFake();
		await typedLog();
		override = (path) =>
			path === "/v1/authorize"
				? { status: 402, json: { error: "insufficient_balance", reason: "no budget" } }
				: undefined;
		await run("pre-tool-use.mjs", pre("tu_1"), env);
		const blocked = (await watch()).filter((e) => e.kind === "would_block");
		// mutant: the watch record selects job fields by hand and forgets the type
		expect(blocked).toHaveLength(1);
		expect(blocked[0]).toMatchObject({ job: "job-a", jobType: "bugfix", typeSource: "agent" });

		capabilities = ["job", "principal", "release"];
		await run("pre-tool-use.mjs", pre("tu_2"), env);
		const second = (await watch()).filter((e) => e.kind === "would_block")[1] ?? {};
		expect(second.job).toBe("job-a");
		for (const key of TYPE_KEYS) expect(second).not.toHaveProperty(key);
	});

	describe("an expired hold's replacement", () => {
		const gone = { status: 404, json: { error: "not_found", reason: "unknown transferId" } };
		async function expired() {
			await startFake();
			await typedLog();
			await run("pre-tool-use.mjs", pre("tu_1"), env);
			let settles = 0;
			override = (path) => {
				if (path === "/v1/settle") {
					settles += 1;
					if (settles === 1) return gone;
					// keep the replacement hold on disk (.settling) so what it recorded can be read
					return { status: 500, json: { error: "internal" } };
				}
				return undefined;
			};
		}
		it("carries the expired hold's type: authorize, record and settle agree", async () => {
			await expired();
			await run("post-tool-use.mjs", post("tu_1"), env);
			const auths = of("/v1/authorize");
			expect(auths).toHaveLength(2);
			expect(auths[1]).toMatchObject({ job: "job-a", jobType: "bugfix", typeSource: "agent" });
			const fresh = (await holdFiles()).find((n) => n.includes("tx_2")) ?? "";
			expect(await holdBody(fresh)).toMatchObject({
				job: "job-a",
				jobType: "bugfix",
				typeSource: "agent",
			});
			expect(of("/v1/settle")[1]).toMatchObject({
				transferId: "tx_2",
				job: "job-a",
				jobType: "bugfix",
			});
		});
		it("a server that now answers WITHOUT job-type: no type is sent, recorded or settled", async () => {
			await expired();
			capabilities = ["job", "principal", "release"];
			await run("post-tool-use.mjs", post("tu_1"), env);
			const auths = of("/v1/authorize");
			expect(auths).toHaveLength(2);
			// mutant: the replacement copies the old hold's labels without the capability check
			expect(auths[1]?.job).toBe("job-a");
			for (const key of TYPE_KEYS) expect(auths[1], key).not.toHaveProperty(key);
			const fresh = (await holdFiles()).find((n) => n.includes("tx_2")) ?? "";
			for (const key of TYPE_KEYS) expect(await holdBody(fresh), key).not.toHaveProperty(key);
			// mutant: the replacement's settle still echoes the expired hold's type
			const settle = of("/v1/settle")[1] ?? {};
			expect(settle.transferId).toBe("tx_2");
			for (const key of TYPE_KEYS) expect(settle, key).not.toHaveProperty(key);
		});
	});

	describe("transcript holds and remainders", () => {
		function message(id: string, tsMs: number, input: number, output: number): string {
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
					usage: {
						input_tokens: input,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
						output_tokens: output,
					},
				},
			});
		}
		const writeTranscript = (lines: string[]) => writeFile(transcript, `${lines.join("\n")}\n`);

		it("a remainder spanning two typed jobs settles once per job, each with ITS type", async () => {
			await startFake();
			await writeSessionLog(
				logLine(at(-60), "session-start", null),
				logLine(at(-50), "start", "job-a", TYPED),
				logLine(at(-20), "start", "job-b", { type: "feature", typeSource: "explicit" }),
			);
			await writeTranscript([message("m1", at(-40), 100, 50), message("m3", at(-10), 300, 120)]);
			await run("stop.mjs", base());
			const auths = of("/v1/authorize");
			const settles = of("/v1/settle");
			expect(auths.map((b) => [b.job, b.jobType, b.typeSource])).toEqual([
				["job-a", "bugfix", "agent"],
				["job-b", "feature", "explicit"],
			]);
			// mutant: settleLabels drops the type, or the groups share the first group's labels
			expect(settles.map((b) => [b.job, b.jobType, b.typeSource])).toEqual([
				["job-a", "bugfix", "agent"],
				["job-b", "feature", "explicit"],
			]);
		});

		it("a remainder for a server that lists job but not job-type sends no type", async () => {
			capabilities = ["job", "principal", "release"];
			await startFake();
			await typedLog();
			await writeTranscript([message("m1", at(-30), 100, 50)]);
			await run("stop.mjs", base());
			expect(of("/v1/authorize")).toHaveLength(1);
			for (const body of [...of("/v1/authorize"), ...of("/v1/settle")]) {
				expect(body.job).toBe("job-a");
				for (const key of TYPE_KEYS) expect(body, key).not.toHaveProperty(key);
			}
		});

		it("a refused remainder is a would_block record with the type", async () => {
			await startFake();
			await typedLog();
			await writeTranscript([message("m1", at(-30), 100, 50)]);
			override = (path) =>
				path === "/v1/authorize"
					? { status: 402, json: { error: "insufficient_balance", reason: "no budget" } }
					: undefined;
			await run("stop.mjs", base());
			const blocked = (await watch()).filter((e) => e.kind === "would_block");
			// mutant: reportDenied selects job fields by hand and forgets the type
			expect(blocked).toHaveLength(1);
			expect(blocked[0]).toMatchObject({ job: "job-a", jobType: "bugfix", typeSource: "agent" });
		});

		describe("an unresolved keyed settle is retried with the labels it was FIRST sent", () => {
			async function firstAttempt() {
				capabilities = ["job", "job-type", "principal", "release", "idempotency-key"];
				await startFake();
				await writeSessionLog(
					logLine(at(-60), "session-start", null),
					logLine(at(-50), "start", "job-a", TYPED),
				);
				await writeTranscript([message("m1", at(-40), 100, 50)]);
				await run("pre-tool-use.mjs", pre("tu_1"));
				override = (path) =>
					path === "/v1/settle" ? { status: 503, json: { error: "down" } } : undefined;
				await run("post-tool-use.mjs", post("tu_1"));
				override = undefined;
			}
			it("the type survives a job that moved on and a server that stopped listing job-type", async () => {
				await firstAttempt();
				expect(of("/v1/authorize")[0]).toMatchObject({ job: "job-a", jobType: "bugfix" });
				// the job moves on (typed otherwise) and the server is downgraded, before the retry
				await writeFile(
					join(stateDir, "jobs", `${SESSION}.jsonl`),
					[
						logLine(at(-60), "session-start", null),
						logLine(at(-50), "start", "job-a", TYPED),
						logLine(Date.now() + 5, "start", "job-b", { type: "docs", typeSource: "explicit" }),
					].join(""),
				);
				await new Promise((r) => setTimeout(r, 30));
				capabilities = ["job", "principal", "release", "idempotency-key"];
				await run("stop.mjs", base());
				const retried = of("/v1/authorize").slice(1);
				const settled = of("/v1/settle").slice(1);
				expect(retried.length).toBeGreaterThan(0);
				// mutant: the vehicle's labels lose the type, or take the log's CURRENT job's
				for (const body of [...retried, ...settled]) {
					expect(body).toMatchObject({ job: "job-a", jobType: "bugfix", typeSource: "agent" });
				}
			});
			it("a vehicle first sent WITHOUT a type never gains one on the retry", async () => {
				capabilities = ["job", "principal", "release", "idempotency-key"];
				await startFake();
				await writeSessionLog(
					logLine(at(-60), "session-start", null),
					logLine(at(-50), "start", "job-a", TYPED),
				);
				await writeTranscript([message("m1", at(-40), 100, 50)]);
				await run("pre-tool-use.mjs", pre("tu_1"));
				override = (path) =>
					path === "/v1/settle" ? { status: 503, json: { error: "down" } } : undefined;
				await run("post-tool-use.mjs", post("tu_1"));
				override = undefined;
				capabilities = ["job", "job-type", "principal", "release", "idempotency-key"];
				await run("stop.mjs", base());
				const retried = [...of("/v1/authorize").slice(1), ...of("/v1/settle").slice(1)];
				expect(retried.length).toBeGreaterThan(0);
				// mutant: the retry re-resolves the labels from the log under the NEW capability
				for (const body of retried) {
					expect(body.job, JSON.stringify(body)).toBe("job-a");
					for (const key of TYPE_KEYS) expect(body, key).not.toHaveProperty(key);
				}
			});
		});
	});
});
