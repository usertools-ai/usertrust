// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Google `models.generateContentStream` is governed, and the Google generation
 * methods usertrust does not govern are refused by name.
 *
 * Before: buildGoogleProxy trapped `generateContent` alone and let everything else
 * through `Reflect.get`, so a streaming Gemini call reached the SDK with no hold, no
 * policy, no receipt and no audit event. Now `generateContentStream` takes the same
 * interceptCall path as every other provider's stream (createGovernedStream reads
 * `usageMetadata` per chunk, replace-with-latest), and resolves to the governed
 * stream itself with a `.receipt` promise, like Anthropic's `messages.stream`.
 *
 * Ledger outcomes are asserted by COUNT (one hold; then exactly one post XOR one
 * void), the same discipline as the OpenAI Responses stream suite.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { GOOGLE_REFUSED_METHODS, type TrustEngine, trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { InsufficientBalanceError, PolicyDeniedError } from "../../src/shared/errors.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// ── Helpers ──

function makeTmpVault(): string {
	const dir = join(tmpdir(), `google-stream-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeVaultConfig(vaultBase: string, config: Record<string, unknown>): void {
	const configDir = join(vaultBase, VAULT_DIR);
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "usertrust.config.json"), JSON.stringify(config));
}

function makeMockEngine(): TrustEngine {
	return {
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => ({
			transferId: p.transferId,
		})),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

function makeMockAudit(): AuditWriter & { events: AppendEventInput[] } {
	const events: AppendEventInput[] = [];
	return {
		events,
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			events.push(input);
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		}),
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

/** A `GenerateContentResponse` chunk, real `@google/genai` shape (usage at the ROOT). */
function chunk(text: string, usageMetadata?: Record<string, number>): Record<string, unknown> {
	return {
		candidates: [{ content: { role: "model", parts: [{ text }] } }],
		modelVersion: "gemini-2.5-flash",
		...(usageMetadata !== undefined ? { usageMetadata } : {}),
	};
}

// gemini-2.5-flash: input 3 / output 25 usertokens per 1k. Gemini stamps a RUNNING
// usageMetadata on every chunk; the last one is the total. Replace-with-latest
// settles at 10_000 in + 2_000 out = 30 + 50 = 80. Summing the snapshots would
// charge 3 x the prompt (and 3_500 out), so the settle amount pins "no double count".
const STREAM_WITH_USAGE = [
	chunk("Hel", { promptTokenCount: 10_000, candidatesTokenCount: 500, totalTokenCount: 10_500 }),
	chunk("lo ", { promptTokenCount: 10_000, candidatesTokenCount: 1_000, totalTokenCount: 11_000 }),
	chunk("world", {
		promptTokenCount: 10_000,
		candidatesTokenCount: 2_000,
		totalTokenCount: 12_000,
	}),
];
const SETTLED_AT_REPORTED_USAGE = 80;

const STREAM_NO_USAGE = [chunk("Hello"), chunk(" world")];

const PARAMS = { model: "gemini-2.5-flash", contents: "Say hello" };

interface FakeGoogleOpts {
	chunks?: Record<string, unknown>[];
	/** Throw mid-stream once this many chunks have been yielded. */
	throwAfter?: number;
}

/**
 * A `@google/genai`-shaped fake: `generateContentStream` resolves to an
 * AsyncGenerator (the SDK's `Promise<AsyncGenerator<GenerateContentResponse>>`), and
 * every other namespace method is a spy so a refusal can prove the SDK was never hit.
 */
function makeGoogleClient(opts: FakeGoogleOpts = {}) {
	const chunks = opts.chunks ?? STREAM_WITH_USAGE;
	const generateContentStream = vi.fn(async (_params: Record<string, unknown>) => {
		async function* gen(): AsyncGenerator<Record<string, unknown>> {
			let i = 0;
			for (const c of chunks) {
				if (opts.throwAfter !== undefined && i >= opts.throwAfter) {
					throw new Error("gemini stream interrupted");
				}
				yield c;
				i++;
			}
		}
		return gen();
	});
	const spies = {
		models: {
			embedContent: vi.fn(async () => ({})),
			generateImages: vi.fn(async () => ({})),
			editImage: vi.fn(async () => ({})),
			upscaleImage: vi.fn(async () => ({})),
			generateVideos: vi.fn(async () => ({})),
			recontextImage: vi.fn(async () => ({})),
			segmentImage: vi.fn(async () => ({})),
		},
		chats: { create: vi.fn(() => ({ sendMessage: vi.fn() })) },
		live: { connect: vi.fn(async () => ({})) },
		"live.music": { connect: vi.fn(async () => ({})) },
		batches: { create: vi.fn(async () => ({})), createEmbeddings: vi.fn(async () => ({})) },
		interactions: { create: vi.fn(async () => ({})) },
	};
	const passThrough = {
		countTokens: vi.fn(async () => ({ totalTokens: 7 })),
		list: vi.fn(async () => []),
		batchesList: vi.fn(async () => []),
		interactionsGet: vi.fn(async () => ({ id: "i_1" })),
		cachesCreate: vi.fn(async () => ({ name: "cachedContents/1" })),
	};
	const client = {
		models: {
			generateContent: vi.fn(async (_params: Record<string, unknown>) =>
				chunk("Hello", { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }),
			),
			generateContentStream,
			countTokens: passThrough.countTokens,
			list: passThrough.list,
			...spies.models,
		},
		chats: { ...spies.chats },
		live: { ...spies.live, music: { ...spies["live.music"] } },
		batches: { ...spies.batches, list: passThrough.batchesList },
		interactions: { ...spies.interactions, get: passThrough.interactionsGet },
		caches: { create: passThrough.cachesCreate },
	};
	return { client, generateContentStream, spies, passThrough };
}

type GovernedStreamHandle = AsyncGenerator<Record<string, unknown>> & {
	receipt: Promise<TrustReceipt>;
};

async function openStream(governed: unknown, params: Record<string, unknown> = PARAMS) {
	const models = (governed as { models: { generateContentStream: (p: unknown) => unknown } })
		.models;
	return (await models.generateContentStream(params)) as GovernedStreamHandle;
}

async function destroy(governed: unknown): Promise<void> {
	await (governed as { destroy(): Promise<void> }).destroy();
}

/** The chain events this call wrote, in order (every call event carries its transferId). */
function kindsFor(audit: { events: AppendEventInput[] }, transferId: string): string[] {
	return audit.events.filter((e) => e.data.transferId === transferId).map((e) => e.kind);
}

// ── generateContent is still governed ──

describe("Google generateContent stays governed", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	it("holds, settles once at the reported usage, and returns the envelope", async () => {
		const engine = makeMockEngine();
		const { client } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const result = await governed.models.generateContent(PARAMS);

		expect(result.receipt.provider).toBe("google");
		expect(result.receipt.usageSource).toBe("provider");
		expect(result.receipt.settled).toBe(true);
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await destroy(governed);
	});
});

// ── generateContentStream is governed ──

describe("Google generateContentStream is governed", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	it("yields the SDK's chunks unchanged and in order, and settles at the reported usage", async () => {
		const engine = makeMockEngine();
		const audit = makeMockAudit();
		const { client, generateContentStream } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: audit,
		});

		const stream = await openStream(governed);
		// The hold is placed BEFORE the stream is handed back, and nothing is settled yet.
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();
		expect(generateContentStream).toHaveBeenCalledOnce();

		const seen: unknown[] = [];
		for await (const c of stream) seen.push(c);
		// Same objects, same order: the governor is transparent middleware.
		expect(seen).toHaveLength(STREAM_WITH_USAGE.length);
		seen.forEach((c, i) => {
			expect(c).toBe(STREAM_WITH_USAGE[i]);
		});

		const receipt = await stream.receipt;
		expect(receipt.provider).toBe("google");
		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.cost).toBe(SETTLED_AT_REPORTED_USAGE);
		expect(receipt.chunksDelivered).toBe(STREAM_WITH_USAGE.length);

		// Exactly one post, at the reported usage, against the hold that was placed.
		const holdId = (engine.spendPending as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
			.transferId as string;
		expect(holdId).toBe(receipt.transferId);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledWith(holdId, SETTLED_AT_REPORTED_USAGE);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await destroy(governed);
	});

	it("writes the llm_call audit event for the stream, carrying the settled cost", async () => {
		const audit = makeMockAudit();
		const { client } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: audit,
		});

		const stream = await openStream(governed);
		for await (const _ of stream) {
			// consume
		}
		const receipt = await stream.receipt;

		expect(kindsFor(audit, receipt.transferId)).toEqual(["llm_call"]);
		const llmCall = audit.events.find((e) => e.kind === "llm_call");
		expect(llmCall?.data).toMatchObject({
			model: "gemini-2.5-flash",
			cost: SETTLED_AT_REPORTED_USAGE,
			settled: true,
			usageSource: "provider",
			chunksDelivered: STREAM_WITH_USAGE.length,
			transferId: receipt.transferId,
		});

		await destroy(governed);
	});

	it("resolves to an async generator with a .receipt promise (the SDK call shape survives)", async () => {
		const { client } = makeGoogleClient();
		const governed = await trust(client, { dryRun: true, budget: 50_000, vaultBase: tmpVault });

		const stream = await openStream(governed);
		expect(typeof stream.next).toBe("function");
		expect(typeof stream.return).toBe("function");
		expect(typeof stream[Symbol.asyncIterator]).toBe("function");
		expect(stream.receipt).toBeInstanceOf(Promise);
		for await (const _ of stream) {
			// consume
		}
		await expect(stream.receipt).resolves.toMatchObject({ provider: "google", settled: true });

		await destroy(governed);
	});

	it("refuses on budget BEFORE the SDK is called", async () => {
		const engine = makeMockEngine();
		const { client, generateContentStream } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 1,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const denied = openStream(governed);
		await expect(denied).rejects.toSatisfy(
			(err: unknown) => err instanceof PolicyDeniedError || err instanceof InsufficientBalanceError,
		);
		expect(generateContentStream).not.toHaveBeenCalled();
		expect(engine.spendPending).not.toHaveBeenCalled();

		await destroy(governed);
	});

	it("refuses on policy (PII in `contents`) BEFORE the SDK is called", async () => {
		writeVaultConfig(tmpVault, { budget: 50_000, pii: "block" });
		const engine = makeMockEngine();
		const { client, generateContentStream } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await expect(
			openStream(governed, {
				model: "gemini-2.5-flash",
				contents: [{ role: "user", parts: [{ text: "my ssn is 123-45-6789" }] }],
			}),
		).rejects.toThrow(/PII detected/);
		expect(generateContentStream).not.toHaveBeenCalled();
		expect(engine.spendPending).not.toHaveBeenCalled();

		await destroy(governed);
	});
});

// ── Every stream ending resolves the hold ──

describe("Google generateContentStream: every ending resolves the hold", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	it("an early consumer break SETTLES at the usage consumed so far (never left pending)", async () => {
		const engine = makeMockEngine();
		const { client } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const stream = await openStream(governed);
		for await (const _ of stream) {
			break; // one chunk: 10_000 in + 500 out = 30 + 12.5 → 43
		}
		const receipt = await stream.receipt;

		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.cost).toBe(43);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledWith(receipt.transferId, 43);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await destroy(governed);
	});

	it("an SDK error mid-stream VOIDs the hold once and records the partial delivery", async () => {
		const engine = makeMockEngine();
		const audit = makeMockAudit();
		const { client } = makeGoogleClient({ throwAfter: 2 });
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: audit,
		});

		const stream = await openStream(governed);
		const receiptOutcome = stream.receipt.then(
			() => "resolved",
			(err: unknown) => err,
		);
		const seen: unknown[] = [];
		await expect(
			(async () => {
				for await (const c of stream) seen.push(c);
			})(),
		).rejects.toThrow(/gemini stream interrupted/);
		expect(seen).toHaveLength(2);

		// `.receipt` rejects with the same error the iteration threw.
		const outcome = await receiptOutcome;
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toMatch(/gemini stream interrupted/);

		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();

		// The void's partial-delivery record is best-effort (not awaited by the terminal).
		await vi.waitFor(() => {
			expect(audit.events.some((e) => e.kind === "stream_partial_delivery")).toBe(true);
		});
		const partial = audit.events.find((e) => e.kind === "stream_partial_delivery");
		expect(partial?.data).toMatchObject({
			chunksDelivered: 2,
			partialInputTokens: 10_000,
			partialOutputTokens: 1_000,
			usageReported: true,
		});

		await destroy(governed);
	});

	it("a stream that never reports usageMetadata SETTLES at the estimate (never zero, never pending)", async () => {
		const engine = makeMockEngine();
		const audit = makeMockAudit();
		const { client } = makeGoogleClient({ chunks: STREAM_NO_USAGE });
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: audit,
		});

		const stream = await openStream(governed);
		for await (const _ of stream) {
			// consume
		}
		const receipt = await stream.receipt;

		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("estimated");
		// The estimate carries the 4096-token default output cap at 25/1k (≥ 103 on its
		// own), so it is nowhere near the 1-usertoken floor.
		expect(receipt.cost).toBeGreaterThanOrEqual(103);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledWith(receipt.transferId, receipt.cost);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(kindsFor(audit, receipt.transferId)).toEqual(["llm_call"]);

		await destroy(governed);
	});
});

// ── The other Google generation methods are refused by name ──

const REFUSED: Array<[string, string]> = Object.entries(GOOGLE_REFUSED_METHODS).flatMap(
	([ns, methods]) => methods.map((m): [string, string] => [ns, m]),
);

function namespaceOf(governed: unknown, ns: string): Record<string, (...a: unknown[]) => unknown> {
	let node = governed as Record<string, unknown>;
	for (const part of ns.split(".")) node = node[part] as Record<string, unknown>;
	return node as Record<string, (...a: unknown[]) => unknown>;
}

describe("Google generation methods usertrust does not govern are refused", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	it("covers every billable generation method the installed SDK exposes beside the governed two", () => {
		expect(REFUSED.map(([ns, m]) => `${ns}.${m}`).sort()).toEqual(
			[
				"batches.create",
				"batches.createEmbeddings",
				"chats.create",
				"interactions.create",
				"live.connect",
				"live.music.connect",
				"models.editImage",
				"models.embedContent",
				"models.generateImages",
				"models.generateVideos",
				"models.recontextImage",
				"models.segmentImage",
				"models.upscaleImage",
			].sort(),
		);
	});

	it.each(REFUSED)("%s.%s throws naming itself, before the SDK is called", async (ns, method) => {
		const engine = makeMockEngine();
		const { client, spies } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const fn = namespaceOf(governed, ns)[method];
		expect(typeof fn).toBe("function");
		let thrown: unknown;
		try {
			fn?.({ model: "gemini-2.5-flash" });
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(PolicyDeniedError);
		expect((thrown as Error).message).toContain(`${ns}.${method} is not governed`);
		expect((thrown as Error).message).toContain(
			"models.generateContent and models.generateContentStream",
		);

		const spy = (spies as Record<string, Record<string, ReturnType<typeof vi.fn>>>)[ns]?.[method];
		expect(spy).toBeDefined();
		expect(spy).not.toHaveBeenCalled();
		expect(engine.spendPending).not.toHaveBeenCalled();

		await destroy(governed);
	});

	it("free metadata calls and non-generation namespaces still pass through", async () => {
		const { client, passThrough } = makeGoogleClient();
		const governed = (await trust(client, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
		})) as unknown as typeof client;

		await expect(governed.models.countTokens()).resolves.toEqual({ totalTokens: 7 });
		await governed.models.list();
		await governed.batches.list();
		await governed.interactions.get();
		await governed.caches.create();
		expect(passThrough.countTokens).toHaveBeenCalledOnce();
		expect(passThrough.list).toHaveBeenCalledOnce();
		expect(passThrough.batchesList).toHaveBeenCalledOnce();
		expect(passThrough.interactionsGet).toHaveBeenCalledOnce();
		expect(passThrough.cachesCreate).toHaveBeenCalledOnce();

		// A wrapped namespace keeps a stable identity across accesses.
		expect(governed.chats).toBe(governed.chats);
		expect(governed.live.music).toBe(governed.live.music);

		await destroy(governed);
	});
});
