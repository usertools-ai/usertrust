// Real-usage settlement from Claude Code's session transcripts.
//
// Every transcript here is SYNTHETIC: written by this file in the measured
// shape (one JSONL per agent; subagents under <session>/subagents/ with a
// meta.json carrying agentType; one API response spread over several entries
// sharing message.id, only the final one carrying stop_reason; a provider
// usage block with disjoint input / cache-read / cache-write / output counts).
// No real transcript content is used or copied.
//
// The mechanism under test: the PreToolUse hold is the settlement vehicle. It
// is assigned the agent's new complete messages (one model's worth) and
// PostToolUse SETTLES it at their counts — no abort on the normal path. What no
// hold picked up is posted by Stop/SubagentStop, one authorize→settle per model.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readLedgerEvents } from "usertrust";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../../server/src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../../server/src/server.js";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const SESSION = "11111111-2222-4333-8444-555555555555";
const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5";

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface Recorded {
	path: string;
	body: Record<string, unknown>;
	status: number;
	response: unknown;
}

interface Cursor {
	v: number;
	byteOffset: number;
	partial: Record<string, unknown>;
	accounted: string[];
	denied: string[];
	assigned: Record<string, string>;
	estimateMode: boolean;
	lastModel: string | null;
}

let stateDir: string;
let projectDir: string;
let mainTranscript: string;
let fake: Server | undefined;
let real: UsertrustServer | undefined;
let port: number;
let requests: Recorded[];
let delayMs: number;
/** What the fake server's /v1/health publishes: none, an older server, unless a test says. Null: health fails. */
let capabilities: string[] | null;

type Responder = (path: string, body: Record<string, unknown>) => { status: number; json: unknown };

let nextTransfer = 0;
const okResponder: Responder = (path) => {
	if (path === "/v1/authorize") {
		nextTransfer += 1;
		return { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
	}
	return { status: 200, json: { settled: true, aborted: true } };
};

/** A recording server: a fixed responder, or a pass-through to a real usertrust-server. */
function startServer(responder: Responder | { forwardTo: string; key: string }): Promise<void> {
	return new Promise((resolve) => {
		fake = createServer((req, res) => {
			if (req.method === "GET" && req.url === "/v1/health") {
				// What the server honours: answered, never logged.
				void health(responder).then(({ status, json }) => {
					res.writeHead(status, { "content-type": "application/json" });
					res.end(JSON.stringify(json));
				});
				return;
			}
			// Bound to THIS test's log: a delayed answer must not land in the next test's.
			const log = requests;
			const delay = delayMs;
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", async () => {
				const path = req.url ?? "";
				const body = JSON.parse(raw || "{}") as Record<string, unknown>;
				if (delay > 0) await new Promise((r) => setTimeout(r, delay));
				let out: { status: number; json: unknown };
				if (typeof responder === "function") {
					out = responder(path, body);
				} else {
					const r = await fetch(`${responder.forwardTo}${path}`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${responder.key}`,
						},
						body: raw,
					});
					out = { status: r.status, json: await r.json() };
				}
				log.push({ path, body, status: out.status, response: out.json });
				if (res.destroyed) return;
				// Status 0: the request was processed, and its answer is lost.
				if (out.status === 0) {
					res.destroy();
					return;
				}
				res.writeHead(out.status, { "content-type": "application/json" });
				res.end(JSON.stringify(out.json));
			});
		});
		fake.listen(0, "127.0.0.1", () => {
			const address = fake?.address();
			port = typeof address === "object" && address !== null ? address.port : 0;
			resolve();
		});
	});
}

async function health(
	responder: Responder | { forwardTo: string; key: string },
): Promise<{ status: number; json: unknown }> {
	if (typeof responder === "function") {
		return capabilities === null
			? { status: 503, json: { error: "unavailable" } }
			: { status: 200, json: { status: "ok", capabilities } };
	}
	const r = await fetch(`${responder.forwardTo}/v1/health`);
	return { status: r.status, json: await r.json() };
}

function run(name: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
	return runHook(join(HOOKS, name), input, {
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_URL: `http://127.0.0.1:${port}`,
		UT_SERVER_KEY: "k",
		...env,
	});
}

/** The entries one API response writes: partial stream entries, then the final one. */
function responseEntries(
	id: string,
	model: string,
	u: Usage,
	extra: Record<string, unknown> = {},
	options: { partials?: number; complete?: boolean } = {},
): string[] {
	const lines: string[] = [];
	const partials = options.partials ?? 2;
	const usage = (output: number) => ({
		input_tokens: u.input,
		cache_creation_input_tokens: u.cacheWrite,
		cache_read_input_tokens: u.cacheRead,
		output_tokens: output,
		cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite, ephemeral_1h_input_tokens: 0 },
		service_tier: "standard",
	});
	for (let i = 0; i < partials; i += 1) {
		lines.push(
			JSON.stringify({
				type: "assistant",
				sessionId: SESSION,
				uuid: `${id}-p${i}`,
				...extra,
				message: {
					id,
					model,
					role: "assistant",
					type: "message",
					stop_reason: null,
					content: [{ type: "text", text: "synthetic" }],
					usage: usage(Math.max(1, Math.floor((u.output * (i + 1)) / (partials + 2)))),
				},
			}),
		);
	}
	if (options.complete !== false) {
		lines.push(
			JSON.stringify({
				type: "assistant",
				sessionId: SESSION,
				uuid: `${id}-final`,
				...extra,
				message: {
					id,
					model,
					role: "assistant",
					type: "message",
					stop_reason: "end_turn",
					content: [{ type: "text", text: "synthetic" }],
					usage: { ...usage(u.output), iterations: [{ type: "message" }] },
				},
			}),
		);
	}
	return lines;
}

const userLine = JSON.stringify({
	type: "user",
	sessionId: SESSION,
	message: { role: "user", content: "synthetic" },
});

async function writeMain(lines: string[]) {
	await writeFile(mainTranscript, `${[userLine, ...lines].join("\n")}\n`);
}

async function appendMain(lines: string[]) {
	await appendFile(mainTranscript, `${lines.join("\n")}\n`);
}

async function writeSubagent(agentId: string, agentType: string | null, lines: string[]) {
	const dir = join(projectDir, SESSION, "subagents");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `agent-${agentId}.jsonl`), `${lines.join("\n")}\n`);
	if (agentType !== null) {
		await writeFile(
			join(dir, `agent-${agentId}.meta.json`),
			JSON.stringify({ agentType, description: "synthetic", toolUseId: "tu_spawn", spawnDepth: 1 }),
		);
	}
}

function sub(agentId: string) {
	return { agentId, isSidechain: true };
}

const u = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage => ({
	input,
	output,
	cacheRead,
	cacheWrite,
});

const settles = () => requests.filter((r) => r.path === "/v1/settle");
const authorizes = () => requests.filter((r) => r.path === "/v1/authorize");
const aborts = () => requests.filter((r) => r.path === "/v1/abort");
const transferOf = (r: Recorded | undefined) =>
	(r?.response as { transferId?: string } | undefined)?.transferId;

const cursorPath = (agentId = "main") =>
	join(stateDir, "transcripts", `${SESSION}__${agentId}.json`);
async function readCursor(agentId = "main"): Promise<Cursor> {
	return JSON.parse(await readFile(cursorPath(agentId), "utf-8")) as Cursor;
}
/** Pending-hold files (live), excluding the transcripts dir. */
async function holdFiles() {
	return (await readdir(stateDir)).filter((n) => n !== "transcripts").sort();
}

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-tx-state-"));
	projectDir = await mkdtemp(join(tmpdir(), "utcc-tx-proj-"));
	mainTranscript = join(projectDir, `${SESSION}.jsonl`);
	requests = [];
	nextTransfer = 0;
	delayMs = 0;
	capabilities = [];
});
afterEach(async () => {
	fake?.closeAllConnections();
	fake?.close();
	fake = undefined;
	await real?.close();
	real = undefined;
});

const stopInput = () => ({ session_id: SESSION, transcript_path: mainTranscript });
const preInput = (toolUseId: string, extra: Record<string, unknown> = {}) => ({
	...stopInput(),
	tool_name: "Bash",
	tool_use_id: toolUseId,
	tool_input: { command: "ls" },
	...extra,
});
const postInput = (toolUseId: string, extra: Record<string, unknown> = {}) => ({
	...stopInput(),
	tool_use_id: toolUseId,
	tool_response: "eight ch",
	...extra,
});

