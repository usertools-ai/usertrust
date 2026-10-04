// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.
import { describe, expect, it } from "vitest";
import * as pkg from "../../src/index.js";
import {
	PendingReplayError,
	TransferIdRetiredError,
	TransferReplayMismatchError,
} from "../../src/ledger/client.js";

// A caller of `usertrust` must be able to tell these outcomes apart with `instanceof`
// without reaching into an internal path, so all three are part of the package's entry.
describe("ledger replay errors are exported from the package entry", () => {
	it("re-exports the three caller-supplied-id error types (the same classes)", () => {
		expect(pkg.PendingReplayError).toBe(PendingReplayError);
		expect(pkg.TransferReplayMismatchError).toBe(TransferReplayMismatchError);
		expect(pkg.TransferIdRetiredError).toBe(TransferIdRetiredError);
	});
});
