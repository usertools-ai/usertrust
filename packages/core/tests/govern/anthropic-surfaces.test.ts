// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Task 2 — Anthropic `messages.stream` + `beta.messages.*` interception.
 *
 * These surfaces previously bypassed governance entirely (detect.ts KNOWN-BYPASS
 * list). They are now brought inside the two-phase lifecycle:
 *   - A1: settle a `messages.stream()` MessageStream via its NON-CONSUMING event
 *     emitter (finalMessage → settle; error/abort → void). The caller's single
 *     async iterator is never touched.
 *   - A2: every terminal routes through the shared finalizeOnce gate — settle XOR
 *     void, exactly one ledger mutation (asserted by COUNT, not just balance).
 *   - A3: usage-extraction failure after a SUCCESSFUL stream settles at ESTIMATE,
 *     never voids.
 *   - A4: the MessageStream self-drives — a never-consumed stream still settles;
 *     the TB PENDING 300s timeout is the documented last-resort backstop.
 *   - A5: nested feature-detect; `stream` bound to the RAW messages target.
 *   - A9: the six-mode consumption matrix (iterate / finalMessage / both /
 *     never-consume / abort / abort-complete race).
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";

// ── TigerBeetle native-module mock (never loaded in unit tests) ──

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

// ── Fakes ──

interface FakeStreamOpts {
	/** Raw stream events emitted via `streamEvent` (message_start / message_delta / …). */
	events?: unknown[];
	/** The `finalMessage` payload (a Message with `.usage`). */
	final?: unknown;
	/** Emit `error` after this many streamEvents instead of completing. */
	errorAfter?: number;
	error?: Error;
	/** A9 mode 6: emit a late `abort` AFTER `finalMessage` (abort/complete race). */
	alsoAbortAfterFinal?: boolean;
	/**
	 * F6: emit `end` WITHOUT a preceding `finalMessage` — the real MessageStream's
	 * clean-SSE-close-without-message_stop shape (receivedMessages empty →
	 * `_emitFinal` emits nothing, only `end` fires).
	 */
	endWithoutFinal?: boolean;
	/**
	 * R1: milliseconds to wait BETWEEN streamEvents. Spacing events out lets the
	 * token-rate anomaly detector accumulate real per-window rates (a synchronous
	 * burst never trips it), so a runaway stream can trip a mid-stream governance abort.
	 */
	chunkDelayMs?: number;
}

/**
 * MessageStream-shaped fake: an event emitter + AsyncIterable that SELF-DRIVES on a
 * macrotask (mirrors the real helper, whose network I/O guarantees listeners
 * attached synchronously after construction are all in place before events fire).
 */
class FakeMessageStream extends EventEmitter {
	private readonly evs: unknown[];
	private readonly finalMsg: unknown;
	private readonly errorAfter: number | undefined;
	private readonly err: Error;
	private readonly alsoAbortAfterFinal: boolean;
	private readonly endWithoutFinal: boolean;
	private readonly chunkDelayMs: number;
	private aborted = false;
	private terminal = false;
	private readonly donePromise: Promise<unknown>;
	private doneResolve!: (v: unknown) => void;
	private doneReject!: (e: unknown) => void;

	constructor(opts: FakeStreamOpts = {}) {
		super();
		this.evs = opts.events ?? [];
		this.finalMsg = opts.final ?? { id: "msg_fake", usage: { input_tokens: 0, output_tokens: 0 } };
		this.errorAfter = opts.errorAfter;
		this.err = opts.error ?? new Error("Stream interrupted");
		this.alsoAbortAfterFinal = opts.alsoAbortAfterFinal ?? false;
		this.endWithoutFinal = opts.endWithoutFinal ?? false;
		this.chunkDelayMs = opts.chunkDelayMs ?? 0;
		this.donePromise = new Promise((res, rej) => {
			this.doneResolve = res;
			this.doneReject = rej;
		});
		this.donePromise.catch(() => {});
		// Self-drive on a macrotask so ALL listeners (governance + caller) attach first.
		setTimeout(() => void this.drive(), 0);
	}

