import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditWriter } from "../../src/audit/chain.js";

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

// Mock proxy to create a failing proxy for settle/spend
let proxySettleShouldFail = false;
let proxySpendShouldFail = false;
vi.mock("../../src/proxy.js", () => ({
	connectProxy: vi.fn((_url: string, _key?: string) => ({
		url: _url,
		key: _key,
		spend: vi.fn(async (params: { estimatedCost: number }) => {
			if (proxySpendShouldFail) {
				throw new Error("Proxy spend failed");
			}
			return {
				transferId: `proxy_${Date.now().toString(36)}`,
				estimatedCost: params.estimatedCost,
			};
		}),
		settle: vi.fn(async () => {
			if (proxySettleShouldFail) {
				throw new Error("Proxy settle failed");
			}
		}),
		void: vi.fn(async () => {}),
		destroy: vi.fn(),
	})),
}));

function makeTmpVault(): string {
	const dir = join(tmpdir(), `headless-proxy-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("headless governor — proxy failure branches", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
		proxySettleShouldFail = false;
		proxySpendShouldFail = false;
	});

	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		proxySettleShouldFail = false;
		proxySpendShouldFail = false;
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	it("settle sets settled=false when proxy settle throws", async () => {
		const { createGovernor } = await import("../../src/headless.js");

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			proxy: "https://proxy.example.com",
			key: "test-key",
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		// Enable proxy settle failure
		proxySettleShouldFail = true;

		const receipt = await gov.settle(auth, {
			inputTokens: 80,
			outputTokens: 200,
		});

		expect(receipt.settled).toBe(false);

		await gov.destroy();
	});

	it("settle sets auditDegraded when proxy settle + audit both fail", async () => {
		const degradedAudit: AuditWriter = {
			appendEvent: vi.fn(async () => {
				throw new Error("Audit write failed");
			}),
			getWriteFailures: () => 0,
			isDegraded: () => false,
			flush: async () => {},
			release: () => {},
		};

		const { createGovernor } = await import("../../src/headless.js");

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			proxy: "https://proxy.example.com",
			_audit: degradedAudit,
		});

		const auth = await gov.authorize({ model: "gpt-4o" });

		// Enable proxy settle failure — triggers audit write which also fails
		proxySettleShouldFail = true;

		const receipt = await gov.settle(auth);

		expect(receipt.settled).toBe(false);
		expect(receipt.auditDegraded).toBe(true);

		await gov.destroy();
	});

	it("authorize throws LedgerUnavailableError when proxy.spend fails", async () => {
		const { createGovernor } = await import("../../src/headless.js");

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			proxy: "https://proxy.example.com",
		});

		proxySpendShouldFail = true;

		await expect(gov.authorize({ model: "claude-sonnet-4-6" })).rejects.toThrow(
			"Ledger unavailable",
		);

		await gov.destroy();
	});
});
