// Every ordering of the events around a hold made while a subagent's transcript was not written
// yet (transcript.mjs `resolveAwaitingHold`), for one kind of agent, against one invariant.
//
// The call is tu_1. Its PreToolUse runs first, before the transcript exists, so its hold is an
// awaiting one. Its response is ONE message (msg_r, 1200 input tokens) whose entries hold tu_1's
// `tool_use` block. Then, in every order:
//  - W   the transcript is written, holding the agent's prompt only;
//  - L   the response is appended to it;
//  - P2  a parallel call of the agent, tu_2: its PreToolUse and its PostToolUse (a read);
//  - S   a sibling sticks at the estimate (its marker), then a call of the agent, tu_3: its
//        PreToolUse and PostToolUse (the read, or the inheritance, that follows it);
//  - P1  tu_1's PostToolUse, the ruling.
// The one constraint: W before L (the response is appended to a written transcript). So
// 5!/2 = 60 orders. Then one of two ends:
//  - "own": the agent's SubagentStop arrives and reads, then the session-wide Stop, then
//    SessionEnd;
//  - "lost": the SubagentStop never arrives, so the session-wide Stop (the parent's input: no
//    hint of the agent's type) and SessionEnd are its settle points.
// 60 orders x 2 ends = 120 scenarios per kind of agent.
//
// THE INVARIANT, asserted after P1 and after EACH end hook: tu_1's response is charged exactly
// once (posted from the transcript, or tu_1's hold settled at the estimate, never both), or it is
// charged nothing and exactly one gap names tu_1's hold. Never nothing with no gap, never twice.
// And no transferId is ever settled twice.
//
// Every transcript here is SYNTHETIC, in the measured shape (transcript.mjs, "WHAT THE
// TRANSCRIPT HOLDS"). No real transcript content is used.

import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "..", "hooks");
const SESSION = "11111111-2222-4333-8444-555555555555";
const SONNET = "claude-sonnet-4-6";
const AGENT = "s1";
/** The response's input tokens: what marks a settle that posts it. */
const RESPONSE_INPUT = 1200;

export type AgentKind = "named-meta" | "named-hint" | "fork" | "untyped";

/** What states the agent's type: its meta file's `agentType`, and its own hooks' `agent_type`. */
const KINDS: Record<AgentKind, { meta: string | null; hook: string | undefined }> = {
	"named-meta": { meta: "general-purpose", hook: "general-purpose" },
	"named-hint": { meta: null, hook: "general-purpose" },
	fork: { meta: "fork", hook: "fork" },
	untyped: { meta: null, hook: undefined },
};

type Event = "W" | "L" | "P2" | "S" | "P1";
const EVENTS: Event[] = ["W", "L", "P2", "S", "P1"];

function permutations<T>(items: T[]): T[][] {
	if (items.length <= 1) return [items];
	return items.flatMap((item, i) =>
		permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
	);
}

/** Every order of the five events with W before L. */
export const ORDERS: Event[][] = permutations(EVENTS).filter(
	(order) => order.indexOf("W") < order.indexOf("L"),
);

interface Recorded {
	path: string;
	body: Record<string, unknown>;
	response: unknown;
}

let stateDir: string;
let projectDir: string;
let mainTranscript: string;
let fake: Server | undefined;
let port: number;
let requests: Recorded[];
let nextTransfer = 0;

function startServer(): Promise<void> {
	return new Promise((resolve) => {
		fake = createServer((req, res) => {
			if (req.method === "GET" && req.url === "/v1/health") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ status: "ok", capabilities: [] }));
				return;
			}
			const log = requests;
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", () => {
				const path = req.url ?? "";
				const body = JSON.parse(raw || "{}") as Record<string, unknown>;
				let json: unknown = { settled: true, aborted: true };
				if (path === "/v1/authorize") {
					nextTransfer += 1;
					json = { transferId: `tx_${nextTransfer}`, estimatedCost: 1 };
				}
				log.push({ path, body, response: json });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(json));
			});
		});
		fake.listen(0, "127.0.0.1", () => {
			const address = fake?.address();
			port = typeof address === "object" && address !== null ? address.port : 0;
			resolve();
		});
	});
}

function run(name: string, input: Record<string, unknown>) {
	return runHook(join(HOOKS, name), input, {
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_URL: `http://127.0.0.1:${port}`,
		UT_SERVER_KEY: "k",
		// SessionEnd's own budget, wide enough that a loaded runner never kills it mid-settle.
		CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "10000",
	});
}

const parentInput = () => ({ session_id: SESSION, transcript_path: mainTranscript });
const subagentFile = () => join(projectDir, SESSION, "subagents", `agent-${AGENT}.jsonl`);
const sidechain = { agentId: AGENT, isSidechain: true };

/** One API response's entries (two partial, one final), all holding `toolUseId`'s tool_use block. */
function responseEntries(id: string, input: number, toolUseId: string): string[] {
	const content = [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "ls" } }];
	const usage = (output: number) => ({
		input_tokens: input,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		output_tokens: output,
		cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
		service_tier: "standard",
	});
	const entry = (suffix: string, stop: string | null, output: number) =>
		JSON.stringify({
			type: "assistant",
			sessionId: SESSION,
			uuid: `${id}-${suffix}`,
			...sidechain,
			message: {
				id,
				model: SONNET,
				role: "assistant",
				type: "message",
				stop_reason: stop,
				content,
				usage: usage(output),
			},
		});
	return [entry("p0", null, 50), entry("p1", null, 150), entry("final", "tool_use", 300)];
}