	private async drive(): Promise<void> {
		if (this.aborted || this.terminal) return;
		let emitted = 0;
		for (const ev of this.evs) {
			if (this.aborted) return;
			if (this.errorAfter !== undefined && emitted >= this.errorAfter) {
				this.terminal = true;
				this.emit("error", this.err);
				this.doneReject(this.err);
				this.emit("end");
				return;
			}
			this.emit("streamEvent", ev, {});
			emitted++;
			// A governance abort inside the streamEvent handler flips `aborted` — bail
			// before the next delay so we don't emit past a mid-stream cutoff.
			if (this.chunkDelayMs > 0 && !this.aborted) {
				await new Promise<void>((r) => setTimeout(r, this.chunkDelayMs));
			}
		}
		if (this.aborted) return;
		this.terminal = true;
		if (this.endWithoutFinal) {
			// F6: clean close, no finalMessage — only `end` fires (endPromise resolves).
			this.doneResolve(undefined);
			this.emit("end");
			return;
		}
		this.emit("finalMessage", this.finalMsg);
		this.doneResolve(this.finalMsg);
		this.emit("end");
		if (this.alsoAbortAfterFinal) {
			// A9 mode 6: a late abort must NOT void an already-settled hold.
			this.emit("abort", new Error("late abort"));
		}
	}

	abort(): void {
		if (this.terminal || this.aborted) {
			// Already terminal — still emit to exercise the finalizeOnce dedup path.
			this.emit("abort", new Error("aborted"));
			return;
		}
		this.aborted = true;
		this.terminal = true;
		const e = new Error("aborted");
		this.emit("abort", e);
		this.doneReject(e);
		this.emit("end");
	}

	finalMessage(): Promise<unknown> {
		return this.donePromise;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
		for (const ev of this.evs) yield ev;
	}
}

