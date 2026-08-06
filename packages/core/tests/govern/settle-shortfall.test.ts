// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Spec D4 — `trust()` reports a TRUNCATED settlement instead of hiding it.
 *
 * TigerBeetle rejects (never caps) a post above the pending transfer, so the
 * engine caps the settle at the reserved hold and hands the truncation back as
 * `{ posted, shortfall }`. What that costs the caller is visibility: the ledger
 * moved less money than the call actually consumed. This file pins where that
 * gap surfaces.
 *
 *  - `receipt.cost` stays the TRUE metered cost. Overwriting it with the posted
 *    amount would make the receipt agree with the ledger by forgetting the
 *    overspend, which is the one number an auditor is here for.
 *  - `receipt.postedCost` carries the ledger side, and ONLY when the two differ —
 *    an absent key is the assertion that nothing was truncated, so a zero
 *    shortfall must not leave the field behind.
 *  - One `settlement_shortfall` event per truncated settle, carrying both numbers
 *    and the transfer they belong to.
 *  - The event is advisory: an audit chain that cannot take it degrades the
 *    receipt (`AUDIT_DEGRADED`) and NEVER unwinds a settlement that committed —
 *    the same contract its sibling `settlement_ambiguous` holds.
 *  - An injected engine whose `postPendingSpend` resolves `void` is posted-in-full.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";

// tigerbeetle-node is a native module and is never loaded in unit tests.
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

// ── Fixtures ──

const PARAMS = {
	model: "claude-sonnet-4-6",
	max_tokens: 64,
	messages: [{ role: "user", content: "hello" }],
};

/** What the capped engine claims to have posted; deliberately not the metered cost. */
const POSTED = 78;
const SHORTFALL = 6;

interface EngineHandle extends TrustEngine {
	spendPending: ReturnType<typeof vi.fn>;
	postPendingSpend: ReturnType<typeof vi.fn>;
	voidPendingSpend: ReturnType<typeof vi.fn>;
}

/**
 * `post` is the whole point of this harness: it is the Task 3 return shape the
 * governor has to read. `undefined` (the default) models the injected engine that
 * predates the shape and resolves `void`.
 */
