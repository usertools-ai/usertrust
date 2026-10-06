// At most once, under crashes and concurrency.
//
// A clean run of each scenario lists every boundary at which one of its hooks can
// die: before or after each claim (link), each cursor, hold or journal file renamed
// into place, each exclusive create, and each server call. The scenario is then
// run again, once per boundary, with that hook SIGKILLed there
// (tests/helpers/crash-at.mjs). The rest of the session still happens, time passes
// (locks, in-flight settles and unfinished authorizes go stale), and two more
// Stops recover what they can. Whatever the boundary, no message is ever charged
// twice: each message's usage is a distinct power of ten, so the inputTokens the
// server charged add up to a number whose every digit counts one message's
// charges. Under-counting is allowed: at most once, never twice.
//
// Every transcript here is SYNTHETIC, in the measured shape (see transcript.test.ts).
import { spawn } from "node:child_process";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const CRASH_AT = join(import.meta.dirname, "helpers", "crash-at.mjs");
const SESSION = "22222222-3333-4444-8555-666666666666";
const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5";
/** How many crash runs go at once: each has its own state dir, transcript and server. */
const PARALLEL = 8;

interface World {
	stateDir: string;
	projectDir: string;
	main: string;
	port: number;
	/** inputTokens of every charge the server made at real usage. */
	charges: number[];
	/** Charges made at an estimate: none of these scenarios may make one. */
	estimated: number[];
	close: () => Promise<void>;
}

/**
 * A server with usertrust's money semantics: a hold is charged at most once, by
 * its first settle. `keyed`: it also honours idempotency keys (#205's contract) —
 * a key with a live hold gets that hold back, and a key whose charge stands is
 * 409 `already_settled`.
 */
async function startServer(
	keyed: boolean,
): Promise<Omit<World, "stateDir" | "projectDir" | "main">> {
	const holds = new Map<string, { key: string | undefined }>();
	const live = new Map<string, string>();
	const charged = new Set<string>();
	const charges: number[] = [];
	const estimated: number[] = [];
	let next = 0;
	const answer = (path: string, body: Record<string, unknown>) => {
		const key = keyed && typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
		if (path === "/v1/authorize") {
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
		if (hold === undefined) return { status: 404, json: { error: "not_found" } };
		holds.delete(transferId);
		if (hold.key !== undefined) live.delete(hold.key);
		if (path !== "/v1/settle") return { status: 200, json: { released: true } };
		if (hold.key !== undefined && charged.has(hold.key)) {
			return { status: 409, json: { error: "already_settled", reason: "duplicate" } };
		}
		if (hold.key !== undefined) charged.add(hold.key);
		(body.usageSource === "estimated" ? estimated : charges).push(Number(body.inputTokens ?? 0));
		return { status: 200, json: { settled: true, transferId } };
	};
	const server: Server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/v1/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					status: "ok",
					capabilities: keyed ? ["release", "idempotency-key", "principal"] : [],
				}),
			);
			return;
		}
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => {
			const out = answer(req.url ?? "", JSON.parse(raw || "{}") as Record<string, unknown>);
			res.writeHead(out.status, { "content-type": "application/json" });
			res.end(JSON.stringify(out.json));
		});
	});
	const port = await new Promise<number>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve(typeof address === "object" && address !== null ? address.port : 0);
		});
	});
	return {
		port,
		charges,
		estimated,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

async function newWorld(keyed: boolean): Promise<World> {
	const stateDir = await mkdtemp(join(tmpdir(), "utcc-crash-state-"));
	const projectDir = await mkdtemp(join(tmpdir(), "utcc-crash-proj-"));
	return {
		stateDir,
		projectDir,
		main: join(projectDir, `${SESSION}.jsonl`),
		...(await startServer(keyed)),
	};
}

async function dropWorld(world: World) {
	await world.close();
	await rm(world.stateDir, { recursive: true, force: true });
	await rm(world.projectDir, { recursive: true, force: true });
}

/** One API response: a partial entry, then the final one. `input` is the message's digit. */
function response(id: string, model: string, input: number, extra: Record<string, unknown> = {}) {
	const entry = (stop: string | null, output: number) =>
		JSON.stringify({
			type: "assistant",
			sessionId: SESSION,
			...extra,
			message: {
				id,
				model,
				role: "assistant",
				type: "message",
				stop_reason: stop,
				content: [{ type: "text", text: "synthetic" }],
				usage: {
					input_tokens: input,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					output_tokens: output,
				},
			},
		});
	return [entry(null, 1), entry("end_turn", 2)];
}

async function append(path: string, lines: string[]) {
	await appendFile(path, `${lines.join("\n")}\n`);
}

const fork = (world: World) => join(world.projectDir, SESSION, "subagents", "agent-f1.jsonl");

/** Run one hook as Claude Code does — optionally killed at `crash`, logging every boundary to `log`. */
function hook(
	world: World,
	name: string,
	input: Record<string, unknown>,
	crash?: { spec: string; log: string },
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[...(crash ? ["--import", CRASH_AT] : []), join(HOOKS, name)],
			{
				env: {
					...process.env,
					UT_CC_STATE_DIR: world.stateDir,
					UT_SERVER_URL: `http://127.0.0.1:${world.port}`,
					UT_SERVER_KEY: "k",
					...(crash ? { UT_CC_CRASH: crash.spec, UT_CC_CRASH_LOG: crash.log } : {}),
				},
				stdio: ["pipe", "ignore", "ignore"],
			},
		);
		child.on("error", reject);
		child.on("close", () => resolve());
		child.stdin.end(JSON.stringify(input));
	});
}

