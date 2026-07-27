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
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

function makeTmpVault(): string {
	const dir = join(tmpdir(), `trust-div-test-${randomUUID()}`);
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

function makeAnthropicMock(createFn: (...args: unknown[]) => unknown) {
	return { messages: { create: createFn } };
}

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

function auditKinds(audit: AuditWriter): string[] {
	return (audit.appendEvent as ReturnType<typeof vi.fn>).mock.calls.map(
		(c: unknown[]) => (c[0] as AppendEventInput).kind,
	);
}

function divergenceEvent(audit: AuditWriter): AppendEventInput | undefined {
	return (audit.appendEvent as ReturnType<typeof vi.fn>).mock.calls
		.map((c: unknown[]) => c[0] as AppendEventInput)
		.find((e) => e.kind === "usage_divergence");
}

describe("divergence wiring — non-stream settle", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("flags when provider reports ~10x the estimate and emits usage_divergence", async () => {
		const engine = makeMockEngine();
		const audit = makeMockAudit();
		// estimate: max_tokens 500 → est output 500; provider reports 5000 output → ~10x
		const client = makeAnthropicMock(
			vi.fn(async () => ({
				id: "msg_1",
				usage: { input_tokens: 100, output_tokens: 5000 },
			})),
		);

		const governed = await trust(client, {
			dryRun: false,
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: audit,
		});

		const { receipt } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 500,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(receipt.usageSource).toBe("provider");
		expect(receipt.divergence).toBeDefined();
		expect(receipt.divergence?.flagged).toBe(true);
		expect(receipt.divergence?.ratio).toBeGreaterThan(4);
		expect(receipt.divergence?.actualCost).toBe(receipt.cost);

		// A hash-chained usage_divergence audit event fires, numbers + ids only.
		const ev = divergenceEvent(audit);
		expect(ev).toBeDefined();
		expect(ev?.data).toMatchObject({
			transferId: receipt.transferId,
			model: "claude-sonnet-4-6",
		});
		expect(typeof ev?.data.ratio).toBe("number");
		expect(ev?.data).not.toHaveProperty("messages");

		await governed.destroy();
	});

	it("A9: settle mutates the ledger EXACTLY once (post once, never void)", async () => {
		const engine = makeMockEngine();
		const client = makeAnthropicMock(
			vi.fn(async () => ({ id: "msg_1", usage: { input_tokens: 100, output_tokens: 5000 } })),
		);
		const governed = await trust(client, {
			dryRun: false,
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 500,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(engine.postPendingSpend).toHaveBeenCalledTimes(1);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("present-but-not-flagged when reported usage is close to the estimate", async () => {
		const audit = makeMockAudit();
		// est output 500 (max_tokens); provider reports ~480 → ratio ≈ 1
		const client = makeAnthropicMock(
			vi.fn(async () => ({ id: "msg_1", usage: { input_tokens: 9, output_tokens: 480 } })),
		);
		const governed = await trust(client, {
			dryRun: false,
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: audit,
		});

		const { receipt } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 500,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(receipt.divergence).toBeDefined();
		expect(receipt.divergence?.flagged).toBe(false);
		// No usage_divergence event when not flagged.
		expect(auditKinds(audit)).not.toContain("usage_divergence");

		await governed.destroy();
	});

	it("omits divergence entirely when usage is absent (settles at estimate)", async () => {
		const client = makeAnthropicMock(vi.fn(async () => ({ id: "msg_1" }))); // no usage field
		const governed = await trust(client, {
			dryRun: false,
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});

		const { receipt } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 500,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.divergence).toBeUndefined();

		await governed.destroy();
	});

	it("A2: a provider error voids EXACTLY once and never posts", async () => {
		const engine = makeMockEngine();
		const client = makeAnthropicMock(
			vi.fn(async () => {
				throw new Error("provider 500");
			}),
		);
		const governed = await trust(client, {
			dryRun: false,
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await expect(
			governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 500,
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toThrow("provider 500");

		expect(engine.voidPendingSpend).toHaveBeenCalledTimes(1);
		expect(engine.postPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});
});

describe("divergence wiring — stream settle (finalizeStreamSettle)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("flags a stream whose reported output dwarfs the estimate", async () => {
		const audit = makeMockAudit();
		const chunks = [
			{ type: "message_start", message: { usage: { input_tokens: 100 } } },
			{ type: "content_block_delta", delta: { text: "hi" } },
			{ type: "message_delta", usage: { output_tokens: 5000 } },
		];
		const governed = await trust(makeStreamingMock(chunks), {
			dryRun: false,
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: audit,
		});

		const { response } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 500,
			messages: [{ role: "user", content: "Hello" }],
		});

		for await (const _ of response as AsyncIterable<unknown>) {
			// consume
		}
		const receipt = await (response as { receipt: Promise<TrustReceipt> }).receipt;

		expect(receipt.usageSource).toBe("provider");
		expect(receipt.divergence?.flagged).toBe(true);
		expect(receipt.divergence?.ratio).toBeGreaterThan(4);
		expect(divergenceEvent(audit)).toBeDefined();

		await governed.destroy();
	});

	it("omits divergence on an estimated (no-usage) stream", async () => {
		const chunks = [
			{ type: "content_block_delta", delta: { text: "a" } },
			{ type: "content_block_delta", delta: { text: "b" } },
		];
		const governed = await trust(makeStreamingMock(chunks), {
			dryRun: false,
			budget: 5_000_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});

		const { response } = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 500,
			messages: [{ role: "user", content: "Hello" }],
		});
		for await (const _ of response as AsyncIterable<unknown>) {
			// consume
		}
		const receipt = await (response as { receipt: Promise<TrustReceipt> }).receipt;

		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.divergence).toBeUndefined();

		await governed.destroy();
	});
});
