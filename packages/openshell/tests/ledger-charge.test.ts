// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { TBTransferError, type TrustTBClient } from "usertrust";
import { describe, expect, it } from "vitest";
import { TigerBeetleLedger, transferIdFor } from "../src/ledger.js";

/**
 * #177 r1 P1: a PERSISTENT refusal between existing accounts (a closed account,
 * accounts_must_have_the_same_ledger) retires each id it touches. Modelled with a stub client:
 * a real cluster cannot be driven into it after a successful reservation, because the debt
 * account is ensured before placement.
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
});
