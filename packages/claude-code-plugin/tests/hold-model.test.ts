// The model a hold is authorized at (transcript.mjs `holdModelFor`): the session's own, never a
// configured or built-in default. An Opus session's holds read claude-opus-*, on every path a
// hold names a model without a transcript window: an estimate agent's hold (a fork that settles
// at the estimate), a transcript hold with no window, and PostToolUse's replacement of an expired
// estimate hold. With no source at all a hold names `unknown`, which the server prices at the
// dearest rate it publishes (core pricing.ts `FALLBACK_RATE`), and says so (`params.modelSource`).
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const SESSION_START = join(HOOKS, "session-start.mjs");
const PRE = join(HOOKS, "pre-tool-use.mjs");
const POST = join(HOOKS, "post-tool-use.mjs");
const SWITCH = join(HOOKS, "post-model-switch.mjs");
/** Imported in-process by a computed path, as the other tests import hook modules (no declarations). */
const TRANSCRIPT = join(HOOKS, "transcript.mjs");

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

	it("a hold made while another hook holds the agent's lock names the transcript's newest model, not the cursor's last saved one", async () => {
		await writeTranscript(mainTranscript(), response("msg_h", HAIKU));
		await pre("tu_1", { transcript_path: mainTranscript() });
		await runHook(
			POST,
			{ ...call("tu_1"), transcript_path: mainTranscript(), tool_response: "ok" },
			env,
		);
		// The session switched to Opus: its response is in the transcript, but another hook holds
		// the agent's lock, so this one reads only the cursor saved before it (`lastModel` Haiku).
		await writeFile(mainTranscript(), response("msg_h", HAIKU) + response("msg_o", OPUS));
		const lock = join(stateDir, "transcripts", `${SESSION}__main.json.lock`);
		await mkdir(lock);
		await writeFile(join(lock, "owner"), "another-hook");
		await pre("tu_2", { transcript_path: mainTranscript() });
		expect(authorizes()[1]).toMatchObject({ model: OPUS, params: { modelSource: "transcript" } });
	});

	it("every source and outcome, directly: the newest response read now, the SessionStart model only while provably current, else `unknown`", async () => {
		// In this process the module reads settings from process.env: never an installed config.
		for (const name of ["UT_CC_CONFIG", "UT_SERVER_URL", "UT_SERVER_KEY"]) delete process.env[name];
		process.env.UT_CC_STATE_DIR = stateDir;
		const { holdModelFor, recordSessionModel } = (await import(TRANSCRIPT)) as {
			holdModelFor: (a: Record<string, unknown>) => Promise<{ model: string; source: string }>;
			recordSessionModel: (session: string, model: unknown) => Promise<void>;
		};
		let n = 0;
		/** A fresh session whose SessionStart reported Opus, and a transcript path under it. */
		const fresh = async () => {
			n += 1;
			const sessionId = `direct-${n}`;
			await recordSessionModel(sessionId, OPUS);
			return { sessionId, path: join(projectDir, `${sessionId}.jsonl`) };
		};
		const at = (
			sessionId: string,
			input: Record<string, unknown>,
			extra: Record<string, unknown> = {},
		) => holdModelFor({ sessionId, agentId: "main", input, lastModel: null, ...extra });
		const session = { model: OPUS, source: "session" };
		const unknown = { model: "unknown", source: "unknown" };

		// The newest response decides, over a cursor that names another model.
		let s = await fresh();
		await writeFile(s.path, response("msg_h", HAIKU) + response("msg_o", OPUS));
		expect(await at(s.sessionId, { transcript_path: s.path }, { lastModel: HAIKU })).toEqual({
			model: OPUS,
			source: "transcript",
		});
		// Then the file is gone: this agent read a response, so `unknown`, never SessionStart.
		await rm(s.path);
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(unknown);

		// Missing, and this agent never read anything: SessionStart (not written yet).
		s = await fresh();
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(session);
		// Missing after its cursor read bytes, or named a model: `unknown`.
		expect(await at(s.sessionId, { transcript_path: s.path }, { readBefore: true })).toEqual(
			unknown,
		);
		expect(await at(s.sessionId, { transcript_path: s.path }, { lastModel: HAIKU })).toEqual(
			unknown,
		);
		// No path at all, never read: SessionStart; with no record either: `unknown`.
		expect(await at(s.sessionId, {})).toEqual(session);
		expect(await at("no-record", {})).toEqual(unknown);

		// Readable, but no response in it (only a user line), never read: SessionStart.
		s = await fresh();
		await writeFile(s.path, `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`);
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(session);

		// Unreadable (a directory at its path): `unknown`, even before anything was read.
		s = await fresh();
		await mkdir(s.path);
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(unknown);

		// A newest response line longer than any fixed tail (5 MiB): read whole, its model named.
		s = await fresh();
		await writeFile(
			s.path,
			response("msg_h", HAIKU) + response("msg_o", OPUS, 0, "x".repeat(5 << 20)),
		);
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual({
			model: OPUS,
			source: "transcript",
		});
		// Only a line its newline has ended is evidence. A final line without it is still being
		// written, so `unknown`, never the older Haiku line's model, whatever it holds so far:
		const whole = response("msg_o", OPUS);
		for (const partial of [
			// cut after its `"usage"` key,
			whole.slice(0, whole.indexOf('"usage"') + 12),
			// cut before it (it does not yet read as a response at all),
			whole.slice(0, whole.indexOf('"usage"') - 1),
			// or whole, and parsing, but not yet ended by its newline.
			whole.slice(0, -1),
		]) {
			s = await fresh();
			await writeFile(s.path, response("msg_h", HAIKU) + partial);
			expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(unknown);
		}
		// A COMPLETE line holding `"usage"` that does not parse is a corrupt response: `unknown` too.
		s = await fresh();
		await writeFile(
			s.path,
			`${response("msg_h", HAIKU)}${whole.slice(0, whole.indexOf('"usage"') + 12)}\n`,
		);
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(unknown);
		// A newest line over the ingest's line limit (16 MiB): it cannot be inspected, `unknown`.
		s = await fresh();
		await writeFile(
			s.path,
			response("msg_h", HAIKU) + response("msg_o", OPUS, 0, "x".repeat(17 << 20)),
		);
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(unknown);
	}, 30_000);

	it("the session's latest model switch, directly: a newest response from before it that names another model is `unknown`", async () => {
		for (const name of ["UT_CC_CONFIG", "UT_SERVER_URL", "UT_SERVER_KEY"]) delete process.env[name];
		process.env.UT_CC_STATE_DIR = stateDir;
		const { holdModelFor, recordSessionModel, recordModelSwitch } = (await import(TRANSCRIPT)) as {
			holdModelFor: (a: Record<string, unknown>) => Promise<{ model: string; source: string }>;
			recordSessionModel: (session: string, model: unknown) => Promise<void>;
			recordModelSwitch: (session: string, model: unknown) => Promise<void>;
		};
		let n = 0;
		/** A fresh session that switched to Opus NOW, and a transcript path under it. */
		const switched = async () => {
			n += 1;
			const sessionId = `switch-${n}`;
			await recordModelSwitch(sessionId, OPUS);
			return { sessionId, path: join(projectDir, `${sessionId}.jsonl`) };
		};
		const at = (sessionId: string, input: Record<string, unknown>, agentId = "main") =>
			holdModelFor({ sessionId, agentId, input, lastModel: null });
		const unknown = { model: "unknown", source: "unknown" };
		const transcript = (model: string) => ({ model, source: "transcript" });

		// The tail lags: its newest response, Haiku's, is from before the switch to Opus.
		let s = await switched();
		await writeFile(s.path, response("msg_h", HAIKU, 10_000));
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(unknown);
		// From before the switch, but naming the model switched to: that model.
		s = await switched();
		await writeFile(s.path, response("msg_o", OPUS, 10_000));
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(transcript(OPUS));
		// A response dated after the switch is the transcript's to say, whichever model it names.
		s = await switched();
		await writeFile(s.path, response("msg_h", HAIKU, -10_000));
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(transcript(HAIKU));
		// A response with no date cannot be placed after the switch: `unknown`.
		s = await switched();
		const undated = JSON.parse(response("msg_h", HAIKU)) as Record<string, unknown>;
		delete undated.timestamp;
		await writeFile(s.path, `${JSON.stringify(undated)}\n`);
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(unknown);
		// A subagent of the session too: an automatic fallback changes the session's model.
		s = await switched();
		const sub = join(projectDir, s.sessionId, "subagents", "agent-a1.jsonl");
		await writeTranscript(sub, response("msg_h", HAIKU, 10_000));
		expect(await at(s.sessionId, { transcript_path: s.path }, "a1")).toEqual(unknown);
		// A switch record that cannot be read may name a dearer model: `unknown`, even for a
		// response that a readable record would leave as it is.
		s = await switched();
		await writeFile(s.path, response("msg_h", HAIKU, -10_000));
		const records = join(stateDir, "transcripts", "session-models", `${s.sessionId}.switches`);
		await writeFile(join(records, "1.corrupt.json"), "{");
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(unknown);
		// Two hook runs that overlapped can land out of order: an earlier switch to Haiku recorded
		// AFTER a later one to Opus. Records that close together are read as one ambiguous switch,
		// so a lagging Haiku response is `unknown`, never taken for the session's model.
		s = await switched();
		const overlapped = join(stateDir, "transcripts", "session-models", `${s.sessionId}.switches`);
		const now = Date.now();
		await writeFile(
			join(overlapped, `${now + 1000}.1.a.json`),
			JSON.stringify({ model: HAIKU, at: now + 1000 }),
		);
		await writeFile(s.path, response("msg_h", HAIKU, 10_000));
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(unknown);
		// With no response to read, before anything was read, an ambiguous switch names no model either.
		await recordModelSwitch("switch-ambiguous", HAIKU);
		await recordModelSwitch("switch-ambiguous", OPUS);
		expect(await at("switch-ambiguous", {})).toEqual(unknown);
		// A response dated after the newest record is still the transcript's.
		await writeFile(s.path, response("msg_h", HAIKU, -20_000));
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(transcript(HAIKU));
		// Two switches in quick succession each keep a record of their own, so neither replaces the
		// other: their order cannot be told from records that close, and a lagging response is
		// `unknown`, even one naming the later switch's model.
		await recordModelSwitch("switch-twice", HAIKU);
		await recordModelSwitch("switch-twice", OPUS);
		const twice = join(projectDir, "switch-twice.jsonl");
		await writeFile(twice, response("msg_o", OPUS, 10_000));
		expect(await at("switch-twice", { transcript_path: twice })).toEqual(unknown);
		// A record well before the newest is a switch that came before it, not an overlap: the newest
		// alone names the session's model, and a new record removes it.
		s = await switched();
		const spaced = join(stateDir, "transcripts", "session-models", `${s.sessionId}.switches`);
		const old = Date.now() - 60_000;
		await writeFile(join(spaced, `${old}.1.b.json`), JSON.stringify({ model: HAIKU, at: old }));
		await writeFile(s.path, response("msg_o", OPUS, 10_000));
		expect(await at(s.sessionId, { transcript_path: s.path })).toEqual(transcript(OPUS));
		await recordModelSwitch(s.sessionId, OPUS);
		expect((await readdir(spaced)).filter((name) => name.startsWith(`${old}.`))).toEqual([]);
		// No response yet, never read: the switch's model, over the SessionStart one it is newer than.
		await recordSessionModel("switch-start", OPUS);
		await recordModelSwitch("switch-start", HAIKU);
		expect(await at("switch-start", {})).toEqual({ model: HAIKU, source: "session" });
		// An unusable `to_model` leaves the earlier record as it is.
		await recordModelSwitch("switch-start", "two words");
		expect(await at("switch-start", {})).toEqual({ model: HAIKU, source: "session" });
	});

	it("a switch record pruned between its listing and its read is never read as no switch", async () => {
		// A newer run (`recordModelSwitch`) removes an old record after this hold listed it, before it
		// read it. The newer run's own record is missing from that listing: the directory is listed
		// again, so the newer switch is seen. Made deterministic in a child process whose `readdir`
		// lets the newer run land right after the first listing.
		const sessionId = "switch-pruned";
		const records = join(stateDir, "transcripts", "session-models", `${sessionId}.switches`);
		await mkdir(records, { recursive: true, mode: 0o700 });
		await chmod(join(stateDir, "transcripts"), 0o700);
		await chmod(join(stateDir, "transcripts", "session-models"), 0o700);
		const old = Date.now() - 60_000;
		await writeFile(join(records, `${old}.1.a.json`), JSON.stringify({ model: HAIKU, at: old }));
		// A Haiku response after the old switch, before the newer one.
		const path = join(projectDir, `${sessionId}.jsonl`);
		await writeFile(path, response("msg_h", HAIKU, 30_000));
		const child = `
			import fs from "node:fs/promises";
			import { syncBuiltinESMExports } from "node:module";
			import { join } from "node:path";
			const { records, old, opus, transcript, sessionId, path } = JSON.parse(process.env.CASE);
			const listing = fs.readdir;
			let first = true;
			fs.readdir = async (dir, ...rest) => {
				const names = await listing(dir, ...rest);
				if (first && String(dir) === records) {
					first = false;
					// The newer run: its own record, then the old one removed.
					const now = Date.now();
					await fs.writeFile(join(records, now + ".2.b.json"), JSON.stringify({ model: opus, at: now }));
					await fs.unlink(join(records, old + ".1.a.json"));
				}
				return names;
			};
			syncBuiltinESMExports();
			const { holdModelFor } = await import(transcript);
			const result = await holdModelFor({ sessionId, agentId: "main", input: { transcript_path: path }, lastModel: null });
			process.stdout.write(JSON.stringify(result));
		`;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			["--input-type=module", "-e", child],
			{
				env: {
					PATH: process.env.PATH ?? "",
					HOME: stateDir,
					UT_CC_STATE_DIR: stateDir,
					CASE: JSON.stringify({
						records,
						old,
						opus: OPUS,
						transcript: TRANSCRIPT,
						sessionId,
						path,
					}),
				},
			},
		);
		// The newer switch, to Opus, was seen: the Haiku response predates it, so `unknown`.
		expect(JSON.parse(stdout)).toEqual({ model: "unknown", source: "unknown" });
	});

	it.each([
		["the record's own write fails", "tmp"],
		["no file can be written at all (a full disk)", "all"],
		["the record and its failure mark fail, so the earlier record is renamed", "tmp-failed"],
	])(
		"a switch run whose write did not complete leaves `unknown`, never the previous record: %s",
		async (_name, failing) => {
			// A cheaper switch recorded first, then a Haiku response after it: alone they say Haiku.
			const sessionId = `switch-failed-${failing}`;
			const path = join(projectDir, `${sessionId}.jsonl`);
			const child = `
			import fs from "node:fs/promises";
			import { syncBuiltinESMExports } from "node:module";
			const { transcript, sessionId, path, haiku, opus, failing, line } = JSON.parse(process.env.CASE);
			const { holdModelFor, recordModelSwitch } = await import(transcript);
			await recordModelSwitch(sessionId, haiku);
			await new Promise((r) => setTimeout(r, 5));
			await fs.writeFile(path, line);
			const write = fs.writeFile;
			fs.writeFile = async (file, ...rest) => {
				const name = String(file);
				const fails = failing === "all" || name.endsWith(".tmp") || (failing === "tmp-failed" && name.endsWith(".failed"));
				if (name.includes(".switches") && fails) {
					throw Object.assign(new Error("no space"), { code: "ENOSPC" });
				}
				return write(file, ...rest);
			};
			syncBuiltinESMExports();
			await recordModelSwitch(sessionId, opus);
			const failed = await holdModelFor({ sessionId, agentId: "main", input: { transcript_path: path }, lastModel: null });
			fs.writeFile = write;
			syncBuiltinESMExports();
			// A later run whose record completes is evidence again: the mark is cleared.
			await recordModelSwitch(sessionId, opus);
			process.stdout.write(JSON.stringify({ failed }));
		`;
			const line = JSON.stringify({
				type: "assistant",
				timestamp: "TS",
				message: {
					id: "msg_h",
					model: HAIKU,
					stop_reason: "tool_use",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			});
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					child.replace(
						"await fs.writeFile(path, line);",
						'await fs.writeFile(path, line.replace("TS", new Date().toISOString()) + "\\n");',
					),
				],
				{
					env: {
						PATH: process.env.PATH ?? "",
						HOME: stateDir,
						UT_CC_STATE_DIR: stateDir,
						CASE: JSON.stringify({
							transcript: TRANSCRIPT,
							sessionId,
							path,
							haiku: HAIKU,
							opus: OPUS,
							failing,
							line,
						}),
					},
				},
			);
			const { failed } = JSON.parse(stdout) as { failed: unknown };
			expect(failed).toEqual({ model: "unknown", source: "unknown" });
			// And no `.pending` or `.failed` mark is left once a run's record completes.
			const records = await readdir(
				join(stateDir, "transcripts", "session-models", `${sessionId}.switches`),
			);
			expect(records.filter((n) => n.endsWith(".pending") || n.endsWith(".failed"))).toEqual([]);
		},
	);

	it("a FIRST switch whose record and failure mark both fail keeps its `.pending`: `unknown`, never SessionStart's model", async () => {
		// SessionStart reported the cheaper model; the switch away from it is the session's first,
		// so there is no record to rename, and the disk takes no new file but the `.pending` mark.
		const sessionId = "switch-first-failed";
		const child = `
			import fs from "node:fs/promises";
			import { syncBuiltinESMExports } from "node:module";
			const { transcript, sessionId, haiku, opus } = JSON.parse(process.env.CASE);
			const { holdModelFor, recordModelSwitch, recordSessionModel } = await import(transcript);
			await recordSessionModel(sessionId, haiku);
			const write = fs.writeFile;
			fs.writeFile = async (file, ...rest) => {
				const name = String(file);
				if (name.includes(".switches") && (name.endsWith(".tmp") || name.endsWith(".failed"))) {
					throw Object.assign(new Error("no space"), { code: "ENOSPC" });
				}
				return write(file, ...rest);
			};
			syncBuiltinESMExports();
			await recordModelSwitch(sessionId, opus);
			const read = await holdModelFor({ sessionId, agentId: "main", input: {}, lastModel: null });
			process.stdout.write(JSON.stringify(read));
		`;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			["--input-type=module", "-e", child],
			{
				env: {
					PATH: process.env.PATH ?? "",
					HOME: stateDir,
					UT_CC_STATE_DIR: stateDir,
					CASE: JSON.stringify({ transcript: TRANSCRIPT, sessionId, haiku: HAIKU, opus: OPUS }),
				},
			},
		);
		expect(JSON.parse(stdout)).toEqual({ model: "unknown", source: "unknown" });
		const names = await readdir(
			join(stateDir, "transcripts", "session-models", `${sessionId}.switches`),
		);
		expect(names.filter((n) => n.endsWith(".pending"))).toHaveLength(1);
		expect(names.filter((n) => n.endsWith(".json") || n.endsWith(".failed"))).toEqual([]);
	});

	it.each([
		["its directory cannot be made", "mkdir"],
		["not even its `.pending` mark can be written", "pending"],
	])(
		"a FIRST switch that leaves no evidence in its directory marks the session: `unknown`, never SessionStart's model: %s",
		async (_name, failing) => {
			const sessionId = `switch-first-none-${failing}`;
			const child = `
			import fs from "node:fs/promises";
			import { syncBuiltinESMExports } from "node:module";
			const { transcript, sessionId, haiku, opus, failing } = JSON.parse(process.env.CASE);
			const { holdModelFor, recordModelSwitch, recordSessionModel } = await import(transcript);
			await recordSessionModel(sessionId, haiku);
			const noSpace = () => Object.assign(new Error("no space"), { code: "ENOSPC" });
			const mkdir = fs.mkdir;
			const write = fs.writeFile;
			fs.mkdir = async (dir, ...rest) => {
				if (failing === "mkdir" && String(dir).endsWith(".switches")) throw noSpace();
				return mkdir(dir, ...rest);
			};
			fs.writeFile = async (file, ...rest) => {
				if (failing === "pending" && String(file).includes(".switches")) throw noSpace();
				return write(file, ...rest);
			};
			syncBuiltinESMExports();
			await recordModelSwitch(sessionId, opus);
			const read = await holdModelFor({ sessionId, agentId: "main", input: {}, lastModel: null });
			process.stdout.write(JSON.stringify(read));
		`;
			const { stdout } = await promisify(execFile)(
				process.execPath,
				["--input-type=module", "-e", child],
				{
					env: {
						PATH: process.env.PATH ?? "",
						HOME: stateDir,
						UT_CC_STATE_DIR: stateDir,
						CASE: JSON.stringify({
							transcript: TRANSCRIPT,
							sessionId,
							haiku: HAIKU,
							opus: OPUS,
							failing,
						}),
					},
				},
			);
			expect(JSON.parse(stdout)).toEqual({ model: "unknown", source: "unknown" });
			const models = await readdir(join(stateDir, "transcripts", "session-models"));
			// SessionStart's record is renamed to the mark: no space needed.
			expect(models).not.toContain(sessionId);
			expect(models).toContain(`${sessionId}.switch-failed`);
		},
	);

	it("a switch that leaves no evidence in its directory reads `unknown` on the TRANSCRIPT path too, until a switch is recorded after it", async () => {
		// The transcript's newest response predates the switch and names the cheaper model; with the
		// switch unrecorded, it would read as the session's model.
		const sessionId = "switch-none-transcript";
		const path = join(projectDir, `${sessionId}.jsonl`);
		// Dated after the late record below (10 s back), so only the mark keeps it from reading.
		await writeTranscript(path, response("msg_h", HAIKU, 5_000));
		const child = `
			import fs from "node:fs/promises";
			import { syncBuiltinESMExports } from "node:module";
			const { transcript, sessionId, haiku, opus, path, fresh } = JSON.parse(process.env.CASE);
			const { holdModelFor, recordModelSwitch, recordSessionModel } = await import(transcript);
			await recordSessionModel(sessionId, haiku);
			// SessionStart ran an hour ago: the mark it is renamed to must be dated by the failure.
			const record = \`\${process.env.UT_CC_STATE_DIR}/transcripts/session-models/\${sessionId}\`;
			const hourAgo = new Date(Date.now() - 3_600_000);
			await fs.utimes(record, hourAgo, hourAgo);
			const mkdir = fs.mkdir;
			fs.mkdir = async (dir, ...rest) => {
				if (String(dir).endsWith(".switches")) {
					throw Object.assign(new Error("no space"), { code: "ENOSPC" });
				}
				return mkdir(dir, ...rest);
			};
			syncBuiltinESMExports();
			await recordModelSwitch(sessionId, opus);
			const at = (input) => holdModelFor({ sessionId, agentId: "main", input, lastModel: null });
			const failed = await at({ transcript_path: path });
			fs.mkdir = mkdir;
			syncBuiltinESMExports();
			// A run from before the failure whose record lands after it never supersedes the mark.
			const now = Date.now;
			Date.now = () => now() - 10_000;
			await recordModelSwitch(sessionId, opus);
			Date.now = now;
			const late = await at({ transcript_path: path });
			// A switch recorded after the mark supersedes it: a response after that reads as itself.
			// The mark is dated 3 s back, so this switch comes past the mark's 2 s resolution.
			const mark = \`\${record}.switch-failed\`;
			const before = new Date(Date.now() - 3_000);
			await fs.utimes(mark, before, before);
			await recordModelSwitch(sessionId, opus);
			await new Promise((resolve) => setTimeout(resolve, 5));
			await fs.appendFile(path, fresh);
			const recorded = await at({ transcript_path: path });
			// A later run that again records nothing re-dates the mark, which then outranks the
			// switch recorded before it (nothing removes a mark, so no run can remove this one).
			await new Promise((resolve) => setTimeout(resolve, 5));
			// Nothing can be written in its directory, and its records cannot be renamed either.
			const write = fs.writeFile;
			const rename = fs.rename;
			fs.writeFile = async (file, ...rest) => {
				if (String(file).includes(".switches")) {
					throw Object.assign(new Error("no space"), { code: "ENOSPC" });
				}
				return write(file, ...rest);
			};
			fs.rename = async (from, ...rest) => {
				if (String(from).includes(".switches")) {
					throw Object.assign(new Error("read-only"), { code: "EROFS" });
				}
				return rename(from, ...rest);
			};
			syncBuiltinESMExports();
			await recordModelSwitch(sessionId, opus);
			const refailed = await at({ transcript_path: path });
			process.stdout.write(JSON.stringify({ failed, late, recorded, refailed }));
		`;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			["--input-type=module", "-e", child],
			{
				env: {
					PATH: process.env.PATH ?? "",
					HOME: stateDir,
					UT_CC_STATE_DIR: stateDir,
					CASE: JSON.stringify({
						transcript: TRANSCRIPT,
						sessionId,
						haiku: HAIKU,
						opus: OPUS,
						path,
						fresh: response("msg_o", OPUS, -1_000),
					}),
				},
			},
		);
		expect(JSON.parse(stdout)).toEqual({
			failed: { model: "unknown", source: "unknown" },
			late: { model: "unknown", source: "unknown" },
			recorded: { model: OPUS, source: "transcript" },
			refailed: { model: "unknown", source: "unknown" },
		});
	});

	it("a switch recorded before a failure never outranks its mark on a filesystem that rounds mtimes down to the second", async () => {
		const sessionId = "switch-none-coarse-mtime";
		const child = `
			import fs from "node:fs/promises";
			import { syncBuiltinESMExports } from "node:module";
			const { transcript, sessionId, haiku, opus } = JSON.parse(process.env.CASE);
			const { holdModelFor, recordModelSwitch, recordSessionModel } = await import(transcript);
			await recordSessionModel(sessionId, haiku);
			// A whole second 10 s back. A switch is recorded 400 ms into it, and a run that records
			// nothing fails 700 ms into it, on a filesystem that stores that mtime as the whole second.
			const second = Math.floor(Date.now() / 1_000) * 1_000 - 10_000;
			const now = Date.now;
			Date.now = () => second + 400;
			await recordModelSwitch(sessionId, haiku);
			Date.now = now;
			const write = fs.writeFile;
			const rename = fs.rename;
			fs.writeFile = async (file, ...rest) => {
				if (String(file).includes(".switches")) {
					throw Object.assign(new Error("no space"), { code: "ENOSPC" });
				}
				return write(file, ...rest);
			};
			fs.rename = async (from, ...rest) => {
				if (String(from).includes(".switches")) {
					throw Object.assign(new Error("read-only"), { code: "EROFS" });
				}
				return rename(from, ...rest);
			};
			syncBuiltinESMExports();
			await recordModelSwitch(sessionId, opus);
			fs.writeFile = write;
			fs.rename = rename;
			syncBuiltinESMExports();
			const mark = \`\${process.env.UT_CC_STATE_DIR}/transcripts/session-models/\${sessionId}.switch-failed\`;
			const floored = new Date(second);
			await fs.utimes(mark, floored, floored);
			const read = await holdModelFor({ sessionId, agentId: "main", input: {}, lastModel: null });
			process.stdout.write(JSON.stringify(read));
		`;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			["--input-type=module", "-e", child],
			{
				env: {
					PATH: process.env.PATH ?? "",
					HOME: stateDir,
					UT_CC_STATE_DIR: stateDir,
					CASE: JSON.stringify({ transcript: TRANSCRIPT, sessionId, haiku: HAIKU, opus: OPUS }),
				},
			},
		);
		// The switch to the dearer model failed after the cheaper one was recorded: never the cheaper.
		expect(JSON.parse(stdout)).toEqual({ model: "unknown", source: "unknown" });
	});

	it("a session mark that cannot be read (EACCES) reads `unknown`, never the switch recorded beside it", async () => {
		const sessionId = "switch-mark-unreadable";
		const child = `
			import fs from "node:fs/promises";
			import { syncBuiltinESMExports } from "node:module";
			const { transcript, sessionId, haiku } = JSON.parse(process.env.CASE);
			const { holdModelFor, recordModelSwitch, recordSessionModel } = await import(transcript);
			await recordSessionModel(sessionId, haiku);
			await recordModelSwitch(sessionId, haiku);
			const lstat = fs.lstat;
			fs.lstat = async (file, ...rest) => {
				if (String(file).endsWith(".switch-failed")) {
					throw Object.assign(new Error("permission denied"), { code: "EACCES" });
				}
				return lstat(file, ...rest);
			};
			syncBuiltinESMExports();
			const read = await holdModelFor({ sessionId, agentId: "main", input: {}, lastModel: null });
			process.stdout.write(JSON.stringify(read));
		`;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			["--input-type=module", "-e", child],
			{
				env: {
					PATH: process.env.PATH ?? "",
					HOME: stateDir,
					UT_CC_STATE_DIR: stateDir,
					CASE: JSON.stringify({ transcript: TRANSCRIPT, sessionId, haiku: HAIKU }),
				},
			},
		);
		// A mark that may be there and newer than the switch cannot be ruled out: fail dearest.
		expect(JSON.parse(stdout)).toEqual({ model: "unknown", source: "unknown" });
	});

	it("a switch directory with no record in it reads `unknown`, never SessionStart's model", async () => {
		for (const name of ["UT_CC_CONFIG", "UT_SERVER_URL", "UT_SERVER_KEY"]) delete process.env[name];
		process.env.UT_CC_STATE_DIR = stateDir;
		const { holdModelFor, recordSessionModel } = (await import(TRANSCRIPT)) as {
			holdModelFor: (a: Record<string, unknown>) => Promise<{ model: string; source: string }>;
			recordSessionModel: (session: string, model: unknown) => Promise<void>;
		};
		const sessionId = "switch-dir-empty";
		await recordSessionModel(sessionId, HAIKU);
		// A run made the directory and could write nothing in it.
		await mkdir(join(stateDir, "transcripts", "session-models", `${sessionId}.switches`), {
			mode: 0o700,
		});
		expect(await holdModelFor({ sessionId, agentId: "main", input: {}, lastModel: null })).toEqual({
			model: "unknown",
			source: "unknown",
		});
	});

	it("a run whose own `.pending` a newer run already cleared records its switch, and leaves no failure mark", async () => {
		const sessionId = "switch-mark-cleared";
		const child = `
			import fs from "node:fs/promises";
			import { syncBuiltinESMExports } from "node:module";
			const { transcript, sessionId, opus } = JSON.parse(process.env.CASE);
			const unlink = fs.unlink;
			// A newer run's prune took this run's mark first: it is gone when this run removes it.
			fs.unlink = async (file) => {
				if (String(file).endsWith(".pending")) {
					await unlink(file);
					throw Object.assign(new Error("gone"), { code: "ENOENT" });
				}
				return unlink(file);
			};
			syncBuiltinESMExports();
			const { holdModelFor, recordModelSwitch } = await import(transcript);
			await recordModelSwitch(sessionId, opus);
			const read = await holdModelFor({ sessionId, agentId: "main", input: {}, lastModel: null });
			process.stdout.write(JSON.stringify(read));
		`;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			["--input-type=module", "-e", child],
			{
				env: {
					PATH: process.env.PATH ?? "",
					HOME: stateDir,
					UT_CC_STATE_DIR: stateDir,
					CASE: JSON.stringify({ transcript: TRANSCRIPT, sessionId, opus: OPUS }),
				},
			},
		);
		expect(JSON.parse(stdout)).toEqual({ model: OPUS, source: "session" });
		const names = await readdir(
			join(stateDir, "transcripts", "session-models", `${sessionId}.switches`),
		);
		expect(names.filter((n) => n.endsWith(".failed") || n.endsWith(".pending"))).toEqual([]);
	});

	it("overlapping switch runs never leave a failure mark: a live writer's `.pending` is kept, a dead one's cleared", async () => {
		for (const name of ["UT_CC_CONFIG", "UT_SERVER_URL", "UT_SERVER_KEY"]) delete process.env[name];
		process.env.UT_CC_STATE_DIR = stateDir;
		const { holdModelFor, recordModelSwitch } = (await import(TRANSCRIPT)) as {
			holdModelFor: (a: Record<string, unknown>) => Promise<{ model: string; source: string }>;
			recordModelSwitch: (session: string, model: unknown) => Promise<void>;
		};
		const sessionId = "switch-overlap-marks";
		await recordModelSwitch(sessionId, HAIKU);
		const dir = join(stateDir, "transcripts", "session-models", `${sessionId}.switches`);
		// An older run still writing (its mark 1 s old), and one that died long ago (60 s).
		const live = `${Date.now() - 1_000}.1.live.pending`;
		const dead = `${Date.now() - 60_000}.1.dead.pending`;
		await writeFile(join(dir, live), "");
		await writeFile(join(dir, dead), "");
		await recordModelSwitch(sessionId, HAIKU);
		const names = await readdir(dir);
		expect(names).toContain(live);
		expect(names).not.toContain(dead);
		expect(names.filter((n) => n.endsWith(".failed"))).toEqual([]);
		// The live writer finishes: its mark goes, and the switch reads as recorded.
		await rm(join(dir, live));
		expect(await holdModelFor({ sessionId, agentId: "main", input: {}, lastModel: null })).toEqual({
			model: HAIKU,
			source: "session",
		});
	});

	it("the PostModelSwitch hook records the switch, prints nothing for Claude's context, and a hold reads it", async () => {
		await writeTranscript(mainTranscript(), response("msg_h", HAIKU, 10_000));
		await pre("tu_1", { transcript_path: mainTranscript() });
		const recorded = await runHook(
			SWITCH,
			{
				session_id: SESSION,
				hook_event_name: "PostModelSwitch",
				from_model: HAIKU,
				to_model: OPUS,
				source: "command",
			},
			env,
		);
		expect(recorded.code).toBe(0);
		// Claude Code adds a PostModelSwitch hook's plain stdout to Claude's context.
		expect(recorded.stdout).toBe("");
		// The tail still ends on Haiku's response, from before the switch.
		await pre("tu_2", { transcript_path: mainTranscript() });
		// Opus's first response reaches the file: it is the transcript's again.
		await writeFile(mainTranscript(), response("msg_h", HAIKU, 10_000) + response("msg_o", OPUS));
		await pre("tu_3", { transcript_path: mainTranscript() });
		expect(authorizes()).toMatchObject([
			{ model: HAIKU, params: { modelSource: "transcript" } },
			{ model: "unknown", params: { modelSource: "unknown" } },
			{ model: OPUS, params: { modelSource: "transcript" } },
		]);
	});

	it("PostModelSwitch is registered in its own hooks file: a Claude Code before v2.1.251 rejects a whole file that names it", async () => {
		// The events Claude Code v2.1.250 accepts, from its own error for a file naming PostModelSwitch
		// ("Failed to load hooks ... Invalid option: expected one of ..."). With any other name in
		// hooks.json it loads none of the file's hooks: no governance on that client at all.
		const known = new Set(
			"PreToolUse PostToolUse PostToolUseFailure PostToolBatch Notification UserPromptSubmit UserPromptExpansion SessionStart SessionEnd Stop StopFailure SubagentStart SubagentStop PreCompact PostCompact PermissionRequest PermissionDenied Setup TeammateIdle TaskCreated TaskCompleted Elicitation ElicitationResult ConfigChange WorktreeCreate WorktreeRemove InstructionsLoaded CwdChanged FileChanged DirectoryAdded MessageDisplay".split(
				" ",
			),
		);
		type Manifest = { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
		const read = async (file: string) =>
			JSON.parse(await readFile(join(HOOKS, file), "utf-8")) as Manifest;
		const main = await read("hooks.json");
		expect(Object.keys(main.hooks).filter((event) => !known.has(event))).toEqual([]);
		const switches = await read("model-switch.json");
		expect(Object.keys(switches.hooks)).toEqual(["PostModelSwitch"]);
		expect(
			switches.hooks.PostModelSwitch?.flatMap((entry) => entry.hooks.map((h) => h.command)),
		).toEqual(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands ${CLAUDE_PLUGIN_ROOT} itself
			['node "${CLAUDE_PLUGIN_ROOT}/hooks/launch.mjs" post-model-switch'],
		);
		// The plugin declares it, beside hooks/hooks.json, which Claude Code loads by default.
		const plugin = JSON.parse(
			await readFile(join(HOOKS, "..", ".claude-plugin", "plugin.json"), "utf-8"),
		) as { hooks?: unknown };
		expect(plugin.hooks).toBe("./hooks/model-switch.json");
	});

	it("before any response of its agent, the main agent's hold names the SessionStart model, and a subagent's is `unknown`", async () => {
		expect((await sessionStart(HAIKU)).code).toBe(0);
		// The main agent, no transcript path: an estimate hold at the session's model.
		await pre("tu_1");
		// A subagent whose transcript holds no response yet: SessionStart names the SESSION's model,
		// and the subagent may run a dearer one (nothing tells its own before its first response).
		await writeTranscript(mainTranscript(), "");
		await writeTranscript(agentTranscript("a2"), "");
		await pre("tu_2", { agent_id: "a2", transcript_path: mainTranscript() });
		expect(authorizes()).toMatchObject([
			{ model: HAIKU, params: { modelSource: "session" } },
			{ model: "unknown", params: { modelSource: "unknown" } },
		]);
	});

	it("a session's recorded model is read only from a directory no one else can write", async () => {
		await sessionStart(OPUS);
		await pre("tu_1");
		// Writable by the group: whatever it holds could have been planted, so it is not read.
		await chmod(join(stateDir, "transcripts", "session-models"), 0o770);
		await pre("tu_2");
		// A newest response on disk too: a switch recorded there cannot be trusted, nor its absence
		// (it may hide a switch to a dearer model), so `unknown` again.
		await writeTranscript(mainTranscript(), response("msg_h", HAIKU));
		await pre("tu_3", { transcript_path: mainTranscript() });
		expect(authorizes()).toMatchObject([
			{ model: OPUS, params: { modelSource: "session" } },
			{ model: "unknown", params: { modelSource: "unknown" } },
			{ model: "unknown", params: { modelSource: "unknown" } },
		]);
	});

	it("a session's switches are read only from a directory no one else can write, beside a private session-models", async () => {
		await sessionStart(HAIKU);
		const recorded = await runHook(
			SWITCH,
			{
				session_id: SESSION,
				hook_event_name: "PostModelSwitch",
				from_model: HAIKU,
				to_model: OPUS,
				source: "command",
			},
			env,
		);
		expect(recorded.code).toBe(0);
		// Only the switch directory is writable by the group: the session's own records stay
		// readable, and a switch read from there could have been planted, nor can its absence be
		// trusted (it may hide a switch to a dearer model), so never SessionStart's cheaper model.
		await chmod(join(stateDir, "transcripts", "session-models", `${SESSION}.switches`), 0o770);
		await pre("tu_1");
		expect(authorizes()).toMatchObject([{ model: "unknown", params: { modelSource: "unknown" } }]);
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
		expect(await readdir(join(stateDir, "transcripts")).catch(() => [])).not.toContain(
			"session-models",
		);
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
		// The transcript gone now: this agent has read responses already, so a switch may have
		// happened since, and the SessionStart model (Haiku) could be cheaper. `unknown`.
		await pre("tu_3", { transcript_path: join(projectDir, "missing.jsonl") }, estimate);
		expect(authorizes()[2]).toMatchObject({ model: "unknown", params: { modelSource: "unknown" } });
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