/** JSON.stringify({command:"ls"}) is 16 chars → 4 estimated tokens; the output hold is 4096. */
const TOOL_INPUT_ESTIMATE = 4;
const TOOL_OUTPUT_HOLD = 4096;

describe("the normal path — the hold is the settlement vehicle", () => {
	it("PreToolUse assigns the window; PostToolUse settles THAT hold at its exact counts, no abort", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(10, 200, 5000, 300)));
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(pre.code).toBe(0);
		expect(JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
		const auth = authorizes()[0];
		expect(auth?.body).toMatchObject({
			model: SONNET,
			// The window held at real cost (cache writes 2x) PLUS the tool estimate.
			estimatedInputTokens: 10 + 5000 + 2 * 300 + TOOL_INPUT_ESTIMATE,
			maxOutputTokens: 200 + TOOL_OUTPUT_HOLD,
			params: {
				hook: "PreToolUse",
				tool_name: "Bash",
				usageOrigin: "transcript",
				agent_id: "main",
				agent_type: "main",
				messages: 1,
			},
			actor: `claude-code:${SESSION}:main:main`,
			// The tool input is still sent for the PII scan.
			messages: [{ role: "user", content: '{"command":"ls"}' }],
		});
		expect((await readCursor()).assigned).toEqual({ msg_a: "tx_1" });

		const post = await run("post-tool-use.mjs", postInput("tu_1"));
		expect(post.code).toBe(0);
		expect(requests.map((r) => r.path)).toEqual(["/v1/authorize", "/v1/settle"]);
		expect(settles()[0]?.body).toEqual({
			transferId: "tx_1",
			inputTokens: 10,
			outputTokens: 200,
			cacheReadTokens: 5000,
			cacheWriteTokens: 300,
			usageSource: "provider",
		});
		expect(await holdFiles()).toEqual([]);
		const cursor = await readCursor();
		expect(cursor.accounted).toEqual(["msg_a"]);
		expect(cursor.assigned).toEqual({});
		// Nothing is left for Stop: no remainder, no leftover hold.
		await run("stop.mjs", stopInput());
		expect(requests).toHaveLength(2);
	});

	it("parallel tool calls: one hold gets the window, the rest settle at zero — 0 aborts in 5", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(7, 70, 700, 0)));
		const ids = ["tu_0", "tu_1", "tu_2", "tu_3", "tu_4"];
		const pres = await Promise.all(ids.map((id) => run("pre-tool-use.mjs", preInput(id))));
		expect(pres.map((r) => r.code)).toEqual([0, 0, 0, 0, 0]);
		const windows = authorizes().filter(
			(a) => (a.body.params as { usageOrigin?: string }).usageOrigin === "transcript",
		);
		expect(windows).toHaveLength(1);
		const posts = await Promise.all(ids.map((id) => run("post-tool-use.mjs", postInput(id))));
		expect(posts.map((r) => r.code)).toEqual([0, 0, 0, 0, 0]);
		expect(aborts()).toHaveLength(0);
		expect(settles()).toHaveLength(5);
		const real = settles().filter((s) => s.body.inputTokens !== 0);
		expect(real).toHaveLength(1);
		expect(real[0]?.body).toMatchObject({
			transferId: transferOf(windows[0]),
			inputTokens: 7,
			outputTokens: 70,
			cacheReadTokens: 700,
		});
		for (const s of settles().filter((x) => x.body.inputTokens === 0)) {
			expect(s.body).toMatchObject({ outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
		}
		await run("stop.mjs", stopInput());
		expect(settles()).toHaveLength(5);
		expect(aborts()).toHaveLength(0);
	});

	it("the window is ONE model's messages; another model's wait for the remainder", async () => {
		await startServer(okResponder);
		await writeMain([
			...responseEntries("msg_a", SONNET, u(1, 1)),
			...responseEntries("msg_h", HAIKU, u(2, 2)),
			...responseEntries("msg_b", SONNET, u(3, 3)),
		]);
		await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(authorizes()[0]?.body).toMatchObject({
			model: SONNET,
			params: { messages: 2 },
			maxOutputTokens: 1 + 3 + TOOL_OUTPUT_HOLD,
		});
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect(settles()[0]?.body).toMatchObject({ transferId: "tx_1", inputTokens: 4 });
		await run("stop.mjs", stopInput());
		expect(authorizes()[1]?.body.model).toBe(HAIKU);
		expect(settles().map((s) => s.body.inputTokens)).toEqual([4, 2]);
	});

	it("a subagent's window is attributed to its own id and type", async () => {
		await startServer(okResponder);
		await writeMain([]);
		await writeSubagent("a1", "Explore", responseEntries("msg_s", HAIKU, u(2, 2), sub("a1")));
		await run("pre-tool-use.mjs", preInput("tu_s", { agent_id: "a1", agent_type: "ignored" }));
		expect(authorizes()[0]?.body).toMatchObject({
			model: HAIKU,
			actor: `claude-code:${SESSION}:Explore:a1`,
			params: { agent_id: "a1", agent_type: "Explore", messages: 1 },
		});
		await run("post-tool-use.mjs", postInput("tu_s", { agent_id: "a1" }));
		expect(settles()[0]?.body).toMatchObject({ transferId: "tx_1", inputTokens: 2 });
	});
});

describe("the remainder and leftover holds", () => {
	it("Stop posts the remainder per model — incl. a final answer — and SETTLES a leftover hold with ids", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(1, 10, 100, 0)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		// The tool was interrupted: no PostToolUse. The model went on.
		await appendMain([
			...responseEntries("msg_b", SONNET, u(2, 20, 200, 0)),
			...responseEntries("msg_c", HAIKU, u(3, 30, 0, 300)),
			// The final answer: no tool call, so no hold ever sees it.
			...responseEntries("msg_d", SONNET, u(4, 40, 400, 0)),
		]);
		const stop = await run("stop.mjs", stopInput());
		expect(stop.code).toBe(0);
		expect(aborts()).toHaveLength(0);
		const remainder = authorizes().slice(1);
		expect(
			remainder.map((a) => [a.body.model, (a.body.params as { messages: number }).messages]),
		).toEqual([
			[SONNET, 2],
			[HAIKU, 1],
		]);
		const byTransfer = (r: Recorded | undefined) =>
			settles().find((s) => s.body.transferId === transferOf(r))?.body;
		expect(byTransfer(remainder[0])).toMatchObject({
			inputTokens: 6,
			outputTokens: 60,
			cacheReadTokens: 600,
		});
		expect(byTransfer(remainder[1])).toMatchObject({ inputTokens: 3, cacheWriteTokens: 300 });
		// The interrupted tool's hold is settled with ITS window (msg_a), not aborted.
		expect(settles().find((s) => s.body.transferId === "tx_1")?.body).toMatchObject({
			inputTokens: 1,
			outputTokens: 10,
			cacheReadTokens: 100,
			usageSource: "provider",
		});
		expect(settles()).toHaveLength(3);
		expect(await holdFiles()).toEqual([]);
		expect((await readCursor()).accounted.sort()).toEqual(["msg_a", "msg_b", "msg_c", "msg_d"]);
	});

	it("Stop aborts a leftover hold that has no assigned usage", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(1, 1), {}, { complete: false }));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		// Nothing complete yet: the hold is the tool estimate alone, as before.
		expect(authorizes()[0]?.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
		expect(authorizes()[0]?.body.actor).toBe(`claude-code:${SESSION}`);
		await run("stop.mjs", stopInput());
		expect(settles()).toHaveLength(0);
		expect(aborts().map((a) => a.body.transferId)).toEqual(["tx_1"]);
		expect(await holdFiles()).toEqual([]);
	});

	it("a window that fails to authorize is released, and the remainder posts it", async () => {
		let denyPre = true;
		await startServer((path, body) => {
			if (
				path === "/v1/authorize" &&
				denyPre &&
				(body.params as { hook: string }).hook === "PreToolUse"
			) {
				return { status: 503, json: { error: "unavailable" } };
			}
			return okResponder(path, body);
		});
		await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(pre.code).toBe(2);
		expect((await readCursor()).assigned).toEqual({});
		denyPre = false;
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([5]);
	});
});

