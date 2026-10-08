import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const PRE = join(HOOKS, "pre-tool-use.mjs");
const SESSION_START = join(HOOKS, "session-start.mjs");

let server: Server | undefined;
let stateDir: string;
let baseEnv: Record<string, string>;

/** A server that answers every request with `status` and `json`. */
function startFake(status: number, json: unknown): Promise<number> {
	return new Promise((resolve) => {
		server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(json));
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server?.address();
			resolve(typeof address === "object" && address !== null ? address.port : 0);
		});
	});
}

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-mode-"));
	// UT_CC_MODE and UT_FAIL_OPEN stay unset unless a test sets them (runHook
	// inherits no UT_* variable); the estimate path keeps these runs off the
	// transcript.
	baseEnv = {
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_KEY: "k",
		UT_CC_USAGE: "estimate",
	};
});
afterEach(() => {
	server?.close();
	server = undefined;
});

const PAYLOAD = {
	session_id: "sess1",
	tool_name: "Bash",
	tool_use_id: "tu_1",
	tool_input: { command: "ls" },
};

/**
 * A new session's id. A session's settings are pinned at its first hook, so a run
 * with other settings is another session, as it would be under Claude Code.
 */
let sessions = 0;
const newSession = () => `sess-${++sessions}`;

interface HookOutput {
	hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
}

const decision = (stdout: string) => (JSON.parse(stdout) as HookOutput).hookSpecificOutput;

/**
 * How the plugin lets a call through, in either mode: exit 0 and NOTHING on
 * stdout, which Claude Code reads as no decision (its normal permission flow
 * applies). Never an `allow`, which would skip the user's permission prompt;
 * never exit 2, which would block.
 */
function expectNoDecision(result: { code: number; stdout: string }) {
	expect(result.code).toBe(0);
	expect(result.stdout).toBe("");
}

