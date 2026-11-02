import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOK = join(import.meta.dirname, "..", "hooks", "pre-tool-use.mjs");

let server: Server | undefined;
let stateDir: string;
let baseEnv: Record<string, string>;
let requests: unknown[];
/** When each request reached the fake server (ms, from performance.now). */
let arrivals: number[];

function startFake(
	handler: (body: unknown) => { status: number; json: unknown; delayMs?: number },
): Promise<number> {
	requests = [];
	arrivals = [];
	return new Promise((resolve) => {
		server = createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", () => {
				// An older server: health answers, with no capabilities (no principal is sent).
				if (req.method === "GET" && req.url === "/v1/health") {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ status: "ok" }));
					return;
				}
				const body = JSON.parse(raw) as unknown;
				requests.push(body);
				arrivals.push(performance.now());
				const out = handler(body);
				setTimeout(() => {
					res.writeHead(out.status, { "content-type": "application/json" });
					res.end(JSON.stringify(out.json));
				}, out.delayMs ?? 0);
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
	// These tests pin the blocking contract, so they run in UT_CC_MODE=enforce; the
	// watch-only default is pinned in mode.test.ts.
	baseEnv = { UT_CC_STATE_DIR: stateDir, UT_SERVER_KEY: "k", UT_CC_MODE: "enforce" };
});
afterEach(() => {
	server?.close();
	server = undefined;
});

/**
 * The pending-hold files. A hook that names no transcript also records, under
 * transcripts/, that its agent settles at the estimate for good.
 */
