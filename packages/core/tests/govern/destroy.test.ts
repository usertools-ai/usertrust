import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { runTeardownSteps, type TrustEngine, trust } from "../../src/govern.js";
import type { AuditEvent } from "../../src/shared/types.js";

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
	const dir = join(tmpdir(), `trust-destroy-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeAnthropicMock() {
	return {
		messages: {
			create: vi.fn(async () => ({
				id: "msg_123",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 10, output_tokens: 5 },
			})),
		},
	};
}

function makeMockEngine(): TrustEngine {
	return {
		spendPending: vi.fn(async (params: { transferId: string; amount: number }) => ({
			transferId: params.transferId,
		})),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
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

// ── Tests ──

describe("client.destroy()", () => {
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

	it("flushes pending audit writes", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		await governed.destroy();

		expect(mockAudit.flush).toHaveBeenCalledOnce();
	});

	it("releases audit chain advisory lock", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		await governed.destroy();

		expect(mockAudit.release).toHaveBeenCalledOnce();
	});

	it("calls engine.destroy() when engine is present", async () => {
		const engine = makeMockEngine();
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		await governed.destroy();

		expect(engine.destroy).toHaveBeenCalledOnce();
	});

	it("calling destroy() twice is safe (idempotent)", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		await governed.destroy();
		await governed.destroy(); // should not throw

		// flush and release are called only once
		expect(mockAudit.flush).toHaveBeenCalledOnce();
		expect(mockAudit.release).toHaveBeenCalledOnce();
	});

	it("calls after destroy() reject with clear error", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		await governed.destroy();

		await expect(
			governed.messages.create({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toThrow("TrustedClient has been destroyed");
	});

	it("flush is called before release", async () => {
		const callOrder: string[] = [];
		const mockAudit = makeMockAudit();
		(mockAudit.flush as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			callOrder.push("flush");
		});
		(mockAudit.release as ReturnType<typeof vi.fn>).mockImplementation(() => {
			callOrder.push("release");
		});

		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		await governed.destroy();

		expect(callOrder).toEqual(["flush", "release"]);
	});

	it("destroy() without TB cleanup when engine is null (dry-run)", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		// Should not throw — no engine to destroy
		await governed.destroy();

		expect(mockAudit.flush).toHaveBeenCalledOnce();
		expect(mockAudit.release).toHaveBeenCalledOnce();
	});

	// ── Teardown: every step is attempted, whatever an earlier one does ──

	it("a throwing audit release does not skip the engine's destroy", async () => {
		const engine = makeMockEngine();
		const mockAudit = makeMockAudit();
		const releaseErr = new Error("release failed");
		(mockAudit.release as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw releaseErr;
		});

		const governed = await trust(makeAnthropicMock(), {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		await expect(governed.destroy()).rejects.toBe(releaseErr);
		expect(engine.destroy).toHaveBeenCalledOnce();
	});

	it("a throwing engine destroy still rejects destroy() with the engine's own error", async () => {
		const engine = makeMockEngine();
		const engineErr = new Error("engine destroy failed");
		(engine.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw engineErr;
		});
		const mockAudit = makeMockAudit();

		const governed = await trust(makeAnthropicMock(), {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		await expect(governed.destroy()).rejects.toBe(engineErr);
		expect(mockAudit.release).toHaveBeenCalledOnce();
		expect(engine.destroy).toHaveBeenCalledOnce();
	});

	it("two failing steps reject with an AggregateError of both, in teardown order", async () => {
		const engine = makeMockEngine();
		const engineErr = new Error("engine destroy failed");
		(engine.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw engineErr;
		});
		const mockAudit = makeMockAudit();
		const releaseErr = new Error("release failed");
		(mockAudit.release as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw releaseErr;
		});

		const governed = await trust(makeAnthropicMock(), {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		const err = await governed.destroy().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(AggregateError);
		expect((err as AggregateError).errors).toEqual([releaseErr, engineErr]);
		expect((err as AggregateError).errors[0]).toBe(releaseErr);
		expect((err as AggregateError).errors[1]).toBe(engineErr);
	});

	it("control: no step throws, destroy() resolves and each step runs exactly once", async () => {
		const engine = makeMockEngine();
		const mockAudit = makeMockAudit();

		const governed = await trust(makeAnthropicMock(), {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		await expect(governed.destroy()).resolves.toBeUndefined();
		expect(mockAudit.release).toHaveBeenCalledOnce();
		expect(engine.destroy).toHaveBeenCalledOnce();
	});
});

// The proxy connection is the last teardown step in both governors, but no governor can
// hold one today (proxy mode throws at construction), so its step is pinned here, on the
// helper both destroy() implementations run their steps through.
describe("runTeardownSteps()", () => {
	it("a throwing step does not skip the steps after it, and its error is rethrown as is", () => {
		const engineErr = new Error("engine destroy failed");
		const release = vi.fn();
		const engineDestroy = vi.fn(() => {
			throw engineErr;
		});
		const proxyDestroy = vi.fn();

		let thrown: unknown;
		try {
			runTeardownSteps([release, engineDestroy, proxyDestroy]);
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBe(engineErr);
		expect(release).toHaveBeenCalledOnce();
		expect(engineDestroy).toHaveBeenCalledOnce();
		expect(proxyDestroy).toHaveBeenCalledOnce();
	});

	it("several throwing steps throw an AggregateError listing them in order", () => {
		const first = new Error("first");
		const third = "third, not an Error";
		const middle = vi.fn();

		let thrown: unknown;
		try {
			runTeardownSteps([
				() => {
					throw first;
				},
				middle,
				() => {
					throw third;
				},
			]);
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors).toEqual([first, third]);
		expect(middle).toHaveBeenCalledOnce();
	});

	it("control: no step throws, every step runs exactly once and nothing is thrown", () => {
		const steps = [vi.fn(), vi.fn(), vi.fn()];

		expect(() => runTeardownSteps(steps)).not.toThrow();
		for (const step of steps) expect(step).toHaveBeenCalledOnce();
	});
});
