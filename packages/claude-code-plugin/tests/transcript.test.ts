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
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { costFromRates, getModelRates, readLedgerEvents } from "usertrust";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveCacheWriteRate } from "../../core/src/ledger/pricing.js";
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
				// An answer that outlived its test: the next test has its own log and its
				// own transfer ids (`nextTransfer`), which this responder must not touch.
				if (log !== requests) {
					res.destroy();
					return;
				}
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
	options: { partials?: number; complete?: boolean; text?: string } = {},
): string[] {
	const lines: string[] = [];
	const partials = options.partials ?? 2;
	const content = [{ type: "text", text: options.text ?? "synthetic" }];
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
					content,
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
					content,
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

/**
 * The main transcript with `count` lines of `bytes` NULs each before `lines` — a
 * SPARSE file: the NULs are holes, so a long transcript costs no real I/O.
 */
async function writeSparseMain(count: number, bytes: number, lines: string[]) {
	const handle = await open(mainTranscript, "w");
	try {
		const head = `${userLine}\n`;
		await handle.write(head, 0);
		let position = head.length;
		for (let i = 0; i < count; i += 1) {
			position += bytes - 1;
			await handle.write("\n", position);
			position += 1;
		}
		await handle.write(`${lines.join("\n")}\n`, position);
	} finally {
		await handle.close();
	}
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
	// The invariant a settle's 404 rests on (post-tool-use.mjs `settleEstimateHold`):
	// across every path these tests drive — estimate, transcript window, remainder,
	// retries, faults — the plugin never sends a second settle for any transferId.
	const settled = requests
		.filter((r) => r.path === "/v1/settle")
		.map((r) => String(r.body.transferId));
	expect(
		settled.filter((id, i) => settled.indexOf(id) !== i),
		"a transferId was settled twice",
	).toEqual([]);
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

/** C0 (ESC, BEL), DEL and C1 (CSI) — anything a terminal could act on. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control chars is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const HOSTILE = "\u001b[2J\u001b]0;pwned\u0007\u007f\u009b";

/**
 * A hold's file name (lib.mjs `holdFilePath`): by its call (the tool_use_id, or the
 * transferId when the host sends none) AND its transfer.
 */
function holdFile(call: string, transferId: string, kind = "json", agentId = "main") {
	return `${SESSION}__${agentId}__${call}.${transferId}.${kind}`;
}

/** Every hold-state file left: pending (`.json`) and settle-attempted (`.settling`). */
async function holdStateFiles() {
	return (await readdir(stateDir)).filter((n) => n.endsWith(".json") || n.endsWith(".settling"));
}

/** JSON.stringify({command:"ls"}) is 16 chars → 4 estimated tokens; the output hold is 4096. */
const TOOL_INPUT_ESTIMATE = 4;
const TOOL_OUTPUT_HOLD = 4096;

describe("the normal path — the hold is the settlement vehicle", () => {
	it("PreToolUse assigns the window; PostToolUse settles THAT hold at its exact counts, no abort", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(10, 200, 5000, 300)));
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(pre.code).toBe(0);
		// Watch (the default) lets the call through with no permission decision.
		expect(pre.stdout).toBe("");
		const auth = authorizes()[0];
		expect(auth?.body).toMatchObject({
			model: SONNET,
			// The window PLUS the tool estimate, as one sum: this (older) server prices
			// every estimated input token at its higher input/cache-write rate.
			estimatedInputTokens: 10 + 5000 + 300 + TOOL_INPUT_ESTIMATE,
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
		expect(auth?.body).not.toHaveProperty("estimatedCacheReadTokens");
		expect(auth?.body).not.toHaveProperty("estimatedCacheWriteTokens");
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

	it("a hold is sized at each tier's own rate where the server can (477 for the real-server window), and never under the real cost where it can't", async () => {
		// The real-server test's first window: 150 in, 82 000 cache read, 2 000 cache
		// write, 1 000 out. Priced as usertrust prices a hold — the estimated input at
		// the higher of the input and cache-write rates, each cache tier given apart at
		// its own (the `authorize-cache-tiers` contract, #231) — at today's Sonnet rates.
		const rates = getModelRates(SONNET);
		const holdRates = {
			...rates,
			inputPer1k: Math.max(rates.inputPer1k, effectiveCacheWriteRate(rates)),
		};
		// The window's part of a hold: the fields, less the tool call's own estimate.
		const windowHold = (body: Record<string, unknown>) =>
			costFromRates(
				holdRates,
				Number(body.estimatedInputTokens) - TOOL_INPUT_ESTIMATE,
				Number(body.maxOutputTokens) - TOOL_OUTPUT_HOLD,
				Number(body.estimatedCacheReadTokens ?? 0),
				Number(body.estimatedCacheWriteTokens ?? 0),
			);
		const realCost = costFromRates(rates, 150, 1_000, 82_000, 2_000);
		expect(realCost).toBe(476);
		const window = [
			...responseEntries("msg_a", SONNET, u(120, 800, 40_000, 2_000)),
			...responseEntries("msg_b", SONNET, u(30, 200, 42_000, 0)),
		];
		const remainder = responseEntries("msg_c", SONNET, u(5, 60, 44_000, 1_000));

		capabilities = ["authorize-cache-tiers"];
		await startServer(okResponder);
		await writeMain(window);
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await appendMain(remainder);
		await run("post-tool-use.mjs", postInput("tu_1"));
		await run("stop.mjs", stopInput());
		const [tiered, tieredRemainder] = authorizes().map((a) => a.body);
		expect(tiered).toMatchObject({
			estimatedInputTokens: 150 + TOOL_INPUT_ESTIMATE,
			estimatedCacheReadTokens: 82_000,
			estimatedCacheWriteTokens: 2_000,
			maxOutputTokens: 1_000 + TOOL_OUTPUT_HOLD,
		});
		// The server side's own hand count for this window, at each tier's rate.
		expect(windowHold(tiered as Record<string, unknown>)).toBe(477);
		expect(tieredRemainder).toMatchObject({
			estimatedInputTokens: 5,
			estimatedCacheReadTokens: 44_000,
			estimatedCacheWriteTokens: 1_000,
			maxOutputTokens: 60,
		});

		// A server without the capability would strip the tiers and hold too little:
		// one sum, priced at the higher rate — never under the real cost, never doubled.
		fake?.closeAllConnections();
		fake?.close();
		capabilities = [];
		requests = [];
		await rm(join(stateDir, "transcripts"), { recursive: true, force: true });
		await startServer(okResponder);
		await writeMain(window);
		await run("pre-tool-use.mjs", preInput("tu_2"));
		const plain = authorizes()[0]?.body as Record<string, unknown>;
		expect(plain).not.toHaveProperty("estimatedCacheReadTokens");
		expect(plain.estimatedInputTokens).toBe(150 + 82_000 + 2_000 + TOOL_INPUT_ESTIMATE);
		// (Doubling the cache writes, as before, held 3 381.)
		expect(windowHold(plain)).toBe(3_306);
		expect(windowHold(plain)).toBeGreaterThanOrEqual(realCost);
	});

	it.each([
		["an older server (no `authorize-cache-tiers`)", []],
		["a server whose capabilities are unknown", null],
	] as const)(
		"%s never gets the cache tiers apart: it would strip them and hold too little",
		async (_server, published) => {
			capabilities = published === null ? null : [...published];
			await startServer(okResponder);
			await writeMain(responseEntries("msg_a", SONNET, u(10, 20, 3_000, 400)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			await appendMain(responseEntries("msg_b", SONNET, u(5, 6, 700, 80)));
			await run("post-tool-use.mjs", postInput("tu_1"));
			await run("stop.mjs", stopInput());
			const carried = authorizes().filter(
				(a) => (a.body.params as { usageOrigin?: string }).usageOrigin === "transcript",
			);
			expect(carried.map((a) => a.body.estimatedInputTokens)).toEqual([
				10 + 3_000 + 400 + TOOL_INPUT_ESTIMATE,
				5 + 700 + 80,
			]);
			for (const a of carried) {
				expect(a.body).not.toHaveProperty("estimatedCacheReadTokens");
				expect(a.body).not.toHaveProperty("estimatedCacheWriteTokens");
			}
		},
	);

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
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
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

	it("NO transcript path: the estimate is made sticky FIRST — a later hook that has the path never posts that agent's usage", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
		const { transcript_path: _path, ...noPath } = preInput("tu_1");
		const pre = await run("pre-tool-use.mjs", noPath);
		const { transcript_path: _post, ...noPathPost } = postInput("tu_1");
		await run("post-tool-use.mjs", noPathPost);
		// Later hooks DO name the transcript: its usage was already settled at the estimate.
		await run("pre-tool-use.mjs", preInput("tu_2"));
		await run("post-tool-use.mjs", postInput("tu_2"));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => [s.body.usageSource, s.body.inputTokens])).toEqual([
			["estimated", TOOL_INPUT_ESTIMATE],
			["estimated", TOOL_INPUT_ESTIMATE],
		]);
		for (const a of authorizes()) {
			expect(a.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
		}
		expect(pre.stderr).toContain("no transcript path; this agent now settles at the ESTIMATE");
	});

	it("a sticky agent whose lock another hook HOLDS still settles at the estimate, and posts no transcript usage", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
		// Sticky by a hook that named no transcript: only the marker records it, no cursor.
		const { transcript_path: _path, ...noPath } = preInput("tu_1");
		await run("pre-tool-use.mjs", noPath);
		const { transcript_path: _post, ...noPathPost } = postInput("tu_1");
		await run("post-tool-use.mjs", noPathPost);
		// Another hook holds the agent's lock for the whole next tool call: the marker
		// is read before the lock is tried, so the busy lock changes nothing.
		const lock = `${cursorPath()}.lock`;
		await mkdir(lock);
		await writeFile(join(lock, "owner"), "another-hook");
		await run("pre-tool-use.mjs", preInput("tu_2"));
		await run("post-tool-use.mjs", postInput("tu_2"));
		await rm(lock, { recursive: true, force: true });
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => [s.body.usageSource, s.body.inputTokens])).toEqual([
			["estimated", TOOL_INPUT_ESTIMATE],
			["estimated", TOOL_INPUT_ESTIMATE],
		]);
		for (const a of authorizes()) {
			expect(a.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
		}
	});

	it.each([
		["its directory cannot be made", "estimate"],
		["its name is taken by something that does not read back", `estimate/${SESSION}__main`],
	])(
		"estimate mode that cannot be RECORDED (%s) settles nothing at the estimate: the hold is given back",
		async (_why, dangling) => {
			await startServer(okResponder);
			await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
			// A dangling symlink: it reads as absent, and no marker can be written there.
			await mkdir(join(stateDir, "transcripts", "estimate"), { recursive: true, mode: 0o700 });
			await rm(join(stateDir, "transcripts", dangling), { recursive: true, force: true });
			await symlink(join(stateDir, "nowhere", "at-all"), join(stateDir, "transcripts", dangling));
			const { transcript_path: _path, ...noPath } = preInput("tu_1");
			const pre = await run("pre-tool-use.mjs", noPath);
			const { transcript_path: _post, ...noPathPost } = postInput("tu_1");
			await run("post-tool-use.mjs", noPathPost);
			// Settled at the estimate, this hold's usage could be posted again for real.
			expect(settles().map((s) => [s.body.usageSource, s.body.inputTokens])).toEqual([
				["provider", 0],
			]);
			expect(pre.stderr).toContain("estimate mode could not be recorded");
			expect(pre.stderr).toContain("given back");
		},
	);

	it("a recorded estimate mode that cannot be READ posts nothing and settles nothing at the estimate", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
		// Not a file: the marker can be neither read nor ruled out.
		await mkdir(join(stateDir, "transcripts", "estimate", `${SESSION}__main`), {
			recursive: true,
			mode: 0o700,
		});
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => [s.body.usageSource, s.body.inputTokens])).toEqual([
			["provider", 0],
		]);
		expect(pre.stderr).toContain("estimate marker unreadable");
	});

	it("a cursor that records estimate mode without its marker gets one: losing the cursor later changes nothing", async () => {
		await startServer(okResponder);
		// Sticky the old way: in the cursor only.
		await mkdir(join(stateDir, "transcripts"), { recursive: true, mode: 0o700 });
		await writeFile(
			cursorPath(),
			JSON.stringify({
				v: 2,
				byteOffset: 0,
				nextSeq: 0,
				partial: {},
				accounted: [],
				denied: [],
				assigned: {},
				authorizingAt: {},
				estimateMode: true,
				estimateReason: "transcript unreadable (EACCES)",
				lastModel: null,
				unresolved: {},
			}),
		);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		await rm(cursorPath());
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.usageSource)).toEqual(["estimated"]);
	});

	it("estimate mode recorded while a hook waits for the lock: once it holds the lock, it posts nothing", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
		// Another hook records this agent's estimate mode just as this one takes the
		// lock: after its first check, before anything it could post.
		const marker = join(stateDir, "transcripts", "estimate", `${SESSION}__main`);
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"), {
			NODE_OPTIONS: `--import=${join(import.meta.dirname, "helpers", "crash-at.mjs")}`,
			UT_CC_CRASH: "create|1|after",
			UT_CC_CRASH_ACTION: `write ${marker}`,
		});
		expect(pre.code).toBe(0);
		await run("post-tool-use.mjs", postInput("tu_1"));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.usageSource)).toEqual(["estimated"]);
		expect(authorizes()[0]?.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
	});

	it("NO transcript path while another hook holds the agent's lock: nothing is recorded, the hold is given back", async () => {
		await startServer(okResponder);
		await mkdir(join(stateDir, "transcripts"), { recursive: true, mode: 0o700 });
		await mkdir(`${cursorPath()}.lock`);
		await writeFile(join(`${cursorPath()}.lock`, "owner"), "another-hook");
		const { transcript_path: _path, ...noPath } = preInput("tu_1");
		const pre = await run("pre-tool-use.mjs", noPath);
		const { transcript_path: _post, ...noPathPost } = postInput("tu_1");
		await run("post-tool-use.mjs", noPathPost);
		expect(settles().map((s) => [s.body.usageSource, s.body.inputTokens])).toEqual([
			["provider", 0],
		]);
		expect(pre.stderr).toContain("another hook holds the agent's lock");
		await expect(readdir(join(stateDir, "transcripts", "estimate"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("a STICKY agent stays sticky when its cursor is lost: the estimate marker lives outside the cursor", async () => {
		await startServer(okResponder);
		// No transcript file yet: sticky at the first hook.
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect((await readCursor()).estimateMode).toBe(true);
		await rm(cursorPath());
		// The transcript appears, holding the usage the estimate already stood for.
		await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
		await run("pre-tool-use.mjs", preInput("tu_2"));
		await run("post-tool-use.mjs", postInput("tu_2"));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.usageSource)).toEqual(["estimated", "estimated"]);
		expect(settles().map((s) => s.body.inputTokens)).not.toContain(9);
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
		// PreToolUse still governs the tool, with no window; its hold is given back
		// (an older server: settled at zero), never settled at the estimate.
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(pre.stderr).toContain("corrupt");
		expect(authorizes()[0]?.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect(settles().map((s) => [s.body.usageSource, s.body.inputTokens])).toEqual([
			["provider", 0],
		]);
		expect(await readFile(cursorPath(), "utf-8")).toBe(corrupt);
	});

	it.each([
		[
			"a state dir writable by others",
			async () => {
				await mkdir(join(stateDir, "transcripts"));
				await chmod(join(stateDir, "transcripts"), 0o777);
			},
			() => chmod(join(stateDir, "transcripts"), 0o700),
		],
		[
			"a corrupt cursor",
			async () => {
				await mkdir(join(stateDir, "transcripts"), { mode: 0o700 });
				await writeFile(cursorPath(), "{");
			},
			() => rm(cursorPath()),
		],
		[
			"a corrupt cursor, seen while another hook holds its lock",
			async () => {
				await mkdir(join(stateDir, "transcripts"), { mode: 0o700 });
				await writeFile(cursorPath(), "{");
				await mkdir(`${cursorPath()}.lock`);
				await writeFile(join(`${cursorPath()}.lock`, "owner"), "another-hook");
			},
			async () => {
				await rm(`${cursorPath()}.lock`, { recursive: true });
				await rm(cursorPath());
			},
		],
	])(
		"%s, repaired later in the session: the usage is posted ONCE — the tool's hold was given back, not settled at the estimate",
		async (_cause, breakState, repair) => {
			await startServer(okResponder);
			await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
			await breakState();
			const pre = await run("pre-tool-use.mjs", preInput("tu_1"));
			expect(pre.code).toBe(0);
			await run("post-tool-use.mjs", postInput("tu_1"));
			await repair();
			await run("stop.mjs", stopInput());
			// The hold back at zero (an older server), then msg_a at its real counts.
			// Settled at the estimate as well, msg_a's usage would be charged twice.
			expect(
				settles().map((s) => [s.body.usageSource, s.body.inputTokens, s.body.outputTokens]),
			).toEqual([
				["provider", 0, 0],
				["provider", 5, 5],
			]);
			expect(pre.stderr).toContain("given back");
		},
	);

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
			"since",
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

	it("a delayed answer that outlives its test never reaches the responder: the next test's transfer ids stay its own", async () => {
		let answered = 0;
		delayMs = 300;
		await startServer((path, body) => {
			answered += 1;
			return okResponder(path, body);
		});
		// A request still waiting out its delay when its test ends...
		const late = fetch(`http://127.0.0.1:${port}/v1/authorize`, {
			method: "POST",
			body: "{}",
		}).catch(() => null);
		await new Promise((resolve) => setTimeout(resolve, 50));
		// ...and what the next test's beforeEach does meanwhile: a new log, ids from 1.
		requests = [];
		nextTransfer = 0;
		delayMs = 0;
		await late;
		expect(answered).toBe(0);
		expect(nextTransfer).toBe(0);
		expect(requests).toEqual([]);
	});

	it("a state dir writable by others is not trusted: nothing is posted, nothing settled at the estimate", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
		const dir = join(stateDir, "transcripts");
		await mkdir(dir);
		await chmod(dir, 0o777);
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"));
		expect(pre.code).toBe(0);
		expect(pre.stderr).toContain("writable by group or others");
		expect(authorizes()[0]?.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
		await run("post-tool-use.mjs", postInput("tu_1"));
		const stop = await run("stop.mjs", stopInput());
		expect(stop.stderr).toContain("writable by group or others");
		expect(settles().map((s) => [s.body.usageSource, s.body.inputTokens])).toEqual([
			["provider", 0],
		]);
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
		expect(authorizes()[0]?.body.model).toBe(SONNET);
		expect(settles()[0]?.body).toMatchObject({ inputTokens: 6, outputTokens: 6 });
	});

	it("a message first seen as <synthetic>, or with no model, is priced under the REAL model a later entry names — window and remainder, across hooks", async () => {
		await startServer(okResponder);
		const placeholder = (id: string, model?: string) =>
			JSON.stringify({
				type: "assistant",
				message: { id, model, stop_reason: null, usage: { input_tokens: 0 } },
			});
		// One hook sees only the placeholders: nothing is complete, nothing is posted.
		await writeMain([placeholder("msg_x", "<synthetic>"), placeholder("msg_y")]);
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect((await readCursor()).partial).toMatchObject({
			msg_x: { model: "<synthetic>", synthetic: true },
			msg_y: { model: "unknown", synthetic: false },
		});
		// A later hook reads the real entries: the window is SONNET's, the remainder HAIKU's.
		await appendMain([
			...responseEntries("msg_x", SONNET, u(6, 6), {}, { partials: 0 }),
			...responseEntries("msg_y", HAIKU, u(7, 7), {}, { partials: 0 }),
		]);
		await run("pre-tool-use.mjs", preInput("tu_2"));
		await run("post-tool-use.mjs", postInput("tu_2"));
		await run("stop.mjs", stopInput());
		// The authorizes that carried messages: model, and how many.
		const carried = authorizes()
			.map((a) => [a.body.model, (a.body.params as { messages?: number }).messages])
			.filter(([, messages]) => messages !== undefined);
		expect(carried).toEqual([
			[SONNET, 1],
			[HAIKU, 1],
		]);
		expect(
			settles()
				.filter((s) => s.body.inputTokens !== 0)
				.map((s) => s.body.inputTokens),
		).toEqual([6, 7]);
	});

	it("the model id is sent EXACTLY as the transcript wrote it: pricing looks it up verbatim", async () => {
		await startServer(okResponder);
		const LOCAL = "llama3.3:70b";
		const VERTEX = "claude-sonnet-4@20250514";
		const ROUTED = "meta-llama/Llama-3.3-70B-Instruct";
		await writeMain([
			...responseEntries("msg_a", LOCAL, u(3, 3)),
			...responseEntries("msg_b", VERTEX, u(4, 4)),
			...responseEntries("msg_c", ROUTED, u(5, 5)),
		]);
		// The window (msg_a), then the remainder per model (msg_b, msg_c) — each
		// read back from the cursor the earlier hook saved.
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		await run("stop.mjs", stopInput());
		// A tool-only hold is authorized at the agent's last model.
		await run("pre-tool-use.mjs", preInput("tu_2"));
		expect(authorizes().map((a) => a.body.model)).toEqual([LOCAL, VERTEX, ROUTED, ROUTED]);
		expect((await readCursor()).lastModel).toBe(ROUTED);
	});

	it("a model id that is not printable text is sent as `unknown` — never rewritten into another id", async () => {
		await startServer(okResponder);
		await writeMain([
			...responseEntries("msg_a", "claude-sonnet-4-6\u001b[2K", u(3, 3)),
			...responseEntries("msg_b", `m${"x".repeat(256)}`, u(4, 4)),
		]);
		await run("stop.mjs", stopInput());
		expect(authorizes().map((a) => a.body.model)).toEqual(["unknown"]);
		expect(settles().map((s) => s.body.inputTokens)).toEqual([7]);
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

	it("a long unread tail is read in bounded steps: each hook reads on from where the last stopped", async () => {
		await startServer(okResponder);
		await writeSparseMain(70, 1 << 20, responseEntries("msg_a", SONNET, u(5, 5)));
		await run("stop.mjs", stopInput());
		// The first hook stopped at the first line end 64 MiB in: msg_a is unread.
		expect(settles()).toEqual([]);
		expect((await readCursor()).byteOffset).toBe(userLine.length + 1 + 64 * (1 << 20));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([5]);
		expect((await readCursor()).byteOffset).toBe((await stat(mainTranscript)).size);
	});

	it("a line over 16 MiB is skipped unread, with a note; the lines after it are read", async () => {
		await startServer(okResponder);
		await writeSparseMain(1, 17 << 20, responseEntries("msg_a", SONNET, u(5, 5)));
		const stop = await run("stop.mjs", stopInput());
		expect(stop.stderr).toContain("skipped 1 transcript line(s) over 16 MiB, unread");
		expect(settles().map((s) => s.body.inputTokens)).toEqual([5]);
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

describe("the final response, written after Stop — SessionEnd and a bounded wait", () => {
	const endInput = () => ({
		...stopInput(),
		hook_event_name: "SessionEnd",
		reason: "prompt_input_exit",
	});
	// SessionEnd's budget is Claude Code's (lib.mjs `sessionEndBudgetMs`). These
	// tests always set it, so a value in the runner's own environment cannot change
	// them: unset (the 1.5 s default) unless a test gives it more.
	const DEFAULT_BUDGET = { CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "" };
	const end = (env: Record<string, string> = DEFAULT_BUDGET) =>
		run("session-end.mjs", endInput(), env);
	const STOP_GAVE_UP = "the turn's final response was not in the transcript by the end of the wait";

	it("hooks.json registers SessionEnd, beside the five hooks before it", async () => {
		const hooks = JSON.parse(await readFile(join(HOOKS, "hooks.json"), "utf-8")) as {
			hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
		};
		// SessionStart announces the mode (see mode.test.ts).
		expect(Object.keys(hooks.hooks).sort()).toEqual(
			["PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "SubagentStop"].sort(),
		);
		const sessionEnd = hooks.hooks.SessionEnd?.[0]?.hooks[0];
		expect(sessionEnd?.command).toContain("hooks/session-end.mjs");
		// Its own timeout does not raise Claude Code's SessionEnd budget. It bounds the
		// hook once CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS has raised that, so it must
		// not cut into the most the plugin uses of it (10 s).
		expect(sessionEnd?.timeout).toBeGreaterThanOrEqual(10);
	});

	it("a final answer the transcript did not yet hold at Stop is posted at SessionEnd — once, within the default budget", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(3, 3)));
		await run("stop.mjs", stopInput());
		// The last turn's answer reaches the transcript only after Stop has run: no
		// later turn will ever pick it up.
		await appendMain(responseEntries("msg_final", SONNET, u(7, 7), {}, { text: "all done" }));
		const ended = await end();
		expect(ended.code).toBe(0);
		expect(settles().map((s) => s.body.inputTokens)).toEqual([3, 7]);
		// Nothing is posted twice: not by another SessionEnd, nor by a Stop.
		await end();
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([3, 7]);
	});

	it("Stop waits — boundedly — for the final response its input names, and posts it itself", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(3, 3)));
		await run("stop.mjs", stopInput());
		const stop = run("stop.mjs", { ...stopInput(), last_assistant_message: "all done" });
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		await appendMain(responseEntries("msg_final", SONNET, u(7, 7), {}, { text: "all done" }));
		const stopped = await stop;
		expect(stopped.code).toBe(0);
		expect(stopped.stderr).not.toContain(STOP_GAVE_UP);
		expect(settles().map((s) => s.body.inputTokens)).toEqual([3, 7]);
		// SessionEnd then finds nothing new: no second post.
		await end();
		expect(settles().map((s) => s.body.inputTokens)).toEqual([3, 7]);
	});

	it("the wait is bounded: a final response that never arrives costs Stop about 2 s, then it goes on — and says so", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(3, 3)));
		const started = Date.now();
		const stop = await run("stop.mjs", { ...stopInput(), last_assistant_message: "never written" });
		const took = Date.now() - started;
		expect(stop.code).toBe(0);
		expect(took).toBeGreaterThanOrEqual(1_900);
		expect(took).toBeLessThan(8_000);
		expect(stop.stderr).toContain(STOP_GAVE_UP);
		expect(settles().map((s) => s.body.inputTokens)).toEqual([3]);
	});

	it("SubagentStop waits for the subagent's final response the same way", async () => {
		await startServer(okResponder);
		await writeMain([]);
		await writeSubagent("a1", "Plan", responseEntries("msg_s1", SONNET, u(2, 2), sub("a1")));
		await run("subagent-stop.mjs", { ...stopInput(), agent_id: "a1" });
		const stop = run("subagent-stop.mjs", {
			...stopInput(),
			agent_id: "a1",
			last_assistant_message: "plan ready",
		});
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		await appendFile(
			join(projectDir, SESSION, "subagents", "agent-a1.jsonl"),
			`${responseEntries("msg_s2", SONNET, u(5, 5), sub("a1"), { text: "plan ready" }).join("\n")}\n`,
		);
		const stopped = await stop;
		expect(stopped.code).toBe(0);
		expect(stopped.stderr).not.toContain("final response was not in");
		expect(settles().map((s) => s.body.inputTokens)).toEqual([2, 5]);
	});

	it("SubagentStop says so when the subagent's final response never arrives", async () => {
		await startServer(okResponder);
		await writeMain([]);
		await writeSubagent("a1", "Plan", responseEntries("msg_s1", SONNET, u(2, 2), sub("a1")));
		const stop = await run("subagent-stop.mjs", {
			...stopInput(),
			agent_id: "a1",
			last_assistant_message: "never written",
		});
		expect(stop.code).toBe(0);
		expect(stop.stderr).toContain(
			"a1's final response was not in its transcript by the end of the wait",
		);
		expect(settles().map((s) => s.body.inputTokens)).toEqual([2]);
	});

	it("SessionEnd waits, within its budget, for a lock a finishing Stop still holds", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(3, 3)));
		await mkdir(join(stateDir, "transcripts"), { recursive: true, mode: 0o700 });
		const lock = `${cursorPath()}.lock`;
		await mkdir(lock);
		await writeFile(join(lock, "owner"), "a-finishing-stop");
		const released = new Promise((resolve) =>
			setTimeout(() => void rm(lock, { recursive: true, force: true }).then(resolve), 800),
		);
		// A budget raised to 10 s: a fifth of it outlasts the 800 ms hold.
		const ended = await end({ CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "10000" });
		await released;
		expect(ended.code).toBe(0);
		expect(settles().map((s) => s.body.inputTokens)).toEqual([3]);
	});

	it("…but only a fifth of its budget: under the default, a lock held longer is left to the next Stop", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(3, 3)));
		await mkdir(join(stateDir, "transcripts"), { recursive: true, mode: 0o700 });
		const lock = `${cursorPath()}.lock`;
		await mkdir(lock);
		await writeFile(join(lock, "owner"), "a-finishing-stop");
		const released = new Promise((resolve) =>
			setTimeout(() => void rm(lock, { recursive: true, force: true }).then(resolve), 1_500),
		);
		const started = Date.now();
		const ended = await end();
		const took = Date.now() - started;
		expect(ended.code).toBe(0);
		// Not the 3 s it used to wait: the budget is 1.5 s in all.
		expect(took).toBeLessThan(2_500);
		expect(ended.stderr).toContain("a concurrent hook holds this agent's lock");
		expect(settles()).toEqual([]);
		await released;
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([3]);
	});

	it("SessionEnd keeps to its budget: against a server too slow for it, it gives up cleanly — and CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS gives it the time", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(3, 3)));
		await run("stop.mjs", stopInput());
		await appendMain(responseEntries("msg_final", SONNET, u(7, 7), {}, { text: "all done" }));
		// Every authorize and settle now takes 500 ms: more than a call may take
		// within 1.5 s, which holds a probe, an authorize, a settle and a reserve.
		delayMs = 500;
		const started = Date.now();
		const tight = await end();
		const took = Date.now() - started;
		expect(tight.code).toBe(0);
		expect(took).toBeLessThan(2_500);
		expect(settles().map((s) => s.body.inputTokens)).toEqual([3]);
		// The same session, with the budget the variable gives: posted, once.
		const roomy = await end({ CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "6000" });
		expect(roomy.code).toBe(0);
		expect(settles().map((s) => s.body.inputTokens)).toEqual([3, 7]);
	});
});