const base = (world: World) => ({ session_id: SESSION, transcript_path: world.main });
const pre = (toolUseId: string, agentId?: string) => (world: World) => ({
	...base(world),
	...(agentId ? { agent_id: agentId, agent_type: "fork" } : {}),
	tool_name: "Bash",
	tool_use_id: toolUseId,
	tool_input: { command: "ls" },
});
const post = (toolUseId: string, agentId?: string) => (world: World) => ({
	...base(world),
	...(agentId ? { agent_id: agentId } : {}),
	tool_use_id: toolUseId,
	tool_response: "ok",
});

interface Call {
	hook: string;
	input: (world: World) => Record<string, unknown>;
}

/** One step of a scenario: what happens to the transcripts first, then hooks that run AT ONCE. */
interface Step {
	before?: (world: World) => Promise<void>;
	calls: Call[];
}

interface Scenario {
	setup: (world: World) => Promise<void>;
	steps: Step[];
	/** How many messages (digits) the scenario charges. */
	messages: number;
	/**
	 * Its one agent settles at the estimate at first: then none of its usage may
	 * ever be charged for real as well. Otherwise no estimate may be settled at all.
	 */
	estimates?: true;
}

/** One agent, an older server: windows, a second model, a remainder. */
const ONE_AGENT: Scenario = {
	messages: 5,
	setup: async (world) => {
		await writeFile(world.main, "");
		await append(world.main, [...response("msg_1", SONNET, 1), ...response("msg_2", SONNET, 10)]);
	},
	steps: [
		{ calls: [{ hook: "pre-tool-use.mjs", input: pre("tu_1") }] },
		{ calls: [{ hook: "post-tool-use.mjs", input: post("tu_1") }] },
		{
			before: (world) =>
				append(world.main, [...response("msg_3", HAIKU, 100), ...response("msg_4", SONNET, 1000)]),
			calls: [{ hook: "pre-tool-use.mjs", input: pre("tu_2") }],
		},
		{ calls: [{ hook: "post-tool-use.mjs", input: post("tu_2") }] },
		{
			before: (world) => append(world.main, response("msg_5", SONNET, 10_000)),
			calls: [{ hook: "stop.mjs", input: base }],
		},
	],
};

/**
 * One agent whose first hooks name no transcript (they settle at the estimate),
 * and whose later hooks do: its real usage must never be charged as well.
 */
const ESTIMATE_FIRST: Scenario = {
	messages: 2,
	estimates: true,
	setup: async (world) => {
		await writeFile(world.main, "");
		await append(world.main, [...response("msg_1", SONNET, 1), ...response("msg_2", SONNET, 10)]);
	},
	steps: [
		{ calls: [{ hook: "pre-tool-use.mjs", input: (world) => unnamed(pre("tu_1")(world)) }] },
		{ calls: [{ hook: "post-tool-use.mjs", input: (world) => unnamed(post("tu_1")(world)) }] },
		{ calls: [{ hook: "pre-tool-use.mjs", input: pre("tu_2") }] },
		{ calls: [{ hook: "post-tool-use.mjs", input: post("tu_2") }] },
		{ calls: [{ hook: "stop.mjs", input: base }] },
	],
};

/** A hook input that names no transcript. */
function unnamed(input: Record<string, unknown>) {
	const { transcript_path: _path, ...rest } = input;
	return rest;
}

