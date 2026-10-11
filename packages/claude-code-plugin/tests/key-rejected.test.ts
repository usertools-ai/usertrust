// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A server that REJECTS the session's key (a 401, or a 403 that says `unauthorized`) is a
 * configuration failure, not an outage. In watch mode such a call was written down as one more
 * `unexpected governance response 401` gap, with its note on stderr, which on exit 0 Claude Code
 * keeps in its debug log only: metering could stop for days with nothing the user ever saw.
 *
 * Pinned here, through the real hooks run the way Claude Code runs them (launch.mjs, stdin JSON
 * in, stdout JSON out):
 *  - PreToolUse: a distinct gap (`cause: "key-rejected"`), full detail once per session, a
 *    compact record per later call; a `systemMessage` on the first, then at most once per
 *    NOTICE_INTERVAL_MS; exit 0, never a decision; enforce still blocks;
 *  - a 402 and a 403 POLICY answer stay `would_block`;
 *  - SessionStart: a WARNING with the count and the first date of the rejected calls recorded
 *    since the last session start, read locally and bounded; any read failure is the normal
 *    banner.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../../server/src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../../server/src/server.js";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const PRE = join(HOOKS, "pre-tool-use.mjs");
const SESSION_START = join(HOOKS, "session-start.mjs");

/** key-rejected.mjs `NOTICE_INTERVAL_MS`: the least time between two notices of one session. */
const NOTICE_INTERVAL_MS = 10 * 60_000;
/** key-rejected.mjs `SINCE_READ_BYTES`: the most of watch.jsonl SessionStart reads. */
const SINCE_READ_BYTES = 1024 * 1024;

const RIGHT = "the-right-key";
const WRONG = "a-mistyped-key";

let server: Server | undefined;
let real: UsertrustServer | undefined;
let stateDir: string;
let baseEnv: Record<string, string>;

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-keyrej-"));
	// Estimate mode keeps these runs off the transcript; UT_CC_MODE is unset (watch) unless a
	// test sets it, and runHook inherits no UT_* variable.
	baseEnv = { UT_CC_STATE_DIR: stateDir, UT_SERVER_KEY: WRONG, UT_CC_USAGE: "estimate" };
});
afterEach(async () => {
	server?.closeAllConnections();
	server?.close();
	server = undefined;
	await real?.close();
	real = undefined;
});

/**
 * A stub governance server that checks the bearer key as usertrust-server does: health answers
 * anyone; any other route answers `RIGHT` with a reservation and anything else with `status`
 * and `json` (by default the server's own 401).
 */
function startStub(
	status = 401,
	json: unknown = { error: "unauthorized", reason: "missing or invalid bearer key" },
): Promise<string> {
	let n = 0;
	return new Promise((resolve) => {
		server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				const send = (code: number, body: unknown) => {
					res.writeHead(code, { "content-type": "application/json" });
					res.end(JSON.stringify(body));
				};
				if (req.method === "GET" && req.url === "/v1/health") {
					return send(200, { ok: true, capabilities: [] });
				}
				if (req.headers.authorization === `Bearer ${RIGHT}`) {
					return send(200, { transferId: `tx_${++n}`, estimatedCost: 3 });
				}
				return send(status, json);
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server?.address();
			resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
		});
	});
}

let sessions = 0;
const newSession = () => `keyrej-${++sessions}`;

const call = (session: string, n: number) => ({
	session_id: session,
	tool_name: "Bash",
	tool_use_id: `tu_${n}`,
	tool_input: { command: "ls" },
});

