// Every request a hook sends to the governance server, against every way it can end: the
// outcome each call site gives that ending, and the record it writes. One test per cell of the
// plugin's endings table (a call site × an ending); a cell no request can reach is not here, and
// the table says why. Each hook runs as Claude Code runs it (helpers/run-hook.ts): its own node
// process, against a fake server that answers by route, with a passwd home of the test's own.
//
// The endings: an answer (200), a 200 whose ledger post was ambiguous (`settled: false`), a 404
// `unknown transferId` (the server holds no such hold), another 4xx, a 5xx, no answer before this
// hook's own timer (`hang`), a connection refused before anything was sent (the server stops
// listening first), and a connection dropped once the request went out.
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const SESSION = "55555555-2222-4333-8444-666666666666";
const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5";

type Answer = { status: number; json?: unknown; delayMs?: number };
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
	| "dropped";

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
};

interface Seen {
	method: string;
	path: string;
	body: Record<string, unknown>;
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
				seen.push({ method: req.method ?? "", path, body });
				const reply = replyFor(path, nth);
				if (reply === "hang") return;
				if (reply === "drop") {
					req.socket.destroy();
					return;
				}
				const send = () => {
					if (closeAfter !== null && closeAfter.path === path && closeAfter.nth === nth) {
						res.on("finish", () => server.close());
					}
					res.writeHead(reply.status, { "content-type": "application/json", connection: "close" });
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
	it.each<Ending>(["other4xx", "refusal402", "error5xx", "timeout", "refused", "dropped"])(
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
	it.each<Ending>(["other4xx", "error5xx", "timeout", "refused", "dropped"])(
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
	it.each<Ending>(["other4xx", "error5xx", "timeout", "refused", "dropped"])(
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
		["settling", "other4xx", "failed"],
		["settling", "other404", "failed"],
		["settling", "error5xx", "failed"],
		["settling", "timeout", "unknown"],
		["settling", "refused", "failed"],
		["settling", "dropped", "unknown"],
	])(
		"a .%s hold, %s: its call's gap, and a release gap, %s",
		async (kind, ending, outcome) => {
			await go(ending, kind);
			expect(await unconfirmed()).toHaveLength(1);
			expect(await phased("release")).toMatchObject([{ outcome, transferId: "tx_1" }]);
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
	it.each<Ending>(["ok", "other4xx", "error5xx"])(
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
});
