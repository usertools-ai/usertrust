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
		await governed.caches.get();
		await governed.tunings.get();
		await governed.fileSearchStores.create();
		await governed.fileSearchStores.documents.list();
		expect(passThrough.countTokens).toHaveBeenCalledOnce();
		expect(passThrough.list).toHaveBeenCalledOnce();
		expect(passThrough.batchesList).toHaveBeenCalledOnce();
		expect(passThrough.interactionsGet).toHaveBeenCalledOnce();
		expect(passThrough.cachesGet).toHaveBeenCalledOnce();
		expect(passThrough.tuningsGet).toHaveBeenCalledOnce();
		expect(passThrough.fileSearchStoresCreate).toHaveBeenCalledOnce();
		expect(passThrough.documentsList).toHaveBeenCalledOnce();

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

describe("automatic function calling is refused on generateContent and generateContentStream", () => {
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
		["a raw MCP client in config.tools", () => ({ tools: [mcpClientTool()] })],
		[
			"a callable tool after a plain declaration-less tool",
			() => ({ tools: [{ googleSearch: {} }, callableTool()] }),
		],
		[
			"a valid maximumRemoteCalls (3)",
			() => ({ tools: [callableTool()], automaticFunctionCalling: { maximumRemoteCalls: 3 } }),
		],
	];

	for (const method of AFC_METHODS) {
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

	it("the SDK's own pre-request AFC errors are left to the SDK (governed path: hold, then void)", async () => {
		// A callable tool next to a non-callable tool with functionDeclarations: the SDK
		// throws "incompatible tools" before any request. That is the SDK's error, not ours.
		const engine = makeMockEngine();
		const { client, generateContentStream } = makeGoogleClient();
		generateContentStream.mockImplementationOnce(async () => {
			throw new Error("Incompatible tools found at tools[1].");
		});
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await expect(
			openStream(
				governed,
				afcParams({ tools: [callableTool(), { functionDeclarations: [{ name: "x" }] }] }),
			),
		).rejects.toThrow(/Incompatible tools/);
		expect(generateContentStream).toHaveBeenCalledOnce();
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();

		await destroy(governed);
	});

	it("config read through a getter is refused WITHOUT running the getter (fail closed)", async () => {
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
		const toolsGetter = vi.fn(() => [callableTool()]);
		const config = Object.defineProperty({}, "tools", { get: toolsGetter, enumerable: true });

		const err = await governed.models.generateContent(afcParams(config)).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(PolicyDeniedError);
		expect((err as Error).message).toContain(
			"models.generateContent could not be checked for automatic function calling",
		);
		expect(toolsGetter).not.toHaveBeenCalled();
		expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(client.models.generateContent).not.toHaveBeenCalled();

		await destroy(governed);
	});
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

describe("Proxy-backed AFC inputs are refused before anything is forwarded", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	/** A transparent Proxy: it lies about nothing, and is still refused. */
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
	];

	async function refusedWithoutSdk(
		method: (typeof AFC_METHODS)[number],
		params: Record<string, unknown>,
	): Promise<{ err: unknown; audit: ReturnType<typeof makeMockAudit> }> {
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
		const err = await callModels(governed, method, params).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(client.models.generateContent).not.toHaveBeenCalled();
		expect(generateContentStream).not.toHaveBeenCalled();
		await destroy(governed);
		return { err, audit };
	}

	for (const method of AFC_METHODS) {
		it.each(POSITIONS)(
			`${method}: a Proxy in %s → refused, audited, no hold, no SDK call`,
			async (at, params) => {
				const { err, audit } = await refusedWithoutSdk(method, params());

				expect(err).toBeInstanceOf(PolicyDeniedError);
				expect((err as Error).message).toContain(
					`models.${method} could not be checked for automatic function calling (a Proxy in ${at}); pass plain objects`,
				);
				expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
				expect((err as PolicyDeniedError).auditEventHash).toBe(audit.hashes[0]);
				expect(audit.events[0]?.data).toMatchObject({ actionName: `models.${method}` });
			},
		);

		it(`${method}: BYPASS — a params Proxy whose descriptor traps hide the callable tool its get trap returns is refused`, async () => {
			const shown = { tools: [] as unknown[] }; // what descriptor reads see: no tool
			const real = { tools: [callableTool()] }; // what the SDK's plain `get` would see
			const target = { model: "gemini-2.5-flash", contents: "Look it up", config: shown };
			const descriptorTrap = vi.fn((t: object, key: string | symbol) =>
				Reflect.getOwnPropertyDescriptor(t, key),
			);
			const params = new Proxy<Record<string, unknown>>(target, {
				getOwnPropertyDescriptor: descriptorTrap,
				getPrototypeOf: (t) => Reflect.getPrototypeOf(t),
				get: (t, key, receiver) => (key === "config" ? real : Reflect.get(t, key, receiver)),
			});

			const { err, audit } = await refusedWithoutSdk(method, params);

			expect(err).toBeInstanceOf(PolicyDeniedError);
			expect((err as Error).message).toContain("(a Proxy in params); pass plain objects");
			expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
			// The check never asked the Proxy anything.
			expect(descriptorTrap).not.toHaveBeenCalled();
		});

		it(`${method}: plain objects with no callable tool are governed (control)`, async () => {
			const engine = makeMockEngine();
			const { client, generateContentStream } = makeGoogleClient();
			const governed = await trust(client, {
				dryRun: false,
				budget: 50_000,
				vaultBase: tmpVault,
				_engine: engine,
				_audit: makeMockAudit(),
			});

			const receipt = (await callModels(
				governed,
				method,
				afcParams({ tools: [{ googleSearch: {} }], automaticFunctionCalling: {} }),
			)) as TrustReceipt;

			expect(receipt.settled).toBe(true);
			expect(engine.spendPending).toHaveBeenCalledOnce();
			const sdk =
				method === "generateContent" ? client.models.generateContent : generateContentStream;
			expect(sdk).toHaveBeenCalledOnce();

			await destroy(governed);
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

		it(`${method}: a non-callable tool that cannot be copied as data, with AFC enabled, is refused`, async () => {
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
			const params = afcParams({
				tools: [{ googleSearch: {} }, { googleSearch: {}, hook: () => 1 }],
			});

			const err = await callModels(governed, method, params).then(
				() => undefined,
				(e: unknown) => e,
			);

			expect(err).toBeInstanceOf(PolicyDeniedError);
			expect((err as Error).message).toContain(
				`models.${method} could not be checked for automatic function calling (params.config.tools[1] cannot be copied as data)`,
			);
			expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
			expect(engine.spendPending).not.toHaveBeenCalled();
			expect(client.models.generateContent).not.toHaveBeenCalled();
			expect(generateContentStream).not.toHaveBeenCalled();
			await destroy(governed);
		});

		it(`${method}: AFC disabled with callable tools is governed, and the SDK receives the same tool references`, async () => {
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
			const receivedTools = (received.config as Record<string, unknown>).tools as unknown[];
			expect(receivedTools).not.toBe(tools);
			expect(receivedTools[0]).toBe(tools[0]);
			expect(receivedTools[1]).toBe(tools[1]);
			await destroy(governed);
		});

		it(`${method}: a plain data-only request is governed, and the SDK receives an equal but not identical config`, async () => {
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
			expect(received).toEqual(params);
			expect(received).not.toBe(params);
			expect(received.config).not.toBe(params.config);
			expect((received.config as Record<string, unknown>).tools).not.toBe(
				(params.config as Record<string, unknown>).tools,
			);
			// Outside the AFC parts, the values are the caller's own (shallow copy).
			expect(received.contents).toBe(params.contents);
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

	it.each(CASES)(
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