/** Every watch record written so far, parsed; [] when the log does not exist. */
async function watchRecords(): Promise<Array<Record<string, unknown>>> {
	try {
		const text = await readFile(join(stateDir, "watch.jsonl"), "utf-8");
		return text
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

/** The hook's stdout as the hook JSON it must be, or null when it wrote nothing. */
function hookJson(stdout: string): Record<string, unknown> | null {
	return stdout === "" ? null : (JSON.parse(stdout) as Record<string, unknown>);
}

/** A watch-mode PreToolUse that let the call through: exit 0, never a permission decision. */
function expectProceeded(result: { code: number; stdout: string }) {
	expect(result.code).toBe(0);
	expect(hookJson(result.stdout)?.hookSpecificOutput).toBeUndefined();
}

/** The per-session notice state the plugin keeps (key-rejected.mjs `sessionStatePath`). */
const noticeState = (session: string) => join(stateDir, "key-rejected", `${session}.json`);

/** Move the session's last notice `ms` into the past, as the clock passing would. */
async function backdateNotice(session: string, ms: number) {
	const state = JSON.parse(await readFile(noticeState(session), "utf-8")) as Record<
		string,
		unknown
	>;
	state.noticeAt = new Date(Date.now() - ms).toISOString();
	await writeFile(noticeState(session), JSON.stringify(state));
}

describe("watch mode: a rejected key is a configuration failure the user is SHOWN", () => {
	it("401: a systemMessage on the first call, exit 0, a distinct gap; silent and counted inside the window; shown again after it", async () => {
		const url = await startStub();
		const env = { ...baseEnv, UT_SERVER_URL: url };
		const session = newSession();

		const first = await runHook(PRE, call(session, 1), env);
		expectProceeded(first);
		const message = String(hookJson(first.stdout)?.systemMessage);
		expect(message).toContain(
			"usertrust: the server rejected this session's key (401): tool calls are NOT being metered",
		);
		expect(message).toContain("UT_SERVER_KEY");
		expect(message).toContain(join(stateDir, "watch.jsonl"));

		// Inside the window: no message, but the call is still recorded.
		const second = await runHook(PRE, call(session, 2), env);
		expectProceeded(second);
		expect(second.stdout).toBe("");
		// Just short of the window: still silent.
		await backdateNotice(session, NOTICE_INTERVAL_MS - 30_000);
		const third = await runHook(PRE, call(session, 3), env);
		expectProceeded(third);
		expect(third.stdout).toBe("");
		// Past it: shown again.
		await backdateNotice(session, NOTICE_INTERVAL_MS + 1_000);
		const fourth = await runHook(PRE, call(session, 4), env);
		expectProceeded(fourth);
		expect(String(hookJson(fourth.stdout)?.systemMessage)).toContain(
			"rejected this session's key (401)",
		);

		const records = await watchRecords();
		expect(records).toHaveLength(4);
		for (const [i, record] of records.entries()) {
			// Still a gap every existing reader understands, one per call.
			expect(record).toMatchObject({
				kind: "gap",
				mode: "watch",
				session,
				agent: "main",
				tool: "Bash",
				reason: "the server rejected this key (401)",
				cause: "key-rejected",
				status: 401,
			});
			expect(Date.parse(String(record.started)), String(i)).not.toBeNaN();
		}
		// Full detail ONCE per session; the later records are compact.
		expect(records[0]?.detail).toMatchObject({
			server: url,
			keyHash: createHash("sha256").update(WRONG).digest("hex").slice(0, 16),
			error: "unauthorized",
			answer: "missing or invalid bearer key",
		});
		expect(records.slice(1).map((r) => r.detail)).toEqual([undefined, undefined, undefined]);
		// No generic outage gap anywhere.
		expect(JSON.stringify(records)).not.toContain("unexpected governance response");
		// The notice state is private, like the plugin's other state.
		expect((await stat(noticeState(session))).mode & 0o777).toBe(0o600);
		expect((await stat(join(stateDir, "key-rejected"))).mode & 0o777).toBe(0o700);
	}, 30_000);

	it("each session gets its own first notice and its own detailed record", async () => {
		const url = await startStub();
		const env = { ...baseEnv, UT_SERVER_URL: url };
		const a = await runHook(PRE, call(newSession(), 1), env);
		const b = await runHook(PRE, call(newSession(), 1), env);
		for (const result of [a, b]) {
			expectProceeded(result);
			expect(String(hookJson(result.stdout)?.systemMessage)).toContain("(401)");
		}
		const records = await watchRecords();
		expect(records.map((r) => r.detail !== undefined)).toEqual([true, true]);
	}, 30_000);

	it("a 403 that says `unauthorized` takes the same path: a configuration failure, not a policy refusal", async () => {
		const url = await startStub(403, { error: "unauthorized", reason: "key revoked" });
		const result = await runHook(PRE, call(newSession(), 1), { ...baseEnv, UT_SERVER_URL: url });
		expectProceeded(result);
		expect(String(hookJson(result.stdout)?.systemMessage)).toContain(
			"the server rejected this session's key (403)",
		);
		expect(await watchRecords()).toMatchObject([
			{
				kind: "gap",
				cause: "key-rejected",
				status: 403,
				reason: "the server rejected this key (403)",
			},
		]);
	}, 30_000);

	for (const [status, json] of [
		[403, { error: "policy_denied", reason: "rule pii" }],
		// Any 403 that does not say `unauthorized` is never a rejected key: only that exact error
		// string reclassifies a 403 (a deliberate, narrow behaviour change).
		[403, { error: "forbidden", reason: "some other refusal" }],
		[403, { error: "Unauthorized", reason: "case differs" }],
		[402, { error: "budget_exceeded", reason: "need 10, have 2" }],
	] as const) {
		it(`a ${status} ${json.error} is unchanged: would_block, no message, no config gap`, async () => {
			const url = await startStub(status, json);
			const result = await runHook(PRE, call(newSession(), 1), { ...baseEnv, UT_SERVER_URL: url });
			expectProceeded(result);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("would have blocked");
			expect(await watchRecords()).toMatchObject([
				{ kind: "would_block", status, error: json.error, reason: json.reason },
			]);
			expect(JSON.stringify(await watchRecords())).not.toContain("key-rejected");
		}, 30_000);
	}

	it("a timeout or a 5xx is still an outage, never a rejected key", async () => {
		const url = await startStub(503, { error: "unavailable" });
		const result = await runHook(PRE, call(newSession(), 1), { ...baseEnv, UT_SERVER_URL: url });
		expectProceeded(result);
		expect(result.stdout).toBe("");
		expect(await watchRecords()).toMatchObject([
			{ kind: "gap", reason: "unexpected governance response 503" },
		]);
		expect((await watchRecords())[0]?.cause).toBeUndefined();
	}, 30_000);
});

describe("enforce mode still blocks on a rejected key", () => {
	it("401: blocked (exit 2), no message, no record, and stderr names the cause", async () => {
		const url = await startStub();
		const result = await runHook(PRE, call(newSession(), 1), {
			...baseEnv,
			UT_CC_MODE: "enforce",
			UT_SERVER_URL: url,
		});
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("failed closed");
		expect(result.stderr).toContain("rejected this key (401)");
		expect(await watchRecords()).toEqual([]);
	}, 30_000);

	it("a 403 `unauthorized` is blocked too", async () => {
		const url = await startStub(403, { error: "unauthorized", reason: "key revoked" });
		const result = await runHook(PRE, call(newSession(), 1), {
			...baseEnv,
			UT_CC_MODE: "enforce",
			UT_SERVER_URL: url,
		});
		const json = hookJson(result.stdout) as {
			hookSpecificOutput?: { permissionDecision?: string };
		} | null;
		const blocked = result.code === 2 || json?.hookSpecificOutput?.permissionDecision === "deny";
		expect(blocked).toBe(true);
	}, 30_000);

	it("with UT_FAIL_OPEN=1 the call proceeds unmetered, so the user is shown it", async () => {
		const url = await startStub();
		const result = await runHook(PRE, call(newSession(), 1), {
			...baseEnv,
			UT_CC_MODE: "enforce",
			UT_FAIL_OPEN: "1",
			UT_SERVER_URL: url,
		});
		expectProceeded(result);
		expect(String(hookJson(result.stdout)?.systemMessage)).toContain("(401)");
		expect(await watchRecords()).toMatchObject([
			{ kind: "gap", mode: "enforce", cause: "key-rejected", status: 401 },
		]);
	}, 30_000);
});

describe("a KEY MISMATCH through the real hook entry", () => {
	it("a stub that checks the key: the wrong key gets the systemMessage on stdout, exit 0; the right key reserves", async () => {
		const url = await startStub();
		const session = newSession();
		const result = await runHook(PRE, call(session, 1), { ...baseEnv, UT_SERVER_URL: url });
		expect(result.code).toBe(0);
		expect(hookJson(result.stdout)).toEqual({
			systemMessage: expect.stringContaining(
				"usertrust: the server rejected this session's key (401): tool calls are NOT being metered",
			),
		});
		// The same server with the right key (another session: a session's key is pinned).
		const ok = await runHook(PRE, call(newSession(), 1), {
			...baseEnv,
			UT_SERVER_KEY: RIGHT,
			UT_SERVER_URL: url,
		});
		expect(ok.code).toBe(0);
		expect(ok.stdout).toBe("");
		expect(ok.stderr).toContain("reserved tx_");
	}, 30_000);

	it("a REAL usertrust-server holding another key's hash: its own 401 reaches the user", async () => {
		const serverState = await mkdtemp(join(tmpdir(), "utcc-keyrej-srv-"));
		real = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir: serverState,
				enforcement: "enforce",
				pendingTtlMs: 240_000,
				dryRun: true,
				tenants: [{ id: "t", keyHash: hashKey(RIGHT), budget: 10_000_000 }],
			},
		});
		const { port } = await real.listen();
		const result = await runHook(PRE, call(newSession(), 1), {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(0);
		expect(String(hookJson(result.stdout)?.systemMessage)).toContain(
			"rejected this session's key (401)",
		);
		expect(await watchRecords()).toMatchObject([
			{
				kind: "gap",
				cause: "key-rejected",
				detail: { error: "unauthorized", answer: "missing or invalid bearer key" },
			},
		]);
	}, 30_000);
});

// ---------------------------------------------------------------------------------------------
// SessionStart: local only.

/** A key-rejected gap as PreToolUse writes it (compact form). */
const rejectedLine = (at: string, n: number) =>
	JSON.stringify({
		at,
		kind: "gap",
		mode: "watch",
		session: "old-session",
		agent: "main",
		tool: "Bash",
		reason: "the server rejected this key (401)",
		cause: "key-rejected",
		status: 401,
		started: at,
		n,
	});

const otherGapLine = (at: string) =>
	JSON.stringify({
		at,
		kind: "gap",
		mode: "watch",
		session: "old-session",
		agent: "main",
		tool: "Bash",
		reason: "fetch failed",
		started: at,
	});

async function banner(env: Record<string, string> = {}) {
	const startedAt = Date.now();
	const result = await runHook(
		SESSION_START,
		{ hook_event_name: "SessionStart", source: "startup", session_id: newSession() },
		{ ...baseEnv, ...env },
	);
	const tookMs = Date.now() - startedAt;
	expect(result.code).toBe(0);
	return {
		message: (JSON.parse(result.stdout) as { systemMessage: string }).systemMessage,
		tookMs,
	};
}

const WATCH = () => join(stateDir, "watch.jsonl");

describe("SessionStart warns, locally, of calls the server rejected since the last session start", () => {
	it("1,946 rejected calls since 2026-10-09: a WARNING with the count and the first date; the next start, none", async () => {
		const day = Date.parse("2026-10-09T08:00:00.000Z");
		const lines: string[] = [];
		for (let i = 0; i < 1946; i++) {
			lines.push(rejectedLine(new Date(day + i * 120_000).toISOString(), i));
			if (i % 100 === 0) lines.push(otherGapLine(new Date(day + i * 120_000).toISOString()));
		}
		await writeFile(WATCH(), `${lines.join("\n")}\n`);

		const { message } = await banner();
		expect(
			message.startsWith("usertrust: WARNING: 1,946 tool calls since 2026-10-09 were NOT metered"),
		).toBe(true);
		expect(message).toContain("the server rejected the key");
		expect(message).toContain("UT_SERVER_KEY");
		expect(message).toContain(WATCH());
		// The mode is still announced.
		expect(message).toContain("usertrust: watch-only — nothing is blocked");

		// Since THAT start: nothing new, the normal banner.
		const next = await banner();
		expect(next.message.startsWith("usertrust: watch-only — nothing is blocked")).toBe(true);
		expect(next.message).not.toContain("WARNING");

		// Two more appended: only those two.
		await appendFile(
			WATCH(),
			`${rejectedLine("2026-10-11T09:00:00.000Z", 1)}\n${rejectedLine("2026-10-11T09:01:00.000Z", 2)}\n`,
		);
		const third = await banner();
		expect(
			third.message.startsWith(
				"usertrust: WARNING: 2 tool calls since 2026-10-11 were NOT metered",
			),
		).toBe(true);
	}, 30_000);

	it("one rejected call reads in the singular", async () => {
		await writeFile(WATCH(), `${rejectedLine("2026-10-10T08:00:00.000Z", 0)}\n`);
		const { message } = await banner();
		expect(
			message.startsWith("usertrust: WARNING: 1 tool call since 2026-10-10 was NOT metered"),
		).toBe(true);
	}, 30_000);

	it("a watch.jsonl replaced since the last start (deleted, a new file) is read from its start", async () => {
		await writeFile(WATCH(), `${rejectedLine("2026-10-09T08:00:00.000Z", 0)}\n`);
		expect((await banner()).message).toContain("WARNING");
		// The user deletes the file, and a new one grows past the old offset.
		await writeFile(`${WATCH()}.new`, `${rejectedLine("2026-10-10T08:00:00.000Z", 0)}\n`.repeat(3));
		await (await import("node:fs/promises")).rename(`${WATCH()}.new`, WATCH());
		const { message } = await banner();
		expect(message.startsWith("usertrust: WARNING: 3 tool calls since 2026-10-10")).toBe(true);
	}, 30_000);

	it("without rejected calls: the normal banner (other gaps and refusals never warn)", async () => {
		await writeFile(
			WATCH(),
			`${otherGapLine("2026-10-10T08:00:00.000Z")}\n${JSON.stringify({ kind: "would_block", status: 403, error: "policy_denied" })}\n`,
		);
		const { message } = await banner();
		expect(message.startsWith("usertrust: watch-only — nothing is blocked")).toBe(true);
		// And with no watch.jsonl at all.
		const empty = await mkdtemp(join(tmpdir(), "utcc-keyrej-empty-"));
		const none = await banner({ UT_CC_STATE_DIR: empty });
		expect(none.message.startsWith("usertrust: watch-only — nothing is blocked")).toBe(true);
	}, 30_000);

	it("an unreadable watch.jsonl (a directory; no permission; a FIFO) is the normal banner, never a hang or a failure", async () => {
		await mkdir(WATCH());
		await mkdir(join(WATCH(), "x"));
		expect((await banner()).message.startsWith("usertrust: watch-only — nothing is blocked")).toBe(
			true,
		);

		const noPerm = await mkdtemp(join(tmpdir(), "utcc-keyrej-perm-"));
		await writeFile(
			join(noPerm, "watch.jsonl"),
			`${rejectedLine("2026-10-10T08:00:00.000Z", 0)}\n`,
		);
		await chmod(join(noPerm, "watch.jsonl"), 0o000);
		const root = typeof process.getuid === "function" && process.getuid() === 0;
		const denied = await banner({ UT_CC_STATE_DIR: noPerm });
		// root reads through any mode bits, and then rightly warns.
		if (!root)
			expect(denied.message.startsWith("usertrust: watch-only — nothing is blocked")).toBe(true);

		if (process.platform !== "win32") {
			const fifoDir = await mkdtemp(join(tmpdir(), "utcc-keyrej-fifo-"));
			expect(spawnSync("mkfifo", [join(fifoDir, "watch.jsonl")]).status).toBe(0);
			const fifo = await banner({ UT_CC_STATE_DIR: fifoDir });
			expect(fifo.message.startsWith("usertrust: watch-only — nothing is blocked")).toBe(true);
		}
	}, 30_000);

	it("a huge watch.jsonl is read only to its bound: rejected calls further back are not reached, and it stays fast", async () => {
		// Rejected calls at the head, then 32 MiB of other gaps: past the bound.
		const head = Array.from({ length: 50 }, (_, i) =>
			rejectedLine(new Date(Date.parse("2026-10-01T00:00:00.000Z") + i).toISOString(), i),
		).join("\n");
		const filler = `${otherGapLine("2026-10-02T00:00:00.000Z")}\n`;
		const fillerBlock = filler.repeat(Math.ceil((32 * 1024 * 1024) / filler.length));
		expect(fillerBlock.length).toBeGreaterThan(SINCE_READ_BYTES * 16);
		await writeFile(WATCH(), `${head}\n${fillerBlock}`);
		const { message, tookMs } = await banner();
		expect(message.startsWith("usertrust: watch-only — nothing is blocked")).toBe(true);
		// Well inside SessionStart's 5 s budget (node's own start is most of it).
		expect(tookMs).toBeLessThan(3_000);
	}, 60_000);

	it("rejected calls past the bound of a large new tail: 'at least' the ones it read", async () => {
		// More rejected records than the bound holds, all new.
		const one = `${rejectedLine("2026-10-09T08:00:00.000Z", 0)}\n`;
		const count = Math.ceil((SINCE_READ_BYTES * 2) / one.length);
		await writeFile(WATCH(), one.repeat(count));
		const { message } = await banner();
		expect(message).toMatch(
			/^usertrust: WARNING: at least [\d,]+ tool calls since 2026-10-09 were NOT metered/,
		);
		const shown = Number(/at least ([\d,]+)/.exec(message)?.[1]?.replaceAll(",", ""));
		expect(shown).toBeLessThan(count);
		expect(shown).toBeGreaterThan(Math.floor(SINCE_READ_BYTES / one.length) - 2);
	}, 30_000);
});
