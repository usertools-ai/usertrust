// Real-usage settlement from Claude Code's session transcripts.
//
// Every transcript here is SYNTHETIC: written by this file in the measured
// shape (one JSONL per agent; subagents under <session>/subagents/ with a
// meta.json carrying agentType; one API response spread over several entries
// sharing message.id, only the final one carrying stop_reason; a provider
// usage block with disjoint input / cache-read / cache-write / output counts).
// No real transcript content is used or copied.
import { appendFile, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../../server/src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../../server/src/server.js";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const SESSION = "11111111-2222-4333-8444-555555555555";

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface Recorded {
	path: string;
	body: Record<string, unknown>;
	status: number;
	response: unknown;
}

let stateDir: string;
let projectDir: string;
let mainTranscript: string;
let fake: Server | undefined;
let real: UsertrustServer | undefined;
let port: number;
let requests: Recorded[];

type Responder = (path: string, body: Record<string, unknown>) => { status: number; json: unknown };

let nextTransfer = 0;
const okResponder: Responder = (path) => {
	if (path === "/v1/authorize") {
		nextTransfer += 1;
		return { status: 200, json: { transferId: `tx_${nextTransfer}`, estimatedCost: 1 } };
	}
	return { status: 200, json: { settled: true, aborted: true } };
};

/** A recording server: a fixed responder, or a pass-through to a real usertrust-server. */
function startServer(responder: Responder | { forwardTo: string; key: string }): Promise<void> {
	return new Promise((resolve) => {
		fake = createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => {
				raw += c;
			});
			req.on("end", async () => {
				const path = req.url ?? "";
				const body = JSON.parse(raw || "{}") as Record<string, unknown>;
				let out: { status: number; json: unknown };
				if (typeof responder === "function") {
					out = responder(path, body);
				} else {
					const r = await fetch(`${responder.forwardTo}${path}`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${responder.key}`,
						},
						body: raw,
					});
					out = { status: r.status, json: await r.json() };
				}
				requests.push({ path, body, status: out.status, response: out.json });
				res.writeHead(out.status, { "content-type": "application/json" });
				res.end(JSON.stringify(out.json));
			});
		});
		fake.listen(0, "127.0.0.1", () => {
			const address = fake?.address();
			port = typeof address === "object" && address !== null ? address.port : 0;
			resolve();
		});
	});
}

function run(name: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
	return runHook(join(HOOKS, name), input, {
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_URL: `http://127.0.0.1:${port}`,
		UT_SERVER_KEY: "k",
		...env,
	});
}

/** The entries one API response writes: partial stream entries, then the final one. */
function responseEntries(
	id: string,
	model: string,
	u: Usage,
	extra: Record<string, unknown> = {},
	options: { partials?: number; complete?: boolean } = {},
): string[] {
	const lines: string[] = [];
	const partials = options.partials ?? 2;
	const usage = (output: number) => ({
		input_tokens: u.input,
		cache_creation_input_tokens: u.cacheWrite,
		cache_read_input_tokens: u.cacheRead,
		output_tokens: output,
		cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite, ephemeral_1h_input_tokens: 0 },
		service_tier: "standard",
	});
	for (let i = 0; i < partials; i += 1) {
		lines.push(
			JSON.stringify({
				type: "assistant",
				sessionId: SESSION,
				uuid: `${id}-p${i}`,
				...extra,
				message: {
					id,
					model,
					role: "assistant",
					type: "message",
					stop_reason: null,
					content: [{ type: "text", text: "synthetic" }],
					usage: usage(Math.max(1, Math.floor((u.output * (i + 1)) / (partials + 2)))),
				},
			}),
		);
	}
	if (options.complete !== false) {
		lines.push(
			JSON.stringify({
				type: "assistant",
				sessionId: SESSION,
				uuid: `${id}-final`,
				...extra,
				message: {
					id,
					model,
					role: "assistant",
					type: "message",
					stop_reason: "end_turn",
					content: [{ type: "text", text: "synthetic" }],
					usage: { ...usage(u.output), iterations: [{ type: "message" }] },
				},
			}),
		);
	}
	return lines;
}

const userLine = JSON.stringify({
	type: "user",
	sessionId: SESSION,
	message: { role: "user", content: "synthetic" },
});

async function writeMain(lines: string[]) {
	await writeFile(mainTranscript, `${[userLine, ...lines].join("\n")}\n`);
}

async function writeSubagent(agentId: string, agentType: string | null, lines: string[]) {
	const dir = join(projectDir, SESSION, "subagents");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `agent-${agentId}.jsonl`), `${lines.join("\n")}\n`);
	if (agentType !== null) {
		await writeFile(
			join(dir, `agent-${agentId}.meta.json`),
			JSON.stringify({ agentType, description: "synthetic", toolUseId: "tu_spawn", spawnDepth: 1 }),
		);
	}
}

function sub(agentId: string) {
	return { agentId, isSidechain: true };
}

const settles = () => requests.filter((r) => r.path === "/v1/settle");
const authorizes = () => requests.filter((r) => r.path === "/v1/authorize");

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-tx-state-"));
	projectDir = await mkdtemp(join(tmpdir(), "utcc-tx-proj-"));
	mainTranscript = join(projectDir, `${SESSION}.jsonl`);
	requests = [];
	nextTransfer = 0;
});
afterEach(async () => {
	fake?.close();
	fake = undefined;
	await real?.close();
	real = undefined;
});

