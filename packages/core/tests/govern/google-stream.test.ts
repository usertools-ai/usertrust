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
import { types as utilTypes } from "node:util";
import { runInNewContext } from "node:vm";
import { GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { resolveGooglePipeline, snapshotGoogleRequest } from "../../src/google-request.js";
import { GOOGLE_REFUSED_METHODS, type TrustEngine, trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import {
	AuditDegradedError,
	InsufficientBalanceError,
	PolicyDeniedError,
} from "../../src/shared/errors.js";
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

/** Each appended event gets its own hash (`hashes[i]` for `events[i]`), so a handle can be joined. */
function makeMockAudit(): AuditWriter & { events: AppendEventInput[]; hashes: string[] } {
	const events: AppendEventInput[] = [];
	const hashes: string[] = [];
	return {
		events,
		hashes,
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			events.push(input);
			const hash = String(events.length).padStart(64, "0");
			hashes.push(hash);
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash,
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
			embedContent: vi.fn(async (_params: Record<string, unknown>) => ({})),
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
		tunings: { tune: vi.fn(async () => ({})) },
		caches: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
		fileSearchStores: {
			uploadToFileSearchStore: vi.fn(async () => ({})),
			importFile: vi.fn(async () => ({})),
		},
	};
	const passThrough = {
		countTokens: vi.fn(async () => ({ totalTokens: 7 })),
		list: vi.fn(async () => []),
		batchesList: vi.fn(async () => []),
		interactionsGet: vi.fn(async () => ({ id: "i_1" })),
		cachesGet: vi.fn(async () => ({ name: "cachedContents/1" })),
		tuningsGet: vi.fn(async () => ({ name: "tunedModels/1" })),
		fileSearchStoresCreate: vi.fn(async () => ({ name: "fileSearchStores/1" })),
		documentsList: vi.fn(async () => []),
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
		tunings: { ...spies.tunings, get: passThrough.tuningsGet },
		caches: { ...spies.caches, get: passThrough.cachesGet },
		fileSearchStores: {
			...spies.fileSearchStores,
			create: passThrough.fileSearchStoresCreate,
			documents: { list: passThrough.documentsList },
		},
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

describe("Google billable methods usertrust does not govern are refused", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	it("covers every billable method the installed SDK exposes beside the governed two", () => {
		expect(REFUSED.map(([ns, m]) => `${ns}.${m}`).sort()).toEqual(
			[
				"batches.create",
				"batches.createEmbeddings",
				"caches.create",
				"caches.update",
				"chats.create",
				"fileSearchStores.importFile",
				"fileSearchStores.uploadToFileSearchStore",
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
				"tunings.tune",
			].sort(),
		);
	});

	it.each(REFUSED)(
		"%s.%s rejects naming itself, with its policy_denied event on the chain, before the SDK is called",
		async (ns, method) => {
			const engine = makeMockEngine();
			const audit = makeMockAudit();
			const { client, spies } = makeGoogleClient();
			const governed = await trust(client, {
				dryRun: false,
				budget: 50_000,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: audit,
			});

			const fn = namespaceOf(governed, ns)[method];
			expect(typeof fn).toBe("function");
			// Async: the call returns a promise (it never throws synchronously), because the
			// denial is appended to the chain before the caller hears of it.
			let pending: unknown;
			expect(() => {
				pending = fn?.({ model: "gemini-2.5-flash", contents: "Say hello" });
			}).not.toThrow();
			expect(pending).toBeInstanceOf(Promise);
			const err = await (pending as Promise<unknown>).then(
				() => undefined,
				(e: unknown) => e,
			);

			expect(err).toBeInstanceOf(PolicyDeniedError);
			const denied = err as PolicyDeniedError;
			expect(denied.message).toContain(`${ns}.${method} is not governed`);
			expect(denied.message).toContain("models.generateContent and models.generateContentStream");

			// Exactly one chain event, the denial, and the error carries ITS hash.
			expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
			expect(denied.auditEventHash).toBe(audit.hashes[0]);
			expect(denied.auditDegraded).toBeUndefined();
			const data = audit.events[0]?.data ?? {};
			expect(data).toMatchObject({
				decision: "deny",
				denialClass: "policy",
				actionName: `${ns}.${method}`,
				model: "gemini-2.5-flash",
				endpointClass: "cloud",
			});
			expect(String(data.error)).toContain(`${ns}.${method} is not governed`);
			// No prompt-derived field: the refusal never read the request's content.
			expect(data).not.toHaveProperty("promptHash");

			const spy = (spies as Record<string, Record<string, ReturnType<typeof vi.fn>>>)[ns]?.[method];
			expect(spy).toBeDefined();
			expect(spy).not.toHaveBeenCalled();
			expect(engine.spendPending).not.toHaveBeenCalled();

			await destroy(governed);
		},
	);

	for (const failClosed of [false, true]) {
		it(`failClosed:${failClosed} — a failed denial append still rejects with the typed refusal, marked degraded`, async () => {
			// The same contract every other denial has (appendDenialEvent): failClosed guards an
			// unaudited SPEND, and a refusal moves no money, so the caller gets the typed
			// PolicyDeniedError with `auditDegraded`, never an AuditDegradedError.
			writeVaultConfig(tmpVault, { budget: 50_000, audit: { failClosed } });
			const { client, spies } = makeGoogleClient();
			// The writer is healthy when the call starts and fails DURING it (this denial's
			// append). A writer already degraded at the start is refused earlier, with
			// AuditDegradedError, under failClosed: see the pre-degraded rows below.
			let failures = 0;
			const failingAudit: AuditWriter = {
				appendEvent: vi.fn(async () => {
					failures++;
					throw new Error("disk full");
				}),
				getWriteFailures: vi.fn(() => failures),
				isDegraded: vi.fn(() => failures > 0),
				flush: vi.fn(async () => {}),
				release: vi.fn(),
			};
			const governed = await trust(client, {
				dryRun: true,
				vaultBase: tmpVault,
				_audit: failingAudit,
			});

			const err = await governed.models.embedContent({ model: "gemini-embedding-001" }).then(
				() => undefined,
				(e: unknown) => e,
			);

			expect(err).toBeInstanceOf(PolicyDeniedError);
			expect((err as PolicyDeniedError).auditEventHash).toBeUndefined();
			expect((err as PolicyDeniedError).auditDegraded).toBe(true);
			expect(failingAudit.appendEvent).toHaveBeenCalledOnce();
			expect(spies.models.embedContent).not.toHaveBeenCalled();

			await destroy(governed);
		});
	}

	it("free metadata calls still pass through; fileSearchStores.create, not free, is refused", async () => {
		const { client, passThrough } = makeGoogleClient();
		const audit = makeMockAudit();
		const governed = (await trust(client, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: audit,
		})) as unknown as typeof client;

		await expect(governed.models.countTokens()).resolves.toEqual({ totalTokens: 7 });
		await governed.models.list();
		await governed.batches.list();
		await governed.interactions.get();
		await governed.caches.get();
		await governed.tunings.get();
		await governed.fileSearchStores.documents.list();
		expect(passThrough.countTokens).toHaveBeenCalledOnce();
		expect(passThrough.list).toHaveBeenCalledOnce();
		expect(passThrough.batchesList).toHaveBeenCalledOnce();
		expect(passThrough.interactionsGet).toHaveBeenCalledOnce();
		expect(passThrough.cachesGet).toHaveBeenCalledOnce();
		expect(passThrough.tuningsGet).toHaveBeenCalledOnce();
		expect(passThrough.documentsList).toHaveBeenCalledOnce();
		expect(audit.events).toEqual([]);

		// A duck-typed client is default-deny too: `fileSearchStores.create` is not on the free
		// list, so it is refused with its policy_denied event and the fake is never called.
		const err = await governed.fileSearchStores.create().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PolicyDeniedError);
		expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
		expect(audit.events[0]?.data.actionName).toBe("fileSearchStores.create");
		expect((err as PolicyDeniedError).auditEventHash).toBe(audit.hashes[0]);
		expect(passThrough.fileSearchStoresCreate).not.toHaveBeenCalled();

		// A wrapped namespace keeps a stable identity across accesses.
		expect(governed.chats).toBe(governed.chats);
		expect(governed.live.music).toBe(governed.live.music);

		await destroy(governed);
	});
});

// ── The refusal never runs caller code to read its labels ──

describe("a refusal reaches the denial boundary whatever the params hold", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	it("a throwing `model` getter still yields the PolicyDeniedError and its policy_denied event", async () => {
		const audit = makeMockAudit();
		const { client, spies } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: audit,
		});
		const getter = vi.fn(() => {
			throw new Error("getter ran");
		});
		const params = Object.defineProperty({}, "model", { get: getter, enumerable: true });

		const err = await governed.models.embedContent(params).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(PolicyDeniedError);
		expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
		expect((err as PolicyDeniedError).auditEventHash).toBe(audit.hashes[0]);
		expect(audit.events[0]?.data).not.toHaveProperty("model");
		expect(getter).not.toHaveBeenCalled();
		expect(spies.models.embedContent).not.toHaveBeenCalled();

		await destroy(governed);
	});
});

// ── Automatic function calling is refused on both methods (fail closed) ──

/** A CallableTool as the SDK recognises it: anything with a function `callTool`. */
function callableTool(): Record<string, unknown> {
	return {
		tool: vi.fn(async () => ({ functionDeclarations: [{ name: "lookup" }] })),
		callTool: vi.fn(async () => []),
	};
}

/** A FUNCTION object carrying `callTool`: the SDK's `'callTool' in tool` accepts it too. */
function callableFunctionTool(): unknown {
	return Object.assign(() => undefined, {
		tool: vi.fn(async () => ({ functionDeclarations: [{ name: "lookup" }] })),
		callTool: vi.fn(async () => []),
	});
}

/** A raw MCP client handed straight to `config.tools` (it has `callTool`, so the SDK calls it callable). */
function mcpClientTool(): Record<string, unknown> {
	return { listTools: vi.fn(async () => ({ tools: [] })), callTool: vi.fn(async () => ({})) };
}

const AFC_METHODS = ["generateContent", "generateContentStream"] as const;

function afcParams(config: Record<string, unknown>): Record<string, unknown> {
	return { model: "gemini-2.5-flash", contents: "Look it up", config };
}

/**
 * The same request on the REAL SDK, ungoverned, with `fetch` stubbed: what the caller gets ("ok", or the error's
 * message) and how many provider requests it made. `calls` scripts the model: round N asks for the function named
 * `calls[N]`, if any, and answers with text otherwise. The governed client runs the SDK's own pipeline over a fake
 * client's request too, so this is the native outcome its rows compare against.
 */
