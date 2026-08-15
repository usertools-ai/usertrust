// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * AUD-001 — headless settle() must not orphan a PENDING hold.
 *
 * settle() deletes the auth from `activeAuths` so a concurrent settle cannot
 * double-POST. If persistSpend or postPendingSpend then throws, the TB transfer
 * is still PENDING. abort() used to be a silent no-op (capture gone) and
 * destroy() never called voidAllPending(), so the hold sat until the 300s
 * auto-void — envelope over-deny — while session budgetSpent could already
 * have recorded money the ledger never posted (permanent capacity loss on
 * the next run's `max(0, budget − budgetSpent)` seed).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import type { Authorization } from "../../src/headless.js";
import { createGovernor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const BUDGET = 100_000;
const AUTHORIZE = {
	model: "claude-sonnet-4-6",
	estimatedInputTokens: 100,
	maxOutputTokens: 500,
} as const;
const USAGE = { inputTokens: 80, outputTokens: 200 } as const;

interface TrackingEngine extends TrustEngine {
	pending: Set<string>;
	posted: string[];
	voided: string[];
	spendPending: ReturnType<typeof vi.fn>;
	postPendingSpend: ReturnType<typeof vi.fn>;
	voidPendingSpend: ReturnType<typeof vi.fn>;
	voidAllPending: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
}

function makeTrackingEngine(opts: { post?: () => Promise<void> } = {}): TrackingEngine {
	const pending = new Set<string>();
	const posted: string[] = [];
	const voided: string[] = [];
	const engine: TrackingEngine = {
		pending,
		posted,
		voided,
		spendPending: vi.fn(async (params: { transferId: string }) => {
			pending.add(params.transferId);
			return { transferId: params.transferId };
		}),
		postPendingSpend: vi.fn(async (transferId: string) => {
			if (opts.post !== undefined) await opts.post();
			pending.delete(transferId);
			posted.push(transferId);
		}),
		voidPendingSpend: vi.fn(async (transferId: string) => {
			pending.delete(transferId);
			voided.push(transferId);
		}),
		voidAllPending: vi.fn(async () => {
			for (const id of [...pending]) {
				pending.delete(id);
				voided.push(id);
			}
		}),
		destroy: vi.fn(),
	};
	return engine;
}

function makeSilentAudit(): AuditWriter {
	return {
		appendEvent: vi.fn(async (input) => ({
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			previousHash: "0".repeat(64),
			hash: "a".repeat(64),
			kind: input.kind,
			actor: input.actor,
			data: input.data,
		})),
		getWriteFailures: () => 0,
		isDegraded: () => false,
		flush: async () => {},
		release: () => {},
	};
}

function readPersistedSpend(vaultBase: string): number | undefined {
	const path = join(vaultBase, VAULT_DIR, "spend-ledger.json");
	if (!existsSync(path)) return undefined;
	return (JSON.parse(readFileSync(path, "utf-8")) as { budgetSpent: number }).budgetSpent;
}

function snapshotAuth(auth: Authorization): Authorization {
	return { ...auth };
}

describe("AUD-001 headless claimed-but-unposted holds", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-orphan-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	async function governorWith(engine: TrackingEngine) {
		return await createGovernor({
			budget: BUDGET,
			vaultBase,
			_engine: engine,
			_audit: makeSilentAudit(),
		});
	}

	it("abort voids the pending hold when settle throws after claiming the auth", async () => {
		// persistSpend used to run after the claim and before POST. A throw
		// there (or any throw after delete-from-activeAuths) left abort() a
		// silent no-op because the capture was gone. The first property settle
		// reads after the claim is `auth.model` — a throwing getter is the
		// persistSpend-after-claim hole without depending on persistSpendLedger
		// (which swallows write failures on purpose).
		const engine = makeTrackingEngine();
		const gov = await governorWith(engine);

		const auth = await gov.authorize(AUTHORIZE);
		const handle = snapshotAuth(auth);
		Object.defineProperty(auth, "model", {
			get(): string {
				throw new Error("persistSpend-like throw after claim");
			},
		});

		await expect(gov.settle(auth, USAGE)).rejects.toThrow("persistSpend-like throw after claim");
		expect(engine.posted).toEqual([]);
		expect(engine.voided).toEqual([]);

		await gov.abort(handle);
		expect(engine.voidPendingSpend).toHaveBeenCalledWith(handle.transferId);
		expect(engine.voided).toEqual([handle.transferId]);
		expect(engine.pending.size).toBe(0);

		// A second abort is silent — already voided.
		await expect(gov.abort(handle)).resolves.toBeUndefined();
		expect(engine.voidPendingSpend).toHaveBeenCalledTimes(1);

		await gov.destroy();
	});

	it("destroy sweeps a hold that settle claimed and then threw on", async () => {
		const engine = makeTrackingEngine();
		const gov = await governorWith(engine);

		const auth = await gov.authorize(AUTHORIZE);
		const transferId = auth.transferId;
		Object.defineProperty(auth, "model", {
			get(): string {
				throw new Error("persistSpend-like throw after claim");
			},
		});

		await expect(gov.settle(auth, USAGE)).rejects.toThrow("persistSpend-like throw after claim");
		expect(engine.pending.has(transferId)).toBe(true);

		await gov.destroy();

		expect(engine.voidAllPending).toHaveBeenCalledOnce();
		expect(engine.voided).toContain(transferId);
		expect(engine.pending.size).toBe(0);
	});

	it("postPendingSpend throw returns settled:false and abort/destroy still void; budgetSpent is not incremented", async () => {
		const engine = makeTrackingEngine({
			post: async () => {
				throw new Error("TigerBeetle POST failed");
			},
		});
		const gov = await governorWith(engine);

		const auth = await gov.authorize(AUTHORIZE);
		const remainingAfterHold = gov.budgetRemaining();
		expect(remainingAfterHold).toBe(BUDGET - auth.estimatedCost);

		const receipt = await gov.settle(auth, USAGE);
		expect(receipt.settled).toBe(false);
		expect(engine.posted).toEqual([]);
		// Session counters must not record money the ledger never posted — the
		// next run seeds `max(0, budget − budgetSpent)`. An early increment
		// permanently shrinks capacity for a hold that is still PENDING.
		expect(gov.budgetRemaining()).toBe(remainingAfterHold);
		expect(readPersistedSpend(vaultBase)).toBeUndefined();

		// Second settle stays refused — the claim already happened.
		await expect(gov.settle(auth, USAGE)).rejects.toThrow(
			/already settled or aborted|is not active/,
		);

		await gov.abort(auth);
		expect(engine.voidPendingSpend).toHaveBeenCalledWith(auth.transferId);
		expect(engine.voided).toEqual([auth.transferId]);
		expect(gov.budgetRemaining()).toBe(BUDGET);
		expect(readPersistedSpend(vaultBase)).toBeUndefined();

		await gov.destroy();
		// Already voided — destroy must still sweep, but not double-void this id.
		expect(engine.voidAllPending).toHaveBeenCalledOnce();
		expect(engine.voided).toEqual([auth.transferId]);
	});

	it("postPendingSpend throw then destroy (no abort) voids the leftover pendingMap entry", async () => {
		const engine = makeTrackingEngine({
			post: async () => {
				throw new Error("TigerBeetle POST failed");
			},
		});
		const gov = await governorWith(engine);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, USAGE);
		expect(receipt.settled).toBe(false);
		expect(engine.pending.has(auth.transferId)).toBe(true);
		expect(readPersistedSpend(vaultBase)).toBeUndefined();

		await gov.destroy();

		expect(engine.voidAllPending).toHaveBeenCalledOnce();
		expect(engine.voided).toContain(auth.transferId);
		expect(engine.pending.size).toBe(0);
		expect(readPersistedSpend(vaultBase)).toBeUndefined();
	});

	it("successful settle does not double-void on destroy and budgetSpent matches posted cost", async () => {
		const engine = makeTrackingEngine();
		const gov = await governorWith(engine);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, USAGE);

		expect(receipt.settled).toBe(true);
		expect(engine.posted).toEqual([auth.transferId]);
		expect(engine.voided).toEqual([]);
		expect(gov.budgetRemaining()).toBe(BUDGET - receipt.cost);
		expect(readPersistedSpend(vaultBase)).toBe(receipt.cost);

		await gov.abort(auth);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await gov.destroy();

		expect(engine.voidAllPending).toHaveBeenCalledOnce();
		expect(engine.voided).not.toContain(auth.transferId);
		expect(engine.posted).toEqual([auth.transferId]);
		expect(readPersistedSpend(vaultBase)).toBe(receipt.cost);
	});

	it("destroy calls voidAllPending even when leftover entries are only in the claimed-but-unposted set", async () => {
		const engine = makeTrackingEngine({
			post: async () => {
				throw new Error("TigerBeetle POST failed");
			},
		});
		const gov = await governorWith(engine);

		const first = await gov.authorize(AUTHORIZE);
		const second = await gov.authorize(AUTHORIZE);
		await gov.settle(first, USAGE);
		await gov.settle(second, USAGE);
		expect(engine.pending.size).toBe(2);

		await gov.destroy();

		expect(engine.voidAllPending).toHaveBeenCalledOnce();
		expect(engine.pending.size).toBe(0);
		expect(engine.voided).toEqual(expect.arrayContaining([first.transferId, second.transferId]));
	});
});
