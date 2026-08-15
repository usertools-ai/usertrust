import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");

let server: Server | undefined;
let stateDir: string;
let port: number;
let requests: Array<{ path: string; body: unknown }>;

type Responder = (path: string, body: unknown) => { status: number; json: unknown };

const okResponder: Responder = () => ({
	status: 200,
	json: { settled: true, aborted: true, cost: 1, budgetRemaining: 9 },
});

function startFake(responder: Responder = okResponder): Promise<void> {
	requests = [];
	return new Promise((resolve) => {
		server = createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", () => {
				const path = req.url ?? "";
				const body = JSON.parse(raw || "{}") as unknown;
				requests.push({ path, body });
				const out = responder(path, body);
				res.writeHead(out.status, { "content-type": "application/json" });
				res.end(JSON.stringify(out.json));
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server?.address();
			port = typeof address === "object" && address !== null ? address.port : 0;
			resolve();
		});
	});
}

/**
 * Seed the per-hold state files the way pre-tool-use records them: keyed
 * <session>__<agent>__<entryKey>.json with the owning agent stored in the body
 * so whole-session sweeps can recover it (A9).
 */
async function seedState(
	sessionId: string,
	agentId: string,
	pending: Array<{
		toolUseId: string | null;
		transferId: string;
		estimatedInputTokens?: number;
	}>,
) {
	for (const entry of pending) {
		const entryKey = entry.toolUseId ?? entry.transferId;
		await writeFile(
			join(stateDir, `${sessionId}__${agentId}__${entryKey}.json`),
			JSON.stringify({ ...entry, agentId }),
		);
		// Distinct mtimes so oldest-first ordering is deterministic.
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function run(name: string, input: unknown, portOverride?: number) {
	return runHook(join(HOOKS, name), input, {
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_URL: `http://127.0.0.1:${portOverride ?? port}`,
		UT_SERVER_KEY: "k",
	});
}

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-life-"));
	requests = [];
});
afterEach(() => {
	server?.close();
	server = undefined;
});

