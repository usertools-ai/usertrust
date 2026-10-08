// The job log (hooks/job-log.mjs) and its CLI (bin/usertrust-job.mjs).
//
// Job ids here are opaque (`job-a`, `bug-1`). Each test names the mutant it kills.

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRINCIPAL_FIELD_PATTERN } from "../../core/src/shared/principal.js";
import { runHook } from "./helpers/run-hook.js";

// Every test here spawns hook processes (some several): a loaded machine needs more than
// the 5 s default, and a timeout is not what these tests are about.
vi.setConfig({ testTimeout: 30_000 });

const HOOKS = join(import.meta.dirname, "..", "hooks");
const CLI = join(import.meta.dirname, "..", "bin", "usertrust-job.mjs");
const SID = "sess-1";

let state: string;
const saved = { ...process.env };

beforeEach(async () => {
	state = await mkdtemp(join(tmpdir(), "utcc-job-"));
	process.env.UT_CC_STATE_DIR = state;
});
afterEach(() => {
	process.env = { ...saved };
});

const gapText = (r: { knownGaps: Array<{ gap: string }> }) =>
	r.knownGaps.map((g) => g.gap).join(" ");
const logFile = (sid = SID) => join(state, "jobs", `${sid}.jsonl`);
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

async function writeLog(text: string, sid = SID) {
	await mkdir(join(state, "jobs"), { recursive: true });
	await writeFile(logFile(sid), text);
}
const start = (sid: string, ts: number) =>
	line({ sid, ts: iso(ts), op: "session-start", job: null });
const op = (sid: string, ts: number, o: string, job: string | null) =>
	line({ sid, ts: iso(ts), op: o, job });

type Parsed =
	| { state: "none" }
	| { state: "invalid"; reason: string }
	| { state: "ok"; events: Array<{ op: string; ts: string; job: string | null }> };
interface Lib {
	JOB_ID: RegExp;
	parseJobLog(text: string, sid: string): Parsed;
	resolveJob(sid: string): Promise<{ parsed: Parsed; at(t: number): Record<string, string> }>;
	appendJobOp(
		sid: string,
		op: string,
		job: string | null,
		opts?: { waitMs?: number },
	): Promise<{ ok: boolean }>;
	jobCoverage(args: {
		job: string;
		logs: Record<string, string>;
		records: unknown[];
		watch?: unknown[];
	}): {
		knownGaps: Array<{ gap: string; evidence: Record<string, unknown> }>;
		transferIds: string[];
		taggedCostUt: string;
	};
}
// A computed specifier: the hooks are plain .mjs with no declarations.
async function lib(): Promise<Lib> {
	return (await import(pathToFileURL(join(HOOKS, "job-log.mjs")).href)) as Lib;
}

