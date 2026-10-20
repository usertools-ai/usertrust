// A hold past its life is never settled. usertrust-server states each hold's remaining life on
// its authorize answer (`expiresInMs`, `hold-expiry`); PreToolUse records when that ends on this
// machine's clock (lib.mjs `holdExpiresAt`). A tool call that outlives it (a long Bash, a long
// permission prompt) finds its hold voided by the ledger's pending timeout, and a settle could
// only fail, as a 410 `settlement_unrecoverable` the server records as spend it never charged.
// So PostToolUse sends none, and the hold takes the path a gone answer takes: an estimate hold's
// call is charged once on a fresh hold, a transcript hold's window goes back for a later settle
// point (or, under a key, is retried under it). An older server states no life: nothing changes.
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const SESSION_START = join(HOOKS, "session-start.mjs");
const PRE = join(HOOKS, "pre-tool-use.mjs");
const POST = join(HOOKS, "post-tool-use.mjs");
const STOP = join(HOOKS, "stop.mjs");

const SESSION = "sess-expiry";
const OPUS = "claude-opus-5-5";
const ESTIMATE = { UT_CC_USAGE: "estimate" };

interface Seen {
	path: string;
	body: {
		transferId?: string;
		idempotencyKey?: string;
		inputTokens?: number;
		params?: { replaces?: string };
	};
}

let server: Server | undefined;
let seen: Seen[];
let stateDir: string;
let projectDir: string;
let env: Record<string, string>;
/** The life each authorize answer states, in ms; undefined for an older server that states none. */
let life: number | undefined;
/** The capabilities /v1/health publishes. */
let capabilities: string[];
/** How a release (or, on a server without one, an abort) is answered. */
let giveBackAnswer: { status: number; json: unknown };
let nextTransfer: number;

function startFake(): Promise<number> {
	seen = [];
	nextTransfer = 1;
	return new Promise((resolve) => {
		server = createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", () => {
				const reply = (status: number, json: unknown) => {
					res.writeHead(status, { "content-type": "application/json" });
					res.end(JSON.stringify(json));
				};
				if (req.method === "GET" && req.url === "/v1/health") {
					return reply(200, { status: "ok", capabilities });
				}
				const body = JSON.parse(raw || "{}") as Seen["body"];
				seen.push({ path: req.url ?? "", body });
				if (req.url === "/v1/authorize") {
					const transferId = `tx_${nextTransfer++}`;
					return reply(200, {
						transferId,
						estimatedCost: 1,
						...(life === undefined ? {} : { expiresInMs: life }),
					});
				}
				if (req.url === "/v1/settle")
					return reply(200, { settled: true, transferId: body.transferId });
				if (req.url === "/v1/release" || req.url === "/v1/abort") {
					return reply(giveBackAnswer.status, giveBackAnswer.json);
				}
				return reply(404, { reason: "unknown route" });
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server?.address();
			resolve(typeof address === "object" && address !== null ? address.port : 0);
		});
	});
}

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-expiry-"));
	projectDir = await mkdtemp(join(tmpdir(), "utcc-expiry-project-"));
	life = 60_000;
	capabilities = ["hold-expiry", "release"];
	giveBackAnswer = { status: 200, json: { released: true } };
	const port = await startFake();
	env = {
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_KEY: "k",
		UT_SERVER_URL: `http://127.0.0.1:${port}`,
	};
});
afterEach(() => {
	server?.close();
	server = undefined;
});

const settled = () => seen.filter((s) => s.path === "/v1/settle").map((s) => s.body);
const authorizes = () => seen.filter((s) => s.path === "/v1/authorize").map((s) => s.body);
const mainTranscript = () => join(projectDir, `${SESSION}.jsonl`);

/** One complete assistant response, `agoMs` before now. */
function response(id: string, agoMs = 0) {
	return `${JSON.stringify({
		type: "assistant",
		timestamp: new Date(Date.now() - agoMs).toISOString(),
		message: {
			id,
			model: OPUS,
			stop_reason: "tool_use",
			usage: { input_tokens: 10, output_tokens: 5 },
		},
	})}\n`;
}

const call = (toolUseId: string, fields: Record<string, unknown> = {}) => ({
	session_id: SESSION,
	tool_name: "Bash",
	tool_use_id: toolUseId,
	tool_input: { command: "ls" },
	...fields,
});
const pre = (id: string, fields: Record<string, unknown> = {}, extra = {}) =>
	runHook(PRE, call(id, fields), { ...env, ...extra });
const post = (id: string, fields: Record<string, unknown> = {}, extra = {}) =>
	runHook(POST, { ...call(id, fields), tool_response: "ok" }, { ...env, ...extra });
/** Let the stated life run out: a life of 0 ends at the clock read before its authorize. */
const outlive = () => new Promise((resolve) => setTimeout(resolve, 20));

async function holdRecord(): Promise<Record<string, unknown>> {
	const names = (await readdir(stateDir)).filter((name) => name.startsWith(`${SESSION}__main__`));
	expect(names).toHaveLength(1);
	return JSON.parse(await readFile(join(stateDir, names[0] ?? ""), "utf-8")) as Record<
		string,
		unknown
	>;
}

