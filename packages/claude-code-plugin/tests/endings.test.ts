// Every request a hook sends to the governance server, against every way it can end: the
// outcome each call site gives that ending, and the record it writes. One test per cell of the
// plugin's endings table (a call site × an ending); a cell no request can reach is not here, and
// the table says why. Each hook runs as Claude Code runs it (helpers/run-hook.ts): its own node
// process, against a fake server that answers by route, with a passwd home of the test's own.
//
// The endings: an answer (200), a 200 whose ledger post was ambiguous (`settled: false`), a 404
// `unknown transferId` (the server holds no such hold), another 4xx, a 5xx, no answer before this
// hook's own timer (`hang`), a connection refused before anything was sent (the server stops
// listening first), a connection dropped once the request went out, and a 307 redirect to a
// port fetch refuses outright: an answer, never followed, as the request may have been acted on.
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetPins, runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const CRASH_AT = join(import.meta.dirname, "helpers", "crash-at.mjs");
const SESSION = "55555555-2222-4333-8444-666666666666";
const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5";

type Answer = {
	status: number;
	json?: unknown;
	delayMs?: number;
	headers?: Record<string, string>;
};
type Reply = Answer | "hang" | "drop";
type Ending =
	| "ok"
	| "unsettled"
	| "gone"
	| "other4xx"
	| "other404"
	| "refusal402"
	| "error5xx"
	| "timeout"
	| "refused"
	| "dropped"
	| "redirect";

/** How the fake server answers the request a test aims at, for each ending it can answer. */
const ANSWER: Record<Exclude<Ending, "ok" | "refused">, Reply> = {
	unsettled: { status: 200, json: { settled: false } },
	gone: { status: 404, json: { error: "not_found", reason: "unknown transferId" } },
	other4xx: { status: 400, json: { error: "bad_request", reason: "invalid request" } },
	other404: { status: 404, json: { error: "not_found", reason: "no such thing" } },
	refusal402: { status: 402, json: { error: "budget_exceeded", reason: "over budget" } },
	error5xx: { status: 503, json: { error: "unavailable" } },
	timeout: "hang",
	dropped: "drop",
	// Followed, it would end on a port fetch refuses before connecting (`bad port`), which reads
	// as never sent: the ending a redirect to an unreachable host gives, with no race for a port.
	redirect: {
		status: 307,
		json: { moved: true },
		headers: { location: "http://127.0.0.1:1/v1/elsewhere" },
	},
};

interface Seen {
	method: string;
	path: string;
	body: Record<string, unknown>;
	auth: string | undefined;
	reply: Reply;
}

let servers: Server[] = [];
let current: Server | null = null;
let seen: Seen[] = [];
let counts = new Map<string, number>();
let capabilities: string[] = [];
let transfers = 0;
/** Fixed answers a scenario needs before its aimed request, by `<path>#<nth>`. */
let fixed = new Map<string, Reply>();
/** The request a test aims at: the nth to its path, and how it ends. */
let aimed: { path: string; nth: number; ending: Ending } | null = null;
/** The request after whose answer the server stops listening: the next one is refused. */
let closeAfter: { path: string; nth: number } | null = null;

/** How the fake server answers what nothing else decides: as a healthy usertrust server. */
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

function replyFor(path: string, nth: number): Reply {
	const scripted = fixed.get(`${path}#${nth}`);
	if (scripted !== undefined) return scripted;
	if (aimed !== null && aimed.path === path && aimed.nth === nth) {
		if (aimed.ending !== "ok" && aimed.ending !== "refused") return ANSWER[aimed.ending];
	}
	return usual(path);
}

/** A fake server: every request is recorded, then answered on a connection it then closes. */
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
				const nth = (counts.get(path) ?? 0) + 1;
				counts.set(path, nth);
				const reply = replyFor(path, nth);
				seen.push({ method: req.method ?? "", path, body, auth: req.headers.authorization, reply });
				if (reply === "hang") return;
				if (reply === "drop") {
					req.socket.destroy();
					return;
				}
				const send = () => {
					if (closeAfter !== null && closeAfter.path === path && closeAfter.nth === nth) {
						res.on("finish", () => server.close());
					}
					res.writeHead(reply.status, {
						"content-type": "application/json",
						connection: "close",
						...reply.headers,
					});
					res.end(JSON.stringify(reply.json ?? {}));
				};
				if (reply.delayMs === undefined) send();
				else setTimeout(send, reply.delayMs);
			});
		});
		servers.push(server);
		current = server;
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
	home = nodeFs.realpathSync(await mkdtemp(join(tmpdir(), "utcc-end-home-")));
	stateDir = await mkdtemp(join(tmpdir(), "utcc-end-state-"));
	projectDir = await mkdtemp(join(tmpdir(), "utcc-end-proj-"));
	seen = [];
	counts = new Map();
	capabilities = [];
	transfers = 0;
	fixed = new Map();
	aimed = null;
	closeAfter = null;
	url = await startServer();
});

afterEach(() => {
	for (const server of servers) {
		server.closeAllConnections();
		server.close();
	}
	servers = [];
	current = null;
});

/**
 * Aim at the nth request to `path`, ending as `ending`. A refused one needs the server to stop
 * listening before it connects: after the answer to `before`, the request just ahead of it, or
 * at once when it is the hook's first.
 */
function aim(path: string, nth: number, ending: Ending, before: [string, number] | null): void {
	aimed = { path, nth, ending };
	if (ending !== "refused") return;
	if (before === null) current?.close();
	else closeAfter = { path: before[0], nth: before[1] };
}

const envFor = (extra: Record<string, string> = {}): Record<string, string> => ({
	UT_CC_STATE_DIR: stateDir,
	UT_SERVER_URL: url,
	UT_SERVER_KEY: "k",
	TEST_PASSWD_HOME: home,
	...extra,
});

const run = (hook: string, input: Record<string, unknown>, extra: Record<string, string> = {}) =>
	runHook(join(HOOKS, `${hook}.mjs`), input, envFor(extra));