async function nativeRun(
	method: (typeof AFC_METHODS)[number],
	params: unknown,
	calls: Array<string | undefined> = [],
): Promise<{ result: string; requests: number }> {
	const realFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = (async (url: unknown) => {
		const call = calls[requests];
		requests++;
		const payload = {
			candidates: [
				{
					content: {
						role: "model",
						parts: [...(call ? [{ functionCall: { name: call, args: {} } }] : []), { text: "ok" }],
					},
				},
			],
			usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
		};
		return String(url).includes(":streamGenerateContent")
			? new Response(`data: ${JSON.stringify(payload)}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})
			: new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
	}) as typeof fetch;
	try {
		const out = await (
			new GoogleGenAI({ apiKey: "test" }).models as unknown as Record<
				string,
				(p: unknown) => Promise<unknown>
			>
		)[method]?.(params);
		if (method === "generateContentStream") {
			for await (const _ of out as AsyncIterable<unknown>) {
				// drained
			}
		}
		return { result: "ok", requests };
	} catch (err) {
		return { result: (err as Error).message, requests };
	} finally {
		globalThis.fetch = realFetch;
	}
}

/**
 * A request the SDK rejects locally, before any request, natively: the governed call throws the SDK's own error, as
 * the native call does, after a refusal is audited, and holds, charges and sends nothing.
 */
async function expectSdkRejection(
	tmpVault: string,
	method: (typeof AFC_METHODS)[number],
	makeParams: () => Record<string, unknown>,
): Promise<void> {
	const native = await nativeRun(method, makeParams());
	expect(native.result).not.toBe("ok");
	expect(native.requests).toBe(0);
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

	const err = await callModels(governed, method, makeParams()).then(
		() => undefined,
		(e: unknown) => e,
	);

	expect(err).not.toBeInstanceOf(PolicyDeniedError);
	expect((err as Error).message).toBe(native.result);
	expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
	expect(engine.spendPending).not.toHaveBeenCalled();
	expect(client.models.generateContent).not.toHaveBeenCalled();
	expect(generateContentStream).not.toHaveBeenCalled();
	await destroy(governed);
}

async function callModels(
	governed: unknown,
	method: (typeof AFC_METHODS)[number],
	params: Record<string, unknown>,
): Promise<unknown> {
	const models = (governed as { models: Record<string, (p: unknown) => Promise<unknown>> }).models;
	const result = await models[method]?.(params);
	if (method === "generateContentStream") {
		const stream = result as GovernedStreamHandle;
		for await (const _ of stream) {
			// consume
		}
		return stream.receipt;
	}
	return (result as { receipt: TrustReceipt }).receipt;
}

describe("automatic function calling: metered per round on generateContent, refused on generateContentStream", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	const REFUSED_AFC: Array<[string, () => Record<string, unknown>]> = [
		["a callable tool object", () => ({ tools: [callableTool()] })],
		["a callable FUNCTION object", () => ({ tools: [callableFunctionTool()] })],
		[
			"a callable tool after a plain declaration-less tool",
			() => ({ tools: [{ googleSearch: {} }, callableTool()] }),
		],
		[
			"a valid maximumRemoteCalls (3)",
			() => ({ tools: [callableTool()], automaticFunctionCalling: { maximumRemoteCalls: 3 } }),
		],
	];

	it.each(REFUSED_AFC)(
		"generateContent: %s → the governed per-round loop runs on the snapshot (one governed call per round)",
		async (_, config) => {
			const engine = makeMockEngine();
			const audit = makeMockAudit();
			const { client } = makeGoogleClient();
			const governed = await trust(client, {
				dryRun: false,
				budget: 50_000,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: audit,
			});
			const params = afcParams(config());

			const out = (await governed.models.generateContent(params)) as unknown as {
				receipt: TrustReceipt;
				receipts?: TrustReceipt[];
			};

			// The fake model returns no function calls, so the loop is one round.
			expect(out.receipts).toHaveLength(1);
			expect(out.receipt.settled).toBe(true);
			expect(engine.spendPending).toHaveBeenCalledOnce();
			expect(audit.events.map((e) => e.kind)).toEqual(["llm_call"]);
			expect(client.models.generateContent).toHaveBeenCalledOnce();
			const round = client.models.generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
			const roundConfig = round.config as Record<string, unknown>;
			// The SDK's own loop is off for the round; the round was built from OUR snapshot.
			expect(roundConfig.automaticFunctionCalling).toMatchObject({ disable: true });
			expect(round).not.toBe(params);
			expect(roundConfig).not.toBe(params.config);

			await destroy(governed);
		},
	);

	{
		const method = "generateContentStream" as const;
		it.each(REFUSED_AFC)(
			`${method}: %s → refused, audited, no hold, no SDK call`,
			async (_, config) => {
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

				const err = await callModels(governed, method, afcParams(config())).then(
					() => undefined,
					(e: unknown) => e,
				);

				expect(err).toBeInstanceOf(PolicyDeniedError);
				expect((err as Error).message).toContain(
					`models.${method} with automatic function calling is not governed yet`,
				);
				expect((err as PolicyDeniedError).auditEventHash).toBe(audit.hashes[0]);
				expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
				expect(audit.events[0]?.data).toMatchObject({
					actionName: `models.${method}`,
					model: "gemini-2.5-flash",
				});
				expect(engine.spendPending).not.toHaveBeenCalled();
				expect(client.models.generateContent).not.toHaveBeenCalled();
				expect(generateContentStream).not.toHaveBeenCalled();

				await destroy(governed);
			},
		);
	}

	const GOVERNED_AFC: Array<[string, () => Record<string, unknown>]> = [
		["no tools", () => ({})],
		["no callable tool", () => ({ tools: [{ functionDeclarations: [{ name: "lookup" }] }] })],
		[
			"AFC disabled",
			() => ({ tools: [callableTool()], automaticFunctionCalling: { disable: true } }),
		],
		[
			"maximumRemoteCalls 0",
			() => ({ tools: [callableTool()], automaticFunctionCalling: { maximumRemoteCalls: 0 } }),
		],
		[
			"maximumRemoteCalls -1",
			() => ({ tools: [callableTool()], automaticFunctionCalling: { maximumRemoteCalls: -1 } }),
		],
		[
			"maximumRemoteCalls 1.5",
			() => ({ tools: [callableTool()], automaticFunctionCalling: { maximumRemoteCalls: 1.5 } }),
		],
	];

	for (const method of AFC_METHODS) {
		it.each(GOVERNED_AFC)(
			`${method}: %s → governed as before (the SDK runs no AFC loop)`,
			async (_, config) => {
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
				const receipt = (await callModels(governed, method, afcParams(config()))) as TrustReceipt;

				expect(receipt.settled).toBe(true);
				expect(audit.events.map((e) => e.kind)).toEqual(["llm_call"]);
				expect(engine.spendPending).toHaveBeenCalledOnce();
				expect(engine.postPendingSpend).toHaveBeenCalledOnce();
				const sdk =
					method === "generateContent" ? client.models.generateContent : generateContentStream;
				expect(sdk).toHaveBeenCalledOnce();

				await destroy(governed);
			},
		);
	}

	for (const method of AFC_METHODS) {
		it(`${method}: a plain declaration beside a callable tool is the SDK's own incompatible-declarations error, as natively: audited, nothing held or sent`, async () => {
			await expectSdkRejection(tmpVault, method, () =>
				afcParams({ tools: [callableTool(), { functionDeclarations: [{ name: "x" }] }] }),
			);
		});

		it(`${method}: a raw MCP client in config.tools (callTool, no tool()) is the SDK's own TypeError, as natively: audited, nothing held or sent`, async () => {
			await expectSdkRejection(tmpVault, method, () => afcParams({ tools: [mcpClientTool()] }));
		});
	}

	it("generateContent: the loop runs on the snapshot, so a callable tool added or maximumRemoteCalls changed during round 1's hold never reaches a round", async () => {
		const { engine, holdEntered, release } = makeGatedEngine();
		const { client } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});
		const tool = callableTool();
		const params = afcParams({
			tools: [tool],
			automaticFunctionCalling: { maximumRemoteCalls: 2 },
		});

		const pending = governed.models.generateContent(params);
		await holdEntered;
		const config = params.config as Record<string, unknown>;
		(config.tools as unknown[]).push(callableTool());
		(config.automaticFunctionCalling as Record<string, unknown>).maximumRemoteCalls = 9;
		release();
		await pending;

		const round = client.models.generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
		const roundConfig = round.config as Record<string, unknown>;
		expect(config.tools as unknown[]).toHaveLength(2); // the caller's mutation happened
		expect(roundConfig.tools as unknown[]).toHaveLength(1);
		expect(roundConfig.automaticFunctionCalling).toMatchObject({
			maximumRemoteCalls: 2,
			disable: true,
		});

		await destroy(governed);
	});

	it("a config.tools getter runs as natively (the SDK's own reads, one loop step included), and generateContent runs the governed loop on the mirror", async () => {
		const engine = makeMockEngine();
		const audit = makeMockAudit();
		const { client } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: audit,
		});
		const tool = callableTool();
		const makeConfig = (getter: () => unknown[]) =>
			Object.defineProperty({}, "tools", { get: getter, enumerable: true });
		// Natively, with the model asking for the tool once, as the governed capture's probe does.
		const nativeGetter = vi.fn(() => [callableTool()]);
		await nativeRun("generateContent", afcParams(makeConfig(nativeGetter)), ["lookup"]);
		const toolsGetter = vi.fn(() => [tool]);

		const out = (await governed.models.generateContent(
			afcParams(makeConfig(toolsGetter)),
		)) as unknown as {
			receipts?: TrustReceipt[];
		};

		expect(toolsGetter).toHaveBeenCalledTimes(nativeGetter.mock.calls.length);
		expect(out.receipts).toHaveLength(1);
		expect(audit.events.map((e) => e.kind)).toEqual(["llm_call"]);
		const round = client.models.generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(Object.getOwnPropertyDescriptor(round.config, "tools")).toHaveProperty("value");

		await destroy(governed);
	});

	for (const method of AFC_METHODS) {
		it(`${method}: a config held by an accessor (here one that would THROW) is refused at call start, its getter never run: audited, nothing held or sent`, async () => {
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
			const getter = vi.fn(() => {
				throw new Error("getter exploded");
			});
			const params = Object.defineProperty(
				{ model: "gemini-2.5-flash", contents: "hi" },
				"config",
				{
					get: getter,
					enumerable: true,
				},
			);
			const err = await callModels(governed, method, params).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(PolicyDeniedError);
			expect((err as Error).message).toContain("config (unreadable)");
			expect(getter).not.toHaveBeenCalled();
			expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
			expect(engine.spendPending).not.toHaveBeenCalled();
			expect(client.models.generateContent).not.toHaveBeenCalled();
			expect(generateContentStream).not.toHaveBeenCalled();
			await destroy(governed);
		});

		it(`${method}: a config that is not an object (here a data property holding a number) is governed as natively: the SDK reads nothing from it`, async () => {
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
			const params = () => ({ model: "gemini-2.5-flash", contents: "hi", config: 42 });
			const native = await nativeRun(method, params());
			expect(native).toEqual({ result: "ok", requests: 1 });

			const receipt = (await callModels(governed, method, params())) as TrustReceipt;

			expect(receipt.settled).toBe(true);
			expect(audit.events.map((e) => e.kind)).toEqual(["llm_call"]);
			expect(engine.spendPending).toHaveBeenCalledOnce();
			const sdk =
				method === "generateContent" ? client.models.generateContent : generateContentStream;
			expect(sdk).toHaveBeenCalledOnce();
			await destroy(governed);
		});
	}
});

// ── Edge values of the AFC config: the SDK's own decision, each pinned ──

