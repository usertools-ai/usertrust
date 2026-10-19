// The model a hold is authorized at (transcript.mjs `holdModelFor`): the session's own, never a
// configured or built-in default. An Opus session's holds read claude-opus-*, on every path a
// hold names a model without a transcript window: an estimate agent's hold (a fork that settles
// at the estimate), a transcript hold with no window, and PostToolUse's replacement of an expired
// estimate hold. With no source at all a hold names `unknown`, which the server prices at the
// dearest rate it publishes (core pricing.ts `FALLBACK_RATE`), and says so (`params.modelSource`).
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const SESSION_START = join(HOOKS, "session-start.mjs");
const PRE = join(HOOKS, "pre-tool-use.mjs");
const POST = join(HOOKS, "post-tool-use.mjs");

const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";
const SESSION = "sess-model";

interface Seen {
	path: string;
	body: {
		model?: string;
		transferId?: string;
		params?: { modelSource?: string; replaces?: string };
	};
}

let server: Server | undefined;
let seen: Seen[];
let stateDir: string;
let projectDir: string;
let env: Record<string, string>;
/** How the fake server answers each settle, by transferId; anything else settles. */
let settleAnswers: Map<string, { status: number; json: unknown }>;
let nextTransfer: number;

function startFake(): Promise<number> {
	seen = [];
	settleAnswers = new Map();
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
				// An older server: health answers, with no capabilities.
				if (req.method === "GET" && req.url === "/v1/health") return reply(200, { status: "ok" });
				const body = JSON.parse(raw) as Seen["body"];
				seen.push({ path: req.url ?? "", body });
				if (req.url === "/v1/authorize") {
					const transferId = `tx_${nextTransfer++}`;
					return reply(200, { transferId, estimatedCost: 1, model: body.model, createdAt: 1 });
				}
				if (req.url === "/v1/settle") {
					const fixed = settleAnswers.get(String(body.transferId));
					if (fixed !== undefined) return reply(fixed.status, fixed.json);
					return reply(200, { settled: true, transferId: body.transferId });
				}
				return reply(200, {});
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server?.address();
			resolve(typeof address === "object" && address !== null ? address.port : 0);
		});
	});
}

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-model-"));
	projectDir = await mkdtemp(join(tmpdir(), "utcc-model-project-"));
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

const authorizes = () => seen.filter((s) => s.path === "/v1/authorize").map((s) => s.body);

/** One complete assistant response of `model`, written `agoMs` before now (`pad` lengthens its line). */
function response(id: string, model: string, agoMs = 0, pad = "") {
	return `${JSON.stringify({
		type: "assistant",
		...(pad === "" ? {} : { pad }),
		timestamp: new Date(Date.now() - agoMs).toISOString(),
		message: {
			id,
			model,
			stop_reason: "tool_use",
			usage: { input_tokens: 10, output_tokens: 5 },
		},
	})}\n`;
}

const mainTranscript = () => join(projectDir, `${SESSION}.jsonl`);
const agentTranscript = (agent: string) =>
	join(projectDir, SESSION, "subagents", `agent-${agent}.jsonl`);

async function writeTranscript(path: string, text: string) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, text);
}

const sessionStart = (model?: unknown, extra: Record<string, string> = {}) =>
	runHook(
		SESSION_START,
		{ session_id: SESSION, source: "startup", ...(model === undefined ? {} : { model }) },
		{ ...env, ...extra },
	);

const call = (toolUseId: string, fields: Record<string, unknown> = {}) => ({
	session_id: SESSION,
	tool_name: "Bash",
	tool_use_id: toolUseId,
	tool_input: { command: "ls" },
	...fields,
});

const pre = (toolUseId: string, fields: Record<string, unknown> = {}, extra = {}) =>
	runHook(PRE, call(toolUseId, fields), { ...env, ...extra });