const stopInput = () => ({ session_id: SESSION, transcript_path: mainTranscript });

describe("transcript usage — what gets counted", () => {
	it("settles each COMPLETE message once, per model, at its real disjoint counts", async () => {
		await startServer(okResponder);
		await writeMain([
			...responseEntries("msg_a", "claude-sonnet-4-6", {
				input: 10,
				output: 200,
				cacheRead: 5000,
				cacheWrite: 300,
			}),
			...responseEntries("msg_b", "claude-sonnet-4-6", {
				input: 4,
				output: 50,
				cacheRead: 5300,
				cacheWrite: 0,
			}),
			...responseEntries("msg_c", "claude-haiku-4-5", {
				input: 7,
				output: 9,
				cacheRead: 0,
				cacheWrite: 100,
			}),
		]);
		const result = await run("stop.mjs", stopInput());
		expect(result.code).toBe(0);
		const bodies = settles().map((s) => s.body);
		expect(bodies).toHaveLength(2);
		const sonnetTx = authorizes().find((a) => a.body.model === "claude-sonnet-4-6");
		const sonnetTransferId = (sonnetTx?.response as { transferId?: string } | undefined)
			?.transferId;
		expect(sonnetTransferId).toBeDefined();
		const sonnet = bodies.find((b) => b.transferId === sonnetTransferId);
		// Partial stream entries and repeated content-block entries are NOT
		// added again: one message, one count, from its final entry.
		expect(sonnet).toMatchObject({
			inputTokens: 14,
			outputTokens: 250,
			cacheReadTokens: 10300,
			cacheWriteTokens: 300,
			usageSource: "provider",
		});
		expect(sonnetTx?.body).toMatchObject({
			actor: `claude-code:${SESSION}:main:main`,
			params: {
				hook: "Stop",
				usageOrigin: "transcript",
				agent_id: "main",
				agent_type: "main",
				messages: 2,
			},
		});
		// No content leaves the machine on a transcript settle.
		expect(sonnetTx?.body.messages).toBeUndefined();
		// The hold covers the real cost: cache writes are held at 2x.
		expect(sonnetTx?.body.estimatedInputTokens).toBe(14 + 10300 + 600);
		expect(sonnetTx?.body.maxOutputTokens).toBe(250);
	});

	it("leaves a message that is still streaming for the next settle point", async () => {
		await startServer(okResponder);
		await writeMain([
			...responseEntries("msg_a", "claude-sonnet-4-6", {
				input: 1,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
			}),
			...responseEntries(
				"msg_b",
				"claude-sonnet-4-6",
				{ input: 2, output: 99, cacheRead: 0, cacheWrite: 0 },
				{},
				{ complete: false },
			),
		]);
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.outputTokens)).toEqual([10]);
		// msg_b completes later; only it is settled, at its FINAL output.
		await appendFile(
			mainTranscript,
			`${responseEntries("msg_b", "claude-sonnet-4-6", { input: 2, output: 99, cacheRead: 0, cacheWrite: 0 }, {}, { partials: 0 }).join("\n")}\n`,
		);
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.outputTokens)).toEqual([10, 99]);
	});

	it("never prices Claude Code's synthetic placeholder messages", async () => {
		await startServer(okResponder);
		await writeMain(
			responseEntries("msg_s", "<synthetic>", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		);
		await run("stop.mjs", stopInput());
		expect(requests).toEqual([]);
	});
});