function cli(args: string[], env: Record<string, string>) {
	return new Promise<{ code: number; stderr: string }>((resolve) => {
		const inherited = Object.fromEntries(
			Object.entries(process.env).filter(
				([k]) => !k.startsWith("UT_") && k !== "CLAUDE_CODE_SESSION_ID",
			),
		);
		const child = spawn(process.execPath, [CLI, ...args], {
			env: { ...inherited, UT_CC_STATE_DIR: state, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
	});
}

function cliOut(args: string[]) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		const inherited = Object.fromEntries(
			Object.entries(process.env).filter(
				([k]) => !k.startsWith("UT_") && k !== "CLAUDE_CODE_SESSION_ID",
			),
		);
		const child = spawn(process.execPath, [CLI, ...args], {
			env: { ...inherited, UT_CC_STATE_DIR: state },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += c;
		});
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

describe("the job id rule is core's", () => {
	it("JOB_ID is exactly PRINCIPAL_FIELD_PATTERN", async () => {
		expect(String((await lib()).JOB_ID)).toBe(String(PRINCIPAL_FIELD_PATTERN));
	});
});

describe("test 6 — no default", () => {
	it("with no log, no labels at any time", async () => {
		const { resolveJob } = await lib();
		const r = await resolveJob(SID);
		expect(r.at(T0)).toEqual({});
	});
	it("with a log and no open job, no labels", async () => {
		await writeLog(start(SID, T0));
		const { resolveJob } = await lib();
		expect((await resolveJob(SID)).at(T0 + 10)).toEqual({});
	});
});

describe("test 1 (resolution) — a switch applies from the NEXT call, and an equal ts is the earlier job", () => {
	it("resolves by the time asked, never 'now'", async () => {
		await writeLog(
			start(SID, T0) +
				op(SID, T0 + 100, "start", "job-a") +
				op(SID, T0 + 200, "start", "job-b") +
				op(SID, T0 + 300, "stop", null),
		);
		const { resolveJob } = await lib();
		const r = await resolveJob(SID);
		expect(r.at(T0 + 100)).toEqual({}); // equal ts: the earlier state
		expect(r.at(T0 + 101)).toEqual({ job: "job-a" });
		expect(r.at(T0 + 200)).toEqual({ job: "job-a" });
		expect(r.at(T0 + 201)).toEqual({ job: "job-b" }); // implicit stop of a at the same ts
		expect(r.at(T0 + 301)).toEqual({});
	});
});

describe("test 3 — stale, foreign or corrupt state is invalid, never a guess", () => {
	const cases: Array<[string, string]> = [
		["a sid mismatch", start(SID, T0) + op("other", T0 + 1, "start", "job-a")],
		["no session-start first", op(SID, T0, "start", "job-a")],
		["interior corruption", `${start(SID, T0)}not json\n${op(SID, T0 + 5, "start", "job-a")}`],
		[
			"out-of-order lines",
			start(SID, T0) + op(SID, T0 + 9, "start", "job-a") + op(SID, T0 + 1, "stop", null),
		],
		["an unknown op", start(SID, T0) + op(SID, T0 + 1, "pause", null)],
		["a bad job id", start(SID, T0) + op(SID, T0 + 1, "start", "bad id")],
		["a repeated session-start", start(SID, T0) + start(SID, T0 + 1)],
		[
			"a ts that is no real instant (Feb 31)",
			`${start(SID, T0)}${line({ sid: SID, ts: "2026-02-31T00:00:00.000Z", op: "start", job: "job-a" })}`,
		],
	];
	it.each(cases)("%s → no job and jobState invalid", async (_name, text) => {
		await writeLog(text);
		const { resolveJob } = await lib();
		expect((await resolveJob(SID)).at(T0 + 1000)).toEqual({ jobState: "invalid" });
	});
	it("a log for ANOTHER session — even a newer file — is never read", async () => {
		await writeLog(start(SID, T0) + op(SID, T0 + 1, "start", "job-a"));
		await writeLog(start("other", T0) + op("other", T0 + 1, "start", "job-z"), "other");
		await utimes(logFile("other"), new Date(), new Date(Date.now() + 5000));
		const { resolveJob } = await lib();
		expect((await resolveJob(SID)).at(T0 + 100)).toEqual({ job: "job-a" });
		// and a session with NO file is none, not the newest file's job
		expect((await resolveJob("missing")).at(T0 + 100)).toEqual({});
	});
});

describe("test 4 — a torn tail is not corruption", () => {
	it("an unterminated final line is ignored", async () => {
		await writeLog(
			`${start(SID, T0)}${op(SID, T0 + 1, "start", "job-a")}{"sid":"sess-1","ts":"2026`,
		);
		const { resolveJob } = await lib();
		expect((await resolveJob(SID)).at(T0 + 100)).toEqual({ job: "job-a" });
	});
	it("only a torn first line is 'not yet written'", async () => {
		await writeLog('{"sid":"sess-1","ts":');
		const { resolveJob } = await lib();
		expect((await resolveJob(SID)).at(T0)).toEqual({});
	});
});

describe("test 5 — the lock", () => {
	it("a writer WAITS for a live holder and appends after it lets go", async () => {
		await writeLog(start(SID, T0));
		await writeFile(`${logFile()}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
		const { appendJobOp } = await lib();
		let done = false;
		const pending = appendJobOp(SID, "start", "job-a", { waitMs: 1000 }).then((r) => {
			done = true;
			return r;
		});
		await new Promise((r) => setTimeout(r, 400));
		expect(done).toBe(false);
		expect((await readFile(logFile(), "utf-8")).split("\n").filter(Boolean)).toHaveLength(1);
		await (await import("node:fs/promises")).unlink(`${logFile()}.lock`);
		expect((await pending).ok).toBe(true);
		expect((await readFile(logFile(), "utf-8")).split("\n").filter(Boolean)).toHaveLength(2);
	});
	it("a lock whose holder is dead is broken", async () => {
		await writeLog(start(SID, T0));
		await writeFile(`${logFile()}.lock`, JSON.stringify({ pid: 2 ** 31 - 2, ts: Date.now() }));
		const { appendJobOp } = await lib();
		expect((await appendJobOp(SID, "start", "job-a", { waitMs: 1000 })).ok).toBe(true);
	});
	it("a lock older than 10 s is broken even for a live pid", async () => {
		await writeLog(start(SID, T0));
		await writeFile(
			`${logFile()}.lock`,
			JSON.stringify({ pid: process.pid, ts: Date.now() - 11_000 }),
		);
		const { appendJobOp } = await lib();
		expect((await appendJobOp(SID, "start", "job-a", { waitMs: 1000 })).ok).toBe(true);
	});
	it("simultaneous CLI starts leave a monotonic, valid log", async () => {
		await writeLog(start(SID, Date.now()));
		const ids = Array.from({ length: 8 }, (_, i) => `job-${i}`);
		const results = await Promise.all(
			ids.map((id) =>
				cli(["start", id], { CLAUDE_CODE_SESSION_ID: SID, UT_CC_JOB_WAIT_MS: "3000" }),
			),
		);
		expect(results.map((r) => r.code)).toEqual(ids.map(() => 0));
		const { parseJobLog } = await lib();
		const parsed = parseJobLog(await readFile(logFile(), "utf-8"), SID);
		expect(parsed.state).toBe("ok");
		if (parsed.state === "ok") expect(parsed.events).toHaveLength(1 + ids.length);
	});
});

describe("test 11 (R2-A) — a wrong id is refused after the wait, and nothing is written", () => {
	it("waits the full 10 s, exits non-zero, names the fix, and creates no file", async () => {
		const began = Date.now();
		const r = await cli(["start", "job-a"], { CLAUDE_CODE_SESSION_ID: "never-started" });
		expect(Date.now() - began).toBeGreaterThanOrEqual(9_500);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("no job log for this session id");
		expect(r.stderr).toContain("--resume <id>");
		expect(await readdir(join(state, "jobs")).catch(() => [])).toEqual([]);
	}, 20_000);
	it("a missing session id refuses (2) and writes nothing", async () => {
		const r = await cli(["start", "job-a"], {});
		expect(r.code).toBe(2);
		expect(await readdir(join(state, "jobs")).catch(() => [])).toEqual([]);
	});
	it("a bad job id refuses (2)", async () => {
		await writeLog(start(SID, T0));
		const r = await cli(["start", "has space"], { CLAUDE_CODE_SESSION_ID: SID });
		expect(r.code).toBe(2);
	});
});

async function sessionStart(source: string, sid = SID) {
	return runHook(
		join(HOOKS, "session-start.mjs"),
		{ session_id: sid, source },
		{ UT_CC_STATE_DIR: state },
	);
}

describe("test 14 (R2-D) — SessionStart sources and the race", () => {
	it("startup, clear and fork each start a NEW log with no job", async () => {
		for (const source of ["startup", "clear", "fork"]) {
			const sid = `sid-${source}`;
			await sessionStart(source, sid);
			const { resolveJob } = await lib();
			const r = await resolveJob(sid);
			expect(r.parsed.state).toBe("ok");
			expect(r.at(Date.now() + 1000)).toEqual({});
		}
	});
	it("compact and resume mid-job keep the job open and the log valid", async () => {
		await sessionStart("startup");
		const j = await cli(["start", "job-a"], {
			CLAUDE_CODE_SESSION_ID: SID,
			UT_CC_JOB_WAIT_MS: "2000",
		});
		expect(j.code).toBe(0);
		const before = await readFile(logFile(), "utf-8");
		await sessionStart("compact");
		await sessionStart("resume");
		expect(await readFile(logFile(), "utf-8")).toBe(before);
		const { resolveJob } = await lib();
		expect((await resolveJob(SID)).at(Date.now() + 1000)).toEqual({ job: "job-a" });
	});
	it("resume or compact with NO log writes none (an existing id never mints a log)", async () => {
		await sessionStart("resume", "old-id");
		await sessionStart("compact", "old-id");
		expect(await readdir(join(state, "jobs")).catch(() => [])).toEqual([]);
	});
	it("a CLI start issued BEFORE the background SessionStart lands succeeds once it lands", async () => {
		const pending = cli(["start", "job-a"], {
			CLAUDE_CODE_SESSION_ID: SID,
			UT_CC_JOB_WAIT_MS: "10000",
		});
		await new Promise((r) => setTimeout(r, 1200));
		await sessionStart("startup");
		const r = await pending;
		expect(r.code).toBe(0);
		const { parseJobLog } = await lib();
		const parsed = parseJobLog(await readFile(logFile(), "utf-8"), SID);
		expect(parsed.state).toBe("ok");
		if (parsed.state === "ok")
			expect(parsed.events.map((e) => e.op)).toEqual(["session-start", "start"]);
	}, 20_000);
});

describe("jobCoverage — a diagnostic, not a certification", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const rec = (extra: Record<string, unknown>, kind = "llm_call") => ({
		kind,
		actor: `claude-code:${SID}:main:main`,
		data: {
			transferId: `tx_${Math.random()}`,
			cost: 7,
			principal: { origin: `claude-code:${SID}` },
			...extra,
		},
	});
	const inside = { usageFrom: iso(T0 + 2000), usageTo: iso(T0 + 3000) };

	it("no known gaps: tagged records inside the interval, nothing untagged overlapping", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				rec({ job: J, usageFrom: iso(T0 + 3500), usageTo: iso(T0 + 4000) }),
			],
		});
		expect(r).toMatchObject({ knownGaps: [], taggedCostUt: "14" });
		expect(r.transferIds).toHaveLength(2);
	});
	it("test 12 (R2-B) — an empty interval has a known gap", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({ job: J, logs: { [SID]: logText }, records: [] });
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("no record of bug-1");
	});
	it("test 13 (R2-C) — a late untagged remainder, appended AFTER stop, has a known gap", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				// Untagged, usage inside the interval; its append time (after stop) is never read.
				rec({ usageFrom: iso(T0 + 2500), usageTo: iso(T0 + 2600), appendedAt: iso(T0 + 9000) }),
			],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("carries no job");
	});
	it("test 13 — a record with no usageFrom in a capable session counts as untagged", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [rec({ job: J, ...inside }), rec({})],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("no complete usage window");
	});
	it("an invalid job state anywhere in the interval has a known gap", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				rec({ jobState: "invalid", usageFrom: iso(T0 + 2500) }),
			],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
	});
	it("test 9 (F3) — a silent strip: records untagged because the server dropped the fields have known gaps", async () => {
		const { jobCoverage } = await lib();
		// The plugin believed the (cached) capability and sent job; the downgraded server
		// stripped it: the records carry neither job nor usage times.
		const r = jobCoverage({ job: J, logs: { [SID]: logText }, records: [rec({}), rec({})] });
		expect(r.knownGaps.length).toBeGreaterThan(0);
	});
	it("a missing or invalid log has a known gap", async () => {
		const { jobCoverage } = await lib();
		expect(
			jobCoverage({ job: J, logs: {}, records: [rec({ job: J, ...inside })] }).knownGaps.length,
		).toBeGreaterThan(0);
		const bad = jobCoverage({
			job: J,
			logs: { [SID]: `${logText}garbage\n${logText}` },
			records: [rec({ job: J, ...inside })],
		});
		expect(bad.knownGaps.length).toBeGreaterThan(0);
	});
	it("a job split across two sessions needs BOTH sessions checked", async () => {
		const { jobCoverage } = await lib();
		const sid2 = "sess-2";
		const logs = {
			[SID]: logText,
			[sid2]: start(sid2, T0) + op(sid2, T0 + 1000, "start", J),
		};
		const r = jobCoverage({ job: J, logs, records: [rec({ job: J, ...inside })] });
		expect(r.knownGaps.length).toBeGreaterThan(0); // sess-2's interval has no record
		expect(gapText(r)).toContain("sess-2");
	});
});

describe("jobCoverage — review hardening", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const inside = { usageFrom: iso(T0 + 2000), usageTo: iso(T0 + 3000) };
	const rec = (extra: Record<string, unknown>, kind = "llm_call", sid = SID) => ({
		kind,
		actor: `claude-code:${sid}:main:main`,
		data: { transferId: "tx_1", cost: 17, principal: { origin: `claude-code:${sid}` }, ...extra },
	});

	it("counts a transfer ONCE: settlement_ambiguous beside its llm_call is not a second spend", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [rec({ job: J, ...inside }), rec({ job: J, ...inside }, "settlement_ambiguous")],
		});
		expect(r.taggedCostUt).toBe("17");
		expect(r.transferIds).toEqual(["tx_1"]);
	});

	it("a contributing session with NO supplied log has a known gap", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				rec({ job: J, transferId: "tx_2", ...inside }, "llm_call", "sess-b"),
			],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain(
			"session sess-b: a record of bug-1 has no usable job log to be placed by",
		);
	});

	it("a contributing session whose log is empty (unreadable) has a known gap", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText, "sess-b": "" },
			records: [
				rec({ job: J, ...inside }),
				rec({ job: J, transferId: "tx_2", ...inside }, "llm_call", "sess-b"),
			],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("sess-b");
	});

	it("an llm_call with usageFrom but no usageTo has a known gap (its end could reach the interval)", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [rec({ job: J, ...inside }), rec({ transferId: "tx_2", usageFrom: iso(T0 + 500) })],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("no complete usage window");
	});

	it("a record with only a usageFrom (a release) cannot be the positive evidence", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [rec({ job: J, usageFrom: iso(T0 + 2000) }, "hold_released")],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("no record of bug-1");
	});
});

describe("jobCoverage — connector review", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const inside = { usageFrom: iso(T0 + 2000), usageTo: iso(T0 + 3000) };
	const rec = (extra: Record<string, unknown>, id = "tx_1") => ({
		kind: "llm_call",
		actor: `claude-code:${SID}:main:main`,
		data: { transferId: id, cost: 5, principal: { origin: `claude-code:${SID}` }, ...extra },
	});

	it("a call inside the interval booked to ANOTHER job has a known gap (it is missing from the total)", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				rec({ job: "bug-2", usageFrom: iso(T0 + 3500), usageTo: iso(T0 + 4000) }, "tx_2"),
			],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("carries another job");
	});

	it("a call tagged to the job but AFTER its stop has a known gap (it is in the total, outside the interval)", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				rec({ job: J, usageFrom: iso(T0 + 6000), usageTo: iso(T0 + 7000) }, "tx_2"),
			],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("lies outside its intervals");
	});

	it("an interval is (start, stop]: a call ending exactly at the start belongs to the earlier job", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				rec({ job: "bug-0", usageFrom: iso(T0 + 500), usageTo: iso(T0 + 1000) }, "tx_2"),
			],
		});
		expect(r.knownGaps.length).toBe(0);
	});
});

describe("jobCoverage — refused and unmetered work", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const inside = { usageFrom: iso(T0 + 2000), usageTo: iso(T0 + 3000) };
	const ok = {
		kind: "llm_call",
		actor: `claude-code:${SID}:main:main`,
		data: {
			transferId: "tx_1",
			cost: 5,
			job: J,
			principal: { origin: `claude-code:${SID}` },
			...inside,
		},
	};

	it("a policy_denied or ledger_rejected record of the job has a known gap (its usage is unrecorded)", async () => {
		const { jobCoverage } = await lib();
		for (const kind of ["policy_denied", "ledger_rejected"]) {
			const r = jobCoverage({
				job: J,
				logs: { [SID]: logText },
				records: [
					ok,
					{
						kind,
						actor: ok.actor,
						data: { job: J, usageFrom: iso(T0 + 3500), principal: ok.data.principal },
					},
				],
			});
			expect(r.knownGaps.length, kind).toBeGreaterThan(0);
			expect(gapText(r)).toContain("was denied");
		}
	});
	it("a watch would_block naming the job has a known gap", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [ok],
			watch: [{ kind: "would_block", job: J, session: SID, at: iso(T0 + 3500) }],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("would_block");
	});
	it("a gap (an unmetered call) INSIDE the interval has a known gap; outside it is irrelevant", async () => {
		const { jobCoverage } = await lib();
		const base = { job: J, logs: { [SID]: logText }, records: [ok] };
		const inGap = jobCoverage({
			...base,
			watch: [{ kind: "gap", session: SID, at: iso(T0 + 3500) }],
		});
		expect(inGap.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(inGap)).toContain("a gap fell inside an interval");
		const outGap = jobCoverage({
			...base,
			watch: [{ kind: "gap", session: SID, at: iso(T0 + 9000) }],
		});
		expect(outGap.knownGaps.length).toBe(0);
		// A gap from a session with a VALID log that had a different job (or none) open is
		// positively attributed elsewhere.
		const zLog = start("sess-z", T0) + op("sess-z", T0 + 1000, "start", "bug-9");
		const elsewhere = jobCoverage({
			...base,
			logs: { [SID]: logText, "sess-z": zLog },
			watch: [{ kind: "gap", session: "sess-z", at: iso(T0 + 3500) }],
		});
		expect(elsewhere.knownGaps.length).toBe(0);
	});
});

describe("jobCoverage — watch events whose job cannot be resolved", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const ok = {
		kind: "llm_call",
		actor: `claude-code:${SID}:main:main`,
		data: {
			transferId: "tx_1",
			cost: 5,
			job: J,
			principal: { origin: `claude-code:${SID}` },
			usageFrom: iso(T0 + 2000),
			usageTo: iso(T0 + 3000),
		},
	};
	const inside = iso(T0 + 3500);
	const run = async (watch: unknown[], logs: Record<string, string> = { [SID]: logText }) =>
		(await lib()).jobCoverage({ job: J, logs, records: [ok], watch });

	it("probe 1: a gap from a session whose log is MISSING may belong to the job", async () => {
		expect(
			(await run([{ kind: "gap", session: "sess-z", started: inside }])).knownGaps.length,
		).toBeGreaterThan(0);
		const r = await run([{ kind: "gap", session: "sess-z", started: inside }]);
		expect(gapText(r)).toContain("cannot be attributed to a job (session sess-z has no job log)");
		// positive control: the same event in S1, whose log has the job open then, flips it
		expect(
			(await run([{ kind: "gap", session: SID, started: inside }])).knownGaps.length,
		).toBeGreaterThan(0);
		// ...and from a session with a valid log that had ANOTHER job open, it does not
		const other = start("sess-z", T0) + op("sess-z", T0 + 1000, "start", "bug-9");
		expect(
			(
				await run([{ kind: "gap", session: "sess-z", started: inside }], {
					[SID]: logText,
					"sess-z": other,
				})
			).knownGaps.length,
		).toBe(0);
	});
	it("probe 1b: ...or whose log is INVALID or empty", async () => {
		for (const bad of ["", "garbage\n"]) {
			const r = await run([{ kind: "gap", session: "sess-z", started: inside }], {
				[SID]: logText,
				"sess-z": bad,
			});
			expect(r.knownGaps.length, JSON.stringify(bad)).toBeGreaterThan(0);
			expect(gapText(r)).toContain("has no usable job log");
		}
	});
	it("probe 2: a would_block labelled jobState invalid is resolved through its session's log", async () => {
		const w = { kind: "would_block", jobState: "invalid", session: SID, started: inside };
		const r = await run([w]);
		expect(r.knownGaps.length).toBeGreaterThan(0); // mutant: ignored because it carries no job
		expect(gapText(r)).toContain("a would_block fell inside an interval");
		// no usable log for its session: unresolved, so a known gap for every job
		expect((await run([{ ...w, session: "sess-z" }])).knownGaps.length).toBeGreaterThan(0);
		// positive control: attributed to another job through a valid log
		const other = start("sess-z", T0) + op("sess-z", T0 + 1000, "start", "bug-9");
		expect(
			(await run([{ ...w, session: "sess-z" }], { [SID]: logText, "sess-z": other })).knownGaps
				.length,
		).toBe(0);
	});
	it("probe 3: a would_block with NO job label inside the interval is not ignored", async () => {
		const w = { kind: "would_block", session: SID, started: inside };
		expect((await run([w])).knownGaps.length).toBeGreaterThan(0); // mutant: only labelled would_blocks count
		// outside the interval it is positively attributed to no job
		expect((await run([{ ...w, started: iso(T0 + 9000) }])).knownGaps.length).toBe(0);
	});
	it("an event that names no session or has no readable time is unresolved", async () => {
		expect((await run([{ kind: "gap", started: inside }])).knownGaps.length).toBeGreaterThan(0);
		expect(
			(await run([{ kind: "gap", session: SID, started: "never" }])).knownGaps.length,
		).toBeGreaterThan(0);
	});
});

describe("jobCoverage — deny by default", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const principal = { origin: `claude-code:${SID}` };
	const ok = {
		kind: "llm_call",
		actor: `claude-code:${SID}:main:main`,
		data: {
			transferId: "tx_1",
			cost: 5,
			job: J,
			principal,
			usageFrom: iso(T0 + 2000),
			usageTo: iso(T0 + 3000),
		},
	};
	const other = (kind: string, data: Record<string, unknown>) => ({
		kind,
		actor: ok.actor,
		data: { principal, ...data },
	});

	it("a denial carrying jobState invalid and no job, inside the interval, has a known gap", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [ok, other("policy_denied", { jobState: "invalid", usageFrom: iso(T0 + 3500) })],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("a policy_denied record lies in an interval");
	});
	it("a record of a kind it does not know, inside the interval, has a known gap", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [ok, other("some_future_kind", { usageFrom: iso(T0 + 3500) })],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
	});
	it("a give-back (hold_released) inside the interval is harmless", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				ok,
				other("hold_released", {
					job: J,
					transferId: "tx_9",
					releaseClass: "unused",
					usageFrom: iso(T0 + 3500),
				}),
			],
		});
		expect(r.knownGaps.length).toBe(0);
	});
	it("a record outside every interval is not this job's business", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [ok, other("policy_denied", { usageFrom: iso(T0 + 9000) })],
		});
		expect(r.knownGaps.length).toBe(0);
	});
});

describe("jobCoverage — watch evidence", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const ok = {
		kind: "llm_call",
		actor: `claude-code:${SID}:main:main`,
		data: {
			transferId: "tx_1",
			cost: 5,
			job: J,
			principal: { origin: `claude-code:${SID}` },
			usageFrom: iso(T0 + 2000),
			usageTo: iso(T0 + 3000),
		},
	};
	it("a gap is placed by when its call STARTED, not when its record was written", async () => {
		const { jobCoverage } = await lib();
		const gap = { kind: "gap", session: SID, started: iso(T0 + 3000), at: iso(T0 + 9000) };
		const r = jobCoverage({ job: J, logs: { [SID]: logText }, records: [ok], watch: [gap] });
		expect(r.knownGaps.length).toBeGreaterThan(0); // mutant: reads `at` → after the stop → no gap reported
		expect(gapText(r)).toContain("a gap fell inside an interval");
	});
	it("an unreadable watch line reports a known gap", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [ok],
			watch: [{ kind: "unreadable" }],
		});
		expect(r.knownGaps.length).toBeGreaterThan(0);
	});
});

describe("usertrust-job coverage — the CLI", () => {
	const J = "bug-1";
	async function fixture(watch?: string | null) {
		const vault = join(state, "vault");
		await mkdir(join(vault, "audit"), { recursive: true });
		await writeFile(
			join(vault, "audit", "events.jsonl"),
			`${JSON.stringify({
				kind: "llm_call",
				actor: `claude-code:${SID}:main:main`,
				data: {
					transferId: "tx_1",
					cost: 5,
					job: J,
					principal: { origin: `claude-code:${SID}` },
					usageFrom: iso(T0 + 2000),
					usageTo: iso(T0 + 3000),
				},
			})}\n`,
		);
		await writeLog(
			start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null),
		);
		const args = ["coverage", J, "--vault", vault];
		if (watch !== undefined && watch !== null) {
			const file = join(state, "watch-test.jsonl");
			await writeFile(file, watch);
			args.push("--watch", file);
			return { args, file };
		}
		args.push("--watch", join(state, "no-such-watch.jsonl"));
		return { args, file: null };
	}
	const out = (r: { stdout: string }) =>
		JSON.parse(r.stdout) as { knownGaps: unknown[]; note: string };

	it("no watch file is no watch records: no known gaps", async () => {
		const { args } = await fixture();
		const r = await cliOut(args);
		expect(r.code).toBe(0);
		expect(out(r).knownGaps.length).toBe(0);
	});
	it("a watch line it cannot read reports a known gap", async () => {
		const { args } = await fixture('{"kind":"gap","sess');
		const r = await cliOut(args);
		expect(out(r).knownGaps.length).toBeGreaterThan(0); // mutant: the torn line is skipped → no gap reported
	});
	it("a watch file that exists but cannot be read is NO verdict (exit 1), always a known gap", async () => {
		const { args, file } = await fixture("{}\n");
		await chmod(file as string, 0o000);
		const r = await cliOut(args);
		await chmod(file as string, 0o600);
		// mutant: every read error is treated as 'no file' → no gap reported
		expect(r.code).toBe(1);
		expect(r.stdout).toBe("");
	});
});

describe("jobCoverage — sessions that could not attribute their usage", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const ok = {
		kind: "llm_call",
		actor: `claude-code:${SID}:main:main`,
		data: {
			transferId: "tx_1",
			cost: 5,
			job: J,
			principal: { origin: `claude-code:${SID}` },
			usageFrom: iso(T0 + 2000),
			usageTo: iso(T0 + 3000),
		},
	};
	const unattributed = {
		kind: "llm_call",
		actor: "claude-code:sess-b:main:main",
		data: {
			transferId: "tx_2",
			cost: 9,
			jobState: "invalid",
			principal: { origin: "claude-code:sess-b" },
			usageFrom: iso(T0 + 2000),
			usageTo: iso(T0 + 3000),
		},
	};
	it("another session whose records are jobState invalid and whose log is missing has a known gap", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({ job: J, logs: { [SID]: logText }, records: [ok, unattributed] });
		expect(r.knownGaps.length).toBeGreaterThan(0); // mutant: only sessions with a record of the job are checked
		expect(gapText(r)).toContain("sess-b");
	});
	it("a boundary written in the very millisecond a call began still clamps its window", async () => {
		await writeLog(
			start(SID, T0) + op(SID, T0 + 100, "start", "job-a") + op(SID, T0 + 500, "start", "job-b"),
		);
		const { resolveJob } = await lib();
		const jobs = (await resolveJob(SID)) as unknown as { boundaryAfter(t: number): number | null };
		expect(jobs.boundaryAfter(T0 + 500)).toBe(T0 + 500); // mutant: strictly after → null
		expect(jobs.boundaryAfter(T0 + 501)).toBeNull();
	});
});

describe("jobCoverage — reconciliation, both ways", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const call = (sid: string, data: Record<string, unknown>) => ({
		kind: "llm_call",
		actor: `claude-code:${sid}:main:main`,
		data: {
			transferId: `tx_${sid}_${String(data.usageFrom)}`,
			cost: 5,
			principal: { origin: `claude-code:${sid}` },
			usageFrom: iso(T0 + 2000),
			usageTo: iso(T0 + 3000),
			...data,
		},
	});
	const s1 = call(SID, { job: J });
	const other = start("sess-2", T0) + op("sess-2", T0 + 1000, "start", "bug-9");
	const run = async (records: unknown[], logs: Record<string, string>, watch: unknown[] = []) =>
		(await lib()).jobCoverage({ job: J, logs, records, watch });

	it("clause 1: a call TAGGED with the job in a session whose valid log has no interval of it is outside", async () => {
		const r = await run([s1, call("sess-2", { job: J })], { [SID]: logText, "sess-2": other });
		expect(r.knownGaps.length).toBeGreaterThan(0); // mutant: sessions with no interval of the job are skipped
		expect(gapText(r)).toContain("lies outside its intervals (the session has none)");
		// positive control: a clean session has no known gaps
		expect((await run([s1], { [SID]: logText })).knownGaps.length).toBe(0);
	});
	it("clause 1: ...or whose log is missing", async () => {
		const r = await run([s1, call("sess-2", { job: J })], { [SID]: logText });
		expect(r.knownGaps.length).toBeGreaterThan(0);
	});
	it("clause 2: an UNTAGGED call from a session with no log, reaching the job's intervals, is unresolved", async () => {
		const r = await run([s1, call("sess-2", {})], { [SID]: logText });
		expect(r.knownGaps.length).toBeGreaterThan(0); // mutant: records of log-less sessions are not examined
		expect(gapText(r)).toContain("cannot be placed (no usable job log)");
	});
	it("clause 2: an untagged call in a session WITH a valid log, outside every interval, has no known gaps", async () => {
		const before = call(SID, { usageFrom: iso(T0 + 100), usageTo: iso(T0 + 900) });
		expect((await run([s1, before], { [SID]: logText })).knownGaps.length).toBe(0);
	});
	it("unbounded: a log-less gap BETWEEN two jobs' intervals gives both a known gap", async () => {
		const both =
			start(SID, T0) +
			op(SID, T0 + 1000, "start", "bug-1") +
			op(SID, T0 + 3000, "start", "bug-2") +
			op(SID, T0 + 6000, "stop", null);
		const { jobCoverage } = await lib();
		const gap = { kind: "gap", session: "sess-z", started: iso(T0 + 3000) };
		for (const [id, w] of [
			["bug-1", [T0 + 1500, T0 + 2500]],
			["bug-2", [T0 + 3500, T0 + 5500]],
		] as const) {
			const record = call(SID, { job: id, usageFrom: iso(w[0]), usageTo: iso(w[1]) });
			expect(
				jobCoverage({ job: id, logs: { [SID]: both }, records: [record] }).knownGaps.length,
				`${id} clean`,
			).toBe(0);
			const r = jobCoverage({ job: id, logs: { [SID]: both }, records: [record], watch: [gap] });
			expect(r.knownGaps.length, `${id} with a log-less gap`).toBeGreaterThan(0);
		}
	});
});

describe("jobCoverage — transfers, and the evidence being there at all", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const principal = { origin: `claude-code:${SID}` };
	const call = {
		kind: "llm_call",
		actor: `claude-code:${SID}:main:main`,
		data: {
			transferId: "tx_1",
			cost: 7,
			job: J,
			principal,
			usageFrom: iso(T0 + 2000),
			usageTo: iso(T0 + 3000),
		},
	};
	const meta = (kind: string, transferId: string) => ({
		kind,
		actor: call.actor,
		data: { ...call.data, transferId, cost: 20 },
	});
	const run = async (records: unknown[], watch: unknown[] = [], logs = { [SID]: logText }) =>
		(await lib()).jobCoverage({ job: J, logs, records, watch });

	it.each(["settlement_shortfall", "settlement_ambiguous", "llm_call_failed"])(
		"clause 3: a transfer known only through %s metadata has a known gap (never costed as 0)",
		async (kind) => {
			const r = await run([call, meta(kind, "tx_2")]);
			expect(r.knownGaps.length).toBeGreaterThan(0); // mutant: a transfer without an llm_call counts as 0
			expect(gapText(r)).toContain("known only through its settlement metadata");
			// positive control: the same metadata BESIDE its llm_call is one charge
			expect((await run([call, meta(kind, "tx_1")])).knownGaps.length).toBe(0);
		},
	);
	it("clause 3: two llm_calls for one transfer are not one charge", async () => {
		const r = await run([call, { ...call }]);
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("has 2 llm_calls");
	});
	describe("clause 3: a transfer with no llm_call needs POSITIVE proof that no usage happened", () => {
		const given = (extra: Record<string, unknown>) => ({
			kind: "hold_released",
			actor: call.actor,
			data: { ...call.data, transferId: "tx_9", usageTo: undefined, ...extra },
		});
		it("a structured releaseClass `unused` is the proof (the control: has no known gaps)", async () => {
			expect((await run([call, given({ releaseClass: "unused" })])).knownGaps.length).toBe(0);
		});
		it.each(["call-ran", "call-unconfirmed"])(
			"releaseClass %s is not proof",
			async (releaseClass) => {
				const r = await run([call, given({ releaseClass })]);
				expect(r.knownGaps.length).toBeGreaterThan(0); // mutant: any hold_released counts as unused
				expect(gapText(r)).toContain("released without proof that no usage happened");
			},
		);
		it("a release that states NO class is not proof (an expiry, a shutdown, an older client)", async () => {
			const r = await run([call, given({})]);
			expect(r.knownGaps.length).toBeGreaterThan(0);
			expect(gapText(r)).toContain("(releaseClass none)");
		});
		it("the free-text reason alone is never proof", async () => {
			for (const reason of [
				"session ended with unsettled hold",
				"session ended after an unanswered settle",
				"no transcript usage was assigned to this hold",
				"unused",
			]) {
				expect((await run([call, given({ reason })])).knownGaps.length, reason).toBeGreaterThan(0);
			}
		});
	});
	it("a labelled would_block of the job is always a known gap, wherever it happened", async () => {
		const w = { kind: "would_block", job: J, session: SID, started: iso(T0 + 9000) };
		expect((await run([call], [w])).knownGaps.length).toBeGreaterThan(0);
	});
	it("no records and no logs has a known gap (nothing proves anything)", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({ job: J, logs: {}, records: [] });
		expect(r.knownGaps.length).toBeGreaterThan(0);
		expect(gapText(r)).toContain("no session log has an interval");
	});
	it("an invalid log that names the job is reported by name", async () => {
		const r = await run([call], [], { [SID]: `${logText}garbage\n` });
		expect(gapText(r)).toContain("the job log is invalid");
	});
});

describe("keyAt — unlabelled stretches are distinct", () => {
	it("the time before `start a` and the time after `stop` are two stretches", async () => {
		await writeLog(
			start(SID, T0) + op(SID, T0 + 1000, "start", "job-a") + op(SID, T0 + 5000, "stop", null),
		);
		const { resolveJob } = await lib();
		const jobs = (await resolveJob(SID)) as unknown as { keyAt(t: number): string };
		const before = jobs.keyAt(T0 + 500);
		const during = jobs.keyAt(T0 + 2000);
		const after = jobs.keyAt(T0 + 6000);
		expect(new Set([before, during, after]).size).toBe(3); // mutant: both unlabelled are "none"
		expect(jobs.keyAt(T0 + 7000)).toBe(after);
		expect(jobs.keyAt(T0 + 600)).toBe(before);
	});
});

describe("usertrust-job coverage — an unreadable vault is no verdict, said through the scrubber", () => {
	it("a missing --vault holding escape bytes is reported without them, exit 1", async () => {
		const hostile = `${state}/gone\u001b[2J\u001b]0;pwned\u0007\u009b`;
		const r = await cliOut(["coverage", "bug-1", "--vault", hostile]);
		expect(r.code).toBe(1); // mutant: the rejection escapes and Node prints the path raw
		expect(r.stdout).toBe("");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none reach the terminal is the point
		expect(r.stderr).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
		expect(r.stderr).toContain("no verdict");
	});
});

describe("jobCoverage — a diagnostic: known gaps, never a verdict", () => {
	const J = "bug-1";
	const closed = start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const running = start(SID, T0) + op(SID, T0 + 1000, "start", J);
	const principal = { origin: `claude-code:${SID}` };
	const call = {
		kind: "llm_call",
		actor: `claude-code:${SID}:main:main`,
		data: {
			transferId: "tx_1",
			cost: 7,
			job: J,
			principal,
			usageFrom: iso(T0 + 2000),
			usageTo: iso(T0 + 3000),
		},
	};
	const run = async (logs: Record<string, string>, records: unknown[] = [call], extra = {}) =>
		(await lib()).jobCoverage({ job: J, logs, records, ...extra }) as unknown as Record<
			string,
			unknown
		> & {
			knownGaps: Array<{ gap: string; evidence: Record<string, unknown> }>;
		};

	it("a clean report has an empty knownGaps list, the tagged cost, and says it is not a verdict", async () => {
		const r = await run({ [SID]: closed });
		expect(r.knownGaps).toEqual([]);
		expect(r).toMatchObject({ taggedCostUt: "7", diagnostic: true });
		expect(String(r.note)).toContain("does not mean it is complete");
	});
	it("no output anywhere claims a job cost is exact or certified", async () => {
		for (const r of [await run({ [SID]: closed }), await run({}, [])]) {
			expect(Object.keys(r)).not.toContain("exact");
			expect(JSON.stringify(r)).not.toMatch(/\bexact\b|certified|verified|green/i);
		}
	});
	it("each known gap carries the evidence behind it", async () => {
		const r = await run({ [SID]: running });
		expect(r.knownGaps.length).toBeGreaterThan(0);
		for (const g of r.knownGaps) {
			expect(typeof g.gap).toBe("string");
			expect(typeof g.evidence).toBe("object");
		}
	});
	it("an interval with no stop yet is a known gap: the job is still running", async () => {
		const r = await run({ [SID]: running });
		expect(gapText(r)).toContain("job still running: in-flight holds are not yet settled");
		expect(r.knownGaps.find((g) => g.gap.startsWith("job still running"))?.evidence).toEqual({
			session: SID,
		});
		// control: the same job, stopped, has none
		expect(gapText(await run({ [SID]: closed }))).not.toContain("still running");
	});
	it("an audit line that could not be parsed is incomplete evidence, never a silent drop", async () => {
		const r = await run({ [SID]: closed }, [call], { unreadable: { audit: 2 } });
		expect(gapText(r)).toContain("evidence incomplete: 2 audit line(s) could not be parsed");
		expect((await run({ [SID]: closed }, [call], { unreadable: { audit: 0 } })).knownGaps).toEqual(
			[],
		);
	});
	it("a log-less session's usage at ANY time is a gap for every job (the set it could belong to is unbounded)", async () => {
		const s2 =
			start("sess-2", T0) +
			op("sess-2", T0 + 8000, "start", J) +
			op("sess-2", T0 + 9000, "stop", null);
		const at = (from: number, to: number) => ({
			kind: "llm_call",
			actor: "claude-code:sess-3:main:main",
			data: {
				transferId: "tx_3",
				cost: 4,
				principal: { origin: "claude-code:sess-3" },
				usageFrom: iso(T0 + from),
				usageTo: iso(T0 + to),
			},
		});
		for (const [from, to] of [
			[6000, 7000], // between two sessions' intervals
			[100, 200], // before the job began
			[40_000, 41_000], // long after it ended
		] as Array<[number, number]>) {
			const r = await run({ [SID]: closed, "sess-2": s2 }, [call, at(from, to)]);
			expect(gapText(r), `${from}`).toContain(
				"session sess-3: a llm_call cannot be placed (no usable job log)",
			);
		}
		// control: the same call from a session that HAS a valid log, outside every interval, is placed
		const withLog = { "sess-3": start("sess-3", T0) };
		expect(
			gapText(await run({ [SID]: closed, "sess-2": s2, ...withLog }, [call, at(100, 200)])),
		).not.toContain("sess-3");
	});
	it("a released hold whose usage is unconfirmed is a named gap", async () => {
		const given = {
			kind: "hold_released",
			actor: call.actor,
			data: { ...call.data, transferId: "tx_9", usageTo: undefined },
		};
		expect(gapText(await run({ [SID]: closed }, [call, given]))).toContain(
			"released without proof that no usage happened",
		);
	});
});

describe("usertrust-job coverage — the CLI reports gaps, not a verdict", () => {
	it("prints knownGaps and no exact/certified claim; an unparseable audit line is reported", async () => {
		const J = "bug-1";
		const vault = join(state, "vault2");
		await mkdir(join(vault, "audit"), { recursive: true });
		await writeFile(
			join(vault, "audit", "events.jsonl"),
			`${JSON.stringify({ kind: "llm_call", actor: `claude-code:${SID}:main:main`, data: { transferId: "tx_1", cost: 5, job: J, principal: { origin: `claude-code:${SID}` }, usageFrom: iso(T0 + 2000), usageTo: iso(T0 + 3000) } })}\n{"kind":"llm_c\n`,
		);
		await writeLog(
			start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null),
		);
		const r = await cliOut(["coverage", J, "--vault", vault, "--watch", join(state, "none.jsonl")]);
		expect(r.code).toBe(0);
		const out = JSON.parse(r.stdout) as { knownGaps: Array<{ gap: string }>; taggedCostUt: string };
		expect(out.taggedCostUt).toBe("5");
		// mutant: the torn line is dropped silently → no gap
		expect(out.knownGaps.map((g) => g.gap).join(" ")).toContain(
			"1 audit line(s) could not be parsed",
		);
		expect(r.stdout).not.toMatch(/\bexact\b|certified/i);
	});
});

describe("jobCoverage — shapes a record can take", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const principal = { origin: `claude-code:${SID}` };
	const ok = {
		kind: "llm_call",
		actor: `claude-code:${SID}:main:main`,
		data: {
			transferId: "tx_1",
			cost: 7,
			job: J,
			principal,
			usageFrom: iso(T0 + 2000),
			usageTo: iso(T0 + 3000),
		},
	};
	const run = async (records: unknown[], watch: unknown[] = [], job = J) =>
		(await lib()).jobCoverage({ job, logs: { [SID]: logText }, records, watch });

	it("an unrecognised record kind naming the job is a gap, alone or beside a covered call", async () => {
		const mystery = {
			kind: "mystery_spend",
			actor: "local",
			data: {
				principal,
				transferId: "tx_m",
				job: J,
				usageFrom: iso(T0 + 2500),
				usageTo: iso(T0 + 2600),
			},
		};
		expect(gapText(await run([mystery]))).toContain(
			"an unrecognised mystery_spend record names bug-1",
		);
		expect(gapText(await run([ok, mystery]))).toContain(
			"an unrecognised mystery_spend record names bug-1",
		);
		expect((await run([ok])).knownGaps).toEqual([]);
	});
	it("an untagged call with NO session overlapping the job is a gap; outside it is not", async () => {
		const sessionless = (from: number, to: number) => ({
			kind: "llm_call",
			actor: "local",
			data: { transferId: "tx_s", cost: 9, usageFrom: iso(T0 + from), usageTo: iso(T0 + to) },
		});
		expect(gapText(await run([ok, sessionless(2500, 2600)]))).toContain("names no session");
		expect(gapText(await run([ok, sessionless(9000, 9100)]))).not.toContain("names no session");
	});
	it("untagged settlement metadata with no llm_call, in the interval, is a gap", async () => {
		const meta = (data: Record<string, unknown>) => ({
			kind: "settlement_shortfall",
			actor: "local",
			data: { principal, ...data },
		});
		const inv = meta({
			transferId: "tx_inv",
			jobState: "invalid",
			usageFrom: iso(T0 + 2500),
			usageTo: iso(T0 + 2600),
		});
		expect((await run([ok, inv])).knownGaps.length).toBeGreaterThan(0);
		// control: the same metadata BESIDE its llm_call is bookkeeping
		const beside = meta({ transferId: "tx_1", usageFrom: iso(T0 + 2500), usageTo: iso(T0 + 2600) });
		expect((await run([ok, beside])).knownGaps).toEqual([]);
	});
	it("a would_block that NAMES another job is that job's, not this one's, whatever time it was written", async () => {
		const two =
			start(SID, T0) +
			op(SID, T0 + 1000, "start", "job-a") +
			op(SID, T0 + 3000, "start", "job-b") +
			op(SID, T0 + 6000, "stop", null);
		const { jobCoverage } = await lib();
		const rec = (job: string, from: number, to: number) => ({
			...ok,
			data: {
				...ok.data,
				transferId: `tx_${job}`,
				job,
				usageFrom: iso(T0 + from),
				usageTo: iso(T0 + to),
			},
		});
		const records = [rec("job-a", 1500, 2500), rec("job-b", 3500, 4500)];
		const wb = { kind: "would_block", job: "job-a", session: SID, started: iso(T0 + 4000) };
		const forB = jobCoverage({ job: "job-b", logs: { [SID]: two }, records, watch: [wb] });
		expect(forB.knownGaps.filter((g) => g.gap.includes("would_block"))).toEqual([]); // mutant: placed by time → a false gap of job-b
		const forA = jobCoverage({ job: "job-a", logs: { [SID]: two }, records, watch: [wb] });
		expect(gapText(forA)).toContain("would_block");
	});
});

describe("usertrust-job coverage — C1 bytes are escaped in its output", () => {
	it("a vault-derived U+009B never reaches stdout as itself", async () => {
		const J = "bug-1";
		const vault = join(state, "vault3");
		await mkdir(join(vault, "audit"), { recursive: true });
		const hostile = "bad\u009bsid\u007f";
		await writeFile(
			join(vault, "audit", "events.jsonl"),
			`${JSON.stringify({ kind: "llm_call", actor: `claude-code:${hostile}:main:main`, data: { transferId: "tx_h", cost: 1, principal: { origin: `claude-code:${hostile}` }, usageFrom: iso(T0 + 2000), usageTo: iso(T0 + 3000) } })}\n`,
		);
		await writeLog(
			start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null),
		);
		const r = await cliOut(["coverage", J, "--vault", vault, "--watch", join(state, "none.jsonl")]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("\\u009b"); // mutant: JSON.stringify leaves it raw
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none reach the terminal is the point
		expect(r.stdout).not.toMatch(/[\u007f-\u009f]/);
	});
});

describe("generators with their own test (B-90)", () => {
	const J = "bug-1";
	const logText =
		start(SID, T0) + op(SID, T0 + 1000, "start", J) + op(SID, T0 + 5000, "stop", null);
	const principal = { origin: `claude-code:${SID}` };
	const base = {
		kind: "llm_call",
		actor: `claude-code:${SID}:main:main`,
		data: {
			transferId: "tx_1",
			cost: 7,
			job: J,
			principal,
			usageFrom: iso(T0 + 2000),
			usageTo: iso(T0 + 3000),
		},
	};
	const run = async (records: unknown[]) =>
		(await lib()).jobCoverage({ job: J, logs: { [SID]: logText }, records });

	it("a record of the job that names no transfer is a gap", async () => {
		const { transferId: _t, ...data } = base.data;
		expect(gapText(await run([base, { ...base, data }]))).toContain("names no transfer");
	});
	it("an llm_call of the job with no integer cost is a gap", async () => {
		for (const cost of ["7", 1.5, -1, undefined]) {
			const r = await run([{ ...base, data: { ...base.data, cost } }]);
			expect(gapText(r), String(cost)).toContain("has no integer cost");
		}
	});
	it("a record of the job that names no session is a gap", async () => {
		const { principal: _p, ...data } = base.data;
		expect(
			gapText(
				await run([
					base,
					{ kind: "llm_call", actor: "local", data: { ...data, transferId: "tx_2" } },
				]),
			),
		).toContain("names no session");
	});
	it("an llm_call in the interval whose job state is invalid, and that names no job, is a gap", async () => {
		const bad = {
			...base,
			data: {
				transferId: "tx_3",
				cost: 2,
				principal,
				jobState: "invalid",
				usageFrom: iso(T0 + 2500),
				usageTo: iso(T0 + 2600),
			},
		};
		expect(gapText(await run([base, bad]))).toContain(
			"an llm_call in the interval has an invalid job state",
		);
	});
	it("a released hold with no class, no job and a start inside the interval is a gap; unused or another job's is not (B-88)", async () => {
		const given = (extra: Record<string, unknown>) => ({
			kind: "hold_released",
			actor: base.actor,
			data: { transferId: "tx_9", principal, usageFrom: iso(T0 + 2500), ...extra },
		});
		expect(gapText(await run([base, given({})]))).toContain(
			"a released hold of no known job, usage unconfirmed",
		);
		expect(gapText(await run([base, given({ jobState: "invalid" })]))).toContain(
			"usage unconfirmed",
		);
		expect((await run([base, given({ releaseClass: "unused" })])).knownGaps).toEqual([]);
		expect(
			(await run([base, given({ job: "bug-9" })])).knownGaps.map((g) => g.gap).join(" "),
		).not.toContain("no known job");
		// outside every interval it is not this job's
		expect((await run([base, given({ usageFrom: iso(T0 + 9000) })])).knownGaps).toEqual([]);
	});
});

describe("hot paths cannot be broken by a long backlog (B-86)", () => {
	it("usageSpan over 200,000 messages does not throw", async () => {
		const { usageSpan } = (await import(pathToFileURL(join(HOOKS, "transcript.mjs")).href)) as {
			usageSpan(m: Array<{ ts: number | null }>): { usageFrom?: string; usageTo?: string };
		};
		const messages = Array.from({ length: 200_000 }, (_, i) => ({ ts: T0 + i }));
		// mutant: Math.min(...times) → RangeError: Maximum call stack size exceeded
		expect(usageSpan(messages)).toEqual({ usageFrom: iso(T0), usageTo: iso(T0 + 199_999) });
		expect(usageSpan([{ ts: null }])).toEqual({});
	});
});

describe("stale-lock breaking is serialized (B-92)", () => {
	it("a breaker that finds another breaker's sentinel leaves the lock alone", async () => {
		await writeLog(start(SID, T0));
		await writeFile(`${logFile()}.lock`, JSON.stringify({ pid: 2 ** 31 - 2, ts: Date.now() }));
		await writeFile(`${logFile()}.lock.breaking`, "");
		const { breakIfStale } = (await lib()) as unknown as {
			breakIfStale(lock: string): Promise<void>;
		};
		await breakIfStale(`${logFile()}.lock`);
		// mutant: no sentinel → the stale lock is unlinked while another breaker is mid-way
		expect(await readFile(`${logFile()}.lock`, "utf-8")).toContain("pid");
	});
	it("a sentinel left by a breaker that died is cleared by age, then the lock can be broken", async () => {
		await writeLog(start(SID, T0));
		await writeFile(`${logFile()}.lock`, JSON.stringify({ pid: 2 ** 31 - 2, ts: Date.now() }));
		await writeFile(`${logFile()}.lock.breaking`, "");
		const old = new Date(Date.now() - 60_000);
		await utimes(`${logFile()}.lock.breaking`, old, old);
		const { breakIfStale } = (await lib()) as unknown as {
			breakIfStale(lock: string): Promise<void>;
		};
		await breakIfStale(`${logFile()}.lock`); // clears the dead sentinel
		await breakIfStale(`${logFile()}.lock`); // now breaks the lock
		await expect(readFile(`${logFile()}.lock`, "utf-8")).rejects.toThrow();
		await expect(readFile(`${logFile()}.lock.breaking`, "utf-8")).rejects.toThrow();
	});
	it("many writers racing over one dead lock all append exactly once, into a valid log", async () => {
		await writeLog(start(SID, Date.now()));
		await writeFile(`${logFile()}.lock`, JSON.stringify({ pid: 2 ** 31 - 2, ts: Date.now() }));
		const { appendJobOp, parseJobLog } = await lib();
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) => appendJobOp(SID, "start", `job-${i}`, { waitMs: 3000 })),
		);
		expect(results.every((r) => r.ok)).toBe(true);
		const parsed = parseJobLog(await readFile(logFile(), "utf-8"), SID);
		expect(parsed.state).toBe("ok");
		if (parsed.state === "ok") expect(parsed.events).toHaveLength(9);
	});
});