describe("edge values of the AFC config are decided by the SDK itself, each pinned", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	async function governedClient() {
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
		return { governed, engine, audit, client, generateContentStream };
	}

	it("disable: 1 (truthy, not true) is the SDK's own off switch: one governed call, no loop", async () => {
		const { governed, engine, client } = await governedClient();
		const out = (await governed.models.generateContent(
			afcParams({ tools: [callableTool()], automaticFunctionCalling: { disable: 1 } }),
		)) as unknown as { receipts?: unknown[] };

		expect(out.receipts).toBeUndefined(); // not the governed loop
		expect(engine.spendPending).toHaveBeenCalledOnce();
		const sent = client.models.generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
		// the SDK decided no AFC on disable: 1; the forward then owns its off switch as disable: true
		expect((sent.config as Record<string, unknown>).automaticFunctionCalling).toEqual({
			disable: true,
		});
		await destroy(governed);
	});

	it("an array-LIKE functionDeclarations beside a callable tool is the SDK's own incompatible-declarations error, as natively", async () => {
		const arrayLike = { length: 1, 0: { name: "f" } };
		await expectSdkRejection(tmpVault, "generateContent", () =>
			afcParams({ tools: [callableTool(), { functionDeclarations: arrayLike }] }),
		);
	});

	/** `[<hole>, callableTool()]`, built without a sparse literal. */
	const holeyTools = (): unknown[] => {
		const tools: unknown[] = new Array(2);
		tools[1] = callableTool();
		return tools;
	};

	// Shapes the hand-written AFC reading could not read: the SDK's own pipeline decides them, as natively.
	const SDK_REJECTS: Array<[string, () => Record<string, unknown>]> = [
		["a hole in config.tools", () => ({ tools: holeyTools() })],
		["a non-array config.tools", () => ({ tools: { 0: callableTool(), length: 1 } })],
		["a primitive tool", () => ({ tools: ["search", callableTool()] })],
	];

	it.each(SDK_REJECTS)(
		"%s is the SDK's own TypeError, as natively: audited, nothing held or sent",
		async (_, config) => {
			await expectSdkRejection(tmpVault, "generateContent", () => afcParams(config()));
		},
	);

	it("an object maximumRemoteCalls is invalid to the SDK, which turns AFC off: one ordinary governed call, as natively", async () => {
		const params = () =>
			afcParams({
				tools: [callableTool()],
				automaticFunctionCalling: { maximumRemoteCalls: { n: 3 } },
			});
		expect(await nativeRun("generateContent", params(), ["lookup"])).toEqual({
			result: "ok",
			requests: 1,
		});
		const { governed, engine, audit, client } = await governedClient();

		const out = (await governed.models.generateContent(params())) as unknown as {
			receipts?: unknown[];
		};

		expect(out.receipts).toBeUndefined(); // not the governed loop
		expect(audit.events.map((e) => e.kind)).toEqual(["llm_call"]);
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(client.models.generateContent).toHaveBeenCalledOnce();
		await destroy(governed);
	});
});

// ── A FLIP getter: the check and the REAL SDK must see the same, once-read value ──

describe("a config getter that flips after its first read cannot turn the SDK's own AFC on", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	/** The real @google/genai client, its network calls replaced by a one-round model. */
	function realSdk() {
		const sdk = new GoogleGenAI({ apiKey: "test" });
		const sent: Array<Record<string, unknown>> = [];
		const reply = () => {
			const res = new GenerateContentResponse();
			res.candidates = [{ content: { role: "model", parts: [{ text: "done" }] } }];
			res.usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };
			return res;
		};
		const models = sdk.models as unknown as Record<string, unknown>;
		models.generateContentInternal = async (p: Record<string, unknown>) => {
			sent.push(p);
			return reply();
		};
		models.generateContentStreamInternal = async (p: Record<string, unknown>) => {
			sent.push(p);
			return (async function* () {
				yield reply();
			})();
		};
		return { sdk, sent };
	}

	/** A request whose `config` getter shows NO callable tool on its first read and one on every later read. */
	function flippingRequest() {
		const tool = {
			tool: vi.fn(async () => ({ functionDeclarations: [{ name: "f" }] })),
			callTool: vi.fn(async () => []),
		};
		let reads = 0;
		const getter = vi.fn(() => {
			reads++;
			return reads === 1 ? { tools: [{ googleSearch: {} }] } : { tools: [tool] };
		});
		const params = Object.defineProperty({ model: "gemini-2.5-flash", contents: "go" }, "config", {
			get: getter,
			enumerable: true,
		});
		return { params, getter, tool };
	}

	for (const method of AFC_METHODS) {
		it(`${method}: config held by an accessor is refused at call start, as per-call request options are (config unreadable): the getter never runs, no model request, and the callable tool's code never runs`, async () => {
			const { sdk, sent } = realSdk();
			const { params, getter, tool } = flippingRequest();
			const audit = makeMockAudit();
			const governed = await trust(sdk, {
				dryRun: true,
				budget: 500_000,
				vaultBase: tmpVault,
				_audit: audit,
			});

			const err = await callModels(
				governed,
				method,
				params as unknown as Record<string, unknown>,
			).then(
				() => undefined,
				(e: unknown) => e,
			);

			expect(err).toBeInstanceOf(PolicyDeniedError);
			expect((err as Error).message).toContain("request_option_refused");
			expect((err as Error).message).toContain("config (unreadable)");
			expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
			// refused before anything read the request: the getter never ran, nothing was sent
			expect(getter).not.toHaveBeenCalled();
			expect(sent).toHaveLength(0);
			expect(tool.tool).not.toHaveBeenCalled();
			expect(tool.callTool).not.toHaveBeenCalled();

			await destroy(governed);
		});
	}
});

// ── A governed stream closed before its first read still ends its hold ──

function makeOpenAIStreamClient() {
	const sourceReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
	const create = vi.fn(async (_params: Record<string, unknown>) => {
		const events = [
			{ choices: [{ delta: { content: "Hi" } }] },
			{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
		];
		let i = 0;
		const iterator = {
			next: async () =>
				i < events.length
					? { done: false as const, value: events[i++] }
					: { done: true as const, value: undefined },
			return: sourceReturn,
			[Symbol.asyncIterator]() {
				return iterator;
			},
		};
		return iterator;
	});
	return { client: { chat: { completions: { create } } }, sourceReturn };
}

describe("a governed stream closed before its first next() ends its hold", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	it("Google: .return() before next() SETTLES at the estimate (the early-break rule) and destroy() does not wait", async () => {
		const engine = makeMockEngine();
		const audit = makeMockAudit();
		const { client } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: audit,
		});

		const stream = await openStream(governed);
		await expect(stream.return(undefined)).resolves.toEqual({ done: true, value: undefined });
		const receipt = await stream.receipt;

		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.chunksDelivered).toBe(0);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledWith(receipt.transferId, receipt.cost);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(kindsFor(audit, receipt.transferId)).toEqual(["llm_call"]);
		// The generator is closed: nothing more is delivered.
		await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });

		// The in-flight stream count dropped: destroy() is not held to its 5 s deadline.
		const t0 = Date.now();
		await destroy(governed);
		expect(Date.now() - t0).toBeLessThan(1_000);
	});

	it("Google: .throw() before next() VOIDs the hold, rejects .receipt with that error, and destroy() does not wait", async () => {
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
		const injected = new Error("caller aborted");
		const receiptOutcome = stream.receipt.then(
			() => "resolved",
			(e: unknown) => e,
		);
		await expect(stream.throw(injected)).rejects.toBe(injected);
		expect(await receiptOutcome).toBe(injected);
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();

		const t0 = Date.now();
		await destroy(governed);
		expect(Date.now() - t0).toBeLessThan(1_000);
	});

	it("OpenAI chat.completions stream: .return() before next() settles and closes the provider stream", async () => {
		const engine = makeMockEngine();
		const { client, sourceReturn } = makeOpenAIStreamClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const result = await governed.chat.completions.create({
			model: "gpt-4o",
			messages: [{ role: "user", content: "Hi" }],
			stream: true,
		});
		const stream = result.response as unknown as GovernedStreamHandle;
		await stream.return(undefined);
		const receipt = await stream.receipt;

		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("estimated");
		expect(sourceReturn).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		const t0 = Date.now();
		await destroy(governed);
		expect(Date.now() - t0).toBeLessThan(1_000);
	});
});

// ── A Proxy anywhere the AFC check reads is refused (fail closed) ──

describe("Proxies in the request are read as the SDK reads them, and governed", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	/** A transparent Proxy: it lies about nothing. */
	const proxied = <T extends object>(target: T): T => new Proxy(target, {});

	const POSITIONS: Array<[string, () => Record<string, unknown>]> = [
		["params", () => proxied(afcParams({ tools: [callableTool()] }))],
		[
			"params.config",
			() => ({
				model: "gemini-2.5-flash",
				contents: "Look it up",
				config: proxied({ tools: [callableTool()] }),
			}),
		],
		["params.config.tools", () => afcParams({ tools: proxied([callableTool()]) })],
		[
			"params.config.tools[1]",
			() => afcParams({ tools: [{ googleSearch: {} }, proxied(callableTool())] }),
		],
		[
			"params.config.automaticFunctionCalling",
			() =>
				afcParams({
					tools: [callableTool()],
					automaticFunctionCalling: proxied({ maximumRemoteCalls: 3 }),
				}),
		],
		[
			// what descriptor reads see (no tool) is not what a plain get returns (a callable tool): the SDK reads with get
			"params, its descriptors hiding the callable tool its get trap returns",
			() => {
				const shown = { tools: [] as unknown[] };
				const real = { tools: [callableTool()] };
				const target = { model: "gemini-2.5-flash", contents: "Look it up", config: shown };
				return new Proxy<Record<string, unknown>>(target, {
					getOwnPropertyDescriptor: (t, key) => Reflect.getOwnPropertyDescriptor(t, key),
					get: (t, key, receiver) => (key === "config" ? real : Reflect.get(t, key, receiver)),
				});
			},
		],
	];

	/** Positions the per-call request-option check refuses at call start: it cannot read the request, or its config, there. */
	const REFUSED_AT_CALL_START = new Set([
		"params",
		"params.config",
		"params, its descriptors hiding the callable tool its get trap returns",
	]);

	/** Refused at call start as a per-call request-option refusal: audited, nothing held or sent. */
	function expectRefusedAtCallStart(r: Awaited<ReturnType<typeof governedCall>>): void {
		expect(r.err).toBeInstanceOf(PolicyDeniedError);
		expect((r.err as Error).message).toContain("request_option_refused");
		expect(r.audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
		expect(r.engine.spendPending).not.toHaveBeenCalled();
		expect(r.client.models.generateContent).not.toHaveBeenCalled();
		expect(r.generateContentStream).not.toHaveBeenCalled();
	}

	async function governedCall(
		method: (typeof AFC_METHODS)[number],
		params: Record<string, unknown>,
	) {
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
		const result: { receipt?: TrustReceipt; err?: unknown } = await callModels(
			governed,
			method,
			params,
		).then(
			(receipt) => ({ receipt: receipt as TrustReceipt }),
			(err: unknown) => ({ err }),
		);
		await destroy(governed);
		return { ...result, engine, audit, client, generateContentStream };
	}

	it.each(POSITIONS)(
		"generateContent: a Proxy in %s → refused at call start where the request-option check cannot read the request or its config; elsewhere the SDK, reading it, would loop: the governed per-round loop runs on the plain mirror",
		async (position, params) => {
			const r = await governedCall("generateContent", params());
			if (REFUSED_AT_CALL_START.has(position)) {
				expectRefusedAtCallStart(r);
				return;
			}
			const { receipt, engine, audit, client } = r;

			expect(receipt?.settled).toBe(true);
			expect(audit.events.map((e) => e.kind)).toEqual(["llm_call"]);
			expect(engine.spendPending).toHaveBeenCalledOnce();
			expect(client.models.generateContent).toHaveBeenCalledOnce();
			const round = client.models.generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
			// what reached the SDK is the mirror, plain data, with the SDK's own loop off for the round
			expect(utilTypes.isProxy(round)).toBe(false);
			expect(utilTypes.isProxy(round.config)).toBe(false);
			expect((round.config as Record<string, unknown>).automaticFunctionCalling).toMatchObject({
				disable: true,
			});
		},
	);

	it.each(POSITIONS)(
		"generateContentStream: a Proxy in %s → refused at call start where the request-option check cannot read the request or its config; elsewhere refused as an AFC stream; no hold, no SDK call",
		async (position, params) => {
			const r = await governedCall("generateContentStream", params());
			if (REFUSED_AT_CALL_START.has(position)) {
				expectRefusedAtCallStart(r);
				return;
			}
			const { err, engine, audit, client, generateContentStream } = r;

			expect(err).toBeInstanceOf(PolicyDeniedError);
			expect((err as Error).message).toContain(
				"models.generateContentStream with automatic function calling is not governed yet",
			);
			expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
			expect(engine.spendPending).not.toHaveBeenCalled();
			expect(client.models.generateContent).not.toHaveBeenCalled();
			expect(generateContentStream).not.toHaveBeenCalled();
		},
	);

	for (const method of AFC_METHODS) {
		it(`${method}: a request with Proxies inside it (tools, a tool) and no callable tool is governed as one call, and the SDK receives plain data`, async () => {
			const { receipt, engine, client, generateContentStream } = await governedCall(
				method,
				afcParams({
					tools: proxied([proxied({ googleSearch: {} })]),
					automaticFunctionCalling: proxied({}),
				}),
			);

			expect(receipt?.settled).toBe(true);
			expect(engine.spendPending).toHaveBeenCalledOnce();
			const sdk =
				method === "generateContent" ? client.models.generateContent : generateContentStream;
			expect(sdk).toHaveBeenCalledOnce();
			const received = sdk.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(utilTypes.isProxy(received)).toBe(false);
			expect(received.config).toMatchObject({ tools: [{ googleSearch: {} }] });
		});
	}
});