function makeMockEngine(post?: TrustEngine["postPendingSpend"]): EngineHandle {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(post ?? (async () => {})),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

interface AuditHandle extends AuditWriter {
	events: AppendEventInput[];
}

/** `failOnCall` is 1-based: the Nth append throws, every other one succeeds. */
function makeMockAudit(opts: { failOnCall?: number } = {}): AuditHandle {
	const events: AppendEventInput[] = [];
	let calls = 0;
	return {
		events,
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			calls++;
			if (calls === opts.failOnCall) throw new Error("audit disk full");
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

function makeAnthropicMock() {
	return {
		messages: {
			create: vi.fn(async () => ({
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 10, output_tokens: 5 },
			})),
		},
	};
}

/** A MessageStream-shaped emitter that emits NOTHING until the test says so. */
class ManualMessageStream extends EventEmitter {
	finalMessage(): Promise<unknown> {
		return Promise.resolve({ usage: { input_tokens: 10, output_tokens: 5 } });
	}
	async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
		// The caller owns the iterator; governance never touches it.
	}
}

function shortfallEvents(audit: AuditHandle): AppendEventInput[] {
	return audit.events.filter((e) => e.kind === "settlement_shortfall");
}

/**
 * Read the REAL hash-linked chain — not a mock's call log. `verifyTransaction`
 * resolves a transfer by the FIRST event whose `data.transferId` matches
 * (packages/verify/src/index.ts), so the on-disk ORDER is the contract: a
 * `settlement_shortfall` written ahead of its `llm_call` renders a settled call
 * as PENDING with no cost. These helpers pin the order at the byte level.
 */
function readChain(vaultBase: string): AuditEvent[] {
	const chainPath = join(vaultBase, VAULT_DIR, "audit", "events.jsonl");
	return readFileSync(chainPath, "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as AuditEvent);
}

/** Index of the first chain event of `kind` carrying `transferId`, or -1. */
function chainIndexOf(events: AuditEvent[], kind: string, transferId: string): number {
	return events.findIndex((e) => e.kind === kind && e.data?.transferId === transferId);
}

/**
 * The one assertion this file exists to protect: `llm_call` FIRST, then the
 * shortfall correction that annotates it.
 */
function expectLlmCallBeforeShortfall(vaultBase: string, transferId: string): void {
	const events = readChain(vaultBase);
	const llmCallIdx = chainIndexOf(events, "llm_call", transferId);
	const shortfallIdx = chainIndexOf(events, "settlement_shortfall", transferId);
	expect(llmCallIdx).toBeGreaterThanOrEqual(0);
	expect(shortfallIdx).toBeGreaterThanOrEqual(0);
	expect(llmCallIdx).toBeLessThan(shortfallIdx);
}

// ── Tests ──

describe("settlement_shortfall — non-streaming settle", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `settle-shortfall-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("audits settlement_shortfall and sets receipt.postedCost when the engine reports truncation", async () => {
		const engine = makeMockEngine(async () => ({ posted: POSTED, shortfall: SHORTFALL }));
		const audit = makeMockAudit();
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			_engine: engine,
			_audit: audit,
		});

		const { receipt } = (await governed.messages.create(PARAMS)) as { receipt: TrustReceipt };

		expect(receipt.settled).toBe(true);
		expect(receipt.postedCost).toBe(POSTED);
		// The receipt keeps the METERED cost — the ledger's number lives beside it.
		expect(receipt.cost).not.toBe(POSTED);
		expect(receipt.cost).toBeGreaterThan(0);

		const events = shortfallEvents(audit);
		expect(events).toHaveLength(1);
		expect(events[0]?.data).toMatchObject({
			model: PARAMS.model,
			actual: receipt.cost,
			posted: POSTED,
			shortfall: SHORTFALL,
			transferId: receipt.transferId,
		});

		await governed.destroy();
	});

	it("omits postedCost and the event when shortfall is zero", async () => {
		const engine = makeMockEngine(async (_transferId, actualAmount) => ({
			posted: actualAmount ?? 0,
			shortfall: 0,
		}));
		const audit = makeMockAudit();
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			_engine: engine,
			_audit: audit,
		});

		const { receipt } = (await governed.messages.create(PARAMS)) as { receipt: TrustReceipt };

		expect(receipt.settled).toBe(true);
		// An ABSENT key, not an undefined one: consumers read the presence.
		expect(Object.hasOwn(receipt, "postedCost")).toBe(false);
		expect(shortfallEvents(audit)).toHaveLength(0);

		await governed.destroy();
	});

	it("treats a void-returning engine as posted-in-full (injected-engine compatibility)", async () => {
		const engine = makeMockEngine();
		const audit = makeMockAudit();
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			_engine: engine,
			_audit: audit,
		});

		const { receipt } = (await governed.messages.create(PARAMS)) as { receipt: TrustReceipt };

		expect(receipt.settled).toBe(true);
		expect(Object.hasOwn(receipt, "postedCost")).toBe(false);
		expect(shortfallEvents(audit)).toHaveLength(0);

		await governed.destroy();
	});

	it("audit-append failure on the shortfall event degrades without unsettling", async () => {
		const engine = makeMockEngine(async () => ({ posted: POSTED, shortfall: SHORTFALL }));
		// llm_call is append #1 and the shortfall event is #2 on this path.
		const audit = makeMockAudit({ failOnCall: 2 });
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			_engine: engine,
			_audit: audit,
		});

		const { receipt } = (await governed.messages.create(PARAMS)) as { receipt: TrustReceipt };

		// The money committed; only the record of the gap was lost.
		expect(receipt.settled).toBe(true);
		expect(receipt.auditHash).toBe("AUDIT_DEGRADED");
		expect(receipt.postedCost).toBe(POSTED);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(shortfallEvents(audit)).toHaveLength(0);

		await governed.destroy();
	});

	it("writes llm_call BEFORE settlement_shortfall on the real chain", async () => {
		const engine = makeMockEngine(async () => ({ posted: POSTED, shortfall: SHORTFALL }));
		// No `_audit`: this test needs the REAL writer so the on-disk order is what
		// is asserted, exactly as `verifyTransaction` will read it.
		const governed = await trust(makeAnthropicMock(), {
			budget: 100_000,
			vaultBase,
			_engine: engine,
		});

		const { receipt } = (await governed.messages.create(PARAMS)) as { receipt: TrustReceipt };

		expect(receipt.postedCost).toBe(POSTED);
		expectLlmCallBeforeShortfall(vaultBase, receipt.transferId);

		await governed.destroy();
	});
});

describe("settlement_shortfall — streaming settle", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `settle-shortfall-stream-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("audits the shortfall and stamps postedCost on the stream receipt", async () => {
		const engine = makeMockEngine(async () => ({ posted: POSTED, shortfall: SHORTFALL }));
		const audit = makeMockAudit();
		const stream = new ManualMessageStream();
		const governed = await trust(
			{ messages: { create: vi.fn(), stream: vi.fn(() => stream) } },
			{ budget: 100_000, vaultBase, _engine: engine, _audit: audit },
		);

		const handle = (await governed.messages.stream(PARAMS)) as ManualMessageStream & {
			receipt: Promise<TrustReceipt>;
		};
		stream.emit("finalMessage", { usage: { input_tokens: 10, output_tokens: 5 } });
		stream.emit("end");
		const receipt = await handle.receipt;

		expect(receipt.settled).toBe(true);
		expect(receipt.postedCost).toBe(POSTED);
		expect(receipt.cost).not.toBe(POSTED);

		const events = shortfallEvents(audit);
		expect(events).toHaveLength(1);
		expect(events[0]?.data).toMatchObject({
			actual: receipt.cost,
			posted: POSTED,
			shortfall: SHORTFALL,
			transferId: receipt.transferId,
		});

		await governed.destroy();
	});

	it("omits postedCost and the event on a full stream post", async () => {
		const engine = makeMockEngine();
		const audit = makeMockAudit();
		const stream = new ManualMessageStream();
		const governed = await trust(
			{ messages: { create: vi.fn(), stream: vi.fn(() => stream) } },
			{ budget: 100_000, vaultBase, _engine: engine, _audit: audit },
		);

		const handle = (await governed.messages.stream(PARAMS)) as ManualMessageStream & {
			receipt: Promise<TrustReceipt>;
		};
		stream.emit("finalMessage", { usage: { input_tokens: 10, output_tokens: 5 } });
		stream.emit("end");
		const receipt = await handle.receipt;

		expect(receipt.settled).toBe(true);
		expect(Object.hasOwn(receipt, "postedCost")).toBe(false);
		expect(shortfallEvents(audit)).toHaveLength(0);

		await governed.destroy();
	});

	it("writes llm_call BEFORE settlement_shortfall on the real chain", async () => {
		const engine = makeMockEngine(async () => ({ posted: POSTED, shortfall: SHORTFALL }));
		const stream = new ManualMessageStream();
		// No `_audit`: the REAL writer, so the assertion is about bytes on disk.
		const governed = await trust(
			{ messages: { create: vi.fn(), stream: vi.fn(() => stream) } },
			{ budget: 100_000, vaultBase, _engine: engine },
		);

		const handle = (await governed.messages.stream(PARAMS)) as ManualMessageStream & {
			receipt: Promise<TrustReceipt>;
		};
		stream.emit("finalMessage", { usage: { input_tokens: 10, output_tokens: 5 } });
		stream.emit("end");
		const receipt = await handle.receipt;

		expect(receipt.postedCost).toBe(POSTED);
		expectLlmCallBeforeShortfall(vaultBase, receipt.transferId);

		await governed.destroy();
	});
});
