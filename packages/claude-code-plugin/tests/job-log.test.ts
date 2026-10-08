// The job log (hooks/job-log.mjs) and its CLI (bin/usertrust-job.mjs).
//
// Job ids here are opaque (`job-a`, `bug-1`). Each test names the mutant it kills.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
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
		exact: boolean;
		reasons: string[];
		transferIds: string[];
		costUt: string;
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

describe("jobCoverage — the one answer path for 'exact'", () => {
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

	it("exact: tagged records inside the interval, nothing untagged overlapping", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				rec({ job: J, usageFrom: iso(T0 + 3500), usageTo: iso(T0 + 4000) }),
			],
		});
		expect(r).toMatchObject({ exact: true, costUt: "14" });
		expect(r.transferIds).toHaveLength(2);
	});
	it("test 12 (R2-B) — an empty interval is NOT exact", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({ job: J, logs: { [SID]: logText }, records: [] });
		expect(r.exact).toBe(false);
		expect(r.reasons.join(" ")).toContain("no record of bug-1");
	});
	it("test 13 (R2-C) — a late untagged remainder, appended AFTER stop, is NOT exact", async () => {
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
		expect(r.exact).toBe(false);
		expect(r.reasons.join(" ")).toContain("carries no job");
	});
	it("test 13 — a record with no usageFrom in a capable session counts as untagged", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [rec({ job: J, ...inside }), rec({})],
		});
		expect(r.exact).toBe(false);
		expect(r.reasons.join(" ")).toContain("no complete usage window");
	});
	it("an invalid job state anywhere in the interval is NOT exact", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				rec({ jobState: "invalid", usageFrom: iso(T0 + 2500) }),
			],
		});
		expect(r.exact).toBe(false);
	});
	it("test 9 (F3) — a silent strip: records untagged because the server dropped the fields are NOT exact", async () => {
		const { jobCoverage } = await lib();
		// The plugin believed the (cached) capability and sent job; the downgraded server
		// stripped it: the records carry neither job nor usage times.
		const r = jobCoverage({ job: J, logs: { [SID]: logText }, records: [rec({}), rec({})] });
		expect(r.exact).toBe(false);
	});
	it("a missing or invalid log is NOT exact", async () => {
		const { jobCoverage } = await lib();
		expect(jobCoverage({ job: J, logs: {}, records: [rec({ job: J, ...inside })] }).exact).toBe(
			false,
		);
		const bad = jobCoverage({
			job: J,
			logs: { [SID]: `${logText}garbage\n${logText}` },
			records: [rec({ job: J, ...inside })],
		});
		expect(bad.exact).toBe(false);
	});
	it("a job split across two sessions needs BOTH exact", async () => {
		const { jobCoverage } = await lib();
		const sid2 = "sess-2";
		const logs = {
			[SID]: logText,
			[sid2]: start(sid2, T0) + op(sid2, T0 + 1000, "start", J),
		};
		const r = jobCoverage({ job: J, logs, records: [rec({ job: J, ...inside })] });
		expect(r.exact).toBe(false); // sess-2's interval has no record
		expect(r.reasons.join(" ")).toContain("sess-2");
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
		expect(r.costUt).toBe("17");
		expect(r.transferIds).toEqual(["tx_1"]);
	});

	it("a contributing session with NO supplied log is not exact", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				rec({ job: J, transferId: "tx_2", ...inside }, "llm_call", "sess-b"),
			],
		});
		expect(r.exact).toBe(false);
		expect(r.reasons.join(" ")).toContain("session sess-b: no job log was supplied");
	});

	it("a contributing session whose log is empty (unreadable) is not exact", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText, "sess-b": "" },
			records: [
				rec({ job: J, ...inside }),
				rec({ job: J, transferId: "tx_2", ...inside }, "llm_call", "sess-b"),
			],
		});
		expect(r.exact).toBe(false);
		expect(r.reasons.join(" ")).toContain("sess-b");
	});

	it("an llm_call with usageFrom but no usageTo is NOT exact (its end could reach the interval)", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [rec({ job: J, ...inside }), rec({ transferId: "tx_2", usageFrom: iso(T0 + 500) })],
		});
		expect(r.exact).toBe(false);
		expect(r.reasons.join(" ")).toContain("no complete usage window");
	});

	it("a record with only a usageFrom (a release) cannot be the positive evidence", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [rec({ job: J, usageFrom: iso(T0 + 2000) }, "hold_released")],
		});
		expect(r.exact).toBe(false);
		expect(r.reasons.join(" ")).toContain("no record of bug-1");
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

	it("a call inside the interval booked to ANOTHER job is not exact (it is missing from the total)", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				rec({ job: "bug-2", usageFrom: iso(T0 + 3500), usageTo: iso(T0 + 4000) }, "tx_2"),
			],
		});
		expect(r.exact).toBe(false);
		expect(r.reasons.join(" ")).toContain("carries another job");
	});

	it("a call tagged to the job but AFTER its stop is not exact (it is in the total, outside the interval)", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [
				rec({ job: J, ...inside }),
				rec({ job: J, usageFrom: iso(T0 + 6000), usageTo: iso(T0 + 7000) }, "tx_2"),
			],
		});
		expect(r.exact).toBe(false);
		expect(r.reasons.join(" ")).toContain("lies outside its intervals");
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
		expect(r.exact).toBe(true);
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

	it("a policy_denied or ledger_rejected record of the job is NOT exact (its usage is unrecorded)", async () => {
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
			expect(r.exact, kind).toBe(false);
			expect(r.reasons.join(" ")).toContain("was denied");
		}
	});
	it("a watch would_block naming the job is NOT exact", async () => {
		const { jobCoverage } = await lib();
		const r = jobCoverage({
			job: J,
			logs: { [SID]: logText },
			records: [ok],
			watch: [{ kind: "would_block", job: J, session: SID, at: iso(T0 + 3500) }],
		});
		expect(r.exact).toBe(false);
		expect(r.reasons.join(" ")).toContain("would_block");
	});
	it("a gap (an unmetered call) INSIDE the interval is NOT exact; outside it is irrelevant", async () => {
		const { jobCoverage } = await lib();
		const base = { job: J, logs: { [SID]: logText }, records: [ok] };
		const inGap = jobCoverage({
			...base,
			watch: [{ kind: "gap", session: SID, at: iso(T0 + 3500) }],
		});
		expect(inGap.exact).toBe(false);
		expect(inGap.reasons.join(" ")).toContain("unmetered");
		const outGap = jobCoverage({
			...base,
			watch: [{ kind: "gap", session: SID, at: iso(T0 + 9000) }],
		});
		expect(outGap.exact).toBe(true);
		const otherSession = jobCoverage({
			...base,
			watch: [{ kind: "gap", session: "sess-z", at: iso(T0 + 3500) }],
		});
		expect(otherSession.exact).toBe(true);
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