/** A parent and its fork, whose transcript begins with a copy of the parent's messages. */
const FORKED: Scenario = {
	messages: 3,
	setup: async (world) => {
		await writeFile(world.main, "");
		await append(world.main, [...response("msg_1", SONNET, 1), ...response("msg_2", SONNET, 10)]);
		await mkdir(join(world.projectDir, SESSION, "subagents"), { recursive: true });
		const copied = { agentId: "f1", isSidechain: true };
		await writeFile(fork(world), "");
		await append(fork(world), [
			...response("msg_1", SONNET, 1, copied),
			...response("msg_2", SONNET, 10, copied),
			...response("msg_f", SONNET, 100, copied),
		]);
		await writeFile(
			join(world.projectDir, SESSION, "subagents", "agent-f1.meta.json"),
			JSON.stringify({ agentType: "fork" }),
		);
	},
	steps: [
		{
			calls: [
				{ hook: "pre-tool-use.mjs", input: pre("tu_1") },
				{ hook: "pre-tool-use.mjs", input: pre("tu_f", "f1") },
			],
		},
		{
			calls: [
				{ hook: "post-tool-use.mjs", input: post("tu_1") },
				{ hook: "post-tool-use.mjs", input: post("tu_f", "f1") },
			],
		},
		{
			calls: [
				{ hook: "subagent-stop.mjs", input: (world) => ({ ...base(world), agent_id: "f1" }) },
				{ hook: "stop.mjs", input: base },
			],
		},
	],
};

/** Time passes: locks and in-flight settles go stale. */
async function age(world: World) {
	const long = new Date(Date.now() - 20 * 60_000);
	for (const name of await readdir(world.stateDir)) {
		if (name.endsWith(".settling")) await utimes(join(world.stateDir, name), long, long);
	}
	const dir = join(world.stateDir, "transcripts");
	for (const name of await readdir(dir).catch(() => [] as string[])) {
		if (name.endsWith(".lock")) await utimes(join(dir, name), long, long);
	}
}

interface Crash {
	step: number;
	call: number;
	spec: string;
}

/**
 * When every cursor is deleted, as if lost: right BEFORE the killed hook runs (it
 * starts a new cursor over messages already posted — the H4 shape), or right
 * AFTER it.
 */
type Loss = "before" | "after" | false;

async function loseCursors(world: World) {
	const dir = join(world.stateDir, "transcripts");
	for (const name of await readdir(dir).catch(() => [] as string[])) {
		if (name.endsWith(".json")) await rm(join(dir, name));
	}
}

/**
 * Run a scenario, killing one hook at `crash`, with the cursors lost as `loss`
 * says. Returns each message's charge count, and whether the crash point was
 * reached.
 */
async function play(scenario: Scenario, keyed: boolean, crash?: Crash, loss: Loss = false) {
	const world = await newWorld(keyed);
	const log = join(world.stateDir, "..", `${world.stateDir.split("/").at(-1)}.crash.log`);
	try {
		await scenario.setup(world);
		for (const [index, step] of scenario.steps.entries()) {
			await step.before?.(world);
			if (loss === "before" && crash?.step === index) await loseCursors(world);
			await Promise.all(
				step.calls.map((call, which) =>
					hook(
						world,
						call.hook,
						call.input(world),
						crash?.step === index && crash.call === which ? { spec: crash.spec, log } : undefined,
					),
				),
			);
			if (loss === "after" && crash?.step === index) await loseCursors(world);
		}
		await age(world);
		await hook(world, "stop.mjs", base(world));
		await hook(world, "stop.mjs", base(world));
		let total = world.charges.reduce((sum, n) => sum + n, 0);
		const counts: number[] = [];
		for (let i = 0; i < scenario.messages; i += 1) {
			counts.push(total % 10);
			total = Math.floor(total / 10);
		}
		const crashed = crash
			? (await readFile(log, "utf-8").catch(() => "")).includes("CRASH")
			: false;
		return {
			counts,
			crashed,
			excess: total,
			estimated: world.estimated.length,
			real: world.charges.length,
		};
	} finally {
		await rm(log, { force: true });
		await dropWorld(world);
	}
}

/** Every boundary of every hook in the scenario, from one clean run that logs them. */
async function boundaries(scenario: Scenario, keyed: boolean): Promise<Crash[]> {
	const world = await newWorld(keyed);
	const crashes: Crash[] = [];
	try {
		await scenario.setup(world);
		for (const [index, step] of scenario.steps.entries()) {
			await step.before?.(world);
			const logs = step.calls.map((_, which) =>
				join(world.projectDir, `step-${index}-${which}.log`),
			);
			await Promise.all(
				step.calls.map((call, which) =>
					hook(world, call.hook, call.input(world), {
						spec: "",
						log: logs[which] as string,
					}),
				),
			);
			for (const [which, path] of logs.entries()) {
				const seen = new Map<string, number>();
				for (const op of (await readFile(path, "utf-8").catch(() => "")).split("\n")) {
					if (op === "") continue;
					const k = (seen.get(op) ?? 0) + 1;
					seen.set(op, k);
					for (const when of ["before", "after"]) {
						crashes.push({ step: index, call: which, spec: `${op}|${k}|${when}` });
					}
				}
			}
		}
	} finally {
		await dropWorld(world);
	}
	return crashes;
}