describe("transcript usage — idempotency", () => {
	it("a re-run settles nothing; a new message settles only itself", async () => {
		await startServer(okResponder);
		await writeMain(
			responseEntries("msg_a", "claude-sonnet-4-6", {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
			}),
		);
		await run("stop.mjs", stopInput());
		await run("stop.mjs", stopInput());
		await run("subagent-stop.mjs", { ...stopInput(), agent_id: "nobody" });
		expect(settles()).toHaveLength(1);
		await appendFile(
			mainTranscript,
			`${responseEntries("msg_b", "claude-sonnet-4-6", { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }).join("\n")}\n`,
		);
		await run("stop.mjs", stopInput());
		expect(settles().map((s) => s.body.inputTokens)).toEqual([1, 5]);
	});

	it("concurrent settle points never post the same message twice", async () => {
		await startServer(okResponder);
		await writeMain(
			Array.from({ length: 20 }, (_, i) =>
				responseEntries(`msg_${i}`, "claude-sonnet-4-6", {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
				}),
			).flat(),
		);
		await Promise.all(Array.from({ length: 6 }, () => run("stop.mjs", stopInput())));
		await run("stop.mjs", stopInput());
		const total = settles().reduce((sum, s) => sum + Number(s.body.inputTokens), 0);
		expect(total).toBe(20);
	});

	it("a settle the server REFUSED is retried at the next settle point (abort proved nothing posted)", async () => {
		let failSettle = true;
		await startServer((path, body) => {
			if (path === "/v1/settle" && failSettle) return { status: 500, json: { error: "internal" } };
			return okResponder(path, body);
		});
		await writeMain(
			responseEntries("msg_a", "claude-sonnet-4-6", {
				input: 3,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
			}),
		);
		await run("stop.mjs", stopInput());
		// The failed attempt's hold was voided, not left dangling.
		expect(requests.map((r) => r.path)).toEqual(["/v1/authorize", "/v1/settle", "/v1/abort"]);
		failSettle = false;
		await run("stop.mjs", stopInput());
		expect(settles().filter((s) => s.status === 200)).toHaveLength(1);
	});

	it("an AMBIGUOUS settle stays claimed — at most once, never twice", async () => {
		// Settle answered 500 AND the hold is already gone (abort 404): the
		// server cannot prove nothing was posted, so the ids are not retried.
		await startServer((path, body) => {
			if (path === "/v1/settle") return { status: 500, json: { error: "internal" } };
			if (path === "/v1/abort") return { status: 404, json: { error: "not_found" } };
			return okResponder(path, body);
		});
		await writeMain(
			responseEntries("msg_a", "claude-sonnet-4-6", {
				input: 3,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
			}),
		);
		await run("stop.mjs", stopInput());
		await run("stop.mjs", stopInput());
		expect(settles()).toHaveLength(1);
	});
});

