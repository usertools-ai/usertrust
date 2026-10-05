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
import {
	PendingReplayError,
	TBTransferError,
	TransferIdRetiredError,
	TrustTBClient,
	XFER_SPEND,
} from "usertrust";
import { afterEach, describe, expect, it } from "vitest";
import { HoldEngine } from "../src/engine.js";
import { HoldJournal } from "../src/journal.js";
import {
	BudgetIdError,
	debtAccountLabel,
	TigerBeetleLedger,
	transferIdFor,
} from "../src/ledger.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

async function setup(
	seed: number,
	holdTtlSeconds = 900,
	o: { expirySkewMs?: number; journalNow?: () => number; expiryGraceMs?: number } = {},
) {
	const tb = new TrustTBClient({ addresses: [TB_ADDRESS as string], clusterId: 0n });
	const treasury = await tb.createTreasury();
	const wallet = await tb.createFundedBudgetWallet(seed);
	const dir = mkdtempSync(join(tmpdir(), "openshell-engine-tb-"));
	const journal = HoldJournal.open(join(dir, "holds.db"), {
		ledgerTimeoutMs: 5_000,
		...(o.journalNow === undefined ? {} : { now: o.journalNow }),
	});
	cleanups.push(() => {
		journal.close();
		tb.destroy();
		rmSync(dir, { recursive: true, force: true });
	});
	const budgetId = `budget-${randomUUID()}`;
	const ledger = new TigerBeetleLedger(tb, {
		walletFor: () => wallet,
		treasuryId: treasury,
		...(o.expirySkewMs === undefined ? {} : { expirySkewMs: o.expirySkewMs }),
	});
	const engine = new HoldEngine(journal, ledger, {
		holdTtlSeconds,
		...(o.expiryGraceMs === undefined ? {} : { expiryGraceMs: o.expiryGraceMs }),
	});
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
		expect(await engine.settle(k, { post: 60, overage: 0 })).toMatchObject({
			outcome: "late_settled",
			state: "expired",
		});
		expect(journal.get(k)).toMatchObject({ state: "expired", lateAmount: 60, lateCharged: true });
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
				admitBy: Date.now() + 30_000,
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

	it("#174 r1 (regression): a crash between an EXPIRED post and its CAS — TigerBeetle 0.17.9 answers the retry pending_transfer_expired again (expiry does not retire the id), so it routes to late settlement", async () => {
		const { engine, ledger, budgetId, journal, key } = await setup(1_000, 1, { expirySkewMs: 0 });
		const k = key();
		await engine.reserve({ holdKey: k, budgetId, amount: 100 });
		await journal.writeTx(() =>
			journal.cas(k, "open", "settling", { intent: { post: 60, overage: 0 } }),
		);
		await new Promise((r) => setTimeout(r, 2_500));
		expect(await ledger.post({ holdKey: k, amount: 60 }), "the crashed attempt").toBe("expired");
		expect(await engine.settle(k, { post: 60, overage: 0 })).toMatchObject({
			outcome: "late_settled",
			state: "expired",
		});
		expect(journal.get(k)).toMatchObject({ state: "expired", lateAmount: 60, lateCharged: true });
	}, 15_000);

	/** An `open` row whose placement never reached the ledger (the placeHold "succeeded" locally). */
	const unplacedRow = (journal: HoldJournal, k: string, budgetId: string) =>
		journal.reserve({
			holdId: k,
			budgetId,
			amount: 100,
			ttlAt: Date.now() + 60_000,
			admitBy: Date.now() + 30_000,
			availableCredit: () => 1_000,
			placeHold: () => {},
		});

	it("#174 r1 P1: a post that found no hold RETIRES its id — the retry is read back (not_found → incident), never a throw loop", async () => {
		const { engine, budgetId, journal, key } = await setup(1_000);
		const k = key();
		await unplacedRow(journal, k, budgetId);
		expect(await engine.settle(k, { post: 60, overage: 0 })).toEqual({
			outcome: "incident",
			state: "settling",
		});
		// The second attempt meets TransferIdRetiredError on the post id: read back, not thrown.
		expect(await engine.settle(k, { post: 60, overage: 0 })).toEqual({
			outcome: "incident",
			state: "settling",
		});
	});

	it("#174 r1 P1: the late placement LANDS after a retired post id — in flight while the hold lives, then late settlement once its own timeout passes (never `settling` forever)", async () => {
		const { engine, ledger, budgetId, journal, key } = await setup(1_000, 1, { expirySkewMs: 0 });
		const k = key();
		await unplacedRow(journal, k, budgetId);
		expect(await engine.settle(k, { post: 60, overage: 0 })).toMatchObject({ outcome: "incident" });
		await ledger.placeHold({ budgetId, holdKey: k, amount: 100, timeoutSeconds: 1 }); // it landed
		expect(await engine.settle(k, { post: 60, overage: 0 }), "live hold, retired post id").toEqual({
			outcome: "in_flight",
		});
		expect(journal.get(k)?.state).toBe("settling");
		await new Promise((r) => setTimeout(r, 2_500));
		expect(await engine.settle(k, { post: 60, overage: 0 })).toMatchObject({
			outcome: "late_settled",
			state: "expired",
		});
		expect(journal.get(k)).toMatchObject({ lateAmount: 60, lateCharged: true });
	}, 15_000);

	it("#174 r1 P1: after one not-found void, a second release meets a RETIRED void id — in flight, then voided_not_found past the horizon (reachable)", async () => {
		let now = Date.now();
		const { engine, budgetId, journal, key } = await setup(1_000, 900, { journalNow: () => now });
		const k = key();
		await expect(
			journal.reserve({
				holdId: k,
				budgetId,
				amount: 10,
				ttlAt: now + 60_000,
				admitBy: now + 30_000,
				availableCredit: () => 1_000,
				placeHold: () => {
					throw new Error("lost before the ledger");
				},
			}),
		).rejects.toThrow(/lost before the ledger/);
		expect(await engine.release(k)).toEqual({ outcome: "in_flight" }); // retires the void id
		expect(await engine.release(k), "the retired id is read back, not thrown").toEqual({
			outcome: "in_flight",
		});
		now += 60_000 + 10 * 60_000; // ttlAt + the default 10-minute placement grace
		expect(await engine.release(k)).toEqual({ outcome: "voided" });
		expect(journal.get(k)).toMatchObject({ state: "voided", terminalKind: "voided_not_found" });
	});

	it("#174 r1 connector: a placement that LANDS after the void id was retired is voided at once under `void-late` (not left until its timeout)", async () => {
		const { engine, ledger, budgetId, journal, walletAcct, key } = await setup(1_000);
		const k = key();
		await expect(
			journal.reserve({
				holdId: k,
				budgetId,
				amount: 10,
				ttlAt: Date.now() + 60_000,
				admitBy: Date.now() + 30_000,
				availableCredit: () => 1_000,
				placeHold: () => {
					throw new Error("lost before the ledger");
				},
			}),
		).rejects.toThrow(/lost before the ledger/);
		expect(await engine.release(k)).toEqual({ outcome: "in_flight" }); // retires the `void` id
		await ledger.placeHold({ budgetId, holdKey: k, amount: 10, timeoutSeconds: 900 }); // it landed
		expect((await walletAcct())?.debits_pending).toBe(10n);
		expect(await engine.release(k)).toEqual({ outcome: "voided" });
		expect(journal.get(k)).toMatchObject({ state: "voided", terminalKind: "voided" });
		expect((await walletAcct())?.debits_pending, "released now, not at its timeout").toBe(0n);
	});

	it("#174 r1 P1: a budget id with `::` is refused at reserve — nothing pending — and is exactly what the escrow namespace refuses", async () => {
		const { tb, engine, walletAcct, key } = await setup(1_000);
		await expect(
			engine.reserve({ holdKey: key(), budgetId: "team::a", amount: 10 }),
		).rejects.toBeInstanceOf(BudgetIdError);
		expect((await walletAcct())?.debits_pending).toBe(0n);
		// Positive control: the label the debt charge would build is refused by core.
		await expect(tb.ensureEscrowAccount("openshell-debt.team::a")).rejects.toThrow(/reserved/);
	});

	it("#174 r2 P1: an ordinary wallet already at the debt label's account id refuses the RESERVATION — nothing placed — never a post that can never charge its overage", async () => {
		const { tb, engine, budgetId, walletAcct, key } = await setup(1_000);
		// Escrow labels and wallet names share core's account-id space.
		await tb.createUserWallet(debtAccountLabel(budgetId));
		await expect(engine.reserve({ holdKey: key(), budgetId, amount: 10 })).rejects.toThrow(
			/exists_with_different_flags/,
		);
		expect((await walletAcct())?.debits_pending, "nothing placed").toBe(0n);
	});

	it("#176 FACT PIN (0.17.9): a repeated post after expiry is code 35 both times, and an over-amount post is code 31 both times — neither retires its id", async () => {
		const { tb, ledger, budgetId, key } = await setup(1_000);
		const code = async (f: () => Promise<unknown>) => {
			try {
				await f();
				return "ok";
			} catch (e) {
				if (e instanceof TransferIdRetiredError) return "retired";
				return e instanceof TBTransferError ? e.code : "other";
			}
		};
		const k = key();
		await ledger.placeHold({ budgetId, holdKey: k, amount: 10, timeoutSeconds: 1 });
		await new Promise((r) => setTimeout(r, 2_500));
		const post = () =>
			tb.postTransfer(transferIdFor(k, "reserve"), 5, { transferId: transferIdFor(k, "post") });
		expect([await code(post), await code(post)]).toEqual([35, 35]);
		const k2 = key();
		await ledger.placeHold({ budgetId, holdKey: k2, amount: 10, timeoutSeconds: 900 });
		const over = () =>
			tb.postTransfer(transferIdFor(k2, "reserve"), 20, { transferId: transferIdFor(k2, "post") });
		expect([await code(over), await code(over)]).toEqual([31, 31]);
		// And the contrast that makes the pin meaningful: a not-found post DOES retire its id.
		const k3 = key();
		const missing = () =>
			tb.postTransfer(transferIdFor(k3, "reserve"), 5, { transferId: transferIdFor(k3, "post") });
		expect([await code(missing), await code(missing)]).toEqual([25, "retired"]);
	}, 15_000);

	it("#176: a RETIRED overage id (its first charge failed: debit_account_not_found) is read back and charged ONCE under overage-retry — settled, never a throw loop", async () => {
		const { tb, treasury, engine, budgetId, journal, key } = await setup(1_000);
		const k = key();
		await engine.reserve({ holdKey: k, budgetId, amount: 100 });
		// The crashed earlier attempt: the overage id failed and is now retired.
		await expect(
			tb.immediateTransfer({
				debitAccountId: TrustTBClient.deriveAccountId(`missing-${k}`),
				creditAccountId: treasury,
				amount: 40,
				code: XFER_SPEND,
				transferId: transferIdFor(k, "overage"),
			}),
		).rejects.toThrow();
		expect(await engine.settle(k, { post: 100, overage: 40 })).toEqual({
			outcome: "settled",
			resumed: false,
		});
		const debtAcct = await tb.ensureEscrowAccount(debtAccountLabel(budgetId));
		expect((await tb.lookupAccounts([debtAcct]))[0]?.debits_posted, "charged once").toBe(40n);
		expect(await tb.lookupTransfer(transferIdFor(k, "overage-retry"))).not.toBeNull();
		expect(journal.debtOf(budgetId)).toBe(40);
		// A repeat charges nothing more (overage-retry exists; the read-back says done).
		expect(await engine.settle(k, { post: 100, overage: 40 })).toEqual({ outcome: "duplicate" });
		expect((await tb.lookupAccounts([debtAcct]))[0]?.debits_posted).toBe(40n);
	});

	it("#177 x #180: a chargeDebt REPLAY (a crash after the charge landed) builds the identical transfer — core's now-verified `exists` accepts it, and the debt account is charged once; a replay with another amount is refused as a mismatch", async () => {
		const { tb, ledger, budgetId, key } = await setup(1_000);
		const k = key();
		const charge = (amount: number) =>
			ledger.chargeDebt({ budgetId, holdKey: k, role: "overage", amount });
		expect(await charge(40)).toBe("done");
		expect(await charge(40), "the replay answers `exists`, verified").toBe("done");
		const debtAcct = await tb.ensureEscrowAccount(debtAccountLabel(budgetId));
		expect((await tb.lookupAccounts([debtAcct]))[0]?.debits_posted).toBe(40n);
		await expect(charge(41)).rejects.toThrow();
		expect((await tb.lookupAccounts([debtAcct]))[0]?.debits_posted, "still charged once").toBe(40n);
	});

	it("1c-1: the SWEEPER expires a hold the ledger released — the void answers expired, the row is `expired`, nothing pending", async () => {
		// Grace 0 and a 1 s lifetime: past ttlAt (start + 2 deadlines + 1 s) the sweep claims it.
		const { engine, budgetId, journal, walletAcct, key } = await setup(1_000, 1, {
			expiryGraceMs: 0,
		});
		const k = key();
		await engine.reserve({ holdKey: k, budgetId, amount: 100 });
		expect((await walletAcct())?.debits_pending).toBe(100n);
		await new Promise((r) => setTimeout(r, 1_000 + 2 * 5_000 + 1_500));
		const report = await engine.sweep();
		expect(report.expired).toEqual([k]);
		expect(journal.get(k)).toMatchObject({
			state: "expired",
			terminalKind: "hold_expired_unsettled",
		});
		expect((await walletAcct())?.debits_pending).toBe(0n);
		expect((await walletAcct())?.debits_posted, "nothing was charged").toBe(0n);
	}, 30_000);

	it("1c-1: a settlement after the ledger expired the hold is LATE-SETTLED — the actual amount charged to the debt account once, never posted", async () => {
		const { tb, engine, budgetId, journal, walletAcct, key } = await setup(1_000, 1);
		const k = key();
		await engine.reserve({ holdKey: k, budgetId, amount: 100 });
		await new Promise((r) => setTimeout(r, 2_500));
		expect(await engine.settle(k, { post: 60, overage: 0 })).toEqual({
			outcome: "late_settled",
			state: "expired",
			resumed: false,
		});
		const debtAcct = await tb.ensureEscrowAccount(debtAccountLabel(budgetId));
		expect((await tb.lookupAccounts([debtAcct]))[0]?.debits_posted).toBe(60n);
		expect((await walletAcct())?.debits_posted, "never posted").toBe(0n);
		expect(journal.get(k)).toMatchObject({ lateAmount: 60, lateCharged: true });
		expect(journal.debtOf(budgetId)).toBe(60);
		// A duplicate settles from the STORED amount: nothing more is charged.
		await engine.settle(k, { post: 60, overage: 0 });
		expect((await tb.lookupAccounts([debtAcct]))[0]?.debits_posted).toBe(60n);
	}, 15_000);

	it("1c-1: the sweeper first, then the settlement: late-settled on the `expired` row, charged once", async () => {
		const { tb, engine, budgetId, journal, key } = await setup(1_000, 1, { expiryGraceMs: 0 });
		const k = key();
		await engine.reserve({ holdKey: k, budgetId, amount: 100 });
		await new Promise((r) => setTimeout(r, 1_000 + 2 * 5_000 + 1_500));
		expect((await engine.sweep()).expired).toEqual([k]);
		expect(await engine.settle(k, { post: 45, overage: 0 })).toMatchObject({
			outcome: "late_settled",
			state: "expired",
		});
		const debtAcct = await tb.ensureEscrowAccount(debtAccountLabel(budgetId));
		expect((await tb.lookupAccounts([debtAcct]))[0]?.debits_posted).toBe(45n);
		expect(journal.get(k)).toMatchObject({ state: "expired", lateAmount: 45, lateCharged: true });
	}, 30_000);

	it("control: every role's id is distinct and stable for a hold", () => {
		const roles = [
			"reserve",
			"post",
			"void",
			"void-late",
			"overage",
			"overage-retry",
			"late",
			"late-retry",
		] as const;
		const ids = roles.map((r) => transferIdFor("k", r));
		expect(new Set(ids.map(String)).size).toBe(roles.length);
		expect(transferIdFor("k", "post")).toBe(transferIdFor("k", "post"));
	});
});