// ── What is forwarded is what was checked: the AFC snapshot ──

/** An engine whose hold waits on `release()`: the window in which a caller could mutate. */
function makeGatedEngine() {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let entered!: () => void;
	const holdEntered = new Promise<void>((r) => {
		entered = r;
	});
	const engine = makeMockEngine();
	engine.spendPending = vi.fn(async (p: { transferId: string; amount: number }) => {
		entered();
		await gate;
		return { transferId: p.transferId };
	}) as TrustEngine["spendPending"];
	return { engine, holdEntered, release };
}

/** A declaration as a class instance: its prototype is the class's, not Object.prototype. */
class DeclarationInstance {
	name = "lookup";
}

/** An array subclass: a real array whose prototype is the subclass's, not Array.prototype. */
class DeclarationList<T> extends Array<T> {}

/**
 * One row per shape the snapshot refuses inside a field the SDK sends from a non-callable
 * tool: the tool, the path the refusal names, and a stable word the hint must carry for it.
 */
const UNCOPYABLE_SHAPES: Array<[shape: string, tool: () => object, at: string, hint: RegExp]> = [
	[
		"a class instance",
		() => ({ functionDeclarations: [new DeclarationInstance()] }),
		"params.config.tools[0].functionDeclarations[0]",
		/\bclass instance\b/,
	],
	[
		"a plain object made with Object.create from another object",
		() => ({
			functionDeclarations: [Object.assign(Object.create({ inherited: true }), { name: "lookup" })],
		}),
		"params.config.tools[0].functionDeclarations[0]",
		/\bobject whose prototype\b/,
	],
	[
		"an array whose prototype is not Array's (an array subclass)",
		() => ({ functionDeclarations: DeclarationList.of({ name: "lookup" }) }),
		"params.config.tools[0].functionDeclarations",
		/\barray whose prototype\b/,
	],
	[
		"an accessor",
		() => ({
			functionDeclarations: [
				{
					get name() {
						return "lookup";
					},
				},
			],
		}),
		"params.config.tools[0].functionDeclarations[0].name",
		/\baccessor\b/,
	],
	[
		"a non-enumerable property",
		() => ({
			functionDeclarations: [
				Object.defineProperty({}, "name", { value: "lookup", enumerable: false }),
			],
		}),
		"params.config.tools[0].functionDeclarations[0].name",
		/\bnon-enumerable property\b/,
	],
	[
		"a function",
		() => ({ googleSearch: { hook: () => 1 } }),
		"params.config.tools[0].googleSearch.hook",
		/\ba function\b/i,
	],
	[
		"a symbol",
		() => ({ googleSearch: { tag: Symbol("tag") } }),
		"params.config.tools[0].googleSearch",
		/\bsymbol\b/,
	],
	[
		"a sparse array",
		() => {
			const declarations: unknown[] = [{ name: "lookup" }];
			declarations[2] = { name: "other" }; // index 1 is a hole
			return { functionDeclarations: declarations };
		},
		"params.config.tools[0].functionDeclarations",
		/\bsparse array\b/,
	],
	[
		"an array with a named property",
		() => ({ functionDeclarations: Object.assign([{ name: "lookup" }], { extra: 1 }) }),
		"params.config.tools[0].functionDeclarations.extra",
		/\barray with a named property\b/,
	],
	[
		"an array whose prototype is another plain array",
		() => ({ functionDeclarations: Object.setPrototypeOf([{ name: "lookup" }], []) as unknown[] }),
		"params.config.tools[0].functionDeclarations",
		/\barray whose prototype\b/,
	],
	[
		'an array with an own "4294967295" (not an index), length 1 and a hole',
		() => {
			const declarations: unknown[] = new Array(1);
			Object.defineProperty(declarations, "4294967295", {
				value: { name: "lookup" },
				enumerable: true,
				writable: true,
				configurable: true,
			});
			return { functionDeclarations: declarations };
		},
		"params.config.tools[0].functionDeclarations.4294967295",
		/\barray with a named property\b/,
	],
	[
		'an array with a non-canonical index key "01"',
		() => ({
			functionDeclarations: Object.assign([{ name: "lookup" }], { "01": { name: "other" } }),
		}),
		"params.config.tools[0].functionDeclarations.01",
		/\barray with a named property\b/,
	],
];

/** Arrays the walk must still accept: a dense same-realm array, and plain arrays from another realm. */
const COPYABLE_ARRAYS: Array<[shape: string, tool: () => object]> = [
	[
		"a dense array of plain declarations",
		() => ({ functionDeclarations: [{ name: "lookup" }, { name: "other", parameters: {} }] }),
	],
	[
		"a declarations array from another realm",
		() => ({ functionDeclarations: runInNewContext('[{ name: "lookup" }]') as unknown[] }),
	],
	[
		"a whole tool from another realm, nested arrays included",
		() =>
			runInNewContext(
				'({ functionDeclarations: [{ name: "lookup", parameters: { type: "OBJECT", required: ["q"] } }] })',
			) as object,
	],
];

