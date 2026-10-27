// Every ordering of the events around a hold made while a subagent's transcript was not written
// yet (transcript.mjs `resolveAwaitingHold`), for one kind of agent, against one invariant.
//
// THE RESPONSE. One API response (msg_r, 1200 input tokens) of the agent makes TWO parallel
// calls, tu_1 and tu_2. Claude Code writes such a response as ONE transcript entry per content
// block, all under msg_r's id, and only the LAST entry carries the `stop_reason`, so the message
// is complete only once its last block lands:
//  - B1  the entry holding tu_1's `tool_use` block (stop_reason null);
//  - B2  the entry holding tu_2's `tool_use` block (stop_reason "tool_use").
// Measured, not assumed: every local subagent response with two or more calls (3722 of them)
// had that shape, the last entry alone carrying the stop_reason.
//
// THE HOOKS. Each call's PreToolUse and PostToolUse is its own event: Pre1, Post1, Pre2, Post2.
// The order they run in was measured from the transcripts' own `hook_success` records (one per
// hook run, naming its hookEvent and toolUseID, written as the hook ends), against the block
// entries, over 124 two-call responses that logged all four hooks:
//    94  B1 Pre1 Post1 B2 Pre2 Post2   (a call runs as soon as its block is written)
//    26  B1 B2 Pre1 Post1 Pre2 Post2
//     4  B1 B2 Pre2 Post2 Pre1 Post1   (the second call's hooks ran first)
// So a call's Post can come before the other call's block, and either call's hooks can come
// first. What the measurement cannot show is the case under test: a hook that runs before the
// transcript is written at all (W), which is what makes a hold an awaiting one. A write that lags
// a hook can lag every later one too, so the only constraints kept are the ones no lag can break:
//  - W before B1 before B2 (the file is written in order);
//  - Pre1 before Post1, Pre2 before Post2 (a call's hooks run in order);
//  - at least one call's Pre before W (an awaiting hold; with none, nothing here is under test).
// That is 120 orders of the seven events.
//
// THE SIBLING (S, for a fork or an agent whose type nothing states only: a named agent inherits
// no one's estimate mode, transcript.mjs `inheritedEstimate`). Another agent of the session sticks
// at the estimate: its marker is written. Only a hook reads it, so where it lands between two
// hooks makes no difference, and each run places it at one point: before the second, third or
// fourth hook, or after them all (before the ends), or nowhere (`SiblingAt`). Never before the
// first: the first hook is a Pre ahead of W, which would then inherit the estimate at once, so no
// hold would await.
//
// THE ENDS. Then one of two:
//  - "own": the agent's SubagentStop arrives and reads, then the session-wide Stop, then
//    SessionEnd;
//  - "lost": the SubagentStop never arrives, so the session-wide Stop (the parent's input: no
//    hint of the agent's type) and SessionEnd are its settle points.
//
// THE INVARIANT, per call, because an estimate is per call (post-tool-use.mjs
// `settleAtEstimate` prices the call's own tool input and output, never its response's tokens)
// while a post of msg_r charges the whole response, so it covers both calls:
//  - msg_r is posted at most once, and never besides an estimate of either of its calls;
//  - each call is settled at its estimate at most once;
//  - a call is covered by the post, or by its own estimate, or else exactly one gap names its
//    hold. Never uncovered with no gap.
// Asserted after the events for every awaiting call (its ruling relies on no later read), and
// after EACH end hook for both calls. The double-charge half is asserted at every one of those
// points for both. No transferId is ever settled twice.
//
// ONE EXEMPTION, from the coverage half only: the late-inheritance hole (`lateInheritanceHole`).
// When a fork or an untyped agent inherits a sibling's estimate mode, a hold it made from its
// transcript BEFORE the sibling's marker was written can be left uncharged with no gap: the switch
// drops it. That is outside this rule and fixed separately; the same orders fail on the hooks
// before this rule, at the same count, with no awaiting hold at all. Only such a call is exempt,
// never an awaiting or an estimate hold, and never from the double-charge half. Each sibling shard
// pins how many orders the exemption was used in, so a change in that count fails it.
//
// Every transcript here is SYNTHETIC, in the measured shape (transcript.mjs, "WHAT THE
// TRANSCRIPT HOLDS"). No real transcript content is used.

import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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

type Call = "tu_1" | "tu_2";
type Hook = "Pre1" | "Post1" | "Pre2" | "Post2";
type Event = "W" | "B1" | "B2" | Hook | "S";
const BASE: Event[] = ["W", "B1", "B2", "Pre1", "Post1", "Pre2", "Post2"];
const HOOK_EVENTS = new Set<Event>(["Pre1", "Post1", "Pre2", "Post2"]);

