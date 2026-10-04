// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The hold engine against a REAL TigerBeetle cluster: the derived transfer ids, the
 * debt account, the ledger's own pending timeout, and replays after a crash.
 * Self-skips without `USERTRUST_TB_ADDRESS` (the tb-integration job sets it).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingReplayError, TrustTBClient } from "usertrust";
import { afterEach, describe, expect, it } from "vitest";
import { HoldEngine } from "../src/engine.js";
import { HoldJournal } from "../src/journal.js";
import { debtAccountLabel, TigerBeetleLedger, transferIdFor } from "../src/ledger.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

async function setup(seed: number, holdTtlSeconds = 900) {
	const tb = new TrustTBClient({ addresses: [TB_ADDRESS as string], clusterId: 0n });
	const treasury = await tb.createTreasury();
	const wallet = await tb.createFundedBudgetWallet(seed);
	const dir = mkdtempSync(join(tmpdir(), "openshell-engine-tb-"));
	const journal = HoldJournal.open(join(dir, "holds.db"), { ledgerTimeoutMs: 5_000 });
	cleanups.push(() => {
		journal.close();
		tb.destroy();
		rmSync(dir, { recursive: true, force: true });
	});
	const budgetId = `budget-${randomUUID()}`;
	const ledger = new TigerBeetleLedger(tb, { walletFor: () => wallet, treasuryId: treasury });
	const engine = new HoldEngine(journal, ledger, { holdTtlSeconds });
	const walletAcct = async () => (await tb.lookupAccounts([wallet]))[0];
	return {
		tb,
		treasury,
		wallet,
		journal,
		ledger,
		engine,
		budgetId,
		walletAcct,
		key: () => randomUUID(),
	};
}

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — the hold engine", () => {
	it("reserve → settle posts the intent once and releases the rest of the hold", async () => {
		const { engine, budgetId, walletAcct, key } = await setup(1_000);
		const k = key();
		expect(await engine.reserve({ holdKey: k, budgetId, amount: 300 })).toEqual({
			admitted: true,
			existing: false,
		});
		expect((await walletAcct())?.debits_pending).toBe(300n);
		expect(await engine.settle(k, { post: 120, overage: 0 })).toEqual({
			outcome: "settled",
			resumed: false,
		});
		const a = await walletAcct();
		expect(a?.debits_posted).toBe(120n);
		expect(a?.debits_pending).toBe(0n);
	});

	it("a reservation over the wallet's balance is refused before any transfer", async () => {
		const { engine, budgetId, walletAcct, key } = await setup(100);
		expect(await engine.reserve({ holdKey: key(), budgetId, amount: 101 })).toEqual({
			admitted: false,
			reason: "budget_exceeded",
		});
		expect((await walletAcct())?.debits_pending).toBe(0n);
	});

	it("an overage lands on the budget's debt account (no balance constraint) exactly once", async () => {
		const { tb, engine, budgetId, journal, walletAcct, key } = await setup(1_000);
		const k = key();
		await engine.reserve({ holdKey: k, budgetId, amount: 100 });
		await engine.settle(k, { post: 100, overage: 40 });
		const debtAcct = await tb.ensureEscrowAccount(debtAccountLabel(budgetId));
		expect((await tb.lookupAccounts([debtAcct]))[0]?.debits_posted).toBe(40n);
		expect((await walletAcct())?.debits_posted).toBe(100n);
		expect(journal.debtOf(budgetId)).toBe(40);
		// The next reservation sees the debt: 900 available − 40 debt.
		expect(await engine.reserve({ holdKey: key(), budgetId, amount: 870 })).toMatchObject({
			admitted: false,
		});
	});

	it("release (a non-2xx) voids the hold: nothing posted, nothing pending", async () => {
		const { engine, budgetId, walletAcct, key } = await setup(1_000);
		const k = key();
		await engine.reserve({ holdKey: k, budgetId, amount: 250 });
		expect(await engine.release(k)).toEqual({ outcome: "voided" });
		const a = await walletAcct();
		expect(a?.debits_pending).toBe(0n);
		expect(a?.debits_posted).toBe(0n);
	});

	it("the ledger's own timeout expires the hold before the post: `expired`, late settlement required, nothing posted", async () => {
		const { engine, budgetId, journal, walletAcct, key } = await setup(1_000, 1);
		const k = key();
		await engine.reserve({ holdKey: k, budgetId, amount: 100 });
		await new Promise((r) => setTimeout(r, 2_500));
		expect(await engine.settle(k, { post: 60, overage: 0 })).toEqual({
			outcome: "late_required",
			state: "expired",
		});
		expect(journal.get(k)?.state).toBe("expired");
		const a = await walletAcct();
		expect(a?.debits_posted).toBe(0n);
		expect(a?.debits_pending).toBe(0n);
	}, 15_000);

	it("a post that landed before a crash is replayed with the same derived id: posted ONCE", async () => {
		const { engine, ledger, budgetId, walletAcct, key } = await setup(1_000);
		const k = key();
		await engine.reserve({ holdKey: k, budgetId, amount: 100 });
		await ledger.post({ holdKey: k, amount: 75 }); // the crashed attempt's post
		expect(await engine.settle(k, { post: 75, overage: 0 })).toMatchObject({ outcome: "settled" });
		expect((await walletAcct())?.debits_posted).toBe(75n);
	});

	it("a reservation whose journal commit was lost is NOT re-placed under the same id: it fails closed, and the orphan is voided", async () => {
		// The pending transfer exists (placed, then the journal transaction rolled back). Its
		// own amount does not count against the retry, so the retry reaches the placement:
		// core's PendingReplayError (a pending replay is never a live hold) — the call is
		// denied, the row is committed `voiding`, and release voids the orphan.
		const { engine, ledger, budgetId, journal, walletAcct, key } = await setup(100);
		const k = key();
		await ledger.placeHold({ budgetId, holdKey: k, amount: 100, timeoutSeconds: 900 });
		await expect(engine.reserve({ holdKey: k, budgetId, amount: 100 })).rejects.toBeInstanceOf(
			PendingReplayError,
		);
		expect(journal.get(k)?.state).toBe("voiding");
		expect((await walletAcct())?.debits_pending, "one hold, never two").toBe(100n);
		expect(await engine.release(k)).toEqual({ outcome: "voided" });
		expect((await walletAcct())?.debits_pending, "the orphan is released now").toBe(0n);
	});

	it("a void that finds no transfer (pending_transfer_not_found) is in flight until the placement horizon", async () => {
		const { engine, budgetId, journal, key } = await setup(1_000);
		const k = key();
		// An ambiguous placement that never reached the ledger.
		await expect(
			journal.reserve({
				holdId: k,
				budgetId,
				amount: 10,
				ttlAt: Date.now() + 60_000,
				availableCredit: () => 1_000,
				placeHold: () => {
					throw new Error("lost before the ledger");
				},
			}),
		).rejects.toThrow(/lost before the ledger/);
		expect(await engine.release(k)).toEqual({ outcome: "in_flight" });
		expect(journal.get(k)?.state).toBe("voiding");
	});

	it("a void after the ledger's own timeout (pending_transfer_expired) finalizes as voided_expired", async () => {
		const { engine, budgetId, journal, walletAcct, key } = await setup(1_000, 1);
		const k = key();
		await engine.reserve({ holdKey: k, budgetId, amount: 100 });
		await new Promise((r) => setTimeout(r, 2_500));
		expect(await engine.release(k)).toEqual({ outcome: "voided" });
		expect(journal.get(k)).toMatchObject({ state: "voided", terminalKind: "voided_expired" });
		expect((await walletAcct())?.debits_pending).toBe(0n);
	}, 15_000);

	it("control: every role's id is distinct and stable for a hold", () => {
		const roles = ["reserve", "post", "void", "overage", "late"] as const;
		const ids = roles.map((r) => transferIdFor("k", r));
		expect(new Set(ids.map(String)).size).toBe(roles.length);
		expect(transferIdFor("k", "post")).toBe(transferIdFor("k", "post"));
	});
});