describe("the remainder's grouping by model", () => {
	it("is linear: a 50 000-message backlog is grouped in well under a hook's budget, in order", async () => {
		// @ts-expect-error TS7016: the hooks are plain .mjs, without type declarations.
		const { groupByModel } = await import("../hooks/transcript.mjs");
		// A long outage's claimed-but-unposted backlog: one model, a few of another.
		const backlog = Array.from({ length: 50_000 }, (_, i) => ({
			id: `msg_${i}`,
			model: i % 1_000 === 999 ? HAIKU : SONNET,
		}));
		const started = performance.now();
		const groups = groupByModel(backlog) as Map<string, Array<{ id: string }>>;
		const took = performance.now() - started;
		// Appending in place takes milliseconds. Copying a model's array for every
		// message, as the remainder once did, takes seconds at this size: every settle
		// point would spend its budget here before posting anything.
		expect(took).toBeLessThan(200);
		expect([...groups.keys()]).toEqual([SONNET, HAIKU]);
		expect(groups.get(SONNET)?.length).toBe(49_950);
		expect(groups.get(SONNET)?.[1_000]?.id).toBe("msg_1001");
		const haiku = groups.get(HAIKU)?.map((m) => m.id) ?? [];
		expect(haiku.slice(0, 2)).toEqual(["msg_999", "msg_1999"]);
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

	describe("a settle that cannot reach its hold: a clean 404 is charged once afresh; anything ambiguous never is", () => {
		const env = { UT_CC_USAGE: "estimate" };
		const notFound = { status: 404, json: { error: "not_found", reason: "unknown transferId" } };
		/** A ledger: an authorize mints tx_N; `fault` answers the FIRST settle of tx_1, posted or not. */
		function ledger(
			fault: "expired" | "posted-then-lost" | "posted-then-500" | "unposted-500" | "settled-false",
		) {
			const charged: string[] = [];
			const responder: Responder = (path, body) => {
				if (path === "/v1/authorize") {
					nextTransfer += 1;
					return { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
				}
				const id = String(body.transferId);
				if (path === "/v1/settle") {
					if (id === "tx_1" && fault === "expired") return notFound;
					if (id === "tx_1" && fault === "unposted-500")
						return { status: 500, json: { error: "internal" } };
					charged.push(id);
					if (id === "tx_1" && fault === "posted-then-lost") return { status: 0, json: null };
					if (id === "tx_1" && fault === "posted-then-500")
						return { status: 500, json: { error: "internal" } };
					if (id === "tx_1" && fault === "settled-false")
						return { status: 200, json: { settled: false, transferId: id } };
					return { status: 200, json: { settled: true, transferId: id } };
				}
				return { status: 200, json: { released: true, aborted: true } };
			};
			return { responder, charged };
		}
		const play = async () => {
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			const post = await run("post-tool-use.mjs", postInput("tu_1", { tool_name: "Bash" }), env);
			await run("stop.mjs", stopInput(), env);
			return post;
		};

		it("a 404 `unknown transferId` (the hold expired at a permission prompt) is charged exactly once, on a fresh hold", async () => {
			const { responder, charged } = ledger("expired");
			await startServer(responder);
			const post = await play();
			expect(requests.map((r) => [r.path, r.body.transferId ?? null, r.status])).toEqual([
				["/v1/authorize", null, 200],
				["/v1/settle", "tx_1", 404],
				["/v1/authorize", null, 200],
				["/v1/settle", "tx_2", 200],
			]);
			expect(authorizes()[1]?.body).toMatchObject({
				model: SONNET,
				estimatedInputTokens: TOOL_INPUT_ESTIMATE,
				maxOutputTokens: TOOL_OUTPUT_HOLD,
				params: { hook: "PostToolUse", tool_name: "Bash", replaces: "tx_1" },
				actor: `claude-code:${SESSION}`,
			});
			expect(settles()[1]?.body).toEqual({
				transferId: "tx_2",
				inputTokens: 4,
				outputTokens: 3,
				usageSource: "estimated",
			});
			expect(charged).toEqual(["tx_2"]);
			expect(post.stderr).toContain("charging this call once on tx_2");
			expect(await holdFiles()).toEqual([]);
		});

		for (const [fault, what] of [
			["posted-then-lost", "posted, its answer lost (no answer, a timeout)"],
			["posted-then-500", "posted, then answered 500"],
			["unposted-500", "not posted, answered 500"],
			["settled-false", "answered settled: false"],
		] as const) {
			it(`a settle ${what} is never re-authorized and never settled again — charged at most once`, async () => {
				const { responder, charged } = ledger(fault);
				await startServer(responder);
				await play();
				expect(authorizes()).toHaveLength(1);
				expect(settles().map((s) => s.body.transferId)).toEqual(["tx_1"]);
				expect(charged.length).toBeLessThanOrEqual(1);
				// Left settle-attempted (.settling) by PostToolUse, then given back at Stop —
				// released, never settled — and forgotten: no hold file outlives the session.
				const givenBack = requests.filter(
					(r) =>
						(r.path === "/v1/release" || r.path === "/v1/abort") && r.body.transferId === "tx_1",
				);
				expect(givenBack).toHaveLength(fault === "settled-false" ? 0 : 1);
				expect(await holdStateFiles()).toEqual([]);
			});
		}

		it("its diagnostics never carry a control character from the server's transferIds: an id carrying one is refused, never echoed", async () => {
			let minted = 0;
			await startServer((path) => {
				if (path === "/v1/authorize") {
					minted += 1;
					// tx_1 is a valid id; every later one carries control characters.
					const transferId = minted === 1 ? "tx_1" : `tx_${minted}${HOSTILE}`;
					return { status: 200, json: { transferId, estimatedCost: 1 } };
				}
				// tx_1 expired before its settle, so PostToolUse asks for a fresh hold.
				if (path === "/v1/settle") return notFound;
				return { status: 200, json: { released: true } };
			});
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			const pre = await run("pre-tool-use.mjs", preInput("tu_1"), env);
			const post = await run("post-tool-use.mjs", postInput("tu_1", { tool_name: "Bash" }), env);
			expect(post.stderr).toContain("its fresh hold's transferId is not a valid id");
			const next = await run("pre-tool-use.mjs", preInput("tu_2"), env);
			expect(next.stderr).toContain("its transferId is not a valid id");
			expect(`${pre.stderr}${post.stderr}${next.stderr}`).not.toMatch(CONTROL);
			expect(await holdStateFiles()).toEqual([]);
		});

		it("a host that sends no tool_use_id: a hold whose settle went unanswered is never taken again — each call charged once, at ITS OWN usage", async () => {
			// Like the server: a settle posts a pending hold and forgets it; one it does
			// not know is a 404. tx_1's settle posts, and its answer is lost.
			const pending = new Set<string>();
			const charged: Array<{ id: string; inputTokens: unknown; outputTokens: unknown }> = [];
			await startServer((path, body) => {
				if (path === "/v1/authorize") {
					nextTransfer += 1;
					pending.add(`tx_${nextTransfer}`);
					return { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
				}
				const id = String(body.transferId);
				if (!pending.delete(id)) return notFound;
				if (path === "/v1/settle") {
					charged.push({ id, inputTokens: body.inputTokens, outputTokens: body.outputTokens });
					return id === "tx_1"
						? { status: 0, json: null }
						: { status: 200, json: { settled: true, transferId: id } };
				}
				return { status: 200, json: { released: true, aborted: true } };
			});
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			const command = (k: number) => "x".repeat(40 * k);
			const response = (k: number) => "y".repeat(100 * k);
			const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));
			for (const k of [1, 2, 3]) {
				await run(
					"pre-tool-use.mjs",
					{ ...stopInput(), tool_name: "Bash", tool_input: { command: command(k) } },
					env,
				);
				await run(
					"post-tool-use.mjs",
					{ ...stopInput(), tool_name: "Bash", tool_response: response(k) },
					env,
				);
			}
			await run("stop.mjs", stopInput(), env);
			expect(authorizes()).toHaveLength(3);
			expect(charged).toEqual(
				[1, 2, 3].map((k) => ({
					id: `tx_${k}`,
					inputTokens: tokens(JSON.stringify({ command: command(k) })),
					outputTokens: tokens(JSON.stringify(response(k))),
				})),
			);
			// tx_1 was given back at Stop (a 404: it posted), never settled again.
			expect(requests.filter((r) => r.body.transferId === "tx_1").map((r) => r.path)).toEqual([
				"/v1/settle",
				expect.stringMatching(/^\/v1\/(release|abort)$/),
			]);
			expect(await holdStateFiles()).toEqual([]);
		});

		/**
		 * A hold file as an earlier release wrote it: no `gate` mark (or `mark`, when a
		 * test gives one), an input estimate of 5 000, and older than any hold the test
		 * records, so it heads the queue.
		 */
		async function seedLegacyHold(transferId: string, toolUseId: string | null, mark?: unknown) {
			const path = join(stateDir, `${SESSION}__main__${toolUseId ?? transferId}.json`);
			await writeFile(
				path,
				JSON.stringify({
					...(mark === undefined ? {} : { gate: mark }),
					toolUseId,
					transferId,
					agentId: "main",
					estimatedInputTokens: 5000,
				}),
			);
			const minuteAgo = new Date(Date.now() - 60_000);
			await utimes(path, minuteAgo, minuteAgo);
		}

		for (const [mark, what] of [
			[undefined, "no mark"],
			[2, "gate: 2, a later format"],
		] as const) {
			for (const calls of [1, 2]) {
				it(`after an upgrade, with no tool_use_id: an earlier release's POSTED hold (${what}) is never paired, settled again or re-authorized; ${calls} call(s), each charged once at its OWN estimate`, async () => {
					// The earlier release settled tx_L. The settle POSTED and its answer was
					// lost, so that release kept the .json. The server has forgotten tx_L, so
					// any settle or release of it answers 404.
					const pending = new Set<string>();
					const charged: Array<{ id: string; inputTokens: unknown; outputTokens: unknown }> = [];
					await startServer((path, body) => {
						if (path === "/v1/authorize") {
							nextTransfer += 1;
							pending.add(`tx_${nextTransfer}`);
							return { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
						}
						const id = String(body.transferId);
						if (!pending.delete(id)) return notFound;
						if (path === "/v1/settle") {
							charged.push({ id, inputTokens: body.inputTokens, outputTokens: body.outputTokens });
							return { status: 200, json: { settled: true, transferId: id } };
						}
						return { status: 200, json: { released: true, aborted: true } };
					});
					await seedLegacyHold("tx_L", null, mark);
					await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
					const command = (k: number) => "x".repeat(40 * k);
					const response = (k: number) => "y".repeat(100 * k);
					const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));
					for (let k = 1; k <= calls; k += 1) {
						await run(
							"pre-tool-use.mjs",
							{ ...stopInput(), tool_name: "Bash", tool_input: { command: command(k) } },
							env,
						);
						await run(
							"post-tool-use.mjs",
							{ ...stopInput(), tool_name: "Bash", tool_response: response(k) },
							env,
						);
					}
					await run("stop.mjs", stopInput(), env);
					// One charge per call, each at that call's own input and output estimates:
					// the legacy 5 000 is never billed, and no input estimate is billed twice.
					expect(charged).toEqual(
						Array.from({ length: calls }, (_, i) => ({
							id: `tx_${i + 1}`,
							inputTokens: tokens(JSON.stringify({ command: command(i + 1) })),
							outputTokens: tokens(JSON.stringify(response(i + 1))),
						})),
					);
					expect(authorizes()).toHaveLength(calls);
					// tx_L is never settled again, only given back at Stop (that 404 is fine).
					expect(requests.filter((r) => r.body.transferId === "tx_L").map((r) => r.path)).toEqual([
						expect.stringMatching(/^\/v1\/(release|abort)$/),
					]);
					expect(await holdStateFiles()).toEqual([]);
				});
			}
		}

		for (const [mark, what, reauthorized] of [
			[1, "gate: 1, this release's mark", true],
			[undefined, "no mark", false],
			[2, "gate: 2, a later format", false],
			["1", 'gate: "1", malformed', false],
			[true, "gate: true, malformed", false],
		] as const) {
			it(`a matched hold (${what}) whose settle answers 404 is ${reauthorized ? "re-authorized once: the expired-hold recovery" : "never re-authorized, only given back at Stop"}`, async () => {
				// A hold its own PreToolUse recorded, settled by its own PostToolUse: the
				// 404 says the server no longer has it. Only this release's mark makes that
				// 404 mean "expired, never posted".
				const charged: string[] = [];
				await startServer((path, body) => {
					if (path === "/v1/authorize") {
						nextTransfer += 1;
						return { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
					}
					const id = String(body.transferId);
					if (id === "tx_L") return notFound;
					if (path === "/v1/settle") charged.push(id);
					return { status: 200, json: { settled: true, released: true, transferId: id } };
				});
				await seedLegacyHold("tx_L", "tu_L", mark);
				await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
				const post = await run("post-tool-use.mjs", postInput("tu_L", { tool_name: "Bash" }), env);
				await run("stop.mjs", stopInput(), env);
				expect(authorizes()).toHaveLength(reauthorized ? 1 : 0);
				expect(settles().map((s) => s.body.transferId)).toEqual(
					reauthorized ? ["tx_L", "tx_1"] : ["tx_L"],
				);
				expect(charged).toEqual(reauthorized ? ["tx_1"] : []);
				if (reauthorized) {
					expect(post.stderr).toContain("charging this call once on tx_1");
				} else {
					expect(post.stderr).toContain("may have been charged already");
					expect(requests.filter((r) => r.body.transferId === "tx_L").map((r) => r.path)).toEqual([
						"/v1/settle",
						expect.stringMatching(/^\/v1\/(release|abort)$/),
					]);
				}
				expect(await holdStateFiles()).toEqual([]);
			});
		}

		it("the fresh hold is settle-attempted from birth: a later FIFO pick never takes it, even when its settle went unanswered", async () => {
			// No tool_use_id. Call 1's hold expired (404); its fresh hold tx_2 posts, and
			// that answer is lost. Call 2's PostToolUse must take call 2's own hold.
			const pending = new Set<string>();
			const charged: string[] = [];
			await startServer((path, body) => {
				if (path === "/v1/authorize") {
					nextTransfer += 1;
					if (nextTransfer !== 1) pending.add(`tx_${nextTransfer}`);
					return { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
				}
				const id = String(body.transferId);
				if (!pending.delete(id)) return notFound;
				if (path === "/v1/settle") {
					charged.push(id);
					return id === "tx_2"
						? { status: 0, json: null }
						: { status: 200, json: { settled: true, transferId: id } };
				}
				return { status: 200, json: { released: true, aborted: true } };
			});
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			for (const k of [1, 2]) {
				await run(
					"pre-tool-use.mjs",
					{ ...stopInput(), tool_name: "Bash", tool_input: { command: "ls" } },
					env,
				);
				await run(
					"post-tool-use.mjs",
					{ ...stopInput(), tool_name: "Bash", tool_response: `r${k}` },
					env,
				);
				if (k === 1) {
					// The fresh hold carries the gate's mark from the write that created it.
					const fresh = join(stateDir, holdFile("tx_2", "tx_2", "settling"));
					expect(JSON.parse(await readFile(fresh, "utf-8"))).toMatchObject({
						gate: 1,
						transferId: "tx_2",
					});
				}
			}
			await run("stop.mjs", stopInput(), env);
			// tx_1 expired; tx_2 (call 1's fresh hold) posted once; tx_3 is call 2's.
			expect(charged).toEqual(["tx_2", "tx_3"]);
			expect(authorizes()).toHaveLength(3);
			expect(await holdStateFiles()).toEqual([]);
		});

		it("a settle that succeeds never re-authorizes", async () => {
			await startServer(okResponder);
			await play();
			expect(requests.map((r) => r.path)).toEqual(["/v1/authorize", "/v1/settle"]);
		});

		it("the expired-hold chain stays inside the hook's budget: each of its requests is capped at the time left", async () => {
			// Every answer but /v1/health takes 4.3 s. Uncapped (5 s each), the settle's
			// 404, the fresh authorize and the fresh settle would all be answered, ~13 s
			// in: past the 10 s budget, close to Claude Code's 15 s kill. Capped, the
			// fresh settle gets only what is left of the budget, and is cut off.
			const pending = new Set<string>();
			const charged: string[] = [];
			await startServer((path, body) => {
				if (path === "/v1/authorize") {
					nextTransfer += 1;
					if (nextTransfer !== 1) pending.add(`tx_${nextTransfer}`);
					return { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
				}
				const id = String(body.transferId);
				if (!pending.delete(id)) return notFound;
				if (path === "/v1/settle") {
					charged.push(id);
					return { status: 200, json: { settled: true, transferId: id } };
				}
				return { status: 200, json: { released: true, aborted: true } };
			});
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			delayMs = 4_300;
			const started = Date.now();
			const post = await run("post-tool-use.mjs", postInput("tu_1", { tool_name: "Bash" }), env);
			const elapsed = Date.now() - started;
			delayMs = 0;
			await run("stop.mjs", stopInput(), env);
			expect(post.code).toBe(0);
			// The 10 s budget, plus node's start and exit.
			expect(elapsed).toBeLessThan(11_750);
			// The fresh hold tx_2 was authorized and its settle cut off by the budget...
			expect(authorizes().map(transferOf)).toEqual(["tx_1", "tx_2"]);
			expect(post.stderr).toContain("charging this call once on tx_2");
			expect(post.stderr).toContain("settle failed (non-blocking)");
			// ...so it was left settle-attempted, and Stop gave it back: at most one
			// charge (the cut-off settle may still post), never two.
			expect(
				requests
					.filter((r) => r.body.transferId === "tx_2" && r.path !== "/v1/settle")
					.map((r) => r.path),
			).toEqual([expect.stringMatching(/^\/v1\/(release|abort)$/)]);
			expect(charged.length).toBeLessThanOrEqual(1);
			expect(await holdStateFiles()).toEqual([]);
		}, 30_000);

		/** How the give-back of an unrecorded hold is answered: confirmed, refused or never. */
		const GIVE_BACK_ANSWERS = [
			["200", "confirmed (200)"],
			["500", "refused (500)"],
			["throw", "unanswered (the connection drops)"],
		] as const;
		const giveBackAnswer = (answer: (typeof GIVE_BACK_ANSWERS)[number][0]) =>
			answer === "200"
				? { status: 200, json: { released: true, aborted: true } }
				: answer === "500"
					? { status: 500, json: { error: "internal", reason: "ledger unavailable" } }
					: { status: 0, json: null };

		for (const [answer, what] of GIVE_BACK_ANSWERS) {
			it(`a fresh hold whose record cannot be written is given back at once, and its note says only what the give-back confirmed: ${what}`, async () => {
				// No tool_use_id, so the fresh hold's file is named by its own transferId. A
				// directory squats on that name, so the record's write fails, as on a full disk.
				const pending = new Set<string>();
				const charged: string[] = [];
				await startServer((path, body) => {
					if (path === "/v1/authorize") {
						nextTransfer += 1;
						if (nextTransfer !== 1) pending.add(`tx_${nextTransfer}`);
						return { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
					}
					const id = String(body.transferId);
					if (path !== "/v1/settle" && id === "tx_2") return giveBackAnswer(answer);
					if (!pending.delete(id)) return notFound;
					if (path === "/v1/settle") {
						charged.push(id);
						return { status: 200, json: { settled: true, transferId: id } };
					}
					return { status: 200, json: { released: true, aborted: true } };
				});
				const squat = holdFile("tx_2", "tx_2", "settling");
				await mkdir(join(stateDir, squat, "x"), { recursive: true });
				await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
				await run(
					"pre-tool-use.mjs",
					{ ...stopInput(), tool_name: "Bash", tool_input: { command: "ls" } },
					env,
				);
				const post = await run(
					"post-tool-use.mjs",
					{ ...stopInput(), tool_name: "Bash", tool_response: "eight ch" },
					env,
				);
				await run("stop.mjs", stopInput(), env);
				expect(post.code).toBe(0);
				expect(post.stderr).toContain("its fresh hold tx_2 could not be recorded");
				expect(post.stderr).toContain("this call's estimate is not recorded");
				// The note says "given back" only when the server confirmed it.
				if (answer === "200") {
					expect(post.stderr).toContain("tx_2 was given back");
					expect(post.stderr).not.toMatch(/was refused|could not be given back/);
				} else {
					expect(post.stderr).not.toContain("was given back");
					expect(post.stderr).toContain("tx_2 is left to the server's TTL sweep");
					expect(post.stderr).toContain(
						answer === "500"
							? "abort tx_2 was refused (500: ledger unavailable)"
							: "hold tx_2 could not be given back",
					);
				}
				// tx_2 was authorized, never settled, and given back exactly once: its
				// reservation is not left held until the server's TTL sweep unless the server
				// refused, or never answered, that one give-back.
				expect(requests.filter((r) => r.body.transferId === "tx_2").map((r) => r.path)).toEqual([
					expect.stringMatching(/^\/v1\/(release|abort)$/),
				]);
				// This call's estimate goes unrecorded: an under-count, never a second charge.
				expect(charged).toEqual([]);
				// tx_1's 404 said it is gone: one settle, and it is not given back afterwards.
				expect(requests.filter((r) => r.body.transferId === "tx_1").map((r) => r.path)).toEqual([
					"/v1/settle",
				]);
				// Nothing is left but the squatter: no hold, no claim, no partial write.
				expect((await readdir(stateDir)).filter((n) => n !== "transcripts")).toEqual([squat]);
			});
		}

		for (const [answer, what] of GIVE_BACK_ANSWERS) {
			it(`PreToolUse: a hold whose record cannot be written is given back, and nothing claims more than the give-back confirmed: ${what}`, async () => {
				const charged: string[] = [];
				await startServer((path, body) => {
					if (path === "/v1/authorize") {
						nextTransfer += 1;
						return { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
					}
					if (path === "/v1/settle") {
						charged.push(String(body.transferId));
						return { status: 200, json: { settled: true, transferId: body.transferId } };
					}
					return giveBackAnswer(answer);
				});
				// A directory squats on the hold's file name, so its record's write fails.
				const squat = holdFile("tu_1", "tx_1");
				await mkdir(join(stateDir, squat, "x"), { recursive: true });
				await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
				const pre = await run("pre-tool-use.mjs", preInput("tu_1"), env);
				// Watch, the default: the call proceeds with no decision, as a gap.
				expect(pre.code).toBe(0);
				expect(pre.stdout).toBe("");
				expect(pre.stderr).toContain("this call is not metered");
				expect(pre.stderr).not.toContain("was given back");
				if (answer === "200") {
					expect(pre.stderr).not.toMatch(/was refused|could not be given back/);
				} else {
					expect(pre.stderr).toContain(
						answer === "500"
							? "abort tx_1 was refused (500: ledger unavailable)"
							: "hold tx_1 could not be given back",
					);
				}
				expect(requests.filter((r) => r.body.transferId === "tx_1").map((r) => r.path)).toEqual([
					expect.stringMatching(/^\/v1\/(release|abort)$/),
				]);
				expect(charged).toEqual([]);
			});
		}
	});

	describe("an estimate hold's .settling in the transcript journal (it carries no ids)", () => {
		const marker = () => join(stateDir, `${SESSION}__main__tu_est.settling`);
		const writeMarker = () =>
			writeFile(
				marker(),
				JSON.stringify({
					toolUseId: "tu_est",
					transferId: "tx_est",
					agentId: "main",
					estimatedInputTokens: 4,
				}),
			);

		it("fresh, it is never live for transcript ids, and the journal leaves it alone", async () => {
			await startServer(okResponder);
			await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
			await writeMarker();
			await run("pre-tool-use.mjs", preInput("tu_1"));
			expect(authorizes()[0]?.body.params).toMatchObject({
				usageOrigin: "transcript",
				messages: 1,
			});
			expect(await readdir(stateDir)).toContain(`${SESSION}__main__tu_est.settling`);
		});

		it("stale (past the server's hold TTL twice over), the journal clears it, and no id is affected", async () => {
			await startServer(okResponder);
			await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
			await writeMarker();
			const old = new Date(Date.now() - 11 * 60_000);
			await utimes(marker(), old, old);
			await run("pre-tool-use.mjs", preInput("tu_1"));
			expect(authorizes()[0]?.body.params).toMatchObject({
				usageOrigin: "transcript",
				messages: 1,
			});
			expect(await readdir(stateDir)).not.toContain(`${SESSION}__main__tu_est.settling`);
		});
	});

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
		expect(JSON.parse(await readFile(join(stateDir, holdFile("tu_1", "tx_1")), "utf-8"))).toEqual({
			gate: 1,
			toolUseId: "tu_1",
			transferId: "tx_1",
			agentId: "main",
			estimatedInputTokens: 4,
			serverUrl: `http://127.0.0.1:${port}`,
			keyHash: createHash("sha256").update("k").digest("hex").slice(0, 16),
		});
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
		// The transcript is never read, and no cursor made: the state holds only the
		// record that this agent settles at the estimate, written before it did. The
		// one stderr line is watch mode's (the default) reason for letting the call
		// through, which lands in Claude Code's debug log; there is no other note.
		expect(pre.stderr).toBe("usertrust: reserved tx_1 (1 ut)\n");
		expect((await readdir(join(stateDir, "transcripts"))).sort()).toEqual(["estimate", "since"]);
		expect(
			await readFile(join(stateDir, "transcripts", "estimate", `${SESSION}__main`), "utf-8"),
		).toBe("UT_CC_USAGE=estimate");
	});

	it("a session settled under UT_CC_USAGE=estimate, resumed in transcript mode, posts nothing from it", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
		const env = { UT_CC_USAGE: "estimate" };
		await run("pre-tool-use.mjs", preInput("tu_1"), env);
		await run("post-tool-use.mjs", postInput("tu_1"), env);
		// Resumed without the setting: the estimate already stood for msg_a.
		await run("pre-tool-use.mjs", preInput("tu_2"));
		await run("post-tool-use.mjs", postInput("tu_2"));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => [s.body.usageSource, s.body.inputTokens])).toEqual([
			["estimated", TOOL_INPUT_ESTIMATE],
			["estimated", TOOL_INPUT_ESTIMATE],
		]);
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
				return {
					status: 200,
					json: { transferId: replay, estimatedCost: 1, expiresInMs: 300_000 },
				};
			next += 1;
			const transferId = `tx_${next}`;
			holds.set(transferId, { key });
			if (key !== undefined) live.set(key, transferId);
			return { status: 200, json: { transferId, estimatedCost: 1, expiresInMs: 300_000 } };
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

	describe("UT_CC_UNIT / UT_CC_ROLE: attribution inside the principal", () => {
		const origin = `claude-code:${SESSION}`;
		const attribution = { UT_CC_UNIT: "platform", UT_CC_ROLE: "release-engineer" };

		it("ride INSIDE the principal on every authorize — a window's, and the remainders' at SubagentStop, Stop and SessionEnd — never as params", async () => {
			const server = keyedServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(10, 20)));
			expect((await run("pre-tool-use.mjs", preInput("tu_1"), attribution)).code).toBe(0);
			await run("post-tool-use.mjs", postInput("tu_1"), attribution);
			await writeSubagent("a1", "Explore", responseEntries("msg_s", HAIKU, u(3, 4), sub("a1")));
			await run("subagent-stop.mjs", { ...stopInput(), agent_id: "a1" }, attribution);
			// A final answer with no tool call after it: no hold carries it, so Stop posts it.
			await appendMain(responseEntries("msg_b", SONNET, u(1, 2)));
			await run("stop.mjs", stopInput(), attribution);
			// The last turn's answer, written after Stop: SessionEnd posts it.
			await appendMain(responseEntries("msg_c", SONNET, u(3, 4)));
			await run(
				"session-end.mjs",
				{ ...stopInput(), hook_event_name: "SessionEnd", reason: "prompt_input_exit" },
				attribution,
			);
			expect(authorizes().map((a) => [a.body.params, a.body.principal])).toEqual([
				[
					{
						hook: "PreToolUse",
						tool_name: "Bash",
						usageOrigin: "transcript",
						agent_id: "main",
						agent_type: "main",
						messages: 1,
					},
					{ id: "main", type: "main", origin, unit: "platform", role: "release-engineer" },
				],
				[
					{
						hook: "SubagentStop",
						usageOrigin: "transcript",
						agent_id: "a1",
						agent_type: "Explore",
						messages: 1,
					},
					{ id: "a1", type: "Explore", origin, unit: "platform", role: "release-engineer" },
				],
				[
					{
						hook: "Stop",
						usageOrigin: "transcript",
						agent_id: "main",
						agent_type: "main",
						messages: 1,
					},
					{ id: "main", type: "main", origin, unit: "platform", role: "release-engineer" },
				],
				[
					{
						hook: "SessionEnd",
						usageOrigin: "transcript",
						agent_id: "main",
						agent_type: "main",
						messages: 1,
					},
					{ id: "main", type: "main", origin, unit: "platform", role: "release-engineer" },
				],
			]);
		});

		it("a value that is empty, too long or has a character outside [A-Za-z0-9._:-] is left out, with a note — never sent, nor forced into shape", async () => {
			const server = keyedServer();
			await startServer(server.responder);
			// A principal rides on every transcript-mode authorize, window or not.
			await writeMain(responseEntries("msg_a", SONNET, u(1, 1)));
			for (const [unit, why] of [
				["release engineer", "a character outside that set"],
				["", "it is empty"],
				["u".repeat(129), "129 characters long"],
				["plat\nform", "a character outside that set"],
			] as const) {
				const pre = await run("pre-tool-use.mjs", preInput("tu_1"), {
					UT_CC_UNIT: unit,
					UT_CC_ROLE: "release-engineer",
				});
				expect(pre.code, JSON.stringify(unit)).toBe(0);
				expect(authorizes().at(-1)?.body.principal, JSON.stringify(unit)).toEqual({
					id: "main",
					type: "main",
					origin,
					role: "release-engineer",
				});
				expect(pre.stderr, JSON.stringify(unit)).toContain("UT_CC_UNIT is not sent");
				expect(pre.stderr, JSON.stringify(unit)).toContain(why);
				expect(pre.stderr).not.toContain("UT_CC_ROLE");
				await run("post-tool-use.mjs", postInput("tu_1"));
			}
		});

		it("on the estimate path (no transcript): the same gate, the same principal shape", async () => {
			await startServer(keyedServer().responder);
			const estimate = { ...attribution, UT_CC_USAGE: "estimate" };
			await run("pre-tool-use.mjs", preInput("tu_1"), estimate);
			await run(
				"pre-tool-use.mjs",
				preInput("tu_2", { agent_id: "a1", agent_type: "Explore" }),
				estimate,
			);
			await run("pre-tool-use.mjs", preInput("tu_3", { agent_id: "a2" }), estimate);
			const attributed = { origin, unit: "platform", role: "release-engineer" };
			expect(authorizes().map((a) => [a.body.params, a.body.principal])).toEqual([
				[
					{ hook: "PreToolUse", tool_name: "Bash" },
					{ id: "main", type: "main", ...attributed },
				],
				[
					{ hook: "PreToolUse", tool_name: "Bash" },
					{ id: "a1", type: "Explore", ...attributed },
				],
				[
					{ hook: "PreToolUse", tool_name: "Bash" },
					{ id: "a2", type: "subagent", ...attributed },
				],
			]);
		});

		it("while transcript state is unavailable: the same gate, the same principal shape", async () => {
			await startServer(keyedServer().responder);
			await writeMain(responseEntries("msg_a", SONNET, u(5, 5)));
			const dir = join(stateDir, "transcripts");
			await mkdir(dir);
			await chmod(dir, 0o777);
			const pre = await run("pre-tool-use.mjs", preInput("tu_1"), attribution);
			expect(pre.stderr).toContain("writable by group or others");
			expect(authorizes()[0]?.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
			expect(authorizes()[0]?.body.principal).toEqual({
				id: "main",
				type: "main",
				origin,
				unit: "platform",
				role: "release-engineer",
			});
		});

		it("no principal — so no unit or role anywhere — on a server that does not advertise it, on either path", async () => {
			capabilities = ["release", "idempotency-key"];
			await startServer(keyedServer().responder);
			await writeMain(responseEntries("msg_a", SONNET, u(1, 1)));
			await run("pre-tool-use.mjs", preInput("tu_1"), attribution);
			await run("post-tool-use.mjs", postInput("tu_1"), attribution);
			await appendMain(responseEntries("msg_b", SONNET, u(2, 2)));
			await run("stop.mjs", stopInput(), attribution);
			await run("pre-tool-use.mjs", preInput("tu_2"), { ...attribution, UT_CC_USAGE: "estimate" });
			expect(authorizes()).toHaveLength(3);
			for (const a of authorizes()) {
				expect(a.body).not.toHaveProperty("principal");
				expect(JSON.stringify(a.body)).not.toContain("platform");
				expect(JSON.stringify(a.body)).not.toContain("release-engineer");
			}
		});
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
		// A model id a path-safe rewrite would change: the retried vehicle keeps it exactly.
		const LOCAL = "llama3.3:70b";
		await writeMain(responseEntries("msg_a", LOCAL, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect(server.charges).toHaveLength(0);
		expect(releases().map((r) => r.body.transferId)).toEqual(["tx_1"]);
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => [s.body.transferId, s.status])).toEqual([
			["tx_1", 500],
			["tx_2", 200],
		]);
		expect(authorizes().map((a) => a.body.model)).toEqual([LOCAL, LOCAL]);
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
		const live = join(stateDir, holdFile("tu_1", "tx_1"));
		const settling = join(stateDir, holdFile("tu_1", "tx_1", "settling"));
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
		expect(pre.stdout).toBe("");
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
	it("history written before this state was first made is never posted (an upgrade, a resumed session); what follows is", async () => {
		await startServer(okResponder);
		// Settled by the estimate plugin a minute ago, perhaps: from before this state.
		const before = new Date(Date.now() - 60_000).toISOString();
		await writeMain(responseEntries("msg_old", SONNET, u(9, 9), { timestamp: before }));
		await run("stop.mjs", stopInput());
		expect(settles()).toEqual([]);
		const since = Date.parse(await readFile(join(stateDir, "transcripts", "since"), "utf-8"));
		expect(since).toBeGreaterThan(Date.parse(before));
		// Written after it, if only just: posted, once.
		const after = new Date(since + 1).toISOString();
		await appendMain(responseEntries("msg_new", SONNET, u(4, 4), { timestamp: after }));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([4]);
		// Fixed once made: a later hook reads the same time.
		expect(Date.parse(await readFile(join(stateDir, "transcripts", "since"), "utf-8"))).toBe(since);
	});

	it("a DELETED state dir no longer re-posts its history: the first-run time is made again, past it", async () => {
		await startServer(okResponder);
		await writeMain([]);
		await run("stop.mjs", stopInput());
		const since = Date.parse(await readFile(join(stateDir, "transcripts", "since"), "utf-8"));
		const at = new Date(since + 1).toISOString();
		await appendMain(responseEntries("msg_a", SONNET, u(6, 6), { timestamp: at }));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([6]);
		await rm(join(stateDir, "transcripts"), { recursive: true });
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([6]);
	});

	it("a first-run time that cannot be read posts nothing and settles nothing at the estimate", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(6, 6)));
		await mkdir(join(stateDir, "transcripts"), { recursive: true, mode: 0o700 });
		await writeFile(join(stateDir, "transcripts", "since"), "not a time");
		const pre = await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => [s.body.usageSource, s.body.inputTokens])).toEqual([
			["provider", 0],
		]);
		expect(pre.stderr).toContain("first-run time unreadable");
	});

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

	it("a claim made by a hook that died before saving is never posted: nothing can say it was not", async () => {
		await startServer(okResponder);
		await writeMain([]);
		await run("stop.mjs", stopInput());
		// The state a hook killed right after claiming msg_a leaves: the claim names
		// this agent, and the cursor has no record of it.
		await appendMain(responseEntries("msg_a", SONNET, u(4, 4)));
		const digest = createHash("sha256").update("msg_a").digest("hex");
		const claims = join(stateDir, "transcripts", "claims");
		await mkdir(join(claims, digest.slice(0, 2)), { recursive: true, mode: 0o700 });
		await writeFile(join(claims, digest.slice(0, 2), digest.slice(2)), `${SESSION}/main`);
		const stop = await run("stop.mjs", stopInput());
		// At most once: an under-count, said on stderr, never a second charge.
		expect(settles()).toEqual([]);
		expect(stop.stderr).toContain("or by a hook that died before saving");
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});

	it("a message re-read after its id left the cursor's history is never posted again: its claim already exists", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(6, 6)));
		await run("stop.mjs", stopInput());
		// Ten thousand ids later msg_a has left `accounted`, and the transcript is
		// replaced by a shorter file holding it: read again from 0.
		const cursor = await readCursor();
		await writeFile(cursorPath(), JSON.stringify({ ...cursor, accounted: [] }));
		await writeFile(
			mainTranscript,
			`${responseEntries("msg_a", SONNET, u(6, 6), {}, { partials: 0 }).join("\n")}\n`,
		);
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([6]);
	});

	it("H4: a lost cursor's recovered claim INTENT never re-posts a message already charged", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(7, 9)));
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => [s.body.inputTokens, s.body.outputTokens])).toEqual([[7, 9]]);
		// The cursor is lost, and the hook that re-read the history recorded its intent
		// to claim msg_a, then deferred it (out of time) or died: the state that leaves.
		const lost = {
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
					inputTokens: 7,
					outputTokens: 9,
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
		};
		await writeFile(cursorPath(), JSON.stringify(lost));
		const again = await run("stop.mjs", stopInput());
		// The claim on msg_a is this agent's, but not this cursor's: never posted again.
		expect(settles().map((s) => [s.body.inputTokens, s.body.outputTokens])).toEqual([[7, 9]]);
		expect(again.stderr).toContain("before its cursor was removed or reset");
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
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
		const hold = join(stateDir, holdFile("tu_1", "tx_1"));
		const old = new Date(Date.now() - 11 * 60_000);
		await utimes(hold, old, old);
		delayMs = 1_500;
		const posting = run("post-tool-use.mjs", postInput("tu_1"));
		const settling = join(stateDir, holdFile("tu_1", "tx_1", "settling"));
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

	it("an already-settled window is accounted at once, and never posted", async () => {
		capabilities = [...ALL_CAPABILITIES];
		const server = keyedServer();
		server.charged.add(keyOf("main", ["msg_a"]));
		await startServer(server.responder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
		await run("stop.mjs", stopInput());
		expect(server.charges).toEqual([]);
		expect(settles().map((s) => s.body.inputTokens)).not.toContain(5);
	});

	it("a binding whose outcome nothing recorded — 'authorizing', its hook gone — is never posted again", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
		// What a PreToolUse killed after binding its window leaves: the claim, and
		// the window "authorizing" in the cursor. Its authorize may have gone out,
		// and nothing recorded what came back.
		const digest = createHash("sha256").update("msg_a").digest("hex");
		const claims = join(stateDir, "transcripts", "claims", digest.slice(0, 2));
		await mkdir(claims, { recursive: true, mode: 0o700 });
		await writeFile(join(claims, digest.slice(2)), `${SESSION}/main`);
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
						claimed: true,
						inputTokens: 5,
						outputTokens: 6,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
				},
				accounted: [],
				denied: [],
				assigned: { msg_a: "authorizing" },
				estimateMode: false,
				estimateReason: null,
				lastModel: SONNET,
				unresolved: {},
			}),
		);
		await run("stop.mjs", stopInput());
		// At most once: possibly posted, so never posted again — an under-count.
		expect(settles()).toEqual([]);
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

	it("a parent's estimate mode recorded just as its fork takes its lock: the fork still inherits it", async () => {
		await startServer(okResponder);
		await writeMain(inherited());
		await writeSubagent("f1", "fork", forkTranscript());
		// The parent's record lands after the fork's first check, before anything it
		// could post: at its lock.
		const marker = join(stateDir, "transcripts", "estimate", `${SESSION}__main`);
		const pre = await run("pre-tool-use.mjs", preInput("tu_f", { agent_id: "f1" }), {
			NODE_OPTIONS: `--import=${join(import.meta.dirname, "helpers", "crash-at.mjs")}`,
			UT_CC_CRASH: "create|1|after",
			UT_CC_CRASH_ACTION: `write ${marker}`,
		});
		expect(pre.code).toBe(0);
		await run("post-tool-use.mjs", postInput("tu_f", { agent_id: "f1" }));
		expect(settles().map((s) => s.body.usageSource)).toEqual(["estimated"]);
		expect(authorizes()[0]?.body.params).toEqual({ hook: "PreToolUse", tool_name: "Bash" });
	});

	it("a fork of a parent in estimate mode posts none of what it inherited: it inherits the estimate mode", async () => {
		await startServer(okResponder);
		// The parent's transcript cannot be read at its first hook: it settles at the
		// estimate for the rest of the session, and claims none of its responses.
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		await writeMain(inherited());
		// Its fork's transcript begins with a copy of them.
		await writeSubagent("f1", "fork", forkTranscript());
		const pre = await run("pre-tool-use.mjs", preInput("tu_f", { agent_id: "f1" }));
		await run("post-tool-use.mjs", postInput("tu_f", { agent_id: "f1" }));
		await run("subagent-stop.mjs", { ...stopInput(), agent_id: "f1", agent_type: "fork" });
		await run("stop.mjs", stopInput());
		// Nothing for real: msg_a and msg_b were the parent's estimates already.
		expect(settles().map((s) => s.body.usageSource)).toEqual(["estimated", "estimated"]);
		expect(pre.stderr).toContain("main of this session settles at the estimate");
		expect(
			await readFile(join(stateDir, "transcripts", "estimate", `${SESSION}__f1`), "utf-8"),
		).toContain("main of this session settles at the estimate");
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
		// And since #231 it sizes a hold per cache tier, and says so.
		expect(health.capabilities).toContain("authorize-cache-tiers");
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
		// What the server held for the window: each cache tier at its own rate, as the
		// window's authorize gave them apart — never under the window's real cost.
		expect(authorizes()[0]?.body).toMatchObject({
			estimatedInputTokens: 150 + TOOL_INPUT_ESTIMATE,
			estimatedCacheReadTokens: 82_000,
			estimatedCacheWriteTokens: 2_000,
			maxOutputTokens: 1000 + TOOL_OUTPUT_HOLD,
		});
		const rates = getModelRates(SONNET);
		const holdRates = {
			...rates,
			inputPer1k: Math.max(rates.inputPer1k, effectiveCacheWriteRate(rates)),
		};
		const hold = costFromRates(
			holdRates,
			150 + TOOL_INPUT_ESTIMATE,
			1000 + TOOL_OUTPUT_HOLD,
			82_000,
			2_000,
		);
		const windowAuth = authorizes()[0]?.response as { estimatedCost?: number } | undefined;
		expect(windowAuth?.estimatedCost).toBe(hold);
		// The window's own part of it, less the tool call's estimate: 477, against a
		// real cost of 476 (it held 3 381 with the cache writes doubled).
		expect(costFromRates(holdRates, 150, 1000, 82_000, 2_000)).toBe(477);
		expect(receipts[0]?.cost).toBe(476);
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

describe("a tool call whose PreToolUse fires again (a resumed defer) never reuses its hold, and never keeps two", () => {
	// Claude Code fires PreToolUse again for the SAME tool call when a deferred call
	// resumes (hooks reference, "Defer a tool call for later"). 1.4.0 reserved a second
	// hold and overwrote the first's record: the first hold was stranded until the
	// server's TTL, and in transcript mode its window was written off, never charged.
	// Now every re-fire ends the call's earlier hold first (`retire`), then reserves
	// afresh, so the budget is checked at every resume: a hold is never reused.
	const endInput = () => ({ ...stopInput(), hook_event_name: "SessionEnd", reason: "other" });
	const SESSION_END_BUDGET = { CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "" };
	const notFound = { status: 404, json: { error: "not_found", reason: "unknown transferId" } };
	const LOSE_CLAIM = join(import.meta.dirname, "helpers", "lose-claim.mjs");
	const LOSE_RECONCILE = join(import.meta.dirname, "helpers", "lose-reconcile.mjs");
	const PAUSE_AT = join(import.meta.dirname, "helpers", "pause-at.mjs");

	/**
	 * A server that holds what it authorizes, forgets what `expire` names, logs
	 * charges, and refuses every authorize after `refuse` (a budget 402). Each answer
	 * states a fresh 300 s life (`expiresInMs`, `hold-expiry`), which the plugin does
	 * not consult: it never reuses a hold however much life one has left.
	 */
	function holdingServer() {
		const pending = new Set<string>();
		const charges: Array<{ transferId: string; inputTokens: unknown; outputTokens: unknown }> = [];
		let refusing = false;
		const responder: Responder = (path, body) => {
			if (path === "/v1/authorize") {
				if (refusing) {
					return { status: 402, json: { error: "budget_exceeded", reason: "need 9, have 1" } };
				}
				nextTransfer += 1;
				pending.add(`tx_${nextTransfer}`);
				return {
					status: 200,
					json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1, expiresInMs: 300_000 },
				};
			}
			const id = String(body.transferId);
			if (!pending.delete(id)) return notFound;
			if (path === "/v1/settle") {
				charges.push({
					transferId: id,
					inputTokens: body.inputTokens,
					outputTokens: body.outputTokens,
				});
				return { status: 200, json: { settled: true, transferId: id } };
			}
			return { status: 200, json: { released: true, aborted: true } };
		};
		return {
			responder,
			charges,
			expire: (id: string) => pending.delete(id),
			refuse: () => {
				refusing = true;
			},
		};
	}

	/** The first hold's files: each hold of the call has its own (by transfer). */
	const RECORD = holdFile("tu_1", "tx_1");
	const SETTLING = holdFile("tu_1", "tx_1", "settling");
	/** The call's one pending record as written, whichever hold it is. */
	async function record(): Promise<Record<string, unknown>> {
		const pending = (await holdStateFiles()).filter((name) => name.endsWith(".json"));
		expect(pending).toHaveLength(1);
		return JSON.parse(await readFile(join(stateDir, pending[0] ?? ""), "utf-8")) as Record<
			string,
			unknown
		>;
	}
	/** Requests about tx_1 after its authorize: a settle, a release or an abort. */
	const aboutTx1 = () => requests.filter((r) => r.body.transferId === "tx_1");
	/** The gap records in watch.jsonl. */
	async function gaps(): Promise<Array<{ kind: string; reason: string }>> {
		return (await readFile(join(stateDir, "watch.jsonl"), "utf-8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; reason: string });
	}

	describe("estimate mode", () => {
		const env = { UT_CC_USAGE: "estimate" };
		const enforce = { ...env, UT_CC_MODE: "enforce" };

		it("an immediate re-fire ends the first hold, then reserves afresh: one authorize per fire, and the fresh hold settled once", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			expect(authorizes()).toHaveLength(1);
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), env);
			expect(again.code).toBe(0);
			expect(again.stdout).toBe("");
			expect(again.stderr).toContain("this tool call's earlier hold tx_1 is ended");
			expect(again.stderr).toContain("reserved tx_2");
			expect(authorizes()).toHaveLength(2);
			// No release on this server, so nothing is sent about the first hold: its record
			// is dropped, and the hold is left to the server's sweep. It is never aborted.
			expect(aboutTx1()).toEqual([]);
			expect((await record()).transferId).toBe("tx_2");
			await run("post-tool-use.mjs", postInput("tu_1"), env);
			await run("stop.mjs", stopInput(), env);
			expect(server.charges).toEqual([
				{ transferId: "tx_2", inputTokens: TOOL_INPUT_ESTIMATE, outputTokens: 3 },
			]);
			expect(await holdStateFiles()).toEqual([]);
		});

		it("on a server with release, the first hold is RELEASED before the second is asked for, and never aborted", async () => {
			capabilities = ["release"];
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			expect(requests.map((r) => [r.path, r.body.transferId ?? transferOf(r)])).toEqual([
				["/v1/authorize", "tx_1"],
				["/v1/release", "tx_1"],
				["/v1/authorize", "tx_2"],
			]);
			expect(aborts()).toEqual([]);
		});

		it("enforce mode: a budget refusal (402) at the resume DENIES the call", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), enforce);
			server.refuse();
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), enforce);
			expect(again.code).toBe(0);
			const decision = JSON.parse(again.stdout).hookSpecificOutput;
			expect(decision.permissionDecision).toBe("deny");
			expect(decision.permissionDecisionReason).toContain("budget_exceeded");
			expect(authorizes()).toHaveLength(2);
			expect(aboutTx1()).toEqual([]);
			expect(await holdStateFiles()).toEqual([]);
		});

		it.each<[string, number]>([
			["just now", 0],
			["in the future (the clock was set back an hour)", -3_600_000],
			["an hour ago (the clock was set forward)", 3_600_000],
		])(
			"a record a reuse-era plugin wrote, reserved %s with a 300 s life, is still ended: no clock and no stated life is read",
			async (_, ago) => {
				const server = holdingServer();
				await startServer(server.responder);
				await run("pre-tool-use.mjs", preInput("tu_1"), env);
				await writeFile(
					join(stateDir, RECORD),
					JSON.stringify({
						...(await record()),
						reservedAt: Date.now() - ago,
						expiresInMs: 300_000,
					}),
				);
				const again = await run("pre-tool-use.mjs", preInput("tu_1"), env);
				expect(again.stderr).toContain("this tool call's earlier hold tx_1 is ended");
				expect(authorizes()).toHaveLength(2);
			},
		);

		it("control: SessionEnd at the deferred exit ends the first hold, and the resume reserves its own", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			await run("session-end.mjs", endInput(), { ...env, ...SESSION_END_BUDGET });
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			await run("post-tool-use.mjs", postInput("tu_1"), env);
			await run("stop.mjs", stopInput(), env);
			expect(authorizes()).toHaveLength(2);
			expect(requests.filter((r) => r.body.transferId === "tx_1").map((r) => r.path)).toEqual([
				expect.stringMatching(/^\/v1\/(release|abort)$/),
			]);
			expect(server.charges.map((c) => c.transferId)).toEqual(["tx_2"]);
			expect(await holdStateFiles()).toEqual([]);
		});
	});

	describe("transcript mode", () => {
		it("no key: an immediate re-fire settles the first hold's window ONCE at its counts, then holds afresh; nothing written off", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			const again = await run("pre-tool-use.mjs", preInput("tu_1"));
			expect(again.stderr).toContain("this tool call's earlier hold tx_1 is ended");
			await run("post-tool-use.mjs", postInput("tu_1"));
			await run("stop.mjs", stopInput());
			expect(authorizes()).toHaveLength(2);
			// The fresh hold carries no window: given back or settled at zero, as any empty
			// hold is.
			expect(server.charges.filter((c) => c.inputTokens !== 0)).toEqual([
				{ transferId: "tx_1", inputTokens: 9, outputTokens: 9 },
			]);
			const cursor = await readCursor();
			expect(cursor.accounted).toEqual(["msg_a"]);
			expect(cursor.assigned).toEqual({});
			expect(await holdStateFiles()).toEqual([]);
		});

		it("no key: an EXPIRED first hold's window is released, and the fresh hold carries it, charged once", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			server.expire("tx_1");
			await run("pre-tool-use.mjs", preInput("tu_1"));
			expect((await record()).assignedIds).toEqual(["msg_a"]);
			await run("post-tool-use.mjs", postInput("tu_1"));
			await run("stop.mjs", stopInput());
			expect(server.charges.filter((c) => c.inputTokens !== 0)).toEqual([
				{ transferId: "tx_2", inputTokens: 9, outputTokens: 9 },
			]);
			// tx_2 carried the window: Stop had no remainder to authorize.
			expect(authorizes()).toHaveLength(2);
			expect((await readCursor()).accounted).toEqual(["msg_a"]);
			expect(await holdStateFiles()).toEqual([]);
		});

		it("keyed: an immediate re-fire settles the first hold's window once, under its key", async () => {
			capabilities = [...ALL_CAPABILITIES];
			const server = keyedServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			await run("post-tool-use.mjs", postInput("tu_1"));
			await run("stop.mjs", stopInput());
			expect(authorizes()).toHaveLength(2);
			expect(server.charges).toEqual([
				{ key: keyOf("main", ["msg_a"]), transferId: "tx_1", inputTokens: 5 },
			]);
			expect((await readCursor()).accounted).toEqual(["msg_a"]);
			expect(await holdStateFiles()).toEqual([]);
		});

		it("keyed: an expired first hold's window is retried under its key at Stop, charged once", async () => {
			capabilities = [...ALL_CAPABILITIES];
			const server = keyedServer();
			server.faults.set("tx_1", "404-restarted");
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			const again = await run("pre-tool-use.mjs", preInput("tu_1"));
			expect(again.stderr).toContain("hold tx_1 unresolved");
			await run("post-tool-use.mjs", postInput("tu_1"));
			await run("stop.mjs", stopInput());
			expect(server.charges).toEqual([
				{ key: keyOf("main", ["msg_a"]), transferId: "tx_3", inputTokens: 5 },
			]);
			expect((await readCursor()).accounted).toEqual(["msg_a"]);
		});

		it("enforce mode: the first hold's window is settled once, then the refused resume is DENIED", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			server.refuse();
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			expect(JSON.parse(again.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
			expect(server.charges).toEqual([{ transferId: "tx_1", inputTokens: 9, outputTokens: 9 }]);
			expect((await readCursor()).accounted).toEqual(["msg_a"]);
			expect(await holdStateFiles()).toEqual([]);
		});

		it("control: SessionEnd at the deferred exit settles the first hold's window, once", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			await run("session-end.mjs", endInput(), SESSION_END_BUDGET);
			await run("pre-tool-use.mjs", preInput("tu_1"));
			await run("post-tool-use.mjs", postInput("tu_1"));
			await run("stop.mjs", stopInput());
			// msg_a is charged once, on tx_1, by SessionEnd. The resume's own hold, tx_2,
			// carries no window and is given back or settled at zero, as any empty hold is.
			expect(server.charges.filter((c) => c.inputTokens !== 0)).toEqual([
				{ transferId: "tx_1", inputTokens: 9, outputTokens: 9 },
			]);
			expect((await readCursor()).accounted).toEqual(["msg_a"]);
			expect(await holdStateFiles()).toEqual([]);
		});
	});

	describe("a resume under ANOTHER server or key: the earlier hold is never touched through the new one", () => {
		// Each record carries the server's URL and a hash of the key that made it. Under
		// another server or key, a settle of the old hold at the new server would answer
		// 404, and the unkeyed path would hand the old window to the fresh hold: the new
		// tenant would pay for the old one's usage. So the record is dropped, nothing about
		// the old hold is sent to the new server, and a window it carried goes unrecorded.
		const env = { UT_CC_USAGE: "estimate" };
		let other: Awaited<ReturnType<typeof otherServer>> | undefined;
		afterEach(() => {
			other?.close();
			other = undefined;
		});

		/** A second server, another tenant: records what it is sent, and advertises `capabilities`. */
		async function otherServer(capabilities: string[]) {
			const seen: Array<{
				method: string;
				path: string;
				auth: string;
				body: Record<string, unknown>;
			}> = [];
			const server = createServer((req, res) => {
				let raw = "";
				req.on("data", (chunk) => {
					raw += chunk;
				});
				req.on("end", () => {
					const path = req.url ?? "";
					seen.push({
						method: req.method ?? "",
						path,
						auth: req.headers.authorization ?? "",
						body: JSON.parse(raw || "{}") as Record<string, unknown>,
					});
					const json =
						path === "/v1/health"
							? { status: "ok", capabilities }
							: path === "/v1/authorize"
								? { transferId: "tx_other", estimatedCost: 1 }
								: path === "/v1/settle"
									? { settled: true }
									: { released: true };
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify(json));
				});
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
			const address = server.address();
			const otherPort = typeof address === "object" && address !== null ? address.port : 0;
			return {
				env: { UT_SERVER_URL: `http://127.0.0.1:${otherPort}`, UT_SERVER_KEY: "k2" },
				posts: () => seen.filter((r) => r.method === "POST").map((r) => `${r.path} ${r.auth}`),
				aboutTx1: () => seen.filter((r) => r.body.transferId === "tx_1"),
				close: () => {
					server.closeAllConnections();
					server.close();
				},
			};
		}

		it("estimate: another server and key, with release, gets only the fresh authorize, never a word about the old hold", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			other = await otherServer(["release"]);
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), { ...env, ...other.env });
			expect(again.stderr).toContain("hold tx_1 was made under another server or key");
			expect(again.stderr).toContain("reserved tx_other");
			expect(other.posts()).toEqual(["/v1/authorize Bearer k2"]);
			expect(other.aboutTx1()).toEqual([]);
			// The first server is not told either, and the record now names the new hold and
			// its tenant.
			expect(authorizes()).toHaveLength(1);
			const fresh = await record();
			expect(fresh.transferId).toBe("tx_other");
			expect(fresh.serverUrl).toBe(other.env.UT_SERVER_URL);
			expect(fresh.keyHash).toBe(createHash("sha256").update("k2").digest("hex").slice(0, 16));
		});

		it("transcript: the old hold's window is NOT carried into the new tenant's hold; it goes unrecorded", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			other = await otherServer([]);
			await run("pre-tool-use.mjs", preInput("tu_1"), other.env);
			expect(other.aboutTx1()).toEqual([]);
			expect(other.posts()).toEqual(["/v1/authorize Bearer k2"]);
			const fresh = await record();
			expect(fresh.transferId).toBe("tx_other");
			expect(fresh.assignedIds).toEqual([]);
			expect((await readCursor()).accounted).toEqual(["msg_a"]);
			expect(server.charges).toEqual([]);
		});

		it("the same server under another key, with release: nothing about the old hold is sent", async () => {
			capabilities = ["release"];
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			await run("pre-tool-use.mjs", preInput("tu_1"), { ...env, UT_SERVER_KEY: "k2" });
			expect(aboutTx1()).toEqual([]);
			expect(authorizes()).toHaveLength(2);
		});

		it("a record without a binding (written before the plugin kept one) is treated as another tenant's", async () => {
			capabilities = ["release"];
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			const { serverUrl: _url, keyHash: _hash, ...legacy } = await record();
			await writeFile(join(stateDir, RECORD), JSON.stringify(legacy));
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), env);
			expect(again.stderr).toContain("hold tx_1 was made under another server or key");
			expect(aboutTx1()).toEqual([]);
			expect(authorizes()).toHaveLength(2);
		});

		it("a LOST claim under another server: the call reserves nothing there, and enforce denies", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			other = await otherServer([]);
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), {
				...env,
				...other.env,
				UT_CC_MODE: "enforce",
				NODE_OPTIONS: `--import=${LOSE_CLAIM}`,
			});
			expect(JSON.parse(again.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
			expect(other.posts()).toEqual([]);
			expect(await holdStateFiles()).toEqual([SETTLING]);
		});

		/** The call's record, as a settle cut off before any answer leaves it: `.settling`. */
		async function cutOff({ stale }: { stale: boolean }) {
			await rename(join(stateDir, RECORD), join(stateDir, SETTLING));
			if (stale) {
				const then = new Date(Date.now() - 11 * 60_000);
				await utimes(join(stateDir, SETTLING), then, then);
			}
		}

		it("a STALE `.settling` made under another server and key never reaches this tenant's journal: nothing about it is sent, its keyed window is never parked for a retry here, and goes unrecorded", async () => {
			capabilities = [...ALL_CAPABILITIES];
			const server = keyedServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			expect(await record()).toHaveProperty("idempotencyKey");
			await cutOff({ stale: true });
			other = await otherServer([...ALL_CAPABILITIES]);
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), other.env);
			expect(again.stderr).toContain("hold tx_1 was made under another server or key");
			expect(again.stderr).toContain("reserved tx_other");
			expect(other.aboutTx1()).toEqual([]);
			expect(other.posts()).toEqual(["/v1/authorize Bearer k2"]);
			// Abandoned through its own name; the fresh hold carries no window of the old one.
			expect(await holdStateFiles()).toEqual([holdFile("tu_1", "tx_other")]);
			expect((await record()).assignedIds).toEqual([]);
			const cursor = (await readCursor()) as unknown as {
				accounted: string[];
				unresolved: Record<string, unknown>;
			};
			expect(cursor.accounted).toEqual(["msg_a"]);
			expect(cursor.unresolved).toEqual({});
			// A Stop under the new tenant retries nothing of the old one's.
			await run("stop.mjs", stopInput(), other.env);
			expect(other.posts().filter((post) => !post.startsWith("/v1/release"))).toEqual([
				"/v1/authorize Bearer k2",
			]);
			expect(server.charges).toEqual([]);
		});

		it("a FRESH `.settling` made under another server or key is refused: its settle may be in flight, and nothing about it is sent", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			await cutOff({ stale: false });
			other = await otherServer([]);
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), {
				...env,
				...other.env,
				UT_CC_MODE: "enforce",
			});
			expect(JSON.parse(again.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
			expect(other.posts()).toEqual([]);
			expect(await holdStateFiles()).toEqual([SETTLING]);
		});

		it("a STALE `.settling` made under another server or key that another hook abandons first: this call reserves nothing", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			await cutOff({ stale: true });
			other = await otherServer([]);
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), {
				...env,
				...other.env,
				UT_CC_MODE: "enforce",
				NODE_OPTIONS: `--import=${LOSE_CLAIM}`,
			});
			expect(JSON.parse(again.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
			expect(again.stderr).not.toContain("goes unrecorded");
			expect(other.posts()).toEqual([]);
		});
	});

	describe("a first hold another hook ends, or that cannot be ended: no fresh hold beside it", () => {
		it.each<[string, Record<string, string>, boolean]>([
			["estimate, enforce", { UT_CC_USAGE: "estimate", UT_CC_MODE: "enforce" }, false],
			["estimate, watch", { UT_CC_USAGE: "estimate" }, false],
			["transcript, enforce", { UT_CC_MODE: "enforce" }, true],
		])(
			"a LOST claim (%s): another hook claimed the first hold first, so the call reserves nothing",
			async (_, env, transcript) => {
				const server = holdingServer();
				await startServer(server.responder);
				if (transcript) await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
				await run("pre-tool-use.mjs", preInput("tu_1"), env);
				const again = await run("pre-tool-use.mjs", preInput("tu_1"), {
					...env,
					NODE_OPTIONS: `--import=${LOSE_CLAIM}`,
				});
				expect(again.code).toBe(0);
				// Nothing claims this hook ended the hold: another hook did.
				expect(again.stderr).not.toContain("is ended");
				const why = "another hook is ending this tool call's earlier hold tx_1";
				if (env.UT_CC_MODE === "enforce") {
					const decision = JSON.parse(again.stdout).hookSpecificOutput;
					expect(decision.permissionDecision).toBe("deny");
					expect(decision.permissionDecisionReason).toContain(why);
				} else {
					expect(again.stdout).toBe("");
					expect((await gaps())[0]?.reason).toContain(why);
				}
				expect(authorizes()).toHaveLength(1);
				// The record is the other hook's claim; nothing was written beside it.
				expect(await holdStateFiles()).toEqual([SETTLING]);
			},
		);

		it.each<[string, Record<string, string>]>([
			["estimate", { UT_CC_USAGE: "estimate" }],
			["transcript", {}],
		])(
			"%s mode: a first hold that cannot be ended stops the fresh reserve, and enforce fails closed",
			async (_, usage) => {
				const server = holdingServer();
				await startServer(server.responder);
				await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
				await run("pre-tool-use.mjs", preInput("tu_1"), usage);
				// A directory where the claim renames the record to: it cannot be claimed.
				await mkdir(join(stateDir, SETTLING));
				const again = await run("pre-tool-use.mjs", preInput("tu_1"), {
					...usage,
					UT_CC_MODE: "enforce",
				});
				expect(again.code).toBe(2);
				expect(again.stderr).toContain("authorization failed closed");
				expect(authorizes()).toHaveLength(1);
				expect(server.charges).toEqual([]);
				// tx_1's record is kept, never overwritten by a fresh hold's.
				expect((await readdir(stateDir)).filter((n) => n.endsWith(".json"))).toEqual([RECORD]);
			},
		);
	});

	describe("a `.settling` record of the same call: the call is refused until that settle resolves", () => {
		/** The call's pending record, renamed as a settling hook's claim leaves it. */
		async function claimed() {
			await rename(join(stateDir, RECORD), join(stateDir, SETTLING));
		}
		/** The claim, aged past the journal's staleness rule (`STALE_SETTLING_MS`, 10 min). */
		async function stale() {
			const then = new Date(Date.now() - 11 * 60_000);
			await utimes(join(stateDir, SETTLING), then, then);
		}

		it("watch mode: no second hold, and the gap is recorded", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_USAGE: "estimate" });
			await claimed();
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_USAGE: "estimate" });
			expect(again.code).toBe(0);
			expect(again.stdout).toBe("");
			expect(again.stderr).toContain("this call is not metered");
			expect(again.stderr).toContain("tx_1 has a settle that is not resolved yet");
			expect(again.stderr).toContain("recorded as a gap");
			const recorded = await gaps();
			expect(recorded.map((g) => g.kind)).toEqual(["gap"]);
			expect(recorded[0]?.reason).toContain("tx_1 has a settle that is not resolved yet");
			expect(authorizes()).toHaveLength(1);
			expect(await holdStateFiles()).toEqual([SETTLING]);
		});

		it.each<[string, Record<string, string>]>([
			["enforce mode", { UT_CC_USAGE: "estimate", UT_CC_MODE: "enforce" }],
			[
				"enforce mode with UT_FAIL_OPEN=1 (not an outage)",
				{ UT_CC_USAGE: "estimate", UT_CC_MODE: "enforce", UT_FAIL_OPEN: "1" },
			],
		])(
			"an estimate hold's `.settling` (its settle attempted, or a retire cut off before its unlink): %s DENIES the resume",
			async (_, env) => {
				const server = holdingServer();
				await startServer(server.responder);
				await run("pre-tool-use.mjs", preInput("tu_1"), env);
				await claimed();
				await stale(); // Even stale: the journal cannot decide a record without a window.
				const again = await run("pre-tool-use.mjs", preInput("tu_1"), env);
				expect(again.code).toBe(0);
				const decision = JSON.parse(again.stdout).hookSpecificOutput;
				expect(decision.permissionDecision).toBe("deny");
				expect(decision.permissionDecisionReason).toContain(
					"tx_1 has a settle that is not resolved yet",
				);
				expect(authorizes()).toHaveLength(1);
				expect(await holdStateFiles()).toEqual([SETTLING]);
			},
		);

		it("a FRESH transcript `.settling` (its settle may be in flight): enforce DENIES, and the journal leaves it alone", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			await claimed();
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			expect(JSON.parse(again.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
			expect(authorizes()).toHaveLength(1);
			expect(await holdStateFiles()).toEqual([SETTLING]);
			expect((await readCursor()).accounted).toEqual([]);
		});

		it("a STALE transcript `.settling`, no key: the journal decides it first (its ids accounted, at most once), then the resume reserves afresh, and a 402 DENIES it", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			await claimed();
			await stale();
			server.refuse();
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			expect(JSON.parse(again.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
			expect(authorizes()).toHaveLength(2);
			expect(await holdStateFiles()).toEqual([]);
			expect((await readCursor()).accounted).toEqual(["msg_a"]);
			expect(server.charges).toEqual([]);
		});

		it("a STALE transcript `.settling`: the fresh hold's window leaves the old ids out, and carries only what is new", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			await claimed();
			await stale();
			await appendMain(responseEntries("msg_b", SONNET, u(4, 4)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			expect(await holdStateFiles()).toEqual([holdFile("tu_1", "tx_2")]);
			const fresh = await record();
			expect(fresh.transferId).toBe("tx_2");
			expect(fresh.assignedIds).toEqual(["msg_b"]);
			await run("post-tool-use.mjs", postInput("tu_1"));
			await run("stop.mjs", stopInput());
			// msg_a was accounted by the journal and is never posted; msg_b is charged once.
			expect(server.charges).toEqual([{ transferId: "tx_2", inputTokens: 4, outputTokens: 4 }]);
		});

		it("a STALE transcript `.settling`, keyed: parked for a retry under its key, and charged once at Stop", async () => {
			capabilities = [...ALL_CAPABILITIES];
			const server = keyedServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(5, 6)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			await claimed();
			await stale();
			await run("pre-tool-use.mjs", preInput("tu_1"));
			await run("post-tool-use.mjs", postInput("tu_1"));
			await run("stop.mjs", stopInput());
			expect(server.charges).toEqual([
				{ key: keyOf("main", ["msg_a"]), transferId: "tx_1", inputTokens: 5 },
			]);
			expect((await readCursor()).accounted).toEqual(["msg_a"]);
		});

		it("two hooks resumed together over one STALE record: only the one whose reconcile removed it may reserve; this one is refused", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			await claimed();
			await stale();
			// The other hook's reconcile removes the record just before this hook's own runs:
			// the record is gone, but this hook did not decide it.
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), {
				UT_CC_MODE: "enforce",
				NODE_OPTIONS: `--import=${LOSE_RECONCILE}`,
				UT_CC_TAKEN: join(stateDir, SETTLING),
			});
			expect(JSON.parse(again.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
			expect(authorizes()).toHaveLength(1);
			expect(await holdStateFiles()).toEqual([]);
		});

		it("a STALE transcript `.settling` with no window (a retire cut off before its unlink) is decided too, and the resume reserves afresh", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain([]);
			await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			const first = await record();
			expect(first.usage).toBe("transcript");
			expect(first.assignedIds).toEqual([]);
			await claimed();
			await stale();
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			expect(again.stdout).toBe("");
			expect(again.stderr).toContain("reserved tx_2");
			expect(authorizes()).toHaveLength(2);
			expect(await holdStateFiles()).toEqual([holdFile("tu_1", "tx_2")]);
		});

		it("control: a FRESH transcript `.settling` with no window is refused: a retire may still be ending it", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain([]);
			await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			await claimed();
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			expect(JSON.parse(again.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
			expect(authorizes()).toHaveLength(1);
			expect(await holdStateFiles()).toEqual([SETTLING]);
		});

		it("a STALE transcript `.settling` the journal cannot reach (its lock is held): no fresh hold beside it, and enforce DENIES", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			await claimed();
			await stale();
			const lock = `${cursorPath()}.lock`;
			await mkdir(lock);
			await writeFile(join(lock, "owner"), "another-hook");
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
			await rm(lock, { recursive: true });
			expect(JSON.parse(again.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
			expect(authorizes()).toHaveLength(1);
			expect(await holdStateFiles()).toEqual([SETTLING]);
		});
	});

	describe("each hold has its own files (by transfer): a hook acting on an earlier listing never touches a later hold's", () => {
		/** Every paused hook's resume: each is resumed after its test, even a failed one. */
		const resumes: Array<() => Promise<unknown>> = [];
		afterEach(async () => {
			for (const resume of resumes.splice(0)) await resume();
		});

		/**
		 * Start `hook` and let it run until it is about to claim (`claim`), delete
		 * (`clear`) or publish (`publish`) its first hold record; it waits there until
		 * `resume` (tests/helpers/pause-at.mjs).
		 */
		async function pausedAt(
			hook: string,
			input: Record<string, unknown>,
			at: "claim" | "clear" | "publish",
			env: Record<string, string> = {},
		) {
			const flags = await mkdtemp(join(tmpdir(), "utcc-pause-"));
			const pausedFlag = join(flags, "paused");
			const go = join(flags, "go");
			const running = run(hook, input, {
				...env,
				NODE_OPTIONS: `--import=${PAUSE_AT}`,
				UT_CC_PAUSE: at,
				UT_CC_PAUSED: pausedFlag,
				UT_CC_GO: go,
			});
			const isPaused = () =>
				stat(pausedFlag).then(
					() => true,
					() => false,
				);
			for (let i = 0; i < 500 && !(await isPaused()); i += 1) {
				await new Promise((r) => setTimeout(r, 10));
			}
			const wasPaused = await isPaused();
			const resume = async () => {
				await writeFile(go, "");
				return running;
			};
			resumes.push(resume);
			return { wasPaused, resume };
		}
		/** The transfer ids the pending records store, whatever their names. */
		async function pendingTransfers() {
			const ids: unknown[] = [];
			for (const name of await holdStateFiles()) {
				if (!name.endsWith(".json")) continue;
				ids.push(JSON.parse(await readFile(join(stateDir, name), "utf-8")).transferId);
			}
			return ids;
		}
		/** Each journalled outcome, by the transfer it stores, whatever its file's name. */
		async function outcomes() {
			const found: Record<string, unknown> = {};
			for (const name of await readdir(stateDir)) {
				if (!name.endsWith(".done")) continue;
				const body = JSON.parse(await readFile(join(stateDir, name), "utf-8"));
				found[String(body.transferId)] = body.outcome;
			}
			return found;
		}

		it("the interleave that double-charged: a Stop that listed the first hold before a re-fire settled it finds that hold's own file gone, so the window is charged ONCE and its `settled` is never written over", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			// The cursor lock stays held, as a busy hook holds it: nothing is reconciled, so
			// tx_1's journal entry waits on disk while the stale Stop runs.
			const lock = `${cursorPath()}.lock`;
			await mkdir(lock);
			await writeFile(join(lock, "owner"), "another-hook");
			const stop = await pausedAt("stop.mjs", stopInput(), "claim");
			expect(stop.wasPaused).toBe(true);
			const again = await run("pre-tool-use.mjs", preInput("tu_1"));
			expect(again.stderr).toContain("this tool call's earlier hold tx_1 is ended");
			expect(await outcomes()).toEqual({ tx_1: "settled" });
			expect(await pendingTransfers()).toEqual(["tx_2"]);
			expect((await stop.resume()).code).toBe(0);
			// The stale Stop re-posted nothing, and wrote nothing over tx_1's `settled`.
			expect(settles().map((r) => r.body.transferId)).toEqual(["tx_1"]);
			expect(await outcomes()).toEqual({ tx_1: "settled" });
			await rm(lock, { recursive: true });
			// The journal then applies `settled`: msg_a is accounted, never released to be
			// charged again.
			await run("stop.mjs", stopInput());
			expect((await readCursor()).accounted).toEqual(["msg_a"]);
			expect(server.charges.filter((c) => c.inputTokens !== 0)).toEqual([
				{ transferId: "tx_1", inputTokens: 9, outputTokens: 9 },
			]);
		});

		it("a Stop that listed the first hold before a re-fire never claims the fresh hold's record: it survives, and each window is charged once", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			const stop = await pausedAt("stop.mjs", stopInput(), "claim");
			expect(stop.wasPaused).toBe(true);
			await appendMain(responseEntries("msg_b", SONNET, u(4, 4)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			expect((await record()).assignedIds).toEqual(["msg_b"]);
			await stop.resume();
			expect(await pendingTransfers()).toEqual(["tx_2"]);
			expect(await holdStateFiles()).toEqual([holdFile("tu_1", "tx_2")]);
			await run("post-tool-use.mjs", postInput("tu_1"));
			expect(settles().map((r) => r.body.transferId)).toEqual(["tx_1", "tx_2"]);
			expect(server.charges).toEqual([
				{ transferId: "tx_1", inputTokens: 9, outputTokens: 9 },
				{ transferId: "tx_2", inputTokens: 4, outputTokens: 4 },
			]);
		});

		it("estimate: a Stop that listed the first hold before a re-fire never deletes the fresh hold's record", async () => {
			capabilities = ["release"];
			const env = { UT_CC_USAGE: "estimate" };
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			// Stop gives tx_1 back, then waits before it deletes tx_1's record.
			const stop = await pausedAt("stop.mjs", stopInput(), "clear", env);
			expect(stop.wasPaused).toBe(true);
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), env);
			// tx_1's release answers that the server holds it no more: gone, so the call
			// reserves afresh.
			expect(again.stderr).toContain("reserved tx_2");
			await stop.resume();
			expect(await pendingTransfers()).toEqual(["tx_2"]);
			expect(await holdStateFiles()).toEqual([holdFile("tu_1", "tx_2")]);
			await run("post-tool-use.mjs", postInput("tu_1"), env);
			expect(server.charges.map((c) => c.transferId)).toEqual(["tx_2"]);
		});

		it.each<[string, string[], string]>([
			["with release", ["release"], "/v1/release"],
			["without release (the declared fallback: an abort)", [], "/v1/abort"],
		])(
			"two resumes of one call at once (%s): a second hook reserves while the first is between ending tx_1 and recording tx_2. Two holds, each its own record, nothing overwritten; charged once, and the extra ended at Stop",
			async (_, offered, extraEndedBy) => {
				capabilities = offered;
				const env = { UT_CC_USAGE: "estimate" };
				const server = holdingServer();
				await startServer(server.responder);
				await run("pre-tool-use.mjs", preInput("tu_1"), env);
				// The first resume ends tx_1, is granted tx_2, and waits before recording it.
				const first = await pausedAt("pre-tool-use.mjs", preInput("tu_1"), "publish", env);
				expect(first.wasPaused).toBe(true);
				expect(await pendingTransfers()).toEqual([]);
				// The second resume finds no hold at all, and reserves its own.
				const second = await run("pre-tool-use.mjs", preInput("tu_1"), env);
				expect(second.stderr).toContain("reserved tx_3");
				expect((await first.resume()).stderr).toContain("reserved tx_2");
				expect((await pendingTransfers()).sort()).toEqual(["tx_2", "tx_3"]);
				// One execution settles one hold; Stop ends the other.
				await run("post-tool-use.mjs", postInput("tu_1"), env);
				expect(server.charges).toHaveLength(1);
				await run("stop.mjs", stopInput(), env);
				expect(server.charges).toHaveLength(1);
				const settled = server.charges[0]?.transferId;
				const extra = settled === "tx_2" ? "tx_3" : "tx_2";
				expect(requests.filter((r) => r.body.transferId === extra).map((r) => r.path)).toEqual([
					extraEndedBy,
				]);
				expect(await holdStateFiles()).toEqual([]);
			},
		);

		describe("a 1.4.0 record (a per-call name, no binding) present at upgrade is found by its stored ids, and ended once, through its own name", () => {
			const LEGACY = `${SESSION}__main__tu_1.json`;
			/** Turn the call's record into what 1.4.0 wrote: its per-call name, no binding. */
			async function asLegacy() {
				const { serverUrl: _url, keyHash: _hash, ...body } = await record();
				await writeFile(join(stateDir, LEGACY), JSON.stringify(body));
				await rm(join(stateDir, RECORD));
			}

			it("estimate: PostToolUse settles it once", async () => {
				const env = { UT_CC_USAGE: "estimate" };
				const server = holdingServer();
				await startServer(server.responder);
				await run("pre-tool-use.mjs", preInput("tu_1"), env);
				await asLegacy();
				await run("post-tool-use.mjs", postInput("tu_1"), env);
				expect(server.charges.map((c) => c.transferId)).toEqual(["tx_1"]);
				expect(await holdStateFiles()).toEqual([]);
			});

			it("transcript: Stop settles its window once, and the journal accounts it", async () => {
				const server = holdingServer();
				await startServer(server.responder);
				await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
				await run("pre-tool-use.mjs", preInput("tu_1"));
				await asLegacy();
				await run("stop.mjs", stopInput());
				expect(server.charges).toEqual([{ transferId: "tx_1", inputTokens: 9, outputTokens: 9 }]);
				expect((await readCursor()).accounted).toEqual(["msg_a"]);
				expect(await holdStateFiles()).toEqual([]);
			});

			it("a re-fire: the record is ended (dropped, its tenant unknown), and the fresh hold gets its own file beside nothing", async () => {
				const env = { UT_CC_USAGE: "estimate" };
				const server = holdingServer();
				await startServer(server.responder);
				await run("pre-tool-use.mjs", preInput("tu_1"), env);
				await asLegacy();
				const again = await run("pre-tool-use.mjs", preInput("tu_1"), env);
				expect(again.stderr).toContain("hold tx_1 was made under another server or key");
				expect(again.stderr).toContain("reserved tx_2");
				expect(aboutTx1()).toEqual([]);
				expect(await holdStateFiles()).toEqual([holdFile("tu_1", "tx_2")]);
			});
		});

		it.each<[string, Record<string, string>]>([
			["enforce", { UT_CC_MODE: "enforce" }],
			["enforce, UT_FAIL_OPEN=1 (not an outage)", { UT_CC_MODE: "enforce", UT_FAIL_OPEN: "1" }],
			["watch", {}],
		])(
			"a file already at the fresh hold's name is never written over (%s): the hold is given back, and the call refused",
			async (_, mode) => {
				capabilities = ["release"];
				const env = { UT_CC_USAGE: "estimate", ...mode };
				const server = holdingServer();
				await startServer(server.responder);
				// Another call's record, under the very name tx_1's record will get.
				const squatter = JSON.stringify({
					gate: 1,
					toolUseId: "tu_other",
					transferId: "tx_other",
					agentId: "main",
				});
				await writeFile(join(stateDir, RECORD), squatter);
				const pre = await run("pre-tool-use.mjs", preInput("tu_1"), env);
				expect(pre.code).toBe(0);
				const why = "already has this hold's name";
				if (mode.UT_CC_MODE === "enforce") {
					const decision = JSON.parse(pre.stdout).hookSpecificOutput;
					expect(decision.permissionDecision).toBe("deny");
					expect(decision.permissionDecisionReason).toContain(why);
				} else {
					expect(pre.stdout).toBe("");
					expect((await gaps())[0]?.reason).toContain(why);
				}
				// tx_1 was given back, and the file already there is byte for byte as it was.
				expect(aboutTx1().map((r) => r.path)).toEqual(["/v1/release"]);
				expect(await readFile(join(stateDir, RECORD), "utf-8")).toBe(squatter);
				expect(await holdStateFiles()).toEqual([RECORD]);
			},
		);

		it("an outcome is never journalled over a file already at its name: the entry already there is the one the journal applies", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
			await run("pre-tool-use.mjs", preInput("tu_1"));
			await writeFile(
				join(stateDir, holdFile("tu_1", "tx_1", "done")),
				JSON.stringify({
					agentId: "main",
					transferId: "tx_other",
					assignedIds: ["msg_z"],
					outcome: "settled",
				}),
			);
			const post = await run("post-tool-use.mjs", postInput("tu_1"));
			expect(post.stderr).toContain("could not be journalled");
			expect(server.charges).toEqual([{ transferId: "tx_1", inputTokens: 9, outputTokens: 9 }]);
			// tx_1's outcome stays in flight (`.settling`), for the journal to decide later.
			expect((await readCursor()).accounted).toEqual(["msg_z"]);
			expect(await holdStateFiles()).toEqual([SETTLING]);
		});

		it("a record is read by the ids it stores, never by its name: a `.settling` named for this call but storing another's is not this call's, and the reverse is", async () => {
			const env = { UT_CC_USAGE: "estimate", UT_CC_MODE: "enforce" };
			const server = holdingServer();
			await startServer(server.responder);
			const stored = (toolUseId: string, transferId: string) =>
				JSON.stringify({ gate: 1, toolUseId, transferId, agentId: "main" });
			// Named for tu_1, but it stores another call's ids: tu_1 reserves as usual.
			await writeFile(
				join(stateDir, holdFile("tu_1", "tx_9", "settling")),
				stored("tu_other", "tx_9"),
			);
			const first = await run("pre-tool-use.mjs", preInput("tu_1"), env);
			expect(first.stdout).toBe("");
			expect(first.stderr).toContain("reserved tx_1");
			// Named for another call and another transfer, but it stores tu_2's ids and
			// tx_8: tu_2's settle of tx_8 is in flight.
			await writeFile(
				join(stateDir, holdFile("tu_other", "tx_5", "settling")),
				stored("tu_2", "tx_8"),
			);
			const second = await run("pre-tool-use.mjs", preInput("tu_2"), env);
			const decision = JSON.parse(second.stdout).hookSpecificOutput;
			expect(decision.permissionDecision).toBe("deny");
			expect(decision.permissionDecisionReason).toContain(
				"tx_8 has a settle that is not resolved yet",
			);
			expect(decision.permissionDecisionReason).not.toContain("tx_5");
			expect(authorizes()).toHaveLength(1);
		});

		describe("a state dir on a filesystem without hard links: each publish falls back to an exclusive create", () => {
			const NO_LINKS = join(import.meta.dirname, "helpers", "no-hard-links.mjs");
			const linkless = { NODE_OPTIONS: `--import=${NO_LINKS}` };

			it("estimate: a hold is still recorded, settled once, and nothing is left", async () => {
				const env = { UT_CC_USAGE: "estimate", ...linkless };
				const server = holdingServer();
				await startServer(server.responder);
				const pre = await run("pre-tool-use.mjs", preInput("tu_1"), env);
				expect(pre.stderr).toContain("reserved tx_1");
				expect(await holdStateFiles()).toEqual([RECORD]);
				await run("post-tool-use.mjs", postInput("tu_1"), env);
				expect(server.charges.map((c) => c.transferId)).toEqual(["tx_1"]);
				expect(await holdStateFiles()).toEqual([]);
			});

			it("transcript: the window is settled once, and its outcome journalled and applied", async () => {
				const server = holdingServer();
				await startServer(server.responder);
				await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
				await run("pre-tool-use.mjs", preInput("tu_1"), linkless);
				await run("post-tool-use.mjs", postInput("tu_1"), linkless);
				expect(server.charges).toEqual([{ transferId: "tx_1", inputTokens: 9, outputTokens: 9 }]);
				expect((await readCursor()).accounted).toEqual(["msg_a"]);
				expect(await holdStateFiles()).toEqual([]);
			});

			it("a file already at the fresh hold's name is still never written over", async () => {
				capabilities = ["release"];
				await startServer(holdingServer().responder);
				const squatter = JSON.stringify({
					gate: 1,
					toolUseId: "tu_other",
					transferId: "tx_other",
					agentId: "main",
				});
				await writeFile(join(stateDir, RECORD), squatter);
				const pre = await run("pre-tool-use.mjs", preInput("tu_1"), {
					UT_CC_USAGE: "estimate",
					UT_CC_MODE: "enforce",
					...linkless,
				});
				expect(JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
				expect(await readFile(join(stateDir, RECORD), "utf-8")).toBe(squatter);
			});
		});

		describe("a server's transferId names a hold's file only as it is: any other id is refused, never sanitized", () => {
			const env = { UT_CC_USAGE: "estimate" };
			/** A server that grants `id` at every authorize, and confirms every release. */
			const granting = (id: unknown) => (path: string) =>
				path === "/v1/authorize"
					? { status: 200, json: { transferId: id, estimatedCost: 1 } }
					: { status: 200, json: { released: true } };
			const releasedIds = () =>
				requests.filter((r) => r.path === "/v1/release").map((r) => r.body.transferId);

			it.each<[string, string]>([
				["a path (`../x`)", "../x"],
				["a dot (`a.b`)", "a.b"],
				["129 characters", "x".repeat(129)],
				["an empty id", ""],
			])(
				"%s: enforce refuses the call, the hold is given back, and nothing is written",
				async (_, id) => {
					capabilities = ["release"];
					await startServer(granting(id));
					// The state dir one level down, so that a write outside it would show.
					const root = await mkdtemp(join(tmpdir(), "utcc-tx-root-"));
					const state = join(root, "state");
					const pre = await run("pre-tool-use.mjs", preInput("tu_1"), {
						...env,
						UT_CC_MODE: "enforce",
						UT_CC_STATE_DIR: state,
					});
					expect(pre.code).toBe(2);
					expect(pre.stderr).toContain("authorization failed closed");
					expect(pre.stderr).toContain("its transferId is not a valid id");
					// Given back through `release`, under the id as the server sent it. An empty
					// id names no hold.
					expect(releasedIds()).toEqual(id === "" ? [] : [id]);
					expect((await readdir(root)).filter((name) => name !== "state")).toEqual([]);
					const written = await readdir(state).catch(() => [] as string[]);
					expect(written.filter((name) => /\.(json|settling|done|tmp)$/.test(name))).toEqual([]);
				},
			);

			it("on a server without release, the hold is left to its sweep: never aborted, which counts as a breaker failure", async () => {
				capabilities = [];
				await startServer(granting("a.b"));
				const pre = await run("pre-tool-use.mjs", preInput("tu_1"), {
					...env,
					UT_CC_MODE: "enforce",
				});
				expect(pre.code).toBe(2);
				expect(pre.stderr).toContain("left to the server's pending-hold sweep");
				expect(requests.map((r) => r.path)).toEqual(["/v1/authorize"]);
				expect(await holdStateFiles()).toEqual([]);
			});

			it("watch mode: the call goes through unmetered, as a gap", async () => {
				capabilities = ["release"];
				await startServer(granting("a.b"));
				const pre = await run("pre-tool-use.mjs", preInput("tu_1"), env);
				expect(pre.code).toBe(0);
				expect(pre.stdout).toBe("");
				expect((await gaps())[0]?.reason).toContain("its transferId is not a valid id");
				expect(releasedIds()).toEqual(["a.b"]);
				expect(await holdStateFiles()).toEqual([]);
			});

			it("control: a 128-character id is valid, and names its hold's file as it is", async () => {
				const id = `tx_${"x".repeat(125)}`;
				await startServer(granting(id));
				await run("pre-tool-use.mjs", preInput("tu_1"), env);
				expect(await holdStateFiles()).toEqual([holdFile("tu_1", id)]);
			});

			it("PostToolUse: a fresh hold with an invalid id is given back and never recorded; the call's estimate goes unrecorded", async () => {
				capabilities = ["release"];
				let granted = 0;
				await startServer((path) => {
					if (path === "/v1/authorize") {
						granted += 1;
						const transferId = granted === 1 ? "tx_1" : "a.b";
						return { status: 200, json: { transferId, estimatedCost: 1 } };
					}
					// tx_1 expired before its settle: the fresh hold the 404 brings is "a.b".
					if (path === "/v1/settle") return notFound;
					return { status: 200, json: { released: true } };
				});
				await run("pre-tool-use.mjs", preInput("tu_1"), env);
				const post = await run("post-tool-use.mjs", postInput("tu_1"), env);
				expect(post.code).toBe(0);
				expect(post.stderr).toContain("its fresh hold's transferId is not a valid id");
				expect(post.stderr).toContain("this call's estimate is not recorded");
				expect(releasedIds()).toEqual(["a.b"]);
				expect(await holdStateFiles()).toEqual([]);
			});

			it("a name too long for the filesystem (ENAMETOOLONG): the hold is given back, and enforce fails closed", async () => {
				capabilities = ["release"];
				const server = holdingServer();
				await startServer(server.responder);
				const pre = await run("pre-tool-use.mjs", preInput("t".repeat(300)), {
					...env,
					UT_CC_MODE: "enforce",
				});
				expect(pre.code).toBe(2);
				expect(pre.stderr).toContain("authorization failed closed");
				expect(pre.stderr).toContain("ENAMETOOLONG");
				expect(aboutTx1().map((r) => r.path)).toEqual(["/v1/release"]);
				expect(await holdStateFiles()).toEqual([]);
			});
		});
	});

	describe("a release the server does not confirm: no fresh hold beside a hold that may be live", () => {
		const env = { UT_CC_USAGE: "estimate" };

		it.each<[string, { status: number; json: unknown }, Record<string, string>]>([
			[
				"a 503, enforce",
				{ status: 503, json: { error: "unavailable" } },
				{ UT_CC_MODE: "enforce" },
			],
			[
				"no answer (the connection drops), enforce",
				{ status: 0, json: null },
				{ UT_CC_MODE: "enforce" },
			],
			[
				"a 503, enforce with UT_FAIL_OPEN=1",
				{ status: 503, json: { error: "unavailable" } },
				{ UT_CC_MODE: "enforce", UT_FAIL_OPEN: "1" },
			],
			["a 503, watch", { status: 503, json: { error: "unavailable" } }, {}],
			[
				"a 404 for an unknown ROUTE (an older server, or a proxy), enforce",
				{ status: 404, json: { error: "not_found", reason: "unknown route" } },
				{ UT_CC_MODE: "enforce" },
			],
		])(
			"%s: nothing is reserved, and the hold is kept for Stop to give back",
			async (_, answer, mode) => {
				capabilities = ["release"];
				const server = holdingServer();
				let refusing = true;
				await startServer((path, body) =>
					refusing && path === "/v1/release" && body.transferId === "tx_1"
						? answer
						: server.responder(path, body),
				);
				await run("pre-tool-use.mjs", preInput("tu_1"), env);
				const again = await run("pre-tool-use.mjs", preInput("tu_1"), { ...env, ...mode });
				expect(again.stderr).toContain("the hold may be live");
				if (mode.UT_CC_MODE === "enforce" && mode.UT_FAIL_OPEN !== "1") {
					// It fails as a failed authorization does: an outage, not a known state.
					expect(again.code).toBe(2);
					expect(again.stderr).toContain("authorization failed closed");
				} else {
					expect(again.code).toBe(0);
					expect(again.stdout).toBe("");
				}
				expect(again.stderr).not.toContain("is ended");
				expect(authorizes()).toHaveLength(1);
				expect(await holdStateFiles()).toEqual([SETTLING]);
				// Stop gives it back.
				refusing = false;
				await run("stop.mjs", stopInput(), env);
				expect(aboutTx1().map((r) => r.path)).toEqual(["/v1/release", "/v1/release"]);
				expect(await holdStateFiles()).toEqual([]);
			},
		);

		it.each<[string, { status: number; json: unknown } | null, boolean]>([
			["its release a 503", { status: 503, json: { error: "unavailable" } }, false],
			["its release confirmed", null, true],
		])(
			"transcript: the first window's settle fails (500) and %s: the resume reserves afresh only once the server confirms the hold is gone",
			async (_, release, reserves) => {
				capabilities = ["release"];
				const server = holdingServer();
				await startServer((path, body) => {
					if (body.transferId === "tx_1" && path === "/v1/settle") {
						return { status: 500, json: { error: "ledger unavailable" } };
					}
					if (body.transferId === "tx_1" && path === "/v1/release" && release !== null) {
						return release;
					}
					return server.responder(path, body);
				});
				await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
				await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
				const again = await run("pre-tool-use.mjs", preInput("tu_1"), { UT_CC_MODE: "enforce" });
				if (reserves) {
					expect(again.stdout).toBe("");
					expect(again.stderr).toContain("reserved tx_2");
					expect(authorizes()).toHaveLength(2);
				} else {
					// It fails as a failed authorization does: no fresh hold beside a hold that
					// may be live.
					expect(again.code).toBe(2);
					expect(again.stderr).toContain("the server has not confirmed it is gone");
					expect(authorizes()).toHaveLength(1);
				}
				// Either way the window's outcome is journalled once. Unkeyed, it is `claimed`:
				// its ids are accounted, never posted again.
				expect((await readCursor()).accounted).toEqual(["msg_a"]);
				expect(server.charges).toEqual([]);
			},
		);

		it("a 404 `unknown transferId` to the release: the server holds it no more, so the call reserves afresh", async () => {
			capabilities = ["release"];
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			server.expire("tx_1");
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), {
				...env,
				UT_CC_MODE: "enforce",
			});
			expect(again.stdout).toBe("");
			expect(again.stderr).toContain("reserved tx_2");
			expect(aboutTx1().map((r) => [r.path, r.status])).toEqual([["/v1/release", 404]]);
			expect(await holdStateFiles()).toEqual([holdFile("tu_1", "tx_2")]);
		});
	});

	describe("end to end: the real hooks against a REAL usertrust-server", () => {
		const KEY = "ut_plugin_resume_key";
		const env = { UT_CC_USAGE: "estimate" };

		it("a re-fire RELEASES the first hold and reserves afresh; the real server settles the fresh hold once", async () => {
			real = createUsertrustServer({
				config: {
					host: "127.0.0.1",
					port: 0,
					stateDir: await mkdtemp(join(tmpdir(), "utcc-tx-srv-")),
					enforcement: "enforce",
					pendingTtlMs: 300_000,
					dryRun: true,
					tenants: [{ id: "t", keyHash: hashKey(KEY), budget: 10_000_000 }],
				},
			});
			const { port: realPort } = await real.listen();
			await startServer({ forwardTo: `http://127.0.0.1:${realPort}`, key: KEY });
			await run("pre-tool-use.mjs", preInput("tu_1"), env);
			// The server states the hold's life (#239), and the plugin does not keep it: it
			// never reuses a hold, so it has no use for one.
			expect(authorizes()[0]?.response).toHaveProperty("expiresInMs");
			expect(Object.hasOwn(await record(), "expiresInMs")).toBe(false);
			const again = await run("pre-tool-use.mjs", preInput("tu_1"), env);
			expect(again.stderr).toContain("earlier hold");
			expect(authorizes()).toHaveLength(2);
			// The real server publishes `release` (#238): the first hold is given back through
			// it, answered 200, before the fresh one is asked for, and nothing is aborted.
			expect(releases().map((r) => [r.body.transferId, r.status])).toEqual([
				[transferOf(authorizes()[0]), 200],
			]);
			expect(requests.map((r) => r.path)).toEqual([
				"/v1/authorize",
				"/v1/release",
				"/v1/authorize",
			]);
			expect(aborts()).toEqual([]);
			expect((await run("post-tool-use.mjs", postInput("tu_1"), env)).code).toBe(0);
			expect(settles().map((s) => [s.body.transferId, s.status])).toEqual([
				[transferOf(authorizes()[1]), 200],
			]);
		});
	});

	describe("a record that names another call is no hold of this one (state-file names can collide)", () => {
		const env = { UT_CC_USAGE: "estimate" };
		// Agent `a__b` with tool `c`, and agent `a` with tool `b__c`: one call name, so
		// each file differs only by its transfer, and only the stored ids tell the calls
		// apart.
		const first = () => preInput("c", { agent_id: "a__b" });
		const second = () => preInput("b__c", { agent_id: "a" });
		const SHARED = `${SESSION}__a__b__c.tx_1`;

		it("control: the first call itself, fired again, ends its hold and reserves afresh", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", first(), env);
			const again = await run("pre-tool-use.mjs", first(), env);
			expect(again.stderr).toContain("this tool call's earlier hold tx_1 is ended");
			expect(authorizes()).toHaveLength(2);
		});

		it("pending: the other call reserves its own hold, and never ends the first's", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", first(), env);
			expect(await holdStateFiles()).toEqual([`${SHARED}.json`]);
			const again = await run("pre-tool-use.mjs", second(), env);
			expect(again.stderr).not.toContain("tx_1");
			expect(again.stderr).toContain("reserved tx_2");
			expect(authorizes()).toHaveLength(2);
		});

		it(".settling: the other call reserves its own hold, and is never told the first's is being settled", async () => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", first(), env);
			await rename(join(stateDir, `${SHARED}.json`), join(stateDir, `${SHARED}.settling`));
			const again = await run("pre-tool-use.mjs", second(), env);
			expect(again.stderr).not.toContain("tx_1");
			expect(again.stderr).toContain("reserved tx_2");
			expect(authorizes()).toHaveLength(2);
		});

		// Each half of the identity, on its own. The TOOL id: one agent, tool ids that
		// sanitize alike (`x.y` and `x_y`). The AGENT: one tool id, and two sessions
		// whose names collide with the agents' (`s` with agent `x__y`, and `s__x` with
		// agent `y`): one call name, and only the stored agent tells them apart.
		const sameAgent = (tool: string) => preInput(tool);
		const crossSession = (session: string, agent: string) =>
			preInput("tu_9", { session_id: session, agent_id: agent });
		const toolShared = `${SESSION}__main__x_y.tx_1`;
		const agentShared = "s__x__y__tu_9.tx_1";

		it.each<[string, boolean]>([
			["pending", false],
			[".settling", true],
		])("the tool id alone (%s): `x_y` is no hold of `x.y`", async (_, settling) => {
			const server = holdingServer();
			await startServer(server.responder);
			await run("pre-tool-use.mjs", sameAgent("x.y"), env);
			if (settling) {
				await rename(
					join(stateDir, `${toolShared}.json`),
					join(stateDir, `${toolShared}.settling`),
				);
			}
			const again = await run("pre-tool-use.mjs", sameAgent("x_y"), env);
			expect(again.stderr).not.toContain("tx_1");
			expect(again.stderr).toContain("reserved tx_2");
			expect(authorizes()).toHaveLength(2);
		});

		it.each<[string, boolean]>([
			["pending", false],
			[".settling", true],
		])(
			"the agent alone (%s): agent `y` of session `s__x` has no hold of agent `x__y` of session `s`",
			async (_, settling) => {
				const server = holdingServer();
				await startServer(server.responder);
				await run("pre-tool-use.mjs", crossSession("s", "x__y"), env);
				expect(await holdStateFiles()).toEqual([`${agentShared}.json`]);
				if (settling) {
					await rename(
						join(stateDir, `${agentShared}.json`),
						join(stateDir, `${agentShared}.settling`),
					);
				}
				const again = await run("pre-tool-use.mjs", crossSession("s__x", "y"), env);
				expect(again.stderr).not.toContain("tx_1");
				expect(again.stderr).toContain("reserved tx_2");
				expect(authorizes()).toHaveLength(2);
			},
		);
	});
});

