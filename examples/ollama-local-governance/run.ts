// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * ollama-local-governance — before/after demo of first-class local-model
 * governance (M2).
 *
 * BEFORE (v1.3 behavior, reproduced with `local.autoDetectLoopback: false`):
 * a free local stream settles on the pre-call ESTIMATE at frontier FALLBACK
 * rates — fake dollars billed for $0 inference.
 *
 * AFTER (M2 default config): the loopback endpoint classifies as LOCAL scope
 * and every call settles at exactly 1 nominal usertoken from server-truth
 * token counts (`stream_options: { include_usage: true }` is auto-injected).
 * Free inference stays INSIDE budget/anomaly/audit governance.
 *
 * Run from a repo checkout (imports the workspace source directly):
 *
 *   npm install
 *   cd examples/ollama-local-governance
 *   npx tsx run.ts
 *
 * Works with or without a running Ollama: probes http://localhost:11434 and
 * falls back to an inline mock OpenAI-compatible server (below).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { type TrustReceipt, trust } from "../../packages/core/src/index.js";

const BUDGET = 500_000; // $50 in usertokens (1 ut = $0.0001)
const MOCK_MODEL = "llama3.3:70b";
const MOCK_USAGE = { prompt_tokens: 42, completion_tokens: 128 };

// ── Inline mock OpenAI-compatible server (the shapes Ollama serves on /v1) ──

function startMockServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: MOCK_MODEL }] }));
				return;
			}
			const params = JSON.parse(body || "{}") as {
				model?: string;
				stream?: boolean;
				stream_options?: { include_usage?: boolean };
			};
			const base = { id: "chatcmpl-mock", model: params.model ?? MOCK_MODEL, created: 0 };
			if (params.stream === true) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				const sse = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
				for (const text of ["Free ", "inference, ", "fully ", "governed."]) {
					const choices = [{ index: 0, delta: { content: text }, finish_reason: null }];
					sse({ ...base, object: "chat.completion.chunk", choices });
				}
				// Like Ollama/vLLM: the final usage chunk is emitted ONLY when the
				// request opted in via stream_options.include_usage.
				if (params.stream_options?.include_usage === true) {
					sse({ ...base, object: "chat.completion.chunk", choices: [], usage: MOCK_USAGE });
				}
				res.end("data: [DONE]\n\n");
				return;
			}
			const message = { role: "assistant", content: "Free inference, fully governed." };
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					...base,
					object: "chat.completion",
					choices: [{ index: 0, message, finish_reason: "stop" }],
					usage: MOCK_USAGE,
				}),
			);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			resolve({
				url: `http://127.0.0.1:${port}/v1`,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

// ── Endpoint resolution: live Ollama (500ms probe) or the inline mock ──

interface DemoEndpoint {
	url: string;
	model: string;
	live: boolean;
	close: () => Promise<void>;
}

async function resolveEndpoint(): Promise<DemoEndpoint> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 500);
	try {
		const res = await fetch("http://localhost:11434/api/tags", { signal: controller.signal });
		if (res.ok) {
			const body = (await res.json()) as { models?: Array<{ name?: unknown }> };
			const model = body.models
				?.map((m) => m.name)
				.find((name): name is string => typeof name === "string");
			if (model !== undefined) {
				return { url: "http://localhost:11434/v1", model, live: true, close: async () => {} };
			}
		}
	} catch {
		// Not running — fall through to the mock.
	} finally {
		clearTimeout(timer);
	}
	const mock = await startMockServer();
	return { url: mock.url, model: MOCK_MODEL, live: false, close: mock.close };
}

// ── Demo plumbing ──

/** Write a throwaway .usertrust vault holding the given config. */
function makeVault(config: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "ollama-local-governance-"));
	mkdirSync(join(dir, ".usertrust"), { recursive: true });
	const configPath = join(dir, ".usertrust", "usertrust.config.json");
	writeFileSync(configPath, JSON.stringify(config, null, "\t"));
	return dir;
}

function printReceipt(label: string, r: TrustReceipt): void {
	const endpoint = r.endpoint ? `${r.endpoint.class}/${r.endpoint.runtime}` : "(none)";
	const meter = r.meter ? `${r.meter.costBasis} via ${r.meter.rateSource}` : "(none)";
	console.log(`  ${label}`);
	console.log(`    cost=${r.cost} ut  endpoint=${endpoint}  meter=${meter}`);
	console.log(`    usageSource=${r.usageSource ?? "n/a"}  budgetRemaining=${r.budgetRemaining}`);
}

interface Usage {
	prompt_tokens?: number;
	completion_tokens?: number;
}
interface StreamChunk {
	choices?: Array<{ delta?: { content?: string } }>;
	usage?: Usage | null;
}
/** Runtime shape of a governed streaming call (SDK types report the raw stream). */
interface GovernedStreamResult {
	response: AsyncIterable<StreamChunk> & { receipt: Promise<TrustReceipt> };
	receipt: TrustReceipt;
}
/** Runtime shape of a governed non-stream call. */
interface GovernedCallResult {
	response: { usage?: Usage };
	receipt: TrustReceipt;
}

