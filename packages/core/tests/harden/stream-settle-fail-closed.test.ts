// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Under `audit.failClosed`, a completed stream whose settlement audit fails has
 * ALREADY been charged: the POST lands first, then the `llm_call` write fails, and
 * `.receipt` rejects with `AuditDegradedError`. Nothing is voided.
 *
 * That rejection used to reach the caller ONLY through `.receipt`, which a caller who
 * catches the iteration need not await (and which can no longer go unhandled). So under
 * failClosed the generic stream path now also ends the ITERATION with the error: the
 * final step (or the `return()` an early `break` drives) waits for settlement and
 * throws its failure. With failClosed off, nothing changes: the loop ends at once and
 * settlement stays in the background.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { AuditDegradedError } from "../../src/shared/errors.js";
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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const CHUNKS = [
	{ type: "message_start", message: { usage: { input_tokens: 100 } } },
	{ type: "content_block_delta", delta: { text: "Hel" } },
	{ type: "content_block_delta", delta: { text: "lo" } },
	{ type: "message_delta", usage: { output_tokens: 30 } },
];

function streamingClient() {
	return {
		messages: {
			create: vi.fn(async (_params: unknown) => {
				async function* gen() {
					for (const c of CHUNKS) yield c;
				}
				return gen();
			}),
		},
	};
}

type OpenAIShaped = {
	chat: { completions: { create: (p: unknown) => Promise<{ response: unknown }> } };
	responses: { create: (p: unknown) => Promise<{ response: unknown }> };
};

/** An OpenAI-shaped client: chat.completions and responses streams, each with usage. */
function openaiClient() {
	const stream = (events: unknown[]) =>
		vi.fn(async (_params: unknown) => {
			async function* gen() {
				for (const e of events) yield e;
			}
			return gen();
		});
	return {
		chat: {
			completions: {
				create: stream([
					{ choices: [{ delta: { content: "Hel" } }] },
					{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30 } },
				]),
			},
		},
		responses: {
			create: stream([
				{ type: "response.output_text.delta", delta: "Hel" },
				{
					type: "response.completed",
					response: { usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } },
				},
			]),
		},
	};
}

