// A FRESH install meters its session's first response.
//
// Claude Code writes an API response to the transcript (a text entry, then the tool_use entry
// carrying the full `usage`, both under one `message.id`) BEFORE it fires the PreToolUse that
// tool_use triggers. The state's first-run time (transcript.mjs `firstRun`) excludes every
// entry written before it, so a stamp first made at that PreToolUse never posted the
// response that triggered it: in a three-call session, the first hold was released empty and
// about 29% of the session's cost went unrecorded. SessionStart now makes the stamp, before
// any response of its session exists. What the stamp is FOR is pinned here too: the history
// of a transcript resumed (or compacted) on a fresh install, and the turns of a session the
// plugin was installed into midway, are never posted.
//
// Every transcript here is SYNTHETIC, written live in Claude Code's own shape (the shape the
// hook simulator writes): `parentUuid` chains, `timestamp` at the moment of writing, two
// entries per tool-calling response sharing `message.id` and `requestId`, `tool_result` user
// entries. The hooks run as hooks.json runs them (launch.mjs), against a REAL usertrust-server
// in dryRun, and the assertions read the server's own audit chain.

import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedgerEvents } from "usertrust";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../../server/src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../../server/src/server.js";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const KEY = "ut_plugin_first_response_key";
const SONNET = "claude-sonnet-4-6";
const DAY_MS = 86_400_000;

/** One API response's counts: fresh input, output, cache read, cache write. */
interface Usage {
	in: number;
	out: number;
	cr: number;
	cw: number;
}
const usage = (text: string): Usage => {
	const [i = 0, o = 0, cr = 0, cw = 0] = text.split(":").map(Number);
	return { in: i, out: o, cr, cw };
};
/** As the server records a settled response's usage. */
const recorded = (u: Usage) => ({
	inputTokens: u.in,
	outputTokens: u.out,
	cacheReadTokens: u.cr,
	cacheWriteTokens: u.cw,
});

/** A session transcript in Claude Code's format, written as Claude Code writes it. */
class Transcript {
	private parent: string | null = null;
	constructor(
		readonly path: string,
		readonly sessionId: string,
		readonly cwd: string,
	) {}

	private base(type: string, at: number | undefined) {
		const uuid = randomUUID();
		const entry = {
			parentUuid: this.parent,
			isSidechain: false,
			userType: "external",
			cwd: this.cwd,
			sessionId: this.sessionId,
			version: "2.1.296",
			gitBranch: "",
			type,
			uuid,
			timestamp: new Date(at ?? Date.now()).toISOString(),
		};
		this.parent = uuid;
		return entry;
	}

	private async write(entry: unknown) {
		await appendFile(this.path, `${JSON.stringify(entry)}\n`);
	}

	async userText(text: string, at?: number) {
		await this.write({ ...this.base("user", at), message: { role: "user", content: text } });
	}

	/**
	 * One API response. A tool call is two entries sharing `message.id`: a text block with
	 * `stop_reason: null` and partial output, then the tool_use block with the full usage.
	 * A final answer is one entry. Returns the message id.
	 */
	async assistant(u: Usage, opts: { toolUseId?: string; at?: number } = {}) {
		const id = `msg_${randomBytes(12).toString("hex")}`;
		const requestId = `req_${randomBytes(12).toString("hex")}`;
		const usageBlock = (out: number) => ({
			input_tokens: u.in,
			cache_creation_input_tokens: u.cw,
			cache_read_input_tokens: u.cr,
			cache_creation: { ephemeral_5m_input_tokens: u.cw, ephemeral_1h_input_tokens: 0 },
			output_tokens: out,
			service_tier: "standard",
		});
		const entry = (content: unknown[], stop: string | null, out: number) => ({
			...this.base("assistant", opts.at),
			message: {
				id,
				type: "message",
				role: "assistant",
				model: SONNET,
				content,
				stop_reason: stop,
				stop_sequence: null,
				usage: usageBlock(out),
			},
			requestId,
		});
		if (opts.toolUseId !== undefined) {
			await this.write(
				entry([{ type: "text", text: "I'll run Bash." }], null, Math.max(1, Math.floor(u.out / 3))),
			);
			await this.write(
				entry(
					[{ type: "tool_use", id: opts.toolUseId, name: "Bash", input: { command: "ls" } }],
					"tool_use",
					u.out,
				),
			);
		} else {
			await this.write(entry([{ type: "text", text: "Done." }], "end_turn", u.out));
		}
		return id;
	}