describe("the request is forwarded as a snapshot of the checked AFC config", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	/**
	 * Start the call, wait until authorization is holding, run `mutate` on the caller's
	 * params, then let the call finish. Returns what the SDK received and what the
	 * CALLER's params looked like at the moment the SDK was called.
	 */
	async function callWithMutation(
		method: (typeof AFC_METHODS)[number],
		params: Record<string, unknown>,
		mutate: (p: Record<string, unknown>) => void,
	) {
		const { engine, holdEntered, release } = makeGatedEngine();
		const { client, generateContentStream } = makeGoogleClient();
		const sdk =
			method === "generateContent" ? client.models.generateContent : generateContentStream;
		const callerAtSdkCall: { config?: unknown; tools?: unknown[]; disable?: unknown } = {};
		const original = sdk.getMockImplementation();
		sdk.mockImplementationOnce(async (received: Record<string, unknown>) => {
			const config = params.config as Record<string, unknown>;
			callerAtSdkCall.tools = [...(config.tools as unknown[])];
			callerAtSdkCall.disable = (
				config.automaticFunctionCalling as Record<string, unknown> | undefined
			)?.disable;
			// biome-ignore lint/style/noNonNullAssertion: the fake always has an implementation
			return original!(received) as never;
		});
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const pending = callModels(governed, method, params);
		await holdEntered;
		mutate(params);
		release();
		const receipt = (await pending) as TrustReceipt;
		const received = sdk.mock.calls[0]?.[0] as Record<string, unknown>;
		await destroy(governed);
		return { receipt, received, callerAtSdkCall, sdk };
	}

	for (const method of AFC_METHODS) {
		it(`${method}: a callable tool added to config.tools during authorization never reaches the SDK`, async () => {
			const params = afcParams({ tools: [{ googleSearch: {} }] });
			const added = callableTool();
			const { receipt, received, callerAtSdkCall, sdk } = await callWithMutation(
				method,
				params,
				(p) => {
					((p.config as Record<string, unknown>).tools as unknown[]).push(added);
				},
			);

			// The mutation really happened, before the SDK was called...
			expect(callerAtSdkCall.tools).toHaveLength(2);
			expect(callerAtSdkCall.tools?.[1]).toBe(added);
			// ...and the SDK received the snapshot: one data tool, no callable one.
			expect(sdk).toHaveBeenCalledOnce();
			expect(received).not.toBe(params);
			const tools = (received.config as Record<string, unknown>).tools as unknown[];
			expect(tools).toEqual([{ googleSearch: {} }]);
			expect(tools.some((t) => typeof (t as { callTool?: unknown }).callTool === "function")).toBe(
				false,
			);
			expect(receipt.settled).toBe(true);
		});

		it(`${method}: automaticFunctionCalling.disable flipped to false during authorization is not seen by the SDK`, async () => {
			const tool = callableTool();
			const params = afcParams({ tools: [tool], automaticFunctionCalling: { disable: true } });
			const { received, callerAtSdkCall, sdk } = await callWithMutation(method, params, (p) => {
				(
					(p.config as Record<string, unknown>).automaticFunctionCalling as Record<string, unknown>
				).disable = false;
			});

			expect(callerAtSdkCall.disable).toBe(false);
			expect(sdk).toHaveBeenCalledOnce();
			const config = received.config as Record<string, unknown>;
			expect((config.automaticFunctionCalling as Record<string, unknown>).disable).toBe(true);
			expect(config.automaticFunctionCalling).not.toBe(
				(params.config as Record<string, unknown>).automaticFunctionCalling,
			);
		});

		// Shapes the hand-written snapshot could not copy as data: the SDK's own pipeline reads them, so each is governed as
		// natively (sent, or the SDK's own local error).
		for (const [shape, makeTool] of [
			[
				"a function inside a field the SDK sends",
				() => ({ googleSearch: { hook: () => 1 } }),
			] as const,
			...UNCOPYABLE_SHAPES.map(([shape, makeTool]) => [shape, makeTool] as const),
		]) {
			it(`${method}: ${shape} in a tool is governed as natively`, async () => {
				const params = () => afcParams({ tools: [{ googleSearch: {} }, makeTool()] });
				const native = await nativeRun(method, params());
				if (native.result !== "ok") {
					await expectSdkRejection(tmpVault, method, params);
					return;
				}
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

				const receipt = (await callModels(governed, method, params())) as TrustReceipt;

				expect(receipt.settled).toBe(true);
				expect(audit.events.map((e) => e.kind)).toEqual(["llm_call"]);
				const sdk =
					method === "generateContent" ? client.models.generateContent : generateContentStream;
				expect(sdk).toHaveBeenCalledOnce();
				await destroy(governed);
			});
		}

		for (const [shape, makeTool] of COPYABLE_ARRAYS) {
			it(`${method}: ${shape} is accepted and forwarded as equal data (control)`, async () => {
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
				const params = afcParams({ tools: [makeTool()] });

				const receipt = (await callModels(governed, method, params)) as TrustReceipt;

				expect(receipt.settled).toBe(true);
				expect(audit.events.map((e) => e.kind)).not.toContain("policy_denied");
				const sdk =
					method === "generateContent" ? client.models.generateContent : generateContentStream;
				expect(sdk).toHaveBeenCalledOnce();
				const received = sdk.mock.calls[0]?.[0] as Record<string, unknown>;
				// structuredClone makes the copy in this realm, so compare as JSON, as the wire would
				expect(JSON.stringify((received.config as Record<string, unknown>).tools)).toBe(
					JSON.stringify((params.config as Record<string, unknown>).tools),
				);
				await destroy(governed);
			});
		}

		it(`${method}: AFC disabled with callable tools is governed, and the SDK receives a governed wrapper of each, whose tool() has not run`, async () => {
			const engine = makeMockEngine();
			const { client, generateContentStream } = makeGoogleClient();
			const governed = await trust(client, {
				dryRun: false,
				budget: 50_000,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: makeMockAudit(),
			});
			const tools = [callableTool(), callableFunctionTool()];
			const params = afcParams({ tools, automaticFunctionCalling: { disable: true } });

			const receipt = (await callModels(governed, method, params)) as TrustReceipt;

			expect(receipt.settled).toBe(true);
			const sdk =
				method === "generateContent" ? client.models.generateContent : generateContentStream;
			const received = sdk.mock.calls[0]?.[0] as Record<string, unknown>;
			const receivedTools = (received.config as Record<string, unknown>).tools as Array<
				Record<string, unknown>
			>;
			expect(receivedTools).not.toBe(tools);
			// each a fresh wrapper with the tool's prototype, its callTool delegating to the caller's, and
			// a hidden toJSON answering {}: no other caller property is reachable from the request
			for (const [i, wrapper] of receivedTools.entries()) {
				const tool = tools[i] as unknown as Record<string, unknown>;
				expect(wrapper).not.toBe(tool);
				expect(Object.getPrototypeOf(wrapper)).toBe(Object.getPrototypeOf(tool));
				expect(Object.keys(wrapper)).toEqual(["tool", "callTool"]);
				expect(JSON.stringify(wrapper)).toBe("{}");
				expect(tool.tool).not.toHaveBeenCalled();
				await (wrapper.callTool as (c: unknown[]) => Promise<unknown>)([]);
				expect(tool.callTool).toHaveBeenCalledOnce();
			}
			// the forward carries an owned disable: true, after the SDK's own decision of no AFC
			expect((received.config as Record<string, unknown>).automaticFunctionCalling).toEqual({
				disable: true,
			});
			await destroy(governed);
		});

		it(`${method}: a plain data-only request is governed, and the SDK receives plain data holding what the SDK reads of it`, async () => {
			const engine = makeMockEngine();
			const { client, generateContentStream } = makeGoogleClient();
			const governed = await trust(client, {
				dryRun: false,
				budget: 50_000,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: makeMockAudit(),
			});
			const params = afcParams({
				tools: [{ googleSearch: {} }],
				temperature: 0.2,
				automaticFunctionCalling: { maximumRemoteCalls: 3 },
			});

			const receipt = (await callModels(governed, method, params)) as TrustReceipt;

			expect(receipt.settled).toBe(true);
			const sdk =
				method === "generateContent" ? client.models.generateContent : generateContentStream;
			const received = sdk.mock.calls[0]?.[0] as Record<string, unknown>;
			// With no callable tool the SDK never reads maximumRemoteCalls, so the mirror does not carry it;
			// the single-call forward owns automaticFunctionCalling, with disable: true.
			expect(received).toEqual({
				...params,
				config: {
					tools: [{ googleSearch: {} }],
					temperature: 0.2,
					automaticFunctionCalling: { disable: true },
				},
			});
			expect(received).not.toBe(params);
			expect(received.config).not.toBe(params.config);
			expect((received.config as Record<string, unknown>).tools).not.toBe(
				(params.config as Record<string, unknown>).tools,
			);
			await destroy(governed);
		});
	}
});

// ── A pre-degraded audit writer under failClosed refuses before any Google gate ──

describe("audit.failClosed: a client already degraded refuses Google refusals before they run", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	/** A writer that is ALREADY degraded (as after an earlier failed write); appends are spied. */
	function degradedWriter() {
		const appendEvent = vi.fn(
			async (input: AppendEventInput): Promise<AuditEvent> => ({
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "b".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			}),
		);
		const writer: AuditWriter = {
			appendEvent,
			getWriteFailures: vi.fn(() => 1),
			isDegraded: vi.fn(() => true),
			flush: vi.fn(async () => {}),
			release: vi.fn(),
		};
		return { writer, appendEvent };
	}

	const CASES: Array<[string, (governed: unknown) => Promise<unknown>]> = [
		[
			"(a) a refused Google method",
			(governed) =>
				(
					governed as { models: { embedContent(p: unknown): Promise<unknown> } }
				).models.embedContent({
					model: "gemini-embedding-001",
				}),
		],
		[
			"(b) generateContent with a callable tool (the AFC refusal)",
			(governed) =>
				(
					governed as { models: { generateContent(p: unknown): Promise<unknown> } }
				).models.generateContent(afcParams({ tools: [callableTool()] })),
		],
		[
			"(b) generateContentStream with a callable tool (the AFC refusal)",
			(governed) =>
				(
					governed as { models: { generateContentStream(p: unknown): Promise<unknown> } }
				).models.generateContentStream(afcParams({ tools: [callableTool()] })),
		],
	];

	it.each(CASES)(
		"%s rejects with AuditDegradedError: no append, no hold, no SDK call",
		async (_, call) => {
			writeVaultConfig(tmpVault, { budget: 50_000, audit: { failClosed: true } });
			const engine = makeMockEngine();
			const { writer, appendEvent } = degradedWriter();
			const { client, spies, generateContentStream } = makeGoogleClient();
			const governed = await trust(client, {
				dryRun: false,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: writer,
			});

			const err = await call(governed).then(
				() => undefined,
				(e: unknown) => e,
			);

			expect(err).toBeInstanceOf(AuditDegradedError);
			expect(err).not.toBeInstanceOf(PolicyDeniedError);
			expect((err as Error).message).toContain("refused before it reached the provider");
			expect(appendEvent).not.toHaveBeenCalled();
			expect(engine.spendPending).not.toHaveBeenCalled();
			expect(spies.models.embedContent).not.toHaveBeenCalled();
			expect(client.models.generateContent).not.toHaveBeenCalled();
			expect(generateContentStream).not.toHaveBeenCalled();

			await destroy(governed);
		},
	);

	it("the AFC gate itself is not evaluated: no snapshot is built (a nested getter a clone would read never runs)", async () => {
		writeVaultConfig(tmpVault, { budget: 50_000, audit: { failClosed: true } });
		const { writer, appendEvent } = degradedWriter();
		const { client } = makeGoogleClient();
		const governed = await trust(client, { dryRun: true, vaultBase: tmpVault, _audit: writer });
		const nestedGetter = vi.fn(() => "x");
		const dataTool = {
			googleSearch: Object.defineProperty({}, "x", { get: nestedGetter, enumerable: true }),
		};

		const err = await governed.models.generateContent(afcParams({ tools: [dataTool] })).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(AuditDegradedError);
		expect(nestedGetter).not.toHaveBeenCalled();
		expect(appendEvent).not.toHaveBeenCalled();
		expect(client.models.generateContent).not.toHaveBeenCalled();

		await destroy(governed);
	});

	// generateContent with a callable tool is no longer a refusal (it runs the metered
	// per-round loop), so (c) covers the two refusals that remain.
	it.each(CASES.filter(([name]) => !name.startsWith("(b) generateContent with")))(
		"(c) failClosed OFF: %s is still the PolicyDeniedError it was",
		async (_, call) => {
			writeVaultConfig(tmpVault, { budget: 50_000, audit: { failClosed: false } });
			const engine = makeMockEngine();
			const { writer, appendEvent } = degradedWriter();
			const { client, generateContentStream } = makeGoogleClient();
			const governed = await trust(client, {
				dryRun: false,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: writer,
			});

			const err = await call(governed).then(
				() => undefined,
				(e: unknown) => e,
			);

			expect(err).toBeInstanceOf(PolicyDeniedError);
			expect(appendEvent).toHaveBeenCalledOnce();
			expect(appendEvent.mock.calls[0]?.[0].kind).toBe("policy_denied");
			expect(engine.spendPending).not.toHaveBeenCalled();
			expect(client.models.generateContent).not.toHaveBeenCalled();
			expect(generateContentStream).not.toHaveBeenCalled();

			await destroy(governed);
		},
	);
});

// ── A caller's OWN abort is an early stop (settle), not a failure (void) ──

interface AbortSpec {
	name: string;
	/** A client whose stream checks the CALLER's signal before each chunk after the first. */
	make: (failAfterFirst: boolean) => unknown;
	/** Open a governed stream, passing `signal` where this SDK takes it. */
	open: (governed: unknown, signal: AbortSignal) => Promise<GovernedStreamHandle>;
}

function abortableStream(
	chunks: unknown[],
	signal: AbortSignal | undefined,
	failAfterFirst: boolean,
): AsyncGenerator<unknown> {
	return (async function* () {
		for (let i = 0; i < chunks.length; i++) {
			if (i > 0 && signal?.aborted === true) {
				throw new DOMException("This operation was aborted", "AbortError");
			}
			if (i > 0 && failAfterFirst) throw new Error("provider 500 mid-stream");
			yield chunks[i];
		}
	})();
}

const OPENAI_CHUNKS = [
	{
		choices: [{ delta: { content: "Hi" } }],
		usage: { prompt_tokens: 1000, completion_tokens: 100 },
	},
	{ choices: [{ delta: { content: " there" } }] },
	{ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 300 } },
];
const ANTHROPIC_CHUNKS = [
	{ type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 0 } } },
	{ type: "content_block_delta", delta: { text: "Hi" } },
	{ type: "message_delta", usage: { output_tokens: 300 } },
];
const MESSAGES = [{ role: "user", content: "Hi" }];