describe("failure handling — at most once", () => {
	it("a remainder authorize answering 402 marks the ids DENIED; they are never retried", async () => {
		await startServer((path, body) =>
			path === "/v1/authorize"
				? { status: 402, json: { error: "budget_exceeded", reason: "need 9, have 1" } }
				: okResponder(path, body),
		);
		await writeMain(responseEntries("msg_a", SONNET, u(11, 22, 33, 44)));
		const stop = await run("stop.mjs", stopInput());
		expect(stop.code).toBe(0);
		expect(stop.stderr).toContain("NOT recorded");
		expect(stop.stderr).toContain("input 11, output 22, cache read 33, cache write 44");
		expect(settles()).toHaveLength(0);
		expect((await readCursor()).denied).toEqual(["msg_a"]);
		await run("stop.mjs", stopInput());
		expect(requests).toHaveLength(1);
	});

	it("settle 500 then abort 200: the ids stay claimed and are never re-posted", async () => {
		let failSettle = true;
		await startServer((path, body) => {
			if (path === "/v1/settle" && failSettle) return { status: 500, json: { error: "internal" } };
			return okResponder(path, body);
		});
		await writeMain(responseEntries("msg_a", SONNET, u(3, 4)));
		await run("stop.mjs", stopInput());
		expect(requests.map((r) => [r.path, r.status])).toEqual([
			["/v1/authorize", 200],
			["/v1/settle", 500],
			["/v1/abort", 200],
		]);
		failSettle = false;
		await run("stop.mjs", stopInput());
		expect(requests).toHaveLength(3);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});

	it("settle 404: the ids are released and re-posted at the next settle point", async () => {
		let failSettle = true;
		await startServer((path, body) => {
			if (path === "/v1/settle" && failSettle) return { status: 404, json: { error: "not_found" } };
			return okResponder(path, body);
		});
		await writeMain(responseEntries("msg_a", SONNET, u(3, 4)));
		await run("stop.mjs", stopInput());
		expect(requests.map((r) => r.path)).toEqual(["/v1/authorize", "/v1/settle", "/v1/abort"]);
		failSettle = false;
		await run("stop.mjs", stopInput());
		const ok = settles().filter((s) => s.status === 200);
		expect(ok.map((s) => [s.body.inputTokens, s.body.outputTokens])).toEqual([[3, 4]]);
	});

	it("a PostToolUse settle 404 releases the window to the remainder; a 500 keeps it claimed", async () => {
		let settleStatus = 404;
		await startServer((path, body) => {
			if (path === "/v1/settle" && body.transferId === "tx_1") {
				return { status: settleStatus, json: { error: "x" } };
			}
			return okResponder(path, body);
		});
		await writeMain(responseEntries("msg_a", SONNET, u(8, 8)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect((await readCursor()).assigned).toEqual({});
		await run("stop.mjs", stopInput());
		expect(
			settles()
				.filter((s) => s.status === 200)
				.map((s) => s.body.inputTokens),
		).toEqual([8]);

		// Same again, but the hold's settle answers 500: never retried.
		stateDir = await mkdtemp(join(tmpdir(), "utcc-tx-state-"));
		requests = [];
		nextTransfer = 0;
		settleStatus = 500;
		await run("pre-tool-use.mjs", preInput("tu_1"));
		const post = await run("post-tool-use.mjs", postInput("tu_1"));
		expect(post.stderr).toContain("claimed");
		expect(aborts().map((a) => a.body.transferId)).toEqual(["tx_1"]);
		await run("stop.mjs", stopInput());
		expect(settles().filter((s) => s.status === 200)).toHaveLength(0);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});
});

describe("estimate mode and the cursor", () => {
	it("STICKY: unreadable at PreToolUse → estimate; readable later → still estimate, never real", async () => {
		await startServer(okResponder);
		// No transcript file yet.
		const pre1 = await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(pre1.code).toBe(0);
		expect(pre1.stderr).toContain("ESTIMATE");
		const post1 = await run("post-tool-use.mjs", postInput("tu_1"));
		expect(post1.stderr).toContain("settling at the ESTIMATE — transcript unreadable (ENOENT)");
		expect((await readCursor()).estimateMode).toBe(true);
		// The transcript appears, with usage that the estimate already stood for.
		await writeMain(responseEntries("msg_a", SONNET, u(9, 9, 9, 9)));
		await run("pre-tool-use.mjs", preInput("tu_2"));
		await run("post-tool-use.mjs", postInput("tu_2"));
		await run("stop.mjs", stopInput());
		expect(settles()).toHaveLength(2);
		for (const s of settles()) {
			expect(s.body).toMatchObject({
				inputTokens: TOOL_INPUT_ESTIMATE,
				outputTokens: 3,
				usageSource: "estimated",
			});
		}
		expect(authorizes()).toHaveLength(2);
		for (const a of authorizes())
			expect(a.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
		expect((await readCursor()).accounted).toEqual([]);
	});

	it("a CORRUPT cursor posts nothing and is left byte-identical", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(1, 1)));
		await mkdir(join(stateDir, "transcripts"), { mode: 0o700 });
		const corrupt = '{"v":1,"byteOffset":"not a number"';
		await writeFile(cursorPath(), corrupt);
		const stop = await run("stop.mjs", stopInput());
		expect(stop.code).toBe(0);
		expect(stop.stderr).toContain("corrupt");
		expect(requests).toEqual([]);
		// PreToolUse still governs the tool — at the estimate, with no window.
		await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(authorizes()[0]?.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect(settles()[0]?.body.usageSource).toBe("estimated");
		expect(await readFile(cursorPath(), "utf-8")).toBe(corrupt);
	});

	it("a cursor of an unknown version is corrupt too, not empty", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(1, 1)));
		await mkdir(join(stateDir, "transcripts"), { mode: 0o700 });
		const old = JSON.stringify({ accounted: [] });
		await writeFile(cursorPath(), old);
		await run("stop.mjs", stopInput());
		expect(requests).toEqual([]);
		expect(await readFile(cursorPath(), "utf-8")).toBe(old);
	});
});

describe("idempotency and concurrency", () => {
	it("a re-run settles nothing; a new message settles only itself", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(1, 2, 3, 4)));
		await run("stop.mjs", stopInput());
		await run("stop.mjs", stopInput());
		await run("subagent-stop.mjs", { ...stopInput(), agent_id: "nobody" });
		expect(settles()).toHaveLength(1);
		await appendMain(responseEntries("msg_b", SONNET, u(5, 6, 7, 8)));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([1, 5]);
	});

	it("concurrent settle points never post the same message twice", async () => {
		await startServer(okResponder);
		await writeMain(
			Array.from({ length: 20 }, (_, i) => responseEntries(`msg_${i}`, SONNET, u(1, 1))).flat(),
		);
		await Promise.all(Array.from({ length: 6 }, () => run("stop.mjs", stopInput())));
		await run("stop.mjs", stopInput());
		const total = settles().reduce((sum, s) => sum + Number(s.body.inputTokens), 0);
		expect(total).toBe(20);
	});

	it("a live lock means busy; a STALE lock is reclaimed", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(2, 2)));
		await mkdir(join(stateDir, "transcripts"), { mode: 0o700 });
		const lock = `${cursorPath()}.lock`;
		await mkdir(lock);
		await writeFile(join(lock, "owner"), "another-hook");
		const busy = await run("stop.mjs", stopInput());
		expect(busy.stderr).toContain("lock");
		expect(requests).toEqual([]);
		// The holder crashed two minutes ago.
		const old = new Date(Date.now() - 120_000);
		await utimes(lock, old, old);
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([2]);
		// Reclaimed, then released: no lock and no stale leftovers remain.
		expect((await readdir(join(stateDir, "transcripts"))).sort()).toEqual([
			`${SESSION}__main.json`,
			"claims",
		]);
	});

	it("a stale lock is reclaimed ONCE: a late reclaimer never removes its replacement, and two at once never both win", async () => {
		// The interleavings need one process (tests/helpers/lock-probe.mjs): whole
		// hook processes cannot be made to hit them.
		const dir = await mkdtemp(join(tmpdir(), "utcc-tx-lock-"));
		const { stdout } = await promisify(execFile)(process.execPath, [
			join(import.meta.dirname, "helpers", "lock-probe.mjs"),
			dir,
		]);
		expect(JSON.parse(stdout)).toEqual({
			first: true,
			late: false,
			ownerAfterLate: "A",
			// One holder: the second reclaimer waits out the first's mutex, then finds
			// the lock no longer the one it judged stale.
			won: [true, false],
			ownerAfterRace: "B",
		});
	});
});