/** Every watch record written so far, parsed; [] when the log does not exist. */
async function watchRecords(): Promise<Array<Record<string, unknown>>> {
	try {
		const text = await readFile(join(stateDir, "watch.jsonl"), "utf-8");
		return text
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

const UNREACHABLE = "http://127.0.0.1:9";

/** C0 (ESC, BEL), DEL and C1 (CSI) — anything a terminal could act on. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control chars is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const HOSTILE = "\u001b[2J\u001b]0;pwned\u0007\u007f\u009b";
/** HOSTILE once its control characters are spaces. */
const HOSTILE_SANITIZED = " [2J ]0;pwned   ";
/** lib.mjs `MAX_NOTE_CHARS`: the longest line `say` or `announce` writes. */
const MAX_NOTE_CHARS = 2000;

describe("the mode: watch-only unless UT_CC_MODE=enforce", () => {
	// Driven through the hooks themselves (each is its own node process reading the
	// environment), the way Claude Code runs them.
	const modeOf = async (value: string | undefined) => {
		const env = { ...baseEnv };
		if (value !== undefined) env.UT_CC_MODE = value;
		const result = await runHook(SESSION_START, { session_id: newSession() }, env);
		const message = (JSON.parse(result.stdout) as { systemMessage: string }).systemMessage;
		return message.startsWith("usertrust: ENFORCING")
			? "enforce"
			: message.startsWith("usertrust: watch-only")
				? "watch"
				: message;
	};

	it("the default is watch: unset, empty or any other value; enforce only for 'enforce'", async () => {
		for (const value of [undefined, "", "watch", "enforcing", "block", "1"]) {
			expect(await modeOf(value), String(value)).toBe("watch");
		}
		for (const value of ["enforce", " Enforce "]) {
			expect(await modeOf(value), value).toBe("enforce");
		}
	});
});

describe("watch (the default) never blocks a tool call, and never approves one", () => {
	for (const status of [402, 403, 429]) {
		it(`a ${status} refusal makes no decision, never exit 2, and is recorded as would_block`, async () => {
			const port = await startFake(status, { error: "budget_exceeded", reason: "need 10, have 2" });
			const result = await runHook(PRE, PAYLOAD, {
				...baseEnv,
				UT_SERVER_URL: `http://127.0.0.1:${port}`,
			});
			expectNoDecision(result);
			expect(result.stderr).toContain("would have blocked");
			const records = await watchRecords();
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				kind: "would_block",
				session: "sess1",
				agent: "main",
				tool: "Bash",
				status,
				error: "budget_exceeded",
				reason: "need 10, have 2",
			});
			expect(Date.parse(String(records[0]?.at))).not.toBeNaN();
		});
	}

	it("an unreachable server makes no decision, never exit 2, and is recorded as a gap: time, session, agent, tool", async () => {
		const result = await runHook(
			PRE,
			{ ...PAYLOAD, agent_id: "agent-A" },
			{ ...baseEnv, UT_SERVER_URL: UNREACHABLE },
		);
		expectNoDecision(result);
		expect(result.stderr).toContain("recorded as a gap");
		const records = await watchRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			kind: "gap",
			mode: "watch",
			session: "sess1",
			agent: "agent-A",
			tool: "Bash",
		});
		expect(Date.parse(String(records[0]?.at))).not.toBeNaN();
		expect(String(records[0]?.reason)).not.toBe("");
		// Private, like the rest of the plugin's durable state.
		expect((await stat(join(stateDir, "watch.jsonl"))).mode & 0o777).toBe(0o600);
	});

	it("a watch record that cannot be written is reported without control characters: path, error and line", async () => {
		// The state root is a FILE, so no record can be written. Its name, and the
		// tool name inside the record line (where JSON leaves DEL and C1 raw), carry
		// ESC, DEL and C1. (A session id carrying them is refused before any record:
		// it names the session's pin.)
		const blocked = join(stateDir, `state${HOSTILE}`);
		await writeFile(blocked, "not a directory");
		const result = await runHook(
			PRE,
			{ ...PAYLOAD, tool_name: `Bash${HOSTILE}` },
			{ ...baseEnv, UT_CC_STATE_DIR: blocked, UT_SERVER_URL: UNREACHABLE },
		);
		expectNoDecision(result);
		expect(result.stderr).toContain("could not write a watch record");
		// And no note claims the record that was not written.
		expect(result.stderr).not.toContain("recorded as a gap");
		expect(result.stderr).toContain("and its gap record could not be written");
		expect(result.stderr).not.toMatch(CONTROL);
	});

	it("an unusable answer (a 200 without a transferId) makes no decision and is recorded as a gap", async () => {
		const port = await startFake(200, { estimatedCost: 3 });
		const result = await runHook(PRE, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expectNoDecision(result);
		expect(await watchRecords()).toMatchObject([{ kind: "gap", tool: "Bash" }]);
	});

	it("a 200 reservation is held and recorded as usual, with NO decision: an allow would skip the permission prompt", async () => {
		const port = await startFake(200, { transferId: "tx_1", estimatedCost: 3 });
		const result = await runHook(PRE, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expectNoDecision(result);
		expect(result.stderr).toContain("reserved tx_1");
		// The hold is recorded for PostToolUse to settle, exactly as in enforce mode
		// (transcripts/ holds the record that this agent settles at the estimate).
		expect((await readdir(stateDir)).filter((name) => name !== "transcripts")).toEqual([
			"sess1__main__tu_1.tx_1.json",
		]);
		expect(await watchRecords()).toEqual([]);
	});

	it("a reservation's estimatedCost reaches the debug log without control characters", async () => {
		const port = await startFake(200, { transferId: "tx_1", estimatedCost: `3${HOSTILE}` });
		const result = await runHook(PRE, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expectNoDecision(result);
		expect(result.stderr).toContain("usertrust: reserved tx_1");
		expect(result.stderr).not.toMatch(CONTROL);
	});

	it("a transferId carrying control characters is refused, never echoed: no decision, a gap", async () => {
		const port = await startFake(200, { transferId: `tx_1${HOSTILE}`, estimatedCost: 3 });
		const result = await runHook(PRE, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expectNoDecision(result);
		expect(result.stderr).toContain("its transferId is not a valid id");
		expect(result.stderr).not.toMatch(CONTROL);
		expect(await watchRecords()).toEqual([expect.objectContaining({ kind: "gap" })]);
	});

	it("a shadow answer (an evaluate_only server) makes no decision either", async () => {
		const port = await startFake(200, { shadow: true, reason: "budget_exceeded" });
		const result = await runHook(PRE, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expectNoDecision(result);
		expect(result.stderr).toContain("would_deny");
	});
});

describe("UT_CC_MODE=enforce still blocks", () => {
	it("a 200 reservation makes NO decision either: enforcing blocks, it never grants", async () => {
		const port = await startFake(200, { transferId: "tx_1", estimatedCost: 3 });
		const result = await runHook(PRE, PAYLOAD, {
			...baseEnv,
			UT_CC_MODE: "enforce",
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expectNoDecision(result);
		expect(result.stderr).toContain("reserved tx_1");
	});

	it("a 402 is denied, and nothing is recorded", async () => {
		const port = await startFake(402, { error: "budget_exceeded", reason: "need 10, have 2" });
		const result = await runHook(PRE, PAYLOAD, {
			...baseEnv,
			UT_CC_MODE: "enforce",
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(decision(result.stdout).permissionDecision).toBe("deny");
		expect(await watchRecords()).toEqual([]);
	});

	it("a 429 anomaly cutoff is denied like a 402/403 — even with UT_FAIL_OPEN=1, which is for outages", async () => {
		for (const failOpen of ["", "1"]) {
			const port = await startFake(429, { error: "anomaly", reason: "spend velocity" });
			const result = await runHook(
				PRE,
				{ ...PAYLOAD, session_id: newSession() },
				{
					...baseEnv,
					UT_CC_MODE: "enforce",
					...(failOpen === "" ? {} : { UT_FAIL_OPEN: failOpen }),
					UT_SERVER_URL: `http://127.0.0.1:${port}`,
				},
			);
			expect(decision(result.stdout).permissionDecision, failOpen).toBe("deny");
			expect(decision(result.stdout).permissionDecisionReason).toContain("anomaly");
			server?.close();
		}
		expect(await watchRecords()).toEqual([]);
	});

	it("an unreachable server blocks the call (exit 2) and writes no gap", async () => {
		const result = await runHook(PRE, PAYLOAD, {
			...baseEnv,
			UT_CC_MODE: "enforce",
			UT_SERVER_URL: UNREACHABLE,
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("failed closed");
		expect(await watchRecords()).toEqual([]);
	});

	it("with UT_FAIL_OPEN=1 an unreachable server lets the call through, recorded as a gap", async () => {
		const result = await runHook(PRE, PAYLOAD, {
			...baseEnv,
			UT_CC_MODE: "enforce",
			UT_FAIL_OPEN: "1",
			UT_SERVER_URL: UNREACHABLE,
		});
		expectNoDecision(result);
		expect(result.stderr).toContain("ungoverned");
		expect(await watchRecords()).toMatchObject([{ kind: "gap", mode: "enforce", tool: "Bash" }]);
	});
});

describe("the plugin never grants permission: deny or nothing, in either mode, on every path", () => {
	const answers: Array<[string, number, unknown]> = [
		["a reservation", 200, { transferId: "tx_1", estimatedCost: 3 }],
		["a shadow answer", 200, { shadow: true, reason: "rule" }],
		["a budget denial", 402, { error: "budget_exceeded", reason: "need 10, have 2" }],
		["a policy denial", 403, { error: "pii", reason: "rule" }],
		["an unusable answer", 200, { estimatedCost: 3 }],
		["a 500", 500, { error: "internal" }],
		["no server", 0, null],
	];
	const modes: Array<[string, Record<string, string>]> = [
		["watch", {}],
		["enforce", { UT_CC_MODE: "enforce" }],
		["enforce + UT_FAIL_OPEN=1", { UT_CC_MODE: "enforce", UT_FAIL_OPEN: "1" }],
	];
	for (const [modeName, modeEnv] of modes) {
		for (const [what, status, json] of answers) {
			it(`${modeName}, ${what}: never allow`, async () => {
				const url =
					status === 0 ? UNREACHABLE : `http://127.0.0.1:${await startFake(status, json)}`;
				const result = await runHook(PRE, PAYLOAD, { ...baseEnv, ...modeEnv, UT_SERVER_URL: url });
				const decided =
					result.stdout === "" ? "nothing" : decision(result.stdout).permissionDecision;
				expect(["nothing", "deny"]).toContain(decided);
			});
		}
	}
});

describe("the mode is announced to the user at session start", () => {
	const announce = async (env: Record<string, string>) => {
		const result = await runHook(
			SESSION_START,
			{ hook_event_name: "SessionStart", source: "startup", session_id: newSession() },
			{
				...baseEnv,
				...env,
			},
		);
		expect(result.code).toBe(0);
		return (JSON.parse(result.stdout) as { systemMessage: string }).systemMessage;
	};

	it("hooks.json runs session-start through launch.mjs on SessionStart", async () => {
		const manifest = JSON.parse(await readFile(join(HOOKS, "hooks.json"), "utf-8")) as {
			hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
		};
		const commands = (manifest.hooks.SessionStart ?? []).flatMap((entry) =>
			entry.hooks.map((hook) => hook.command),
		);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands ${CLAUDE_PLUGIN_ROOT} itself
		expect(commands).toEqual(['node "${CLAUDE_PLUGIN_ROOT}/hooks/launch.mjs" session-start']);
	});

	it("watch (default): 'nothing is blocked', where the records go, and how to enforce", async () => {
		const message = await announce({});
		expect(message).toContain("usertrust: watch-only — nothing is blocked");
		expect(message).toContain(join(stateDir, "watch.jsonl"));
		expect(message).toContain("UT_CC_MODE=enforce");
		expect(message).not.toContain("ENFORCING");
	});

	it("control characters in the state path never reach the terminal, in either message that names it", async () => {
		const hostileDir = join(stateDir, `state${HOSTILE}dir`);
		for (const env of [{}, { UT_CC_MODE: "enforce", UT_FAIL_OPEN: "1" }]) {
			const message = await announce({ ...env, UT_CC_STATE_DIR: hostileDir });
			expect(message).toContain("watch.jsonl");
			expect(message).toContain(`${stateDir}/state`);
			expect(message, JSON.stringify(env)).not.toMatch(CONTROL);
		}
	});

	it("an unrecognised UT_CC_MODE carrying ESC, DEL and C1 is named without them: each is a space, and 40 characters of that are shown", async () => {
		const message = await announce({ UT_CC_MODE: `enforcing${HOSTILE}${"x".repeat(60)}` });
		const shown = `enforcing${HOSTILE_SANITIZED}${"x".repeat(15)}`;
		expect(shown).toHaveLength(40);
		expect(message).toContain(`UT_CC_MODE=${JSON.stringify(shown)} is not a mode`);
		expect(message).not.toMatch(CONTROL);
	});

	it("an announcement past the bound is clipped to it, with no control character in what is left", async () => {
		// 200 path segments, each carrying ESC, BEL, DEL and C1: far past the bound.
		const hostileDir = join(stateDir, ...Array.from({ length: 200 }, (_, i) => `d${i}${HOSTILE}`));
		expect(hostileDir.length).toBeGreaterThan(MAX_NOTE_CHARS);
		const message = await announce({ UT_CC_STATE_DIR: hostileDir });
		expect(message.startsWith("usertrust: watch-only — nothing is blocked")).toBe(true);
		expect(message).toHaveLength(MAX_NOTE_CHARS);
		expect(message).not.toMatch(CONTROL);
	});

	it("an unrecognised UT_CC_MODE is named, so a typo never looks like enforcement", async () => {
		const message = await announce({ UT_CC_MODE: "enforcing" });
		expect(message).toContain("watch-only — nothing is blocked");
		expect(message).toContain('UT_CC_MODE="enforcing" is not a mode');
	});

	it("enforce: ENFORCING, and what an outage does with and without UT_FAIL_OPEN", async () => {
		const strict = await announce({ UT_CC_MODE: "enforce" });
		expect(strict).toContain("usertrust: ENFORCING");
		expect(strict).toContain("every tool call while the usertrust server is unreachable");
		const failOpen = await announce({ UT_CC_MODE: "enforce", UT_FAIL_OPEN: "1" });
		expect(failOpen).toContain("usertrust: ENFORCING");
		expect(failOpen).toContain("UT_FAIL_OPEN=1");
		expect(failOpen).not.toContain("watch-only");
	});
});
