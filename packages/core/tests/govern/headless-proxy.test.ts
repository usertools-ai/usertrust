/**
 * headless-proxy.test.ts
 *
 * AUD-456: Proxy mode has been removed from the public API.
 * These tests verify that attempting to use proxy mode throws
 * a clear error, and that the headless governor works without proxy.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { AuditEvent } from "../../src/shared/types.js";

// Mock tigerbeetle-node
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

function makeTmpVault(): string {
	const dir = join(tmpdir(), `headless-proxy-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
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

describe("headless governor — AUD-456 proxy mode removed", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	it("createGovernor throws when proxy option is provided", async () => {
		const { createGovernor } = await import("../../src/headless.js");

		await expect(
			createGovernor({
				budget: 100_000,
				vaultBase,
				proxy: "https://proxy.example.com",
				key: "test-key",
			}),
		).rejects.toThrow("proxy mode is not yet implemented");
	});

	it("createGovernor throws with AUD-456 reference in error message", async () => {
		const { createGovernor } = await import("../../src/headless.js");

		await expect(
			createGovernor({
				budget: 100_000,
				vaultBase,
				proxy: "https://proxy.example.com",
			}),
		).rejects.toThrow("AUD-456");
	});

	it("error message suggests dryRun as alternative", async () => {
		const { createGovernor } = await import("../../src/headless.js");

		await expect(
			createGovernor({
				budget: 100_000,
				vaultBase,
				proxy: "https://proxy.example.com",
			}),
		).rejects.toThrow("dryRun");
	});

	it("headless governor works normally without proxy", async () => {
		const mockAudit = makeMockAudit();
		const { createGovernor } = await import("../../src/headless.js");

		const gov = await createGovernor({
			budget: 100_000,
			dryRun: true,
			vaultBase,
			_audit: mockAudit,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		expect(auth.transferId).toMatch(/^tx_/);
		expect(auth.estimatedCost).toBeGreaterThan(0);

		const receipt = await gov.settle(auth, {
			inputTokens: 80,
			outputTokens: 200,
		});

		expect(receipt.settled).toBe(true);
		expect(receipt.cost).toBeGreaterThan(0);

		await gov.destroy();
	});
});