const ABORT_SPECS: AbortSpec[] = [
	{
		name: "Google generateContentStream (config.abortSignal)",
		make: (fail) => ({
			models: {
				generateContent: vi.fn(async () => ({})),
				generateContentStream: vi.fn(async (p: { config?: { abortSignal?: AbortSignal } }) =>
					abortableStream(STREAM_WITH_USAGE, p.config?.abortSignal, fail),
				),
			},
		}),
		open: async (governed, signal) =>
			(await (
				governed as { models: { generateContentStream(p: unknown): Promise<unknown> } }
			).models.generateContentStream({
				model: "gemini-2.5-flash",
				contents: "Hi",
				config: { abortSignal: signal },
			})) as GovernedStreamHandle,
	},
	{
		name: "OpenAI chat.completions stream (options.signal)",
		make: (fail) => ({
			chat: {
				completions: {
					create: vi.fn(async (_p: unknown, o?: { signal?: AbortSignal }) =>
						abortableStream(OPENAI_CHUNKS, o?.signal, fail),
					),
				},
			},
		}),
		open: async (governed, signal) =>
			(
				await (
					governed as {
						chat: {
							completions: { create(p: unknown, o: unknown): Promise<{ response: unknown }> };
						};
					}
				).chat.completions.create({ model: "gpt-4o", messages: MESSAGES, stream: true }, { signal })
			).response as GovernedStreamHandle,
	},
	{
		name: "Anthropic messages.create stream (options.signal)",
		make: (fail) => ({
			messages: {
				create: vi.fn(async (_p: unknown, o?: { signal?: AbortSignal }) =>
					abortableStream(ANTHROPIC_CHUNKS, o?.signal, fail),
				),
			},
		}),
		open: async (governed, signal) =>
			(
				await (
					governed as {
						messages: { create(p: unknown, o: unknown): Promise<{ response: unknown }> };
					}
				).messages.create(
					{ model: "claude-sonnet-4-6", max_tokens: 64, messages: MESSAGES, stream: true },
					{ signal },
				)
			).response as GovernedStreamHandle,
	},
];

/** Read one chunk, abort through the caller's own signal, keep reading: the SDK's iterator throws. */
async function abortAfterFirstChunk(stream: GovernedStreamHandle, controller: AbortController) {
	let thrown: unknown;
	let seen = 0;
	try {
		for await (const _ of stream) {
			seen++;
			controller.abort();
		}
	} catch (err) {
		thrown = err;
	}
	return { thrown, seen };
}

describe("a caller's own abort settles the consumed usage, like an early break", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	it.each(ABORT_SPECS)(
		"$name: aborted mid-stream → settled at the consumed usage, no void, receipt settled",
		async (spec) => {
			const engine = makeMockEngine();
			const governed = await trust(spec.make(false), {
				dryRun: false,
				budget: 5_000_000,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: makeMockAudit(),
			});
			const controller = new AbortController();
			const stream = await spec.open(governed, controller.signal);

			const { thrown, seen } = await abortAfterFirstChunk(stream, controller);
			const receipt = await stream.receipt;

			// The SDK's abort error still reaches the caller...
			expect((thrown as Error).name).toBe("AbortError");
			expect(seen).toBe(1);
			// ...but the hold SETTLES at what was delivered: no void.
			expect(receipt.settled).toBe(true);
			expect(receipt.chunksDelivered).toBe(1);
			expect(engine.postPendingSpend).toHaveBeenCalledOnce();
			expect(engine.postPendingSpend).toHaveBeenCalledWith(receipt.transferId, receipt.cost);
			expect(engine.voidPendingSpend).not.toHaveBeenCalled();

			await destroy(governed);
		},
	);

	it.each(ABORT_SPECS)(
		"$name: a provider error mid-stream with the signal NOT aborted still VOIDS",
		async (spec) => {
			const engine = makeMockEngine();
			const governed = await trust(spec.make(true), {
				dryRun: false,
				budget: 5_000_000,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: makeMockAudit(),
			});
			const controller = new AbortController();
			const stream = await spec.open(governed, controller.signal);
			const receiptOutcome = stream.receipt.then(
				() => "resolved",
				(e: unknown) => e,
			);

			await expect(
				(async () => {
					for await (const _ of stream) {
						// consume
					}
				})(),
			).rejects.toThrow(/provider 500 mid-stream/);
			expect(controller.signal.aborted).toBe(false);
			expect(await receiptOutcome).toBeInstanceOf(Error);
			expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
			expect(engine.postPendingSpend).not.toHaveBeenCalled();

			await destroy(governed);
		},
	);

	it.each(ABORT_SPECS)(
		"$name: ten aborts in a row leave the breaker CLOSED, and the next call goes through",
		async (spec) => {
			const engine = makeMockEngine();
			const governed = await trust(spec.make(false), {
				dryRun: false,
				budget: 50_000_000,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: makeMockAudit(),
			});

			for (let i = 0; i < 10; i++) {
				const controller = new AbortController();
				const stream = await spec.open(governed, controller.signal);
				await abortAfterFirstChunk(stream, controller);
				await expect(stream.receipt).resolves.toMatchObject({ settled: true });
			}
			// The breaker (failureThreshold 5) never saw a failure: the 11th call is let through.
			const controller = new AbortController();
			const stream = await spec.open(governed, controller.signal);
			for await (const _ of stream) {
				// consume to the end
			}
			await expect(stream.receipt).resolves.toMatchObject({ settled: true });
			expect(engine.voidPendingSpend).not.toHaveBeenCalled();
			expect(engine.postPendingSpend).toHaveBeenCalledTimes(11);

			await destroy(governed);
		},
	);
});

// ── An own "__proto__" key in the request is plain data in the snapshot ──

describe('an own "__proto__" key in the request cannot make the snapshot inherit the caller\'s object', () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	function protoInAfc() {
		// JSON.parse makes "__proto__" an OWN property, pointing at { disable: true }.
		const afc = JSON.parse('{"__proto__": {"disable": true}}') as Record<string, unknown>;
		const params = afcParams({ tools: [callableTool()], automaticFunctionCalling: afc });
		// The OWN data property named "__proto__" (not the accessor on Object.prototype).
		const inherited = Object.getOwnPropertyDescriptor(afc, "__proto__")?.value as Record<
			string,
			unknown
		>;
		return { params, afc, inherited };
	}

	function protoInConfig() {
		const config = JSON.parse(
			'{"__proto__": {"automaticFunctionCalling": {"disable": true}}}',
		) as Record<string, unknown>;
		config.tools = [callableTool()];
		const params = { model: "gemini-2.5-flash", contents: "Look it up", config };
		return { params };
	}

	it("automaticFunctionCalling: the mirror's copy inherits no disable (the SDK never reads its own __proto__ key, so the mirror does not carry it)", async () => {
		const pipeline = await resolveGooglePipeline(new GoogleGenAI({ apiKey: "test" }), false);
		if (pipeline === undefined) throw new Error("the installed SDK's pipeline did not resolve");
		const { params } = protoInAfc();
		const snap = await snapshotGoogleRequest(pipeline, "generateContent", params);
		if (snap.kind !== "ok") throw new Error(`expected a mirror, got ${snap.kind}`);
		const config = (snap.params as Record<string, unknown>).config as Record<string, unknown>;
		const afc = config.automaticFunctionCalling as Record<string, unknown>;
		expect(Object.getPrototypeOf(afc)).toBe(Object.prototype);
		expect("disable" in afc).toBe(false);
		expect(Object.getOwnPropertyDescriptor(afc, "__proto__")).toBeUndefined();
		// the SDK decided on the caller's object as natively: AFC on (its own "__proto__" key is not a prototype)
		expect(snap.afcRan).toBe(true);
	});

	it("automaticFunctionCalling with __proto__ → { disable: true }, flipped afterwards: generateContent still runs the METERED loop", async () => {
		const engine = makeMockEngine();
		const { client } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});
		const { params, inherited } = protoInAfc();

		const pending = governed.models.generateContent(params);
		inherited.disable = false; // the flip: it must not matter, the gate decided on own data
		const out = (await pending) as unknown as { receipts?: unknown[] };

		// Decided on the snapshot's OWN data (no disable) → the governed per-round loop.
		expect(out.receipts).toHaveLength(1);
		const round = client.models.generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
		expect((round.config as Record<string, unknown>).automaticFunctionCalling).toMatchObject({
			disable: true,
		});
		await destroy(governed);
	});

	it("config with __proto__ → { automaticFunctionCalling: { disable: true } }: generateContent runs the metered loop", async () => {
		const { client } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});
		const { params } = protoInConfig();

		const out = (await governed.models.generateContent(params)) as unknown as {
			receipts?: unknown[];
		};

		expect(out.receipts).toHaveLength(1);
		await destroy(governed);
	});

	it("generateContentStream with __proto__ → { disable: true } in automaticFunctionCalling is refused (AFC, decided on own data)", async () => {
		const { client, generateContentStream } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});
		const { params } = protoInAfc();

		await expect(openStream(governed, params)).rejects.toThrow(
			/models.generateContentStream with automatic function calling is not governed yet/,
		);
		expect(generateContentStream).not.toHaveBeenCalled();
		await destroy(governed);
	});
});

// ── A #private-backed getter on a class-instance request ──

describe("a class-instance request with a #private-backed contents getter", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	class PrivateRequest {
		readonly #contents: string;
		readonly model = "gemini-2.5-flash";
		constructor(contents: string) {
			this.#contents = contents;
		}
		get contents(): string {
			return this.#contents;
		}
	}

	it("generateContent with no tools is governed, and the SDK receives the contents", async () => {
		const { client } = makeGoogleClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});

		const result = await governed.models.generateContent(
			new PrivateRequest("hello from a class") as unknown as Record<string, unknown>,
		);

		expect(result.receipt.settled).toBe(true);
		const sent = client.models.generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(sent.contents).toBe("hello from a class");
		await destroy(governed);
	});
});

// ── pii "redact": the caller's AbortSignal survives; nothing else is kept by reference ──