describe("usertrust-job start/stop — a write failure is reported through the scrubber (B-93)", () => {
	it("a read-only jobs dir under a state dir holding ESC: exit 1, no stack, no raw control bytes", async () => {
		const hostile = join(state, "st\u001b[31mRED\u009b");
		const jobs = join(hostile, "jobs");
		await mkdir(jobs, { recursive: true });
		await writeFile(join(jobs, "s1.jsonl"), start("s1", Date.now() - 5000));
		await chmod(jobs, 0o555);
		try {
			const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
				const inherited = Object.fromEntries(
					Object.entries(process.env).filter(
						([k]) => !k.startsWith("UT_") && k !== "CLAUDE_CODE_SESSION_ID",
					),
				);
				const child = spawn(process.execPath, [CLI, "start", "job-a"], {
					env: {
						...inherited,
						UT_CC_STATE_DIR: hostile,
						CLAUDE_CODE_SESSION_ID: "s1",
						UT_CC_JOB_WAIT_MS: "0",
					},
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (c) => (stdout += c));
				child.stderr.on("data", (c) => (stderr += c));
				child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
			});
			// (Running as root can write into a read-only dir: then there is nothing to report.)
			if (r.code !== 0) {
				expect(r.code).toBe(1);
				expect(r.stderr).toContain("usertrust-job: failed");
				expect(r.stderr).not.toContain("node:internal");
				// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none reach the terminal is the point
				expect(r.stderr).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
			}
		} finally {
			await chmod(jobs, 0o755);
		}
	});
});