describe("a hold's life, as the server states it", () => {
	it("PreToolUse records when the hold's life ends, counted from the clock read before its authorize", async () => {
		const before = Date.now();
		await pre("tu_1", {}, ESTIMATE);
		const after = Date.now();
		const { expiresAt } = await holdRecord();
		expect(typeof expiresAt).toBe("number");
		expect(expiresAt as number).toBeGreaterThanOrEqual(before + 60_000);
		expect(expiresAt as number).toBeLessThanOrEqual(after + 60_000);
	});

	it("an older server states no life: nothing is recorded, and a late settle is sent as before", async () => {
		life = undefined;
		await pre("tu_1", {}, ESTIMATE);
		expect(Object.hasOwn(await holdRecord(), "expiresAt")).toBe(false);
		await outlive();
		await post("tu_1", {}, ESTIMATE);
		expect(settled().map((s) => s.transferId)).toEqual(["tx_1"]);
	});

	it("an estimate hold within its life is settled as before", async () => {
		await pre("tu_1", {}, ESTIMATE);
		await post("tu_1", {}, ESTIMATE);
		expect(settled().map((s) => s.transferId)).toEqual(["tx_1"]);
		expect(authorizes()).toHaveLength(1);
	});

	it("an estimate hold past its life is never settled: the call is charged once, on a fresh hold", async () => {
		life = 0;
		await pre("tu_1", {}, ESTIMATE);
		await outlive();
		const result = await post("tu_1", {}, ESTIMATE);
		expect(result.code).toBe(0);
		// No settle of the expired hold, so no `settlement_unrecoverable` on the server.
		expect(settled().map((s) => s.transferId)).toEqual(["tx_2"]);
		// Given back first, and only then replaced: the server counts a hold against the budget until
		// its own sweep, so a replacement asked for beside it could be refused.
		const order = seen.map(
			(s) => `${s.path} ${s.body.transferId ?? s.body.params?.replaces ?? ""}`,
		);
		expect(order.indexOf("/v1/release tx_1")).toBeGreaterThan(-1);
		expect(order.indexOf("/v1/release tx_1")).toBeLessThan(order.indexOf("/v1/authorize tx_1"));
		expect(authorizes()[1]?.params?.replaces).toBe("tx_1");
		expect(await readdir(stateDir)).not.toContain(expect.stringContaining("tx_1"));
	});

	it("an estimate hold past its life whose give-back the server does not confirm is settled as before", async () => {
		life = 0;
		await pre("tu_1", {}, ESTIMATE);
		await outlive();
		giveBackAnswer = { status: 503, json: { error: "unavailable" } };
		await post("tu_1", {}, ESTIMATE);
		// Unconfirmed, the hold may still be counted, or still live: its own settle is sent.
		expect(settled().map((s) => s.transferId)).toEqual(["tx_1"]);
		expect(authorizes()).toHaveLength(1);
	});

	it("a transcript hold past its life whose give-back the server does not confirm is settled as before", async () => {
		await runHook(SESSION_START, { session_id: SESSION, source: "startup" }, env);
		await writeFile(mainTranscript(), response("msg_a"));
		life = 0;
		await pre("tu_1", { transcript_path: mainTranscript() });
		await outlive();
		giveBackAnswer = { status: 503, json: { error: "unavailable" } };
		await post("tu_1", { transcript_path: mainTranscript() });
		expect(settled().map((s) => s.transferId)).toContain("tx_1");
	});

	it("a transcript hold past its life is never settled: its window is posted once at Stop", async () => {
		// No keys: the window goes back unkeyed.
		capabilities = ["hold-expiry", "release"];
		await runHook(SESSION_START, { session_id: SESSION, source: "startup" }, env);
		await writeFile(mainTranscript(), response("msg_a"));
		life = 0;
		await pre("tu_1", { transcript_path: mainTranscript() });
		await outlive();
		await post("tu_1", { transcript_path: mainTranscript() });
		expect(settled().map((s) => s.transferId)).not.toContain("tx_1");
		life = 60_000;
		await runHook(
			STOP,
			{ session_id: SESSION, transcript_path: mainTranscript(), stop_hook_active: false },
			env,
		);
		// The window's usage, posted once on a hold of its own; never through the expired one.
		const posts = settled().filter((s) => s.inputTokens === 10);
		expect(posts).toHaveLength(1);
		expect(posts[0]?.transferId).not.toBe("tx_1");
	});

	it("a keyed transcript hold past its life is never settled: its window is posted once, under the same key", async () => {
		capabilities = ["hold-expiry", "release", "idempotency-key"];
		await runHook(SESSION_START, { session_id: SESSION, source: "startup" }, env);
		await writeFile(mainTranscript(), response("msg_a"));
		life = 0;
		await pre("tu_1", { transcript_path: mainTranscript() });
		const key = authorizes()[0]?.idempotencyKey;
		expect(typeof key).toBe("string");
		await outlive();
		await post("tu_1", { transcript_path: mainTranscript() });
		expect(settled().map((s) => s.transferId)).not.toContain("tx_1");
		life = 60_000;
		await runHook(
			STOP,
			{ session_id: SESSION, transcript_path: mainTranscript(), stop_hook_active: false },
			env,
		);
		// Nothing posted under the key, so the window's later post is the same charge: authorized
		// again under the same key (its ids derive it), and settled once.
		const retried = authorizes().filter((a) => a.idempotencyKey === key);
		expect(retried).toHaveLength(2);
		expect(settled().filter((s) => s.inputTokens === 10)).toHaveLength(1);
	});

	it("an empty transcript hold past its life, on a server that cannot release, is never settled at zero", async () => {
		capabilities = ["hold-expiry"];
		// Such a server gives a hold back through abort, which answers that the hold is gone.
		giveBackAnswer = { status: 404, json: { error: "not_found", reason: "unknown transferId" } };
		// A response from before metering: read, never posted, so the hold carries no window.
		await mkdir(projectDir, { recursive: true });
		await writeFile(mainTranscript(), response("msg_old", 3_600_000));
		await runHook(SESSION_START, { session_id: SESSION, source: "startup" }, env);
		life = 0;
		await pre("tu_1", { transcript_path: mainTranscript() });
		await outlive();
		await post("tu_1", { transcript_path: mainTranscript() });
		expect(settled()).toEqual([]);
	});
});