describe('pii "redact" keeps the caller\'s AbortSignal (and only that) by reference', () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	const EMAIL = "alice@example.com";

	async function redactingGoogle() {
		writeVaultConfig(tmpVault, { budget: 5_000_000, pii: "redact" });
		const engine = makeMockEngine();
		const received: Array<Record<string, unknown>> = [];
		const client = {
			models: {
				generateContent: vi.fn(async (p: Record<string, unknown>) => {
					received.push(p);
					return chunk("ok", {
						promptTokenCount: 10,
						candidatesTokenCount: 5,
						totalTokenCount: 15,
					});
				}),
				generateContentStream: vi.fn(
					async (p: Record<string, unknown> & { config?: { abortSignal?: AbortSignal } }) => {
						received.push(p);
						return abortableStream(STREAM_WITH_USAGE, p.config?.abortSignal, false);
					},
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});
		return { governed, engine, received };
	}

	it("Google stream: the SDK receives the SAME AbortSignal, the prompt redacted, and aborting it settles like a break", async () => {
		const { governed, engine, received } = await redactingGoogle();
		const controller = new AbortController();

		const stream = (await governed.models.generateContentStream({
			model: "gemini-2.5-flash",
			contents: `mail ${EMAIL} please`,
			config: { abortSignal: controller.signal },
		})) as GovernedStreamHandle;
		const sent = received[0] as { contents: unknown; config: { abortSignal: unknown } };
		expect(sent.config.abortSignal).toBe(controller.signal);
		expect(JSON.stringify(sent.contents)).not.toContain(EMAIL);

		const { thrown, seen } = await abortAfterFirstChunk(stream, controller);
		const receipt = await stream.receipt;
		expect((thrown as Error).name).toBe("AbortError");
		expect(seen).toBe(1);
		expect(receipt.settled).toBe(true);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await destroy(governed);
	});

	it("Google: config reached first under another key still reaches the SDK with the caller's AbortSignal", async () => {
		const { governed, received } = await redactingGoogle();
		const controller = new AbortController();
		const cfg = { abortSignal: controller.signal };

		await governed.models.generateContent({
			model: "gemini-2.5-flash",
			alias: cfg,
			contents: `mail ${EMAIL} please`,
			config: cfg,
		} as Record<string, unknown>);

		const sent = received[0] as { contents: unknown; config: { abortSignal: unknown } };
		expect(sent.config.abortSignal).toBe(controller.signal);
		expect(JSON.stringify(sent.contents)).not.toContain(EMAIL);
		await destroy(governed);
	});

	it("NO-REGRESSION: a class instance holding a PII string is NOT sent unredacted", async () => {
		const { governed, received } = await redactingGoogle();
		class Note {
			constructor(readonly text: string) {}
		}

		await governed.models.generateContent({
			model: "gemini-2.5-flash",
			contents: [{ role: "user", parts: [new Note(`mail ${EMAIL}`)] }],
		});

		expect(JSON.stringify(received[0])).not.toContain(EMAIL);
		await destroy(governed);
	});

	it("plain objects are still deep-cloned and redacted", async () => {
		const { governed, received } = await redactingGoogle();
		const contents = [{ role: "user", parts: [{ text: `mail ${EMAIL}` }] }];

		await governed.models.generateContent({ model: "gemini-2.5-flash", contents });

		const sent = received[0] as { contents: unknown };
		expect(sent.contents).not.toBe(contents);
		expect(JSON.stringify(sent)).not.toContain(EMAIL);
		await destroy(governed);
	});

	it("a Uint8Array in the request is still NOT forwarded by reference (today's behaviour, pinned: binary is not on the allowlist)", async () => {
		const { governed, received } = await redactingGoogle();
		const bytes = new Uint8Array([1, 2, 3]);

		await governed.models.generateContent({
			model: "gemini-2.5-flash",
			contents: [
				{ role: "user", parts: [{ text: `mail ${EMAIL}` }, { inlineData: { data: bytes } }] },
			],
		});

		const sent = received[0] as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
		const inline = (sent.contents[0] as { parts: Array<Record<string, unknown>> }).parts[1]
			?.inlineData as { data: unknown } | undefined;
		expect(inline).toBeDefined();
		expect(inline?.data).not.toBe(bytes);
		await destroy(governed);
	});

	it("a #private-backed contents getter holding an e-mail is captured ENUMERABLE, so the SDK receives it REDACTED", async () => {
		const { governed, received } = await redactingGoogle();
		class SecretRequest {
			readonly #contents: string;
			readonly model = "gemini-2.5-flash";
			constructor(contents: string) {
				this.#contents = contents;
			}
			get contents(): string {
				return this.#contents;
			}
		}

		await governed.models.generateContent(
			new SecretRequest(`mail ${EMAIL} please`) as unknown as Record<string, unknown>,
		);

		const sent = received[0] as Record<string, unknown>;
		expect(String(sent.contents)).toContain("[REDACTED");
		expect(JSON.stringify(sent)).not.toContain(EMAIL);
		await destroy(governed);
	});
});

// ── The caller's signal is captured when the call is made, before any await ──

function gatedAbortClient(kind: "openai" | "anthropic", failAfterFirst: boolean) {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let entered!: () => void;
	const providerEntered = new Promise<void>((r) => {
		entered = r;
	});
	// Like a real SDK, the provider takes the signal it was given at call time.
	const create = vi.fn(async (_p: unknown, o?: { signal?: AbortSignal }) => {
		const signal = o?.signal;
		entered();
		await gate;
		return abortableStream(
			kind === "openai" ? OPENAI_CHUNKS : ANTHROPIC_CHUNKS,
			signal,
			failAfterFirst,
		);
	});
	const client =
		kind === "openai" ? { chat: { completions: { create } } } : { messages: { create } };
	return { client, providerEntered, release };
}

async function openGated(
	kind: "openai" | "anthropic",
	governed: unknown,
	options: { signal?: AbortSignal },
): Promise<{ response: unknown }> {
	if (kind === "openai") {
		return (
			governed as {
				chat: { completions: { create(p: unknown, o: unknown): Promise<{ response: unknown }> } };
			}
		).chat.completions.create({ model: "gpt-4o", messages: MESSAGES, stream: true }, options);
	}
	return (
		governed as { messages: { create(p: unknown, o: unknown): Promise<{ response: unknown }> } }
	).messages.create(
		{ model: "claude-sonnet-4-6", max_tokens: 64, messages: MESSAGES, stream: true },
		options,
	);
}

describe("the caller's abort signal is captured at call time, before the provider await", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	const MUTATIONS: Array<[string, (o: { signal?: AbortSignal }) => void]> = [
		[
			"replaced with a fresh signal",
			(o) => {
				o.signal = new AbortController().signal;
			},
		],
		[
			"deleted",
			(o) => {
				delete o.signal;
			},
		],
	];

	for (const kind of ["openai", "anthropic"] as const) {
		it.each(MUTATIONS)(
			`${kind}: options.signal %s during the await, then the ORIGINAL is aborted → settled, no breaker failure`,
			async (_, mutate) => {
				const engine = makeMockEngine();
				const { client, providerEntered, release } = gatedAbortClient(kind, false);
				const governed = await trust(client, {
					dryRun: false,
					budget: 5_000_000,
					vaultBase: tmpVault,
					_engine: engine,
					_audit: makeMockAudit(),
				});
				const original = new AbortController();
				const options: { signal?: AbortSignal } = { signal: original.signal };

				const pending = openGated(kind, governed, options);
				await providerEntered;
				mutate(options);
				release();
				const stream = (await pending).response as GovernedStreamHandle;
				const { thrown } = await abortAfterFirstChunk(stream, original);
				const receipt = await stream.receipt;

				expect((thrown as Error).name).toBe("AbortError");
				expect(receipt.settled).toBe(true);
				expect(engine.postPendingSpend).toHaveBeenCalledOnce();
				expect(engine.voidPendingSpend).not.toHaveBeenCalled();
				await destroy(governed);
			},
		);

		it(`${kind}: options.signal replaced with an ALREADY-ABORTED signal during the await, then a provider error with the original NOT aborted → still VOIDS`, async () => {
			const engine = makeMockEngine();
			const { client, providerEntered, release } = gatedAbortClient(kind, true);
			const governed = await trust(client, {
				dryRun: false,
				budget: 5_000_000,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: makeMockAudit(),
			});
			const original = new AbortController();
			const options: { signal?: AbortSignal } = { signal: original.signal };

			const pending = openGated(kind, governed, options);
			await providerEntered;
			const replacement = new AbortController();
			replacement.abort();
			options.signal = replacement.signal;
			release();
			const stream = (await pending).response as GovernedStreamHandle;
			const receiptOutcome = stream.receipt.then(
				() => "resolved",
				(e: unknown) => e,
			);
			await expect(
				(async () => {
					for await (const _ of stream) {
						// consume
					}
				})(),
			).rejects.toThrow(/provider 500 mid-stream/);

			expect(original.signal.aborted).toBe(false);
			expect(await receiptOutcome).toBeInstanceOf(Error);
			expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
			expect(engine.postPendingSpend).not.toHaveBeenCalled();
			await destroy(governed);
		});
	}
});

// ── Refusing namespaces: keyed by path AND object; pass-through methods on the raw receiver ──

describe("Google refusing namespaces: aliases and raw receivers", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	async function rejection(p: Promise<unknown>): Promise<unknown> {
		return p.then(
			() => undefined,
			(e: unknown) => e,
		);
	}

	for (const order of ["chats first", "caches first"] as const) {
		it(`one object aliased as chats AND caches (${order}): each alias refuses its own list`, async () => {
			const shared = {
				create: vi.fn(async () => ({})),
				update: vi.fn(async () => ({})),
			};
			const client = {
				models: { generateContent: vi.fn(async () => ({})) },
				chats: shared,
				caches: shared,
			};
			const audit = makeMockAudit();
			const governed = (await trust(client, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
				_audit: audit,
			})) as unknown as {
				chats: { create(p?: unknown): Promise<unknown> };
				caches: { create(p?: unknown): Promise<unknown>; update(p?: unknown): Promise<unknown> };
				destroy(): Promise<void>;
			};

			// Touch the namespaces in the order under test.
			const first = order === "chats first" ? governed.chats : governed.caches;
			expect(first).toBeDefined();

			const update = await rejection(governed.caches.update({ name: "c" }));
			const create = await rejection(governed.caches.create({ model: "m" }));
			const chat = await rejection(governed.chats.create({ model: "m" }));

			expect((update as Error).message).toContain("caches.update is not governed");
			expect((create as Error).message).toContain("caches.create is not governed");
			expect((chat as Error).message).toContain("chats.create is not governed");
			expect(shared.update).not.toHaveBeenCalled();
			expect(shared.create).not.toHaveBeenCalled();
			expect(audit.events.map((e) => e.kind)).toEqual([
				"policy_denied",
				"policy_denied",
				"policy_denied",
			]);
			await governed.destroy();
		});
	}

	it("a free method that reads a #private field works through the governed client (raw receiver), with a stable identity", async () => {
		class CachesNamespace {
			readonly #client = "the raw client";
			async get(): Promise<string> {
				return this.#client;
			}
			async create(): Promise<unknown> {
				return {};
			}
		}
		class ModelsNamespace {
			readonly #tokens = 7;
			generateContent = vi.fn(async () => ({}));
			async countTokens(): Promise<{ totalTokens: number }> {
				return { totalTokens: this.#tokens };
			}
		}
		const client = { models: new ModelsNamespace(), caches: new CachesNamespace() };
		const governed = (await trust(client, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
		})) as unknown as {
			models: { countTokens(): Promise<{ totalTokens: number }> };
			caches: { get(): Promise<string> };
			destroy(): Promise<void>;
		};

		await expect(governed.caches.get()).resolves.toBe("the raw client");
		await expect(governed.models.countTokens()).resolves.toEqual({ totalTokens: 7 });
		expect(governed.caches.get).toBe(governed.caches.get);
		expect(governed.models.countTokens).toBe(governed.models.countTokens);
		await governed.destroy();
	});
});

// ── The caller-abort decision reads the BUILT-IN abort state ──

/** Like `abortableStream`, but the fake SDK reads the signal's real state, as the platform does. */
function brandAbortableStream(
	chunks: unknown[],
	signal: AbortSignal | undefined,
	failAfterFirst: boolean,
): AsyncGenerator<unknown> {
	const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
	return (async function* () {
		for (let i = 0; i < chunks.length; i++) {
			if (i > 0 && signal !== undefined && aborted?.call(signal) === true) {
				throw new DOMException("This operation was aborted", "AbortError");
			}
			if (i > 0 && failAfterFirst) throw new Error("provider 500 mid-stream");
			yield chunks[i];
		}
	})();
}

