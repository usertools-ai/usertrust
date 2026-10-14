// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// A stand-in for tigerbeetle-node, for a CLI run in its own process (fake-tigerbeetle-register.mjs).
// `FAKE_TB_MODE` says how its clients behave, as a 0.17.9 client does:
//  - "healthy": every request answers;
//  - "evict-after-read": a client answers one read, then learns the cluster evicted it while idle,
//    and fails every request after that "closed";
//  - "evicted": every client fails every request "closed" from the start.
// Each client holds the event loop until it is destroyed, as a native client does, and destroying
// an evicted one aborts the process (SIGABRT), as tigerbeetle-node 0.17.9 does.
const mode = process.env.FAKE_TB_MODE ?? "healthy";

const closed = () => Object.assign(new Error("Client was closed."), { code: "ERR_CLIENT_CLOSED" });

export function createClient() {
	let evicted = mode === "evicted";
	let open = true;
	const hold = setInterval(() => {}, 60_000);
	const request = async (ids) => {
		if (!open || evicted) throw closed();
		if (mode === "evict-after-read" && ids.length > 0) evicted = true;
		return [{ id: 1n, credits_posted: 750n, debits_posted: 0n, debits_pending: 0n }].slice(
			0,
			ids.length > 0 ? 1 : 0,
		);
	};
	return {
		lookupAccounts: request,
		createAccounts: async () => [],
		createTransfers: async () => [],
		lookupTransfers: async () => [],
		destroy() {
			if (evicted) process.kill(process.pid, "SIGABRT");
			open = false;
			clearInterval(hold);
		},
	};
}

export const AccountFlags = { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 };
export const TransferFlags = { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 };
export const CreateAccountStatus = {
	created: 4294967295,
	exists: 1,
	exists_with_different_flags: 2,
};
export const CreateTransferStatus = {
	created: 4294967295,
	exceeds_credits: 22,
	overflows_debits: 30,
	overflows_debits_pending: 31,
};
export const amount_max = (1n << 128n) - 1n;