const ESTIMATE_MODE = { UT_CC_USAGE: "estimate" };
const transcriptPath = () => join(projectDir, `${SESSION}.jsonl`);
const preInput = (call: string) => ({
	session_id: SESSION,
	transcript_path: transcriptPath(),
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
const stopInput = () => ({ session_id: SESSION, transcript_path: transcriptPath() });

const holdName = (call: string, transferId: string, agent = "main", kind = "json") =>
	`${SESSION}__${agent}__${call}.${transferId}.${kind}`;

/** A hold's file, as PreToolUse records one; `kind` "settling" for one a hook claimed. */
async function seedHold(
	call: string,
	transferId: string,
	fields: Record<string, unknown>,
	kind = "json",
): Promise<void> {
	await writeFile(
		join(stateDir, holdName(call, transferId, "main", kind)),
		JSON.stringify({
			gate: 1,
			toolUseId: call,
			transferId,
			agentId: "main",
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
/** The same, under an idempotency key. */
const KEYED = { ...WINDOW, idempotencyKey: `cc:${"a".repeat(48)}`, agentType: "main" };
/** A transcript hold that carries no usage: it is only given back. */
const EMPTY = { usage: "transcript", holdModel: SONNET, assignedIds: [] };
/** An estimate hold: settled at the estimate by its PostToolUse. */
const ESTIMATE = { estimatedInputTokens: 4 };

/** One complete response per model, in a session's main transcript (5 in, 6 out each). */
async function writeTranscript(models: string[] = [SONNET]): Promise<void> {
	const lines = [
		JSON.stringify({ type: "user", sessionId: SESSION, message: { role: "user", content: "x" } }),
	];
	for (const [i, model] of models.entries()) {
		lines.push(
			JSON.stringify({
				type: "assistant",
				sessionId: SESSION,
				uuid: `msg_${i}-final`,
				message: {
					id: i === 0 ? "msg_a" : `msg_${i}`,
					model,
					role: "assistant",
					type: "message",
					stop_reason: "end_turn",
					content: [{ type: "text", text: "x" }],
					usage: {
						input_tokens: 5,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
						output_tokens: 6,
						cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
					},
				},
			}),
		);
	}
	await writeFile(transcriptPath(), `${lines.join("\n")}\n`);
}

type WatchRecord = Record<string, unknown>;

async function records(): Promise<WatchRecord[]> {
	const text = await readFile(join(stateDir, "watch.jsonl"), "utf-8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as WatchRecord);
}
const gaps = async () => (await records()).filter((record) => record.kind === "gap");
/** The gap records a settle or a give-back wrote, by phase. */
const phased = async (phase: string) => (await gaps()).filter((record) => record.phase === phase);
/** The gap records of a call that ran or may have run, its charge unconfirmed. */
const unconfirmed = async () => (await gaps()).filter((record) => record.tool === "(unconfirmed)");
const requests = (path: string) => seen.filter((request) => request.path === path);
const holdFiles = async () =>
	(await readdir(stateDir)).filter((name) => name.startsWith(`${SESSION}__`));

const breakerDir = () => join(home, ".local", "state", "usertrust", "breaker");
async function dueBreaker(): Promise<string> {
	const file = join(
		breakerDir(),
		`${createHash("sha256").update(url).digest("hex").slice(0, 16)}.json`,
	);
	await mkdir(breakerDir(), { recursive: true, mode: 0o700 });
	await writeFile(
		file,
		JSON.stringify({ openUntil: Date.now() - 1, openedAt: Date.now() - 61_000, timeouts: [] }),
		{ mode: 0o600 },
	);
	return file;
}
async function breakerState(file: string): Promise<Record<string, unknown> | null> {
	try {
		return JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

const LONG = 30_000;

describe("PreToolUse's authorize", () => {
	const go = async (ending: Ending) => {
		aim("/v1/authorize", 1, ending, ["/v1/health", 1]);
		return run("pre-tool-use", preInput("tu_1"), ESTIMATE_MODE);
	};
	it("200: the hold is recorded, and nothing else", async () => {
		await go("ok");
		expect(await holdFiles()).toEqual([holdName("tu_1", "tx_s1")]);
		expect(await records()).toEqual([]);
	});
	it.each<[Ending, string]>([
		["other4xx", "unexpected governance response 400"],
		["error5xx", "unexpected governance response 503"],
		["timeout", ""],
		["refused", "fetch failed"],
		["dropped", "fetch failed"],
		["redirect", "unexpected governance response 307"],
	])(
		"%s: no hold, and the call is recorded as a gap",
		async (ending, reason) => {
			await go(ending);
			expect(await holdFiles()).toEqual([]);
			expect(await records()).toMatchObject([{ kind: "gap", tool: "Bash", session: SESSION }]);
			expect(String((await records())[0]?.reason)).toContain(reason);
		},
		LONG,
	);
	it("402: no hold, and the refusal is recorded as would_block", async () => {
		await go("refusal402");
		expect(await holdFiles()).toEqual([]);
		expect(await records()).toMatchObject([{ kind: "would_block", status: 402 }]);
	});
});

describe("PreToolUse's give-back of a repeated call's earlier hold", () => {
	const go = async (ending: Ending) => {
		capabilities = ["release"];
		await run("pre-tool-use", preInput("tu_1"), ESTIMATE_MODE);
		aim("/v1/release", 1, ending, ["/v1/health", 2]);
		return run("pre-tool-use", preInput("tu_1"), ESTIMATE_MODE);
	};
	it.each<Ending>(["ok", "gone"])(
		"%s: the earlier hold is ended, the call holds afresh, and nothing is recorded",
		async (ending) => {
			await go(ending);
			expect(requests("/v1/authorize")).toHaveLength(2);
			expect(await records()).toEqual([]);
		},
	);
	it.each<[Ending, string]>([
		["other4xx", "release tx_s1 returned 400"],
		["error5xx", "release tx_s1 returned 503"],
		["timeout", "release tx_s1 failed"],
		["refused", "release tx_s1 failed"],
		["dropped", "release tx_s1 failed"],
		["redirect", "release tx_s1 returned 307"],
	])(
		"%s: the hold may be live, so none is made beside it: a gap, and the hold kept for Stop",
		async (ending, reason) => {
			await go(ending);
			expect(requests("/v1/authorize")).toHaveLength(1);
			expect(await records()).toMatchObject([{ kind: "gap", tool: "Bash" }]);
			expect(String((await records())[0]?.reason)).toContain(reason);
			expect(await holdFiles()).toEqual([holdName("tu_1", "tx_s1", "main", "releasing")]);
		},
		LONG,
	);
});

describe("PostToolUse's settle of an estimate hold", () => {
	const go = async (ending: Ending) => {
		await seedHold("tu_1", "tx_1", ESTIMATE);
		aim("/v1/settle", 1, ending, null);
		return run("post-tool-use", postInput("tu_1"), ESTIMATE_MODE);
	};
	it("200: settled, its hold gone, and nothing recorded", async () => {
		await go("ok");
		expect(await holdFiles()).toEqual([]);
		expect(await records()).toEqual([]);
	});
	it("200 settled:false: the charge may be missing: a claimed gap", async () => {
		await go("unsettled");
		expect(await records()).toMatchObject([
			{ kind: "gap", phase: "settle", outcome: "claimed", transferId: "tx_1" },
		]);
	});
	it("404 unknown transferId, a hold an earlier release recorded without the settle-attempt gate: it may have been charged already, so a settle gap, failed, and no fresh hold", async () => {
		// No `gate` mark: as a release before the settle-attempt gate wrote it.
		await writeFile(
			join(stateDir, holdName("tu_1", "tx_1")),
			JSON.stringify({ toolUseId: "tu_1", transferId: "tx_1", agentId: "main", ...ESTIMATE }),
			{ mode: 0o600 },
		);
		aim("/v1/settle", 1, "gone", null);
		await run("post-tool-use", postInput("tu_1"), ESTIMATE_MODE);
		expect(requests("/v1/authorize")).toEqual([]);
		expect(await records()).toMatchObject([
			{ kind: "gap", phase: "settle", outcome: "failed", transferId: "tx_1" },
		]);
	});

	it("404 unknown transferId: the hold expired, and the call is charged once on a fresh hold", async () => {
		await go("gone");
		expect(requests("/v1/settle").map((request) => request.body.transferId)).toEqual([
			"tx_1",
			"tx_s1",
		]);
		expect(await records()).toEqual([]);
	});
	it.each<[Ending, string]>([
		["other4xx", "failed"],
		["error5xx", "failed"],
		["timeout", "unknown"],
		["refused", "failed"],
		["dropped", "unknown"],
		["redirect", "failed"],
	])(
		"%s: a settle gap, %s, and the hold kept for Stop",
		async (ending, outcome) => {
			await go(ending);
			expect(await records()).toMatchObject([
				{ kind: "gap", phase: "settle", outcome, transferId: "tx_1" },
			]);
			expect(await holdFiles()).toEqual([holdName("tu_1", "tx_1", "main", "settling")]);
		},
		LONG,
	);
});

describe("PostToolUse's fresh hold for an estimate hold that expired", () => {
	const go = async (ending: Ending) => {
		await seedHold("tu_1", "tx_1", ESTIMATE);
		fixed.set("/v1/settle#1", ANSWER.gone);
		aim("/v1/authorize", 1, ending, ["/v1/health", 1]);
		return run("post-tool-use", postInput("tu_1"), ESTIMATE_MODE);
	};
	it("200: the call is charged once, on the fresh hold, and nothing recorded", async () => {
		await go("ok");
		expect(requests("/v1/settle").map((request) => request.body.transferId)).toEqual([
			"tx_1",
			"tx_s1",
		]);
		expect(await records()).toEqual([]);
	});
	it.each<Ending>([
		"other4xx",
		"refusal402",
		"error5xx",
		"timeout",
		"refused",
		"dropped",
		"redirect",
	])(
		"%s: the call ran and nothing charges it: a call-ran gap now, and no hold left",
		async (ending) => {
			await go(ending);
			expect(await records()).toMatchObject([
				{ kind: "gap", tool: "(unconfirmed)", transferId: "tx_1", releaseClass: "call-ran" },
			]);
			expect(await holdFiles()).toEqual([]);
		},
		LONG,
	);
});

describe("PostToolUse's fresh hold for an estimate hold that expired: evidence before the marker goes", () => {
	// Killed right before its settle-attempted marker is removed, the hook has already written the
	// call's gap: never neither.
	it.each<Ending>(["other4xx", "dropped"])(
		"%s: the call-ran gap is written before the marker's unlink",
		async (ending) => {
			await seedHold("tu_1", "tx_1", ESTIMATE);
			fixed.set("/v1/settle#1", ANSWER.gone);
			aim("/v1/authorize", 1, ending, ["/v1/health", 1]);
			await runHook(
				join(HOOKS, "post-tool-use.mjs"),
				postInput("tu_1"),
				envFor({ ...ESTIMATE_MODE, UT_CC_CRASH: "unlink .settling|1|before" }),
				["--import", CRASH_AT],
			);
			expect(await records()).toMatchObject([
				{ kind: "gap", tool: "(unconfirmed)", transferId: "tx_1", releaseClass: "call-ran" },
			]);
			expect(await holdFiles()).toEqual([holdName("tu_1", "tx_1", "main", "settling")]);
		},
		LONG,
	);
});

describe("a ran estimate hold the breaker skip cannot mark settle-attempted", () => {
	it(
		"a claim that fails (not ENOENT) quarantines the hold: no later call without a tool_use_id can take it",
		async () => {
			const file = join(
				breakerDir(),
				`${createHash("sha256").update(url).digest("hex").slice(0, 16)}.json`,
			);
			await mkdir(breakerDir(), { recursive: true, mode: 0o700 });
			await writeFile(
				file,
				JSON.stringify({ openUntil: Date.now() + 60_000, openedAt: Date.now(), timeouts: [] }),
				{ mode: 0o600 },
			);
			await seedHold("tu_1", "tx_1", ESTIMATE);
			const skipped = await runHook(
				join(HOOKS, "post-tool-use.mjs"),
				postInput("tu_1"),
				envFor({ ...ESTIMATE_MODE, UT_CC_FAULT: ".settling|1|throw" }),
				["--import", FAULT_AT],
			);
			expect(skipped.stderr).toContain("could not be marked settle-attempted (EIO)");
			expect(skipped.stderr).toContain("kept out of any other call's reach");
			// The breaker closes, and the next call comes from a host that sends no tool_use_id.
			nodeFs.rmSync(file, { force: true });
			const { tool_use_id: _call, ...noCallId } = postInput("tu_2");
			await run("post-tool-use", noCallId, ESTIMATE_MODE);
			expect(requests("/v1/settle").filter((r) => r.body.transferId === "tx_1")).toEqual([]);
			// The hold itself stays, for Stop to give back.
			expect(await holdFiles()).toEqual([holdName("tu_1", "tx_1")]);
		},
		LONG,
	);
});

describe("PostToolUse's settle of that fresh hold", () => {
	const go = async (ending: Ending) => {
		await seedHold("tu_1", "tx_1", ESTIMATE);
		fixed.set("/v1/settle#1", ANSWER.gone);
		aim("/v1/settle", 2, ending, ["/v1/authorize", 1]);
		return run("post-tool-use", postInput("tu_1"), ESTIMATE_MODE);
	};
	it("200: settled, and nothing recorded", async () => {
		await go("ok");
		expect(await records()).toEqual([]);
	});
	it.each<[Ending, string]>([
		["unsettled", "claimed"],
		["gone", "failed"],
		["other4xx", "failed"],
		["error5xx", "failed"],
		["timeout", "unknown"],
		["refused", "failed"],
		["dropped", "unknown"],
		["redirect", "failed"],
	])(
		"%s: a settle gap under the fresh hold, %s",
		async (ending, outcome) => {
			await go(ending);
			expect(await records()).toMatchObject([
				{ kind: "gap", phase: "settle", outcome, transferId: "tx_s1" },
			]);
		},
		LONG,
	);
});

describe("the give-back of a hold whose transferId is not a valid id", () => {
	const go = async (ending: Ending) => {
		capabilities = ["release"];
		fixed.set("/v1/authorize#1", {
			status: 200,
			json: { transferId: "bad id!", estimatedCost: 1 },
		});
		aim("/v1/release", 1, ending, ["/v1/authorize", 1]);
		return run("pre-tool-use", preInput("tu_1"), ESTIMATE_MODE);
	};
	it.each<[Ending, string | null]>([
		["ok", null],
		["gone", null],
		["other4xx", "returned 400; the server's sweep releases it"],
		["error5xx", "returned 503; the server's sweep releases it"],
		["timeout", "could not be released"],
		["refused", "could not be released"],
		["dropped", "could not be released"],
		["redirect", "returned 307; the server's sweep releases it"],
	])(
		"%s: released or left to the sweep, said on stderr; the call's own gap is the record",
		async (ending, said) => {
			const pre = await go(ending);
			// A refused release never reaches the server: its stderr is the evidence it was tried.
			expect(requests("/v1/release")).toMatchObject(
				ending === "refused" ? [] : [{ body: { transferId: "bad id!" } }],
			);
			expect(await records()).toMatchObject([{ kind: "gap", tool: "Bash" }]);
			if (said === null) expect(pre.stderr).not.toMatch(/sweep releases it|could not be released/);
			else expect(pre.stderr).toContain(said);
		},
		LONG,
	);
});

describe("the give-back of a hold whose record cannot be written", () => {
	const go = async (ending: Ending) => {
		capabilities = ["release"];
		// A directory squats on the hold's file name, so its record's write fails.
		await mkdir(join(stateDir, holdName("tu_1", "tx_s1"), "x"), { recursive: true });
		aim("/v1/release", 1, ending, ["/v1/authorize", 1]);
		return run("pre-tool-use", preInput("tu_1"), ESTIMATE_MODE);
	};
	it.each<[Ending, string | null]>([
		["ok", null],
		["gone", null],
		["other4xx", "was refused (400: invalid request)"],
		["error5xx", "was refused (503"],
		["timeout", "could not be given back"],
		["refused", "could not be given back"],
		["dropped", "could not be given back"],
		["redirect", "was refused (307"],
	])(
		"%s: given back or left to the sweep, said on stderr; the call's own gap is the record",
		async (ending, said) => {
			const pre = await go(ending);
			// A refused give-back never reaches the server: its stderr is the evidence it was tried.
			expect(requests("/v1/release")).toMatchObject(
				ending === "refused" ? [] : [{ body: { transferId: "tx_s1" } }],
			);
			expect(await records()).toMatchObject([{ kind: "gap", tool: "Bash" }]);
			if (said === null) expect(pre.stderr).not.toMatch(/was refused|could not be given back/);
			else expect(pre.stderr).toContain(said);
		},
		LONG,
	);
});

describe("the settle of a transcript hold (PostToolUse)", () => {
	const go = async (ending: Ending, fields: Record<string, unknown>) => {
		await seedHold("tu_1", "tx_1", fields);
		aim("/v1/settle", 1, ending, null);
		return run("post-tool-use", postInput("tu_1"));
	};
	it.each<[string, Record<string, unknown>, string[]]>([
		["no key", WINDOW, ["release"]],
		["a key", KEYED, ["release", "idempotency-key"]],
	])("200, %s: settled, and nothing recorded", async (_, fields, caps) => {
		capabilities = caps;
		await go("ok", fields);
		expect(await records()).toEqual([]);
	});
	it.each<[Ending, string]>([
		["unsettled", "claimed"],
		["gone", "released"],
		["other4xx", "released"],
		["refusal402", "claimed"],
		["error5xx", "claimed"],
		["timeout", "claimed"],
		["refused", "released"],
		["dropped", "claimed"],
		["redirect", "claimed"],
	])(
		"%s, with no key: a settle gap, %s",
		async (ending, outcome) => {
			capabilities = ["release"];
			await go(ending, WINDOW);
			expect(await phased("settle")).toMatchObject([{ outcome, transferId: "tx_1" }]);
		},
		LONG,
	);
	it.each<[Ending, string]>([
		["unsettled", "unresolved"],
		["gone", "unresolved"],
		["other4xx", "released"],
		["refusal402", "unresolved"],
		["error5xx", "unresolved"],
		["timeout", "unresolved"],
		["refused", "unresolved"],
		["dropped", "unresolved"],
		["redirect", "unresolved"],
	])(
		"%s, under a key: a settle gap, %s",
		async (ending, outcome) => {
			capabilities = ["release", "idempotency-key"];
			await go(ending, KEYED);
			expect(await phased("settle")).toMatchObject([{ outcome, transferId: "tx_1" }]);
		},
		LONG,
	);
});

describe("the give-back after a transcript hold's failed settle, as a repeated call's PreToolUse reads it", () => {
	const go = async (ending: Ending) => {
		capabilities = ["release"];
		await writeTranscript();
		await run("pre-tool-use", preInput("tu_1"));
		fixed.set("/v1/settle#1", { status: 500, json: { error: "down" } });
		aim("/v1/release", 1, ending, ["/v1/health", 2]);
		return run("pre-tool-use", preInput("tu_1"));
	};
	it.each<Ending>(["ok", "gone"])(
		"%s: the hold is known gone, so the call holds afresh",
		async (ending) => {
			const again = await go(ending);
			expect(again.stderr).toContain("this tool call's earlier hold tx_s1 is ended");
			expect(requests("/v1/authorize")).toHaveLength(2);
			expect(await phased("settle")).toMatchObject([{ outcome: "claimed", transferId: "tx_s1" }]);
		},
	);
	it.each<Ending>(["other4xx", "error5xx", "timeout", "refused", "dropped", "redirect"])(
		"%s: the hold may be live, so none is made beside it, and the call's gap says so",
		async (ending) => {
			await go(ending);
			expect(requests("/v1/authorize")).toHaveLength(1);
			expect(await phased("settle")).toMatchObject([{ outcome: "claimed", transferId: "tx_s1" }]);
			const call = (await gaps()).filter((record) => record.phase === undefined);
			expect(String(call[0]?.reason)).toContain("the server has not confirmed it is gone");
		},
		LONG,
	);
});

describe("the release of a transcript hold that carries no usage (PostToolUse)", () => {
	const go = async (ending: Ending) => {
		capabilities = ["release"];
		await seedHold("tu_1", "tx_1", EMPTY);
		aim("/v1/release", 1, ending, ["/v1/health", 1]);
		return run("post-tool-use", postInput("tu_1"));
	};
	it.each<Ending>(["ok", "gone"])("%s: given back, and nothing recorded", async (ending) => {
		await go(ending);
		expect(await records()).toEqual([]);
	});
	it.each<[Ending, string]>([
		["other4xx", "failed"],
		["error5xx", "failed"],
		["timeout", "unknown"],
		["refused", "failed"],
		["dropped", "unknown"],
		["redirect", "failed"],
	])(
		"%s: a release gap, %s",
		async (ending, outcome) => {
			await go(ending);
			expect(await records()).toMatchObject([
				{ kind: "gap", phase: "release", outcome, transferId: "tx_1" },
			]);
		},
		LONG,
	);
});

describe("the settle at zero that stands in for that release on a server that cannot release", () => {
	const go = async (ending: Ending) => {
		capabilities = [];
		await seedHold("tu_1", "tx_1", EMPTY);
		aim("/v1/settle", 1, ending, ["/v1/health", 1]);
		return run("post-tool-use", postInput("tu_1"));
	};
	it.each<Ending>(["ok", "gone"])("%s: given back, and nothing recorded", async (ending) => {
		await go(ending);
		expect(requests("/v1/settle")).toMatchObject([
			{ body: { transferId: "tx_1", inputTokens: 0 } },
		]);
		expect(await records()).toEqual([]);
	});
	it.each<[Ending, string]>([
		["unsettled", "failed"],
		["other4xx", "failed"],
		["error5xx", "failed"],
		["timeout", "unknown"],
		["refused", "failed"],
		["dropped", "unknown"],
		["redirect", "failed"],
	])(
		"%s: written down as the give-back it stands for: a release gap, %s",
		async (ending, outcome) => {
			await go(ending);
			expect(await records()).toMatchObject([
				{ kind: "gap", phase: "release", outcome, transferId: "tx_1" },
			]);
		},
		LONG,
	);
});

describe("Stop's remainder: the authorize", () => {
	const go = async (ending: Ending) => {
		await writeTranscript();
		aim("/v1/authorize", 1, ending, ["/v1/health", 1]);
		return run("stop", stopInput());
	};
	it("200: posted, and nothing recorded", async () => {
		await go("ok");
		expect(requests("/v1/settle")).toHaveLength(1);
		expect(await records()).toEqual([]);
	});
	it.each<Ending>(["other4xx", "error5xx", "timeout", "refused", "dropped", "redirect"])(
		"%s: nothing posted, so the messages are released: a remainder gap",
		async (ending) => {
			await go(ending);
			expect(await records()).toMatchObject([
				{ kind: "gap", phase: "remainder", outcome: "released", model: SONNET, messages: 1 },
			]);
		},
		LONG,
	);
	it("402: a refusal: the messages are denied, and without a job nothing is recorded", async () => {
		await go("refusal402");
		expect(requests("/v1/settle")).toEqual([]);
		expect(await records()).toEqual([]);
	});
});

describe("Stop's remainder: the settle", () => {
	const go = async (ending: Ending) => {
		await writeTranscript();
		aim("/v1/settle", 1, ending, ["/v1/authorize", 1]);
		return run("stop", stopInput());
	};
	it.each<[string, string[]]>([
		["no key", []],
		["a key", ["idempotency-key"]],
	])("200, %s: posted, and nothing recorded", async (_, caps) => {
		capabilities = caps;
		await go("ok");
		expect(await records()).toEqual([]);
	});
	it.each<[Ending, string]>([
		["unsettled", "claimed"],
		["gone", "released"],
		["other4xx", "released"],
		["refusal402", "claimed"],
		["error5xx", "claimed"],
		["timeout", "claimed"],
		["refused", "released"],
		["dropped", "claimed"],
		["redirect", "claimed"],
	])(
		"%s: a remainder gap, %s",
		async (ending, outcome) => {
			await go(ending);
			expect(await phased("remainder")).toMatchObject([{ outcome, model: SONNET, messages: 1 }]);
		},
		LONG,
	);
	it.each<[Ending, string]>([
		["unsettled", "unresolved"],
		["gone", "unresolved"],
		["other4xx", "released"],
		["refusal402", "unresolved"],
		["error5xx", "unresolved"],
		["timeout", "unresolved"],
		["refused", "unresolved"],
		["dropped", "unresolved"],
		["redirect", "unresolved"],
	])(
		"%s, under a key: a remainder gap, %s",
		async (ending, outcome) => {
			capabilities = ["idempotency-key"];
			await go(ending);
			expect(await phased("remainder")).toMatchObject([{ outcome, model: SONNET, messages: 1 }]);
		},
		LONG,
	);
});

describe("Stop's give-back of a leftover estimate hold", () => {
	const go = async (ending: Ending, kind: string) => {
		capabilities = ["release"];
		await seedHold("tu_1", "tx_1", ESTIMATE, kind);
		aim("/v1/release", 1, ending, ["/v1/health", 1]);
		return run("stop", stopInput(), ESTIMATE_MODE);
	};
	it.each<[string, string, string]>([
		["never reached PostToolUse", "json", "call-unconfirmed"],
		["whose settle went unanswered", "settling", "call-ran"],
	])(
		"200 and 404 unknown transferId, a hold that %s (.%s): its call's gap, %s, and no release gap",
		async (_, kind, releaseClass) => {
			for (const ending of ["ok", "gone"] as const) {
				await go(ending, kind);
				expect(await unconfirmed()).toMatchObject([{ transferId: "tx_1", releaseClass }]);
				expect(await phased("release")).toEqual([]);
				nodeFs.rmSync(join(stateDir, "watch.jsonl"), { force: true });
				counts = new Map();
			}
		},
	);
	it.each<[string, Ending, string]>([
		["json", "other4xx", "failed"],
		["json", "other404", "failed"],
		["json", "error5xx", "failed"],
		["json", "timeout", "unknown"],
		["json", "refused", "failed"],
		["json", "dropped", "unknown"],
		["json", "redirect", "failed"],
		["settling", "other4xx", "failed"],
		["settling", "other404", "failed"],
		["settling", "error5xx", "failed"],
		["settling", "timeout", "unknown"],
		["settling", "refused", "failed"],
		["settling", "dropped", "unknown"],
		["settling", "redirect", "failed"],
	])(
		"a .%s hold, %s: its call's gap, and a release gap, %s",
		async (kind, ending, outcome) => {
			await go(ending, kind);
			expect(await unconfirmed()).toHaveLength(1);
			expect(await phased("release")).toMatchObject([{ outcome, transferId: "tx_1" }]);
		},
		LONG,
	);

	// The same loops give back two holds behind which no call's charge can hide: a transcript hold
	// with no usage (its window is posted by message) and a `.releasing` hold (claimed only to END
	// a deferred call's earlier hold). Each is given back as `unused`: no call gap, whatever the
	// ending; a give-back that did not end cleanly is its release gap alone.
	const unused: Array<[string, Record<string, unknown>, string, Record<string, string>]> = [
		["a transcript hold that carries no usage (.json)", EMPTY, "json", {}],
		["a .releasing hold", ESTIMATE, "releasing", ESTIMATE_MODE],
	];
	const giveBackUnused = async (
		ending: Ending,
		fields: Record<string, unknown>,
		kind: string,
		mode: Record<string, string>,
	) => {
		// `job`: the server records why a hold is given back, so the release names its class.
		capabilities = ["release", "job"];
		await seedHold("tu_1", "tx_1", fields, kind);
		aim("/v1/release", 1, ending, ["/v1/health", 1]);
		return run("stop", stopInput(), mode);
	};
	it.each(unused)(
		"%s, 200 and 404 unknown transferId: given back, and nothing recorded",
		async (_, fields, kind, mode) => {
			for (const ending of ["ok", "gone"] as const) {
				await giveBackUnused(ending, fields, kind, mode);
				expect(requests("/v1/release")).toMatchObject([
					{ body: { transferId: "tx_1", releaseClass: "unused" } },
				]);
				expect(await records()).toEqual([]);
				expect(await holdFiles()).toEqual([]);
				seen = [];
				counts = new Map();
			}
		},
	);
	it.each(
		unused.flatMap(([what, fields, kind, mode]) =>
			(
				[
					["other4xx", "failed"],
					["other404", "failed"],
					["error5xx", "failed"],
					["timeout", "unknown"],
					["refused", "failed"],
					["dropped", "unknown"],
					["redirect", "failed"],
				] as Array<[Ending, string]>
			).map(([ending, outcome]) => [what, ending, outcome, fields, kind, mode] as const),
		),
	)(
		"%s, %s: no call gap; a release gap, %s, as unused",
		async (_, ending, outcome, fields, kind, mode) => {
			await giveBackUnused(ending, fields, kind, mode);
			expect(await unconfirmed()).toEqual([]);
			expect(await records()).toMatchObject([
				{ kind: "gap", phase: "release", outcome, transferId: "tx_1", releaseClass: "unused" },
			]);
		},
		LONG,
	);
});

describe("the capability probe", () => {
	const go = async (ending: Ending) => {
		aim("/v1/health", 1, ending, null);
		return run("pre-tool-use", preInput("tu_1"), ESTIMATE_MODE);
	};
	it("200: the capabilities are known", async () => {
		const pre = await go("ok");
		expect(pre.stderr).not.toContain("capabilities are unknown");
	});
	it.each<[Ending, string]>([
		["other4xx", "health returned 400"],
		["error5xx", "health returned 503"],
		["timeout", "capabilities are unknown"],
		["refused", "capabilities are unknown"],
		["dropped", "capabilities are unknown"],
		["redirect", "health returned 307"],
	])(
		"%s: unknown, said on stderr, and the call sends no key or principal",
		async (ending, said) => {
			const pre = await go(ending);
			expect(pre.stderr).toContain(said);
			for (const request of requests("/v1/authorize")) {
				expect(request.body.idempotencyKey).toBeUndefined();
				expect(request.body.principal).toBeUndefined();
			}
		},
		LONG,
	);
});

describe("the half-open probe of a breaker past its minute", () => {
	const go = async (ending: Ending) => {
		const file = await dueBreaker();
		aim("/v1/health", 1, ending, null);
		await run("pre-tool-use", preInput("tu_1"), ESTIMATE_MODE);
		return file;
	};
	it.each<Ending>(["ok", "other4xx", "error5xx", "redirect"])(
		"%s: an answer: the breaker closes, and the call is governed",
		async (ending) => {
			const file = await go(ending);
			expect(await breakerState(file)).toBeNull();
			expect(requests("/v1/authorize").length).toBeGreaterThan(0);
		},
	);
	it.each<Ending>(["timeout", "refused", "dropped"])(
		"%s: no answer: open for another minute, nothing sent, and the skip recorded",
		async (ending) => {
			const before = Date.now();
			const file = await go(ending);
			expect(Number((await breakerState(file))?.openedAt)).toBeGreaterThanOrEqual(before);
			expect(requests("/v1/authorize")).toEqual([]);
			expect(await records()).toMatchObject([{ kind: "gap", reason: "breaker-open" }]);
		},
		LONG,
	);
});

describe("the breaker's count while /v1/health answers (PreToolUse's authorize)", () => {
	/** A breaker two timeouts into its count: one more opens it. */
	async function twoTimeouts(): Promise<string> {
		const file = join(
			breakerDir(),
			`${createHash("sha256").update(url).digest("hex").slice(0, 16)}.json`,
		);
		await mkdir(breakerDir(), { recursive: true, mode: 0o700 });
		await writeFile(file, JSON.stringify({ timeouts: [Date.now() - 2_000, Date.now() - 1_000] }), {
			mode: 0o600,
		});
		return file;
	}
	// Each hook's capability probe is answered first: that answer clears nothing. Only the route's
	// ending decides: any answer clears the count, a timeout counts, and a request that got no
	// answer without a timeout (refused, dropped) leaves it as it was.
	it.each<[Ending, "cleared" | "opens" | "kept"]>([
		["ok", "cleared"],
		["other4xx", "cleared"],
		["refusal402", "cleared"],
		["error5xx", "cleared"],
		["redirect", "cleared"],
		["timeout", "opens"],
		["refused", "kept"],
		["dropped", "kept"],
	])(
		"%s: the count is %s",
		async (ending, effect) => {
			const file = await twoTimeouts();
			aim("/v1/authorize", 1, ending, ["/v1/health", 1]);
			await run("pre-tool-use", preInput("tu_1"), ESTIMATE_MODE);
			expect(requests("/v1/health")).toHaveLength(1);
			const state = await breakerState(file);
			if (effect === "cleared") expect(state).toEqual({ timeouts: [] });
			else if (effect === "kept") expect(state?.timeouts).toHaveLength(2);
			else expect(typeof state?.openUntil).toBe("number");
		},
		LONG,
	);
});

describe("SessionEnd, the last settle point: what it cannot finish is written down", () => {
	/** SessionEnd's whole budget, by Claude Code's variable less the start-up margin. */
	const budget = (ms: number) => ({ CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: String(ms + 300) });
	const endInput = () => ({ ...stopInput(), hook_event_name: "SessionEnd", reason: "other" });

	it(
		"its half-open probe takes at most a fifth of its budget: an answer slower than that re-opens the breaker, and the skip is recorded",
		async () => {
			const file = await dueBreaker();
			await writeTranscript();
			fixed.set("/v1/health#1", {
				status: 200,
				json: { status: "ok", capabilities },
				delayMs: 600,
			});
			const before = Date.now();
			await run("session-end", endInput(), budget(1_200));
			expect(Number((await breakerState(file))?.openedAt)).toBeGreaterThanOrEqual(before);
			expect(requests("/v1/authorize")).toEqual([]);
			expect(await records()).toMatchObject([
				{ kind: "gap", phase: "session-end", reason: "breaker-open" },
			]);
		},
		LONG,
	);

	it("with no time to probe, it decides nothing: the breaker stays past its minute, and SessionEnd sends nothing", async () => {
		const file = await dueBreaker();
		const was = await breakerState(file);
		await run("session-end", endInput(), budget(0));
		expect(await breakerState(file)).toEqual(was);
		expect(seen).toEqual([]);
	});

	it("a message it has no time to claim: a deferred remainder gap, with its count and start", async () => {
		await writeTranscript();
		await run("session-end", endInput(), budget(0));
		expect(seen).toEqual([]);
		expect(await phased("remainder")).toMatchObject([
			{ outcome: "deferred", agent: "main", messages: 1 },
		]);
		expect(String((await phased("remainder"))[0]?.reason)).toContain("not claimed");
	});

	it(
		"the groups a dead server leaves: the first is released, and each after it a deferred gap",
		async () => {
			await writeTranscript([SONNET, HAIKU]);
			aim("/v1/authorize", 1, "timeout", null);
			await run("session-end", endInput(), budget(1_200));
			const written = await phased("remainder");
			expect(written.map((record) => record.outcome)).toEqual(["released", "deferred"]);
			expect(written[1]).toMatchObject({ messages: 1 });
			expect(String(written[1]?.reason)).toContain("the server stopped answering");
		},
		LONG,
	);

	it("an agent whose transcript state is unavailable: a deferred gap naming why", async () => {
		await writeTranscript();
		const cursors = join(stateDir, "transcripts");
		await mkdir(cursors, { recursive: true, mode: 0o700 });
		await writeFile(join(cursors, `${SESSION}__main.json`), "{ not a cursor");
		await run("session-end", endInput(), budget(1_200));
		const written = await phased("remainder");
		expect(written).toMatchObject([{ outcome: "deferred", agent: "main" }]);
		expect(String(written[0]?.reason)).toContain("transcript state unavailable");
	});

	it("a settle-attempted hold it has no time to give back: its call written down as having run", async () => {
		await seedHold("tu_1", "tx_1", ESTIMATE, "settling");
		await run("session-end", endInput(), { ...ESTIMATE_MODE, ...budget(0) });
		expect(seen).toEqual([]);
		expect(await unconfirmed()).toMatchObject([{ transferId: "tx_1", releaseClass: "call-ran" }]);
	});

	it("holds it has no time to give back: each one's call written down, as the give-back would have", async () => {
		await seedHold("tu_1", "tx_1", ESTIMATE);
		await seedHold("tu_2", "tx_2", ESTIMATE, "settling");
		await seedHold("tu_3", "tx_3", EMPTY);
		await run("session-end", endInput(), { ...ESTIMATE_MODE, ...budget(0) });
		expect(seen).toEqual([]);
		const written = await unconfirmed();
		expect(written.map((record) => [record.transferId, record.releaseClass]).sort()).toEqual([
			["tx_1", "call-unconfirmed"],
			["tx_2", "call-ran"],
		]);
	});

	it("a backlog spanning two jobs: one deferred gap per job, each a known gap of its own job's coverage", async () => {
		const now = Date.now();
		const at = (offsetS: number) => new Date(now + offsetS * 1000).toISOString();
		// The state is older than the backlog, so both messages are the session's to post.
		await mkdir(join(stateDir, "transcripts"), { recursive: true, mode: 0o700 });
		await writeFile(join(stateDir, "transcripts", "since"), "2000-01-01T00:00:00.000Z");
		const line = (ts: string, op: string, job: string | null) =>
			JSON.stringify({ sid: SESSION, ts, op, job });
		const log = [
			line(at(-60), "session-start", null),
			line(at(-50), "start", "job-a"),
			line(at(-30), "stop", null),
			line(at(-20), "start", "job-b"),
			line(at(-5), "stop", null),
		].join("\n");
		await mkdir(join(stateDir, "jobs"), { recursive: true });
		await writeFile(join(stateDir, "jobs", `${SESSION}.jsonl`), `${log}\n`);
		const message = (id: string, ts: string) =>
			JSON.stringify({
				type: "assistant",
				sessionId: SESSION,
				uuid: `${id}-final`,
				timestamp: ts,
				message: {
					id,
					model: SONNET,
					role: "assistant",
					type: "message",
					stop_reason: "end_turn",
					content: [{ type: "text", text: "x" }],
					usage: {
						input_tokens: 5,
						output_tokens: 6,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			});
		await writeFile(
			transcriptPath(),
			`${[message("msg_a", at(-40)), message("msg_b", at(-10))].join("\n")}\n`,
		);
		await run("session-end", endInput(), budget(0));
		expect(seen).toEqual([]);
		const written = await phased("remainder");
		expect(written).toMatchObject([
			{ outcome: "deferred", messages: 1, started: at(-40) },
			{ outcome: "deferred", messages: 1, started: at(-10) },
		]);
		const { jobCoverage } = (await import(pathToFileURL(join(HOOKS, "job-log.mjs")).href)) as {
			jobCoverage(args: {
				job: string;
				logs: Record<string, string>;
				records: unknown[];
				watch: unknown[];
			}): { knownGaps: Array<{ gap: string }> };
		};
		for (const job of ["job-a", "job-b"]) {
			const coverage = jobCoverage({
				job,
				logs: { [SESSION]: `${log}\n` },
				records: [],
				watch: written,
			});
			expect(coverage.knownGaps.map((gap) => gap.gap)).toContain(
				`session ${SESSION}: a gap fell inside an interval of ${job}`,
			);
		}
	});

	it("a message whose claim fails: Stop leaves it to stderr, as a later settle point retries it; SessionEnd, the last, writes it down", async () => {
		await writeTranscript();
		// A claims directory this user cannot write: every claim fails (EACCES).
		await mkdir(join(stateDir, "transcripts", "claims"), { recursive: true, mode: 0o700 });
		await chmod(join(stateDir, "transcripts", "claims"), 0o500);
		const stop = await run("stop", stopInput());
		expect(stop.stderr).toContain("could not be claimed (EACCES)");
		expect(await records()).toEqual([]);
		await run("session-end", endInput(), budget(1_200));
		expect(requests("/v1/settle")).toEqual([]);
		const written = await phased("remainder");
		expect(written).toMatchObject([{ outcome: "deferred", agent: "main", messages: 1 }]);
		expect(String(written[0]?.reason)).toContain("could not be claimed (EACCES)");
		await chmod(join(stateDir, "transcripts", "claims"), 0o700);
	});
});

// ── The fixes of the sixth review round: the mechanisms that replace exit-by-exit patching ──

const FAULT_AT = join(import.meta.dirname, "helpers", "fault-at.mjs");
const seBudget = (ms: number) => ({ CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: String(ms + 300) });
const seInput = () => ({ ...stopInput(), hook_event_name: "SessionEnd", reason: "other" });

/** One complete response, as Claude Code writes it, at `ts` (ISO) when given. */
const response = (id: string, model: string, ts?: string) =>
	JSON.stringify({
		type: "assistant",
		sessionId: SESSION,
		uuid: `${id}-final`,
		...(ts === undefined ? {} : { timestamp: ts }),
		message: {
			id,
			model,
			role: "assistant",
			type: "message",
			stop_reason: "end_turn",
			content: [{ type: "text", text: "x" }],
			usage: {
				input_tokens: 5,
				output_tokens: 6,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	});
const writeLines = (path: string, lines: string[]) =>
	writeFile(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
/** The state is older than any message a test writes, so every message is the session's to post. */
async function backdate(): Promise<void> {
	await mkdir(join(stateDir, "transcripts"), { recursive: true, mode: 0o700 });
	await writeFile(join(stateDir, "transcripts", "since"), "2000-01-01T00:00:00.000Z");
}
const answered = (request: Seen, status: number) =>
	typeof request.reply === "object" && request.reply.status === status;
const replyJson = (request: Seen) =>
	(typeof request.reply === "object" ? request.reply.json : undefined) as
		| Record<string, unknown>
		| undefined;
/** Messages a remainder authorize carried, for the authorizes `pick` selects. */
const carried = (pick: (authorize: Seen) => boolean) =>
	requests("/v1/authorize")
		.filter(pick)
		.reduce((n, r) => n + Number((r.body.params as Record<string, unknown>)?.messages ?? 0), 0);

describe("SessionEnd's one exit sweep: whatever the exit, what it selected and did not post is written down, once", () => {
	const main = transcriptPath;
	// Two jobs, one message in each: every record says by its start which message it is.
	const now = Date.now();
	const at = (offsetS: number) => new Date(now + offsetS * 1000).toISOString();
	const T = { A: at(-40), B: at(-10), V: at(-45) };
	const jobLine = (ts: string, op: string, job: string | null) =>
		JSON.stringify({ sid: SESSION, ts, op, job });
	const JOB_LOG = `${[
		jobLine(at(-60), "session-start", null),
		jobLine(at(-50), "start", "job-a"),
		jobLine(at(-30), "stop", null),
		jobLine(at(-20), "start", "job-b"),
		jobLine(at(-5), "stop", null),
	].join("\n")}\n`;
	type Scenario = {
		lines: () => string[];
		prepare?: () => Promise<void>;
		budgetMs?: number;
		fault?: string;
		/** Messages the remainder selected: the transcript's, unless it never read them. */
		selected: number;
		posted: number;
		refused?: number;
		/** The messages each kind of record names, by its start: one record per job, so per message. */
		recorded?: Array<keyof typeof T>;
		deferred: Array<keyof typeof T>;
		/** Agents written down whole, their usage never read. */
		agents?: string[];
		why?: string;
		said?: string;
	};
	const A = () => response("msg_a", SONNET, T.A);
	const B = () => response("msg_b", HAIKU, T.B);
	const V = () => response("msg_v", HAIKU, T.V);
	const TWO = () => [A(), B()];
	/** A Stop leaves an unresolved vehicle (haiku, under a key) for SessionEnd to retry first. */
	const vehicleFirst = async () => {
		capabilities = ["idempotency-key"];
		await writeLines(main(), [V()]);
		fixed.set("/v1/settle#1", { status: 503, json: { error: "unavailable" } });
		await run("stop", stopInput());
		nodeFs.rmSync(join(stateDir, "watch.jsonl"), { force: true });
		seen = [];
		counts = new Map();
		fixed = new Map();
		await writeLines(main(), [V(), A()]);
	};
	const scenarios: Array<[string, Scenario]> = [
		["every group posted (the control)", { lines: TWO, selected: 2, posted: 2, deferred: [] }],
		[
			"a group refused (402)",
			{
				lines: TWO,
				prepare: async () => {
					fixed.set("/v1/authorize#1", ANSWER.refusal402 as Reply);
				},
				selected: 2,
				posted: 1,
				refused: 1,
				deferred: [],
			},
		],
		["nothing new to post", { lines: () => [], selected: 0, posted: 0, deferred: [] }],
		[
			"selection: out of time to claim",
			{
				lines: TWO,
				budgetMs: 0,
				selected: 2,
				posted: 0,
				deferred: ["A", "B"],
				why: "not claimed (out of time)",
			},
		],
		[
			"selection: a claim that fails",
			{
				lines: TWO,
				prepare: async () => {
					await mkdir(join(stateDir, "transcripts", "claims"), { recursive: true, mode: 0o700 });
					await chmod(join(stateDir, "transcripts", "claims"), 0o500);
				},
				selected: 2,
				posted: 0,
				deferred: ["A", "B"],
				why: "could not be claimed (EACCES)",
			},
		],
		[
			"selection: a message an earlier settle point claimed and did not post",
			{
				lines: TWO,
				prepare: async () => {
					// Stop claims both, and the server stops answering at the first group's authorize: the
					// first group is released, the second never tried, and SessionEnd finds both claimed.
					aim("/v1/authorize", 1, "timeout", null);
					await run("stop", stopInput());
					nodeFs.rmSync(join(stateDir, "watch.jsonl"), { force: true });
					seen = [];
					counts = new Map();
					aimed = null;
				},
				budgetMs: 0,
				selected: 2,
				posted: 0,
				// A released group keeps its claims: both are this agent's own, and neither is posted.
				deferred: ["A", "B"],
				why: "not posted (out of time)",
			},
		],
		[
			"the retry loop: out of time",
			{
				lines: () => [V(), A()],
				prepare: vehicleFirst,
				fault: "__main.json|1|sleep 800",
				selected: 1,
				posted: 0,
				deferred: ["A"],
				why: "not posted (out of time)",
				said: "unresolved settles: deferred to the next settle point (out of time)",
			},
		],
		[
			"the retry loop: the server stops answering",
			{
				lines: () => [V(), A()],
				prepare: async () => {
					await vehicleFirst();
					capabilities = ["idempotency-key"];
					aim("/v1/authorize", 1, "timeout", null);
				},
				selected: 1,
				posted: 0,
				deferred: ["A"],
				why: "not posted (the server stopped answering)",
			},
		],
		[
			"the group loop: out of time",
			{
				lines: TWO,
				fault: "__main.json|3|sleep 900",
				selected: 2,
				posted: 1,
				deferred: ["B"],
				why: "not posted (out of time)",
				said: `${HAIKU}: deferred to the next settle point (out of time)`,
			},
		],
		[
			"the group loop: the server stops answering",
			{
				lines: TWO,
				prepare: async () => aim("/v1/authorize", 1, "timeout", null),
				selected: 2,
				posted: 0,
				recorded: ["A"],
				deferred: ["B"],
				why: "not posted (the server stopped answering)",
			},
		],
		[
			"an error after selection (the cursor's save fails)",
			{
				lines: TWO,
				fault: "__main.json|1|throw",
				selected: 2,
				posted: 0,
				deferred: ["A", "B"],
				why: "not posted (an error ended it (injected rename failure))",
			},
		],
		[
			"an error after a group settled (its cursor save fails)",
			{
				lines: TWO,
				fault: "__main.json|3|throw",
				selected: 2,
				posted: 1,
				deferred: ["B"],
				why: "not posted (an error ended it (injected rename failure))",
			},
		],
		[
			"an error after every group posted (the last cursor save fails)",
			{ lines: TWO, fault: "__main.json|5|throw", selected: 2, posted: 2, deferred: [] },
		],
		[
			"the agent's lock is busy",
			{
				lines: TWO,
				prepare: async () => {
					const lock = join(stateDir, "transcripts", `${SESSION}__main.json.lock`);
					await mkdir(lock, { recursive: true });
					await writeFile(join(lock, "owner"), "another hook");
				},
				selected: 0,
				posted: 0,
				deferred: [],
				agents: ["main"],
				why: "another hook holds this agent's lock",
			},
		],
		[
			"the agent's state is unavailable",
			{
				lines: TWO,
				prepare: async () => {
					await writeFile(join(stateDir, "transcripts", `${SESSION}__main.json`), "{ not a cursor");
				},
				selected: 0,
				posted: 0,
				deferred: [],
				agents: ["main"],
				why: "transcript state unavailable",
			},
		],
		[
			"the agent settles at the estimate (nothing to post)",
			{
				lines: TWO,
				prepare: async () => {
					await mkdir(join(stateDir, "transcripts", "estimate"), { recursive: true, mode: 0o700 });
					await writeFile(join(stateDir, "transcripts", "estimate", `${SESSION}__main`), "");
				},
				selected: 0,
				posted: 0,
				deferred: [],
			},
		],
		[
			"an agent after the server stopped answering",
			{
				lines: () => [A()],
				prepare: async () => {
					const subagents = join(projectDir, SESSION, "subagents");
					await mkdir(subagents, { recursive: true });
					await writeLines(join(subagents, "agent-a1.jsonl"), [response("msg_s", HAIKU, T.B)]);
					aim("/v1/authorize", 1, "timeout", null);
				},
				selected: 1,
				posted: 0,
				recorded: ["A"],
				deferred: [],
				agents: ["a1"],
				why: "the server stopped answering, so this agent's usage was not posted",
			},
		],
	];
	it.each(scenarios)(
		"%s",
		async (_, scenario) => {
			await backdate();
			await mkdir(join(stateDir, "jobs"), { recursive: true });
			await writeFile(join(stateDir, "jobs", `${SESSION}.jsonl`), JOB_LOG);
			await writeLines(main(), scenario.lines());
			await scenario.prepare?.();
			const end = await runHook(
				join(HOOKS, "session-end.mjs"),
				seInput(),
				envFor({
					...seBudget(scenario.budgetMs ?? 1_200),
					...(scenario.fault === undefined ? {} : { UT_CC_FAULT: scenario.fault }),
				}),
				scenario.fault === undefined ? [] : ["--import", FAULT_AT],
			);
			await chmod(join(stateDir, "transcripts", "claims"), 0o700).catch(() => {});
			// A retried vehicle's own record (haiku, its start unknown) is not the fresh messages'.
			const vehicle = scenario.lines().some((line) => line.includes("msg_v"));
			const remainder = (await phased("remainder")).filter(
				(record) => !vehicle || record.model !== HAIKU,
			);
			const deferred = remainder.filter((r) => r.outcome === "deferred");
			const ofMessages = deferred.filter((r) => r.messages !== undefined && r.agent === "main");
			const whole = deferred.filter((r) => r.messages === undefined).map((r) => r.agent);
			const recorded = remainder.filter((r) => r.outcome !== "deferred");
			const sum = (rs: WatchRecord[]) => rs.reduce((n, r) => n + Number(r.messages ?? 0), 0);
			const startedOf = (rs: WatchRecord[]) => rs.map((r) => String(r.started)).sort();
			const settled = new Set(
				requests("/v1/settle")
					.filter((r) => answered(r, 200) && replyJson(r)?.settled !== false)
					.map((r) => r.body.transferId),
			);
			const posted = carried((r) => answered(r, 200) && settled.has(replyJson(r)?.transferId));
			const refused = carried((r) => answered(r, 402));
			// The sweep's defining property: every message selected is posted, refused, written down
			// by its group, or deferred by the sweep, exactly one of these; and each record names, by
			// its start, the very message it is about.
			expect({
				posted,
				refused,
				recorded: startedOf(recorded),
				deferred: startedOf(ofMessages),
			}).toEqual({
				posted: scenario.posted,
				refused: scenario.refused ?? 0,
				recorded: (scenario.recorded ?? []).map((m) => T[m]).sort(),
				deferred: scenario.deferred.map((m) => T[m]).sort(),
			});
			expect(posted + refused + sum(recorded) + sum(ofMessages)).toBe(scenario.selected);
			expect(whole.sort()).toEqual(scenario.agents ?? []);
			if (scenario.why !== undefined) {
				for (const record of deferred) expect(String(record.reason)).toContain(scenario.why);
			}
			if (scenario.said !== undefined) expect(end.stderr).toContain(scenario.said);
		},
		LONG,
	);
});

describe("one writer for a remainder's records: each job's record starts at that job's own first message, whatever the server says of `job`", () => {
	const now = Date.now();
	const at = (offsetS: number) => new Date(now + offsetS * 1000).toISOString();
	const line = (ts: string, op: string, job: string | null) =>
		JSON.stringify({ sid: SESSION, ts, op, job });
	const log = `${[
		line(at(-60), "session-start", null),
		line(at(-50), "start", "job-a"),
		line(at(-30), "stop", null),
		line(at(-20), "start", "job-b"),
		line(at(-5), "stop", null),
	].join("\n")}\n`;
	const states: Array<[string, () => void]> = [
		[
			"`job` honoured",
			() => {
				capabilities = ["job"];
			},
		],
		[
			"`job` absent",
			() => {
				capabilities = [];
			},
		],
		[
			"capabilities unknown",
			() => {
				for (let n = 1; n <= 4; n += 1) fixed.set(`/v1/health#${n}`, ANSWER.error5xx as Reply);
			},
		],
	];
	const endings: Array<[string, string, () => void, "stop" | "session-end"]> = [
		[
			"Stop, an authorize refused (400)",
			"released",
			() => {
				for (let n = 1; n <= 2; n += 1) fixed.set(`/v1/authorize#${n}`, ANSWER.other4xx as Reply);
			},
			"stop",
		],
		[
			"Stop, a settle answered 503",
			"claimed",
			() => {
				for (let n = 1; n <= 2; n += 1) fixed.set(`/v1/settle#${n}`, ANSWER.error5xx as Reply);
			},
			"stop",
		],
		[
			"Stop, a settle answered settled:false",
			"claimed",
			() => {
				for (let n = 1; n <= 2; n += 1) fixed.set(`/v1/settle#${n}`, ANSWER.unsettled as Reply);
			},
			"stop",
		],
		["SessionEnd, out of time", "deferred", () => {}, "session-end"],
	];
	const cases = states.flatMap(([state, setState]) =>
		endings.map(
			([ending, outcome, setEnding, hook]) =>
				[state, ending, outcome, setState, setEnding, hook] as const,
		),
	);
	it.each(cases)(
		"%s × %s: one %s record per job, each at its own first message",
		async (_, __, outcome, setState, setEnding, hook) => {
			await backdate();
			await mkdir(join(stateDir, "jobs"), { recursive: true });
			await writeFile(join(stateDir, "jobs", `${SESSION}.jsonl`), log);
			await writeLines(transcriptPath(), [
				response("msg_a", SONNET, at(-40)),
				response("msg_b", SONNET, at(-10)),
			]);
			setState();
			setEnding();
			if (hook === "stop") await run("stop", stopInput());
			else await run("session-end", seInput(), seBudget(0));
			const written = await phased("remainder");
			expect(
				written
					.map((r) => ({ outcome: r.outcome, started: r.started, messages: r.messages }))
					.sort((x, y) => String(x.started).localeCompare(String(y.started))),
			).toEqual([
				{ outcome, started: at(-40), messages: 1 },
				{ outcome, started: at(-10), messages: 1 },
			]);
			const { jobCoverage } = (await import(pathToFileURL(join(HOOKS, "job-log.mjs")).href)) as {
				jobCoverage(args: {
					job: string;
					logs: Record<string, string>;
					records: unknown[];
					watch: unknown[];
				}): { knownGaps: Array<{ gap: string }> };
			};
			for (const job of ["job-a", "job-b"]) {
				const coverage = jobCoverage({
					job,
					logs: { [SESSION]: log },
					records: [],
					watch: written,
				});
				expect(coverage.knownGaps.map((gap) => gap.gap)).toContain(
					`session ${SESSION}: a gap fell inside an interval of ${job}`,
				);
			}
		},
		LONG,
	);

	// A job log no hook can read whole: no start can be vouched for, so the record has none. Read
	// whole later (repaired, or its torn line completed), it must still be a gap of every job.
	const unusable: Array<[string, () => Promise<void>]> = [
		[
			"a torn job log (its last line unfinished)",
			async () => {
				await mkdir(join(stateDir, "jobs"), { recursive: true });
				await writeFile(join(stateDir, "jobs", `${SESSION}.jsonl`), log.slice(0, -1));
			},
		],
		[
			"an unreadable job log (a directory in its place)",
			async () => {
				await mkdir(join(stateDir, "jobs", `${SESSION}.jsonl`), { recursive: true });
			},
		],
	];
	const where: Array<[string, string, () => void, "stop" | "session-end"]> = [
		[
			"Stop, an authorize refused (400)",
			"released",
			() => {
				fixed.set("/v1/authorize#1", ANSWER.other4xx as Reply);
			},
			"stop",
		],
		["SessionEnd, out of time", "deferred", () => {}, "session-end"],
	];
	it.each(
		unusable.flatMap(([what, spoil]) =>
			where.map(
				([ending, outcome, setEnding, hook]) =>
					[what, ending, outcome, spoil, setEnding, hook] as const,
			),
		),
	)(
		"%s × %s: one %s record, started at null, and a gap of every job once the log reads whole",
		async (_, __, outcome, spoil, setEnding, hook) => {
			await backdate();
			await spoil();
			await writeLines(transcriptPath(), [
				response("msg_a", SONNET, at(-40)),
				response("msg_b", SONNET, at(-10)),
			]);
			setEnding();
			if (hook === "stop") await run("stop", stopInput());
			else await run("session-end", seInput(), seBudget(0));
			const written = await phased("remainder");
			expect(
				written.map((r) => ({ outcome: r.outcome, started: r.started, messages: r.messages })),
			).toEqual([{ outcome, started: null, messages: 2 }]);
			const { jobCoverage } = (await import(pathToFileURL(join(HOOKS, "job-log.mjs")).href)) as {
				jobCoverage(args: {
					job: string;
					logs: Record<string, string>;
					records: unknown[];
					watch: unknown[];
				}): { knownGaps: Array<{ gap: string }> };
			};
			for (const job of ["job-a", "job-b"]) {
				const coverage = jobCoverage({
					job,
					logs: { [SESSION]: log },
					records: [],
					watch: written,
				});
				expect(coverage.knownGaps.map((gap) => gap.gap)).toContain(
					`a gap cannot be attributed to a job (its time is unreadable): it may belong to ${job}`,
				);
			}
		},
		LONG,
	);
});

describe("every hold state SessionEnd can meet, and what it writes down", () => {
	const STALE = (Date.now() - 11 * 60_000) / 1000;
	const makeStale = async (call: string, transferId: string, kind: string) =>
		utimes(join(stateDir, holdName(call, transferId, "main", kind)), STALE, STALE);
	const busyLock = async () => {
		const lock = join(stateDir, "transcripts", `${SESSION}__main.json.lock`);
		await mkdir(lock, { recursive: true });
		await writeFile(join(lock, "owner"), "another hook");
	};
	type Row = {
		/** The hold, as SessionEnd finds it. */
		seed: () => Promise<void>;
		mode?: Record<string, string>;
		budgetMs?: number;
		/** Every gap SessionEnd writes, in order. */
		gaps: Array<Record<string, unknown>>;
	};
	const tx = { transferId: "tx_1" };
	const rows: Array<[string, Row]> = [
		[
			"an estimate hold, pending (.json): its call may have run uncharged",
			{
				seed: () => seedHold("tu_1", "tx_1", ESTIMATE),
				mode: ESTIMATE_MODE,
				gaps: [{ ...tx, tool: "(unconfirmed)", releaseClass: "call-unconfirmed" }],
			},
		],
		[
			"an estimate hold, settle-attempted (.settling), fresh: its call ran",
			{
				seed: () => seedHold("tu_1", "tx_1", ESTIMATE, "settling"),
				mode: ESTIMATE_MODE,
				gaps: [{ ...tx, tool: "(unconfirmed)", releaseClass: "call-ran" }],
			},
		],
		[
			"an estimate hold, settle-attempted (.settling), stale: the journal writes its call down, under its transferId",
			{
				seed: async () => {
					await seedHold("tu_1", "tx_1", ESTIMATE, "settling");
					await makeStale("tu_1", "tx_1", "settling");
				},
				gaps: [{ ...tx, tool: "(unconfirmed)", releaseClass: "call-ran" }],
			},
		],
		[
			"a hold claimed only to end a deferred call's (.releasing): given back, nothing written",
			{
				seed: () => seedHold("tu_1", "tx_1", ESTIMATE, "releasing"),
				mode: ESTIMATE_MODE,
				gaps: [],
			},
		],
		[
			"a transcript hold with its window, pending (.json): settled, nothing written",
			{ seed: () => seedHold("tu_1", "tx_1", WINDOW), gaps: [] },
		],
		[
			"a transcript hold with its window, pending (.json), out of time: its settle deferred",
			{
				seed: () => seedHold("tu_1", "tx_1", WINDOW),
				budgetMs: 0,
				gaps: [{ ...tx, phase: "settle", outcome: "deferred" }],
			},
		],
		[
			"a transcript hold with no usage, pending (.json): given back, nothing written",
			{ seed: () => seedHold("tu_1", "tx_1", EMPTY), gaps: [] },
		],
		[
			"a transcript hold whose settle is in flight (.settling), fresh: unknown",
			{
				seed: () => seedHold("tu_1", "tx_1", WINDOW, "settling"),
				gaps: [{ ...tx, phase: "settle", outcome: "unknown", messages: 1 }],
			},
		],
		[
			"a transcript hold whose settle is in flight (.settling), fresh, its agent's lock busy: unknown, beside the agent's own",
			{
				seed: async () => {
					await seedHold("tu_1", "tx_1", WINDOW, "settling");
					await busyLock();
				},
				gaps: [
					{ ...tx, phase: "settle", outcome: "unknown", messages: 1 },
					{ phase: "remainder", outcome: "deferred", agent: "main" },
				],
			},
		],
		[
			"a transcript hold whose settle is in flight (.settling), stale: claimed, its window accounted",
			{
				seed: async () => {
					await seedHold("tu_1", "tx_1", WINDOW, "settling");
					await makeStale("tu_1", "tx_1", "settling");
				},
				gaps: [{ ...tx, phase: "settle", outcome: "claimed", messages: 1 }],
			},
		],
		[
			"a transcript hold whose settle is in flight (.settling) under a key, stale: unresolved, retried as itself",
			{
				seed: async () => {
					await seedHold("tu_1", "tx_1", KEYED, "settling");
					await makeStale("tu_1", "tx_1", "settling");
				},
				gaps: [{ ...tx, phase: "settle", outcome: "unresolved", messages: 1 }],
			},
		],
		[
			"a finished hold (.done): its outcome applied, nothing written",
			{ seed: () => seedHold("tu_1", "tx_1", { ...WINDOW, outcome: "settled" }, "done"), gaps: [] },
		],
	];
	it.each(rows)(
		"%s",
		async (_, row) => {
			capabilities = ["release"];
			await writeTranscript();
			await row.seed();
			await run("session-end", seInput(), {
				...(row.mode ?? {}),
				...seBudget(row.budgetMs ?? 1_200),
			});
			const written = await gaps();
			expect(written).toMatchObject(row.gaps);
			expect(written).toHaveLength(row.gaps.length);
		},
		LONG,
	);
});

describe("every gap that carries transcript usage is dated by one rule: its job-labelled start, else null", () => {
	const now = Date.now();
	const at = (offsetS: number) => new Date(now + offsetS * 1000).toISOString();
	const jobLine = (ts: string, op: string, job: string | null) =>
		JSON.stringify({ sid: SESSION, ts, op, job });
	// Job A, then job B. The window's message is A's; the tool call that holds it is B's.
	const LOG = `${[
		jobLine(at(-60), "session-start", null),
		jobLine(at(-50), "start", "job-a"),
		jobLine(at(-30), "stop", null),
		jobLine(at(-20), "start", "job-b"),
		jobLine(at(-5), "stop", null),
	].join("\n")}\n`;
	const CALL = at(-10);
	const coverageOf = async (job: string, watch: WatchRecord[]) => {
		const { jobCoverage } = (await import(pathToFileURL(join(HOOKS, "job-log.mjs")).href)) as {
			jobCoverage(args: {
				job: string;
				logs: Record<string, string>;
				records: unknown[];
				watch: unknown[];
			}): { knownGaps: Array<{ gap: string }> };
		};
		return jobCoverage({ job, logs: { [SESSION]: LOG }, records: [], watch }).knownGaps.map(
			(gap) => gap.gap,
		);
	};
	/** What job A's coverage must say of a gap dated `started`: a gap of job A either way. */
	const gapOfJobA = (started: string | null) =>
		started === null
			? "cannot be attributed to a job (its time is unreadable): it may belong to job-a"
			: "fell inside an interval of job-a";
	const labelStates: Array<[string, Record<string, unknown>, string | null]> = [
		["no job label (a server without `job`): a job switch inside the hold", {}, null],
		[
			"an untrusted job log (`jobState: invalid`)",
			{ jobState: "invalid", usageFrom: at(-40) },
			null,
		],
		["a job label", { job: "job-a", usageFrom: at(-40) }, at(-40)],
	];
	const windowHold = (labels: Record<string, unknown>) => ({
		...WINDOW,
		startedAt: CALL,
		...labels,
	});
	const openBreakerNow = async () => {
		const file = join(
			breakerDir(),
			`${createHash("sha256").update(url).digest("hex").slice(0, 16)}.json`,
		);
		await mkdir(breakerDir(), { recursive: true, mode: 0o700 });
		await writeFile(
			file,
			JSON.stringify({ openUntil: Date.now() + 60_000, openedAt: Date.now(), timeouts: [] }),
			{ mode: 0o600 },
		);
	};
	const holdWriters: Array<
		[string, (labels: Record<string, unknown>) => Promise<void>, (r: WatchRecord) => boolean]
	> = [
		[
			"PostToolUse's settle of a transcript hold (503: claimed)",
			async (labels) => {
				capabilities = ["release"];
				await seedHold("tu_1", "tx_1", windowHold(labels));
				fixed.set("/v1/settle#1", ANSWER.error5xx as Reply);
				await run("post-tool-use", postInput("tu_1"));
			},
			(r) => r.kind === "gap" && r.phase === "settle",
		],
		[
			"Stop's settle of a leftover transcript hold (503: claimed)",
			async (labels) => {
				capabilities = ["release"];
				await seedHold("tu_1", "tx_1", windowHold(labels));
				fixed.set("/v1/settle#1", ANSWER.error5xx as Reply);
				await run("stop", stopInput());
			},
			(r) => r.kind === "gap" && r.phase === "settle",
		],
		[
			"Stop's drop of a hold made under another server (abandon)",
			async (labels) => {
				await seedHold("tu_1", "tx_1", {
					...windowHold(labels),
					serverUrl: "http://elsewhere.invalid",
					keyHash: "x",
				});
				await run("stop", stopInput());
			},
			(r) => r.kind === "gap" && r.phase === "abandon",
		],
		[
			"SessionEnd's sweep of a settle in flight (unknown)",
			async (labels) => {
				await writeTranscript();
				await seedHold("tu_1", "tx_1", windowHold(labels), "settling");
				await run("session-end", seInput(), seBudget(1_200));
			},
			(r) => r.kind === "gap" && r.phase === "settle",
		],
		[
			"a reconcile's decision on a stale settle in flight (claimed)",
			async (labels) => {
				await writeTranscript();
				await seedHold("tu_1", "tx_1", windowHold(labels), "settling");
				const stale = (Date.now() - 11 * 60_000) / 1000;
				await utimes(join(stateDir, holdName("tu_1", "tx_1", "main", "settling")), stale, stale);
				await run("stop", stopInput());
			},
			(r) => r.kind === "gap" && r.phase === "settle",
		],
		[
			"PreToolUse's drop of a repeated call's stale settle made under another server (call-ran)",
			async (labels) => {
				await writeTranscript();
				await seedHold(
					"tu_1",
					"tx_1",
					{ ...windowHold(labels), serverUrl: "http://elsewhere.invalid", keyHash: "x" },
					"settling",
				);
				const stale = (Date.now() - 11 * 60_000) / 1000;
				await utimes(join(stateDir, holdName("tu_1", "tx_1", "main", "settling")), stale, stale);
				await run("pre-tool-use", preInput("tu_1"));
			},
			(r) => r.kind === "gap" && r.tool === "(unconfirmed)" && r.releaseClass === "call-ran",
		],
		[
			"PostToolUse under an open breaker (its transcript hold deferred)",
			async (labels) => {
				await openBreakerNow();
				await seedHold("tu_1", "tx_1", windowHold(labels));
				await run("post-tool-use", postInput("tu_1"));
			},
			(r) => r.kind === "deferred",
		],
	];
	it.each(
		holdWriters.flatMap(([writer, play, pick]) =>
			labelStates.map(
				([state, labels, started]) => [writer, state, labels, started, play, pick] as const,
			),
		),
	)(
		"%s, %s: started at its window's job-labelled start, else null; a gap of the earlier job",
		async (_, __, labels, started, play, pick) => {
			await play(labels);
			const written = (await records()).filter(pick);
			expect(written.map((r) => r.started)).toEqual([started]);
			const gapsOfA = await coverageOf("job-a", written);
			expect(
				gapsOfA.some((gap) => gap.includes(gapOfJobA(started))),
				gapsOfA.join(" | "),
			).toBe(true);
		},
		LONG,
	);
	it("a give-back carries no usage, and keeps its call's time", async () => {
		capabilities = ["release"];
		await seedHold("tu_1", "tx_1", { ...EMPTY, startedAt: CALL });
		fixed.set("/v1/release#1", ANSWER.other4xx as Reply);
		await run("post-tool-use", postInput("tu_1"));
		expect((await phased("release")).map((r) => r.started)).toEqual([CALL]);
	});

	// The group-level writers with labels: a job log torn (untrusted) or whole.
	const logs: Array<[string, string, string | null]> = [
		["a torn job log", LOG.slice(0, -1), null],
		["a whole job log", LOG, at(-40)],
	];
	const sendLabelled = async (text: string) => {
		await backdate();
		await mkdir(join(stateDir, "jobs"), { recursive: true });
		await writeFile(join(stateDir, "jobs", `${SESSION}.jsonl`), text);
		await writeLines(transcriptPath(), [response("msg_a", SONNET, at(-40))]);
	};
	it.each(logs)(
		"a refused remainder (would_block) under %s: started at its job's start, else null",
		async (_, text, started) => {
			capabilities = ["job"];
			await sendLabelled(text);
			fixed.set("/v1/authorize#1", ANSWER.refusal402 as Reply);
			await run("stop", stopInput());
			const refused = (await records()).filter((r) => r.kind === "would_block");
			expect(refused.map((r) => r.started)).toEqual([started]);
		},
		LONG,
	);
	/** A Stop parks an unresolved vehicle, under a key, with the labels its job log gave. */
	const parkVehicle = async (text: string) => {
		capabilities = ["job", "idempotency-key"];
		await sendLabelled(text);
		fixed.set("/v1/settle#1", ANSWER.error5xx as Reply);
		await run("stop", stopInput());
		nodeFs.rmSync(join(stateDir, "watch.jsonl"), { force: true });
	};
	it.each(logs)(
		"a retried vehicle's gap under %s: started at its job's start, else null",
		async (_, text, started) => {
			await parkVehicle(text);
			fixed.set("/v1/settle#2", ANSWER.error5xx as Reply);
			await run("stop", stopInput());
			expect((await phased("remainder")).map((r) => r.started)).toEqual([started]);
		},
		LONG,
	);
	it.each(logs)(
		"a vehicle made under another server, dropped (abandon), under %s: started at its job's start, else null",
		async (_, text, started) => {
			await parkVehicle(text);
			forgetPins(envFor());
			url = await startServer();
			await run("stop", stopInput());
			expect((await phased("abandon")).map((r) => r.started)).toEqual([started]);
		},
		LONG,
	);
});

describe("a redirect the plugin follows by hand: to the same origin, a 307 or a 308, up to twenty", () => {
	/** A transcript hold's settle, unkeyed: `claimed` when it may have posted, `released` when not. */
	const settleTranscriptHold = async () => {
		capabilities = ["release"];
		await seedHold("tu_1", "tx_1", WINDOW);
		return run("post-tool-use", postInput("tu_1"));
	};
	const to = (location: string, status = 307): Reply => ({
		status,
		json: { moved: true },
		headers: { location },
	});
	it.each<[number, string]>([
		[307, "absolute"],
		[308, "relative"],
	])(
		"a same-origin %i (%s Location): followed once, with the same method, body and key; settled",
		async (status, form) => {
			fixed.set(
				"/v1/settle#1",
				to(form === "absolute" ? `${url}/v1/settle` : "/v1/settle", status),
			);
			await settleTranscriptHold();
			const settles = requests("/v1/settle");
			expect(settles).toHaveLength(2);
			expect(settles[0]?.auth).toBe("Bearer k");
			expect(settles[1]).toMatchObject({
				method: "POST",
				body: settles[0]?.body,
				auth: "Bearer k",
			});
			expect(await records()).toEqual([]);
			expect(await holdFiles()).toEqual([]);
		},
	);
	it("a chain of two same-origin redirects: both followed, each with the same request; settled", async () => {
		fixed.set("/v1/settle#1", to("/v1/settle"));
		fixed.set("/v1/settle#2", to(`${url}/v1/settle`, 308));
		await settleTranscriptHold();
		const settles = requests("/v1/settle");
		expect(settles).toHaveLength(3);
		for (const hop of settles) {
			expect(hop).toMatchObject({ method: "POST", body: settles[0]?.body, auth: "Bearer k" });
		}
		expect(await records()).toEqual([]);
	});
	it("twenty-one same-origin redirects: twenty are followed, and the twenty-first is the answer: claimed", async () => {
		for (let n = 1; n <= 21; n += 1) fixed.set(`/v1/settle#${n}`, to("/v1/settle"));
		await settleTranscriptHold();
		expect(requests("/v1/settle")).toHaveLength(21);
		expect(await phased("settle")).toMatchObject([{ outcome: "claimed", transferId: "tx_1" }]);
	});
	it("a same-origin redirect, then one to another origin: followed to the other origin's, and no further: claimed", async () => {
		let reached = 0;
		const other = createServer((req, res) => {
			reached += 1;
			req.resume();
			res.writeHead(200, { "content-type": "application/json", connection: "close" });
			res.end(JSON.stringify({ settled: true }));
		});
		servers.push(other);
		await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()));
		const port = (other.address() as { port: number }).port;
		fixed.set("/v1/settle#1", to("/v1/settle"));
		fixed.set("/v1/settle#2", to(`http://127.0.0.1:${port}/v1/settle`));
		await settleTranscriptHold();
		expect(reached).toBe(0);
		expect(requests("/v1/settle")).toHaveLength(2);
		expect(await phased("settle")).toMatchObject([{ outcome: "claimed", transferId: "tx_1" }]);
	});
	it("a 307 to another origin (another port): not followed, and is the answer: claimed", async () => {
		let reached = 0;
		const other = createServer((req, res) => {
			reached += 1;
			req.resume();
			res.writeHead(200, { "content-type": "application/json", connection: "close" });
			res.end(JSON.stringify({ settled: true }));
		});
		servers.push(other);
		await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()));
		const port = (other.address() as { port: number }).port;
		fixed.set("/v1/settle#1", to(`http://127.0.0.1:${port}/v1/settle`));
		await settleTranscriptHold();
		expect(reached).toBe(0);
		expect(requests("/v1/settle")).toHaveLength(1);
		expect(await phased("settle")).toMatchObject([{ outcome: "claimed", transferId: "tx_1" }]);
	});
	it.each([301, 302, 303])(
		"a same-origin %i: not followed, and is the answer: claimed",
		async (status) => {
			fixed.set("/v1/settle#1", to("/v1/settle", status));
			await settleTranscriptHold();
			expect(requests("/v1/settle")).toHaveLength(1);
			expect(await phased("settle")).toMatchObject([{ outcome: "claimed", transferId: "tx_1" }]);
		},
	);
	it("a followed request whose next hop is refused was sent all the same: claimed, never released", async () => {
		fixed.set("/v1/settle#1", to(`${url}/v1/settle`));
		closeAfter = { path: "/v1/settle", nth: 1 };
		await settleTranscriptHold();
		expect(requests("/v1/settle")).toHaveLength(1);
		expect(await phased("settle")).toMatchObject([{ outcome: "claimed", transferId: "tx_1" }]);
	});
	it(
		"a followed request whose next hop times out: claimed, never released",
		async () => {
			fixed.set("/v1/settle#1", to("/v1/settle"));
			fixed.set("/v1/settle#2", "hang");
			await settleTranscriptHold();
			expect(requests("/v1/settle")).toHaveLength(2);
			expect(await phased("settle")).toMatchObject([{ outcome: "claimed", transferId: "tx_1" }]);
		},
		LONG,
	);
	it("the capability probe follows a same-origin 308: the capabilities are known", async () => {
		fixed.set("/v1/health#1", to("/v1/health", 308));
		const pre = await run("pre-tool-use", preInput("tu_1"), ESTIMATE_MODE);
		expect(requests("/v1/health")).toHaveLength(2);
		expect(pre.stderr).not.toContain("capabilities are unknown");
	});
});