describe("hardening", () => {
	it("a server slower than the per-call timeout: every hook exits 0 in < 12 s and no id is lost", async () => {
		delayMs = 5_500;
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(1, 1)));
		await writeSubagent("a1", "Plan", responseEntries("msg_s", SONNET, u(2, 2), sub("a1")));
		// A zero-usage transcript hold, so PostToolUse has a settle to time out on.
		await writeFile(
			join(stateDir, `${SESSION}__main__tu_z.json`),
			JSON.stringify({
				toolUseId: "tu_z",
				transferId: "tx_z",
				agentId: "main",
				usage: "transcript",
				holdModel: SONNET,
				assignedIds: [],
			}),
		);
		const hooks: Array<[string, Record<string, unknown>, Record<string, string>]> = [
			["pre-tool-use.mjs", preInput("tu_1"), { UT_FAIL_OPEN: "1" }],
			["pre-tool-use.mjs", preInput("tu_2", { agent_id: "a1" }), { UT_FAIL_OPEN: "1" }],
			["post-tool-use.mjs", postInput("tu_z"), {}],
			["subagent-stop.mjs", { ...stopInput(), agent_id: "a1" }, {}],
			["stop.mjs", stopInput(), {}],
		];
		for (const [hook, input, env] of hooks) {
			const started = Date.now();
			const result = await run(hook, input, env);
			expect(result.code, hook).toBe(0);
			expect(Date.now() - started, hook).toBeLessThan(12_000);
		}
		for (const agent of ["main", "a1"]) {
			const cursor = await readCursor(agent);
			expect(cursor.accounted, agent).toEqual([]);
			expect(cursor.assigned, agent).toEqual({});
		}
		// Once the server answers again, both messages post.
		delayMs = 0;
		await run("stop.mjs", stopInput());
		expect(
			requests
				.filter((r) => r.path === "/v1/settle" && r.status === 200 && r.body.inputTokens !== 0)
				.map((r) => r.body.inputTokens)
				.sort(),
		).toEqual([1, 2]);
	}, 60_000);

	it("a state dir writable by others is not trusted: estimate behaviour", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
		const dir = join(stateDir, "transcripts");
		await mkdir(dir);
		await chmod(dir, 0o777);
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(pre.code).toBe(0);
		expect(authorizes()[0]?.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
		const post = await run("post-tool-use.mjs", postInput("tu_1"));
		expect(post.stderr).toContain("writable by group or others");
		const stop = await run("stop.mjs", stopInput());
		expect(stop.stderr).toContain("writable by group or others");
		expect(settles().map((s) => s.body.usageSource)).toEqual(["estimated"]);
		expect(await readdir(dir)).toEqual([]);
	});

	it("an agent_id that would escape the subagents dir reads nothing", async () => {
		await startServer(okResponder);
		await writeMain([]);
		// Where a naive join of `agent-${id}.jsonl` would land for this id.
		const evil = "x/../../escape";
		await mkdir(join(projectDir, SESSION), { recursive: true });
		await writeFile(
			join(projectDir, SESSION, "escape.jsonl"),
			`${responseEntries("msg_e", SONNET, u(9, 9)).join("\n")}\n`,
		);
		const stop = await run("subagent-stop.mjs", { ...stopInput(), agent_id: evil });
		expect(stop.code).toBe(0);
		expect(requests).toEqual([]);
		await run("pre-tool-use.mjs", preInput("tu_1", { agent_id: evil }));
		expect(authorizes()[0]?.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
		expect(await readdir(join(stateDir, "transcripts")).catch(() => [])).toEqual([]);
	});

	it("per-id MAX: an appended <synthetic> zero entry with the same id neither lowers nor exempts it", async () => {
		await startServer(okResponder);
		await writeMain([
			...responseEntries("msg_a", SONNET, u(12, 34, 56, 78)),
			JSON.stringify({
				type: "assistant",
				sessionId: SESSION,
				message: {
					id: "msg_a",
					model: "<synthetic>",
					stop_reason: "stop_sequence",
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			}),
		]);
		await run("stop.mjs", stopInput());
		expect(authorizes()[0]?.body.model).toBe(SONNET);
		expect(settles()[0]?.body).toMatchObject({
			inputTokens: 12,
			outputTokens: 34,
			cacheReadTokens: 56,
			cacheWriteTokens: 78,
		});
	});

	it("the <synthetic> exemption needs ALL-zero usage, not just the first entry's model", async () => {
		await startServer(okResponder);
		await writeMain([
			// First seen as a zero-usage <synthetic> entry, still incomplete.
			JSON.stringify({
				type: "assistant",
				message: {
					id: "msg_x",
					model: "<synthetic>",
					stop_reason: null,
					usage: { input_tokens: 0 },
				},
			}),
			...responseEntries("msg_x", SONNET, u(6, 6), {}, { partials: 0 }),
		]);
		await run("stop.mjs", stopInput());
		expect(settles()[0]?.body).toMatchObject({ inputTokens: 6, outputTokens: 6 });
	});

	it("never prices Claude Code's synthetic placeholder messages", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_s", "<synthetic>", u(0, 0), {}, { partials: 0 }));
		await run("stop.mjs", stopInput());
		expect(requests).toEqual([]);
		expect((await readCursor()).accounted).toEqual(["msg_s"]);
	});

	it("incremental read: only past the last newline; a truncated file is re-read from 0", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(1, 1)));
		await run("stop.mjs", stopInput());
		const size = (await readFile(mainTranscript)).length;
		expect((await readCursor()).byteOffset).toBe(size);
		// Half a line: not consumed.
		const [line] = responseEntries("msg_b", SONNET, u(2, 2), {}, { partials: 0 });
		await appendFile(mainTranscript, line?.slice(0, 40) ?? "");
		await run("stop.mjs", stopInput());
		expect((await readCursor()).byteOffset).toBe(size);
		await appendFile(mainTranscript, `${line?.slice(40)}\n`);
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([1, 2]);
		// Replaced by a SHORTER file: re-read from 0; accounted ids are not re-posted.
		const shorter = [
			...responseEntries("msg_a", SONNET, u(1, 1), {}, { partials: 0 }),
			...responseEntries("msg_c", SONNET, u(3, 3), {}, { partials: 0 }),
		];
		await writeFile(mainTranscript, `${shorter.join("\n")}\n`);
		expect((await readFile(mainTranscript)).length).toBeLessThan(size);
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([1, 2, 3]);
	});

	it("leaves a message that is still streaming for the next settle point", async () => {
		await startServer(okResponder);
		await writeMain([
			...responseEntries("msg_a", SONNET, u(1, 10)),
			...responseEntries("msg_b", SONNET, u(2, 99), {}, { complete: false }),
		]);
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.outputTokens)).toEqual([10]);
		// msg_b completes later; only it is settled, at its FINAL output.
		await appendMain(responseEntries("msg_b", SONNET, u(2, 99), {}, { partials: 0 }));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.outputTokens)).toEqual([10, 99]);
	});
});