describe("the lock and the log tail — review hardening", () => {
	it("a lock whose metadata was never written is broken once it is old enough", async () => {
		await writeLog(start(SID, T0));
		await writeFile(`${logFile()}.lock`, "");
		const old = new Date(Date.now() - 60_000);
		await utimes(`${logFile()}.lock`, old, old);
		const { appendJobOp } = await lib();
		expect((await appendJobOp(SID, "start", "job-a", { waitMs: 1000 })).ok).toBe(true);
	});
	it("...but not while it is still being written (a fresh empty lock waits)", async () => {
		await writeLog(start(SID, T0));
		await writeFile(`${logFile()}.lock`, "");
		const { appendJobOp } = await lib();
		let done = false;
		const pending = appendJobOp(SID, "start", "job-a", { waitMs: 1000 }).then((r) => {
			done = true;
			return r;
		});
		await new Promise((r) => setTimeout(r, 300));
		expect(done).toBe(false);
		expect((await pending).ok).toBe(true); // after the 2 s grace it is broken
	}, 10_000);
	it("an orphaned partial line is cut off before the append, so the log stays valid", async () => {
		await writeLog(`${start(SID, T0)}{"sid":"sess-1","ts":"2026-01-01T00:0`);
		const { appendJobOp, parseJobLog } = await lib();
		expect((await appendJobOp(SID, "start", "job-a", { waitMs: 1000 })).ok).toBe(true);
		const parsed = parseJobLog(await readFile(logFile(), "utf-8"), SID);
		expect(parsed.state).toBe("ok");
		if (parsed.state === "ok")
			expect(parsed.events.map((e) => e.op)).toEqual(["session-start", "start"]);
	});
});
