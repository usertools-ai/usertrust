// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The contract between this plugin's give-backs and usertrust-server's `/v1/release`
 * (usertrust #238), driven with the REAL hooks against a REAL dry-run server.
 *
 * A give-back used to reach the server as `/v1/abort`, which counts as a failure on the
 * tenant's circuit breaker: five in a row failed every authorize for a minute. The
 * plugin already prefers `/v1/release` when the server publishes `release`, through two
 * separate pieces of code, and both are pinned here:
 *  - `releaseHold` (lib.mjs), behind every leftover hold Stop gives back;
 *  - `returnEmptyHold` (transcript.mjs), behind PostToolUse's empty transcript hold,
 *    which against an older server is settled at zero (the server's 1-unit floor).
 *
 * The terms shipped clients depend on: the body `{ transferId, reason }`, the
 * capability `release`, a 200 only when the hold was released, and a 404
 * `unknown transferId` for a hold the server no longer knows. After a failed
 * capability read the plugin falls back to `/v1/abort` ONLY on `unknown route`.
 *
 * Every transcript here is SYNTHETIC; no real transcript content is used.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedgerEvents } from "usertrust";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../../server/src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../../server/src/server.js";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const SESSION = "11111111-2222-4333-8444-555555555555";
const SONNET = "claude-sonnet-4-6";
const KEY = "ut_plugin_release_key";

interface Recorded {
	path: string;
	body: Record<string, unknown>;
	status: number;
	response: unknown;
}

let stateDir: string;
let mainTranscript: string;
let serverState: string;
let real: UsertrustServer | undefined;
let proxy: Server | undefined;
let proxyPort: number;
let requests: Recorded[];
/**
 * How the proxy answers /v1/health: as the server does (`forward`), as one whose
 * capabilities cannot be read (`fail`), or as an older one with no `release` (`older`).
 */
let health: "forward" | "fail" | "older";

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-rel-state-"));
	const projectDir = await mkdtemp(join(tmpdir(), "utcc-rel-proj-"));
	mainTranscript = join(projectDir, `${SESSION}.jsonl`);
	requests = [];
	health = "forward";
});

afterEach(async () => {
	proxy?.closeAllConnections();
	proxy?.close();
	proxy = undefined;
	await real?.close();
	real = undefined;
});