describe("per-subagent attribution", () => {
	it("Stop splits the ledger into main and each subagent, tagged with id and type", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_m", SONNET, u(1, 1)));
		await writeSubagent("a1", "Explore", responseEntries("msg_s1", HAIKU, u(2, 2), sub("a1")));
		await writeSubagent(
			"a2",
			"general-purpose",
			responseEntries("msg_s2", SONNET, u(3, 3), sub("a2")),
		);
		await run("stop.mjs", stopInput());
		const tags = authorizes()
			.map((a) => `${(a.body.params as { agent_type: string }).agent_type}:${a.body.actor}`)
			.sort();
		expect(tags).toEqual([
			`Explore:claude-code:${SESSION}:Explore:a1`,
			`general-purpose:claude-code:${SESSION}:general-purpose:a2`,
			`main:claude-code:${SESSION}:main:main`,
		]);
		// No content leaves the machine on a remainder settle.
		for (const a of authorizes()) expect(a.body.messages).toBeUndefined();
	});

	it("SubagentStop settles ONLY the stopping subagent, and Stop does not repeat it", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_m", SONNET, u(1, 1)));
		await writeSubagent("a1", null, responseEntries("msg_s1", SONNET, u(2, 2), sub("a1")));
		await writeSubagent("a2", "Plan", responseEntries("msg_s2", SONNET, u(3, 3), sub("a2")));
		await run("subagent-stop.mjs", { ...stopInput(), agent_id: "a1", agent_type: "Explore" });
		expect(authorizes().map((a) => a.body.actor)).toEqual([`claude-code:${SESSION}:Explore:a1`]);
		await run("stop.mjs", stopInput());
		expect(
			settles()
				.map((s) => s.body.inputTokens)
				.sort(),
		).toEqual([1, 2, 3]);
	});
});

describe("estimate holds", () => {
	async function seedHold(agentId: string, toolUseId: string, transferId: string) {
		await writeFile(
			join(stateDir, `${SESSION}__${agentId}__${toolUseId}.json`),
			JSON.stringify({ toolUseId, transferId, agentId, estimatedInputTokens: 4 }),
		);
	}

	it("Stop posts the remainder, then aborts an estimate hold that is left", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
		await seedHold("main", "tu_left", "tx_left");
		await run("stop.mjs", stopInput());
		expect(requests.map((r) => r.path)).toEqual(["/v1/authorize", "/v1/settle", "/v1/abort"]);
		expect(requests[2]?.body.transferId).toBe("tx_left");
		expect(await holdFiles()).toEqual([]);
	});

	it("UT_CC_USAGE=estimate reproduces the original estimate behaviour exactly", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
		const env = { UT_CC_USAGE: "estimate" };
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"), env);
		expect(pre.code).toBe(0);
		expect(authorizes()[0]?.body).toEqual({
			model: SONNET,
			estimatedInputTokens: TOOL_INPUT_ESTIMATE,
			maxOutputTokens: TOOL_OUTPUT_HOLD,
			params: { hook: "PreToolUse", tool_name: "Bash" },
			actor: `claude-code:${SESSION}`,
			messages: [{ role: "user", content: '{"command":"ls"}' }],
		});
		expect(
			JSON.parse(await readFile(join(stateDir, `${SESSION}__main__tu_1.json`), "utf-8")),
		).toEqual({ toolUseId: "tu_1", transferId: "tx_1", agentId: "main", estimatedInputTokens: 4 });
		const post = await run("post-tool-use.mjs", postInput("tu_1"), env);
		expect(post.stderr).toBe("");
		await run("stop.mjs", stopInput(), env);
		expect(requests.map((r) => r.path)).toEqual(["/v1/authorize", "/v1/settle"]);
		expect(settles()[0]?.body).toEqual({
			transferId: "tx_1",
			inputTokens: 4,
			outputTokens: 3,
			usageSource: "estimated",
		});
		// The transcript is never read and no transcript state is created.
		expect(await readdir(stateDir)).toEqual([]);
	});

	it("an estimate settle whose receipt says settled: false says the usage may be unrecorded", async () => {
		await startServer((path, body) =>
			path === "/v1/settle" ? { status: 200, json: { settled: false } } : okResponder(path, body),
		);
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use.mjs", preInput("tu_1"), env);
		const post = await run("post-tool-use.mjs", postInput("tu_1"), env);
		expect(post.stderr).toContain("may be unrecorded");
		// The hold is spent: its file goes, as on any 200.
		expect(await holdFiles()).toEqual([]);
	});

	it("a dead server never blocks or throws out of a settle point", async () => {
		port = 1; // nothing listens here
		await writeMain(responseEntries("msg_a", SONNET, u(1, 1)));
		for (const hook of ["post-tool-use.mjs", "stop.mjs", "subagent-stop.mjs"]) {
			const result = await run(hook, { ...stopInput(), agent_id: "main", tool_use_id: "tu_1" });
			expect(result.code).toBe(0);
		}
		// Nothing was posted, so nothing is claimed.
		expect((await readCursor()).accounted).toEqual([]);
	});
});

const ALL_CAPABILITIES = ["release", "idempotency-key", "principal", "settlement-unrecoverable"];

/** The key a vehicle of these message ids is authorized under (pinned: a change orphans parked retries). */
function keyOf(agentId: string, ids: string[]): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([SESSION, agentId, [...ids].sort()]))
		.digest("hex");
	return `cc:${digest.slice(0, 48)}`;
}

type SettleFault =
	| "post-then-500"
	| "500-before-post"
	| "post-then-lost"
	| "404-restarted"
	| "settled-false"
	| "409-duplicate"
	| "400";

/**
 * A fake that keeps usertrust #205's contract for keys: a replayed authorize of a
 * key with a live hold gets THAT hold back; a key whose charge stands is 409
 * `already_settled`, at authorize and at a second settle. `charges` is the ledger:
 * one entry per posted key. Faults apply to the next settle of the named hold.
 */
function keyedServer() {
	const holds = new Map<string, { key: string | undefined }>();
	const live = new Map<string, string>();
	const charged = new Set<string>();
	const charges: Array<{ key: string | undefined; transferId: string; inputTokens: unknown }> = [];
	const faults = new Map<string, SettleFault>();
	/** Set: every authorize answers this status, and nothing is held. */
	const authorizeFault: { status: number | null } = { status: null };
	let next = 0;
	const responder: Responder = (path, body) => {
		const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
		if (path === "/v1/authorize") {
			if (authorizeFault.status !== null) {
				return { status: authorizeFault.status, json: { error: "unavailable" } };
			}
			if (key !== undefined && charged.has(key)) {
				return { status: 409, json: { error: "already_settled", reason: "already charged" } };
			}
			const replay = key === undefined ? undefined : live.get(key);
			if (replay !== undefined)
				return { status: 200, json: { transferId: replay, estimatedCost: 1 } };
			next += 1;
			const transferId = `tx_${next}`;
			holds.set(transferId, { key });
			if (key !== undefined) live.set(key, transferId);
			return { status: 200, json: { transferId, estimatedCost: 1 } };
		}
		const transferId = String(body.transferId);
		const hold = holds.get(transferId);
		if (path === "/v1/settle") {
			const fault = faults.get(transferId);
			faults.delete(transferId);
			if (fault === "404-restarted") {
				// The server restarted: it holds nothing, and remembers no live key.
				holds.clear();
				live.clear();
				return { status: 404, json: { error: "not_found" } };
			}
			if (hold === undefined) return { status: 404, json: { error: "not_found" } };
			if (fault === "500-before-post") return { status: 500, json: { error: "internal" } };
			if (fault === "400") return { status: 400, json: { error: "bad_request" } };
			holds.delete(transferId);
			if (hold.key !== undefined) live.delete(hold.key);
			if (fault === "settled-false") {
				// The ledger post is ambiguous: the hold is spent, and nothing is known.
				return { status: 200, json: { settled: false, transferId } };
			}
			if (fault === "409-duplicate" && hold.key !== undefined) charged.add(hold.key);
			if (hold.key !== undefined && charged.has(hold.key)) {
				return { status: 409, json: { error: "already_settled", reason: "duplicate" } };
			}
			if (hold.key !== undefined) charged.add(hold.key);
			charges.push({ key: hold.key, transferId, inputTokens: body.inputTokens });
			if (fault === "post-then-500") return { status: 500, json: { error: "internal" } };
			if (fault === "post-then-lost") return { status: 0, json: null };
			return { status: 200, json: { settled: true, transferId } };
		}
		// /v1/release, /v1/abort
		holds.delete(transferId);
		if (hold?.key !== undefined) live.delete(hold.key);
		return { status: 200, json: { released: true } };
	};
	return { responder, charges, charged, faults, authorizeFault };
}

interface CursorV2 extends Cursor {
	unresolved: Record<string, { ids: string[]; inputTokens: number }>;
}

const releases = () => requests.filter((r) => r.path === "/v1/release");

