// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * FIRST-RUN-A — a PROVIDER auth failure must not read as "usertrust is broken".
 *
 * `dryRun: true` skips the LEDGER, not the PROVIDER, so a quickstart run with no
 * valid `ANTHROPIC_API_KEY` surfaces a raw `AuthenticationError: 401` whose stack
 * names `interceptCall (usertrust/dist/govern.js…)`. Governance worked; the key
 * did not. The hint says so — by APPENDING to the original error instance, never
 * by wrapping or reconstructing it, because consumers key retry logic on
 * `instanceof Anthropic.AuthenticationError` and `err.status === 401`.
 */

import { describe, expect, it, vi } from "vitest";
import { _looksLikeProviderAuthFailure as looksLikeProviderAuthFailure } from "../../src/govern.js";

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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

describe("looksLikeProviderAuthFailure", () => {
	it("matches a 401 from any provider shape", () => {
		expect(looksLikeProviderAuthFailure({ status: 401 })).toBe(true);
		expect(looksLikeProviderAuthFailure({ statusCode: 401 })).toBe(true);
		expect(
			looksLikeProviderAuthFailure(
				Object.assign(new Error("401 authentication_error: API key is invalid."), {}),
			),
		).toBe(true);
		expect(looksLikeProviderAuthFailure({ error: { type: "authentication_error" } })).toBe(true);
	});

	it("does NOT match unrelated failures", () => {
		expect(looksLikeProviderAuthFailure({ status: 500 })).toBe(false);
		expect(looksLikeProviderAuthFailure({ status: 403 })).toBe(false); // valid key, no access
		expect(
			looksLikeProviderAuthFailure(
				new Proxy(
					{},
					{
						get() {
							throw new Error("hostile getter");
						},
					},
				),
			),
		).toBe(false); // must not throw out of the catch path
		expect(looksLikeProviderAuthFailure({ status: 429 })).toBe(false);
		expect(looksLikeProviderAuthFailure(new Error("socket hang up"))).toBe(false);
		expect(looksLikeProviderAuthFailure(new Error("overloaded_error"))).toBe(false);
		expect(looksLikeProviderAuthFailure(null)).toBe(false);
		expect(looksLikeProviderAuthFailure(undefined)).toBe(false);
	});
});
