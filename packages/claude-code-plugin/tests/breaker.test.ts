// The watch-mode circuit breaker (hooks/breaker.mjs), the gap records every hook writes when a
// settle or a give-back does not end cleanly, and the remembered `principal` capability. Each
// hook runs as Claude Code runs it (helpers/run-hook.ts): its own node process, against a fake
// server, with a passwd home of the test's own, under which the host-wide breaker lives.
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const SESSION = "44444444-2222-4333-8444-555555555555";
const SONNET = "claude-sonnet-4-6";

interface Verdict {
	state: string;
	note?: string;
	closed?: boolean;
	reopened?: boolean;
}

interface BreakerModule {
	useBreakerHome(home: string | null): void;
	noteTimeout(url: string, deadlineMs: number, options?: { now?: number }): boolean;
	noteAnswer(url: string, options?: { now?: number }): void;
	consultBreaker(
		url: string,
		probe: () => Promise<boolean>,
		options?: { clock?: () => number },
	): Promise<Verdict>;
}

async function breakerModule(): Promise<BreakerModule> {
	// @ts-expect-error TS7016: breaker.mjs ships as plain .mjs, with no type declarations.
	return (await import("../hooks/breaker.mjs")) as BreakerModule;
}

type Reply = { status: number; json?: unknown } | "hang" | "stall";

interface Seen {
	method: string;
	path: string;
	body: Record<string, unknown>;
}

let servers: Server[] = [];
let seen: Seen[] = [];
let override: ((path: string, body: Record<string, unknown>) => Reply | undefined) | undefined;
let capabilities: string[] = [];
let transfers = 0;

/** How the fake server answers when `override` does not: as a healthy usertrust server. */
function usual(path: string): Reply {
	if (path === "/v1/health") return { status: 200, json: { status: "ok", capabilities } };
	if (path === "/v1/authorize") {
		transfers += 1;
		return { status: 200, json: { transferId: `tx_s${transfers}`, estimatedCost: 1 } };
	}
	if (path === "/v1/settle") return { status: 200, json: { settled: true } };
	if (path === "/v1/release") return { status: 200, json: { released: true } };
	return { status: 404, json: { reason: "unknown route" } };
}

/**
 * A fake server: every request is recorded, then answered. A "hang" reply never answers; a
 * "stall" reply sends its headers, then never its body.
 */