/** Where the sibling's marker lands: before the n-th hook, after every event, or nowhere. */
export type SiblingAt = "none" | 2 | 3 | 4 | "end";

function permutations<T>(items: T[]): T[][] {
	if (items.length <= 1) return [items];
	return items.flatMap((item, i) =>
		permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
	);
}

const before = (order: Event[], a: Event, b: Event) => order.indexOf(a) < order.indexOf(b);

/** Every order of the seven events the constraints allow (the header). */
export const ORDERS: Event[][] = permutations(BASE).filter(
	(o) =>
		before(o, "W", "B1") &&
		before(o, "B1", "B2") &&
		before(o, "Pre1", "Post1") &&
		before(o, "Pre2", "Post2") &&
		(before(o, "Pre1", "W") || before(o, "Pre2", "W")),
);

/** `order` with the sibling's marker placed at `at`. */
export function withSibling(order: Event[], at: SiblingAt): Event[] {
	if (at === "none") return order;
	if (at === "end") return [...order, "S"];
	let seen = 0;
	const i = order.findIndex((e) => HOOK_EVENTS.has(e) && ++seen === at);
	return [...order.slice(0, i), "S", ...order.slice(i)];
}

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

/** msg_r's entry for one call's block: the last one (B2) carries the stop_reason. */
function blockEntry(call: Call, last: boolean): string {
	return JSON.stringify({
		type: "assistant",
		sessionId: SESSION,
		uuid: `msg_r-${call}`,
		...sidechain,
		message: {
			id: "msg_r",
			model: SONNET,
			role: "assistant",
			type: "message",
			stop_reason: last ? "tool_use" : null,
			content: [{ type: "tool_use", id: call, name: "Bash", input: { command: "ls" } }],
			usage: {
				input_tokens: RESPONSE_INPUT,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: last ? 300 : 150,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
				service_tier: "standard",
			},
		},
	});
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

interface Hold {
	tx: string;
	awaiting: boolean;
	/** The hold was made from the transcript (its pending record's `usage`). */
	transcript: boolean;
	/** Its PreToolUse's place in the order. */
	at: number;
}

/**
 * The late-inheritance hole (the header's exemption): a hold made from the transcript before the
 * sibling's marker, which sits at `marker` in the order (-1: no marker).
 */
function lateInheritanceHole(hold: Hold, marker: number): boolean {
	return marker >= 0 && hold.transcript && hold.at < marker;
}

/**
 * The invariant (the header) on the calls whose holds exist. `covered` names the calls that must
 * be charged by now, or carry their gap. A call left uncovered by the late-inheritance hole is
 * added to `exempted` instead of failing.
 */
async function assertPerCall(
	holds: Map<Call, Hold>,
	covered: Call[],
	at: string,
	marker: number,
	exempted: Set<Call>,
) {
	const posted = settles().filter(
		(s) => s.body.usageSource === "provider" && Number(s.body.inputTokens) >= RESPONSE_INPUT,
	).length;
	const gaps = (await watchRecords()).filter((r) => r.kind === "gap");
	const seen: Record<string, unknown> = { posted };
	for (const [call, { tx, awaiting }] of holds) {
		// A transcript hold that posts msg_r settles under its own transferId too: that is the post.
		const estimated = settles().filter(
			(s) => s.body.transferId === tx && s.body.usageSource === "estimated",
		);
		seen[call] = {
			awaiting,
			estimated: estimated.length,
			gaps: gaps.filter((g) => g.transferId === tx).length,
		};
	}
	const say = `after ${at}: ${JSON.stringify(seen)}`;
	expect(posted, say).toBeLessThanOrEqual(1);
	for (const call of holds.keys()) {
		const { estimated, gaps: named } = seen[call] as { estimated: number; gaps: number };
		expect(estimated, `${say}: ${call} settled at its estimate twice`).toBeLessThanOrEqual(1);
		if (posted === 1) expect(estimated, `${say}: ${call} estimated AND posted`).toBe(0);
		if (covered.includes(call) && posted === 0 && estimated === 0) {
			const hold = holds.get(call) as Hold;
			if (named === 0 && lateInheritanceHole(hold, marker)) exempted.add(call);
			else expect(named, `${say}: ${call} uncharged`).toBe(1);
		}
	}
	const ids = settles().map((s) => String(s.body.transferId));
	expect(ids.length, `a transferId was settled twice: ${ids.join(", ")}`).toBe(new Set(ids).size);
}

const endLabel = {
	own: "SubagentStop, Stop, SessionEnd",
	lost: "Stop, SessionEnd (no SubagentStop)",
};

/**
 * The orders for one kind of agent and one place of the sibling's marker. `lateInheritance` pins
 * how many orders the late-inheritance exemption was used in (the header).
 */
export function defineAwaitingOrders(
	kind: AgentKind,
	sibling: SiblingAt = "none",
	lateInheritance = 0,
) {
	const { meta, hook } = KINDS[kind];
	const own = { agent_id: AGENT, ...(hook === undefined ? {} : { agent_type: hook }) };
	const call = (toolUseId: Call) => ({
		...parentInput(),
		...own,
		tool_name: "Bash",
		tool_use_id: toolUseId,
		tool_input: { command: "ls" },
	});
	const done = (toolUseId: Call) => ({
		...parentInput(),
		...own,
		tool_use_id: toolUseId,
		tool_response: "eight ch",
	});

	async function step(event: Event, index: number, holds: Map<Call, Hold>) {
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
			case "B1":
			case "B2":
				await appendFile(
					subagentFile(),
					`${blockEntry(event === "B1" ? "tu_1" : "tu_2", event === "B2")}\n`,
				);
				return;
			case "S":
				await mkdir(join(stateDir, "transcripts", "estimate"), { recursive: true });
				await writeFile(
					join(stateDir, "transcripts", "estimate", `${SESSION}__a0`),
					"transcript unreadable (ENOENT)",
				);
				return;
			case "Pre1":
			case "Pre2": {
				const id: Call = event === "Pre1" ? "tu_1" : "tu_2";
				const from = requests.length;
				const pre = await run("pre-tool-use.mjs", call(id));
				const hold = requests.slice(from).find((r) => r.path === "/v1/authorize")?.response as
					| { transferId: string }
					| undefined;
				expect(hold?.transferId, `${id}'s PreToolUse made no hold`).toBeDefined();
				const tx = hold?.transferId ?? "";
				const record = (await readdir(stateDir)).find((f) => f.endsWith(`.${tx}.json`));
				expect(record, `${id}'s hold was not recorded`).toBeDefined();
				const pending = JSON.parse(await readFile(join(stateDir, record ?? ""), "utf-8")) as {
					usage?: string;
				};
				holds.set(id, {
					tx,
					awaiting: pre.stderr.includes("not written yet"),
					transcript: pending.usage === "transcript",
					at: index,
				});
				return;
			}
			case "Post1":
			case "Post2":
				await run("post-tool-use.mjs", done(event === "Post1" ? "tu_1" : "tu_2"));
				return;
		}
	}

	const label =
		sibling === "none"
			? ""
			: `, the sibling's marker ${sibling === "end" ? "last" : `before hook ${sibling}`}`;
	describe(`every order around an awaiting hold, for a ${kind} subagent${label}`, () => {
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

		it("covers 120 orders", () => {
			expect(ORDERS).toHaveLength(120);
			expect(new Set(ORDERS.map((o) => o.join(" "))).size).toBe(120);
		});

		let exemptOrders = 0;
		for (const base of ORDERS) {
			const order = withSibling(base, sibling);
			const marker = order.indexOf("S");
			for (const end of ["own", "lost"] as const) {
				it(`${order.join(" ")} then ${endLabel[end]}`, async () => {
					const holds = new Map<Call, Hold>();
					const exempted = new Set<Call>();
					for (const [index, event] of order.entries()) await step(event, index, holds);
					const awaiting = [...holds].filter(([, h]) => h.awaiting).map(([c]) => c);
					expect(awaiting.length, "no hold was an awaiting one").toBeGreaterThan(0);
					const both: Call[] = ["tu_1", "tu_2"];
					const check = (covered: Call[], at: string) =>
						assertPerCall(holds, covered, at, marker, exempted);
					await check(awaiting, "the events");
					if (end === "own") {
						await run("subagent-stop.mjs", { ...parentInput(), ...own });
						await check(both, "SubagentStop");
					}
					await run("stop.mjs", parentInput());
					await check(both, "the session-wide Stop");
					await run("session-end.mjs", {
						...parentInput(),
						hook_event_name: "SessionEnd",
						reason: "other",
					});
					await check(both, "SessionEnd");
					if (exempted.size > 0) exemptOrders += 1;
				});
			}
		}

		if (sibling !== "none") {
			it(`uses the late-inheritance exemption in exactly ${lateInheritance} of ${ORDERS.length * 2} runs (each order, with each end)`, () => {
				expect(exemptOrders).toBe(lateInheritance);
			});
		}
	});
}