describe("the model a hold names is the session's own", () => {
	it("a fork that settles at the estimate names its transcript's model, and records it on the hold", async () => {
		// Another agent of the session settles at the estimate, so this subagent inherits it
		// (transcript.mjs `inheritedEstimate`): an estimate hold, with no transcript window.
		await mkdir(join(stateDir, "transcripts", "estimate"), { recursive: true });
		await writeFile(join(stateDir, "transcripts", "estimate", `${SESSION}__a0`), "estimate mode");
		await writeTranscript(mainTranscript(), "");
		await writeTranscript(agentTranscript("a1"), response("msg_1", OPUS));
		const result = await pre("tu_1", { agent_id: "a1", transcript_path: mainTranscript() });
		expect(result.code).toBe(0);
		expect(authorizes()).toMatchObject([{ model: OPUS, params: { modelSource: "transcript" } }]);
		const hold = JSON.parse(
			await readFile(join(stateDir, `${SESSION}__a1__tu_1.tx_1.json`), "utf-8"),
		) as { holdModel: string; usage?: string };
		expect(hold.usage).toBeUndefined();
		expect(hold.holdModel).toBe(OPUS);
	});

	it("a transcript hold with no window names the model of responses from before metering, read into its cursor", async () => {
		// The response predates the session's first-run stamp: never posted, so no window, but it
		// still says which model the agent runs (transcript.mjs `foldLine`).
		await writeTranscript(mainTranscript(), response("msg_1", OPUS, 3_600_000));
		expect((await sessionStart()).code).toBe(0);
		await pre("tu_1", { transcript_path: mainTranscript() });
		expect(authorizes()).toMatchObject([{ model: OPUS, params: { modelSource: "transcript" } }]);
		const cursor = JSON.parse(
			await readFile(join(stateDir, "transcripts", `${SESSION}__main.json`), "utf-8"),
		) as { lastModel: string | null };
		expect(cursor.lastModel).toBe(OPUS);
	});

	it("a transcript reread from zero (it was replaced by a shorter file) ends on its newest model, an accounted response included", async () => {
		const older = response("msg_h", HAIKU, 3_600_000);
		await writeTranscript(mainTranscript(), older);
		expect((await sessionStart()).code).toBe(0);
		// A response after metering began, held and settled: its id is accounted from here on.
		const newer = (pad: string) => response("msg_o", OPUS, 0, pad);
		await writeFile(mainTranscript(), older + newer("x".repeat(4096)));
		await pre("tu_1", { transcript_path: mainTranscript() });
		await runHook(
			POST,
			{ ...call("tu_1"), transcript_path: mainTranscript(), tool_response: "ok" },
			env,
		);
		// The same two responses in a SHORTER file: the cursor's offset is past its end, so it is
		// read again from zero, the Haiku line first and the accounted Opus line last.
		await writeFile(mainTranscript(), older + newer(""));
		await pre("tu_2", { transcript_path: mainTranscript() });
		const [, held] = authorizes();
		expect(held).toMatchObject({ model: OPUS, params: { modelSource: "transcript" } });
		const cursor = JSON.parse(
			await readFile(join(stateDir, "transcripts", `${SESSION}__main.json`), "utf-8"),
		) as { lastModel: string | null; accounted: string[] };
		expect(cursor.accounted).toContain("msg_o");
		expect(cursor.lastModel).toBe(OPUS);
	});

	it("a newest response whose model is unusable makes a hold `unknown`, never an older, cheaper model's", async () => {
		// Spaces are not allowed in a model id: such a response's model is unusable, so unknown.
		const unusable = response("msg_u", "two words");
		// Estimate path (no window): the transcript tail's newest response decides.
		await writeTranscript(mainTranscript(), response("msg_h", HAIKU) + unusable);
		await pre("tu_1", { transcript_path: mainTranscript() }, { UT_CC_USAGE: "estimate" });
		// Transcript path, in a session of its own (a session's usage mode is pinned at its first
		// hook), before metering (no window): the cursor's newest response decides, over the
		// SessionStart model too.
		const other = "sess-model-2";
		const otherMain = join(projectDir, `${other}.jsonl`);
		await writeTranscript(
			otherMain,
			response("msg_h3", HAIKU, 3_600_000) + response("msg_u3", "two words", 3_500_000),
		);
		await runHook(SESSION_START, { session_id: other, source: "startup", model: OPUS }, env);
		await runHook(PRE, { ...call("tu_2"), session_id: other, transcript_path: otherMain }, env);
		expect(authorizes()).toMatchObject([
			{ model: "unknown", params: { modelSource: "unknown" } },
			{ model: "unknown", params: { modelSource: "unknown" } },
		]);
		const cursor = JSON.parse(
			await readFile(join(stateDir, "transcripts", `${other}__main.json`), "utf-8"),
		) as { lastModel: string | null };
		expect(cursor.lastModel).toBe("unknown");
	});

	it("before any response of its agent, a hold names the model Claude Code reported at SessionStart", async () => {
		expect((await sessionStart(OPUS)).code).toBe(0);
		// No transcript path: an estimate hold. And a subagent whose transcript holds no response yet.
		await pre("tu_1");
		await writeTranscript(mainTranscript(), "");
		await writeTranscript(agentTranscript("a2"), "");
		await pre("tu_2", { agent_id: "a2", transcript_path: mainTranscript() });
		expect(authorizes()).toMatchObject([
			{ model: OPUS, params: { modelSource: "session" } },
			{ model: OPUS, params: { modelSource: "session" } },
		]);
	});

	it("a session's recorded model is read only from a directory no one else can write", async () => {
		await sessionStart(OPUS);
		await pre("tu_1");
		// Writable by the group: whatever it holds could have been planted, so it is not read.
		await chmod(join(stateDir, "session-models"), 0o770);
		await pre("tu_2");
		expect(authorizes()).toMatchObject([
			{ model: OPUS, params: { modelSource: "session" } },
			{ model: "unknown", params: { modelSource: "unknown" } },
		]);
	});

	it("SessionStart's model as an object is read by its id, and an omitted one leaves the earlier record", async () => {
		await sessionStart({ id: OPUS, display_name: "Opus" });
		await sessionStart();
		await pre("tu_1");
		expect(authorizes()).toMatchObject([{ model: OPUS, params: { modelSource: "session" } }]);
	});

	it("with no source at all, a hold names `unknown` (priced at the dearest rate), never a default model", async () => {
		await pre("tu_1");
		expect(authorizes()).toEqual([
			expect.objectContaining({
				model: "unknown",
				params: expect.objectContaining({ modelSource: "unknown" }),
			}),
		]);
		expect(JSON.stringify(seen)).not.toContain("claude-sonnet-4-6");
		// Looking for a session's model makes nothing: only SessionStart's record does.
		expect(await readdir(stateDir)).not.toContain("session-models");
	});

	it("UT_CC_USAGE=estimate names the transcript's newest model: a switch from Haiku to Opus mid-session is held and settled at Opus", async () => {
		const estimate = { UT_CC_USAGE: "estimate" };
		await sessionStart(HAIKU, estimate);
		await writeTranscript(mainTranscript(), response("msg_1", HAIKU));
		await pre("tu_1", { transcript_path: mainTranscript() }, estimate);
		// `/model opus`: the next response is Opus's. Only its model id is read, never its usage.
		await writeFile(mainTranscript(), response("msg_1", HAIKU) + response("msg_2", OPUS));
		await pre("tu_2", { transcript_path: mainTranscript() }, estimate);
		const post = await runHook(
			POST,
			{ ...call("tu_2"), transcript_path: mainTranscript(), tool_response: "ok" },
			{ ...env, ...estimate },
		);
		expect(post.code).toBe(0);
		expect(authorizes()).toMatchObject([
			{ model: HAIKU, params: { modelSource: "transcript" } },
			{ model: OPUS, params: { modelSource: "transcript" } },
		]);
		// The estimate settles the hold authorized at Opus: the server prices it at that model.
		const settled = seen.filter((s) => s.path === "/v1/settle").map((s) => s.body.transferId);
		expect(settled).toEqual(["tx_2"]);
		// Usage is still the estimate, never the transcript's: no settle carries its counts.
		expect(JSON.stringify(seen.filter((s) => s.path === "/v1/settle"))).not.toContain(
			'"usageSource":"provider"',
		);
		// Without a readable transcript, the SessionStart model, as before.
		await pre("tu_3", { transcript_path: join(projectDir, "missing.jsonl") }, estimate);
		expect(authorizes()[2]).toMatchObject({ model: HAIKU, params: { modelSource: "session" } });
	});

	it("PostToolUse's replacement of an expired estimate hold is authorized at the HOLD's model, not one resolved later", async () => {
		await sessionStart(OPUS);
		await pre("tu_1");
		// The session's record changes after the hold was made: the replacement still charges the
		// call at the model it was held at.
		await sessionStart(HAIKU);
		settleAnswers.set("tx_1", {
			status: 404,
			json: { error: "not_found", reason: "unknown transferId" },
		});
		const post = await runHook(
			POST,
			{ session_id: SESSION, tool_name: "Bash", tool_use_id: "tu_1", tool_response: "ok" },
			env,
		);
		expect(post.code).toBe(0);
		const [held, replacement] = authorizes();
		expect(held).toMatchObject({ model: OPUS, params: { modelSource: "session" } });
		expect(replacement).toMatchObject({
			model: OPUS,
			params: { modelSource: "hold", replaces: "tx_1" },
		});
	});

	it("UT_CC_MODEL is ignored, and SessionStart says so; a session without it says nothing of it", async () => {
		const noted = await sessionStart(undefined, { UT_CC_MODEL: "claude-sonnet-4-6" });
		const line = (JSON.parse(noted.stdout) as { systemMessage: string }).systemMessage;
		expect(line).toContain(
			"usertrust: UT_CC_MODEL is ignored: model is no longer configurable, and the session's own model is used.",
		);
		await pre("tu_1", {}, { UT_CC_MODEL: "claude-sonnet-4-6" });
		expect(authorizes()).toMatchObject([{ model: "unknown" }]);
		const quiet = await runHook(SESSION_START, { session_id: "other", source: "startup" }, env);
		expect(quiet.stdout).not.toContain("is ignored");
	});
});
