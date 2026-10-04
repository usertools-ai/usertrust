// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.
import { describe, expect, it } from "vitest";
import * as pkg from "../../src/index.js";
import {
	PendingReplayError,
	TBTransferError,
	TransferIdRetiredError,
	TransferReplayMismatchError,
	XFER_SPEND,
} from "../../src/ledger/client.js";

// A caller of `usertrust` must be able to tell these outcomes apart with `instanceof`
// without reaching into an internal path, so all three are part of the package's entry.
describe("ledger replay errors are exported from the package entry", () => {
	it("re-exports the three caller-supplied-id error types (the same classes)", () => {
		expect(pkg.PendingReplayError).toBe(PendingReplayError);
		expect(pkg.TransferReplayMismatchError).toBe(TransferReplayMismatchError);
		expect(pkg.TransferIdRetiredError).toBe(TransferIdRetiredError);
	});
	it("re-exports their base TBTransferError (to read a failed transfer's `code`) and the spend code", () => {
		expect(pkg.TBTransferError).toBe(TBTransferError);
		expect(new pkg.TransferIdRetiredError(1n)).toBeInstanceOf(pkg.TBTransferError);
		expect(pkg.XFER_SPEND).toBe(XFER_SPEND);
	});
});