describe("transcript usage — per-subagent attribution", () => {
	it("Stop splits the ledger into main and each subagent, tagged with id and type", async () => {
		await startServer(okResponder);
		await writeMain(
			responseEntries("msg_m", "claude-sonnet-4-6", {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
			}),
		);
		await writeSubagent(
			"a1",
			"Explore",
			responseEntries(
				"msg_s1",
				"claude-haiku-4-5",
				{ input: 2, output: 2, cacheRead: 0, cacheWrite: 0 },
				sub("a1"),
			),
		);
		await writeSubagent(
			"a2",
			"general-purpose",
			responseEntries(
				"msg_s2",
				"claude-sonnet-4-6",
				{ input: 3, output: 3, cacheRead: 0, cacheWrite: 0 },
				sub("a2"),
			),
		);
		await run("stop.mjs", stopInput());
		const tags = authorizes()
			.map((a) => `${(a.body.params as { agent_type: string }).agent_type}:${a.body.actor}`)
			.sort();
		expect(tags).toEqual([
			`Explore:claude-code:${SESSION}:Explore:a1`,
			`general-purpose:claude-code:${SESSION}:general-purpose:a2`,
			`main:claude-code:${SESSION}:main:main`,
		]);
	});

	it("SubagentStop settles ONLY the stopping subagent, and Stop does not repeat it", async () => {
		await startServer(okResponder);
		await writeMain(
			responseEntries("msg_m", "claude-sonnet-4-6", {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
			}),
		);
		await writeSubagent(
			"a1",
			null,
			responseEntries(
				"msg_s1",
				"claude-sonnet-4-6",
				{ input: 2, output: 2, cacheRead: 0, cacheWrite: 0 },
				sub("a1"),
			),
		);
		await writeSubagent(
			"a2",
			"Plan",
			responseEntries(
				"msg_s2",
				"claude-sonnet-4-6",
				{ input: 3, output: 3, cacheRead: 0, cacheWrite: 0 },
				sub("a2"),
			),
		);
		await run("subagent-stop.mjs", { ...stopInput(), agent_id: "a1", agent_type: "Explore" });
		expect(authorizes().map((a) => a.body.actor)).toEqual([`claude-code:${SESSION}:Explore:a1`]);
		await run("stop.mjs", stopInput());
		expect(
			settles()
				.map((s) => s.body.inputTokens)
				.sort(),
		).toEqual([1, 2, 3]);
	});
});

describe("estimate holds — reconciled, never dangling", () => {
	async function seedHold(agentId: string, toolUseId: string, transferId: string) {
		await writeFile(
			join(stateDir, `${SESSION}__${agentId}__${toolUseId}.json`),
			JSON.stringify({ toolUseId, transferId, agentId, estimatedInputTokens: 4 }),
		);
	}

	it("with a readable transcript, PostToolUse settles real usage and VOIDS the estimate hold", async () => {
		await startServer(okResponder);
		await writeMain(
			responseEntries("msg_a", "claude-sonnet-4-6", {
				input: 9,
				output: 9,
				cacheRead: 0,
				cacheWrite: 0,
			}),
		);
		await seedHold("main", "tu_1", "tx_hold");
		const result = await run("post-tool-use.mjs", {
			...stopInput(),
			tool_use_id: "tu_1",
			tool_response: "eight ch",
		});
		expect(result.code).toBe(0);
		expect(requests.map((r) => r.path)).toEqual(["/v1/authorize", "/v1/settle", "/v1/abort"]);
		expect(requests[2]?.body.transferId).toBe("tx_hold");
		// The estimate is never settled on top of the real usage.
		expect(settles().every((s) => s.body.usageSource === "provider")).toBe(true);
		expect((await readdir(stateDir)).filter((n) => n.endsWith(".json"))).toEqual([]);
	});

	it.each([
		["missing", async () => {}],
		["corrupt", async () => writeFile(mainTranscript, "{not json\n\u0000\u0001garbage\n")],
	])("a %s transcript falls back to the ESTIMATE, labelled as such", async (_label, prepare) => {
		await startServer(okResponder);
		await prepare();
		await seedHold("main", "tu_1", "tx_hold");
		const result = await run("post-tool-use.mjs", {
			...stopInput(),
			tool_use_id: "tu_1",
			tool_response: "eight ch",
		});
		expect(result.code).toBe(0);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.body).toMatchObject({
			transferId: "tx_hold",
			inputTokens: 4,
			outputTokens: 3,
			usageSource: "estimated",
		});
		expect(result.stderr).toContain("settling at the ESTIMATE");
	});

	it("Stop settles real usage FIRST, then aborts whatever hold is left", async () => {
		await startServer(okResponder);
		await writeMain(
			responseEntries("msg_a", "claude-sonnet-4-6", {
				input: 9,
				output: 9,
				cacheRead: 0,
				cacheWrite: 0,
			}),
		);
		await seedHold("main", "tu_left", "tx_left");
		await run("stop.mjs", stopInput());
		expect(requests.map((r) => r.path)).toEqual(["/v1/authorize", "/v1/settle", "/v1/abort"]);
		expect(requests[2]?.body.transferId).toBe("tx_left");
		expect((await readdir(stateDir)).filter((n) => n.endsWith(".json"))).toEqual([]);
	});

	it("UT_CC_USAGE=estimate keeps the old per-call estimate and never reads the transcript", async () => {
		await startServer(okResponder);
		await writeMain(
			responseEntries("msg_a", "claude-sonnet-4-6", {
				input: 9,
				output: 9,
				cacheRead: 0,
				cacheWrite: 0,
			}),
		);
		await seedHold("main", "tu_1", "tx_hold");
		await run(
			"post-tool-use.mjs",
			{ ...stopInput(), tool_use_id: "tu_1", tool_response: "x" },
			{ UT_CC_USAGE: "estimate" },
		);
		await run("stop.mjs", stopInput(), { UT_CC_USAGE: "estimate" });
		expect(requests.map((r) => r.path)).toEqual(["/v1/settle"]);
		expect(requests[0]?.body.usageSource).toBe("estimated");
	});

	it("a dead server never blocks or throws out of a settle point", async () => {
		port = 1; // nothing listens here
		await writeMain(
			responseEntries("msg_a", "claude-sonnet-4-6", {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
			}),
		);
		for (const hook of ["post-tool-use.mjs", "stop.mjs", "subagent-stop.mjs"]) {
			const result = await run(hook, { ...stopInput(), agent_id: "main", tool_use_id: "tu_1" });
			expect(result.code).toBe(0);
		}
	});
});

