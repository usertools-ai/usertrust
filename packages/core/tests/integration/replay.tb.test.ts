// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Caller-supplied transfer ids, replayed against a REAL TigerBeetle cluster.
 *
 * `tests/ledger/client.test.ts` proves the replay verification with a mocked
 * `tigerbeetle-node` — a mock that encodes the very TigerBeetle rule the
 * verification relies on, so it cannot prove that rule. These rows run against a
 * live cluster (the version `tb-integration` pins) and, where a row turns on what
 * TigerBeetle itself answers, resubmit the identical transfer through a RAW native
 * client and assert the status the server returns.
 *
 * Self-skips without `USERTRUST_TB_ADDRESS`, like every `*.tb.test.ts`; everything
 * that touches the cluster lives inside `it` bodies.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
	TBTransferError,
	TransferIdRetiredError,
	TransferReplayMismatchError,
	TrustTBClient,
	XFER_ALLOCATION,
	XFER_SPEND,
} from "../../src/ledger/client.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;

const opened: Array<{ destroy(): void }> = [];
afterEach(() => {
	for (const c of opened.splice(0)) c.destroy();
});

async function setup(seed: number) {
	const tb = new TrustTBClient({ addresses: [TB_ADDRESS as string], clusterId: 0n });
	opened.push(tb);
	const treasury = await tb.createTreasury();
	const wallet = await tb.createFundedBudgetWallet(seed);
	// The RAW client: the server's own answer, with nothing of ours in between.
	const tbNode = await import("tigerbeetle-node");
	const raw = tbNode.createClient({ cluster_id: 0n, replica_addresses: [TB_ADDRESS as string] });
	opened.push({ destroy: () => raw.destroy() });
	return { tb, treasury, wallet, raw, tbNode };
}

