// A tool call that FAILS is closed by PostToolUseFailure. Claude Code fires exactly one of
// PostToolUse (the call succeeded, or exited 1 as a result: grep, diff, ...) and
// PostToolUseFailure (it failed) per call, both with the call's `tool_use_id` and, in a subagent,
// its `agent_id`. The failure's hold is settled as a success's is: the call ran, so it is charged.
// Before this hook was registered a failed call's hold was never settled by its own call: it waited
// for a Stop, a SubagentStop or SessionEnd, or the server's pending timeout.
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const PRE = join(HOOKS, "pre-tool-use.mjs");
const POST = join(HOOKS, "post-tool-use.mjs");
const POST_FAILURE = join(HOOKS, "post-tool-use-failure.mjs");
const STOP = join(HOOKS, "stop.mjs");
const SESSION_START = join(HOOKS, "session-start.mjs");
const ESTIMATE = { UT_CC_USAGE: "estimate" };
const SESSION = "sess-failed-call";

interface Seen {
	path: string;
	body: { transferId?: string; outputTokens?: number } & Record<string, unknown>;
}

let server: Server | undefined;
let seen: Seen[];
let stateDir: string;
let projectDir: string;
let env: Record<string, string>;
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
					return reply(200, { status: "ok", capabilities: ["hold-expiry", "release"] });
				}
				const body = JSON.parse(raw || "{}") as Seen["body"];
				seen.push({ path: req.url ?? "", body });
				if (req.url === "/v1/authorize") {
					return reply(200, {
						transferId: `tx_${nextTransfer++}`,
						estimatedCost: 1,
						expiresInMs: 60_000,
					});
				}
				if (req.url === "/v1/settle")
					return reply(200, { settled: true, transferId: body.transferId });
				if (req.url === "/v1/release" || req.url === "/v1/abort")
					return reply(200, { released: true });
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
	stateDir = await mkdtemp(join(tmpdir(), "utcc-failed-"));
	projectDir = await mkdtemp(join(tmpdir(), "utcc-failed-project-"));
	const port = await startFake();
	env = {
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_KEY: "k",
		UT_SERVER_URL: `http://127.0.0.1:${port}`,
	};
});

afterEach(() => {
	server?.closeAllConnections();
	server?.close();
	server = undefined;
});

const settled = () => seen.filter((s) => s.path === "/v1/settle").map((s) => s.body.transferId);
const call = (id: string, fields: Record<string, unknown> = {}) => ({
	session_id: SESSION,
	tool_name: "Bash",
	tool_use_id: id,
	tool_input: { command: "false" },
	...fields,
});
const pre = (id: string, fields: Record<string, unknown> = {}) =>
	runHook(PRE, call(id, fields), { ...env, ...ESTIMATE });
const post = (id: string, fields: Record<string, unknown> = {}) =>
	runHook(POST, { ...call(id, fields), tool_response: "ok" }, { ...env, ...ESTIMATE });
const failed = (id: string, fields: Record<string, unknown> = {}) =>
	runHook(
		POST_FAILURE,
		{ ...call(id, fields), error: "Exit code 1", is_interrupt: false, duration_ms: 29 },
		{ ...env, ...ESTIMATE },
	);
const holdFiles = async () =>
	(await readdir(stateDir)).filter(
		(name) => name.startsWith(`${SESSION}__`) && name.includes("tx_"),
	);