describe("against a REAL usertrust-server — cache tokens priced separately, never double-counted", () => {
	it("the receipt's four-tier usage is exactly the transcript's, and the cost reconciles", async () => {
		const KEY = "ut_plugin_transcript_key";
		real = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir: await mkdtemp(join(tmpdir(), "utcc-tx-srv-")),
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				dryRun: true,
				tenants: [{ id: "t", keyHash: hashKey(KEY), budget: 10_000_000 }],
			},
		});
		const { port: realPort } = await real.listen();
		await startServer({ forwardTo: `http://127.0.0.1:${realPort}`, key: KEY });
		await writeMain([
			...responseEntries("msg_a", "claude-sonnet-4-6", {
				input: 120,
				output: 800,
				cacheRead: 40_000,
				cacheWrite: 2_000,
			}),
			...responseEntries("msg_b", "claude-sonnet-4-6", {
				input: 30,
				output: 200,
				cacheRead: 42_000,
				cacheWrite: 0,
			}),
		]);
		await run("stop.mjs", stopInput());
		const settle = settles()[0];
		expect(settle?.status).toBe(200);
		const receipt = settle?.response as {
			cost: number;
			postedCost?: number;
			usageSource: string;
			usage: Record<string, number>;
			pricing: { appliedRates: Record<string, number> };
		};
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.usage).toMatchObject({
			inputTokens: 150,
			outputTokens: 1000,
			cacheReadTokens: 82_000,
			cacheWriteTokens: 2_000,
		});
		const r = receipt.pricing.appliedRates as {
			inputPer1k: number;
			outputPer1k: number;
			cacheReadPer1k: number;
			cacheWritePer1k: number;
		};
		// Each tier at its own rate. Folding cache into input (the double count)
		// would price 84,150 input tokens at inputPer1k instead.
		const expected = Math.max(
			1,
			Math.ceil(
				(150 * r.inputPer1k +
					1000 * r.outputPer1k +
					82_000 * r.cacheReadPer1k +
					2_000 * r.cacheWritePer1k) /
					1000,
			),
		);
		expect(receipt.cost).toBe(expected);
		expect(r.cacheReadPer1k).toBeLessThan(r.inputPer1k);
		// The hold was large enough: the full cost was posted, no shortfall cap.
		expect(receipt.postedCost ?? receipt.cost).toBe(receipt.cost);
	});
});