describe("with a server that honours keys, principal and release (usertrust #205)", () => {
	beforeEach(() => {
		capabilities = [...ALL_CAPABILITIES];
	});

	it("a window's authorize carries its vehicle key and the principal; a settle carries neither", async () => {
		const server = keyedServer();
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(10, 20, 30, 40)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(authorizes()[0]?.body).toMatchObject({
			idempotencyKey: keyOf("main", ["msg_a"]),
			principal: { id: "main", type: "main", origin: `claude-code:${SESSION}` },
		});
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect(settles()[0]?.body).not.toHaveProperty("idempotencyKey");
		expect(settles()[0]?.body).not.toHaveProperty("principal");
		// The remainder is keyed by ITS ids, and names its agent too.
		await appendMain(responseEntries("msg_b", SONNET, u(1, 2)));
		await writeSubagent("a1", "Explore", responseEntries("msg_s", HAIKU, u(3, 4), sub("a1")));
		await run("stop.mjs", stopInput());
		const remainder = authorizes().slice(1);
		expect(remainder.map((a) => a.body.idempotencyKey).sort()).toEqual(
			[keyOf("main", ["msg_b"]), keyOf("a1", ["msg_s"])].sort(),
		);
		expect(remainder.find((a) => a.body.model === HAIKU)?.body.principal).toEqual({
			id: "a1",
			type: "Explore",
			origin: `claude-code:${SESSION}`,
		});
		expect(server.charges.map((c) => c.inputTokens).sort()).toEqual([1, 10, 3].sort());
	});

	it("an older server gets neither: no key, no principal, no release", async () => {
		capabilities = [];
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(1, 1)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("pre-tool-use.mjs", preInput("tu_2"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_2"));
		for (const a of authorizes()) {
			expect(a.body).not.toHaveProperty("idempotencyKey");
			expect(a.body).not.toHaveProperty("principal");
		}
		// The empty hold is settled at zero, as before: that server cannot release.
		expect(releases()).toHaveLength(0);
		expect(settles()).toHaveLength(2);
	});

	it("parallel tool calls: one window is settled, the empty holds are RELEASED — no 1-unit settles, no aborts", async () => {
		const server = keyedServer();
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(7, 70, 700, 0)));
		const ids = ["tu_0", "tu_1", "tu_2", "tu_3", "tu_4"];
		await Promise.all(ids.map((id) => run("pre-tool-use.mjs", preInput(id))));
		await Promise.all(ids.map((id) => run("post-tool-use.mjs", postInput(id))));
		expect(settles()).toHaveLength(1);
		expect(settles()[0]?.body).toMatchObject({ inputTokens: 7, outputTokens: 70 });
		expect(releases()).toHaveLength(4);
		expect(aborts()).toHaveLength(0);
		expect(server.charges).toHaveLength(1);
	});

	it("a settle that POSTED but answered 500 is unresolved, and its retry finds the charge: posted once", async () => {
		const server = keyedServer();
		server.faults.set("tx_1", "post-then-500");
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		const post = await run("post-tool-use.mjs", postInput("tu_1"));
		expect(post.stderr).toContain("unresolved");
		expect(post.stderr).toContain("NOT recorded yet");
		// Given back for hygiene, never aborted: the retry authorizes afresh.
		expect(releases().map((r) => r.body.transferId)).toEqual(["tx_1"]);
		expect(aborts()).toHaveLength(0);
		const parked = (await readCursor()) as CursorV2;
		expect(parked.accounted).toEqual([]);
		expect(parked.unresolved).toEqual({
			[keyOf("main", ["msg_a"])]: expect.objectContaining({ ids: ["msg_a"], inputTokens: 5 }),
		});

		await run("stop.mjs", stopInput());
		expect(authorizes().at(-1)?.body.idempotencyKey).toBe(keyOf("main", ["msg_a"]));
		expect(authorizes().at(-1)?.status).toBe(409);
		expect(server.charges).toHaveLength(1);
		const done = (await readCursor()) as CursorV2;
		expect(done.unresolved).toEqual({});
		expect(done.accounted).toEqual(["msg_a"]);
		// Resolved for good: a later Stop sends nothing.
		const before = requests.length;
		await run("stop.mjs", stopInput());
		expect(requests).toHaveLength(before);
	});

	it("a settle that failed BEFORE posting: given back, then charged once under its key by the retry", async () => {
		const server = keyedServer();
		server.faults.set("tx_1", "500-before-post");
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect(server.charges).toHaveLength(0);
		expect(releases().map((r) => r.body.transferId)).toEqual(["tx_1"]);
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => [s.body.transferId, s.status])).toEqual([
			["tx_1", 500],
			["tx_2", 200],
		]);
		expect(server.charges).toEqual([
			{ key: keyOf("main", ["msg_a"]), transferId: "tx_2", inputTokens: 5 },
		]);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});

	it("a settle whose answer is LOST is retried, and charges once", async () => {
		const server = keyedServer();
		server.faults.set("tx_1", "post-then-lost");
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect(Object.keys(((await readCursor()) as CursorV2).unresolved)).toHaveLength(1);
		await run("stop.mjs", stopInput());
		expect(server.charges).toHaveLength(1);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});

	it("a keyed settle answering 404 (the server restarted) is retried under its key: one fresh hold, one charge", async () => {
		const server = keyedServer();
		server.faults.set("tx_1", "404-restarted");
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		await run("stop.mjs", stopInput());
		expect(server.charges).toEqual([
			{ key: keyOf("main", ["msg_a"]), transferId: "tx_2", inputTokens: 5 },
		]);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});

	it("a 200 whose receipt says settled: false is unresolved too, and charged once by the retry", async () => {
		const server = keyedServer();
		server.faults.set("tx_1", "settled-false");
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect(Object.keys(((await readCursor()) as CursorV2).unresolved)).toEqual([
			keyOf("main", ["msg_a"]),
		]);
		await run("stop.mjs", stopInput());
		expect(server.charges).toEqual([
			{ key: keyOf("main", ["msg_a"]), transferId: "tx_2", inputTokens: 5 },
		]);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});

	it("a settle answering 409 already_settled is settled at once: the key's charge stands", async () => {
		const server = keyedServer();
		server.faults.set("tx_1", "409-duplicate");
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		const post = await run("post-tool-use.mjs", postInput("tu_1"));
		expect(post.stderr).toBe("");
		const cursor = (await readCursor()) as CursorV2;
		expect(cursor.accounted).toEqual(["msg_a"]);
		expect(cursor.unresolved).toEqual({});
		await run("stop.mjs", stopInput());
		expect(authorizes()).toHaveLength(1);
	});

	it("a retry that fails — authorize 503, or settle 400 — stays unresolved: never released, never re-keyed", async () => {
		const server = keyedServer();
		server.faults.set("tx_1", "500-before-post");
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		const key = keyOf("main", ["msg_a"]);
		server.authorizeFault.status = 503;
		await run("stop.mjs", stopInput());
		expect(Object.keys(((await readCursor()) as CursorV2).unresolved)).toEqual([key]);
		// It answers again, and rejects the retry's settle.
		server.authorizeFault.status = null;
		server.faults.set("tx_2", "400");
		await run("stop.mjs", stopInput());
		expect(settles().map((r) => [r.body.transferId, r.status])).toEqual([
			["tx_1", 500],
			["tx_2", 400],
		]);
		const parked = (await readCursor()) as CursorV2;
		expect(Object.keys(parked.unresolved)).toEqual([key]);
		expect(parked.accounted).toEqual([]);
		// Never folded into a remainder under another key; charged once when it can be.
		for (const a of authorizes()) expect(a.body.idempotencyKey).toBe(key);
		await run("stop.mjs", stopInput());
		expect(server.charges).toHaveLength(1);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});

	it("a window's key is the SORTED ids' key, whatever order the transcript lists them in", async () => {
		const server = keyedServer();
		await startServer(server.responder);
		await writeMain([
			...responseEntries("msg_z", SONNET, u(1, 1)),
			...responseEntries("msg_y", SONNET, u(2, 2)),
		]);
		await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(authorizes()[0]?.body.idempotencyKey).toBe(keyOf("main", ["msg_y", "msg_z"]));
		expect(keyOf("main", ["msg_z", "msg_y"])).toBe(keyOf("main", ["msg_y", "msg_z"]));
	});

	it("a hook that died mid-settle under a key: the stale settle is retried, not lost", async () => {
		const server = keyedServer();
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		// The hook renamed the hold to .settling, then died before any answer.
		const live = join(stateDir, `${SESSION}__main__tu_1.json`);
		const settling = join(stateDir, `${SESSION}__main__tu_1.settling`);
		await writeFile(settling, await readFile(live, "utf-8"));
		await rm(live);
		const old = new Date(Date.now() - 11 * 60_000);
		await utimes(settling, old, old);
		await run("stop.mjs", stopInput());
		expect(server.charges).toEqual([
			{ key: keyOf("main", ["msg_a"]), transferId: "tx_1", inputTokens: 5 },
		]);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
		expect(await holdFiles()).toEqual([]);
	});

	it("an unresolved settle waits for a server that honours keys: never retried without one", async () => {
		const server = keyedServer();
		server.faults.set("tx_1", "post-then-500");
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		// Downgraded: a key sent now would be stripped, and a retry could post twice.
		capabilities = [];
		const stop = await run("stop.mjs", stopInput());
		expect(stop.stderr).toContain("wait for a server that honours idempotency keys");
		expect(authorizes()).toHaveLength(1);
		expect(Object.keys(((await readCursor()) as CursorV2).unresolved)).toHaveLength(1);
		capabilities = [...ALL_CAPABILITIES];
		await run("stop.mjs", stopInput());
		expect(server.charges).toHaveLength(1);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});

	it("an unresolved vehicle is never folded into a new window: new messages get their own key", async () => {
		const server = keyedServer();
		server.faults.set("tx_1", "post-then-500");
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		await appendMain(responseEntries("msg_b", SONNET, u(7, 8)));
		await run("pre-tool-use.mjs", preInput("tu_2"));
		expect(authorizes().at(-1)?.body).toMatchObject({
			idempotencyKey: keyOf("main", ["msg_b"]),
			params: { messages: 1 },
		});
		await run("post-tool-use.mjs", postInput("tu_2"));
		await run("stop.mjs", stopInput());
		expect(server.charges.map((c) => c.inputTokens).sort()).toEqual([5, 7]);
		expect(((await readCursor()).accounted as string[]).sort()).toEqual(["msg_a", "msg_b"]);
	});

	it("PreToolUse: a window whose key is already charged is accounted, and the tool is held alone", async () => {
		const server = keyedServer();
		server.charged.add(keyOf("main", ["msg_a"]));
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(pre.code).toBe(0);
		expect(JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
		expect(authorizes().map((a) => a.status)).toEqual([409, 200]);
		expect(authorizes()[1]?.body).not.toHaveProperty("idempotencyKey");
		expect(authorizes()[1]?.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
		await run("post-tool-use.mjs", postInput("tu_1"));
		await run("stop.mjs", stopInput());
		expect(settles()).toHaveLength(0);
		expect(releases().map((r) => r.body.transferId)).toEqual(["tx_1"]);
	});

	it("Stop RELEASES a leftover hold without usage — not a failure, no abort", async () => {
		const server = keyedServer();
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(1, 1), {}, { complete: false }));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("stop.mjs", stopInput());
		expect(aborts()).toHaveLength(0);
		expect(releases().map((r) => r.body)).toEqual([
			{ transferId: "tx_1", reason: "session ended with unsettled hold" },
		]);
	});
});