/** `postPendingSpend` waits for `release()`, so a test can see what runs before it. */
function makeEngine(opts: { gatePost?: boolean; failPost?: boolean } = {}) {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let posted = false;
	const engine: TrustEngine = {
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => ({
			transferId: p.transferId,
		})),
		postPendingSpend: vi.fn(async () => {
			if (opts.gatePost === true) await gate;
			if (opts.failPost === true) throw new Error("ledger POST failed");
			posted = true;
		}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
	return { engine, release, posted: () => posted };
}

/** An audit writer whose `llm_call` write fails, as audit-fail-closed.test.ts degrades it. */
function makeAudit(opts: { failLlmCall: boolean }): AuditWriter {
	let degraded = false;
	return {
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			if (opts.failLlmCall && input.kind === "llm_call") {
				degraded = true;
				throw new Error("Audit disk full");
			}
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
		getWriteFailures: vi.fn(() => (degraded ? 1 : 0)),
		isDegraded: vi.fn(() => degraded),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

describe("a completed stream whose settlement audit fails (audit.failClosed)", () => {
	let vaultBase: string;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	beforeEach(() => {
		vaultBase = join(tmpdir(), `stream-failclosed-${randomUUID()}`);
		mkdirSync(join(vaultBase, ".usertrust"), { recursive: true });
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});
	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
		rmSync(vaultBase, { recursive: true, force: true });
	});

	async function governedStream(failClosed: boolean, engine: TrustEngine, audit: AuditWriter) {
		writeFileSync(
			join(vaultBase, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 500_000, audit: { failClosed } }),
		);
		const governed = await trust(streamingClient(), {
			dryRun: false,
			vaultBase,
			_engine: engine,
			_audit: audit,
		});
		const { response } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: [{ role: "user", content: "Hello" }],
			stream: true,
		});
		const stream = response as AsyncIterable<unknown> & { receipt: Promise<TrustReceipt> };
		return { governed, stream };
	}

	/** The docs pattern: a for-await inside try/catch. What the catch received, if anything. */
	async function iterate(stream: AsyncIterable<unknown>, breakAfter?: number): Promise<unknown> {
		let seen = 0;
		try {
			for await (const _ of stream) {
				seen++;
				if (breakAfter !== undefined && seen >= breakAfter) break;
			}
			return undefined;
		} catch (err) {
			return err;
		}
	}

	const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

	it("the charge posts, nothing is voided, and .receipt rejects with AuditDegradedError", async () => {
		const { engine } = makeEngine();
		const { governed, stream } = await governedStream(
			true,
			engine,
			makeAudit({ failLlmCall: true }),
		);
		await iterate(stream);
		await expect(stream.receipt).rejects.toBeInstanceOf(AuditDegradedError);
		expect(engine.postPendingSpend).toHaveBeenCalledTimes(1);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await governed.destroy();
	});

	it("the docs pattern: the loop's catch receives AuditDegradedError, without awaiting .receipt", async () => {
		const { engine } = makeEngine();
		const { governed, stream } = await governedStream(
			true,
			engine,
			makeAudit({ failLlmCall: true }),
		);
		const caught = await iterate(stream);
		expect(caught).toBeInstanceOf(AuditDegradedError);
		await settled();
		expect(engine.postPendingSpend).toHaveBeenCalledTimes(1);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(unhandled).toEqual([]);
		// .receipt carries the same error.
		await expect(stream.receipt).rejects.toBe(caught);
		await governed.destroy();
	});

	it("an early break: the error surfaces at the break", async () => {
		const { engine } = makeEngine();
		const { governed, stream } = await governedStream(
			true,
			engine,
			makeAudit({ failLlmCall: true }),
		);
		const caught = await iterate(stream, 1);
		expect(caught).toBeInstanceOf(AuditDegradedError);
		await settled();
		expect(engine.postPendingSpend).toHaveBeenCalledTimes(1);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(unhandled).toEqual([]);
		await governed.destroy();
	});

	it.each([
		{
			surface: "chat.completions.create",
			call: (g: OpenAIShaped) =>
				g.chat.completions.create({ model: "gpt-4o", messages: [], stream: true }),
		},
		{
			surface: "responses.create",
			call: (g: OpenAIShaped) => g.responses.create({ model: "gpt-4o", input: "hi", stream: true }),
		},
	])("OpenAI $surface: the loop's catch receives AuditDegradedError too", async ({ call }) => {
		writeFileSync(
			join(vaultBase, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 500_000, audit: { failClosed: true } }),
		);
		const { engine } = makeEngine();
		const governed = await trust(openaiClient(), {
			dryRun: false,
			vaultBase,
			_engine: engine,
			_audit: makeAudit({ failLlmCall: true }),
		});
		const { response } = await call(governed as unknown as OpenAIShaped);
		const caught = await iterate(response as AsyncIterable<unknown>);
		expect(caught).toBeInstanceOf(AuditDegradedError);
		await settled();
		expect(engine.postPendingSpend).toHaveBeenCalledTimes(1);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(unhandled).toEqual([]);
		await governed.destroy();
	});

	it("control, failClosed OFF: the loop ends at once, settlement stays in the background", async () => {
		const { engine, release, posted } = makeEngine({ gatePost: true });
		const { governed, stream } = await governedStream(
			false,
			engine,
			makeAudit({ failLlmCall: true }),
		);
		// The loop ends cleanly while the POST is still held: done did not wait for it.
		expect(await iterate(stream)).toBeUndefined();
		expect(posted()).toBe(false);
		release();
		// Fail-open: a degraded receipt, resolved.
		const receipt = await stream.receipt;
		expect(receipt.auditDegraded).toBe(true);
		expect(engine.postPendingSpend).toHaveBeenCalledTimes(1);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(unhandled).toEqual([]);
		await governed.destroy();
	});

	it("a failed ledger POST under failClosed, audit healthy, is ambiguous: the loop ends cleanly", async () => {
		// Only the failClosed AUDIT refusal reaches the iteration. A POST that fails is
		// caught inside settlement and recorded as ambiguous (the hold may still be posted
		// or voided later), and the receipt says so: settled: false, nothing voided.
		const { engine } = makeEngine({ failPost: true });
		const audit = makeAudit({ failLlmCall: false });
		const { governed, stream } = await governedStream(true, engine, audit);
		expect(await iterate(stream)).toBeUndefined();
		const receipt = await stream.receipt;
		expect(receipt.settled).toBe(false);
		expect(receipt.auditDegraded).not.toBe(true);
		expect(engine.postPendingSpend).toHaveBeenCalledTimes(1);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		const kinds = vi.mocked(audit.appendEvent).mock.calls.map(([e]) => e.kind);
		expect(kinds).toContain("settlement_ambiguous");
		expect(unhandled).toEqual([]);
		await governed.destroy();
	});

	it("control, failClosed ON with a healthy audit: the loop ends cleanly and .receipt resolves", async () => {
		const { engine } = makeEngine();
		const { governed, stream } = await governedStream(
			true,
			engine,
			makeAudit({ failLlmCall: false }),
		);
		expect(await iterate(stream)).toBeUndefined();
		const receipt = await stream.receipt;
		expect(receipt.settled).toBe(true);
		expect(receipt.auditDegraded).not.toBe(true);
		expect(engine.postPendingSpend).toHaveBeenCalledTimes(1);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		await governed.destroy();
	});
});