function usageTokens(usage: Usage | null | undefined): number {
	return (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
}

// ── Demo ──

async function main(): Promise<void> {
	console.log("── ollama-local-governance ──\n");
	const endpoint = await resolveEndpoint();
	console.log(
		endpoint.live
			? `Live Ollama at http://localhost:11434 — model "${endpoint.model}"`
			: `No Ollama at http://localhost:11434 — inline mock OpenAI-compat server at ${endpoint.url}`,
	);

	const messages = [{ role: "user" as const, content: "Why govern free local inference?" }];

	// ── BEFORE: v1.3 behavior — loopback NOT classified, silent fallback pricing ──
	console.log("\n[BEFORE — v1.3 behavior: local.autoDetectLoopback: false]");
	const beforeVault = makeVault({
		budget: BUDGET,
		local: { autoDetectLoopback: false },
		unknownModelPolicy: "fallback", // reproduce the old SILENT frontier fallback
	});
	const beforeClient = await trust(new OpenAI({ baseURL: endpoint.url, apiKey: "local" }), {
		dryRun: true,
		vaultBase: beforeVault,
	});
	const beforeCall = (await beforeClient.chat.completions.create({
		model: endpoint.model,
		stream: true,
		messages,
	})) as unknown as GovernedStreamResult;
	let beforeChunks = 0;
	for await (const chunk of beforeCall.response) {
		// Consume the stream. No include_usage injection on a "cloud" endpoint,
		// so settlement falls back to the pre-call estimate at FALLBACK_RATE.
		if (chunk != null) beforeChunks++;
	}
	const beforeReceipt = await beforeCall.response.receipt;
	printReceipt(`streamed "${endpoint.model}" (${beforeChunks} chunks):`, beforeReceipt);
	const perCallDollars = (beforeReceipt.cost / 10_000).toFixed(4);
	const callsToExhaust = Math.floor(BUDGET / beforeReceipt.cost);
	console.log(`    → $0 inference billed ${beforeReceipt.cost} ut ($${perCallDollars}/call)`);
	console.log(`    → a $50 budget is exhausted after ~${callsToExhaust} FREE streams`);
	await beforeClient.destroy();

	// ── AFTER: M2 default config — loopback classifies local, nominal metering ──
	console.log("\n[AFTER — M2 default config]");
	const afterVault = makeVault({ budget: BUDGET });
	const afterClient = await trust(new OpenAI({ baseURL: endpoint.url, apiKey: "local" }), {
		dryRun: true,
		vaultBase: afterVault,
	});

	let calls = 0;
	let realTokens = 0;

	// (1) Non-stream: provider-reported usage, settles at 1 nominal usertoken.
	const call1 = (await afterClient.chat.completions.create({
		model: endpoint.model,
		messages,
	})) as unknown as GovernedCallResult;
	calls++;
	realTokens += usageTokens(call1.response.usage);
	printReceipt(`non-stream "${endpoint.model}":`, call1.receipt);

	// (2) Streamed: stream_options.include_usage auto-injected → server-truth usage.
	const call2 = (await afterClient.chat.completions.create({
		model: endpoint.model,
		stream: true,
		messages,
	})) as unknown as GovernedStreamResult;
	let finalUsage: Usage | null | undefined;
	for await (const chunk of call2.response) {
		if (chunk?.usage != null) finalUsage = chunk.usage; // forwarded unmodified
	}
	const call2Receipt = await call2.response.receipt;
	calls++;
	realTokens += usageTokens(finalUsage);
	printReceipt(`streamed "${endpoint.model}" (include_usage injected):`, call2Receipt);
	let lastReceipt = call2Receipt;

	// (3) Spoof defense: the ENDPOINT class picks the regime, not the model
	// string ("ollama cp llama3.2 gpt-4o" cannot buy frontier billing).
	// Mock-only: a live Ollama would 404 a model it doesn't have installed.
	if (!endpoint.live) {
		const call3 = (await afterClient.chat.completions.create({
			model: "gpt-4o",
			messages,
		})) as unknown as GovernedCallResult;
		calls++;
		realTokens += usageTokens(call3.response.usage);
		printReceipt('spoofed model "gpt-4o" on the local endpoint:', call3.receipt);
		lastReceipt = call3.receipt;
	}

	const spent = BUDGET - lastReceipt.budgetRemaining;
	console.log(
		`\nShowback: ${calls} calls, ${realTokens} real tokens metered, ` +
			`${spent} ut nominal spend, $0.00 actual.`,
	);
	console.log("Free inference, fully governed.");

	await afterClient.destroy();
	await endpoint.close();
	for (const dir of [beforeVault, afterVault]) {
		rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