async function holdFiles() {
	return (await readdir(stateDir)).filter((name) => name !== "transcripts");
}

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
	it("lets a 200 through with NO decision, and records the reservation as a per-hold state file", async () => {
		const port = await startFake((body) => {
			// No transcript and no SessionStart model: `unknown`, which the server prices at its
			// dearest rate, never a default model (transcript.mjs `holdModelFor`).
			expect((body as { model: string }).model).toBe("unknown");
			expect((body as { params: { tool_name: string } }).params.tool_name).toBe("Bash");
			expect((body as { params: { modelSource: string } }).params.modelSource).toBe("unknown");
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
		// No decision: an `allow` would skip the user's permission prompt.
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("tx_1");
		// No agent_id in the payload → the parent's "main" bucket. One file per hold: its
		// call (tu_1) and its transfer (tx_1).
		expect(await holdFiles()).toEqual(["sess1__main__tu_1.tx_1.json"]);
		// No transcript_path: the agent's estimate mode is recorded before its hold is.
		expect(await readdir(join(stateDir, "transcripts", "estimate"))).toEqual(["sess1__main"]);
		const raw = await readFile(join(stateDir, "sess1__main__tu_1.tx_1.json"), "utf-8");
		const entry = JSON.parse(raw) as {
			toolUseId: string;
			transferId: string;
			agentId: string;
			estimatedInputTokens: number;
			gate: 1;
			serverUrl: string;
			keyHash: string;
		};
		// JSON.stringify({command:"ls"}) is 16 chars -> 4 estimated tokens. `gate: 1`:
		// recorded under the settle-attempt gate, so a 404 to its settle means it expired.
		// `serverUrl` / `keyHash`: which server and tenant made the hold, never the key.
		expect(entry).toEqual({
			gate: 1,
			toolUseId: "tu_1",
			transferId: "tx_1",
			agentId: "main",
			// The session as given: a session id can contain the file name's `__` separator.
			sessionId: "sess1",
			estimatedInputTokens: 4,
			// The model it was authorized at: an expired hold's replacement is authorized at it.
			holdModel: "unknown",
			// When the call was received: kept on every hold, whatever the server honours.
			startedAt: expect.any(String),
			serverUrl: `http://127.0.0.1:${port}`,
			keyHash: createHash("sha256").update("k").digest("hex").slice(0, 16),
		});
		expect(raw).not.toContain('"k"');
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
		expect(await holdFiles()).toEqual(["sess1__agent-A__tu_1.tx_sub.json"]);
		const entry = JSON.parse(
			await readFile(join(stateDir, "sess1__agent-A__tu_1.tx_sub.json"), "utf-8"),
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
		expect(await holdFiles()).toEqual([]);
	});

	it("fails closed (exit 2) on a 200 missing transferId", async () => {
		const port = await startFake(() => ({ status: 200, json: { estimatedCost: 3 } }));
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(2);
		expect(await holdFiles()).toEqual([]);
	});

	it("UT_FAIL_OPEN=1 lets the call through with NO decision, and a warning, when the server is unreachable", async () => {
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: "http://127.0.0.1:9",
			UT_FAIL_OPEN: "1",
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("ungoverned");
	});

	it("a shadow response lets the call through with NO decision, and records nothing", async () => {
		const port = await startFake(() => ({
			status: 200,
			json: { shadow: true, shadowId: "shadow_1", decision: "would_deny", reason: "rule" },
		}));
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("shadow");
		expect(await holdFiles()).toEqual([]);
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
			maxOutputTokens: number;
			messages: Array<{ content: string }>;
		};
		expect(body.messages[0]?.content.length).toBe(16_384);
		expect(body.estimatedInputTokens).toBe(4096);
		// Output hold is the same 16 KiB cap (4096 tokens), not 1.
		expect(body.maxOutputTokens).toBe(4096);
	});

	it("sizes the authorize hold on both legs so a content-cap settle cannot shortfall", async () => {
		const { estimateTokens, MAX_CONTENT_CHARS, MAX_OUTPUT_TOKENS } = await import(
			"../hooks/lib.mjs"
		);
		const port = await startFake(() => ({
			status: 200,
			json: { transferId: "tx_hold", estimatedCost: 1, model: "m", createdAt: 1 },
		}));
		const payload = { ...PAYLOAD, tool_input: { command: "x".repeat(40_000) } };
		const result = await runHook(HOOK, payload, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(0);
		const body = requests[0] as {
			estimatedInputTokens: number;
			maxOutputTokens: number;
		};
		expect(body.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
		expect(body.maxOutputTokens).toBeGreaterThan(1);
		const settleAtCap = body.estimatedInputTokens + estimateTokens("x".repeat(MAX_CONTENT_CHARS));
		expect(body.estimatedInputTokens + body.maxOutputTokens).toBeGreaterThanOrEqual(settleAtCap);
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

/** The preload that leaves a set part of the hook's budget once an authorize is answered 503. */
const BUDGET_AFTER_503 = join(import.meta.dirname, "helpers", "budget-after-503.mjs");

describe("pre-tool-use: a 503 ledger_unavailable is tried once more", () => {
	const UNAVAILABLE = {
		status: 503,
		json: {
			error: "ledger_unavailable",
			reason: "no answer came within 5000 ms",
			retryAfterMs: 5000,
		},
	};
	/** Answers the authorizes in turn, then 500 for any past the list. */
	function answers(...list: Array<{ status: number; json: unknown; delayMs?: number }>) {
		let n = 0;
		return () => list[n++] ?? { status: 500, json: { error: "unexpected extra authorize" } };
	}

	const RESERVED = { status: 200, json: { transferId: "tx_after_retry", estimatedCost: 3 } };
	/** How long the hook waited between the 503 and its retry, as the server saw it. */
	const gap = () => (arrivals[1] ?? Number.NaN) - (arrivals[0] ?? Number.NaN);

	it("503 then 200: the call is reserved, after exactly one retry, made a full 1 s later", async () => {
		const port = await startFake(answers(UNAVAILABLE, RESERVED));
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(requests).toHaveLength(2);
		// The retry is the same authorize.
		expect(requests[1]).toEqual(requests[0]);
		expect(gap()).toBeGreaterThanOrEqual(950);
		expect(gap()).toBeLessThan(2_500);
		expect(await holdFiles()).toHaveLength(1);
		expect(result.stderr).toContain("reserved tx_after_retry");
	});

	it("a short budget cuts the wait: 1.8 s left after the 503 leaves a wait of about 300 ms, then the retry", async () => {
		const port = await startFake(answers(UNAVAILABLE, RESERVED));
		const result = await runHook(
			HOOK,
			PAYLOAD,
			{ ...baseEnv, UT_SERVER_URL: `http://127.0.0.1:${port}`, UT_CC_TEST_LEFT_AFTER_503: "1800" },
			["--import", BUDGET_AFTER_503],
		);
		expect(result.code).toBe(0);
		expect(requests).toHaveLength(2);
		expect(gap()).toBeGreaterThanOrEqual(200);
		expect(gap()).toBeLessThan(800);
		expect(result.stderr).toContain("reserved tx_after_retry");
	});

	it("no retry when no wait fits: 1.4 s left after the 503 is the outage path at once", async () => {
		const port = await startFake(answers(UNAVAILABLE, RESERVED));
		const result = await runHook(
			HOOK,
			PAYLOAD,
			{ ...baseEnv, UT_SERVER_URL: `http://127.0.0.1:${port}`, UT_CC_TEST_LEFT_AFTER_503: "1400" },
			["--import", BUDGET_AFTER_503],
		);
		expect(result.code).toBe(2);
		expect(requests).toHaveLength(1);
		expect(result.stderr).toContain("unexpected governance response 503");
	});

	it("a 503 answered AT the server's 5 s deadline is received (not given up on first), and retried", async () => {
		const port = await startFake(answers({ ...UNAVAILABLE, delayMs: 5_000 }, RESERVED));
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(0);
		expect(requests).toHaveLength(2);
		expect(result.stderr).toContain("reserved tx_after_retry");
	}, 20_000);

	for (const [label, env, code] of [
		["enforce", {}, 2],
		["enforce with failOpen", { UT_FAIL_OPEN: "1" }, 0],
		["watch", { UT_CC_MODE: "watch" }, 0],
	] as const) {
		it(`503 then 503 (${label}): the outage path, as before, after exactly one retry`, async () => {
			const port = await startFake(answers(UNAVAILABLE, UNAVAILABLE));
			const result = await runHook(HOOK, PAYLOAD, {
				...baseEnv,
				...env,
				UT_SERVER_URL: `http://127.0.0.1:${port}`,
			});
			expect(result.code).toBe(code);
			expect(requests).toHaveLength(2);
			expect(result.stderr).toContain("unexpected governance response 503");
			// No hold. Where the call proceeds, its miss is a `gap` record, as for any outage.
			const files = await holdFiles();
			expect(files.filter((name) => name !== "watch.jsonl")).toEqual([]);
			if (code === 0) {
				const records = (await readFile(join(stateDir, "watch.jsonl"), "utf-8"))
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { kind: string });
				expect(records).toMatchObject([{ kind: "gap", tool: "Bash" }]);
			} else {
				expect(files).toEqual([]);
			}
		});
	}

	for (const status of [402, 403, 429]) {
		it(`a ${status} refusal is never retried`, async () => {
			const port = await startFake(
				answers({ status, json: { error: "denied", reason: "no" } }, { status: 200, json: {} }),
			);
			const result = await runHook(HOOK, PAYLOAD, {
				...baseEnv,
				UT_SERVER_URL: `http://127.0.0.1:${port}`,
			});
			expect(requests).toHaveLength(1);
			expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
		});
	}

	it("a 503 that is not ledger_unavailable is not retried: the outage path at once", async () => {
		const port = await startFake(
			answers({ status: 503, json: { error: "overloaded" } }, { status: 200, json: {} }),
		);
		const result = await runHook(HOOK, PAYLOAD, {
			...baseEnv,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
		});
		expect(result.code).toBe(2);
		expect(requests).toHaveLength(1);
	});
});
