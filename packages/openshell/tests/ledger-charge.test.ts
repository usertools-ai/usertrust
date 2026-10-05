// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { TBTransferError, TrustTBClient } from "usertrust";
import { describe, expect, it } from "vitest";
import { debtAccountLabel, TigerBeetleLedger, transferIdFor } from "../src/ledger.js";

/**
 * #177 r1 P1: a PERSISTENT refusal between existing accounts (a closed account,
 * accounts_must_have_the_same_ledger) retires each id it touches. Modelled with a stub client;
 * the closed-account case also runs on a real cluster (engine.tb.test.ts, #179 / #190).
 */
function stubClient(refusal: number) {
	const failed = new Set<string>();
	const calls: string[] = [];
	const tb = {
		ensureEscrowAccount: async () => 1n,
		lookupTransfer: async () => null, // a failed transfer is never stored
		immediateTransfer: async (p: { transferId: bigint }) => {
			const id = p.transferId.toString();
			calls.push(id);
			if (failed.has(id)) throw new TBTransferError(68, "id_already_failed");
			failed.add(id);
			throw new TBTransferError(refusal, "refused");
		},
	} as unknown as TrustTBClient;
	return { tb, calls };
}

describe("#177 r1 P1: a debt charge the ledger refuses for good ends TERMINAL, never in flight", () => {
	it("attempt 1 throws (the real code); attempt 2 throws (the retry's first attempt); attempt 3 — both retired, nothing landed — is `failed` with both ids", async () => {
		const { tb, calls } = stubClient(46); // a persistent refusal, not id_already_failed
		const ledger = new TigerBeetleLedger(tb, { walletFor: () => 1n, treasuryId: 2n });
		const charge = () =>
			ledger.chargeDebt({ budgetId: "b", holdKey: "k1", role: "overage", amount: 20 });
		await expect(charge()).rejects.toMatchObject({ code: 46 });
		await expect(charge()).rejects.toMatchObject({ code: 46 });
		const ids = [transferIdFor("k1", "overage"), transferIdFor("k1", "overage-retry")].map(String);
		expect(await charge()).toEqual({ failed: true, role: "overage", transferIds: ids });
		expect(new Set(calls), "only the two derived ids are ever tried").toEqual(new Set(ids));
	});

	it("#190: a CLOSED debt account (debit_account_already_closed, 65 — measured on 0.17.9 to retire the id) is `failed` on the FIRST call: role id, read-back, retry id, read-back — never a throw loop across sweeps", async () => {
		const { tb, calls } = stubClient(65);
		const ledger = new TigerBeetleLedger(tb, { walletFor: () => 1n, treasuryId: 2n });
		const ids = [transferIdFor("k1", "overage"), transferIdFor("k1", "overage-retry")].map(String);
		expect(
			await ledger.chargeDebt({ budgetId: "b", holdKey: "k1", role: "overage", amount: 20 }),
		).toEqual({ failed: true, role: "overage", transferIds: ids });
		expect(calls).toEqual(ids);
	});

	it("#190: chargeDebt does not re-ensure the debt account (the reservation ensured it): it debits the derived id directly", async () => {
		const { tb } = stubClient(65);
		let ensured = 0;
		const debited: bigint[] = [];
		const t = tb as unknown as Record<string, unknown>;
		t.ensureEscrowAccount = async () => {
			ensured++;
			return 1n;
		};
		t.immediateTransfer = async (p: { debitAccountId: bigint }) => {
			debited.push(p.debitAccountId);
		};
		const ledger = new TigerBeetleLedger(tb, { walletFor: () => 1n, treasuryId: 2n });
		await ledger.chargeDebt({ budgetId: "b", holdKey: "k1", role: "late", amount: 5 });
		expect(ensured).toBe(0);
		expect(debited).toEqual([TrustTBClient.deriveAccountId(debtAccountLabel("b"))]);
	});
});
