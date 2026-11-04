// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * cloud-usage-injection.test.ts: a streamed chat completion to api.openai.com settles at what
 * the provider reports, not at the estimate.
 *
 * OpenAI sends a stream's usage only when the request asks for it (`stream_options.include_usage`).
 * Without it a governed cloud stream carries no usage and the call is charged the estimate. The
 * request is changed only for the one host that is known to accept the field, and the stream the
 * caller sees is never changed when the caller did not ask for usage.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { TrustReceipt } from "../../src/shared/types.js";

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

const OPENAI_BASE_URL = "https://api.openai.com/v1";

const CONTENT_CHUNKS = [
	{ choices: [{ delta: { content: "Hello" } }] },
	{ choices: [{ delta: { content: " world" } }] },
];

const USAGE_CHUNK = { choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } };

// gpt-4o: 25 in / 100 out per 1k. 100 in + 50 out settles at 8; max_tokens 4000 holds far more.
const REAL_COST = 8;

function makeTmpVault(): string {
	const dir = join(tmpdir(), `cloud-usage-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeVaultConfig(vaultBase: string, config: Record<string, unknown>): void {
	const configDir = join(vaultBase, VAULT_DIR);
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "usertrust.config.json"), JSON.stringify(config));
}

/**
 * OpenAI-SDK-shaped mock that answers like the real service. `usage: "when-asked"` sends the
 * final usage chunk only if the request set `stream_options.include_usage: true`; "never" is a
 * server that sends none.
 */
function makeStreamClient(
	usage: "when-asked" | "never",
	opts?: { baseURL?: string | null; failWith?: Error },
) {
	const createFn = vi.fn(async (params: Record<string, unknown>) => {
		if (opts?.failWith !== undefined) throw opts.failWith;
		const asked = (params.stream_options as { include_usage?: unknown } | undefined)?.include_usage;
		async function* gen(): AsyncGenerator<unknown> {
			for (const c of CONTENT_CHUNKS) yield c;
			if (usage === "when-asked" && asked === true) yield USAGE_CHUNK;
		}
		return gen();
	});
	const client: Record<string, unknown> = {
		chat: { completions: { create: createFn } },
	};
	if (opts?.baseURL !== null) client.baseURL = opts?.baseURL ?? OPENAI_BASE_URL;
	return { client, createFn };
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

async function consume(result: CallResult): Promise<{ chunks: unknown[]; receipt: TrustReceipt }> {
	const chunks: unknown[] = [];
	for await (const chunk of result.response as AsyncIterable<unknown>) chunks.push(chunk);
	const receipt = await (result.response as { receipt: Promise<TrustReceipt> }).receipt;
	return { chunks, receipt };
}

async function destroy(governed: unknown): Promise<void> {
	await (governed as { destroy(): Promise<void> }).destroy();
}

const baseParams = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	model: "gpt-4o",
	stream: true,
	max_tokens: 4000,
	messages: [{ role: "user", content: "hi" }],
	...extra,
});

describe("cloud OpenAI chat streams ask for usage", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault();
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
		vi.restoreAllMocks();
	});

	async function run(
		client: Record<string, unknown>,
		params: Record<string, unknown>,
		config?: Record<string, unknown>,
	) {
		if (config !== undefined) writeVaultConfig(tmpVault, config);
		const governed = await trust(client, { dryRun: true, budget: 100_000, vaultBase: tmpVault });
		const result = await call(governed, params);
		const out = await consume(result);
		await destroy(governed);
		return out;
	}

	function forwardedOptions(createFn: ReturnType<typeof makeStreamClient>["createFn"]) {
		return (createFn.mock.calls[0]?.[0] as Record<string, unknown>).stream_options;
	}

	describe("api.openai.com", () => {
		it("sends include_usage and does not touch the caller's params object", async () => {
			const { client, createFn } = makeStreamClient("when-asked");
			const params = baseParams();
			await run(client, params);
			expect(forwardedOptions(createFn)).toEqual({ include_usage: true });
			expect("stream_options" in params).toBe(false);
		});

		it("settles at the provider's usage, not the estimate", async () => {
			const { client } = makeStreamClient("when-asked");
			const { receipt } = await run(client, baseParams());
			expect(receipt.usageSource).toBe("provider");
			expect(receipt.cost).toBe(REAL_COST);
		});

		it("merges with the caller's other stream_options fields", async () => {
			const { client, createFn } = makeStreamClient("when-asked");
			await run(client, baseParams({ stream_options: { chunk_size: 8 } }));
			expect(forwardedOptions(createFn)).toEqual({ chunk_size: 8, include_usage: true });
		});

		it("never overrides an explicit include_usage: false, and settles at the estimate", async () => {
			const { client, createFn } = makeStreamClient("never");
			const { receipt } = await run(
				client,
				baseParams({ stream_options: { include_usage: false } }),
			);
			expect(forwardedOptions(createFn)).toEqual({ include_usage: false });
			expect(receipt.usageSource).toBe("estimated");
			expect(receipt.cost).toBeGreaterThan(REAL_COST);
		});

		it("leaves an explicit include_usage: true untouched", async () => {
			const { client, createFn } = makeStreamClient("when-asked");
			await run(client, baseParams({ stream_options: { include_usage: true } }));
			expect(forwardedOptions(createFn)).toEqual({ include_usage: true });
		});

		it("leaves a stream_options value that is not an object as the caller wrote it", async () => {
			const { client, createFn } = makeStreamClient("never");
			await run(client, baseParams({ stream_options: "include_usage" }));
			expect(forwardedOptions(createFn)).toBe("include_usage");
		});

		it("settles at the estimate, labelled so, when the server sends no usage", async () => {
			const { client } = makeStreamClient("never");
			const { receipt } = await run(client, baseParams());
			expect(receipt.usageSource).toBe("estimated");
			expect(receipt.cost).toBeGreaterThan(REAL_COST);
		});

		it("does not inject on a non-stream call", async () => {
			const { client, createFn } = makeStreamClient("never");
			const governed = await trust(client, { dryRun: true, budget: 100_000, vaultBase: tmpVault });
			createFn.mockResolvedValueOnce({
				choices: [{ message: { content: "ok" } }],
				usage: { prompt_tokens: 100, completion_tokens: 50 },
			} as never);
			await call(governed, baseParams({ stream: false }));
			expect("stream_options" in (createFn.mock.calls[0]?.[0] as object)).toBe(false);
			await destroy(governed);
		});

		it("does not inject when cloud.injectUsageOptions is false", async () => {
			const { client, createFn } = makeStreamClient("never");
			await run(client, baseParams(), { cloud: { injectUsageOptions: false } });
			expect("stream_options" in (createFn.mock.calls[0]?.[0] as object)).toBe(false);
		});

		it("a provider error makes exactly one call and rethrows the original error", async () => {
			const failure = Object.assign(new Error("400 invalid model"), { status: 400 });
			const { client, createFn } = makeStreamClient("never", { failWith: failure });
			const governed = await trust(client, { dryRun: true, budget: 100_000, vaultBase: tmpVault });
			await expect(call(governed, baseParams())).rejects.toBe(failure);
			expect(createFn).toHaveBeenCalledTimes(1);
			await destroy(governed);
		});
	});

	describe("the stream the caller sees", () => {
		it("does not contain the usage chunk when the caller did not ask for usage", async () => {
			const { client } = makeStreamClient("when-asked");
			const { chunks } = await run(client, baseParams());
			expect(chunks).toHaveLength(2);
		});

		it("a consumer that reads chunk.choices[0] on every chunk does not throw", async () => {
			const { client } = makeStreamClient("when-asked");
			const governed = await trust(client, { dryRun: true, budget: 100_000, vaultBase: tmpVault });
			const result = await call(governed, baseParams());
			let text = "";
			for await (const chunk of result.response as AsyncIterable<{
				choices: { delta: { content: string } }[];
			}>) {
				text += (chunk.choices[0] as { delta: { content: string } }).delta.content;
			}
			expect(text).toBe("Hello world");
			await destroy(governed);
		});

		it("still contains the usage chunk when the caller asked for usage", async () => {
			const { client } = makeStreamClient("when-asked");
			const { chunks } = await run(
				client,
				baseParams({ stream_options: { include_usage: true } }),
			);
			expect(chunks).toHaveLength(3);
		});
	});

	describe("the Responses API", () => {
		it("on api.openai.com is sent without stream_options (that field is chat completions only)", async () => {
			const calls: Record<string, unknown>[] = [];
			const responsesCreate = vi.fn(async (params: Record<string, unknown>) => {
				calls.push(params);
				async function* gen(): AsyncGenerator<unknown> {
					yield { type: "response.output_text.delta", delta: "Hi" };
					yield {
						type: "response.completed",
						response: { id: "r1", usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
					};
				}
				return gen();
			});
			const client = {
				baseURL: OPENAI_BASE_URL,
				chat: { completions: { create: vi.fn(async () => ({})) } },
				responses: { create: responsesCreate },
			};
			const governed = await trust(client, { dryRun: true, budget: 100_000, vaultBase: tmpVault });
			const g = governed as {
				responses: { create: (p: Record<string, unknown>) => Promise<CallResult> };
			};
			const result = await g.responses.create({ model: "gpt-4o", input: "hi", stream: true });
			await consume(result);
			expect(calls).toHaveLength(1);
			expect("stream_options" in (calls[0] as object)).toBe(false);
			await destroy(governed);
		});
	});

	describe("every other destination is left alone", () => {
		const others: [string, string | null][] = [
			["OpenRouter", "https://openrouter.ai/api/v1"],
			["Together", "https://api.together.xyz/v1"],
			["a host that only starts with the name", "https://api.openai.com.evil.test/v1"],
			["a host that only ends with the name", "https://evilapi.openai.com.test/v1"],
			["a userinfo trick", "https://api.openai.com@evil.test/v1"],
			["a subdomain", "https://eu.api.openai.com/v1"],
			["a plain http address", "http://api.openai.com/v1"],
			["Azure OpenAI", "https://example.openai.azure.com/openai/v1"],
			["a client with no readable baseURL", null],
		];
		for (const [name, baseURL] of others) {
			it(`${name}: sends the request as the caller wrote it`, async () => {
				const { client, createFn } = makeStreamClient("never", { baseURL });
				await run(client, baseParams());
				expect("stream_options" in (createFn.mock.calls[0]?.[0] as object)).toBe(false);
			});
		}
	});
});