function startServer(): Promise<string> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			let raw = "";
			req.on("data", (chunk: Buffer) => {
				raw += chunk.toString("utf-8");
			});
			req.on("end", () => {
				const path = req.url ?? "";
				let body: Record<string, unknown> = {};
				try {
					body = JSON.parse(raw || "{}") as Record<string, unknown>;
				} catch {
					body = {};
				}
				seen.push({ method: req.method ?? "", path, body });
				const reply = override?.(path, body) ?? usual(path);
				if (reply === "hang") return;
				if (reply === "stall") {
					res.writeHead(200, { "content-type": "application/json" });
					res.flushHeaders();
					return;
				}
				res.writeHead(reply.status, { "content-type": "application/json" });
				res.end(JSON.stringify(reply.json ?? {}));
			});
		});
		servers.push(server);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve(
				`http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
			);
		});
	});
}

let home: string;
let stateDir: string;
let projectDir: string;
let url: string;

beforeEach(async () => {
	home = nodeFs.realpathSync(await mkdtemp(join(tmpdir(), "utcc-brk-home-")));
	stateDir = await mkdtemp(join(tmpdir(), "utcc-brk-state-"));
	projectDir = await mkdtemp(join(tmpdir(), "utcc-brk-proj-"));
	seen = [];
	override = undefined;
	capabilities = [];
	transfers = 0;
	url = await startServer();
});

afterEach(() => {
	for (const server of servers) {
		server.closeAllConnections();
		server.close();
	}
	servers = [];
});

/** A hook's environment: this test's state dir, server and passwd home. */
const envFor = (extra: Record<string, string> = {}): Record<string, string> => ({
	UT_CC_STATE_DIR: stateDir,
	UT_SERVER_URL: url,
	UT_SERVER_KEY: "k",
	TEST_PASSWD_HOME: home,
	...extra,
});

const run = (hook: string, input: Record<string, unknown>, extra: Record<string, string> = {}) =>
	runHook(join(HOOKS, `${hook}.mjs`), input, envFor(extra));

/** A session's main transcript, as Claude Code names it. */
const transcriptPath = (session = SESSION) => join(projectDir, `${session}.jsonl`);
const preInput = (call: string, session = SESSION) => ({
	session_id: session,
	transcript_path: transcriptPath(session),
	tool_name: "Bash",
	tool_use_id: call,
	tool_input: { command: "ls" },
});
const postInput = (call: string) => ({
	session_id: SESSION,
	transcript_path: transcriptPath(),
	tool_use_id: call,
	tool_response: "ok",
});
/** A settle point's input with no transcript: its remainder reads nothing. */
const bare = () => ({ session_id: SESSION });

const sha16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const breakerDir = () => join(home, ".local", "state", "usertrust", "breaker");
const breakerFile = (server = url) => join(breakerDir(), `${sha16(server)}.json`);

async function writeBreaker(state: Record<string, unknown>, server = url): Promise<void> {
	await mkdir(breakerDir(), { recursive: true, mode: 0o700 });
	await writeFile(breakerFile(server), JSON.stringify(state), { mode: 0o600 });
}

/** The breaker of `server`, opened just now: open for its minute. */
const openBreaker = (server = url) =>
	writeBreaker({ openUntil: Date.now() + 60_000, openedAt: Date.now(), timeouts: [] }, server);

/** The breaker of `server`, its minute over: the next hook probes. */
const dueBreaker = (server = url) =>
	writeBreaker({ openUntil: Date.now() - 1, openedAt: Date.now() - 61_000, timeouts: [] }, server);

async function breakerState(server = url): Promise<Record<string, unknown> | null> {
	try {
		return JSON.parse(await readFile(breakerFile(server), "utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Every watch record of `dir` so far, parsed; [] when there is no log. */
async function records(dir = stateDir): Promise<Array<Record<string, unknown>>> {
	const text = await readFile(join(dir, "watch.jsonl"), "utf-8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const holdName = (call: string, transferId: string, agent = "main", kind = "json") =>
	`${SESSION}__${agent}__${call}.${transferId}.${kind}`;

/**
 * A pending hold's file, as PreToolUse records one; `kind` "settling" or "releasing" for one
 * a hook has claimed, its settle or give-back attempted.
 */
async function seedHold(
	call: string,
	transferId: string,
	fields: Record<string, unknown>,
	agent = "main",
	kind = "json",
): Promise<void> {
	await writeFile(
		join(stateDir, holdName(call, transferId, agent, kind)),
		JSON.stringify({
			gate: 1,
			toolUseId: call,
			transferId,
			agentId: agent,
			startedAt: new Date().toISOString(),
			...fields,
		}),
		{ mode: 0o600 },
	);
}

/** A transcript hold carrying one assigned message's usage. */
const WINDOW = {
	usage: "transcript",
	holdModel: SONNET,
	assignedIds: ["msg_a"],
	inputTokens: 5,
	outputTokens: 6,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cacheWrite1hTokens: 0,
};
/** An estimate hold: settled at the estimate, by its PostToolUse alone. */
const ESTIMATE = { estimatedInputTokens: 4 };

/** Every file under `dir` with its content, but the names in `skip`. */
async function snapshot(dir: string, skip: string[] = []): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	async function walk(rel: string): Promise<void> {
		for (const name of await readdir(join(dir, rel))) {
			const path = rel === "" ? name : join(rel, name);
			if (skip.includes(path)) continue;
			if ((await stat(join(dir, path))).isDirectory()) await walk(path);
			else files[path] = await readFile(join(dir, path), "utf-8");
		}
	}
	await walk("");
	return files;
}

/**
 * A session's main transcript: one user line, then one complete response, `id` (5 in, 6 out).
 * Message claims are shared by every session of a state dir, so two sessions need two ids.
 * `at` timestamps both lines, as Claude Code does; without it they carry none.
 */
async function writeTranscript(session = SESSION, id = "msg_a", at?: string): Promise<void> {
	const stamp = at === undefined ? {} : { timestamp: at };
	const user = JSON.stringify({
		type: "user",
		sessionId: SESSION,
		...stamp,
		message: { role: "user", content: "synthetic" },
	});
	const response = JSON.stringify({
		type: "assistant",
		sessionId: SESSION,
		uuid: `${id}-final`,
		...stamp,
		message: {
			id,
			model: SONNET,
			role: "assistant",
			type: "message",
			stop_reason: "end_turn",
			content: [{ type: "text", text: "synthetic" }],
			usage: {
				input_tokens: 5,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 6,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
			},
		},
	});
	await writeFile(transcriptPath(session), `${user}\n${response}\n`);
}

const paths = () => seen.map((request) => request.path);
const settles = () => seen.filter((request) => request.path === "/v1/settle");

describe("the breaker's file (breaker.mjs)", () => {
	let breaker: BreakerModule;
	beforeEach(async () => {
		breaker = await breakerModule();
		breaker.useBreakerHome(home);
	});
	afterEach(() => breaker.useBreakerHome(null));
	const answers = async () => true;

	it("three timeouts within a minute open it, and one under a second never counts", async () => {
		const t = Date.now() - 10;
		expect(breaker.noteTimeout(url, 2_000, { now: t })).toBe(false);
		expect(breaker.noteTimeout(url, 999, { now: t + 1 })).toBe(false);
		expect(breaker.noteTimeout(url, 2_000, { now: t + 2 })).toBe(false);
		expect((await breaker.consultBreaker(url, answers)).state).toBe("closed");
		expect(await breakerState()).toMatchObject({ timeouts: [t, t + 2] });
		expect(breaker.noteTimeout(url, 2_000, { now: t + 3 })).toBe(true);
		expect((await breaker.consultBreaker(url, answers)).state).toBe("open");
		expect(await breakerState()).toMatchObject({ openedAt: t + 3, timeouts: [] });
	});

	it("any answer clears the count: a timeout, an answer, then two timeouts stays closed", async () => {
		const t = Date.now() - 10;
		breaker.noteTimeout(url, 2_000, { now: t });
		breaker.noteAnswer(url, { now: t + 1 });
		breaker.noteTimeout(url, 2_000, { now: t + 2 });
		expect(breaker.noteTimeout(url, 2_000, { now: t + 3 })).toBe(false);
		expect((await breaker.consultBreaker(url, answers)).state).toBe("closed");
		expect(await breakerState()).toMatchObject({ timeouts: [t + 2, t + 3] });
	});

	it("a timeout older than a minute falls out of the count", async () => {
		const t = Date.now();
		breaker.noteTimeout(url, 2_000, { now: t - 61_000 });
		breaker.noteTimeout(url, 2_000, { now: t - 1 });
		expect(breaker.noteTimeout(url, 2_000, { now: t })).toBe(false);
		expect((await breaker.consultBreaker(url, answers)).state).toBe("closed");
	});

	it("each server has its own: tripping one leaves another closed", async () => {
		const other = await startServer();
		const t = Date.now() - 10;
		for (const n of [0, 1, 2]) breaker.noteTimeout(url, 2_000, { now: t + n });
		expect((await breaker.consultBreaker(url, answers)).state).toBe("open");
		expect((await breaker.consultBreaker(other, answers)).state).toBe("closed");
		expect(await breakerState(other)).toBeNull();
	});

	it("a corrupt file, one not the user's own, or one too large reads closed", async () => {
		await openBreaker();
		expect((await breaker.consultBreaker(url, answers)).state).toBe("open");
		await writeFile(breakerFile(), "{ not json");
		expect((await breaker.consultBreaker(url, answers)).state).toBe("closed");
		await openBreaker();
		await chmod(breakerFile(), 0o644);
		expect((await breaker.consultBreaker(url, answers)).state).toBe("closed");
		nodeFs.rmSync(breakerFile());
		await writeBreaker({
			openUntil: Date.now() + 60_000,
			openedAt: Date.now(),
			timeouts: [],
			pad: "x".repeat(5_000),
		});
		expect((await breaker.consultBreaker(url, answers)).state).toBe("closed");
	});

	it("an open breaker is open for a minute from when it opened, whatever openUntil says, and never if it opened in the future", async () => {
		const now = Date.now();
		const year = 365 * 24 * 60 * 60 * 1000;
		const clock = () => now;
		await writeBreaker({ openUntil: now + year, openedAt: now - 30_000, timeouts: [] });
		expect((await breaker.consultBreaker(url, answers, { clock })).state).toBe("open");
		await writeBreaker({ openUntil: now + year, openedAt: now - 61_000, timeouts: [] });
		let probes = 0;
		const counted = async () => {
			probes += 1;
			return true;
		};
		expect(await breaker.consultBreaker(url, counted, { clock })).toMatchObject({
			state: "closed",
			closed: true,
		});
		expect(probes).toBe(1);
		expect(await breakerState()).toBeNull();
		await writeBreaker({ openUntil: now + year, openedAt: now + 3_600_000, timeouts: [] });
		expect((await breaker.consultBreaker(url, counted, { clock })).state).toBe("closed");
		expect(probes).toBe(1);
	});

	it("past its minute ONE hook probes, the others skip while it does, and a stale marker reads closed", async () => {
		await dueBreaker();
		let probes = 0;
		const slow = async () => {
			probes += 1;
			await new Promise((resolve) => setTimeout(resolve, 200));
			return true;
		};
		const verdicts = await Promise.all([
			breaker.consultBreaker(url, slow),
			breaker.consultBreaker(url, slow),
		]);
		expect(probes).toBe(1);
		expect(verdicts.map((verdict) => verdict.state).sort()).toEqual(["closed", "open"]);
		// A marker its prober left behind, dead, reads closed: removed, and no probe of its own.
		await dueBreaker();
		const marker = breakerFile().replace(/\.json$/u, ".probe");
		await writeFile(marker, "");
		const old = new Date(Date.now() - 6_000);
		await utimes(marker, old, old);
		expect((await breaker.consultBreaker(url, slow)).state).toBe("closed");
		expect(probes).toBe(1);
		expect(nodeFs.existsSync(marker)).toBe(false);
	});

	it("a probe marker dated past PROBE_STALE_MS ahead (the clock was set back) reads stale; one a second ahead still has its prober", async () => {
		await dueBreaker();
		let probes = 0;
		const counted = async () => {
			probes += 1;
			return true;
		};
		const marker = breakerFile().replace(/\.json$/u, ".probe");
		await writeFile(marker, "");
		const ahead = new Date(Date.now() + 3_600_000);
		await utimes(marker, ahead, ahead);
		expect((await breaker.consultBreaker(url, counted)).state).toBe("closed");
		expect(probes).toBe(0);
		expect(nodeFs.existsSync(marker)).toBe(false);
		// A fresh marker's mtime, finer than Date.now(), can lead it by under a millisecond: a
		// marker a second ahead still has its prober at work.
		await writeFile(marker, "");
		const soon = new Date(Date.now() + 1_000);
		await utimes(marker, soon, soon);
		expect((await breaker.consultBreaker(url, counted)).state).toBe("open");
		expect(probes).toBe(0);
		expect(nodeFs.existsSync(marker)).toBe(true);
	});

	it("a probe that gets no answer opens it for another minute", async () => {
		await dueBreaker();
		const before = Date.now();
		expect(await breaker.consultBreaker(url, async () => false)).toMatchObject({
			state: "open",
			reopened: true,
		});
		const state = (await breakerState()) as { openUntil: number; openedAt: number };
		expect(state.openedAt).toBeGreaterThanOrEqual(before);
		expect(state.openUntil).toBe(state.openedAt + 60_000);
	});

	it("a breaker directory that fails its checks reads closed, and says why", async () => {
		const parent = join(home, ".local", "state", "usertrust");
		await mkdir(parent, { recursive: true, mode: 0o700 });
		const elsewhere = nodeFs.realpathSync(await mkdtemp(join(tmpdir(), "utcc-brk-elsewhere-")));
		await symlink(elsewhere, breakerDir());
		await writeFile(
			join(elsewhere, `${sha16(url)}.json`),
			JSON.stringify({ openUntil: Date.now() + 60_000, openedAt: Date.now(), timeouts: [] }),
			{ mode: 0o600 },
		);
		expect(await breaker.consultBreaker(url, answers)).toEqual({
			state: "closed",
			note: "symlink",
		});
		nodeFs.unlinkSync(breakerDir());
		await openBreaker();
		await chmod(breakerDir(), 0o770);
		expect(await breaker.consultBreaker(url, answers)).toEqual({ state: "closed", note: "mode" });
	});
});

describe("under an open breaker, every hook sends nothing and touches nothing", () => {
	it("PreToolUse: a transcript-mode call is deferred, an estimate-mode call is a gap", async () => {
		await writeTranscript();
		await openBreaker();
		const pre = await run("pre-tool-use", preInput("tu_1"));
		expect(pre.code).toBe(0);
		expect(pre.stdout).toBe("");
		expect(seen).toEqual([]);
		expect(await records()).toMatchObject([
			{
				kind: "deferred",
				phase: "pre-tool-use",
				outcome: "deferred",
				reason: "breaker-open",
				tool: "Bash",
				session: SESSION,
			},
		]);
		// The agent's transcript state is untouched: no cursor, no window, no marker. Only the
		// state's first-run time is stamped (transcript.mjs `stampFirstRun`).
		expect(await readdir(stateDir)).toEqual(["transcripts", "watch.jsonl"]);
		expect(await readdir(join(stateDir, "transcripts"))).toEqual(["since"]);
		// Another session: a session's settings, its usage included, are pinned at its first hook.
		await run("pre-tool-use", preInput("tu_2", "estimate-session"), { UT_CC_USAGE: "estimate" });
		expect(seen).toEqual([]);
		expect((await records())[1]).toMatchObject({
			kind: "gap",
			phase: "pre-tool-use",
			reason: "breaker-open",
		});
	});

	it("PostToolUse leaves the state dir byte-identical but for its record and the first-run time, and the first Stop after the close settles that hold ONCE", async () => {
		await seedHold("tu_1", "tx_1", WINDOW);
		await openBreaker();
		const before = await snapshot(stateDir);
		const post = await run("post-tool-use", postInput("tu_1"));
		expect(post.code).toBe(0);
		expect(seen).toEqual([]);
		expect(await snapshot(stateDir, ["watch.jsonl", join("transcripts", "since")])).toEqual(before);
		expect(await records()).toMatchObject([
			{
				kind: "deferred",
				phase: "post-tool-use",
				transferIds: ["tx_1"],
				reason: "breaker-open",
			},
		]);
		// Its minute over, the probe finds the server answering: closed, and the Stop settles.
		await dueBreaker();
		const stop = await run("stop", bare());
		expect(stop.code).toBe(0);
		expect(await breakerState()).toBeNull();
		expect(settles()).toHaveLength(1);
		expect(settles()[0]?.body).toMatchObject({
			transferId: "tx_1",
			inputTokens: 5,
			outputTokens: 6,
		});
	});

	it("a transcript call skipped under an open breaker is posted ONCE, by the remainder after the close", async () => {
		await writeTranscript();
		await openBreaker();
		await run("pre-tool-use", preInput("tu_1"));
		expect(seen).toEqual([]);
		await dueBreaker();
		await run("stop", { session_id: SESSION, transcript_path: transcriptPath() });
		expect(settles()).toHaveLength(1);
		expect(settles()[0]?.body).toMatchObject({ inputTokens: 5, outputTokens: 6 });
		await run("stop", { session_id: SESSION, transcript_path: transcriptPath() });
		expect(settles()).toHaveLength(1);
	});

	it.each<[string, () => Record<string, unknown>]>([
		["pre-tool-use", () => preInput("tu_1")],
		["post-tool-use", () => postInput("tu_1")],
		["stop", bare],
		["subagent-stop", () => ({ session_id: SESSION, agent_id: "agent1" })],
		["session-end", bare],
	])(
		"on a fresh state dir, the %s skip stamps the state's first-run time: the outage's usage is posted after the close",
		async (hook, input) => {
			await openBreaker();
			await run(hook, input());
			expect(seen).toEqual([]);
			// A response of the outage, timestamped as Claude Code writes one, after the skip.
			await writeTranscript(SESSION, "msg_a", new Date().toISOString());
			await new Promise((resolve) => setTimeout(resolve, 5));
			await dueBreaker();
			await run("stop", { session_id: SESSION, transcript_path: transcriptPath() });
			expect(settles()).toHaveLength(1);
			expect(settles()[0]?.body).toMatchObject({ inputTokens: 5, outputTokens: 6 });
		},
	);

	it("control: with no hook before the close, the same response predates the state, and is never posted", async () => {
		await openBreaker();
		await writeTranscript(SESSION, "msg_a", new Date().toISOString());
		await new Promise((resolve) => setTimeout(resolve, 5));
		await dueBreaker();
		await run("stop", { session_id: SESSION, transcript_path: transcriptPath() });
		expect(await breakerState()).toBeNull();
		expect(settles()).toEqual([]);
	});

	it("an estimate hold PostToolUse leaves is a gap: no later hook charges it, one only gives it back", async () => {
		await seedHold("tu_1", "tx_1", ESTIMATE);
		await openBreaker();
		await run("post-tool-use", postInput("tu_1"), { UT_CC_USAGE: "estimate" });
		expect(seen).toEqual([]);
		expect(await records()).toMatchObject([
			{ kind: "gap", phase: "post-tool-use", transferIds: ["tx_1"], reason: "breaker-open" },
		]);
		// Its call ran: the hold is claimed as settle-attempted, by a local rename.
		expect((await readdir(stateDir)).filter((name) => name.includes("tx_1"))).toEqual([
			holdName("tu_1", "tx_1", "main", "settling"),
		]);
		// An estimate-mode skip stamps no first-run time: it has no transcript state.
		expect(nodeFs.existsSync(join(stateDir, "transcripts"))).toBe(false);
	});

	it("with no tool_use_id, a skipped estimate hold is never the next call's: that call settles its own hold, and Stop gives the skipped one back as call-ran", async () => {
		capabilities = ["release"];
		const env = { UT_CC_USAGE: "estimate" };
		// A host that sends no tool_use_id: PostToolUse takes the oldest hold it can pair.
		const pre = (n: number) => ({
			session_id: SESSION,
			tool_name: "Bash",
			tool_input: { command: `echo ${n}` },
		});
		const post = (n: number) => ({
			session_id: SESSION,
			tool_name: "Bash",
			tool_response: `out ${n}`,
		});
		await run("pre-tool-use", pre(1), env);
		await openBreaker();
		await run("post-tool-use", post(1), env);
		expect(settles()).toEqual([]);
		// The minute over, the next call holds afresh, and its PostToolUse settles ITS hold.
		await dueBreaker();
		await run("pre-tool-use", pre(2), env);
		await run("post-tool-use", post(2), env);
		expect(settles().map((request) => request.body.transferId)).toEqual(["tx_s2"]);
		await run("stop", bare(), env);
		// The skipped call's hold is given back as a call that ran, its charge unconfirmed.
		expect(seen.filter((request) => request.path === "/v1/release")).toMatchObject([
			{ body: { transferId: "tx_s1" } },
		]);
		expect((await records()).filter((record) => record.tool === "(unconfirmed)")).toMatchObject([
			{ transferId: "tx_s1", releaseClass: "call-ran" },
		]);
	});

	it("Stop and SubagentStop each record a deferral naming the holds they leave, those whose settle or give-back was attempted included, once each", async () => {
		await seedHold("tu_1", "tx_1", WINDOW);
		await seedHold("tu_2", "tx_2", WINDOW, "agent1");
		await seedHold("tu_3", "tx_3", WINDOW, "main", "settling");
		await seedHold("tu_4", "tx_4", { ...WINDOW, assignedIds: [] }, "agent1", "releasing");
		// Met twice, as when a hook claims it between the two listings: named once.
		await seedHold("tu_5", "tx_5", WINDOW);
		await seedHold("tu_5", "tx_5", WINDOW, "main", "settling");
		await openBreaker();
		await run("subagent-stop", { session_id: SESSION, agent_id: "agent1" });
		await run("stop", bare());
		expect(seen).toEqual([]);
		const [subagent, stop] = await records();
		expect(subagent).toMatchObject({ kind: "deferred", phase: "subagent-stop" });
		expect([...((subagent?.transferIds as string[] | undefined) ?? [])].sort()).toEqual([
			"tx_2",
			"tx_4",
		]);
		expect(stop).toMatchObject({ kind: "deferred", phase: "stop" });
		expect([...((stop?.transferIds as string[] | undefined) ?? [])].sort()).toEqual([
			"tx_1",
			"tx_2",
			"tx_3",
			"tx_4",
			"tx_5",
		]);
	});

	it("SessionEnd records a GAP, not a deferral, naming the holds it leaves: no later hook of the session settles them", async () => {
		await seedHold("tu_1", "tx_1", WINDOW);
		// An estimate hold whose settle went unanswered: settle-attempted.
		await seedHold("tu_2", "tx_2", ESTIMATE, "main", "settling");
		await openBreaker();
		await run("session-end", bare());
		expect(seen).toEqual([]);
		const written = await records();
		expect(written).toMatchObject([
			{ kind: "gap", phase: "session-end", outcome: "deferred", reason: "breaker-open" },
		]);
		expect([...((written[0]?.transferIds as string[] | undefined) ?? [])].sort()).toEqual([
			"tx_1",
			"tx_2",
		]);
	});

	it("a deferred hold whose later settle fails yields exactly one gap, under the deferral's transferId", async () => {
		await seedHold("tu_1", "tx_1", WINDOW);
		await openBreaker();
		await run("post-tool-use", postInput("tu_1"));
		await dueBreaker();
		override = (path) =>
			path === "/v1/settle" ? { status: 500, json: { error: "down" } } : undefined;
		await run("stop", bare());
		const all = await records();
		expect(all.filter((record) => record.kind === "deferred")).toMatchObject([
			{ transferIds: ["tx_1"] },
		]);
		expect(all.filter((record) => record.kind === "gap")).toMatchObject([
			{ phase: "settle", outcome: "claimed", transferId: "tx_1" },
		]);
	});

	it("enforce never reads it: an enforce hook sends as usual", async () => {
		await openBreaker();
		await run("pre-tool-use", preInput("tu_1"), { UT_CC_MODE: "enforce", UT_CC_USAGE: "estimate" });
		expect(paths()).toContain("/v1/authorize");
		expect((await records()).filter((record) => record.reason === "breaker-open")).toEqual([]);
	});

	it("enforce never counts toward it either: an enforce hook's timeouts leave no breaker", async () => {
		override = () => "hang";
		await run("pre-tool-use", preInput("tu_1", "enforce-session"), {
			UT_CC_MODE: "enforce",
			UT_FAIL_OPEN: "1",
			UT_CC_USAGE: "estimate",
		});
		expect(paths()).toEqual(["/v1/health", "/v1/authorize"]);
		expect(await breakerState()).toBeNull();
	}, 30_000);

	it("one breaker per server, for every lane on the host: another state dir obeys it, another server does not", async () => {
		await openBreaker();
		const lane = await mkdtemp(join(tmpdir(), "utcc-brk-lane-"));
		await runHook(join(HOOKS, "pre-tool-use.mjs"), preInput("tu_1", "lane-b"), {
			...envFor({ UT_CC_USAGE: "estimate" }),
			UT_CC_STATE_DIR: lane,
		});
		expect(seen).toEqual([]);
		expect(await records(lane)).toMatchObject([{ kind: "gap", reason: "breaker-open" }]);
		// An estimate-mode skip stamps no first-run time: it has no transcript state.
		expect(await readdir(lane)).toEqual(["watch.jsonl"]);
		const other = await startServer();
		await runHook(join(HOOKS, "pre-tool-use.mjs"), preInput("tu_2", "lane-c"), {
			...envFor({ UT_CC_USAGE: "estimate" }),
			UT_SERVER_URL: other,
		});
		expect(paths()).toContain("/v1/authorize");
	});

	it("a configured session's hook, run as a child with nothing of the environment, obeys the breaker under the passwd home its parent read", async () => {
		const anchor = join(home, ".config", "usertrust");
		await mkdir(anchor, { recursive: true });
		await chmod(anchor, 0o700);
		const config = join(anchor, "session.json");
		await writeFile(config, JSON.stringify({ url, key: "k", mode: "watch", stateDir }), {
			mode: 0o600,
		});
		await openBreaker();
		const pre = await runHook(join(HOOKS, "pre-tool-use.mjs"), preInput("tu_1"), {
			TEST_PASSWD_HOME: home,
			UT_CC_CONFIG: config,
			UT_CC_USAGE: "estimate",
		});
		expect(pre.code).toBe(0);
		expect(seen).toEqual([]);
		expect(await records()).toMatchObject([{ phase: "pre-tool-use", reason: "breaker-open" }]);
	});
});

describe("what opens the breaker, and what never does", () => {
	it("refusals, 5xx answers and refused connections never open it", async () => {
		for (const status of [402, 403, 429, 503]) {
			override = (path) =>
				path === "/v1/authorize" || path === "/v1/health"
					? { status, json: { error: "x", reason: "y" } }
					: undefined;
			for (const n of [1, 2, 3]) {
				await run("pre-tool-use", preInput(`tu_${status}_${n}`), { UT_CC_USAGE: "estimate" });
			}
			expect(await breakerState()).toBeNull();
		}
		const refused = "http://127.0.0.1:9";
		for (const n of [1, 2, 3]) {
			await runHook(join(HOOKS, "pre-tool-use.mjs"), preInput(`tu_r${n}`, "refused"), {
				...envFor({ UT_CC_USAGE: "estimate" }),
				UT_SERVER_URL: refused,
			});
		}
		expect(await breakerState(refused)).toBeNull();
	}, 60_000);

	it("against a hung server, three timeouts trip it; the hook that trips it still sends the rest, and the next one sends nothing", async () => {
		override = () => "hang";
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use", preInput("tu_1"), env);
		expect(paths()).toEqual(["/v1/health", "/v1/authorize"]);
		expect((await breakerState())?.timeouts).toHaveLength(2);
		// Its probe is the third timeout: the breaker opens, and this hook's authorize goes all the same.
		await run("pre-tool-use", preInput("tu_2"), env);
		expect(paths()).toEqual(["/v1/health", "/v1/authorize", "/v1/health", "/v1/authorize"]);
		expect(await breakerState()).toMatchObject({ timeouts: [] });
		expect(typeof (await breakerState())?.openUntil).toBe("number");
		await run("pre-tool-use", preInput("tu_3"), env);
		expect(seen).toHaveLength(4);
		expect((await records()).at(-1)).toMatchObject({
			kind: "gap",
			phase: "pre-tool-use",
			reason: "breaker-open",
		});
	}, 60_000);

	it("a server that sends its headers and then stalls is a hung one: three timeouts trip it", async () => {
		override = () => "stall";
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use", preInput("tu_1"), env);
		expect(paths()).toEqual(["/v1/health", "/v1/authorize"]);
		expect((await breakerState())?.timeouts).toHaveLength(2);
		await run("pre-tool-use", preInput("tu_2"), env);
		expect(typeof (await breakerState())?.openUntil).toBe("number");
		await run("pre-tool-use", preInput("tu_3"), env);
		expect(seen).toHaveLength(4);
		expect((await records()).at(-1)).toMatchObject({
			kind: "gap",
			phase: "pre-tool-use",
			reason: "breaker-open",
		});
	}, 60_000);

	it("a whole answer, its body read, still clears the count", async () => {
		override = () => "stall";
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use", preInput("tu_1"), env);
		expect((await breakerState())?.timeouts).toHaveLength(2);
		override = undefined;
		await run("pre-tool-use", preInput("tu_2"), env);
		expect(await breakerState()).toEqual({ timeouts: [] });
	}, 60_000);

	it("a half-open probe whose answer stalls after its headers opens it for another minute", async () => {
		await dueBreaker();
		override = (path) => (path === "/v1/health" ? "stall" : undefined);
		const before = Date.now();
		const pre = await run("pre-tool-use", preInput("tu_1"), { UT_CC_USAGE: "estimate" });
		expect(pre.code).toBe(0);
		expect(paths()).toEqual(["/v1/health"]);
		expect(pre.stderr).toContain("its breaker stays open for another minute");
		expect(Number((await breakerState())?.openedAt)).toBeGreaterThanOrEqual(before);
		expect((await records()).at(-1)).toMatchObject({ reason: "breaker-open" });
	}, 30_000);

	it("a server that answers between its timeouts never opens it: the count is of timeouts in a row", async () => {
		override = (path) => (path === "/v1/health" ? "hang" : undefined);
		for (const call of ["tu_1", "tu_2", "tu_3"]) {
			await run("pre-tool-use", preInput(call), { UT_CC_USAGE: "estimate" });
		}
		// Each hook's probe timed out, and its authorize was answered: never two timeouts in a row.
		expect(paths().filter((path) => path === "/v1/authorize")).toHaveLength(3);
		expect(await breakerState()).toEqual({ timeouts: [] });
	}, 60_000);
});

describe("a settle or give-back that does not end cleanly is written down, under its transferId", () => {
	const gaps = async () => (await records()).filter((record) => record.kind === "gap");

	it("PostToolUse, a transcript hold: claimed (a 500), released (a 400), unresolved (a 500 under a key)", async () => {
		await seedHold("tu_1", "tx_1", WINDOW);
		await seedHold("tu_2", "tx_2", WINDOW);
		await seedHold("tu_3", "tx_3", {
			...WINDOW,
			idempotencyKey: `cc:${"a".repeat(48)}`,
			agentType: "main",
		});
		override = (path, body) =>
			path === "/v1/settle"
				? body.transferId === "tx_2"
					? { status: 400, json: { error: "bad" } }
					: { status: 500, json: { error: "down" } }
				: undefined;
		for (const call of ["tu_1", "tu_2", "tu_3"]) await run("post-tool-use", postInput(call));
		expect(await gaps()).toMatchObject([
			{ phase: "settle", outcome: "claimed", transferId: "tx_1", session: SESSION },
			{ phase: "settle", outcome: "released", transferId: "tx_2" },
			{ phase: "settle", outcome: "unresolved", transferId: "tx_3" },
		]);
	});

	it("PreToolUse: a repeated call's earlier hold whose settle ends claimed (a 500, the hold then given back) is written down before the call holds afresh", async () => {
		capabilities = ["release"];
		await writeTranscript();
		await run("pre-tool-use", preInput("tu_1"));
		override = (path) =>
			path === "/v1/settle" ? { status: 500, json: { error: "down" } } : undefined;
		const again = await run("pre-tool-use", preInput("tu_1"));
		// The give-back confirmed the hold gone, so the call reserves afresh.
		expect(paths().filter((path) => path === "/v1/release")).toHaveLength(1);
		expect(again.stderr).toContain("this tool call's earlier hold tx_s1 is ended");
		expect(paths().filter((path) => path === "/v1/authorize")).toHaveLength(2);
		expect(await gaps()).toMatchObject([
			{ phase: "settle", outcome: "claimed", transferId: "tx_s1", session: SESSION },
		]);
	});

	it("PostToolUse, an estimate hold: failed (a 500), and unknown when this hook's timer cuts the settle off", async () => {
		const env = { UT_CC_USAGE: "estimate" };
		await seedHold("tu_1", "tx_1", ESTIMATE);
		override = (path) =>
			path === "/v1/settle" ? { status: 500, json: { error: "down" } } : undefined;
		await run("post-tool-use", postInput("tu_1"), env);
		await seedHold("tu_2", "tx_2", ESTIMATE);
		override = (path) => (path === "/v1/settle" ? "hang" : undefined);
		await run("post-tool-use", postInput("tu_2"), env);
		expect(await gaps()).toMatchObject([
			{ phase: "settle", outcome: "failed", transferId: "tx_1", reason: "settle returned 500" },
			{ phase: "settle", outcome: "unknown", transferId: "tx_2" },
		]);
	}, 30_000);

	it("Stop: a leftover window's settle, and an estimate hold's give-back the server refuses", async () => {
		capabilities = ["release"];
		await seedHold("tu_1", "tx_1", WINDOW);
		await seedHold("tu_2", "tx_2", ESTIMATE);
		override = (path) =>
			path === "/v1/settle" || path === "/v1/release"
				? { status: 500, json: { error: "down" } }
				: undefined;
		await run("stop", bare());
		const written = await gaps();
		expect(written.filter((record) => record.phase === "settle")).toMatchObject([
			{ outcome: "claimed", transferId: "tx_1" },
		]);
		expect(written.filter((record) => record.phase === "release")).toMatchObject([
			{ outcome: "failed", transferId: "tx_2", releaseClass: "call-unconfirmed" },
		]);
		// The give-back's own gap (the call may have run, uncharged) names the same hold.
		expect(written.filter((record) => record.tool === "(unconfirmed)")).toMatchObject([
			{ transferId: "tx_2" },
		]);
	});

	it("SubagentStop and SessionEnd: the same, for the holds each ends", async () => {
		await seedHold("tu_1", "tx_1", WINDOW, "agent1");
		await seedHold("tu_2", "tx_2", WINDOW);
		override = (path) =>
			path === "/v1/settle" ? { status: 500, json: { error: "down" } } : undefined;
		await run("subagent-stop", { session_id: SESSION, agent_id: "agent1" });
		await run("session-end", bare());
		expect(await gaps()).toMatchObject([
			{ phase: "settle", outcome: "claimed", transferId: "tx_1", agent: "agent1" },
			{ phase: "settle", outcome: "claimed", transferId: "tx_2", agent: "main" },
		]);
	});

	it("Stop's remainder: a post that does not settle is written down, with its model and message count", async () => {
		await writeTranscript();
		override = (path) =>
			path === "/v1/settle" ? { status: 500, json: { error: "down" } } : undefined;
		await run("stop", { session_id: SESSION, transcript_path: transcriptPath() });
		expect(await gaps()).toMatchObject([
			{
				phase: "remainder",
				outcome: "claimed",
				transferId: "tx_s1",
				model: SONNET,
				messages: 1,
			},
		]);
	});

	it("a give-back this hook's timer cuts off is unknown, not failed", async () => {
		capabilities = ["release"];
		await seedHold("tu_1", "tx_1", { usage: "transcript", holdModel: SONNET, assignedIds: [] });
		override = (path) => (path === "/v1/release" ? "hang" : undefined);
		await run("stop", bare());
		expect(await gaps()).toMatchObject([
			{ phase: "release", outcome: "unknown", transferId: "tx_1", releaseClass: "unused" },
		]);
	}, 30_000);

	it("Stop's remainder under a key: unresolved, and its retry at the next Stop is written down too", async () => {
		capabilities = ["idempotency-key", "release"];
		await writeTranscript();
		override = (path) =>
			path === "/v1/settle" ? { status: 500, json: { error: "down" } } : undefined;
		await run("stop", { session_id: SESSION, transcript_path: transcriptPath() });
		await run("stop", { session_id: SESSION, transcript_path: transcriptPath() });
		expect((await gaps()).filter((record) => record.phase === "remainder")).toMatchObject([
			{ outcome: "unresolved", model: SONNET, messages: 1 },
			{ outcome: "unresolved", model: SONNET, messages: 1 },
		]);
	});

	it("Stop: an estimate hold its settle left unanswered, whose give-back fails, is written down as call-ran", async () => {
		capabilities = ["release"];
		const env = { UT_CC_USAGE: "estimate" };
		await seedHold("tu_1", "tx_1", ESTIMATE);
		override = (path) =>
			path === "/v1/settle" || path === "/v1/release"
				? { status: 500, json: { error: "down" } }
				: undefined;
		await run("post-tool-use", postInput("tu_1"), env);
		await run("stop", bare(), env);
		expect((await gaps()).filter((record) => record.phase === "release")).toMatchObject([
			{ outcome: "failed", transferId: "tx_1", releaseClass: "call-ran" },
		]);
	});

	it("an empty hold the server no longer holds writes no gap: a release's, or a settle at zero's, 404 unknown transferId", async () => {
		const gone = { status: 404, json: { error: "not_found", reason: "unknown transferId" } };
		const empty = { usage: "transcript", holdModel: SONNET, assignedIds: [] };
		// A server that can release: the give-back is a release.
		capabilities = ["release"];
		await seedHold("tu_1", "tx_1", empty);
		override = (path) => (path === "/v1/release" || path === "/v1/settle" ? gone : undefined);
		await run("post-tool-use", postInput("tu_1"));
		expect(seen.filter((request) => request.path === "/v1/release")).toMatchObject([
			{ body: { transferId: "tx_1" } },
		]);
		// A server that cannot: the give-back is a settle at zero.
		capabilities = [];
		await seedHold("tu_2", "tx_2", empty);
		await run("post-tool-use", postInput("tu_2"));
		expect(settles()).toMatchObject([{ body: { transferId: "tx_2", inputTokens: 0 } }]);
		expect(await gaps()).toEqual([]);
	});

	it("Stop: a give-back the server answers 404 unknown transferId writes no release gap, and an estimate hold's call keeps its own gap", async () => {
		capabilities = ["release"];
		await seedHold("tu_1", "tx_1", { usage: "transcript", holdModel: SONNET, assignedIds: [] });
		await seedHold("tu_2", "tx_2", ESTIMATE);
		override = (path) =>
			path === "/v1/release"
				? { status: 404, json: { error: "not_found", reason: "unknown transferId" } }
				: undefined;
		await run("stop", bare());
		expect(seen.filter((request) => request.path === "/v1/release")).toHaveLength(2);
		const written = await gaps();
		expect(written.filter((record) => record.phase === "release")).toEqual([]);
		expect(written).toMatchObject([
			{ tool: "(unconfirmed)", transferId: "tx_2", releaseClass: "call-unconfirmed" },
		]);
	});

	it("control: settles and give-backs that end cleanly write nothing", async () => {
		capabilities = ["release"];
		await seedHold("tu_1", "tx_1", WINDOW);
		await seedHold("tu_2", "tx_2", { usage: "transcript", holdModel: SONNET, assignedIds: [] });
		await run("post-tool-use", postInput("tu_1"));
		await run("stop", bare());
		expect(paths()).toEqual(expect.arrayContaining(["/v1/settle", "/v1/release"]));
		expect(await gaps()).toEqual([]);
	});
});

describe("a probe that fails falls back to a remembered answer, for the principal alone", () => {
	const keyHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);
	const cacheDir = () => join(stateDir, "capabilities");
	const cacheFile = (server = url, key = "k") =>
		join(cacheDir(), `${sha16(server)}-${keyHash(key)}.json`);
	async function remember(list: string[], server = url, key = "k"): Promise<string> {
		await mkdir(cacheDir(), { recursive: true, mode: 0o700 });
		const path = cacheFile(server, key);
		await writeFile(path, JSON.stringify({ capabilities: list, at: new Date().toISOString() }), {
			mode: 0o600,
		});
		return path;
	}
	const authorize = () => seen.find((request) => request.path === "/v1/authorize")?.body;
	const estimate = { UT_CC_USAGE: "estimate" };
	const healthFails = () => {
		override = (path) => (path === "/v1/health" ? { status: 503, json: {} } : undefined);
	};

	it("a probe that answers is remembered, 0600, with the server's list; a server that records no principal starts none", async () => {
		capabilities = ["release", "principal"];
		await run("pre-tool-use", preInput("tu_1"), estimate);
		const entry = JSON.parse(await readFile(cacheFile(), "utf-8")) as { capabilities: string[] };
		expect(entry.capabilities).toEqual(["principal", "release"]);
		expect((await stat(cacheFile())).mode & 0o777).toBe(0o600);
		capabilities = ["release"];
		const lane = await mkdtemp(join(tmpdir(), "utcc-brk-lane-"));
		await runHook(join(HOOKS, "pre-tool-use.mjs"), preInput("tu_2", "lane-b"), {
			...envFor(estimate),
			UT_CC_STATE_DIR: lane,
		});
		expect(nodeFs.existsSync(join(lane, "capabilities"))).toBe(false);
	});

	it("a health probe that hangs: the authorize carries the remembered principal and no idempotency key, and says so", async () => {
		await remember(["idempotency-key", "principal", "release"]);
		override = (path) => (path === "/v1/health" ? "hang" : undefined);
		const pre = await run("pre-tool-use", preInput("tu_1"), estimate);
		expect(authorize()?.principal).toBeDefined();
		expect(authorize()?.idempotencyKey).toBeUndefined();
		expect(pre.stderr).toContain("a cached answer from");
		expect(pre.stderr).toContain("this hook sends it, and no idempotency key");
	}, 30_000);

	it("what another key's or another server's probe remembered is not used", async () => {
		capabilities = ["principal"];
		// Another key's session on this server, and this key's session on another server, each
		// remember an answer that records a principal.
		await run("pre-tool-use", preInput("tu_k2", "key-two"), { ...estimate, UT_SERVER_KEY: "k2" });
		const other = await startServer();
		await runHook(join(HOOKS, "pre-tool-use.mjs"), preInput("tu_o", "other-server"), {
			...envFor(estimate),
			UT_SERVER_URL: other,
		});
		expect(nodeFs.existsSync(cacheFile(url, "k2"))).toBe(true);
		expect(nodeFs.existsSync(cacheFile(other, "k"))).toBe(true);
		// This server and this key: the probe fails, and nothing remembered for them says principal.
		seen = [];
		healthFails();
		await run("pre-tool-use", preInput("tu_1"), estimate);
		expect(authorize()?.principal).toBeUndefined();
	});

	it("a corrupt entry, one over a day old, or one dated in the future counts as none", async () => {
		healthFails();
		const path = await remember(["principal"]);
		await writeFile(path, "{ not json", { mode: 0o600 });
		await run("pre-tool-use", preInput("tu_1"), estimate);
		await remember(["principal"]);
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
		await utimes(path, old, old);
		await run("pre-tool-use", preInput("tu_2"), estimate);
		await remember(["principal"]);
		const future = new Date(Date.now() + 60 * 60 * 1000);
		await utimes(path, future, future);
		await run("pre-tool-use", preInput("tu_3"), estimate);
		const authorizes = seen.filter((request) => request.path === "/v1/authorize");
		expect(authorizes).toHaveLength(3);
		for (const request of authorizes) expect(request.body.principal).toBeUndefined();
	});

	it("a probe that fails remembers nothing", async () => {
		healthFails();
		await run("pre-tool-use", preInput("tu_1"), estimate);
		expect(nodeFs.existsSync(cacheDir())).toBe(false);
	});

	it("with the probe failing, nothing but the principal changes: an entry listing idempotency-key sends no key", async () => {
		healthFails();
		// Two sessions, each with one new response for its window, so each authorize could carry a
		// key: the first before an answer is remembered, the second after.
		await writeTranscript("session-a", "msg_sa");
		await run("pre-tool-use", preInput("tu_1", "session-a"));
		await remember(["idempotency-key", "principal", "release", "job"]);
		await writeTranscript("session-b", "msg_sb");
		await run("pre-tool-use", preInput("tu_2", "session-b"));
		const [without, withEntry] = seen
			.filter((request) => request.path === "/v1/authorize")
			.map((request) => request.body);
		expect((without?.params as Record<string, unknown> | undefined)?.messages).toBe(1);
		expect(without?.principal).toBeUndefined();
		expect(withEntry?.principal).toBeDefined();
		expect(without?.idempotencyKey).toBeUndefined();
		expect(withEntry?.idempotencyKey).toBeUndefined();
		expect(Object.keys(withEntry ?? {}).sort()).toEqual(
			[...Object.keys(without ?? {}), "principal"].sort(),
		);
	});
});
