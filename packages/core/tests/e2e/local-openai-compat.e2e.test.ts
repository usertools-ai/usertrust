// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * local-openai-compat.e2e.test.ts — M2 end-to-end: trust() wrapping an
 * OpenAI-SDK-shaped client pointed at a real (in-process) OpenAI-compatible
 * HTTP server, exercising the full governed path over the wire: loopback
 * classification → nominal metering → include_usage injection → server-truth
 * settlement → budget math, plus the BEFORE-behavior regression guard that
 * documents the pre-M2 frontier-fallback bug as the contrast case.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Zero-dep verify package, imported by relative path across the workspace
// (same pattern as tests/harden/differential.test.ts). Source is READ, never modified.
import { verifyVault } from "../../../verify/src/index.js";
import { trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { TrustReceipt } from "../../src/shared/types.js";
import {
	type MockOpenAIServer,
	startMockOpenAIServer,
} from "../fixtures/mock-openai-compat-server.js";

// Mock tigerbeetle-node (native module, never loaded in tests)
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: {
		linked: 1,
		pending: 2,
		post_pending_transfer: 4,
		void_pending_transfer: 8,
	},
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// ── Helpers ──

function makeTmpVault(): string {
	const dir = join(tmpdir(), `local-e2e-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeVaultConfig(vaultBase: string, config: Record<string, unknown>): void {
	const configDir = join(vaultBase, VAULT_DIR);
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "usertrust.config.json"), JSON.stringify(config));
}

/** Minimal SSE reader for the mock server's text/event-stream responses. */
async function* sseStream(res: Response): AsyncGenerator<unknown> {
	const body = res.body;
	if (body == null) return;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep = buffer.indexOf("\n\n");
			while (sep !== -1) {
				const event = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				sep = buffer.indexOf("\n\n");
				const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
				if (dataLine === undefined) continue;
				const payload = dataLine.slice(6);
				if (payload === "[DONE]") return;
				yield JSON.parse(payload) as unknown;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * An OpenAI-SDK-shaped client that actually speaks HTTP to the mock server —
 * exposes `baseURL` (like the real OpenAI SDK) so classifyEndpoint can read it.
 */
function makeOpenAICompatClient(baseURL: string) {
	return {
		baseURL,
		chat: {
			completions: {
				create: async (params: Record<string, unknown>): Promise<unknown> => {
					const res = await fetch(`${baseURL}/chat/completions`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(params),
					});
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					if (params.stream === true) return sseStream(res);
					return (await res.json()) as unknown;
				},
			},
		},
	};
}

interface CallResult {
	response: unknown;
	receipt: TrustReceipt;
}

async function call(governed: unknown, params: Record<string, unknown>): Promise<CallResult> {
	const g = governed as {
		chat: { completions: { create: (p: Record<string, unknown>) => Promise<CallResult> } };
	};
	return g.chat.completions.create(params);
}

async function destroy(governed: unknown): Promise<void> {
	await (governed as { destroy(): Promise<void> }).destroy();
}

// ── Tests ──

describe("local OpenAI-compat endpoint — e2e over HTTP (M2)", () => {
	let server: MockOpenAIServer;
	let tmpVault: string;

	beforeEach(async () => {
		server = await startMockOpenAIServer({ promptTokens: 100, completionTokens: 50 });
		tmpVault = makeTmpVault();
	});

	afterEach(async () => {
		await server.close();
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
		vi.restoreAllMocks();
	});

	it("(a) non-stream call settles at exactly 1 nominal usertoken from provider usage", async () => {
		const client = makeOpenAICompatClient(`${server.url}/v1`);
		const governed = await trust(client, { dryRun: true, budget: 200, vaultBase: tmpVault });

		const result = await call(governed, {
			model: "llama3.3:70b",
			messages: [{ role: "user", content: "Explain governance briefly" }],
		});

		expect(result.receipt.cost).toBe(1);
		expect(result.receipt.usageSource).toBe("provider");
		expect(result.receipt.endpoint).toEqual({ class: "local", runtime: "openai-compat" });
		// A6: computeMs is omitted, not undefined — toEqual pins the exact key set.
		expect(result.receipt.meter).toMatchObject({
			costBasis: "nominal",
			rateSource: "local-default",
		});
		expect(result.receipt.settled).toBe(true);
		expect(result.receipt.budgetRemaining).toBe(199);

		await destroy(governed);
	});

	it("(b) streamed call: include_usage injected over the wire, settles from server-truth usage", async () => {
		writeVaultConfig(tmpVault, {
			budget: 200,
			local: { models: { "llama3.3*": { inputPer1k: 10, outputPer1k: 20 } } },
		});
		const client = makeOpenAICompatClient(`${server.url}/v1`);
		const governed = await trust(client, { dryRun: true, vaultBase: tmpVault });

		const result = await call(governed, {
			model: "llama3.3:70b",
			stream: true,
			messages: [{ role: "user", content: "stream please" }],
		});

		const collected: unknown[] = [];
		for await (const chunk of result.response as AsyncIterable<unknown>) {
			collected.push(chunk);
		}
		const receipt = await (result.response as { receipt: Promise<TrustReceipt> }).receipt;

		// The governed layer injected the opt-in the caller never wrote…
		expect(server.lastRequest()?.stream_options).toEqual({ include_usage: true });
		// …and the resulting usage tail chunk was forwarded to the consumer unmodified.
		expect(collected).toHaveLength(4);
		const tail = collected[3] as { usage?: { prompt_tokens: number; completion_tokens: number } };
		expect(tail.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 50 });

		// Server-truth settlement: (100/1000)*10 + (50/1000)*20 = 2.
		expect(receipt.cost).toBe(2);
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.meter).toMatchObject({ costBasis: "nominal", rateSource: "local-model" });
		expect(receipt.endpoint).toEqual({ class: "local", runtime: "openai-compat" });

		await destroy(governed);
	});

	it("(b2) streamed call on default {0,0} local rates settles at 1 nominal usertoken", async () => {
		const client = makeOpenAICompatClient(`${server.url}/v1`);
		const governed = await trust(client, { dryRun: true, budget: 200, vaultBase: tmpVault });

		const result = await call(governed, {
			model: "llama3.3:70b",
			stream: true,
			messages: [{ role: "user", content: "stream please" }],
		});
		for await (const _ of result.response as AsyncIterable<unknown>) {
			// consume
		}
		const receipt = await (result.response as { receipt: Promise<TrustReceipt> }).receipt;

		expect(receipt.cost).toBe(1);
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.meter).toMatchObject({ costBasis: "nominal", rateSource: "local-default" });

		await destroy(governed);
	});

	it("(c) budget is decremented by exactly 1 per call", async () => {
		const client = makeOpenAICompatClient(`${server.url}/v1`);
		const governed = await trust(client, { dryRun: true, budget: 200, vaultBase: tmpVault });

		const params = {
			model: "llama3.3:70b",
			messages: [{ role: "user", content: "count me" }],
		};
		const r1 = await call(governed, params);
		const r2 = await call(governed, params);
		const r3 = await call(governed, params);

		expect(r1.receipt.cost).toBe(1);
		expect(r2.receipt.cost).toBe(1);
		expect(r3.receipt.cost).toBe(1);
		expect(r1.receipt.budgetRemaining).toBe(199);
		expect(r2.receipt.budgetRemaining).toBe(198);
		expect(r3.receipt.budgetRemaining).toBe(197);

		await destroy(governed);
	});

	it("(d) BEFORE-behavior guard: autoDetectLoopback:false meters the same call at FALLBACK_RATE", async () => {
		// This is the pre-M2 bug as a contrast case: with loopback autodetect off,
		// the endpoint classifies as cloud, "llama3.3:70b" misses the pricing
		// table, and free inference is billed at sonnet-class FALLBACK_RATE.
		// Budget is 5000 (not 200) because the fallback-rate PENDING hold alone
		// (~617 ut for a $0 call) would overshoot a 200-ut budget — that
		// over-reservation is itself part of the documented old bug.
		writeVaultConfig(tmpVault, { budget: 5000, local: { autoDetectLoopback: false } });
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const client = makeOpenAICompatClient(`${server.url}/v1`);
		const governed = await trust(client, { dryRun: true, vaultBase: tmpVault });

		const result = await call(governed, {
			model: "llama3.3:70b",
			messages: [{ role: "user", content: "Explain governance briefly" }],
		});

		expect(result.receipt.endpoint).toEqual({ class: "cloud", runtime: "unknown" });
		expect(result.receipt.meter).toMatchObject({ costBasis: "usd-proxy", rateSource: "fallback" });
		// FALLBACK_RATE {30, 150}: (100/1000)*30 + (50/1000)*150 = 3 + 7.5 → ceil = 11.
		expect(result.receipt.cost).toBe(11);
		// Default unknownModelPolicy "warn" surfaces the fallback footgun.
		expect(
			warnSpy.mock.calls.filter((c) => String(c[0]).includes("llama3.3:70b")).length,
		).toBeGreaterThanOrEqual(1);

		await destroy(governed);
	});

	it("(e) A6 verify-parity smoke: dryRun audit chain with local nominal receipts passes usertrust-verify", async () => {
		const client = makeOpenAICompatClient(`${server.url}/v1`);
		const governed = await trust(client, { dryRun: true, budget: 200, vaultBase: tmpVault });

		// One non-stream + one streamed local call so the chain contains llm_call
		// events carrying the M2 metering provenance (endpoint/meter receipts).
		const nonStream = await call(governed, {
			model: "llama3.3:70b",
			messages: [{ role: "user", content: "audit me" }],
		});
		expect(nonStream.receipt.meter).toMatchObject({
			costBasis: "nominal",
			rateSource: "local-default",
		});

		const streamed = await call(governed, {
			model: "llama3.3:70b",
			stream: true,
			messages: [{ role: "user", content: "audit the stream too" }],
		});
		for await (const _ of streamed.response as AsyncIterable<unknown>) {
			// consume
		}
		await (streamed.response as { receipt: Promise<TrustReceipt> }).receipt;
		await destroy(governed);

		// The chain actually contains local-nominal llm_call events (not a vacuous pass)…
		const eventsRaw = readFileSync(join(tmpVault, VAULT_DIR, "audit", "events.jsonl"), "utf8");
		const events = eventsRaw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; data?: Record<string, unknown> });
		const localCalls = events.filter(
			(e) =>
				e.kind === "llm_call" &&
				e.data?.endpointClass === "local" &&
				e.data?.costBasis === "nominal" &&
				e.data?.rateSource === "local-default",
		);
		expect(localCalls.length).toBeGreaterThanOrEqual(2);

		// …and the standalone verifier (packages/verify, untouched by M2) accepts it.
		const result = verifyVault(join(tmpVault, VAULT_DIR));
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBeGreaterThanOrEqual(events.length);
		expect(result.validHashes).toBe(result.chainLength);
		expect(result.merkleRoot).not.toBeNull();
	});
});
