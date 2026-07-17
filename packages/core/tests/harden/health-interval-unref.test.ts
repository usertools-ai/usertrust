import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
	TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
	CreateAccountError: { exists: 1 },
	CreateTransferError: { exceeds_credits: 22, overflows_debits: 30, overflows_debits_pending: 31 },
	amount_max: (1n << 128n) - 1n,
}));

import { TrustTBClient } from "../../src/ledger/client.js";

describe("TrustTBClient health-check interval (Finding: interval never unref'd)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("unref()s the health-check interval so it cannot keep the process alive", () => {
		const unref = vi.fn();
		const fakeHandle = { unref } as unknown as ReturnType<typeof setInterval>;
		const spy = vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeHandle);

		const client = new TrustTBClient({ addresses: ["3000"] });

		expect(unref).toHaveBeenCalledTimes(1);

		spy.mockRestore();
		client.destroy();
	});
});