	async toolResult(toolUseId: string, at?: number) {
		await this.write({
			...this.base("user", at),
			message: {
				role: "user",
				content: [{ tool_use_id: toolUseId, type: "tool_result", content: "ok", is_error: false }],
			},
			toolUseResult: { stdout: "ok", stderr: "", interrupted: false, isImage: false },
		});
	}
}

type Flavour = "environment" | "configured";

let serverState: string;
let real: UsertrustServer | undefined;
let serverUrl: string;
let stateDir: string;
let projectDir: string;
let hookEnv: Record<string, string>;

/** The settings every hook of a test runs with: environment variables, or a config file. */
async function useFlavour(flavour: Flavour) {
	if (flavour === "environment") {
		hookEnv = { UT_CC_STATE_DIR: stateDir, UT_SERVER_URL: serverUrl, UT_SERVER_KEY: KEY };
		return;
	}
	const home = realpathSync(await mkdtemp(join(tmpdir(), "utcc-fr-home-")));
	const anchor = join(home, ".config", "usertrust");
	await mkdir(anchor, { recursive: true });
	await chmod(anchor, 0o700);
	const config = join(anchor, "session.json");
	await writeFile(config, JSON.stringify({ url: serverUrl, key: KEY, mode: "watch", stateDir }));
	await chmod(config, 0o600);
	hookEnv = { TEST_PASSWD_HOME: home, UT_CC_CONFIG: config };
}

beforeEach(async () => {
	serverState = await mkdtemp(join(tmpdir(), "utcc-fr-srv-"));
	real = createUsertrustServer({
		config: {
			host: "127.0.0.1",
			port: 0,
			stateDir: serverState,
			enforcement: "enforce",
			pendingTtlMs: 240_000,
			dryRun: true,
			tenants: [{ id: "t", keyHash: hashKey(KEY), budget: 10_000_000 }],
		},
	});
	const { port } = await real.listen();
	serverUrl = `http://127.0.0.1:${port}`;
	stateDir = await mkdtemp(join(tmpdir(), "utcc-fr-state-"));
	projectDir = await mkdtemp(join(tmpdir(), "utcc-fr-proj-"));
	await useFlavour("environment");
});
afterEach(async () => {
	await real?.close();
	real = undefined;
});

/** The server's audit chain, read once it is closed: what it recorded, in order. */
async function chain() {
	await real?.close();
	real = undefined;
	const events = readLedgerEvents(join(serverState, "t", ".usertrust"));
	const settled = events.filter((e) => e.kind === "llm_call").map((e) => e.data.transferId);
	expect(
		settled.filter((id, i) => settled.indexOf(id) !== i),
		"a transferId was settled twice",
	).toEqual([]);
	return events;
}
const llmCalls = (events: Awaited<ReturnType<typeof chain>>) =>
	events.filter((e) => e.kind === "llm_call");
const released = (events: Awaited<ReturnType<typeof chain>>) =>
	events.filter((e) => e.kind === "hold_released");