describe("state that is lost, slow or unwritable", () => {
	it("a REMOVED cursor re-posts nothing: this agent's claims say what it already posted", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(4, 4)));
		await run("stop.mjs", stopInput());
		await rm(cursorPath());
		await appendMain(responseEntries("msg_b", SONNET, u(5, 5)));
		const stop = await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([4, 5]);
		expect((await readCursor()).accounted.sort()).toEqual(["msg_a", "msg_b"]);
		expect(stop.stderr).toContain(
			"1 transcript message(s) were claimed by this agent before its cursor",
		);
	});

	it("a claim made just before the hook died is still this agent's to post: the cursor recorded the intent first", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(4, 4)));
		// The state a hook killed right after claiming leaves: the cursor knows msg_a
		// as `claiming`, and the claim file names this agent.
		const dir = join(stateDir, "transcripts");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(
			cursorPath(),
			JSON.stringify({
				v: 2,
				byteOffset: (await readFile(mainTranscript)).length,
				nextSeq: 1,
				partial: {
					msg_a: {
						n: 0,
						model: SONNET,
						synthetic: false,
						complete: true,
						claimed: false,
						claiming: true,
						inputTokens: 4,
						outputTokens: 4,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
				},
				accounted: [],
				denied: [],
				assigned: {},
				authorizingAt: {},
				estimateMode: false,
				estimateReason: null,
				lastModel: SONNET,
				unresolved: {},
			}),
		);
		const digest = createHash("sha256").update("msg_a").digest("hex");
		await mkdir(join(dir, "claims", digest.slice(0, 2)), { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "claims", digest.slice(0, 2), digest.slice(2)), `${SESSION}/main`);
		const stop = await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([4]);
		expect(stop.stderr).not.toContain("before its cursor");
	});

	it("a message whose claim cannot be made is NOT posted, says so, and posts once it can", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(4, 4)));
		await mkdir(join(stateDir, "transcripts"), { recursive: true, mode: 0o700 });
		// Not a directory: every claim under it fails.
		await writeFile(join(stateDir, "transcripts", "claims"), "");
		const stop = await run("stop.mjs", stopInput());
		expect(stop.stderr).toContain("could not be claimed");
		expect(stop.stderr).toContain("NOT posted");
		expect(settles()).toHaveLength(0);
		await rm(join(stateDir, "transcripts", "claims"));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([4]);
	});

	it("an unkeyed 200 whose receipt says settled: false is claimed, and says the usage may be unrecorded", async () => {
		await startServer((path, body) =>
			path === "/v1/settle" ? { status: 200, json: { settled: false } } : okResponder(path, body),
		);
		await writeMain(responseEntries("msg_a", SONNET, u(4, 4)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		const post = await run("post-tool-use.mjs", postInput("tu_1"));
		expect(post.stderr).toContain("claimed");
		expect(post.stderr).toContain("may be unrecorded");
		// The hold is spent: nothing to give back.
		expect(aborts()).toHaveLength(0);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});

	it("capabilities UNKNOWN (health fails): no key, no principal — and the hook says so", async () => {
		capabilities = null;
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(4, 4)));
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(pre.code).toBe(0);
		expect(pre.stderr).toContain("capabilities are unknown");
		expect(authorizes()[0]?.body).not.toHaveProperty("idempotencyKey");
		expect(authorizes()[0]?.body).not.toHaveProperty("principal");
	});

	it("a settling hold's age is the settle's, not the hold's: a long tool never reads as a dead settle", async () => {
		capabilities = [...ALL_CAPABILITIES];
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(4, 4)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		// The tool ran for 11 minutes.
		const hold = join(stateDir, `${SESSION}__main__tu_1.json`);
		const old = new Date(Date.now() - 11 * 60_000);
		await utimes(hold, old, old);
		delayMs = 1_500;
		const posting = run("post-tool-use.mjs", postInput("tu_1"));
		const settling = join(stateDir, `${SESSION}__main__tu_1.settling`);
		let age = Number.NaN;
		for (let i = 0; i < 100 && Number.isNaN(age); i += 1) {
			age = await stat(settling).then(
				(info) => Date.now() - info.mtimeMs,
				() => Number.NaN,
			);
			if (Number.isNaN(age)) await new Promise((r) => setTimeout(r, 20));
		}
		expect(age).toBeLessThan(60_000);
		expect((await posting).code).toBe(0);
	});

	it("a keyed remainder is parked as unresolved BEFORE its call: a hook killed mid-call leaves it to be retried", async () => {
		capabilities = [...ALL_CAPABILITIES];
		const server = keyedServer();
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(4, 4)));
		delayMs = 1_500;
		const stopping = run("stop.mjs", stopInput());
		let parked: string[] = [];
		for (let i = 0; i < 100 && parked.length === 0; i += 1) {
			parked = await readFile(cursorPath(), "utf-8").then(
				(text) => Object.keys((JSON.parse(text) as CursorV2).unresolved ?? {}),
				() => [],
			);
			if (parked.length === 0) await new Promise((r) => setTimeout(r, 20));
		}
		expect(parked).toEqual([keyOf("main", ["msg_a"])]);
		await stopping;
		// And once the call returns, the vehicle is done.
		expect(((await readCursor()) as CursorV2).unresolved).toEqual({});
		expect(server.charges).toHaveLength(1);
	});

	it("Stop settles a leftover hold FIRST, so an unresolved one is retried by that same Stop", async () => {
		capabilities = [...ALL_CAPABILITIES];
		const server = keyedServer();
		server.faults.set("tx_1", "post-then-500");
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(4, 4)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		// The tool was interrupted: no PostToolUse. One Stop settles and resolves it.
		await run("stop.mjs", stopInput());
		expect(server.charges).toHaveLength(1);
		const cursor = (await readCursor()) as CursorV2;
		expect(cursor.unresolved).toEqual({});
		expect(cursor.accounted).toEqual(["msg_a"]);
	});

	it("an already-settled window is journalled beside the cursor, and the next lock holder applies the record", async () => {
		capabilities = [...ALL_CAPABILITIES];
		const server = keyedServer();
		server.charged.add(keyOf("main", ["msg_a"]));
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		const journal = (await readdir(stateDir)).filter((n) => n.endsWith(".done"));
		expect(journal).toHaveLength(1);
		expect(JSON.parse(await readFile(join(stateDir, journal[0] ?? ""), "utf-8"))).toMatchObject({
			agentId: "main",
			assignedIds: ["msg_a"],
			outcome: "settled",
		});
		// The next lock holder applies and removes it.
		await run("stop.mjs", stopInput());
		expect((await readdir(stateDir)).filter((n) => n.endsWith(".done"))).toEqual([]);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});
});

