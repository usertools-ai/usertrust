// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * AUD-001 — headless settle() must not orphan a PENDING hold, and must not
 * void or under-count an in-flight or transport-ambiguous POST.
 *
 * settle() deletes the auth from `activeAuths` so a concurrent settle cannot
 * double-POST. Pre-POST work (metering) can still throw — the hold is PENDING
 * and abort()/destroy() must void it. Once `postPendingSpend` is in flight the
 * id is in `settling`: abort() is a silent no-op and destroy() waits before
 * voidAllPending(). A transport-ambiguous POST (TB may have committed) is
 * counted fail-closed into budgetSpent and is NOT put back on the abort-void
 * path — voiding it would drop a posted transfer, and skipping the increment
 * would reseed the next run as if the spend never happened.
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

function appendedKinds(audit: AuditWriter): string[] {
	return vi.mocked(audit.appendEvent).mock.calls.map(([input]) => input.kind);
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

	async function governorWith(engine: TrackingEngine, audit: AuditWriter = makeSilentAudit()) {
		return await createGovernor({
			budget: BUDGET,
			vaultBase,
			_engine: engine,
			_audit: audit,
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

	it("postPendingSpend throw returns settled:false, counts spend fail-closed, abort does not void", async () => {
		const engine = makeTrackingEngine({
			post: async () => {
				throw new Error("TigerBeetle POST failed");
			},
		});
		const audit = makeSilentAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		expect(gov.budgetRemaining()).toBe(BUDGET - auth.estimatedCost);

		const receipt = await gov.settle(auth, USAGE);
		expect(receipt.settled).toBe(false);
		expect(engine.posted).toEqual([]);
		// Transport-ambiguous POST: TB may have committed after retries.
		// Count as spent (fail-closed) so the next run cannot reseed as if
		// the money never moved. Do NOT void — that would drop a posted transfer.
		expect(gov.budgetRemaining()).toBe(BUDGET - receipt.cost);
		expect(readPersistedSpend(vaultBase)).toBe(receipt.cost);
		expect(appendedKinds(audit)).toContain("settlement_ambiguous");
		expect(appendedKinds(audit)).toContain("llm_call");

		// Second settle stays refused — the claim already happened.
		await expect(gov.settle(auth, USAGE)).rejects.toThrow(
			/already settled or aborted|is not active/,
		);

		const kindsBeforeAbort = appendedKinds(audit);
		await gov.abort(auth);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(appendedKinds(audit)).toEqual(kindsBeforeAbort);
		expect(appendedKinds(audit)).not.toContain("llm_call_failed");
		// Abort must not restore the session counters it never owned.
		expect(gov.budgetRemaining()).toBe(BUDGET - receipt.cost);
		expect(readPersistedSpend(vaultBase)).toBe(receipt.cost);

		await gov.destroy();
		// destroy may sweep leftover pendingMap entries via voidAllPending
		// (best-effort; void of an already-posted transfer fails closed).
		// That is not the abort-void path and must not look like unposted cleanup.
		expect(engine.voidAllPending).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
	});

	it("postPendingSpend throw then destroy does not treat the hold as unposted cleanup", async () => {
		const engine = makeTrackingEngine({
			post: async () => {
				throw new Error("TigerBeetle POST failed");
			},
		});
		const gov = await governorWith(engine);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, USAGE);
		expect(receipt.settled).toBe(false);
		expect(readPersistedSpend(vaultBase)).toBe(receipt.cost);
		expect(gov.budgetRemaining()).toBe(BUDGET - receipt.cost);

		await gov.destroy();

		expect(engine.voidAllPending).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(readPersistedSpend(vaultBase)).toBe(receipt.cost);
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

	it("destroy voids leftover holds that settle claimed and then threw on before POST", async () => {
		const engine = makeTrackingEngine();
		const gov = await governorWith(engine);

		const first = await gov.authorize(AUTHORIZE);
		const second = await gov.authorize(AUTHORIZE);
		for (const auth of [first, second]) {
			Object.defineProperty(auth, "model", {
				get(): string {
					throw new Error("persistSpend-like throw after claim");
				},
			});
			await expect(gov.settle(auth, USAGE)).rejects.toThrow("persistSpend-like throw after claim");
		}
		expect(engine.pending.size).toBe(2);
		expect(readPersistedSpend(vaultBase)).toBeUndefined();

		await gov.destroy();

		expect(engine.voidAllPending).toHaveBeenCalledOnce();
		expect(engine.pending.size).toBe(0);
		expect(engine.voided).toEqual(expect.arrayContaining([first.transferId, second.transferId]));
	});

	it("abort during an in-flight POST does not void; settle completes as the sole terminal", async () => {
		let releasePost!: () => void;
		const postGate = new Promise<void>((resolve) => {
			releasePost = resolve;
		});
		const engine = makeTrackingEngine({ post: () => postGate });
		const audit = makeSilentAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		const settleP = gov.settle(auth, USAGE);
		await vi.waitFor(() => {
			expect(engine.postPendingSpend).toHaveBeenCalledWith(auth.transferId, expect.any(Number));
		});

		await gov.abort(auth);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(engine.voided).toEqual([]);
		expect(appendedKinds(audit)).not.toContain("llm_call_failed");

		releasePost();
		const receipt = await settleP;
		expect(receipt.settled).toBe(true);
		expect(engine.posted).toEqual([auth.transferId]);
		expect(engine.voided).toEqual([]);
		expect(gov.budgetRemaining()).toBe(BUDGET - receipt.cost);
		expect(readPersistedSpend(vaultBase)).toBe(receipt.cost);

		await gov.destroy();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(engine.voided).not.toContain(auth.transferId);
	});

	it("abort during an in-flight POST that then throws does not void; spend is counted fail-closed", async () => {
		let releasePost!: () => void;
		const postGate = new Promise<void>((resolve) => {
			releasePost = resolve;
		});
		const engine = makeTrackingEngine({
			post: async () => {
				await postGate;
				throw new Error("TigerBeetle POST failed");
			},
		});
		const audit = makeSilentAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		const settleP = gov.settle(auth, USAGE);
		await vi.waitFor(() => {
			expect(engine.postPendingSpend).toHaveBeenCalled();
		});

		await gov.abort(auth);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(appendedKinds(audit)).not.toContain("llm_call_failed");

		releasePost();
		const receipt = await settleP;
		expect(receipt.settled).toBe(false);
		expect(engine.posted).toEqual([]);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(appendedKinds(audit)).not.toContain("llm_call_failed");
		expect(gov.budgetRemaining()).toBe(BUDGET - receipt.cost);
		expect(readPersistedSpend(vaultBase)).toBe(receipt.cost);

		await gov.destroy();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
	});

	it("destroy waits for an in-flight POST before voidAllPending", async () => {
		let releasePost!: () => void;
		const postGate = new Promise<void>((resolve) => {
			releasePost = resolve;
		});
		const engine = makeTrackingEngine({ post: () => postGate });
		const gov = await governorWith(engine);

		const auth = await gov.authorize(AUTHORIZE);
		const settleP = gov.settle(auth, USAGE);
		await vi.waitFor(() => {
			expect(engine.postPendingSpend).toHaveBeenCalled();
		});

		const destroyP = gov.destroy();
		await new Promise<void>((r) => setTimeout(r, 30));
		expect(engine.voidAllPending).not.toHaveBeenCalled();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		releasePost();
		const receipt = await settleP;
		expect(receipt.settled).toBe(true);
		await destroyP;

		expect(engine.voidAllPending).toHaveBeenCalledOnce();
		expect(engine.posted).toEqual([auth.transferId]);
		expect(engine.voided).not.toContain(auth.transferId);
		expect(readPersistedSpend(vaultBase)).toBe(receipt.cost);
	});
});
