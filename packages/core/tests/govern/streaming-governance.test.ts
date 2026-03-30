import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";

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

// ── Test helpers ──

function makeTmpVault(): string {
	const dir = join(tmpdir(), `trust-sg-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeMockEngine(overrides?: Partial<TrustEngine>): TrustEngine {
	return {
		spendPending: vi.fn(async (params: { transferId: string; amount: number }) => ({
			transferId: params.transferId,
		})),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
		...overrides,
	};
}

function makeMockAudit(overrides?: Partial<AuditWriter>): AuditWriter {
	const events: AppendEventInput[] = [];
	return {
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
		...overrides,
	};
}

// Anthropic streaming mock: yields chunks then reports usage via message_start/message_delta
function makeStreamingMock(chunks: unknown[]) {
	return {
		messages: {
			create: vi.fn(async () => {
				async function* gen() {
					for (const c of chunks) yield c;
				}
				return gen();
			}),
		},
	};
}

function makeFailingStreamMock(chunks: unknown[], errorAfter: number) {
	return {
		messages: {
			create: vi.fn(async () => {
				async function* gen() {
					let i = 0;
					for (const c of chunks) {
						if (i >= errorAfter) throw new Error("Stream interrupted");
						yield c;
						i++;
					}
				}
				return gen();
			}),
		},
	};
}

// ── Tests ──

describe("Streaming governance integration", () => {
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
	});

	it("receipt has usageSource='provider' when stream reports usage", async () => {
		const chunks = [
			{ type: "message_start", message: { usage: { input_tokens: 100 } } },
			{ type: "content_block_delta", delta: { text: "Hello" } },
			{ type: "message_delta", usage: { output_tokens: 30 } },
		];

		const engine = makeMockEngine();
		const mockAudit = makeMockAudit();
		const mockClient = makeStreamingMock(chunks);

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// Consume the stream to trigger onComplete
		const stream = result.response as AsyncIterable<unknown>;
		const collected: unknown[] = [];
		for await (const chunk of stream) {
			collected.push(chunk);
		}
		expect(collected).toHaveLength(3);

		// Get the final receipt from the governed stream
		const finalReceipt = await (result.response as { receipt: Promise<TrustReceipt> }).receipt;
		expect(finalReceipt.usageSource).toBe("provider");
		expect(finalReceipt.chunksDelivered).toBe(3);

		await governed.destroy();
	});

	it("receipt has usageSource='estimated' when stream reports no usage", async () => {
		// No usage chunks — just content deltas
		const chunks = [
			{ type: "content_block_delta", delta: { text: "Hello" } },
			{ type: "content_block_delta", delta: { text: " world" } },
		];

		const engine = makeMockEngine();
		const mockAudit = makeMockAudit();
		const mockClient = makeStreamingMock(chunks);

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// Consume the stream
		for await (const _ of result.response as AsyncIterable<unknown>) {
			// consume
		}

		const finalReceipt = await (result.response as { receipt: Promise<TrustReceipt> }).receipt;
		expect(finalReceipt.usageSource).toBe("estimated");
		// Cost should be > 1 (the floor) since we have estimated tokens
		expect(finalReceipt.cost).toBeGreaterThan(1);
		expect(finalReceipt.chunksDelivered).toBe(2);

		await governed.destroy();
	});

	it("audits partial delivery when stream fails mid-way", async () => {
		const chunks = [
			{ type: "message_start", message: { usage: { input_tokens: 50 } } },
			{ type: "content_block_delta", delta: { text: "partial" } },
			{ type: "content_block_delta", delta: { text: "boom" } },
		];

		const engine = makeMockEngine();
		const mockAudit = makeMockAudit();
		const mockClient = makeFailingStreamMock(chunks, 2);

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// Capture the receipt promise rejection (it will reject on stream failure)
		const receiptPromise = (result.response as { receipt: Promise<TrustReceipt> }).receipt;
		receiptPromise.catch(() => {}); // prevent unhandled rejection

		// Consume the stream — should throw
		try {
			for await (const _ of result.response as AsyncIterable<unknown>) {
				// consume
			}
		} catch {
			// expected
		}

		// Wait a tick for the best-effort audit to flush
		await new Promise<void>((r) => setTimeout(r, 50));

		// Verify stream_partial_delivery was audited
		const appendCalls = (mockAudit.appendEvent as ReturnType<typeof vi.fn>).mock.calls;
		const partialCall = appendCalls.find(
			(call: unknown[]) => (call[0] as AppendEventInput).kind === "stream_partial_delivery",
		);
		expect(partialCall).toBeDefined();

		const partialData = (partialCall?.[0] as AppendEventInput).data;
		expect(partialData.chunksDelivered).toBe(2);
		expect(partialData.partialInputTokens).toBe(50);
		expect(partialData.error).toContain("Stream interrupted");

		// Verify VOID was called
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();

		await governed.destroy();
	});

	it("still VOIDs the hold on stream failure", async () => {
		const chunks = [
			{ type: "content_block_delta", delta: { text: "ok" } },
			{ type: "content_block_delta", delta: { text: "fail" } },
		];

		const engine = makeMockEngine();
		const mockAudit = makeMockAudit();
		const mockClient = makeFailingStreamMock(chunks, 1);

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// Capture the receipt promise rejection (it will reject on stream failure)
		const receiptPromise = (result.response as { receipt: Promise<TrustReceipt> }).receipt;
		receiptPromise.catch(() => {}); // prevent unhandled rejection

		// Consume the stream — should throw
		try {
			for await (const _ of result.response as AsyncIterable<unknown>) {
				// consume
			}
		} catch {
			// expected
		}

		// Wait a tick for async callbacks
		await new Promise<void>((r) => setTimeout(r, 50));

		// VOID was called, POST was NOT called
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("initial streaming receipt budgetRemaining accounts for in-flight holds", async () => {
		// Use dry-run mode so we don't need engine but still get budget tracking
		const chunks = [
			{ type: "message_start", message: { usage: { input_tokens: 100 } } },
			{ type: "content_block_delta", delta: { text: "Hello" } },
			{ type: "message_delta", usage: { output_tokens: 20 } },
		];

		const mockAudit = makeMockAudit();
		const mockClient = makeStreamingMock(chunks);

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 1000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// The initial receipt's budgetRemaining should account for the in-flight hold
		expect(result.receipt.budgetRemaining).toBeLessThan(1000);

		// Consume the stream
		for await (const _ of result.response as AsyncIterable<unknown>) {
			// consume
		}

		await governed.destroy();
	});
});