/** A real dry-run usertrust-server, behind a proxy that records every request. */
async function startReal(pendingTtlMs = 240_000): Promise<void> {
	serverState = await mkdtemp(join(tmpdir(), "utcc-rel-srv-"));
	real = createUsertrustServer({
		config: {
			host: "127.0.0.1",
			port: 0,
			stateDir: serverState,
			enforcement: "enforce",
			pendingTtlMs,
			dryRun: true,
			tenants: [{ id: "t", keyHash: hashKey(KEY), budget: 10_000_000 }],
		},
	});
	const { port } = await real.listen();
	const base = `http://127.0.0.1:${port}`;
	await new Promise<void>((resolve) => {
		proxy = createServer((req, res) => {
			const send = (status: number, json: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(json));
			};
			if (req.method === "GET" && req.url === "/v1/health") {
				if (health === "fail") return send(503, { error: "unavailable" });
				void fetch(`${base}/v1/health`)
					.then((r) => r.json() as Promise<{ capabilities?: string[] }>)
					.then((json) => {
						if (health === "older" && Array.isArray(json.capabilities)) {
							json.capabilities = json.capabilities.filter((c) => c !== "release");
						}
						send(200, json);
					});
				return;
			}
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", async () => {
				const path = req.url ?? "";
				const r = await fetch(`${base}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
					body: raw,
				});
				const json = await r.json();
				requests.push({ path, body: JSON.parse(raw || "{}"), status: r.status, response: json });
				send(r.status, json);
			});
		});
		proxy.listen(0, "127.0.0.1", () => {
			const address = proxy?.address();
			proxyPort = typeof address === "object" && address !== null ? address.port : 0;
			resolve();
		});
	});
}

function run(name: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
	return runHook(join(HOOKS, name), input, {
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_URL: `http://127.0.0.1:${proxyPort}`,
		UT_SERVER_KEY: "k",
		...env,
	});
}

/** One complete API response: a single final entry with its usage. */
function response(id: string, input: number, output: number): string {
	return JSON.stringify({
		type: "assistant",
		sessionId: SESSION,
		uuid: `${id}-final`,
		message: {
			id,
			model: SONNET,
			role: "assistant",
			type: "message",
			stop_reason: "tool_use",
			content: [{ type: "text", text: "synthetic" }],
			usage: {
				input_tokens: input,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: output,
			},
		},
	});
}

async function writeMain(lines: string[]): Promise<void> {
	const user = JSON.stringify({
		type: "user",
		sessionId: SESSION,
		message: { role: "user", content: "synthetic" },
	});
	await writeFile(mainTranscript, `${[user, ...lines].join("\n")}\n`);
}

const stopInput = () => ({ session_id: SESSION, transcript_path: mainTranscript });
const preInput = (toolUseId: string) => ({
	...stopInput(),
	tool_name: "Bash",
	tool_use_id: toolUseId,
	tool_input: { command: "ls" },
});
const postInput = (toolUseId: string) => ({
	...stopInput(),
	tool_use_id: toolUseId,
	tool_response: "eight ch",
});

const on = (path: string) => requests.filter((r) => r.path === path);
const releases = () => on("/v1/release");
const aborts = () => on("/v1/abort");
const settles = () => on("/v1/settle");
const authorizes = () => on("/v1/authorize");
const heldBy = (i: number): string => {
	const id = (authorizes()[i]?.response as { transferId?: string } | undefined)?.transferId;
	if (id === undefined) throw new Error(`authorize #${i} answered no transferId`);
	return id;
};
const ESTIMATE = { UT_CC_USAGE: "estimate" };

/** Let the server's own sweep end every hold, so it no longer knows them. */
async function sweepAll(): Promise<void> {
	await new Promise((r) => setTimeout(r, 80));
	expect(await real?.sweepExpired()).toBeGreaterThan(0);
}

/** The audit kinds the tenant's chain holds for one hold, read once the server closed. */
async function chainFor(transferId: string): Promise<string[]> {
	await real?.close();
	real = undefined;
	return readLedgerEvents(join(serverState, "t", ".usertrust"))
		.filter((e) => e.data.transferId === transferId)
		.map((e) => e.kind);
}

describe("releaseHold: every leftover hold Stop gives back", () => {
	it("`release` advertised: ONE /v1/release and a 200 per hold, never an abort, and five leave the next authorize open", async () => {
		await startReal();
		await writeMain([]);
		for (let i = 0; i < 5; i += 1) {
			expect((await run("pre-tool-use.mjs", preInput(`tu_${i}`), ESTIMATE)).code).toBe(0);
			const stop = await run("stop.mjs", stopInput(), ESTIMATE);
			expect(stop.stderr).not.toContain("refused");
		}
		expect(releases().map((r) => [r.body.transferId, r.status])).toEqual(
			[0, 1, 2, 3, 4].map((i) => [heldBy(i), 200]),
		);
		expect(aborts()).toHaveLength(0);
		// Five aborts opened the tenant's breaker, and this authorize answered 500: a gap.
		const pre = await run("pre-tool-use.mjs", preInput("tu_5"), ESTIMATE);
		expect(authorizes().at(-1)?.status).toBe(200);
		expect(pre.stderr).toContain("reserved");
	});

	it("the capability read failing: a live hold is still released, ONE /v1/release and a 200, no abort", async () => {
		await startReal();
		health = "fail";
		await writeMain([]);
		await run("pre-tool-use.mjs", preInput("tu_1"), ESTIMATE);
		await run("stop.mjs", stopInput(), ESTIMATE);
		expect(releases().map((r) => [r.body.transferId, r.status])).toEqual([[heldBy(0), 200]]);
		expect(aborts()).toHaveLength(0);
	});

	it("the capability read failing, a hold the server no longer knows: 404 `unknown transferId`, and NO abort", async () => {
		await startReal(50);
		health = "fail";
		await writeMain([]);
		await run("pre-tool-use.mjs", preInput("tu_1"), ESTIMATE);
		await sweepAll();
		await run("stop.mjs", stopInput(), ESTIMATE);
		expect(releases().map((r) => [r.body.transferId, r.status, r.response])).toEqual([
			[heldBy(0), 404, { error: "not_found", reason: "unknown transferId" }],
		]);
		// An unknown ROUTE is what sends this client to /v1/abort; an unknown id never does.
		expect(aborts()).toHaveLength(0);
	});
});

describe("returnEmptyHold: PostToolUse's empty transcript hold", () => {
	it("`release` advertised: ONE /v1/release and a 200, no zero settle, and the chain says hold_released", async () => {
		await startReal();
		await writeMain([response("msg_a", 5, 50)]);
		// Parallel calls: the window rides the first hold, the second holds nothing.
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("pre-tool-use.mjs", preInput("tu_2"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_2"));
		const [windowHold, emptyHold] = [heldBy(0), heldBy(1)];
		expect(releases().map((r) => [r.body.transferId, r.status])).toEqual([[emptyHold, 200]]);
		expect(settles().map((s) => s.body.transferId)).toEqual([windowHold]);
		expect(aborts()).toHaveLength(0);
		// No 1-unit charge for a call that used nothing: a void, and a neutral record.
		expect(await chainFor(emptyHold)).toEqual(["hold_released"]);
	});

	it("an older server (no `release`): the zero settle, unchanged", async () => {
		await startReal();
		health = "older";
		await writeMain([response("msg_a", 5, 50)]);
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await run("pre-tool-use.mjs", preInput("tu_2"));
		await run("post-tool-use.mjs", postInput("tu_1"));
		await run("post-tool-use.mjs", postInput("tu_2"));
		const emptyHold = heldBy(1);
		expect(releases()).toHaveLength(0);
		expect(settles().find((s) => s.body.transferId === emptyHold)?.body).toMatchObject({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
	});

	it("the capability read failing, a hold the server no longer knows is gone: returned, no settle, no abort", async () => {
		await startReal(50);
		health = "fail";
		await writeMain([]);
		await run("pre-tool-use.mjs", preInput("tu_1"));
		await sweepAll();
		await run("post-tool-use.mjs", postInput("tu_1"));
		expect(releases().map((r) => [r.body.transferId, r.status])).toEqual([[heldBy(0), 404]]);
		expect(settles()).toHaveLength(0);
		expect(aborts()).toHaveLength(0);
	});
});