async function everyCrash(scenario: Scenario, keyed: boolean, loss: Loss) {
	const crashes = await boundaries(scenario, keyed);
	const doubled: string[] = [];
	let reached = 0;
	for (let i = 0; i < crashes.length; i += PARALLEL) {
		await Promise.all(
			crashes.slice(i, i + PARALLEL).map(async (crash) => {
				const result = await play(scenario, keyed, crash, loss);
				if (result.crashed) reached += 1;
				const both = scenario.estimates
					? result.estimated > 0 && result.real > 0
					: result.estimated > 0;
				if (result.excess !== 0 || both || result.counts.some((n) => n > 1)) {
					doubled.push(
						`step ${crash.step}.${crash.call} at "${crash.spec}": charges per message ${JSON.stringify(result.counts)}, at the estimate ${result.estimated}`,
					);
				}
			}),
		);
	}
	return { crashes: crashes.length, reached, doubled };
}

describe("at most once — killed at every boundary, the session goes on, nothing is charged twice", () => {
	it("the scenarios are what they claim: a clean run charges every message exactly once", async () => {
		for (const [scenario, keyed] of [
			[ONE_AGENT, false],
			[ONE_AGENT, true],
			[FORKED, false],
		] as const) {
			const clean = await play(scenario, keyed);
			expect(clean.counts).toEqual(Array(scenario.messages).fill(1));
			expect(clean.excess).toBe(0);
			expect(clean.estimated).toBe(0);
		}
		// Estimated first: every tool call at the estimate, and no real charge.
		const estimated = await play(ESTIMATE_FIRST, false);
		expect(estimated.estimated).toBe(2);
		expect(estimated.real).toBe(0);
	}, 60_000);

	// A binding (AUTHORIZING, REMAINDER, a hold) whose outcome nothing recorded may
	// have posted, so its messages are NEVER posted again: charged once if the
	// settle went out, never if it did not — the under-count side, by design.
	it.each([
		// [what, step (0 pre tu_1, 1 post tu_1, 2 pre tu_2, 3 post tu_2, 4 stop), boundary, charges]
		[
			"PostToolUse killed after its settle went out, before anything recorded the outcome: charged once",
			1,
			"fetch /v1/settle|1|after",
			[1, 1, 1, 1, 1],
		],
		[
			"PostToolUse killed after the outcome journal, before the cursor took it: charged once",
			1,
			"rename|2|after",
			[1, 1, 1, 1, 1],
		],
		[
			"PostToolUse killed with its hold claimed for settling, before the settle went out: never posted",
			1,
			"fetch /v1/settle|1|before",
			[0, 0, 1, 1, 1],
		],
		[
			"PreToolUse killed after its window's authorize, before the hold was recorded: never posted",
			0,
			"fetch /v1/authorize|1|after",
			[0, 0, 1, 1, 1],
		],
		[
			"Stop killed after a remainder settle went out, before the cursor saved it: charged once",
			4,
			"fetch /v1/settle|1|after",
			[1, 1, 1, 1, 1],
		],
		[
			"Stop killed between a remainder's binding and its settle: never posted",
			4,
			"fetch /v1/settle|1|before",
			[1, 1, 1, 0, 0],
		],
	] as const)(
		"a binding with no recorded outcome — %s",
		async (_what, step, spec, charges) => {
			const result = await play(ONE_AGENT, false, { step, call: 0, spec });
			expect(result.crashed).toBe(true);
			expect(result.counts).toEqual(charges);
			expect(result.excess).toBe(0);
			expect(result.estimated).toBe(0);
		},
		60_000,
	);

	it.each([
		["one agent, an older server", ONE_AGENT, false, false],
		["one agent, its cursor lost just before the killed hook (H4)", ONE_AGENT, false, "before"],
		["one agent, its cursor lost just after the killed hook", ONE_AGENT, false, "after"],
		["one agent, a server that honours keys", ONE_AGENT, true, false],
		["a parent and its fork at once", FORKED, false, false],
		["a parent and its fork at once, their cursors lost just before", FORKED, false, "before"],
		["one agent at the estimate first, then with its transcript", ESTIMATE_FIRST, false, false],
		["the same, its cursor lost just after the killed hook", ESTIMATE_FIRST, false, "after"],
	] as const)(
		"%s",
		async (_name, scenario, keyed, loss) => {
			const { crashes, reached, doubled } = await everyCrash(scenario, keyed, loss);
			expect(doubled, `charged twice:\n${doubled.join("\n")}`).toEqual([]);
			// The harness reached the boundaries it listed (a concurrent run may take a
			// path that never gets to some of them).
			expect(crashes).toBeGreaterThanOrEqual(10);
			expect(reached).toBeGreaterThan(crashes * 0.8);
		},
		300_000,
	);
});
