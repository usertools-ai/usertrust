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
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
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
		this.donePromise = new Promise((res, rej) => {
			this.doneResolve = res;
			this.doneReject = rej;
		});
		this.donePromise.catch(() => {});
		// Self-drive on a macrotask so ALL listeners (governance + caller) attach first.
		setTimeout(() => this.drive(), 0);
	}

	private drive(): void {
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
		}
		if (this.aborted) return;
		this.terminal = true;
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

/** Let the self-driven stream + async governance settlement fully complete. */
async function flush(ms = 40): Promise<void> {
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
		// Task 1 divergence flag rides along on the stream receipt.
		expect(receipt.divergence).toBeDefined();
		expect(receipt.divergence?.actualCost).toBe(receipt.cost);
		expect(Number.isFinite(receipt.divergence?.ratio ?? Number.NaN)).toBe(true);

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

	it("caller abort → void exactly once, never posts", async () => {
		const { engine, governed } = await makeGoverned(
			() => new FakeMessageStream({ events: PROVIDER_EVENTS, final: PROVIDER_FINAL }),
		);
		const stream = (await governed.messages.stream(STREAM_PARAMS)) as {
			abort: () => void;
			receipt: Promise<TrustReceipt>;
		};
		void stream.receipt.catch(() => {});
		stream.abort();
		await flush();

		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();
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

		// finalizeOnce: settle claimed first, the late abort's void is refused.
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
