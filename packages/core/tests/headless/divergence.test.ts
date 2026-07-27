import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import type { AuditEvent } from "../../src/shared/types.js";

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
	const dir = join(tmpdir(), `trust-hdiv-test-${randomUUID()}`);
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

function divergenceEvent(audit: AuditWriter): AppendEventInput | undefined {
	return (audit.appendEvent as ReturnType<typeof vi.fn>).mock.calls
		.map((c: unknown[]) => c[0] as AppendEventInput)
		.find((e) => e.kind === "usage_divergence");
}

describe("divergence wiring — headless settle", () => {
	let vaultBase: string;
	beforeEach(() => {
		vaultBase = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {}
	});

	it("flags a settle whose actual cost dwarfs the authorize-time estimate", async () => {
		const audit = makeMockAudit();
		const gov = await createGovernor({
			budget: 5_000_000,
			vaultBase,
			_engine: makeMockEngine(),
			_audit: audit,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		const receipt = await gov.settle(auth, {
			inputTokens: 100,
			outputTokens: 5000,
			usageSource: "provider",
		});

		expect(receipt.usageSource).toBe("provider");
		expect(receipt.divergence).toBeDefined();
		expect(receipt.divergence?.flagged).toBe(true);
		expect(receipt.divergence?.ratio).toBeGreaterThan(4);
		expect(receipt.divergence?.estimatedCost).toBe(auth.estimatedCost);
		expect(receipt.divergence?.actualCost).toBe(receipt.cost);

		const ev = divergenceEvent(audit);
		expect(ev).toBeDefined();
		expect(ev?.data).toMatchObject({ transferId: auth.transferId, model: "claude-sonnet-4-6" });

		await gov.destroy();
	});

	it("omits divergence when settling at the estimate (no usage supplied)", async () => {
		const audit = makeMockAudit();
		const gov = await createGovernor({
			budget: 5_000_000,
			vaultBase,
			_engine: makeMockEngine(),
			_audit: audit,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});
		const receipt = await gov.settle(auth);

		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.divergence).toBeUndefined();
		expect(divergenceEvent(audit)).toBeUndefined();

		await gov.destroy();
	});

	it("present-but-not-flagged when actual is close to estimate", async () => {
		const gov = await createGovernor({
			budget: 5_000_000,
			vaultBase,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});
		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});
		// actual ≈ estimate → ratio ≈ 1
		const receipt = await gov.settle(auth, { inputTokens: 100, outputTokens: 480 });

		expect(receipt.divergence).toBeDefined();
		expect(receipt.divergence?.flagged).toBe(false);

		await gov.destroy();
	});
});