/** A fresh, valid caller-supplied id through the public derivation. */
const callerId = (role: string) => TrustTBClient.deriveTransferId(randomUUID(), role);

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — caller-supplied transfer id replays", () => {
	it("row 1: a FULL post replayed with a LARGER amount — TigerBeetle itself refuses it (`exists_with_different_amount`)", async () => {
		// Measured on 0.17.9: the server does NOT answer plain `exists` here. The refusal is
		// TigerBeetle's own; the client surfaces it as a TBTransferError carrying that code.
		const { tb, treasury, wallet, raw, tbNode } = await setup(1000);
		const pending = await tb.createPendingTransfer({
			debitAccountId: wallet,
			creditAccountId: treasury,
			amount: 100,
			code: XFER_SPEND,
		});
		const x = callerId("post");
		await tb.postTransfer(pending, 100, { transferId: x });

		const err = await tb.postTransfer(pending, 150, { transferId: x }).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(TBTransferError);
		expect((err as TBTransferError).code).toBe(
			tbNode.CreateTransferStatus.exists_with_different_amount,
		);
		const [res] = await raw.createTransfers([postOf(tbNode, x, pending, 150n)]);
		expect(tbNode.CreateTransferStatus[res?.status ?? -1]).toBe("exists_with_different_amount");
		expect((await tb.lookupTransfer(x))?.amount, "the stored post is untouched").toBe(100n);
	});

	it("row 1b: a FULL post replayed as `amount_max` — the server answers plain `exists`, and the client verifies and accepts it", async () => {
		// The one amount-changing replay TigerBeetle answers plain `exists`: `amount_max` means
		// "the whole pending amount", which the full post already took — the same intent. This
		// is the path the client's verification (assertReplayMatches) actually runs on.
		const { tb, treasury, wallet, raw, tbNode } = await setup(1000);
		const pending = await tb.createPendingTransfer({
			debitAccountId: wallet,
			creditAccountId: treasury,
			amount: 100,
			code: XFER_SPEND,
		});
		const x = callerId("post");
		await tb.postTransfer(pending, 100, { transferId: x });
		expect(await tb.postTransfer(pending, undefined, { transferId: x })).toBe(x);
		const [res] = await raw.createTransfers([postOf(tbNode, x, pending, tbNode.amount_max)]);
		expect(tbNode.CreateTransferStatus[res?.status ?? -1]).toBe("exists");
		const [acct] = await tb.lookupAccounts([wallet]);
		expect(acct?.debits_posted, "posted once").toBe(100n);
	});

	it("row 2: a PARTIAL post replayed as `amount_max` — TigerBeetle itself refuses it (`exists_with_different_amount`)", async () => {
		// Which layer refuses: the SERVER. The partial post stored 60; `amount_max` would mean
		// the full 100, and 0.17.9 answers `exists_with_different_amount` before the client's
		// verification is ever reached.
		const { tb, treasury, wallet, raw, tbNode } = await setup(1000);
		const pending = await tb.createPendingTransfer({
			debitAccountId: wallet,
			creditAccountId: treasury,
			amount: 100,
			code: XFER_SPEND,
		});
		const x = callerId("post");
		await tb.postTransfer(pending, 60, { transferId: x });

		const err = await tb.postTransfer(pending, undefined, { transferId: x }).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(TransferReplayMismatchError);
		expect((err as TBTransferError).code).toBe(
			tbNode.CreateTransferStatus.exists_with_different_amount,
		);
		const [res] = await raw.createTransfers([postOf(tbNode, x, pending, tbNode.amount_max)]);
		expect(tbNode.CreateTransferStatus[res?.status ?? -1]).toBe("exists_with_different_amount");
		const [acct] = await tb.lookupAccounts([wallet]);
		expect(acct?.debits_posted, "only the partial post moved money").toBe(60n);
	});

	it("row 3: an IDENTICAL replay succeeds, and the ledger holds exactly one posted transfer", async () => {
		const { tb, treasury, wallet } = await setup(1000);
		const pending = await tb.createPendingTransfer({
			debitAccountId: wallet,
			creditAccountId: treasury,
			amount: 100,
			code: XFER_SPEND,
		});
		const x = callerId("post");
		expect(await tb.postTransfer(pending, 100, { transferId: x })).toBe(x);
		expect(await tb.postTransfer(pending, 100, { transferId: x })).toBe(x);

		const stored = await tb.lookupTransfer(x);
		expect(stored?.amount).toBe(100n);
		expect(stored?.pending_id).toBe(pending);
		const [acct] = await tb.lookupAccounts([wallet]);
		expect(acct?.debits_posted, "posted ONCE, not twice").toBe(100n);
		expect(acct?.debits_pending).toBe(0n);
	});

	it("row 4: an id whose first attempt FAILED is retired — after a top-up the same id is refused", async () => {
		const { tb, treasury, wallet, raw, tbNode } = await setup(50);
		const r = callerId("hold");
		const hold = {
			debitAccountId: wallet,
			creditAccountId: treasury,
			amount: 100,
			code: XFER_SPEND,
			transferId: r,
		};
		await expect(tb.createPendingTransfer(hold)).rejects.toMatchObject({
			code: tbNode.CreateTransferStatus.exceeds_credits,
		});
		await tb.immediateTransfer({
			debitAccountId: treasury,
			creditAccountId: wallet,
			amount: 100,
			code: XFER_ALLOCATION,
		});
		await expect(tb.createPendingTransfer(hold)).rejects.toBeInstanceOf(TransferIdRetiredError);
		// The server's own answer for the retired id.
		const [res] = await raw.createTransfers([
			{
				id: r,
				debit_account_id: wallet,
				credit_account_id: treasury,
				amount: 100n,
				pending_id: 0n,
				user_data_128: 0n,
				user_data_64: 0n,
				user_data_32: 0,
				timeout: 300,
				ledger: 1,
				code: XFER_SPEND,
				flags: tbNode.TransferFlags.pending,
				timestamp: 0n,
			},
		]);
		expect(tbNode.CreateTransferStatus[res?.status ?? -1]).toBe("id_already_failed");
		// And nothing was reserved by either attempt.
		const [acct] = await tb.lookupAccounts([wallet]);
		expect(acct?.debits_pending).toBe(0n);
	});

	it("row 6 (#178): an IMMEDIATE transfer whose first attempt failed is retired — after a top-up the same caller id is TransferIdRetiredError", async () => {
		const { tb, treasury, wallet } = await setup(50);
		const r = callerId("debit");
		const debit = {
			debitAccountId: wallet,
			creditAccountId: treasury,
			amount: 100,
			code: XFER_SPEND,
			transferId: r,
		};
		const first = await tb.immediateTransfer(debit).catch((e: unknown) => e);
		expect(first).toBeInstanceOf(TBTransferError);
		expect(first).not.toBeInstanceOf(TransferIdRetiredError); // the real code, not 68
		await tb.immediateTransfer({
			debitAccountId: treasury,
			creditAccountId: wallet,
			amount: 100,
			code: XFER_ALLOCATION,
		});
		const second = await tb.immediateTransfer(debit).catch((e: unknown) => e);
		expect(second).toBeInstanceOf(TransferIdRetiredError);
		expect((second as TBTransferError).code).toBe(68);
		const [acct] = await tb.lookupAccounts([wallet]);
		expect(acct?.debits_posted, "neither attempt moved money").toBe(0n);
	});

	it("row 6b (#178): an IDENTICAL immediate replay under a caller id is verified and accepted; the account is debited once", async () => {
		const { tb, treasury, wallet } = await setup(500);
		const debit = {
			debitAccountId: wallet,
			creditAccountId: treasury,
			amount: 120,
			code: XFER_SPEND,
			transferId: callerId("debit"),
		};
		expect(await tb.immediateTransfer(debit)).toBe(debit.transferId);
		expect(await tb.immediateTransfer(debit)).toBe(debit.transferId);
		const [acct] = await tb.lookupAccounts([wallet]);
		expect(acct?.debits_posted).toBe(120n);
	});

	it("row 5: a VOID replayed with the same id succeeds, and the hold is released once", async () => {
		const { tb, treasury, wallet } = await setup(1000);
		const pending = await tb.createPendingTransfer({
			debitAccountId: wallet,
			creditAccountId: treasury,
			amount: 100,
			code: XFER_SPEND,
		});
		const v = callerId("void");
		expect(await tb.voidTransfer(pending, { transferId: v })).toBe(v);
		expect(await tb.voidTransfer(pending, { transferId: v })).toBe(v);
		const [acct] = await tb.lookupAccounts([wallet]);
		expect(acct?.debits_pending).toBe(0n);
		expect(acct?.debits_posted).toBe(0n);
	});

	it("control: a replay through a DIFFERENT id is not a replay — it is refused as already posted", async () => {
		// Proves rows 1–3 exercise the SAME-id path: a fresh id against an already-posted
		// pending transfer is TigerBeetle's own refusal, not our verification.
		const { tb, treasury, wallet } = await setup(1000);
		const pending = await tb.createPendingTransfer({
			debitAccountId: wallet,
			creditAccountId: treasury,
			amount: 100,
			code: XFER_SPEND,
		});
		await tb.postTransfer(pending, 100, { transferId: callerId("post") });
		const err = await tb.postTransfer(pending, 100, { transferId: callerId("post") }).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(TransferReplayMismatchError);
	});
});

/** The exact post the client submits (ledger/client.ts postTransfer), built raw. */
function postOf(
	tbNode: typeof import("tigerbeetle-node"),
	id: bigint,
	pendingId: bigint,
	amount: bigint,
) {
	return {
		id,
		debit_account_id: 0n,
		credit_account_id: 0n,
		amount,
		pending_id: pendingId,
		user_data_128: 0n,
		user_data_64: 0n,
		user_data_32: 0,
		timeout: 0,
		ledger: 0,
		code: 0,
		flags: tbNode.TransferFlags.post_pending_transfer,
		timestamp: 0n,
	};
}
