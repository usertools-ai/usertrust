// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Per-tier estimates at authorize: a hold reserves what the call will cost.
 *
 * `authorize()` used to know only `estimatedInputTokens` and `maxOutputTokens`, and
 * sized ALL estimated input at max(inputPer1k, cacheWritePer1k) (the D3 hold). A
 * Claude Code window is mostly cache READS, so it was reserved at the cache-WRITE
 * rate: on Sonnet, 84,150 prompt tokens held at 37.5/1k (3,156 usertokens) against
 * an input side that really costs ~327. Near a budget that is a false 402.
 *
 * Pinned here:
 *  - with `estimatedCacheReadTokens` / `estimatedCacheWriteTokens`, each tier is
 *    held at its own resolved rate; only FRESH input keeps the D3 write premium;
 *  - the cache tiers resolve from the UN-inflated rates, exactly as settle does — a
 *    model with no cache-read rate holds reads at the REAL input rate;
 *  - an old client (no tier fields) is held exactly as before;
 *  - the un-inflated metered estimate (settle's no-usage fallback) uses the tiers;
 *  - an invalid count is a TypeError before any hold or record.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import { createGovernor, type Governor } from "../../src/headless.js";
import { costFromRates, getModelRates } from "../../src/ledger/pricing.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { AuditEvent } from "../../src/shared/types.js";

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

const SONNET = "claude-sonnet-4-6"; // 30 in / 150 out / 3 cache read / 37.5 cache write, per 1k
/** The real-server window from the report: fresh 150, read 82,000, write 2,000, out 1,000. */
const WINDOW = { input: 150, cacheRead: 82_000, cacheWrite: 2_000, output: 1_000 };

interface EngineHandle extends TrustEngine {
	spendPending: Mock<TrustEngine["spendPending"]>;
	postPendingSpend: Mock<TrustEngine["postPendingSpend"]>;
	voidPendingSpend: Mock<TrustEngine["voidPendingSpend"]>;
}

function makeEngine(): EngineHandle {
	return {
		spendPending: vi.fn<TrustEngine["spendPending"]>(async (p) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn<TrustEngine["postPendingSpend"]>(async () => undefined),
		voidPendingSpend: vi.fn<TrustEngine["voidPendingSpend"]>(async () => {}),
		voidAllPending: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

function makeAudit(): AuditWriter & { events: AppendEventInput[] } {
	const events: AppendEventInput[] = [];
	return {
		events,
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
	};
}

/** The amount the governor asked the ledger to hold, for its only authorize. */
function heldAmount(engine: EngineHandle): number {
	const call = engine.spendPending.mock.calls[0]?.[0];
	if (call === undefined) throw new Error("no hold was placed");
	return call.amount;
}

describe("authorize: per-tier hold sizing", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-tiers-${randomUUID()}`);
		mkdirSync(join(vaultBase, VAULT_DIR), { recursive: true });
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		rmSync(vaultBase, { recursive: true, force: true });
	});

	async function governor(engine: EngineHandle, config?: object): Promise<Governor> {
		if (config !== undefined) {
			writeFileSync(join(vaultBase, VAULT_DIR, "usertrust.config.json"), JSON.stringify(config));
		}
		return await createGovernor({
			budget: 10_000_000,
			vaultBase,
			_engine: engine,
			_audit: makeAudit(),
		});
	}

	it("the real-server window holds ~327 on the input side WITH the tiers, ~3,156 without them", async () => {
		// Hand-computed from the published Sonnet rates — never from the code under test.
		// With tiers: fresh 150 x 37.5 (D3) + read 82,000 x 3 + write 2,000 x 37.5 = 326.625;
		// output 1,000 x 150 = 150; total ceil(476.625) = 477.
		// Without (an old client sends all 84,150 prompt tokens as input): 84,150 x 37.5
		// = 3,155.625 on the input side; total ceil(3,305.625) = 3,306.
		const tiered = makeEngine();
		const govTiered = await governor(tiered);
		const auth = await govTiered.authorize({
			model: SONNET,
			estimatedInputTokens: WINDOW.input,
			estimatedCacheReadTokens: WINDOW.cacheRead,
			estimatedCacheWriteTokens: WINDOW.cacheWrite,
			maxOutputTokens: WINDOW.output,
		});
		expect(heldAmount(tiered)).toBe(477);
		expect(auth.estimatedCost).toBe(477);
		await govTiered.destroy();

		const old = makeEngine();
		const govOld = await governor(old);
		await govOld.authorize({
			model: SONNET,
			estimatedInputTokens: WINDOW.input + WINDOW.cacheRead + WINDOW.cacheWrite,
			maxOutputTokens: WINDOW.output,
		});
		expect(heldAmount(old)).toBe(3306);
		await govOld.destroy();
	});

	it("an OLD client (no tier fields) is held exactly as before: max(input, write) on all estimated input", async () => {
		const engine = makeEngine();
		const gov = await governor(engine);
		await gov.authorize({ model: SONNET, estimatedInputTokens: 12_345, maxOutputTokens: 678 });
		const rates = getModelRates(SONNET);
		// The pre-change formula, written out: fresh input at the D3 hold rate.
		expect(heldAmount(engine)).toBe(
			costFromRates({ ...rates, inputPer1k: Math.max(rates.inputPer1k, 37.5) }, 12_345, 678),
		);
		await gov.destroy();
	});

	it("each tier is held at ITS OWN rate: reads at 3/1k and writes at 37.5/1k, never one rate for both", async () => {
		const reads = makeEngine();
		const govReads = await governor(reads);
		await govReads.authorize({
			model: SONNET,
			estimatedInputTokens: 0,
			estimatedCacheReadTokens: 100_000,
			maxOutputTokens: 1,
		});
		// 100,000 x 3 / 1000 = 300; output 1 x 150 / 1000 = 0.15 → ceil(300.15) = 301.
		expect(heldAmount(reads)).toBe(301);
		await govReads.destroy();

		const writes = makeEngine();
		const govWrites = await governor(writes);
		await govWrites.authorize({
			model: SONNET,
			estimatedInputTokens: 0,
			estimatedCacheWriteTokens: 100_000,
			maxOutputTokens: 1,
		});
		// 100,000 x 37.5 / 1000 = 3,750; + 0.15 → 3,751.
		expect(heldAmount(writes)).toBe(3751);
		await govWrites.destroy();
	});

	it("cache tiers resolve from the UN-inflated rates, as settle does: no published read rate → the REAL input rate", async () => {
		// A model with a cache-WRITE rate above input and NO cache-read rate. The D3 hold
		// raises fresh input to 40/1k; a cache read must still fall back to the real 10/1k
		// (D1), not to the inflated 40.
		const engine = makeEngine();
		const gov = await governor(engine, {
			budget: 10_000_000,
			pricing: "custom",
			customRates: { "tier-model": { inputPer1k: 10, outputPer1k: 20, cacheWritePer1k: 40 } },
		});
		await gov.authorize({
			model: "tier-model",
			estimatedInputTokens: 1_000,
			estimatedCacheReadTokens: 10_000,
			maxOutputTokens: 1,
		});
		// fresh 1,000 x 40 (D3) = 40; read 10,000 x 10 (D1 fallback, un-inflated) = 100;
		// output 1 x 20 / 1000 = 0.02 → ceil(140.02) = 141. At the inflated rate the read
		// alone would be 400.
		expect(heldAmount(engine)).toBe(141);
		await gov.destroy();
	});

	it("the metered estimate (settle's no-usage fallback) is UN-inflated and per-tier", async () => {
		const engine = makeEngine();
		const gov = await governor(engine);
		const auth = await gov.authorize({
			model: SONNET,
			estimatedInputTokens: WINDOW.input,
			estimatedCacheReadTokens: WINDOW.cacheRead,
			estimatedCacheWriteTokens: WINDOW.cacheWrite,
			maxOutputTokens: WINDOW.output,
		});
		const receipt = await gov.settle(auth);
		// 150 x 30 + 82,000 x 3 + 2,000 x 37.5 + 1,000 x 150, / 1000 = 475.5 → 476.
		expect(receipt.cost).toBe(476);
		await gov.destroy();
	});

	for (const [label, value] of [
		["negative", -1],
		["fractional", 1.5],
		["NaN", Number.NaN],
		["a string", "100"],
	] as const) {
		it(`a ${label} tier count is a TypeError before any hold`, async () => {
			const engine = makeEngine();
			const gov = await governor(engine);
			for (const field of ["estimatedCacheReadTokens", "estimatedCacheWriteTokens"] as const) {
				await expect(
					gov.authorize({ model: SONNET, maxOutputTokens: 1, [field]: value as number }),
				).rejects.toThrow(new TypeError(`${field} must be a non-negative integer`));
			}
			expect(engine.spendPending).not.toHaveBeenCalled();
			await gov.destroy();
		});
	}
});
