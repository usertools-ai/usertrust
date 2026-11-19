// A tool call that FAILS is closed by PostToolUseFailure. Claude Code fires exactly one of
// PostToolUse (the call succeeded, or exited 1 as a result: grep, diff, ...) and
// PostToolUseFailure (it failed) per call, both with the call's `tool_use_id` and, in a subagent,
// its `agent_id`. The failure's hold is settled as a success's is: the call ran, so it is charged.
// Before this hook was registered a failed call's hold was never settled by its own call: it waited
// for a Stop, a SubagentStop or SessionEnd, or the server's pending timeout.
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const PRE = join(HOOKS, "pre-tool-use.mjs");
const POST = join(HOOKS, "post-tool-use.mjs");
const POST_FAILURE = join(HOOKS, "post-tool-use-failure.mjs");
const ESTIMATE = { UT_CC_USAGE: "estimate" };
const SESSION = "sess-failed-call";

interface Seen {
	path: string;
	body: { transferId?: string; outputTokens?: number };
}

let server: Server | undefined;
let seen: Seen[];
let stateDir: string;
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
	it("is registered, beside PostToolUse, for every tool", async () => {
		const manifest = JSON.parse(await readFile(join(HOOKS, "hooks.json"), "utf-8")) as {
			hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
		};
		expect(
			manifest.hooks.PostToolUseFailure?.flatMap((e) => e.hooks.map((h) => h.command)),
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands ${CLAUDE_PLUGIN_ROOT} itself
		).toEqual(['node "${CLAUDE_PLUGIN_ROOT}/hooks/launch.mjs" post-tool-use-failure']);
		expect(manifest.hooks.PostToolUseFailure?.every((e) => e.matcher === undefined)).toBe(true);
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
		expect(sent?.body.outputTokens).toBeGreaterThan(0);
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
});
