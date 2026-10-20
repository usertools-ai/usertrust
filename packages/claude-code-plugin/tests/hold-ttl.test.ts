// A tool call expected to outlive the default hold life asks for a longer one (`holdTtlMs`,
// capability `hold-ttl`), so its budget stays reserved until it settles (lib.mjs `holdTtlFor`):
// a Bash or PowerShell call for its own timeout plus a grace, a subagent for the server's
// ceiling. Only a server that lists `hold-ttl` and states its ceiling is asked, never above that
// ceiling; an older server strips the key, so none is sent to it. The hold records what it asked
// for, so a `.settling` record of it is stale only after that (transcript.mjs `staleSettlingAfter`).
import { mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const PRE = join(HOOKS, "pre-tool-use.mjs");
const SESSION_START = join(HOOKS, "session-start.mjs");
const TRANSCRIPT = join(HOOKS, "transcript.mjs");
const SESSION = "sess-ttl";
const MINUTE = 60_000;

let server: Server | undefined;
let authorizes: Array<Record<string, unknown>>;
let stateDir: string;
let env: Record<string, string>;
/** What /v1/health publishes. */
let health: Record<string, unknown>;

function startFake(): Promise<number> {
	authorizes = [];
	let next = 1;
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
				if (req.method === "GET" && req.url === "/v1/health") return reply(200, health);
				const body = JSON.parse(raw || "{}") as Record<string, unknown>;
				if (req.url === "/v1/authorize") {
					authorizes.push(body);
					return reply(200, { transferId: `tx_${next++}`, estimatedCost: 1 });
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
	stateDir = await mkdtemp(join(tmpdir(), "utcc-ttl-"));
	health = { status: "ok", capabilities: ["hold-ttl", "release"], maxHoldTtlMs: 60 * MINUTE };
	const port = await startFake();
	env = {
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_KEY: "k",
		UT_SERVER_URL: `http://127.0.0.1:${port}`,
		UT_CC_USAGE: "estimate",
	};
});
afterEach(() => {
	server?.close();
	server = undefined;
});

const pre = (toolName: string, toolInput: Record<string, unknown>, extra = {}, session = SESSION) =>
	runHook(
		PRE,
		{
			session_id: session,
			tool_name: toolName,
			tool_use_id: `tu_${authorizes.length + 1}`,
			tool_input: toolInput,
		},
		{ ...env, ...extra },
	);
const asked = () => authorizes.map((a) => a.holdTtlMs);

describe("a call's hold is asked to outlive the call", () => {
	it("Bash: its own timeout plus the 60 s grace; with none, the two-minute default plus it", async () => {
		await pre("Bash", { command: "make", timeout: 15 * MINUTE });
		await pre("Bash", { command: "ls" });
		await pre("PowerShell", { command: "dir", timeout: 4 * MINUTE });
		expect(asked()).toEqual([16 * MINUTE, 3 * MINUTE, 5 * MINUTE]);
	});

	it("Bash with no timeout reads the host's BASH_DEFAULT_TIMEOUT_MS", async () => {
		await pre("Bash", { command: "ls" }, { BASH_DEFAULT_TIMEOUT_MS: String(5 * MINUTE) });
		expect(asked()).toEqual([6 * MINUTE]);
	});

	it("UT_CC_HOLD_GRACE_MS sets the grace", async () => {
		await pre("Bash", { command: "make", timeout: 15 * MINUTE }, { UT_CC_HOLD_GRACE_MS: "0" });
		// A session's settings are pinned at its first hook: another session for another value.
		await pre(
			"Bash",
			{ command: "make", timeout: 15 * MINUTE },
			{ UT_CC_HOLD_GRACE_MS: "nonsense" },
			"sess-ttl-2",
		);
		expect(asked()).toEqual([15 * MINUTE, 16 * MINUTE]);
	});

	it("Agent and Task: the server's ceiling; never more than it for anything", async () => {
		await pre("Agent", { prompt: "go" });
		await pre("Task", { prompt: "go" });
		health.maxHoldTtlMs = 10 * MINUTE;
		await pre("Bash", { command: "make", timeout: 15 * MINUTE });
		expect(asked()).toEqual([60 * MINUTE, 60 * MINUTE, 10 * MINUTE]);
	});

	it("a background Bash, and every other tool, ask for nothing: the default", async () => {
		await pre("Bash", { command: "serve", run_in_background: true, timeout: 15 * MINUTE });
		await pre("Read", { file_path: "/etc/hosts" });
		expect(authorizes).toHaveLength(2);
		expect(authorizes.map((a) => Object.hasOwn(a, "holdTtlMs"))).toEqual([false, false]);
	});

	it.each([
		[
			"an older server (no hold-ttl)",
			{ status: "ok", capabilities: ["release"], maxHoldTtlMs: 60 * MINUTE },
		],
		["a server stating no ceiling", { status: "ok", capabilities: ["hold-ttl"] }],
		["capabilities unknown", { status: "ok" }],
	])("%s is asked for nothing", async (_name, answer) => {
		health = answer;
		await pre("Bash", { command: "make", timeout: 15 * MINUTE });
		await pre("Agent", { prompt: "go" });
		expect(authorizes.map((a) => Object.hasOwn(a, "holdTtlMs"))).toEqual([false, false]);
	});

	it("the hold records the life it asked for", async () => {
		await pre("Bash", { command: "make", timeout: 15 * MINUTE });
		const names = (await readdir(stateDir)).filter((n) => n.startsWith(`${SESSION}__main__`));
		expect(names).toHaveLength(1);
		const hold = JSON.parse(await readFile(join(stateDir, names[0] ?? ""), "utf-8")) as {
			holdTtlMs?: number;
		};
		expect(hold.holdTtlMs).toBe(16 * MINUTE);
	});
});

describe("a `.settling` record is stale only after its hold's own life", () => {
	it("STALE_SETTLING_MS, plus however much longer than the default its hold was asked to live", async () => {
		const { staleSettlingAfter, STALE_SETTLING_MS, DEFAULT_HOLD_LIFE_MS } = (await import(
			TRANSCRIPT
		)) as {
			staleSettlingAfter: (r: unknown) => number;
			STALE_SETTLING_MS: number;
			DEFAULT_HOLD_LIFE_MS: number;
		};
		expect(staleSettlingAfter({})).toBe(STALE_SETTLING_MS);
		expect(staleSettlingAfter({ holdTtlMs: 2 * MINUTE })).toBe(STALE_SETTLING_MS);
		expect(staleSettlingAfter({ holdTtlMs: 60 * MINUTE })).toBe(
			STALE_SETTLING_MS + 60 * MINUTE - DEFAULT_HOLD_LIFE_MS,
		);
		expect(staleSettlingAfter({ holdTtlMs: "60" })).toBe(STALE_SETTLING_MS);
	});

	it.each([
		["asked to live an hour: still in flight at 20 minutes, kept", 60 * MINUTE, true],
		["the default life: abandoned at 20 minutes, cleared", undefined, false],
	])("a transcript hold's `.settling` record %s", async (_name, holdTtlMs, kept) => {
		const session = `sess-stale-${holdTtlMs ?? "default"}`;
		const transcriptMode = { UT_CC_USAGE: "transcript" };
		const projectDir = await mkdtemp(join(tmpdir(), "utcc-ttl-project-"));
		const transcript = join(projectDir, `${session}.jsonl`);
		await runHook(
			SESSION_START,
			{ session_id: session, source: "startup" },
			{ ...env, ...transcriptMode },
		);
		await writeFile(
			transcript,
			`${JSON.stringify({
				type: "assistant",
				timestamp: new Date().toISOString(),
				message: {
					id: "msg_a",
					model: "claude-opus-5-5",
					stop_reason: "tool_use",
					usage: { input_tokens: 5, output_tokens: 5 },
				},
			})}\n`,
		);
		// A hook died mid-settle 20 minutes ago: its claim is left `.settling`.
		const record = join(stateDir, `${session}__main__tu_old.tx_old.settling`);
		await writeFile(
			record,
			JSON.stringify({
				gate: 1,
				toolUseId: "tu_old",
				transferId: "tx_old",
				agentId: "main",
				sessionId: session,
				usage: "transcript",
				holdModel: "claude-opus-5-5",
				assignedIds: ["msg_a"],
				inputTokens: 5,
				outputTokens: 5,
				...(holdTtlMs === undefined ? {} : { holdTtlMs }),
			}),
			{ mode: 0o600 },
		);
		const then = new Date(Date.now() - 20 * MINUTE);
		await utimes(record, then, then);
		await runHook(
			PRE,
			{
				session_id: session,
				tool_name: "Read",
				tool_use_id: "tu_new",
				tool_input: {},
				transcript_path: transcript,
			},
			{ ...env, ...transcriptMode },
		);
		expect((await readdir(stateDir)).includes(`${session}__main__tu_old.tx_old.settling`)).toBe(
			kept,
		);
	});
});