describe("the caller-abort decision reads the built-in abort state, not a decorated property", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	async function googleStream(signal: AbortSignal, failAfterFirst: boolean) {
		const engine = makeMockEngine();
		const client = {
			models: {
				generateContent: vi.fn(async () => ({})),
				generateContentStream: vi.fn(
					async (p: Record<string, unknown> & { config?: { abortSignal?: AbortSignal } }) =>
						brandAbortableStream(STREAM_WITH_USAGE, p.config?.abortSignal, failAfterFirst),
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});
		const stream = (await governed.models.generateContentStream({
			model: "gemini-2.5-flash",
			contents: "Hi",
			config: { abortSignal: signal },
		})) as GovernedStreamHandle;
		return { governed, engine, stream };
	}

	it("a real signal decorated with an own `aborted: false`, then really aborted → settled as a caller abort", async () => {
		const controller = new AbortController();
		Object.defineProperty(controller.signal, "aborted", { value: false });
		const { governed, engine, stream } = await googleStream(controller.signal, false);

		const { thrown } = await abortAfterFirstChunk(stream, controller);
		const receipt = await stream.receipt;

		expect((thrown as Error).name).toBe("AbortError");
		expect(receipt.settled).toBe(true);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await destroy(governed);
	});

	it("an own THROWING `aborted` getter, signal not aborted, provider error mid-stream → voids as a provider error (no bypass)", async () => {
		const controller = new AbortController();
		Object.defineProperty(controller.signal, "aborted", {
			get() {
				throw new Error("decorated getter");
			},
		});
		const { governed, engine, stream } = await googleStream(controller.signal, true);
		const receiptOutcome = stream.receipt.then(
			() => "resolved",
			(e: unknown) => e,
		);

		await expect(
			(async () => {
				for await (const _ of stream) {
					// consume
				}
			})(),
		).rejects.toThrow(/provider 500 mid-stream/);
		expect(await receiptOutcome).toBeInstanceOf(Error);
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();
		await destroy(governed);
	});

	it("an own THROWING `aborted` getter on a signal that IS aborted (built-in state) → settled as a caller abort", async () => {
		const controller = new AbortController();
		Object.defineProperty(controller.signal, "aborted", {
			get() {
				throw new Error("decorated getter");
			},
		});
		const { governed, engine, stream } = await googleStream(controller.signal, false);

		const { thrown } = await abortAfterFirstChunk(stream, controller);
		const receipt = await stream.receipt;

		expect((thrown as Error).name).toBe("AbortError");
		expect(receipt.settled).toBe(true);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await destroy(governed);
	});
});

// ── A callable tool is classified once; a later getter cannot unclassify it ──

describe("a later tool's getter that clears a callable's callTool cannot unmeter the SDK's AFC loop", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	/** The real @google/genai client: round 1 asks for a tool call, round 2 answers. */
	function toolCallingSdk() {
		const sdk = new GoogleGenAI({ apiKey: "test" });
		const sent: unknown[] = [];
		const reply = () => {
			const res = new GenerateContentResponse();
			const asksForTool = sent.length === 1;
			res.candidates = [
				{
					content: {
						role: "model",
						parts: asksForTool
							? [{ functionCall: { name: "lookup", args: { q: "a" } } }]
							: [{ text: "done" }],
					},
				},
			];
			res.usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };
			return res;
		};
		const models = sdk.models as unknown as Record<string, unknown>;
		models.generateContentInternal = async (p: unknown) => {
			sent.push(p);
			return reply();
		};
		models.generateContentStreamInternal = async (p: unknown) => {
			sent.push(p);
			const res = reply();
			return (async function* () {
				yield res;
			})();
		};
		return { sdk, sent };
	}

	function callableLookup() {
		return {
			tool: vi.fn(async () => ({ functionDeclarations: [{ name: "lookup" }] })),
			callTool: vi.fn(async () => [
				{ functionResponse: { name: "lookup", response: { ok: true } } },
			]),
		};
	}

	/** Clear `victim.callTool` now; put it back on a microtask, before the SDK reads the request. */
	function clearThenRestore(victim: { callTool: unknown }) {
		const saved = victim.callTool;
		victim.callTool = undefined;
		queueMicrotask(() => {
			victim.callTool = saved;
		});
	}

	const SHAPES: Array<[string, (victim: ReturnType<typeof callableLookup>) => unknown[]]> = [
		[
			"tools[1] is an array-index getter",
			(victim) => {
				const tools: unknown[] = [victim];
				Object.defineProperty(tools, 1, {
					get() {
						clearThenRestore(victim);
						return { googleSearch: {} };
					},
					enumerable: true,
				});
				return tools;
			},
		],
		[
			"tools[1] is a data tool whose nested getter structuredClone runs",
			(victim) => [
				victim,
				{
					googleSearch: Object.defineProperty({}, "x", {
						get() {
							clearThenRestore(victim);
							return 1;
						},
						enumerable: true,
					}),
				},
			],
		],
	];

	for (const method of AFC_METHODS) {
		it.each(SHAPES)(
			`${method}: %s → never one unmetered round: ${
				method === "generateContent"
					? "the SDK still loops on the restored tool, so the governed loop runs it, every round its own governed call, as natively"
					: "the native stream runs its loop (or sends a round, then fails on the cleared tool); the governed stream refuses before any request"
			}`,
			async (_, build) => {
				// natively, on the same SDK double, ungoverned
				const nativeSdk = toolCallingSdk();
				const nativeVictim = callableLookup();
				const nativeErr = await (method === "generateContent"
					? nativeSdk.sdk.models.generateContent(afcParams({ tools: build(nativeVictim) }) as never)
					: nativeSdk.sdk.models
							.generateContentStream(afcParams({ tools: build(nativeVictim) }) as never)
							.then(async (stream) => {
								for await (const _ of stream) {
									// drained
								}
							})
				).then(
					() => undefined,
					(e: unknown) => e,
				);

				const { sdk, sent } = toolCallingSdk();
				const victim = callableLookup();
				const audit = makeMockAudit();
				const governed = await trust(sdk, {
					dryRun: true,
					budget: 500_000,
					vaultBase: tmpVault,
					_audit: audit,
				});

				const err = await callModels(
					governed,
					method,
					afcParams({ tools: build(victim) }) as Record<string, unknown>,
				).then(
					() => undefined,
					(e: unknown) => e,
				);

				if (method === "generateContent") {
					// natively the SDK's own loop ran two rounds and called the restored tool once
					expect(nativeErr).toBeUndefined();
					expect(nativeSdk.sent).toHaveLength(2);
					expect(err).toBeUndefined();
					// governed: the same rounds, each one held, metered and audited
					expect(sent).toHaveLength(nativeSdk.sent.length);
					expect(audit.events.map((e) => e.kind)).toEqual(["llm_call", "llm_call"]);
					expect(victim.callTool.mock.calls.length).toBe(nativeVictim.callTool.mock.calls.length);
				} else {
					// natively the first round is SENT either way: the SDK then loops on the tool, or fails on it
					expect(nativeSdk.sent.length).toBeGreaterThan(0);
					expect(err).toBeInstanceOf(PolicyDeniedError);
					expect((err as Error).message).toContain(
						nativeErr === undefined
							? `models.${method} with automatic function calling is not governed yet`
							: `models.${method} could not be checked for automatic function calling`,
					);
					expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
					expect(sent).toHaveLength(0);
				}
				await destroy(governed);
			},
		);
	}
});

// ── An AbortSignal is kept by reference only at the transport slot ──

describe('pii "redact": an AbortSignal is kept only at config.abortSignal', () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	const EMAIL = "alice@example.com";

	it("a real AbortSignal with a non-enumerable toJSON (an e-mail) nested in functionResponse.response leaves nothing unredacted; config.abortSignal stays the same object and an abort still settles", async () => {
		writeVaultConfig(tmpVault, { budget: 5_000_000, pii: "redact" });
		const engine = makeMockEngine();
		const received: Array<Record<string, unknown>> = [];
		const client = {
			models: {
				generateContent: vi.fn(async () => ({})),
				generateContentStream: vi.fn(
					async (p: Record<string, unknown> & { config?: { abortSignal?: AbortSignal } }) => {
						received.push(p);
						return abortableStream(STREAM_WITH_USAGE, p.config?.abortSignal, false);
					},
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});
		const smuggler = new AbortController().signal;
		Object.defineProperty(smuggler, "toJSON", { value: () => `mail ${EMAIL}`, enumerable: false });
		const controller = new AbortController();

		const stream = (await governed.models.generateContentStream({
			model: "gemini-2.5-flash",
			contents: [
				{ role: "user", parts: [{ text: `mail ${EMAIL}` }] },
				{
					role: "user",
					parts: [{ functionResponse: { name: "lookup", response: { carrier: smuggler } } }],
				},
			],
			config: { abortSignal: controller.signal },
		})) as GovernedStreamHandle;

		const sent = received[0] as { config: { abortSignal: unknown } };
		expect(JSON.stringify(sent)).not.toContain(EMAIL);
		expect(sent.config.abortSignal).toBe(controller.signal);

		const { thrown } = await abortAfterFirstChunk(stream, controller);
		const receipt = await stream.receipt;
		expect((thrown as Error).name).toBe("AbortError");
		expect(receipt.settled).toBe(true);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await destroy(governed);
	});
});

// ── A pre-start return() returns what the native generator returns ──

describe("a governed stream's pre-start return(v) yields v, as a native return does", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	it("return(Promise.resolve(123)) before the first next() resolves { done: true, value: 123 }", async () => {
		const { client } = makeGoogleClient();
		const governed = await trust(client, { dryRun: true, budget: 50_000, vaultBase: tmpVault });
		const stream = await openStream(governed);

		await expect(stream.return(Promise.resolve(123) as never)).resolves.toEqual({
			done: true,
			value: 123,
		});
		await expect(stream.receipt).resolves.toMatchObject({ settled: true });
		await destroy(governed);
	});
});

// ── A pre-start return(rejected promise) still ends the hold ──

describe("a governed stream's pre-start return(Promise.reject(err)) rejects natively and still ends its hold", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	async function expectRejectedReturnEndsHold(
		governed: unknown,
		stream: GovernedStreamHandle,
		engine: TrustEngine,
	): Promise<void> {
		const err = new Error("rejected return value");
		await expect(stream.return(Promise.reject(err) as never)).rejects.toBe(err);
		const receipt = await stream.receipt;

		// Settled at the estimate, as any pre-start return(): nothing was consumed.
		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.chunksDelivered).toBe(0);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		// The in-flight stream count dropped: destroy() is not held to its 5 s deadline.
		const t0 = Date.now();
		await destroy(governed);
		expect(Date.now() - t0).toBeLessThan(1_000);
	}

	it("Google: rejects with the same error, settles at the estimate, .receipt resolves, destroy() does not wait", async () => {
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

		await expectRejectedReturnEndsHold(governed, stream, engine);
	});

	it("OpenAI chat.completions stream: rejects with the same error, settles at the estimate, .receipt resolves, destroy() does not wait", async () => {
		const engine = makeMockEngine();
		const { client } = makeOpenAIStreamClient();
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});
		const result = await governed.chat.completions.create({
			model: "gpt-4o",
			messages: [{ role: "user", content: "Hi" }],
			stream: true,
		});

		await expectRejectedReturnEndsHold(
			governed,
			result.response as unknown as GovernedStreamHandle,
			engine,
		);
	});
});