describe("forked subagents — inherited messages are posted once", () => {
	const inherited = () => [
		...responseEntries("msg_a", SONNET, u(100, 1)),
		...responseEntries("msg_b", SONNET, u(200, 2)),
	];
	const forkTranscript = () => [
		// A fork's transcript starts with its ancestor's entries: same ids, its own agentId.
		...responseEntries("msg_a", SONNET, u(100, 1), sub("f1")),
		...responseEntries("msg_b", SONNET, u(200, 2), sub("f1")),
		...responseEntries("msg_f", SONNET, u(7, 3), sub("f1")),
	];

	it("the parent posts its own messages; the fork posts only what it added", async () => {
		await startServer(okResponder);
		await writeMain(inherited());
		await writeSubagent("f1", "fork", forkTranscript());
		await run("stop.mjs", stopInput());
		const byActor = new Map(
			authorizes().map((a) => [String(a.body.actor), transferOf(a)] as const),
		);
		const settledFor = (actor: string) =>
			settles().find((s) => s.body.transferId === byActor.get(actor))?.body.inputTokens;
		expect(settledFor(`claude-code:${SESSION}:main:main`)).toBe(300);
		expect(settledFor(`claude-code:${SESSION}:fork:f1`)).toBe(7);
		expect(settles().reduce((sum, s) => sum + Number(s.body.inputTokens), 0)).toBe(307);
		// The fork's cursor accounts the inherited ids as posted elsewhere.
		expect((await readCursor("f1")).accounted.sort()).toEqual(["msg_a", "msg_b", "msg_f"]);
	});

	it("whichever agent claims a message first posts it — never both, in either order", async () => {
		await startServer(okResponder);
		await writeMain(inherited());
		await writeSubagent("f1", "fork", forkTranscript());
		// The fork stops first and claims the inherited messages.
		await run("subagent-stop.mjs", { ...stopInput(), agent_id: "f1", agent_type: "fork" });
		await run("stop.mjs", stopInput());
		await run("stop.mjs", stopInput());
		expect(settles().reduce((sum, s) => sum + Number(s.body.inputTokens), 0)).toBe(307);
		expect((await readCursor()).accounted.sort()).toEqual(["msg_a", "msg_b"]);
	});

	it("a window never carries a message another agent owns", async () => {
		await startServer(okResponder);
		await writeMain(inherited());
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await writeSubagent("f1", "fork", forkTranscript());
		await run("pre-tool-use.mjs", preInput("tu_2", { agent_id: "f1" }));
		expect(authorizes()[1]?.body.params).toMatchObject({ agent_id: "f1", messages: 1 });
		expect(authorizes()[1]?.body.estimatedInputTokens).toBe(7 + TOOL_INPUT_ESTIMATE);
	});
});

describe("against a REAL usertrust-server — cache tokens priced separately, never double-counted", () => {
	it("the receipts' four-tier usage is exactly the transcript's, and the cost reconciles", async () => {
		const KEY = "ut_plugin_transcript_key";
		const serverState = await mkdtemp(join(tmpdir(), "utcc-tx-srv-"));
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
		const { port: realPort } = await real.listen();
		// What THIS server honours decides what the plugin sends: today's server
		// publishes `principal` (#227) and no `idempotency-key`, so settles take the
		// at-most-once path.
		const health = (await (await fetch(`http://127.0.0.1:${realPort}/v1/health`)).json()) as {
			capabilities?: string[];
		};
		expect(health.capabilities).toContain("principal");
		await startServer({ forwardTo: `http://127.0.0.1:${realPort}`, key: KEY });
		// Two responses before the tool call: the hold carries them.
		await writeMain([
			...responseEntries("msg_a", SONNET, u(120, 800, 40_000, 2_000)),
			...responseEntries("msg_b", SONNET, u(30, 200, 42_000, 0)),
		]);
		expect((await run("pre-tool-use.mjs", preInput("tu_1"))).code).toBe(0);
		expect((await run("post-tool-use.mjs", postInput("tu_1"))).code).toBe(0);
		// The final answer: posted by Stop's remainder.
		await appendMain(responseEntries("msg_c", SONNET, u(5, 60, 44_000, 1_000)));
		expect((await run("stop.mjs", stopInput())).code).toBe(0);
		expect(aborts()).toHaveLength(0);
		const receipts = settles().map((s) => {
			expect(s.status).toBe(200);
			return s.response as {
				cost: number;
				postedCost?: number;
				usageSource: string;
				usage: Record<string, number>;
				pricing: { appliedRates: Record<string, number> };
			};
		});
		// No key is sent: this server claims no `idempotency-key`. The principal is
		// sent on every authorize, and the server records it on the call's AUDIT
		// records (not in the settle response).
		const principal = { id: "main", type: "main", origin: `claude-code:${SESSION}` };
		for (const a of authorizes()) {
			expect(a.status).toBe(200);
			expect(a.body).not.toHaveProperty("idempotencyKey");
			expect(a.body.principal).toEqual(principal);
		}
		await real.close();
		real = undefined;
		const calls = readLedgerEvents(join(serverState, "t", ".usertrust")).filter(
			(e) => e.kind === "llm_call",
		);
		expect(calls).toHaveLength(2);
		for (const call of calls) expect(call.data).toMatchObject({ principal });
		const expected = [
			{ inputTokens: 150, outputTokens: 1000, cacheReadTokens: 82_000, cacheWriteTokens: 2_000 },
			{ inputTokens: 5, outputTokens: 60, cacheReadTokens: 44_000, cacheWriteTokens: 1_000 },
		];
		expect(receipts).toHaveLength(2);
		receipts.forEach((receipt, i) => {
			const want = expected[i] as Record<string, number>;
			expect(receipt.usageSource).toBe("provider");
			expect(receipt.usage).toMatchObject(want);
			const r = receipt.pricing.appliedRates as {
				inputPer1k: number;
				outputPer1k: number;
				cacheReadPer1k: number;
				cacheWritePer1k: number;
			};
			// Each tier at its own rate. Folding cache into input (the double count)
			// would price every cache token at inputPer1k instead.
			const cost = Math.max(
				1,
				Math.ceil(
					((want.inputTokens ?? 0) * r.inputPer1k +
						(want.outputTokens ?? 0) * r.outputPer1k +
						(want.cacheReadTokens ?? 0) * r.cacheReadPer1k +
						(want.cacheWriteTokens ?? 0) * r.cacheWritePer1k) /
						1000,
				),
			);
			expect(receipt.cost).toBe(cost);
			expect(r.cacheReadPer1k).toBeLessThan(r.inputPer1k);
			// The hold was large enough: the full cost was posted, no shortfall cap.
			expect(receipt.postedCost ?? receipt.cost).toBe(receipt.cost);
		});
	});
});