function makeTmpVault(): string {
	const dir = join(tmpdir(), `anthropic-surfaces-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeMockEngine(overrides?: Partial<TrustEngine>): TrustEngine {
	return {
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => ({
			transferId: p.transferId,
		})),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
		...overrides,
	};
}

function makeMockAudit(): AuditWriter {
	return {
		appendEvent: vi.fn(
			async (input: AppendEventInput): Promise<AuditEvent> => ({
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			}),
		),
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

const PROVIDER_EVENTS = [
	{ type: "message_start", message: { usage: { input_tokens: 100 } } },
	{ type: "content_block_delta", delta: { text: "Hi" } },
	{ type: "message_delta", usage: { output_tokens: 20 } },
];
const PROVIDER_FINAL = { id: "msg_1", usage: { input_tokens: 100, output_tokens: 30 } };

/**
 * Let the self-driven stream + async governance settlement fully complete.
 *
 * This is a WALL-CLOCK budget, not a tick count, and these cases run with
 * `dryRun: false` against a real temp vault — so the settle path does real disk
 * I/O (`persistSpendLedger`) BEFORE it calls `postPendingSpend`, which is what
 * the assertions here count. The budget therefore has to cover an fsync, and
 * fsync latency spikes by an order of magnitude on a loaded machine.
 *
 * Measured on APFS/SSD: the settle-path write costs ~0.2ms without fsync and
 * ~5.6ms with the file + directory fsync that durability requires. The old 40ms
 * default cleared that by a hair when idle and failed intermittently under
 * parallel load, surfacing as "never-consume → settle exactly once" seeing zero
 * calls. Raised to 400ms for real headroom: these are timing floors, not
 * timing assertions, so a generous budget costs a few seconds of suite time and
 * buys determinism.
 */
async function flush(ms = 400): Promise<void> {
	await new Promise<void>((r) => setTimeout(r, ms));
}

const STREAM_PARAMS = {
	model: "claude-sonnet-4-6",
	max_tokens: 1024,
	messages: [{ role: "user", content: "Hello" }],
};

// ── Tests ──

describe("Anthropic messages.stream governance (A1/A2)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("authorizes then settles at final provider usage", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(
					() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as FakeMessageStream & {
			receipt: Promise<TrustReceipt>;
		};
		const receipt = await stream.receipt;

		// Authorize placed exactly one PENDING hold; settle POSTed exactly once; no void.
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.chunksDelivered).toBe(3);
		expect(receipt.cost).toBeGreaterThan(0);

		await governed.destroy();
	});

	it("VOIDs the hold on a mid-stream error (never posts)", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(() => new FakeMessageStream({ events: PROVIDER_EVENTS, errorAfter: 2 })),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const stream = await governed.messages.stream(STREAM_PARAMS);
		void (stream as { receipt: Promise<TrustReceipt> }).receipt.catch(() => {});
		await flush();

		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("binds the original stream to the RAW messages target (A5)", async () => {
		let capturedThis: unknown;
		const rawMessages = {
			create: vi.fn(),
			stream(this: unknown, _body: unknown): FakeMessageStream {
				capturedThis = this;
				return new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL });
			},
		};
		const client = { messages: rawMessages };
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			receipt: Promise<TrustReceipt>;
		};
		await stream.receipt;

		// The helper's `this` must be the un-proxied messages object, NOT the proxy —
		// so its internal messages.create({stream:true}) never re-enters the governed
		// create trap (avoids the .withResponse() re-entrancy break).
		expect(capturedThis).toBe(rawMessages);

		await governed.destroy();
	});
});

describe("Anthropic beta.messages governance (A5)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("governs beta.messages.create identically to stable create", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: { create: vi.fn(), stream: vi.fn() },
			beta: {
				messages: {
					create: vi.fn(async () => ({
						id: "beta_msg",
						usage: { input_tokens: 200, output_tokens: 50 },
					})),
					stream: vi.fn(),
				},
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const result = await (
			governed as unknown as {
				beta: { messages: { create: (p: unknown) => Promise<{ receipt: TrustReceipt }> } };
			}
		).beta.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 256,
			messages: [{ role: "user", content: "Hi" }],
		});

		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(result.receipt.settled).toBe(true);
		expect(result.receipt.usageSource).toBe("provider");
		expect(result.receipt.cost).toBeGreaterThan(0);

		await governed.destroy();
	});

	it("governs beta.messages.stream via the emitter path", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: { create: vi.fn(), stream: vi.fn() },
			beta: {
				messages: {
					create: vi.fn(),
					stream: vi.fn(
						() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
					),
				},
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const stream = (await (
			governed as unknown as {
				beta: { messages: { stream: (p: unknown) => Promise<unknown> } };
			}
		).beta.messages.stream(STREAM_PARAMS)) as { receipt: Promise<TrustReceipt> };
		const receipt = await stream.receipt;

		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(receipt.usageSource).toBe("provider");

		await governed.destroy();
	});
});

describe("Anthropic surfaces feature-detection (A5)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("wraps a client WITHOUT beta/stream; create still works; absent surfaces stay raw", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(async () => ({ id: "m", usage: { input_tokens: 10, output_tokens: 5 } })),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: [{ role: "user", content: "Hi" }],
		});
		expect(result.receipt.settled).toBe(true);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();

		// Absent surfaces fall through to the raw (undefined) properties — never
		// synthesized. `stream` is not a function, `beta` is absent.
		expect(
			(governed as unknown as { messages: { stream?: unknown } }).messages.stream,
		).toBeUndefined();
		expect((governed as unknown as { beta?: unknown }).beta).toBeUndefined();

		await governed.destroy();
	});

	it("wraps a client with stream but no beta", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(
					() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		expect((governed as unknown as { beta?: unknown }).beta).toBeUndefined();
		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			receipt: Promise<TrustReceipt>;
		};
		await stream.receipt;
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();

		await governed.destroy();
	});
});

describe("A3 — success with unknown usage settles at estimate, never voids", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("finalMessage without a usage object → usageSource 'estimated', settled", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(
					() =>
						new FakeMessageStream({
							// No message_start/message_delta usage, and a final message with no usage.
							events: [{ type: "content_block_delta", delta: { text: "Hi" } }],
							final: { id: "no_usage_msg" },
						}),
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			receipt: Promise<TrustReceipt>;
		};
		const receipt = await stream.receipt;

		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.cost).toBeGreaterThan(1);
		// A successful-but-usage-less stream is a billable success — never a void.
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});
});

describe("A4 — self-driven settlement without consumption (no leak)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("a never-consumed stream still settles via its self-driven terminal event", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(
					() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		// Caller never iterates and never calls finalMessage(); it does not even read
		// `.receipt`. The MessageStream self-drives, so governance still settles and
		// the hold is released (the TB PENDING 300s timeout is the documented backstop
		// for a hold whose terminal event never arrives).
		await governed.messages.stream(STREAM_PARAMS);
		await flush();

		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});
});

describe("A9 — ledger-mutation count across the six-mode consumption matrix", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	async function makeGoverned(streamFactory: () => FakeMessageStream) {
		const engine = makeMockEngine();
		const client = {
			messages: { create: vi.fn(), stream: vi.fn(streamFactory) },
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});
		return { engine, governed };
	}

	it("iterate-only → settle exactly once", async () => {
		const { engine, governed } = await makeGoverned(
			() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
		);
		const stream = (await governed.messages.stream(STREAM_PARAMS)) as AsyncIterable<unknown> & {
			receipt: Promise<TrustReceipt>;
		};
		const seen: unknown[] = [];
		for await (const ev of stream) seen.push(ev);
		await stream.receipt;

		expect(seen).toHaveLength(3);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await governed.destroy();
	});

	it("finalMessage-only → settle exactly once", async () => {
		const { engine, governed } = await makeGoverned(
			() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
		);
		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			finalMessage: () => Promise<unknown>;
			receipt: Promise<TrustReceipt>;
		};
		await stream.finalMessage();
		await stream.receipt;

		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await governed.destroy();
	});

	it("iterate + finalMessage → settle exactly once", async () => {
		const { engine, governed } = await makeGoverned(
			() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
		);
		const stream = (await governed.messages.stream(STREAM_PARAMS)) as AsyncIterable<unknown> & {
			finalMessage: () => Promise<unknown>;
			receipt: Promise<TrustReceipt>;
		};
		for await (const _ of stream) {
			// consume
		}
		await stream.finalMessage();
		await stream.receipt;

		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await governed.destroy();
	});

	it("never-consume → settle exactly once", async () => {
		const { engine, governed } = await makeGoverned(
			() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
		);
		await governed.messages.stream(STREAM_PARAMS);
		await flush();

		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await governed.destroy();
	});

	it("caller abort → settle partial exactly once, never voids (F9)", async () => {
		// F9: a consumer abort is an early EXIT, not a provider failure — it settles the
		// partial usage rather than voiding the hold (mirroring the generic
		// break-out-of-for-await path). Exactly one ledger mutation, and it's a POST.
		const { engine, governed } = await makeGoverned(
			() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
		);
		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			abort: () => void;
			receipt: Promise<TrustReceipt>;
		};
		stream.abort();
		const receipt = await stream.receipt;
		await flush();

		expect(receipt.settled).toBe(true);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await governed.destroy();
	});

	it("abort/complete race (late abort after finalMessage) → settle once, never voids", async () => {
		const { engine, governed } = await makeGoverned(
			() =>
				new FakeMessageStream({
					events: PROVIDER_EVENTS,
					final: PROVIDER_FINAL,
					alsoAbortAfterFinal: true,
				}),
		);
		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			receipt: Promise<TrustReceipt>;
		};
		await stream.receipt;
		await flush();

		// finalizeOnce: the finalMessage settle claimed the gate first, so the late
		// abort's own settle attempt is refused — still exactly one POST, never a void.
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await governed.destroy();
	});
});

describe("A3 fallback — stream() returns a NON-emitter (feature-detect miss)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("settles at estimate and exposes the settled receipt via `.receipt`", async () => {
		const engine = makeMockEngine();
		// An SDK too old to return an event-emitter MessageStream: stream() hands back
		// a plain object with NO `.on`. The stream-helper surface can't tap emitter
		// events, so it must settle the hold at ESTIMATE now AND still attach a live
		// `.receipt` the caller can await — the receipt must not stay frozen at the
		// synchronous estimate handle (the regression this guards).
		const nonEmitter: { notAnEmitter: true; receipt?: Promise<TrustReceipt> } = {
			notAnEmitter: true,
		};
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(() => nonEmitter),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as typeof nonEmitter & {
			receipt: Promise<TrustReceipt>;
		};

		// `.receipt` is attached on the non-emitter branch (previously omitted) and
		// resolves with the SETTLED receipt, not the frozen estimate handle.
		expect(stream.receipt).toBeInstanceOf(Promise);
		const receipt = await stream.receipt;

		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.chunksDelivered).toBe(0);
		expect(receipt.cost).toBeGreaterThan(0);

		// Exactly ONE ledger mutation: authorize placed the hold, settle POSTed once,
		// never a void.
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		// inFlightStreamCount was released: destroy() drains promptly rather than
		// spinning to its 5s deadline.
		await flush();
		const startedAt = Date.now();
		await governed.destroy();
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});
});

describe("F3 — finalMessage per-field usage merge (partial usage keeps accumulated counters)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	async function streamReceipt(opts: FakeStreamOpts): Promise<TrustReceipt> {
		const engine = makeMockEngine();
		const client = {
			messages: { create: vi.fn(), stream: vi.fn(() => new FakeMessageStream(opts)) },
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});
		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			receipt: Promise<TrustReceipt>;
		};
		const receipt = await stream.receipt;
		await governed.destroy();
		return receipt;
	}

	it("a finalMessage with output_tokens: null keeps the 2000 output accumulated from streamEvent", async () => {
		// streamEvents accumulate 500 input / 2000 output.
		const ACC_EVENTS = [
			{ type: "message_start", message: { usage: { input_tokens: 500 } } },
			{ type: "message_delta", usage: { output_tokens: 2000 } },
		];

		// finalMessage reports input but a NULL output — the accumulated 2000 output
		// must survive the per-field merge (the bug zeroed it → settled 500/0).
		const merged = await streamReceipt({
			events: ACC_EVENTS,
			final: { id: "m", usage: { input_tokens: 500, output_tokens: null } },
		});
		// Authoritative target: a finalMessage carrying the FULL 500/2000.
		const full = await streamReceipt({
			events: ACC_EVENTS,
			final: { id: "m", usage: { input_tokens: 500, output_tokens: 2000 } },
		});
		// What the bug produced: a genuine 500/0 settle (no accumulated output).
		const zeroed = await streamReceipt({
			events: [{ type: "message_start", message: { usage: { input_tokens: 500 } } }],
			final: { id: "m", usage: { input_tokens: 500, output_tokens: 0 } },
		});

		expect(merged.usageSource).toBe("provider");
		// Merged prices identically to the full 500/2000 report...
		expect(merged.cost).toBe(full.cost);
		// ...and strictly above the 500/0 the bug would have settled.
		expect(merged.cost).toBeGreaterThan(zeroed.cost);
	});

	it("a finalMessage with input_tokens: null keeps the accumulated input counter", async () => {
		const ACC_EVENTS = [
			{ type: "message_start", message: { usage: { input_tokens: 500 } } },
			{ type: "message_delta", usage: { output_tokens: 2000 } },
		];
		// Mirror case: null INPUT field, real output — accumulated 500 input survives.
		const merged = await streamReceipt({
			events: ACC_EVENTS,
			final: { id: "m", usage: { input_tokens: null, output_tokens: 2000 } },
		});
		const full = await streamReceipt({
			events: ACC_EVENTS,
			final: { id: "m", usage: { input_tokens: 500, output_tokens: 2000 } },
		});

		expect(merged.usageSource).toBe("provider");
		expect(merged.cost).toBe(full.cost);
	});
});

describe("F6 — clean 'end' with no finalMessage settles at estimate (no dangling hold)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("settles once at estimate and releases the hold when only 'end' fires", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				// message_start + a delta, then a CLEAN close with NO finalMessage (no
				// message_stop) — the real MessageStream emits only 'end' here.
				stream: vi.fn(
					() => new FakeMessageStream({ events: PROVIDER_EVENTS, endWithoutFinal: true }),
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			receipt: Promise<TrustReceipt>;
		};
		const receipt = await stream.receipt;

		// The 'end' catch-all settles at ESTIMATE (never voids), so the hold releases.
		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("estimated");
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		// No leak: destroy drains promptly rather than spinning to its 5s deadline.
		await flush();
		const startedAt = Date.now();
		await governed.destroy();
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});
});

describe("F9 — consumer aborts do not trip the circuit breaker", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("five consecutive aborts settle partial and leave the breaker CLOSED", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(
					() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
				),
			},
		};
		// Budget generous enough for 5 aborted (estimate-settled) streams + a 6th.
		const governed = await trust(client, {
			dryRun: false,
			budget: 1_000_000_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		// The default circuit-breaker failureThreshold is 5. Under the old behavior each
		// abort recorded a FAILURE, so the 5th would open the breaker and the 6th
		// stream() would throw CircuitOpenError. F9 settles aborts as successes.
		for (let i = 0; i < 5; i++) {
			const s = (await governed.messages.stream(STREAM_PARAMS)) as {
				abort: () => void;
				receipt: Promise<TrustReceipt>;
			};
			s.abort();
			await s.receipt;
			await flush();
		}

		// Breaker still closed: a 6th stream authorizes and settles normally.
		const sixth = (await governed.messages.stream(STREAM_PARAMS)) as {
			receipt: Promise<TrustReceipt>;
		};
		const receipt = await sixth.receipt;
		expect(receipt.settled).toBe(true);

		// Every abort settled (POSTed); none voided.
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(engine.postPendingSpend).toHaveBeenCalledTimes(6);

		await governed.destroy();
	});
});

describe("F4 — messages.parse / beta.messages.parse are governed (no crash, settle once)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	const RAW_MESSAGE = {
		id: "msg_parse",
		type: "message",
		role: "assistant",
		content: [{ type: "text", text: '{"answer":42}' }],
		usage: { input_tokens: 30, output_tokens: 12 },
	};

	// The SDK's real parse() is `create(params).then(parseMessage)`; when create is the
	// governed proxy it returns a { response, receipt } wrapper the SDK parser crashes
	// on. A raw parse() that mirrors the SDK exercises exactly that path.
	function makeClientWithParse() {
		const rawCreate = vi.fn(async () => RAW_MESSAGE);
		const rawParse = vi.fn(function (
			this: { create: (p: unknown) => Promise<unknown> },
			params: unknown,
		) {
			return this.create(params).then((m) => {
				// The SDK's parseMessage would do `(m as Message).content.map(...)` here.
				(m as { content: unknown[] }).content.map((b) => b);
				return m;
			});
		});
		const messages = { create: rawCreate, stream: vi.fn(), parse: rawParse };
		const client: Record<string, unknown> = {
			messages,
			beta: { messages: { create: rawCreate, stream: vi.fn(), parse: rawParse } },
		};
		return client;
	}

	const PARSE_PARAMS = {
		model: "claude-sonnet-4-6",
		max_tokens: 256,
		messages: [{ role: "user", content: "Give me the answer." }],
		output_config: { format: { type: "json_schema", parse: (c: string) => JSON.parse(c) } },
	};

	it("stable messages.parse returns a parsed Message with a receipt and settles once", async () => {
		const engine = makeMockEngine();
		const governed = await trust(makeClientWithParse(), {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const parsed = (await (
			governed as unknown as {
				messages: { parse: (p: unknown) => Promise<Record<string, unknown>> };
			}
		).messages.parse(PARSE_PARAMS)) as {
			content: { type: string; text: string }[];
			parsed_output: unknown;
			receipt: TrustReceipt;
		};

		// A real SDK-shaped Message (NOT a { response, receipt } wrapper).
		expect(Array.isArray(parsed.content)).toBe(true);
		expect(parsed.content[0].text).toBe('{"answer":42}');
		// The structured-output transform ran (caller-provided format.parse).
		expect(parsed.parsed_output).toEqual({ answer: 42 });
		// The governed create settled exactly once and the receipt rode along.
		expect(parsed.receipt.settled).toBe(true);
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("beta.messages.parse is governed identically (no crash, settle once)", async () => {
		const engine = makeMockEngine();
		const governed = await trust(makeClientWithParse(), {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const parsed = (await (
			governed as unknown as {
				beta: { messages: { parse: (p: unknown) => Promise<Record<string, unknown>> } };
			}
		).beta.messages.parse(PARSE_PARAMS)) as {
			content: { type: string; text: string }[];
			parsed_output: unknown;
			receipt: TrustReceipt;
		};

		expect(parsed.content[0].text).toBe('{"answer":42}');
		expect(parsed.parsed_output).toEqual({ answer: 42 });
		expect(parsed.receipt.settled).toBe(true);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});
});

describe("F8 — governance never silently swallows a stream failure", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("a consumer awaiting `.receipt` sees a genuine mid-stream error (rejection)", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(
					() =>
						new FakeMessageStream({
							events: PROVIDER_EVENTS,
							errorAfter: 2,
							error: new Error("boom upstream"),
						}),
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			receipt: Promise<TrustReceipt>;
		};

		// The error is NOT swallowed: awaiting `.receipt` rejects with the provider error.
		await expect(stream.receipt).rejects.toThrow(/boom upstream/);
		// A genuine failure voids (never posts).
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("the happy path still resolves `.receipt` to a settled receipt", async () => {
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(
					() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			receipt: Promise<TrustReceipt>;
		};
		await expect(stream.receipt).resolves.toMatchObject({ settled: true });

		await governed.destroy();
	});
});

describe("R1 — anomaly cutoff on messages.stream matches the generic path (void + breaker failure)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	// Anomaly opts only travel through the config file (TrustOpts has no anomaly
	// field). Low token-rate thresholds so a runaway stream trips immediately.
	function writeAnomalyConfig(vaultBase: string): void {
		const dir = join(vaultBase, VAULT_DIR);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "usertrust.config.json"),
			JSON.stringify({
				budget: 50_000_000,
				anomaly: {
					enabled: true,
					tokenRate: { thresholdTokPerSec: 10, windowMs: 100, consecutiveWindows: 1 },
					spendVelocity: { thresholdDollarsPerMin: 1_000_000 },
					injectionCascade: { eventCount: 1_000_000 },
					cooldownMs: 60_000,
				},
			}),
		);
	}

	// A runaway stream: 1000 output tokens per delta, spaced 30ms apart so multiple
	// 100ms token-rate windows complete and trip the detector mid-stream.
	function runawayEvents(): unknown[] {
		const evs: unknown[] = [{ type: "message_start", message: { usage: { input_tokens: 50 } } }];
		let cumulative = 0;
		for (let i = 0; i < 12; i++) {
			cumulative += 1000;
			evs.push({ type: "content_block_delta", delta: { text: "x".repeat(1000) } });
			evs.push({ type: "message_delta", usage: { output_tokens: cumulative } });
		}
		return evs;
	}

	it("a token-rate anomaly mid-stream VOIDs the hold and records a breaker FAILURE", async () => {
		writeAnomalyConfig(tmpVault);
		const engine = makeMockEngine();
		const audit = makeMockAudit();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(() => new FakeMessageStream({ events: runawayEvents(), chunkDelayMs: 30 })),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: audit,
		});

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			receipt: Promise<TrustReceipt>;
		};
		void stream.receipt.catch(() => {});

		// Wait for the self-driven runaway stream to trip the anomaly + void the hold.
		const deadline = Date.now() + 3_000;
		while (
			(engine.voidPendingSpend as ReturnType<typeof vi.fn>).mock.calls.length === 0 &&
			Date.now() < deadline
		) {
			await flush(30);
		}

		// Same outcome as the generic createGovernedStream anomaly path: VOID once, never
		// POST — the containment + breaker-failure signal is NOT lost on messages.stream.
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();

		// The anomaly was detected + audited.
		const calls = (audit.appendEvent as ReturnType<typeof vi.fn>).mock.calls as Array<
			[AppendEventInput]
		>;
		expect(calls.some(([e]) => e.kind === "anomaly_detected")).toBe(true);

		await governed.destroy();
	});
});

// ── Cache tiers through the MessageStream accumulator (spec D2/D4, govern.ts:1561) ──

describe("cache tiers survive the MessageStream accumulator", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	/** claude-sonnet-4-6: input 30 / output 150 / cacheRead 3 / cacheWrite 37.5 per 1k. */
	const CACHE_EVENTS = [
		{
			type: "message_start",
			message: {
				usage: {
					input_tokens: 100,
					cache_read_input_tokens: 9_000,
					cache_creation_input_tokens: 1_000,
				},
			},
		},
		{ type: "content_block_delta", delta: { text: "Hi" } },
		{ type: "message_delta", usage: { output_tokens: 200 } },
	];

	it("prices all four tiers from the streamEvent tap alone (no finalMessage usage)", async () => {
		// Pre-fix: 3 + 30 = 33 usertokens, cache severed at zero.
		// Post-fix: 33 + (9000/1000)*3 + (1000/1000)*37.5 = 33 + 27 + 37.5 = 97.5 → 98.
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(
					() =>
						new FakeMessageStream({
							events: CACHE_EVENTS,
							// finalMessage carries only the two headline counters — the cache
							// tiers must still come from the accumulated streamEvent tap (F3).
							final: { id: "msg_c", usage: { input_tokens: 100, output_tokens: 200 } },
						}),
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

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as FakeMessageStream & {
			receipt: Promise<TrustReceipt>;
		};
		const receipt = await stream.receipt;

		expect(receipt.usageSource).toBe("provider");
		expect(receipt.cost).toBe(98);
		expect(receipt.cost).not.toBe(33);

		await governed.destroy();
	});

	it("prefers the finalMessage cache counters over the accumulated ones", async () => {
		// finalMessage is the authoritative total: 12000 read, 0 write.
		// 3 + 30 + (12000/1000)*3 = 69.
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(
					() =>
						new FakeMessageStream({
							events: CACHE_EVENTS,
							final: {
								id: "msg_c2",
								usage: {
									input_tokens: 100,
									output_tokens: 200,
									cache_read_input_tokens: 12_000,
									cache_creation_input_tokens: 0,
								},
							},
						}),
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

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as FakeMessageStream & {
			receipt: Promise<TrustReceipt>;
		};
		const receipt = await stream.receipt;

		expect(receipt.cost).toBe(69);

		await governed.destroy();
	});

	it("keeps an accumulated WRITE tier when finalMessage names only the READ tier (F3 per tier)", async () => {
		// F3 applies per tier, separately. A finalMessage that reports the read
		// counter but omits the write counter must NOT zero the 1000 write tokens the
		// streamEvent tap already saw — they were billed.
		// 3 + 30 + (9000/1000)*3 + (1000/1000)*37.5 = 97.5 → 98.
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(
					() =>
						new FakeMessageStream({
							events: CACHE_EVENTS,
							final: {
								id: "msg_c3",
								usage: {
									input_tokens: 100,
									output_tokens: 200,
									cache_read_input_tokens: 9_000,
								},
							},
						}),
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as FakeMessageStream & {
			receipt: Promise<TrustReceipt>;
		};
		const receipt = await stream.receipt;

		expect(receipt.cost).toBe(98);

		await governed.destroy();
	});

	it("keeps the accumulated READ tier when finalMessage carries cache_read_input_tokens: null", async () => {
		// Bug: the gate was `"cache_read_input_tokens" in u` — true even when the
		// value is `null`, a present-but-unusable counter. That zeroed the 9000
		// read tokens the streamEvent tap already accumulated and billed
		// (understatement). Fixed: gate on a USABLE value (typeof number, finite,
		// >= 0), so a null counter falls back to the accumulated 9000 exactly as
		// if the key had been omitted entirely — same math as the sibling
		// omitted-WRITE-tier test above.
		// 3 + 30 + (9000/1000)*3 + (1000/1000)*37.5 = 97.5 → 98.
		const client = {
			messages: {
				create: vi.fn(),
				stream: vi.fn(
					() =>
						new FakeMessageStream({
							events: CACHE_EVENTS,
							final: {
								id: "msg_c4",
								usage: {
									input_tokens: 100,
									output_tokens: 200,
									cache_read_input_tokens: null,
								},
							},
						}),
				),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as FakeMessageStream & {
			receipt: Promise<TrustReceipt>;
		};
		const receipt = await stream.receipt;

		expect(receipt.cost).toBe(98);

		await governed.destroy();
	});

	it("carries the cache tiers into a consumer-abort partial settle", async () => {
		// F9: an abort settles at the PARTIAL accumulated usage. The cache tokens were
		// already read and billed by the provider, so they must ride along.
		const engine = makeMockEngine();
		const client = {
			messages: {
				create: vi.fn(),
				// Neighbouring runaway test (R1) uses the same 30ms spacing — 5ms left
				// only a ~2ms margin against `flush(8)` below, a timing-tight flake risk
				// on slow CI. message_start (the only event the abort needs to have
				// landed) still fires on the very first macrotask, well before either
				// the 8ms flush or the 30ms delay to the second event.
				stream: vi.fn(() => new FakeMessageStream({ events: CACHE_EVENTS, chunkDelayMs: 30 })),
			},
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const stream = (await governed.messages.stream(STREAM_PARAMS)) as FakeMessageStream & {
			receipt: Promise<TrustReceipt>;
		};
		// Let message_start land (cache counters accumulate), then abort.
		await flush(8);
		stream.abort();
		const receipt = await stream.receipt;

		// input 100 + cacheRead 9000 + cacheWrite 1000, no output yet:
		// 3 + 27 + 37.5 = 67.5 → 68. Without the cache tiers this would be 3 → 3.
		expect(receipt.cost).toBe(68);

		await governed.destroy();
	});
});
