import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOK = join(import.meta.dirname, "..", "hooks", "pre-tool-use.mjs");

let server: Server | undefined;
let stateDir: string;
let baseEnv: Record<string, string>;
let requests: unknown[];

function startFake(handler: (body: unknown) => { status: number; json: unknown }): Promise<number> {
	requests = [];
	return new Promise((resolve) => {
		server = createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", () => {
				const body = JSON.parse(raw) as unknown;
				requests.push(body);
				const out = handler(body);
				res.writeHead(out.status, { "content-type": "application/json" });
				res.end(JSON.stringify(out.json));
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server?.address();
			resolve(typeof address === "object" && address !== null ? address.port : 0);
		});
	});
}

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-hook-"));
	baseEnv = { UT_CC_STATE_DIR: stateDir, UT_SERVER_KEY: "k" };
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

interface HookOutput {
	hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
}

describe("pre-tool-use hook", () => {
	it("allows and records the reservation as a per-hold state file on 200", async () => {
		const port = await startFake((body) => {
			expect((body as { model: string }).model).toBe("claude-sonnet-4-6");
			expect((body as { params: { tool_name: string } }).params.tool_name).toBe("Bash");
			return {
				status: 200,
				json: { transferId: "tx_1", estimatedCost: 3, model: "m", createdAt: 1 },
			};
		});
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(0);
		const output = JSON.parse(result.stdout) as HookOutput;
		expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
		expect(output.hookSpecificOutput.permissionDecisionReason).toContain("tx_1");
		// No agent_id in the payload → the parent's "main" bucket.
		const files = await readdir(stateDir);
		expect(files).toEqual(["sess1__main__tu_1.json"]);
		const entry = JSON.parse(await readFile(join(stateDir, "sess1__main__tu_1.json"), "utf-8")) as {
			toolUseId: string;
			transferId: string;
			agentId: string;
		};
		expect(entry).toEqual({ toolUseId: "tu_1", transferId: "tx_1", agentId: "main" });
	});

	it("records a subagent's reservation under its own agent_id bucket", async () => {
		const port = await startFake(() => ({
			status: 200,
			json: { transferId: "tx_sub", estimatedCost: 1, model: "m", createdAt: 1 },
		}));
		const result = await runHook(
			HOOK,
			{ ...PAYLOAD, agent_id: "agent-A" },
			{ ...baseEnv, UT_SERVER_URL: `http://127.0.0.1:${port}` },
		);
		expect(result.code).toBe(0);
		expect(await readdir(stateDir)).toEqual(["sess1__agent-A__tu_1.json"]);
		const entry = JSON.parse(
			await readFile(join(stateDir, "sess1__agent-A__tu_1.json"), "utf-8"),
		) as { agentId: string };
		expect(entry.agentId).toBe("agent-A");
	});

	it("denies with the server's reason on 403", async () => {
		const port = await startFake(() => ({
			status: 403,
			json: { error: "policy_denied", reason: "pii: ssn detected" },
		}));
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(0);
		const output = JSON.parse(result.stdout) as HookOutput;
		expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(output.hookSpecificOutput.permissionDecisionReason).toContain("pii");
	});

	it("denies on 402 budget exhaustion", async () => {
		const port = await startFake(() => ({
			status: 402,
			json: { error: "budget_exceeded", reason: "need 10, have 2" },
		}));
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		const output = JSON.parse(result.stdout) as HookOutput;
		expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("caps deny reasons at 500 chars and strips C0/DEL/C1 control characters", async () => {
		const port = await startFake(() => ({
			status: 403,
			json: { error: "policy_denied", reason: `bad\u0007rule\nline\u0085end${"x".repeat(1000)}` },
		}));
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		const output = JSON.parse(result.stdout) as HookOutput;
		const reason = output.hookSpecificOutput.permissionDecisionReason;
		expect(reason.length).toBeLessThanOrEqual(500);
		expect(reason).not.toContain("\u0007");
		expect(reason).not.toContain("\n");
		expect(reason).not.toContain("\u0085");
		expect(reason).toContain("bad rule");
	});

	it("fails closed (exit 2) when the server is unreachable", async () => {
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: "http://127.0.0.1:9",
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("usertrust");
	});

	it("fails closed (exit 2) on a 200 with malformed/absent JSON body", async () => {
		const port = await startFake(() => ({ status: 200, json: null }));
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("usertrust");
		expect(await readdir(stateDir)).toEqual([]);
	});

	it("fails closed (exit 2) on a 200 missing transferId", async () => {
		const port = await startFake(() => ({ status: 200, json: { estimatedCost: 3 } }));
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(2);
		expect(await readdir(stateDir)).toEqual([]);
	});

	it("UT_FAIL_OPEN=1 allows with a warning when the server is unreachable", async () => {
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: "http://127.0.0.1:9",
			UT_FAIL_OPEN: "1",
		});
		expect(result.code).toBe(0);
		const output = JSON.parse(result.stdout) as HookOutput;
		expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
		expect(output.hookSpecificOutput.permissionDecisionReason).toContain("ungoverned");
	});

	it("shadow response allows and records nothing", async () => {
		const port = await startFake(() => ({
			status: 200,
			json: { shadow: true, shadowId: "shadow_1", decision: "would_deny", reason: "rule" },
		}));
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(0);
		const output = JSON.parse(result.stdout) as HookOutput;
		expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
		expect(output.hookSpecificOutput.permissionDecisionReason).toContain("shadow");
		expect(await readdir(stateDir)).toEqual([]);
	});

	it("truncates tool_input at 16 KiB for both content and token estimation", async () => {
		const port = await startFake(() => ({
			status: 200,
			json: { transferId: "tx_big", estimatedCost: 1, model: "m", createdAt: 1 },
		}));
		const payload = { ...PAYLOAD, tool_input: { command: "x".repeat(40_000) } };
		const result = await runHook(HOOK, payload, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(0);
		const body = requests[0] as {
			estimatedInputTokens: number;
			messages: Array<{ content: string }>;
		};
		expect(body.messages[0]?.content.length).toBe(16_384);
		expect(body.estimatedInputTokens).toBe(4096);
	});

	it("UT_CC_SEND_CONTENT=0 sends redacted content but a real size estimate", async () => {
		const port = await startFake(() => ({
			status: 200,
			json: { transferId: "tx_red", estimatedCost: 1, model: "m", createdAt: 1 },
		}));
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
			UT_CC_SEND_CONTENT: "0",
		});
		expect(result.code).toBe(0);
		const body = requests[0] as {
			estimatedInputTokens: number;
			messages: Array<{ content: string }>;
		};
		expect(body.messages[0]?.content).toBe('{"redacted":true}');
		// JSON.stringify({command:"ls"}) is 16 chars -> 4 estimated tokens.
		expect(body.estimatedInputTokens).toBe(4);
	});
});