/** A Claude Code session, driving the plugin's hooks as Claude Code fires them. */
function session(sessionId = randomUUID()) {
	const transcript = new Transcript(join(projectDir, `${sessionId}.jsonl`), sessionId, projectDir);
	const common = () => ({
		session_id: sessionId,
		transcript_path: transcript.path,
		cwd: projectDir,
		permission_mode: "default",
	});
	const fire = async (hook: string, event: string, extra: Record<string, unknown> = {}) => {
		const result = await runHook(
			join(HOOKS, `${hook}.mjs`),
			{ ...common(), hook_event_name: event, ...extra },
			hookEnv,
		);
		expect(result.code, `${event}: ${result.stderr}`).toBe(0);
		return result;
	};
	/** The hold PreToolUse reserved, from its note (`usertrust: reserved <tx> (<n> ut)`). */
	const holds: string[] = [];
	return {
		transcript,
		holds,
		start: (source: string) => fire("session-start", "SessionStart", { source }),
		/** assistant tool_use response → PreToolUse → tool result → PostToolUse */
		async toolCall(u: Usage) {
			const toolUseId = `toolu_${randomBytes(12).toString("hex")}`;
			const tool = { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: toolUseId };
			const id = await transcript.assistant(u, { toolUseId });
			const pre = await fire("pre-tool-use", "PreToolUse", tool);
			const hold = /usertrust: reserved (\S+) \(/.exec(pre.stderr)?.[1];
			expect(hold, pre.stderr).toBeDefined();
			holds.push(hold ?? "");
			await transcript.toolResult(toolUseId);
			await fire("post-tool-use", "PostToolUse", { ...tool, tool_response: { stdout: "ok" } });
			return id;
		},
		/** The final answer, then Stop and SessionEnd. */
		async end(u: Usage) {
			await transcript.assistant(u);
			await fire("stop", "Stop", { stop_hook_active: false });
			await fire("session-end", "SessionEnd", { reason: "other" });
		},
	};
}

async function since() {
	return Date.parse(await readFile(join(stateDir, "transcripts", "since"), "utf-8"));
}

/**
 * What a hook that only writes a gap does, and nothing else: one session-tagged watch record,
 * through the same writer (as launch.mjs does for a hook whose process failed). In a child
 * process, under the hooks' environment.
 */
function gapOnly(sessionId: string, { written = true } = {}): Promise<void> {
	// `written`: whether the record must land (exit 1 if not), or must NOT (exit 1 if it did).
	const code = `const m = await import(${JSON.stringify(join(HOOKS, "lib.mjs"))});
if ((await m.recordWatchEvent({ kind: "gap", mode: "watch", session: ${JSON.stringify(sessionId)}, agent: "main", reason: "launch: the hook's process failed (signal SIGKILL)", started: null })) !== ${written}) process.exit(1);`;
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			["--input-type=module", "-e", code],
			{ env: { PATH: process.env.PATH ?? "", ...hookEnv } },
			(err) => (err ? reject(err) : resolve()),
		);
	});
}