describe("a hook after the server or key changed never ends a hold through the new one", () => {
	// Each hook is its own process and reads its settings afresh, so the server or key
	// can change between the hook that made a hold and the one that ends it: an edited
	// config file, or environment. Settled, released or retried through the new one, a
	// hold it never made answers 404, the estimate path then charges the call to it on
	// a fresh hold, and an unresolved settle retried under its key there could charge
	// what the old server already did. So such a hold is dropped, nothing about it is
	// sent, and its usage goes unrecorded: an under-count of the old tenant. A record
	// with no binding (from before the plugin kept one) is ended as it always was.
	const estimate = { UT_CC_USAGE: "estimate" };
	const otherKey = { UT_SERVER_KEY: "k2" };
	const aboutTx1 = () => requests.filter((r) => r.body.transferId === "tx_1");
	const notedOther = (stderr: string, what: string) =>
		expect(stderr).toContain(`${what} tx_1 was made under another server or key`);
	/** The watch records written so far. */
	const watched = async () =>
		(await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => ""))
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	/** The one gap a dropped hold leaves: its usage goes unrecorded. */
	const ABANDONED = [
		{
			kind: "gap",
			phase: "abandon",
			transferId: "tx_1",
			reason: "the hold was made under another server or key",
		},
	];

	it("PostToolUse, estimate: the hold is dropped, and nothing about it is sent", async () => {
		await startServer(okResponder);
		await run("pre-tool-use.mjs", preInput("tu_1"), estimate);
		const post = await run("post-tool-use.mjs", postInput("tu_1"), { ...estimate, ...otherKey });
		notedOther(post.stderr, "this tool call's hold");
		expect(settles()).toEqual([]);
		expect(authorizes()).toHaveLength(1);
		expect(await holdStateFiles()).toEqual([]);
		expect(await watched()).toMatchObject(ABANDONED);
	});

	it("control: PostToolUse under the same key settles the hold", async () => {
		await startServer(okResponder);
		await run("pre-tool-use.mjs", preInput("tu_1"), estimate);
		await run("post-tool-use.mjs", postInput("tu_1"), estimate);
		expect(settles().map((r) => r.body.transferId)).toEqual(["tx_1"]);
	});

	it("PostToolUse, transcript: the window is never settled through the new key, and goes unrecorded", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		const post = await run("post-tool-use.mjs", postInput("tu_1"), otherKey);
		notedOther(post.stderr, "this tool call's hold");
		await run("stop.mjs", stopInput(), otherKey);
		expect(aboutTx1()).toEqual([]);
		expect(settles()).toEqual([]);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
		expect(await holdStateFiles()).toEqual([]);
	});

	it("Stop: a leftover hold with a window is dropped, nothing sent, its usage unrecorded", async () => {
		await startServer(okResponder);
		await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		const stop = await run("stop.mjs", stopInput(), otherKey);
		notedOther(stop.stderr, "leftover hold");
		expect(aboutTx1()).toEqual([]);
		expect(settles()).toEqual([]);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
		expect(await holdStateFiles()).toEqual([]);
		expect(await watched()).toMatchObject(ABANDONED);
	});

	it("Stop: an empty leftover hold is forgotten without a release, which the same key gets (control)", async () => {
		capabilities = ["release"];
		await startServer(okResponder);
		await run("pre-tool-use.mjs", preInput("tu_1"), estimate);
		const stop = await run("stop.mjs", stopInput(), { ...estimate, ...otherKey });
		notedOther(stop.stderr, "leftover hold");
		expect(aboutTx1()).toEqual([]);
		expect(await holdStateFiles()).toEqual([]);
		expect(await watched()).toMatchObject(ABANDONED);
		await run("pre-tool-use.mjs", preInput("tu_2"), estimate);
		await run("stop.mjs", stopInput(), estimate);
		expect(requests.filter((r) => r.path === "/v1/release").map((r) => r.body.transferId)).toEqual([
			"tx_2",
		]);
	});

	it("Stop: an estimate hold left `.settling` (its settle unanswered) is forgotten without a release", async () => {
		capabilities = ["release"];
		const lostSettle: Responder = (path, body) =>
			path === "/v1/settle" && body.transferId === "tx_1"
				? { status: 0, json: null }
				: okResponder(path, body);
		await startServer(lostSettle);
		await run("pre-tool-use.mjs", preInput("tu_1"), estimate);
		await run("post-tool-use.mjs", postInput("tu_1"), estimate);
		expect(await holdStateFiles()).toEqual([holdFile("tu_1", "tx_1", "settling")]);
		const stop = await run("stop.mjs", stopInput(), { ...estimate, ...otherKey });
		notedOther(stop.stderr, "leftover hold");
		expect(requests.filter((r) => r.path !== "/v1/settle" && r.body.transferId === "tx_1")).toEqual(
			[],
		);
		expect(await holdStateFiles()).toEqual([]);
	});

	it("a record without a binding (from before the plugin kept one) is still given back at Stop, as before", async () => {
		capabilities = ["release"];
		await startServer(okResponder);
		await run("pre-tool-use.mjs", preInput("tu_1"), estimate);
		const path = join(stateDir, holdFile("tu_1", "tx_1"));
		const {
			serverUrl: _url,
			keyHash: _hash,
			...legacy
		} = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
		await writeFile(path, JSON.stringify(legacy));
		const stop = await run("stop.mjs", stopInput(), { ...estimate, ...otherKey });
		expect(stop.stderr).not.toContain("another server or key");
		expect(requests.filter((r) => r.path === "/v1/release").map((r) => r.body.transferId)).toEqual([
			"tx_1",
		]);
	});

	it("an UNRESOLVED settle parked under the old key is never retried under the new one", async () => {
		capabilities = ["idempotency-key", "release"];
		const failingSettle: Responder = (path, body) =>
			path === "/v1/settle"
				? { status: 503, json: { error: "unavailable" } }
				: okResponder(path, body);
		await startServer(failingSettle);
		await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		const key = authorizes()[0]?.body.idempotencyKey;
		expect(typeof key).toBe("string");
		await run("post-tool-use.mjs", postInput("tu_1"));
		// Parked as an unresolved vehicle, with the server and key it was authorized under.
		const parked = JSON.parse(await readFile(cursorPath(), "utf-8")) as {
			unresolved: Record<string, { keyHash?: string }>;
		};
		expect(parked.unresolved[key as string]?.keyHash).toBe(
			createHash("sha256").update("k").digest("hex").slice(0, 16),
		);
		const stop = await run("stop.mjs", stopInput(), otherKey);
		expect(stop.stderr).toContain("made under another server or key is not retried here");
		expect(authorizes().filter((r) => r.body.idempotencyKey === key)).toHaveLength(1);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});

	it("a REMAINDER group parked under the old key is never retried under the new one", async () => {
		capabilities = ["idempotency-key", "release"];
		const failingSettle: Responder = (path, body) =>
			path === "/v1/settle"
				? { status: 503, json: { error: "unavailable" } }
				: okResponder(path, body);
		await startServer(failingSettle);
		await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
		// No hold carried msg_a: Stop posts it as a remainder group, parked under its key
		// before the authorize, and its settle fails, so it stays parked.
		await run("stop.mjs", stopInput());
		const key = authorizes()[0]?.body.idempotencyKey;
		expect(typeof key).toBe("string");
		const parked = JSON.parse(await readFile(cursorPath(), "utf-8")) as {
			unresolved: Record<string, { keyHash?: string }>;
		};
		expect(parked.unresolved[key as string]?.keyHash).toBe(
			createHash("sha256").update("k").digest("hex").slice(0, 16),
		);
		const stop = await run("stop.mjs", stopInput(), otherKey);
		expect(stop.stderr).toContain("made under another server or key is not retried here");
		expect(authorizes().filter((r) => r.body.idempotencyKey === key)).toHaveLength(1);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});

	it("control: the same key retries the unresolved settle at Stop", async () => {
		capabilities = ["idempotency-key", "release"];
		let failSettle = true;
		const recovering: Responder = (path, body) => {
			if (path === "/v1/settle" && failSettle) {
				failSettle = false;
				return { status: 503, json: { error: "unavailable" } };
			}
			return okResponder(path, body);
		};
		await startServer(recovering);
		await writeMain(responseEntries("msg_a", SONNET, u(9, 9)));
		await run("pre-tool-use.mjs", preInput("tu_1"));
		const key = authorizes()[0]?.body.idempotencyKey;
		await run("post-tool-use.mjs", postInput("tu_1"));
		await run("stop.mjs", stopInput());
		expect(authorizes().filter((r) => r.body.idempotencyKey === key)).toHaveLength(2);
		expect((await readCursor()).accounted).toEqual(["msg_a"]);
	});
});