describe("post-tool-use hook", () => {
	it("settles the matching pending entry and deletes its file only after the 200", async () => {
		await startFake();
		await seedState("s1", "main", [
			{ toolUseId: "tu_1", transferId: "tx_1", estimatedInputTokens: 4 },
		]);
		const result = await run("post-tool-use.mjs", {
			session_id: "s1",
			tool_use_id: "tu_1",
			tool_response: "eight ch",
		});
		expect(result.code).toBe(0);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.path).toBe("/v1/settle");
		const body = requests[0]?.body as {
			transferId: string;
			inputTokens: number;
			outputTokens: number;
			usageSource: string;
		};
		expect(body.transferId).toBe("tx_1");
		expect(body.inputTokens).toBe(4);
		expect(body.outputTokens).toBe(3);
		expect(body.usageSource).toBe("estimated");
		expect(await readdir(stateDir)).toEqual([]);
	});

	it("re-estimates inputTokens from tool_input when the pending file has no estimate", async () => {
		await startFake();
		await seedState("s1", "main", [{ toolUseId: "tu_1", transferId: "tx_1" }]);
		const result = await run("post-tool-use.mjs", {
			session_id: "s1",
			tool_use_id: "tu_1",
			tool_input: { command: "ls" },
			tool_response: "ok",
		});
		expect(result.code).toBe(0);
		const body = requests[0]?.body as { inputTokens: number; outputTokens: number };
		// JSON.stringify({command:"ls"}) is 16 chars -> 4 estimated tokens.
		expect(body.inputTokens).toBe(4);
		expect(body.outputTokens).toBe(1);
	});

	it("does not steal an unmatched tool_use_id — no settle, hold stays", async () => {
		await startFake();
		await seedState("s1", "main", [{ toolUseId: "tu_1", transferId: "tx_1" }]);
		const result = await run("post-tool-use.mjs", {
			session_id: "s1",
			tool_use_id: "zzz",
			tool_response: "x",
		});
		expect(result.code).toBe(0);
		expect(requests).toHaveLength(0);
		expect(await readdir(stateDir)).toEqual(["s1__main__tu_1.json"]);
	});

	it("exits 0 with no server call when nothing is pending", async () => {
		await startFake();
		const result = await run("post-tool-use.mjs", { session_id: "s1", tool_use_id: "x" });
		expect(result.code).toBe(0);
		expect(requests).toHaveLength(0);
	});

	it("never fails closed — transport failure exits 0 and keeps the pending file", async () => {
		await seedState("s1", "main", [{ toolUseId: "tu_1", transferId: "tx_1" }]);
		const result = await run(
			"post-tool-use.mjs",
			{ session_id: "s1", tool_use_id: "tu_1", tool_response: "x" },
			9,
		);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("settle");
		// The hold survives for Stop/SubagentStop cleanup (A10).
		expect(await readdir(stateDir)).toEqual(["s1__main__tu_1.json"]);
	});

	it("keeps the pending file on a non-200 settle response", async () => {
		await startFake(() => ({ status: 500, json: { error: "internal" } }));
		await seedState("s1", "main", [{ toolUseId: "tu_1", transferId: "tx_1" }]);
		const result = await run("post-tool-use.mjs", {
			session_id: "s1",
			tool_use_id: "tu_1",
			tool_response: "x",
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("settle");
		expect(result.stderr).toContain("500");
		expect(await readdir(stateDir)).toEqual(["s1__main__tu_1.json"]);
	});

	it("post-tool-use from agent A settles A's hold and never a sibling's (pre→post scoping)", async () => {
		const responder: Responder = (path) =>
			path === "/v1/authorize"
				? { status: 200, json: { transferId: "tx_scoped", estimatedCost: 2 } }
				: { status: 200, json: { settled: true } };
		await startFake(responder);
		// A sibling hold under a different agent must be left untouched.
		await seedState("sess", "main", [{ toolUseId: "tu_main", transferId: "tx_main" }]);
		const pre = await run("pre-tool-use.mjs", {
			session_id: "sess",
			agent_id: "agent-A",
			tool_name: "Bash",
			tool_use_id: "tu_a",
			tool_input: { command: "ls" },
		});
		expect(pre.code).toBe(0);
		const post = await run("post-tool-use.mjs", {
			session_id: "sess",
			agent_id: "agent-A",
			tool_use_id: "tu_a",
			tool_response: "ok",
		});
		expect(post.code).toBe(0);
		const settles = requests.filter((r) => r.path === "/v1/settle");
		expect(settles).toHaveLength(1);
		// biome-ignore lint/correctness/noUnsafeOptionalChaining: settles[0] guaranteed present by the toHaveLength(1) assertion above
		expect((settles[0]?.body as { transferId: string }).transferId).toBe("tx_scoped");
		const settleBody = settles[0]?.body as {
			inputTokens: number;
			outputTokens: number;
			usageSource: string;
		};
		// Authorize-time input estimate ({command:"ls"} → 4) is persisted and sent.
		expect(settleBody.inputTokens).toBe(4);
		expect(settleBody.outputTokens).toBe(1);
		expect(settleBody.usageSource).toBe("estimated");
		// main's hold is still present; only agent-A's was settled and cleared.
		expect(await readdir(stateDir)).toEqual(["sess__main__tu_main.json"]);
	});

	it("a content-cap settle does not exceed the reserved hold on either leg", async () => {
		const { MAX_CONTENT_CHARS, MAX_OUTPUT_TOKENS, estimateTokens } = await import(
			"../hooks/lib.mjs"
		);
		const responder: Responder = (path) =>
			path === "/v1/authorize"
				? { status: 200, json: { transferId: "tx_cap", estimatedCost: 2 } }
				: { status: 200, json: { settled: true } };
		await startFake(responder);
		const pre = await run("pre-tool-use.mjs", {
			session_id: "sess",
			tool_name: "Read",
			tool_use_id: "tu_cap",
			tool_input: { command: "x".repeat(40_000) },
		});
		expect(pre.code).toBe(0);
		const auth = requests.find((r) => r.path === "/v1/authorize")?.body as {
			estimatedInputTokens: number;
			maxOutputTokens: number;
		};
		expect(auth.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
		const post = await run("post-tool-use.mjs", {
			session_id: "sess",
			tool_use_id: "tu_cap",
			tool_response: "y".repeat(MAX_CONTENT_CHARS),
		});
		expect(post.code).toBe(0);
		const settle = requests.find((r) => r.path === "/v1/settle")?.body as {
			inputTokens: number;
			outputTokens: number;
		};
		expect(settle.inputTokens).toBe(auth.estimatedInputTokens);
		expect(settle.outputTokens).toBe(
			estimateTokens(JSON.stringify("y".repeat(MAX_CONTENT_CHARS)).slice(0, MAX_CONTENT_CHARS)),
		);
		expect(auth.estimatedInputTokens + auth.maxOutputTokens).toBeGreaterThanOrEqual(
			settle.inputTokens + settle.outputTokens,
		);
	});
});

describe("stop.mjs aborts every hold across all agents", () => {
	it("aborts the parent's and every subagent's holds, then clears state (idempotent)", async () => {
		await startFake();
		await seedState("s2", "main", [{ toolUseId: "a", transferId: "tx_main" }]);
		await seedState("s2", "agent-A", [{ toolUseId: "b", transferId: "tx_a" }]);
		await seedState("s2", "agent-B", [{ toolUseId: "c", transferId: "tx_b" }]);
		const result = await run("stop.mjs", { session_id: "s2" });
		expect(result.code).toBe(0);
		const aborts = requests.filter((r) => r.path === "/v1/abort");
		expect(aborts.map((r) => (r.body as { transferId: string }).transferId).sort()).toEqual([
			"tx_a",
			"tx_b",
			"tx_main",
		]);
		expect(await readdir(stateDir)).toEqual([]);
		const again = await run("stop.mjs", { session_id: "s2" });
		expect(again.code).toBe(0);
		expect(requests.filter((r) => r.path === "/v1/abort")).toHaveLength(3);
	});

	it("logs non-200 abort responses to stderr but still exits 0 and clears state", async () => {
		await startFake(() => ({ status: 500, json: { error: "internal" } }));
		await seedState("s3", "main", [{ toolUseId: "a", transferId: "tx_a" }]);
		const result = await run("stop.mjs", { session_id: "s3" });
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("abort");
		expect(result.stderr).toContain("500");
		expect(await readdir(stateDir)).toEqual([]);
	});
});

describe("subagent-stop.mjs scopes cleanup to the stopping subagent", () => {
	it("with agent_id aborts only that subagent's holds, leaving parent and siblings intact", async () => {
		await startFake();
		await seedState("s2", "main", [{ toolUseId: "a", transferId: "tx_main" }]);
		await seedState("s2", "agent-A", [
			{ toolUseId: "b", transferId: "tx_a1" },
			{ toolUseId: "c", transferId: "tx_a2" },
		]);
		await seedState("s2", "agent-B", [{ toolUseId: "d", transferId: "tx_b" }]);
		const result = await run("subagent-stop.mjs", { session_id: "s2", agent_id: "agent-A" });
		expect(result.code).toBe(0);
		const aborts = requests.filter((r) => r.path === "/v1/abort");
		expect(aborts.map((r) => (r.body as { transferId: string }).transferId).sort()).toEqual([
			"tx_a1",
			"tx_a2",
		]);
		// The parent's and sibling subagent's in-flight holds survive.
		expect((await readdir(stateDir)).sort()).toEqual(["s2__agent-B__d.json", "s2__main__a.json"]);
	});

	it("without agent_id aborts nothing and leaves every hold for later reconciliation", async () => {
		await startFake();
		await seedState("s2", "main", [{ toolUseId: "a", transferId: "tx_main" }]);
		await seedState("s2", "agent-A", [{ toolUseId: "b", transferId: "tx_a" }]);
		const result = await run("subagent-stop.mjs", { session_id: "s2" });
		expect(result.code).toBe(0);
		expect(requests.filter((r) => r.path === "/v1/abort")).toHaveLength(0);
		expect(result.stderr).toContain("without agent_id");
		expect((await readdir(stateDir)).sort()).toEqual(["s2__agent-A__b.json", "s2__main__a.json"]);
	});
});