describe("PostToolUseFailure settles the hold of a call that failed", () => {
	it("is registered in its own hooks file, declared by the plugin, for every tool", async () => {
		const manifest = JSON.parse(
			await readFile(join(HOOKS, "post-tool-use-failure.json"), "utf-8"),
		) as {
			hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
		};
		expect(Object.keys(manifest.hooks)).toEqual(["PostToolUseFailure"]);
		expect(
			manifest.hooks.PostToolUseFailure?.flatMap((e) => e.hooks.map((h) => h.command)),
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands ${CLAUDE_PLUGIN_ROOT} itself
		).toEqual(['node "${CLAUDE_PLUGIN_ROOT}/hooks/launch.mjs" post-tool-use-failure']);
		expect(manifest.hooks.PostToolUseFailure?.every((e) => e.matcher === undefined)).toBe(true);
		const plugin = JSON.parse(
			await readFile(join(HOOKS, "..", ".claude-plugin", "plugin.json"), "utf-8"),
		) as { hooks?: string[] };
		expect(plugin.hooks).toContain("./hooks/post-tool-use-failure.json");
		// Not in hooks.json: a Claude Code before v2.0.56 would reject that whole file.
		const main = JSON.parse(await readFile(join(HOOKS, "hooks.json"), "utf-8")) as {
			hooks: Record<string, unknown>;
		};
		expect(Object.keys(main.hooks)).not.toContain("PostToolUseFailure");
	});

	it("CONTROL: a call that succeeds is settled by PostToolUse, as before", async () => {
		await pre("tu_ok");
		expect(await holdFiles()).toHaveLength(1);
		await post("tu_ok");
		expect(settled()).toEqual(["tx_1"]);
		expect(await holdFiles()).toEqual([]);
	});

	it("a call that fails is settled at once, its hold closed, charged once", async () => {
		await pre("tu_bad");
		expect(await holdFiles()).toHaveLength(1);
		const result = await failed("tu_bad");
		expect(result.code).toBe(0);
		expect(settled()).toEqual(["tx_1"]);
		expect(await holdFiles()).toEqual([]);
		// The call is charged for the error text it produced, as a result's text would be.
		const sent = seen.find((s) => s.path === "/v1/settle");
		// "Exit code 1" as JSON is 13 characters: 4 tokens at 4 characters each. With `error` not read
		// (`tool_response` absent) the estimate would be that of an empty string, 1.
		expect(sent?.body.outputTokens).toBe(4);
		expect(seen.filter((s) => s.path === "/v1/authorize")).toHaveLength(1);
	});

	it("a subagent's failed call is settled by its own agent_id, and a sibling's hold is left", async () => {
		await pre("tu_sub", { agent_id: "agent-a", agent_type: "general-purpose" });
		await pre("tu_other", { agent_id: "agent-b", agent_type: "general-purpose" });
		await failed("tu_sub", { agent_id: "agent-a", agent_type: "general-purpose" });
		expect(settled()).toEqual(["tx_1"]);
		const left = await holdFiles();
		expect(left).toHaveLength(1);
		expect(left[0]).toContain("agent-b");
	});

	it("a second event for the same call settles nothing again", async () => {
		await pre("tu_bad");
		await failed("tu_bad");
		await failed("tu_bad");
		expect(settled()).toEqual(["tx_1"]);
	});

	it("a failure event with no hold for the call settles nothing and does not fail", async () => {
		const result = await failed("tu_never_authorized");
		expect(result.code).toBe(0);
		expect(settled()).toEqual([]);
	});

	it("both events for one call, one after the other: one settle", async () => {
		await pre("tu_x");
		await failed("tu_x");
		await post("tu_x");
		expect(settled()).toEqual(["tx_1"]);
		expect(await holdFiles()).toEqual([]);
	});

	it("both events for one call at the same time: one settle", async () => {
		await pre("tu_x");
		const both = await Promise.all([failed("tu_x"), post("tu_x")]);
		expect(both.map((r) => r.code)).toEqual([0, 0]);
		expect(settled()).toEqual(["tx_1"]);
		expect(await holdFiles()).toEqual([]);
	});

	it("the error text is what is priced: 400 characters settle at 101 output tokens", async () => {
		await pre("tu_x");
		await runHook(
			POST_FAILURE,
			{ ...call("tu_x"), error: "x".repeat(400), is_interrupt: false },
			{ ...env, ...ESTIMATE },
		);
		expect(seen.find((s) => s.path === "/v1/settle")?.body.outputTokens).toBe(101);
	});
});

describe("transcript mode (the default): a failed call settles as a successful one does", () => {
	const OPUS = "claude-opus-5-5";
	const transcript = () => join(projectDir, `${SESSION}.jsonl`);
	const response = (id: string) =>
		`${JSON.stringify({
			type: "assistant",
			timestamp: new Date().toISOString(),
			message: {
				id,
				model: OPUS,
				stop_reason: "tool_use",
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		})}\n`;
	const withPath = (id: string) => call(id, { transcript_path: transcript() });
	const preT = (id: string) => runHook(PRE, withPath(id), env);
	const postT = (id: string) => runHook(POST, { ...withPath(id), tool_response: "ok" }, env);
	const failedT = (id: string) =>
		runHook(
			POST_FAILURE,
			{ ...withPath(id), error: "Exit code 1", is_interrupt: false, duration_ms: 29 },
			env,
		);
	const stopT = () => runHook(STOP, { session_id: SESSION, transcript_path: transcript() }, env);
	const prepare = async () => {
		expect(
			(await runHook(SESSION_START, { session_id: SESSION, source: "startup" }, env)).code,
		).toBe(0);
		await writeFile(transcript(), response("msg_1"));
		expect((await preT("tu_1")).code).toBe(0);
	};
	/** A settle body without the fields that are clock readings. */
	const stable = (body: Record<string, unknown> | undefined) =>
		Object.fromEntries(
			Object.entries(body ?? {}).filter(([key]) => !/(At|From|To|Ms|time|ts)$/i.test(key)),
		);
	const settleBodies = () => seen.filter((s) => s.path === "/v1/settle").map((s) => s.body);

	let controlBody: Record<string, unknown> | undefined;

	it("CONTROL: a successful call's hold settles at the transcript's counts", async () => {
		await prepare();
		expect((await postT("tu_1")).code).toBe(0);
		expect(settled()).toEqual(["tx_1"]);
		controlBody = stable(settleBodies()[0]);
		expect(controlBody.usageSource).not.toBe("estimated");
	});

	it("a failed call's hold settles at once, with the same body as the control's", async () => {
		await prepare();
		expect((await failedT("tu_1")).code).toBe(0);
		expect(settled()).toEqual(["tx_1"]);
		expect(controlBody).toBeDefined();
		expect(stable(settleBodies()[0])).toEqual(controlBody);
		expect(await holdFiles()).toEqual([]);
	});

	it("both events for one call: one settle, and a Stop after it settles nothing more", async () => {
		await prepare();
		await Promise.all([failedT("tu_1"), postT("tu_1")]);
		await stopT();
		expect(settled()).toEqual(["tx_1"]);
	});
});