/** The plugin's watch records (`watch.jsonl`), parsed. */
async function watchRecords(): Promise<Array<Record<string, unknown>>> {
	const text = await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CALL = usage("1000:200:500:100");
const FINAL = usage("400:120");

describe("a fresh install meters its first response", () => {
	it.each<Flavour>(["environment", "configured"])(
		"%s session, 3 tool calls: each call's OWN response settles on its hold, none is released empty, and the remainder is the final answer",
		async (flavour) => {
			await useFlavour(flavour);
			const s = session();
			await s.start("startup");
			await s.transcript.userText("Simulated task.");
			for (let i = 0; i < 3; i += 1) await s.toolCall(CALL);
			await s.end(FINAL);
			const events = await chain();
			// Before the fix: the first hold was released ("no transcript usage was assigned to this
			// hold"), and the first response was never posted at all.
			expect(released(events)).toEqual([]);
			const calls = llmCalls(events);
			expect(calls.map((e) => e.data.usage)).toEqual([
				recorded(CALL),
				recorded(CALL),
				recorded(CALL),
				recorded(FINAL),
			]);
			// Each tool call's hold carried that call's response; the remainder is a fourth vehicle.
			expect(calls.slice(0, 3).map((e) => e.data.transferId)).toEqual(s.holds);
			expect(s.holds).not.toContain(calls[3]?.data.transferId);
		},
	);

	it("SessionStart makes the first-run time; in estimate mode it makes none (no transcript state)", async () => {
		const s = session();
		hookEnv = { ...hookEnv, UT_CC_USAGE: "estimate" };
		await s.start("startup");
		expect(await readdir(stateDir).catch(() => [])).not.toContain("transcripts");
		hookEnv = { UT_CC_STATE_DIR: stateDir, UT_SERVER_URL: serverUrl, UT_SERVER_KEY: KEY };
		const before = Date.now();
		await session().start("startup");
		expect(await since()).toBeGreaterThanOrEqual(before);
	});
});

describe("what the first-run time keeps out", () => {
	it.each(["resume", "compact"])(
		"a fresh install whose first session is a %s of an old transcript posts none of its history, and all that follows",
		async (source) => {
			const s = session();
			// Written yesterday, before this plugin ever ran: two turns, a tool call and an answer.
			const old = Date.now() - DAY_MS;
			await s.transcript.userText("Yesterday's task.", old);
			await s.transcript.assistant(usage("7000:70"), { toolUseId: "toolu_old", at: old + 1 });
			await s.transcript.toolResult("toolu_old", old + 2);
			await s.transcript.assistant(usage("8000:80"), { at: old + 3 });
			await s.start(source);
			await s.transcript.userText("Today's task.");
			await s.toolCall(CALL);
			await s.end(FINAL);
			const calls = llmCalls(await chain());
			expect(calls.map((e) => e.data.usage)).toEqual([recorded(CALL), recorded(FINAL)]);
		},
	);

	it("a session resumed AFTER the first run keeps that time: a response it left unposted is posted, once", async () => {
		// The plugin's first session: it makes the first-run time.
		await session().start("startup");
		const first = await since();
		// A later session whose final answer no hook posted (Claude Code was killed before Stop).
		await sleep(5);
		const s = session();
		await s.start("startup");
		await s.transcript.userText("Task.");
		await s.toolCall(CALL);
		await s.transcript.assistant(usage("600:60"));
		await sleep(20);
		// Resumed: SessionStart again. The time is the first session's still, so the left-over
		// answer, written after it, is posted at the resumed session's Stop.
		await s.start("resume");
		expect(await since()).toBe(first);
		await s.transcript.userText("Go on.");
		await s.end(FINAL);
		const calls = llmCalls(await chain());
		expect(calls.map((e) => e.data.usage)).toEqual([
			recorded(CALL),
			// The resumed Stop's remainder: the left-over answer and the new one, one vehicle each
			// response (both Sonnet, so one settle carrying both).
			{ inputTokens: 1000, outputTokens: 180, cacheReadTokens: 0, cacheWriteTokens: 0 },
		]);
	});

	it("red-first: a lane metered later, on a state that already has a first-run time, posts nothing it wrote before its first hook, and declares it once as pre-metering, never a gap", async () => {
		// Lane A: the state's first session makes the state's first-run time.
		await session().start("startup");
		await sleep(5);
		// Lane B runs with NO hook of this plugin (unmetered), after that time: two responses.
		const id = randomUUID();
		const b = session(id);
		await b.transcript.userText("Unmetered task.");
		await b.transcript.assistant(usage("7000:70"), { toolUseId: "toolu_unmetered" });
		await b.transcript.toolResult("toolu_unmetered");
		await b.transcript.assistant(usage("8000:80"));
		await sleep(5);
		// Lane B becomes metered: its first hook is a PreToolUse (no SessionStart for it). The
		// response that triggered it was written before it, as for a mid-session install.
		await b.transcript.userText("Metered task.");
		await b.toolCall(usage("2000:20"));
		await b.toolCall(CALL);
		await b.end(FINAL);
		// Before the fix the backlog settled onto the first hold: 7000 + 8000 + 2000 input.
		expect(llmCalls(await chain()).map((e) => e.data.usage)).toEqual([
			recorded(CALL),
			recorded(FINAL),
		]);
		const watch = await watchRecords();
		expect(watch.filter((w) => w.kind === "pre-metering")).toEqual([
			expect.objectContaining({
				kind: "pre-metering",
				session: id,
				agent: "main",
				responses: 3,
				reason: "written before this session was metered; not billed",
				started: null,
			}),
		]);
		// Never a gap: the gap figure counts calls missed while metering was on.
		expect(watch.filter((w) => w.kind === "gap")).toEqual([]);
	});

	it("a hook that only writes a gap stamps the session: what it wrote after that is metering ON, posted, never pre-metering", async () => {
		await session().start("startup");
		await sleep(5);
		const id = randomUUID();
		const b = session(id);
		// The session's first hook only writes a gap (its process failed): metering was on, and failing.
		await gapOnly(id);
		await sleep(5);
		await b.transcript.userText("Task.");
		await b.transcript.assistant(usage("7000:70"), { toolUseId: "toolu_during" });
		await b.transcript.toolResult("toolu_during");
		await b.transcript.assistant(usage("8000:80"));
		await b.toolCall(CALL);
		await b.end(FINAL);
		const calls = llmCalls(await chain());
		// The two responses after the gap ride the first hold with its own call's response.
		expect(calls.map((e) => e.data.usage)).toEqual([
			{ inputTokens: 16000, outputTokens: 350, cacheReadTokens: 500, cacheWriteTokens: 100 },
			recorded(FINAL),
		]);
		const watch = (await watchRecords()).filter((w) => w.session === id);
		expect(watch.map((w) => w.kind)).toEqual(["gap"]);
	});

	it("a gap-only hook whose record CANNOT be written still stamps the session: what it wrote after that is posted", async () => {
		await session().start("startup");
		await sleep(5);
		const id = randomUUID();
		const b = session(id);
		// The watch log cannot be appended to: a directory holds its name.
		await mkdir(join(stateDir, "watch.jsonl"), { recursive: true });
		await gapOnly(id, { written: false });
		await sleep(5);
		await b.transcript.userText("Task.");
		await b.transcript.assistant(usage("7000:70"), { toolUseId: "toolu_during" });
		await b.transcript.toolResult("toolu_during");
		await b.transcript.assistant(usage("8000:80"));
		await b.toolCall(CALL);
		await b.end(FINAL);
		// Metering was on from the failed hook: the two responses after it are posted, not
		// skipped as written before metering.
		expect(llmCalls(await chain()).map((e) => e.data.usage)).toEqual([
			{ inputTokens: 16000, outputTokens: 350, cacheReadTokens: 500, cacheWriteTokens: 100 },
			recorded(FINAL),
		]);
	});

	it("a session this state already metered BEFORE per-session times, first touched again by a gap-only hook, keeps the state's time: its left-over answer is still posted", async () => {
		const id = randomUUID();
		const s = session(id);
		await s.start("startup");
		await s.transcript.userText("Task.");
		await s.toolCall(CALL);
		await s.transcript.assistant(usage("600:60"));
		await sleep(20);
		// The state as an older plugin left it (a cursor, no per-session time), and the session's
		// first hook after the upgrade only writes a gap.
		await rm(join(stateDir, "transcripts", "since-session", id));
		await gapOnly(id);
		expect(
			Date.parse(await readFile(join(stateDir, "transcripts", "since-session", id), "utf-8")),
		).toBe(await since());
		await s.end(FINAL);
		expect(llmCalls(await chain()).map((e) => e.data.usage)).toEqual([
			recorded(CALL),
			{ inputTokens: 1000, outputTokens: 180, cacheReadTokens: 0, cacheWriteTokens: 0 },
		]);
		expect((await watchRecords()).filter((w) => w.kind === "pre-metering")).toEqual([]);
	});

	it("a pre-metering backlog that ends in a line still being written is not declared until that line is whole: then once, counting it", async () => {
		await session().start("startup");
		await sleep(5);
		const id = randomUUID();
		const b = session(id);
		await b.transcript.userText("Unmetered task.");
		await b.transcript.assistant(usage("7000:70"));
		// The next response, half written (no newline yet): built in a scratch transcript.
		const scratch = new Transcript(join(projectDir, `scratch-${id}.jsonl`), id, projectDir);
		await scratch.assistant(usage("8000:80"));
		const line = (await readFile(scratch.path, "utf-8")).trimEnd();
		const half = Math.floor(line.length / 2);
		await appendFile(b.transcript.path, line.slice(0, half));
		const stop = () =>
			runHook(
				join(HOOKS, "stop.mjs"),
				{
					session_id: id,
					transcript_path: b.transcript.path,
					cwd: projectDir,
					permission_mode: "default",
					hook_event_name: "Stop",
					stop_hook_active: false,
				},
				hookEnv,
			);
		await stop();
		expect((await watchRecords()).filter((w) => w.kind === "pre-metering")).toEqual([]);
		await appendFile(b.transcript.path, `${line.slice(half)}\n`);
		await stop();
		expect((await watchRecords()).filter((w) => w.kind === "pre-metering")).toEqual([
			expect.objectContaining({ session: id, responses: 2 }),
		]);
	});

	it("a session this state already metered BEFORE per-session times keeps the state's time: a response it left unposted is still posted, once", async () => {
		const id = randomUUID();
		const s = session(id);
		await s.start("startup");
		await s.transcript.userText("Task.");
		await s.toolCall(CALL);
		await s.transcript.assistant(usage("600:60"));
		await sleep(20);
		// The state as an older plugin left it: a cursor for the session, no per-session time.
		await rm(join(stateDir, "transcripts", "since-session", id));
		await s.start("resume");
		expect(
			Date.parse(await readFile(join(stateDir, "transcripts", "since-session", id), "utf-8")),
		).toBe(await since());
		await s.transcript.userText("Go on.");
		await s.end(FINAL);
		expect(llmCalls(await chain()).map((e) => e.data.usage)).toEqual([
			recorded(CALL),
			{ inputTokens: 1000, outputTokens: 180, cacheReadTokens: 0, cacheWriteTokens: 0 },
		]);
		expect((await watchRecords()).filter((w) => w.kind === "pre-metering")).toEqual([]);
	});

	it("a plugin installed MID-SESSION posts none of the turns before its first hook; the responses after it are posted", async () => {
		const s = session();
		// The turns before the install: no hook of this plugin ever saw them.
		const earlier = Date.now() - 60_000;
		await s.transcript.userText("Earlier task.", earlier);
		await s.transcript.assistant(usage("5000:50"), { toolUseId: "toolu_earlier", at: earlier + 1 });
		await s.transcript.toolResult("toolu_earlier", earlier + 2);
		await s.transcript.assistant(usage("6000:60"), { at: earlier + 3 });
		// Installed now, with no SessionStart for this session: its next turn's first hook is a
		// PreToolUse, and the response that triggered it was written before it. That one response
		// predates the first-run time and is not posted (the README's stated residual); every later
		// one is.
		await s.transcript.userText("Next task.");
		await s.toolCall(usage("2000:20"));
		await s.toolCall(CALL);
		await s.end(FINAL);
		const events = await chain();
		expect(llmCalls(events).map((e) => e.data.usage)).toEqual([recorded(CALL), recorded(FINAL)]);
		// The first hook's hold carried nothing, and was given back.
		expect(released(events).map((e) => e.data.transferId)).toEqual([s.holds[0]]);
	});
});