async function watchRecords(): Promise<Array<Record<string, unknown>>> {
	const text = await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => "");
	return text
		.trim()
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const settles = () => requests.filter((r) => r.path === "/v1/settle");

/** The invariant on tu_1 (its hold `tx`), and that no transferId is settled twice. */
async function assertChargedOnce(tx: string, at: string) {
	const estimated = settles().filter((s) => s.body.transferId === tx);
	const posted = settles().filter(
		(s) => s.body.usageSource === "provider" && Number(s.body.inputTokens) >= RESPONSE_INPUT,
	);
	const charges = estimated.length + posted.length;
	const gaps = (await watchRecords()).filter((r) => r.kind === "gap" && r.transferId === tx);
	const seen = { charges, estimated: estimated.length, posted: posted.length, gaps: gaps.length };
	expect(charges, `after ${at}: ${JSON.stringify(seen)}`).toBeLessThanOrEqual(1);
	if (charges === 0) expect(gaps, `after ${at}: ${JSON.stringify(seen)}`).toHaveLength(1);
	for (const s of estimated) expect(s.body.usageSource).toBe("estimated");
	const ids = settles().map((s) => String(s.body.transferId));
	expect(ids.length, `a transferId was settled twice: ${ids.join(", ")}`).toBe(new Set(ids).size);
}

export function defineAwaitingOrders(kind: AgentKind) {
	const { meta, hook } = KINDS[kind];
	const own = { agent_id: AGENT, ...(hook === undefined ? {} : { agent_type: hook }) };
	const call = (toolUseId: string) => ({
		...parentInput(),
		...own,
		tool_name: "Bash",
		tool_use_id: toolUseId,
		tool_input: { command: "ls" },
	});
	const done = (toolUseId: string) => ({
		...parentInput(),
		...own,
		tool_use_id: toolUseId,
		tool_response: "eight ch",
	});

	async function step(event: Event) {
		switch (event) {
			case "W": {
				const dir = join(projectDir, SESSION, "subagents");
				await mkdir(dir, { recursive: true });
				const prompt = JSON.stringify({
					type: "user",
					sessionId: SESSION,
					...sidechain,
					message: { role: "user", content: "synthetic" },
				});
				await writeFile(subagentFile(), `${prompt}\n`);
				if (meta !== null) {
					await writeFile(
						join(dir, `agent-${AGENT}.meta.json`),
						JSON.stringify({ agentType: meta, description: "synthetic", spawnDepth: 1 }),
					);
				}
				return;
			}
			case "L":
				await appendFile(
					subagentFile(),
					`${responseEntries("msg_r", RESPONSE_INPUT, "tu_1").join("\n")}\n`,
				);
				return;
			case "P2":
				await run("pre-tool-use.mjs", call("tu_2"));
				await run("post-tool-use.mjs", done("tu_2"));
				return;
			case "S":
				await mkdir(join(stateDir, "transcripts", "estimate"), { recursive: true });
				await writeFile(
					join(stateDir, "transcripts", "estimate", `${SESSION}__a0`),
					"transcript unreadable (ENOENT)",
				);
				await run("pre-tool-use.mjs", call("tu_3"));
				await run("post-tool-use.mjs", done("tu_3"));
				return;
			case "P1":
				await run("post-tool-use.mjs", done("tu_1"));
				return;
		}
	}

	describe(`every order around an awaiting hold, for a ${kind} subagent`, () => {
		beforeEach(async () => {
			stateDir = await mkdtemp(join(tmpdir(), "utcc-orders-state-"));
			projectDir = await mkdtemp(join(tmpdir(), "utcc-orders-proj-"));
			mainTranscript = join(projectDir, `${SESSION}.jsonl`);
			requests = [];
			nextTransfer = 0;
			await writeFile(
				mainTranscript,
				`${JSON.stringify({ type: "user", sessionId: SESSION, message: { role: "user", content: "synthetic" } })}\n`,
			);
			await startServer();
		});
		afterEach(() => {
			fake?.closeAllConnections();
			fake?.close();
			fake = undefined;
		});

		it("covers 60 orders", () => {
			expect(ORDERS).toHaveLength(60);
			expect(new Set(ORDERS.map((o) => o.join(" "))).size).toBe(60);
		});

		for (const order of ORDERS) {
			for (const end of ["own", "lost"] as const) {
				it(`${order.join(" ")} then ${end === "own" ? "SubagentStop, Stop, SessionEnd" : "Stop, SessionEnd (no SubagentStop)"}`, async () => {
					const pre = await run("pre-tool-use.mjs", call("tu_1"));
					expect(pre.stderr).toContain("not written yet");
					const hold = requests.find((r) => r.path === "/v1/authorize")?.response as
						| { transferId: string }
						| undefined;
					const tx = hold?.transferId ?? "";
					expect(tx).not.toBe("");
					for (const event of order) await step(event);
					await assertChargedOnce(tx, "tu_1's PostToolUse and the events after it");
					if (end === "own") {
						await run("subagent-stop.mjs", { ...parentInput(), ...own });
						await assertChargedOnce(tx, "SubagentStop");
					}
					await run("stop.mjs", parentInput());
					await assertChargedOnce(tx, "the session-wide Stop");
					await run("session-end.mjs", {
						...parentInput(),
						hook_event_name: "SessionEnd",
						reason: "other",
					});
					await assertChargedOnce(tx, "SessionEnd");
				});
			}
		}
	});
}
