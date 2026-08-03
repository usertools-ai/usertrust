import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock variables so they're available inside the vi.mock factory
const {
	mockCreateAccounts,
	mockCreateTransfers,
	mockLookupAccounts,
	mockLookupTransfers,
	mockDestroy,
	mockClient,
	mockCreateClient,
} = vi.hoisted(() => {
	const mockCreateAccounts = vi.fn();
	const mockCreateTransfers = vi.fn();
	const mockLookupAccounts = vi.fn();
	const mockLookupTransfers = vi.fn();
	const mockDestroy = vi.fn();

	const mockClient = {
		createAccounts: mockCreateAccounts,
		createTransfers: mockCreateTransfers,
		lookupAccounts: mockLookupAccounts,
		lookupTransfers: mockLookupTransfers,
		destroy: mockDestroy,
	};

	const mockCreateClient = vi.fn(() => mockClient);

	return {
		mockCreateAccounts,
		mockCreateTransfers,
		mockLookupAccounts,
		mockLookupTransfers,
		mockDestroy,
		mockClient,
		mockCreateClient,
	};
});

vi.mock("tigerbeetle-node", () => ({
	createClient: mockCreateClient,
	AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
	TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
	CreateAccountStatus: {
		created: 4294967295,
		exists: 1,
		// The real binding's values. Only bare `exists` is success; these two stand in
		// for the rest of the family, which every door must refuse.
		exists_with_different_flags: 15,
		exists_with_different_ledger: 19,
	},
	CreateTransferStatus: {
		created: 4294967295,
		exceeds_credits: 22,
		overflows_debits: 30,
		overflows_debits_pending: 31,
		// The real binding's value — a transfer with this id already committed.
		exists: 46,
	},
	amount_max: (1n << 128n) - 1n,
}));

import { AccountFlags, CreateAccountStatus } from "tigerbeetle-node";
import {
	CODE_ESCROW,
	CODE_PLATFORM_TREASURY,
	CODE_USER_WALLET,
	LEDGER_USERTOKENS,
	TBTransferError,
	TrustTBClient,
	XFER_A2A_DELEGATION,
	XFER_ALLOCATION,
	XFER_PURCHASE,
	XFER_REFUND,
	XFER_SPEND,
	XFER_TOOL_CALL,
	XFER_TRANSFER,
} from "../../src/ledger/client.js";

/** Reset mockCreateClient to the default implementation (return mockClient). */
function resetCreateClient() {
	mockCreateClient.mockImplementation(() => mockClient);
}

describe("TrustTBClient", () => {
	let client: TrustTBClient;

	beforeEach(() => {
		vi.clearAllMocks();
		resetCreateClient();
		vi.useFakeTimers();
		client = new TrustTBClient({ addresses: ["3000"] });
	});

	afterEach(() => {
		client.destroy();
		vi.useRealTimers();
	});

	describe("deriveAccountId", () => {
		it("returns deterministic bigint for same userId", () => {
			const id1 = TrustTBClient.deriveAccountId("user_123");
			const id2 = TrustTBClient.deriveAccountId("user_123");
			expect(id1).toBe(id2);
		});

		it("returns different IDs for different users", () => {
			const id1 = TrustTBClient.deriveAccountId("user_123");
			const id2 = TrustTBClient.deriveAccountId("user_456");
			expect(id1).not.toBe(id2);
		});

		it("returns a bigint", () => {
			const id = TrustTBClient.deriveAccountId("test");
			expect(typeof id).toBe("bigint");
		});
	});

	describe("deriveCostCenterAccountId — tuple domain separation", () => {
		// Known answers computed OUTSIDE the implementation (spec: sha256("usertrust:cost-center:v1"
		// ‖ u32be(|p|) ‖ p ‖ u32be(|c|) ‖ c), first 16 bytes). Spelled out, never imported, so this
		// suite polices the derivation instead of following it — including any domain-tag change.
		it("matches the pinned known answer for (acme, billing)", () => {
			expect(TrustTBClient.deriveCostCenterAccountId("acme", "billing")).toBe(
				153698412649693138325753473963527840061n,
			);
		});
		it("matches the pinned known answer for a colon-bearing parent", () => {
			expect(TrustTBClient.deriveCostCenterAccountId("acct:123", "research")).toBe(
				112969331358731418235272055848009854886n,
			);
		});
		it("is disjoint from the wallet namespace", () => {
			// 339169140118482546062612604151268776219n = sha256("wallet:acme::billing") first 128
			// bits, spelled out so this proof does not follow a change in either derivation.
			const id = TrustTBClient.deriveCostCenterAccountId("acme", "billing");
			expect(id).not.toBe(339169140118482546062612604151268776219n);
			expect(id).not.toBe(TrustTBClient.deriveAccountId("acme"));
			expect(id).not.toBe(TrustTBClient.deriveAccountId("billing"));
			expect(id).not.toBe(TrustTBClient.deriveAccountId("acme::billing"));
		});
		it("length prefixes make boundary shifts distinct", () => {
			const d = TrustTBClient.deriveCostCenterAccountId.bind(TrustTBClient);
			expect(d("ab", "c")).not.toBe(d("a", "bc"));
			expect(d("a:", "b")).not.toBe(d("a", ":b"));
			expect(d("a::b", "c")).not.toBe(d("a", "b::c"));
			expect(d("a", "")).not.toBe(d("", "a"));
		});
		it("is byte-exact: no Unicode normalization, UTF-8 byte-length prefixes", () => {
			const d = TrustTBClient.deriveCostCenterAccountId.bind(TrustTBClient);
			// NFC "é" (2 bytes, \u00e9) vs NFD "é" (3 bytes, "e" + \u0301 combining
			// acute): canonically equivalent, different bytes, MUST derive different ids --
			// normalizing would alias two byte strings to one account. Written with explicit
			// \u escapes, not the literal glyph, so the NFC/NFD distinction survives any
			// encoding-lossy round trip through an editor, terminal, or diff tool.
			expect(d("\u00e9", "x")).not.toBe(d("e\u0301", "x"));
			// Pins the BYTE-length prefix: a code-unit prefix writes 1 for "é" and derives
			// 68069851642113482633497729179357140435n instead. Computed outside the implementation.
			expect(d("\u00e9", "x")).toBe(7822644739665374224199629721231252559n);
		});
		it("is pure and total over strings — validation lives at the doors, not here", () => {
			// Deterministic on any input, hostile or not (mirrors deriveAccountId's contract).
			const d = TrustTBClient.deriveCostCenterAccountId.bind(TrustTBClient);
			expect(d("\x00\x1b[2J", ":::")).toBe(d("\x00\x1b[2J", ":::"));
		});
	});

	describe("createUserWallet", () => {
		it("creates account and returns account ID", async () => {
			mockCreateAccounts.mockResolvedValueOnce([]);
			const id = await client.createUserWallet("user_1");
			expect(typeof id).toBe("bigint");
			expect(mockCreateAccounts).toHaveBeenCalledOnce();
		});

		it("returns cached ID on second call", async () => {
			mockCreateAccounts.mockResolvedValueOnce([]);
			const id1 = await client.createUserWallet("user_2");
			const id2 = await client.createUserWallet("user_2");
			expect(id1).toBe(id2);
			expect(mockCreateAccounts).toHaveBeenCalledTimes(1);
		});

		it("handles account-already-exists gracefully", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ status: 1 }]); // exists
			const id = await client.createUserWallet("user_3");
			expect(typeof id).toBe("bigint");
		});

		it("throws on other creation errors", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ status: 99 }]);
			await expect(client.createUserWallet("user_4")).rejects.toThrow("Failed to create account");
		});

		it("throws when error array element is undefined", async () => {
			mockCreateAccounts.mockResolvedValueOnce([undefined]);
			await expect(client.createUserWallet("user_undef")).rejects.toThrow(
				"Unknown account/transfer error",
			);
		});

		it("retries on connection error via withReconnect", async () => {
			mockCreateAccounts
				.mockRejectedValueOnce(new Error("connection refused"))
				.mockResolvedValueOnce([]);
			const id = await client.createUserWallet("user_reconnect");
			expect(typeof id).toBe("bigint");
			expect(mockCreateAccounts).toHaveBeenCalledTimes(2);
		});

		// QUARANTINE, not the retired derivation reservation. On a cluster upgraded
		// from v2.x an unreclaimed cost center still occupies
		// deriveAccountId("acme::billing") with CODE_USER_WALLET and an ordinary
		// wallet's flags, so this call would be answered bare `exists` — not
		// exists_with_different_flags — and adopt that stranded balance as a new
		// owner's wallet, silently. Refuse the name and it stays unadoptable.
		it("refuses an ordinary wallet id containing `::`", async () => {
			await expect(client.createUserWallet("acme::billing")).rejects.toThrow(
				/"::" is reserved for pre-v3 cost-center accounts/,
			);
			await expect(client.createUserWallet("a::b::c")).rejects.toThrow(/Invalid userId/);
			// Refused at the door — TigerBeetle never sees the legacy account id.
			expect(mockCreateAccounts).not.toHaveBeenCalled();
		});

		// Single `:` is what issue #64 asked for and is untouched by the quarantine —
		// only the doubled separator names a pre-v3 cost-center account.
		it("still accepts every ordinary id that does not use the separator", async () => {
			mockCreateAccounts.mockResolvedValue([]);
			for (const userId of ["acme-billing", "acme:billing", "a:b:c", "a.b@c.com", "user_1"]) {
				const id = await client.createUserWallet(userId);
				expect(id).toBe(TrustTBClient.deriveAccountId(userId));
			}
		});

		// The `{ derived: true }` opt-in is gone with its last caller. There is nothing
		// left for a string-typed flag to mean: a cost-center account is reached only by
		// passing the PAIR to createCostCenterWallet, and no single string is a preimage
		// of one. This method takes one argument again.
		it("takes no options object", () => {
			expect(client.createUserWallet.length).toBe(1);
		});
	});

	describe("createCostCenterWallet", () => {
		// The KATs are spelled out, never recomputed from the static: this suite is a
		// door test, and a door that follows its own derivation proves nothing. Same
		// answers as the derivation KAT suite above, on purpose. Exception: the
		// pattern-boundary test below deliberately recomputes from the static — a
		// 128/64-char KAT would be unreadable.
		const ACME_BILLING = 153698412649693138325753473963527840061n;
		const ACCT123_RESEARCH = 112969331358731418235272055848009854886n;

		it("returns the derived id on the created path", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ status: CreateAccountStatus.created }]);
			await expect(client.createCostCenterWallet("acme", "billing")).resolves.toBe(ACME_BILLING);
			expect(mockCreateAccounts.mock.calls[0]?.[0][0].id).toBe(ACME_BILLING);
		});

		// `exists` IS SUCCESS, and the id is what makes that safe: it is derived from
		// the tuple, so the account that already exists is the account this call asked
		// for. Asserting the id on this path is what proves it — a door that returned a
		// cached or colliding id here would hand back someone else's balance.
		it("returns the same derived id on the exists path", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ status: CreateAccountStatus.exists }]);
			await expect(client.createCostCenterWallet("acme", "billing")).resolves.toBe(ACME_BILLING);
		});

		it("is idempotent across sequential calls", async () => {
			mockCreateAccounts
				.mockResolvedValueOnce([{ status: CreateAccountStatus.created }])
				.mockResolvedValueOnce([{ status: CreateAccountStatus.exists }]);
			await expect(client.createCostCenterWallet("acme", "billing")).resolves.toBe(ACME_BILLING);
			await expect(client.createCostCenterWallet("acme", "billing")).resolves.toBe(ACME_BILLING);
			// No in-process short-circuit: the second call still reaches TigerBeetle.
			expect(mockCreateAccounts).toHaveBeenCalledTimes(2);
		});

		it("tolerates an empty result array", async () => {
			mockCreateAccounts.mockResolvedValueOnce([]);
			await expect(client.createCostCenterWallet("acme", "billing")).resolves.toBe(ACME_BILLING);
		});

		// Balance enforcement is the whole point of a budget wallet: without
		// debits_must_not_exceed_credits a cost center can overspend its allocation.
		it("creates a balance-enforced user wallet on the usertokens ledger", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ status: CreateAccountStatus.created }]);
			await client.createCostCenterWallet("acme", "billing");
			const account = mockCreateAccounts.mock.calls[0]?.[0][0];
			expect(account.flags).toBe(
				AccountFlags.debits_must_not_exceed_credits | AccountFlags.history,
			);
			expect(account.code).toBe(CODE_USER_WALLET);
			expect(account.ledger).toBe(LEDGER_USERTOKENS);
		});

		// An account that exists with different flags is an account missing its
		// enforcement — accepting it would hand back an unenforced wallet.
		it("rejects exists_with_different_flags", async () => {
			mockCreateAccounts.mockResolvedValueOnce([
				{ status: CreateAccountStatus.exists_with_different_flags },
			]);
			await expect(client.createCostCenterWallet("acme", "billing")).rejects.toThrow(
				"Failed to create cost-center wallet",
			);
		});

		// Representative of every OTHER `exists_with_different_*`: only bare `exists`
		// is success, and the enumeration is not "anything that starts with exists".
		it("rejects a non-flags exists_with_different_* status", async () => {
			mockCreateAccounts.mockResolvedValueOnce([
				{ status: CreateAccountStatus.exists_with_different_ledger },
			]);
			await expect(client.createCostCenterWallet("acme", "billing")).rejects.toThrow(
				"Failed to create cost-center wallet",
			);
		});

		it("rejects any other non-ok status", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ status: 99 }]);
			await expect(client.createCostCenterWallet("acme", "billing")).rejects.toThrow(
				"Failed to create cost-center wallet",
			);
		});

		it("throws when the result element is undefined", async () => {
			mockCreateAccounts.mockResolvedValueOnce([undefined]);
			await expect(client.createCostCenterWallet("acme", "billing")).rejects.toThrow(
				"Unknown account/transfer error",
			);
		});

		// Belt to the budget path's braces. The derivation is total over strings, so
		// nothing below is refused by the hash — the door is the only thing between a
		// control character and an audit event that quotes it.
		it("refuses inputs outside the patterns before reaching TigerBeetle", async () => {
			await expect(client.createCostCenterWallet("acme\x1b[2J", "billing")).rejects.toThrow(
				/parentUserId/,
			);
			await expect(client.createCostCenterWallet("", "billing")).rejects.toThrow(/parentUserId/);
			await expect(client.createCostCenterWallet("p".repeat(129), "billing")).rejects.toThrow(
				/parentUserId/,
			);
			await expect(client.createCostCenterWallet("acme", "bad cc!")).rejects.toThrow(/costCenter/);
			await expect(client.createCostCenterWallet("acme", "")).rejects.toThrow(/costCenter/);
			await expect(client.createCostCenterWallet("acme", "c".repeat(65))).rejects.toThrow(
				/costCenter/,
			);
			// A cost center may not carry a colon: the display label's injectivity is
			// what makes the maximal colon-free suffix recover the tuple.
			await expect(client.createCostCenterWallet("acme", "a:b")).rejects.toThrow(/costCenter/);
			expect(mockCreateAccounts).not.toHaveBeenCalled();
		});

		// The types do not reach a JS caller, and `PATTERN.test(undefined)` matches the
		// STRING "undefined" — so the typeof guard is what refuses these, not the regex.
		it("refuses non-string inputs a JS caller can still pass", async () => {
			await expect(
				client.createCostCenterWallet(null as unknown as string, "billing"),
			).rejects.toThrow(/parentUserId/);
			await expect(client.createCostCenterWallet("acme", 123 as unknown as string)).rejects.toThrow(
				/costCenter/,
			);
			expect(mockCreateAccounts).not.toHaveBeenCalled();
		});

		// Issue #64: the tuple hash is length-prefixed, so a colon in the parent can no
		// longer make two tuples collide — the door admits it.
		it("admits a colon-bearing parent id", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ status: CreateAccountStatus.created }]);
			await expect(client.createCostCenterWallet("acct:123", "research")).resolves.toBe(
				ACCT123_RESEARCH,
			);
		});

		// The quarantine reaches parent ids through the shared `parentUserIdRefusal`,
		// and names itself distinctly from the charset message: `acme::x` PASSES
		// PARENT_USER_ID_PATTERN, so quoting that regex at the operator would read as
		// admitting the id it just refused. The failure being prevented is one level
		// down — deriveAccountId("acme::x") is an unreclaimed pre-v3 cost-center
		// account on an upgraded cluster, and allocation debits the parent by that id.
		it("refuses a `::`-bearing parent id, distinctly from the charset refusal", async () => {
			await expect(client.createCostCenterWallet("acme::x", "research")).rejects.toThrow(
				/Invalid parentUserId: must not contain "::" \(reserved for pre-v3 cost-center accounts\)/,
			);
			// Same door, different reason — the two messages must not be confusable.
			await expect(client.createCostCenterWallet("acme\x1b[2J", "research")).rejects.toThrow(
				/Invalid parentUserId: must match/,
			);
			expect(mockCreateAccounts).not.toHaveBeenCalled();
		});

		it("accepts both parts at their pattern boundaries", async () => {
			for (const [parent, cc] of [
				["p", "c"],
				["p".repeat(128), "c"],
				["p", "c".repeat(64)],
				["p".repeat(128), "c".repeat(64)],
			] as const) {
				mockCreateAccounts.mockResolvedValueOnce([{ status: CreateAccountStatus.created }]);
				await expect(client.createCostCenterWallet(parent, cc)).resolves.toBe(
					TrustTBClient.deriveCostCenterAccountId(parent, cc),
				);
			}
		});

		// ASCII is DOOR POLICY, not a property of the derivation: the static derives
		// "é" fine and deterministically, and the door still refuses it. Loosening the
		// pattern is therefore a policy decision, not a derivation change.
		it("refuses a multibyte parent the derivation itself handles fine", async () => {
			expect(typeof TrustTBClient.deriveCostCenterAccountId("é", "billing")).toBe("bigint");
			await expect(client.createCostCenterWallet("é", "billing")).rejects.toThrow(/parentUserId/);
			expect(mockCreateAccounts).not.toHaveBeenCalled();
		});

		// The id is derived, never looked up — so caching it would only create a second
		// source of truth that a fresh client in another process would not share.
		it("writes nothing to the in-process account map", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ status: CreateAccountStatus.created }]);
			await client.createCostCenterWallet("acme", "billing");
			for (const name of ["acme", "billing", "acme::billing"]) {
				expect(() => client.getAccountId(name)).toThrow(/No TigerBeetle account/);
			}
		});
	});

	// Ordinary wallet ids and escrow labels are still hashed through the SAME
	// `wallet:` namespace as each other (deriveAccountId), and collide safely
	// only because their differing account flags make TigerBeetle answer
	// `exists_with_different_flags` rather than silently sharing a balance.
	//
	// `parent::costCenter`-shaped names are QUARANTINED out of that namespace at
	// both doors. Not because v3 derives anything from them — the real
	// cost-center space is the domain-separated tuple hash, unreachable from
	// either door — but because on a cluster upgraded from v2.x those exact names
	// still address unreclaimed legacy cost-center accounts, which a v3 wallet
	// would hash onto and adopt.
	describe("wallet/escrow shared namespace", () => {
		// Spelled out rather than imported from budget/allocation.ts so this proof
		// does not silently follow a change in the derivation it is meant to police.
		const PARENT = "acme";
		const COST_CENTER = "billing";
		const DERIVED = `${PARENT}::${COST_CENTER}`;

		// The legacy account is flag-identical to an ordinary wallet, so TigerBeetle
		// would answer bare `exists` and this door would read that as success —
		// handing back a stranded cost center's balance under a new owner's name.
		it("refuses a `parent::costCenter`-shaped id at the createUserWallet door", async () => {
			await expect(client.createUserWallet(DERIVED)).rejects.toThrow(
				/"::" is reserved for pre-v3 cost-center accounts/,
			);
			expect(mockCreateAccounts).not.toHaveBeenCalled();
		});

		// The other door into deriveAccountId, refused for the same reason. Escrow's
		// flags differ from a wallet's TODAY, so this particular label would hit
		// exists_with_different_flags — but that is a property of the current account
		// codes, not of the names, and the quarantine holds at every door rather than
		// only where a flag mismatch happens to save us.
		it("refuses a `parent::costCenter`-shaped label at the ensureEscrowAccount door", async () => {
			await expect(client.ensureEscrowAccount(DERIVED)).rejects.toThrow(
				/Invalid escrow label: "::" is reserved for pre-v3 cost-center accounts/,
			);
			expect(mockCreateAccounts).not.toHaveBeenCalled();
		});

		it("still accepts ordinary escrow labels, single colon included", async () => {
			mockCreateAccounts.mockResolvedValue([]);
			const id = await client.ensureEscrowAccount("escrow:session-1");
			expect(id).toBe(TrustTBClient.deriveAccountId("escrow:session-1"));
			const plain = await client.ensureEscrowAccount("session-1");
			expect(plain).toBe(TrustTBClient.deriveAccountId("session-1"));
		});

		// The cost-center wallet for the SAME pair is a different account entirely, and
		// the two doors cannot be talked into swapping: one takes a string, the other a
		// pair, and neither derivation shares a preimage with the other.
		it("creates the cost-center wallet at the tuple id, not the label's", async () => {
			mockCreateAccounts.mockResolvedValueOnce([]);
			const id = await client.createCostCenterWallet(PARENT, COST_CENTER);
			expect(id).toBe(TrustTBClient.deriveCostCenterAccountId(PARENT, COST_CENTER));
			expect(id).not.toBe(TrustTBClient.deriveAccountId(DERIVED));
		});
	});

	describe("createPendingTransfer", () => {
		it("creates transfer and returns transfer ID", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.createPendingTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 100,
				code: XFER_SPEND,
			});
			expect(typeof id).toBe("bigint");
			expect(mockCreateTransfers).toHaveBeenCalledOnce();
		});

		it("throws TBTransferError on failure", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ status: 22 }]);
			await expect(
				client.createPendingTransfer({
					debitAccountId: 1n,
					creditAccountId: 2n,
					amount: 100,
					code: XFER_SPEND,
				}),
			).rejects.toThrow(TBTransferError);
		});

		it("throws when error array element is undefined", async () => {
			mockCreateTransfers.mockResolvedValueOnce([undefined]);
			await expect(
				client.createPendingTransfer({
					debitAccountId: 1n,
					creditAccountId: 2n,
					amount: 100,
					code: XFER_SPEND,
				}),
			).rejects.toThrow("Unknown account/transfer error");
		});

		it("passes optional userData and timeout fields", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			await client.createPendingTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 50,
				code: XFER_SPEND,
				timeoutSeconds: 600,
				userData128: 42n,
				userData64: 7n,
				userData32: 99,
			});
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.user_data_128).toBe(42n);
			expect(transfer.user_data_64).toBe(7n);
			expect(transfer.user_data_32).toBe(99);
			expect(transfer.timeout).toBe(600);
		});

		it("defaults timeout to 300 seconds", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			await client.createPendingTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 50,
				code: XFER_SPEND,
			});
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.timeout).toBe(300);
		});

		// The id is generated OUTSIDE the withReconnect closure, so the retry
		// resubmits the same id and TigerBeetle answers `exists`. Throwing there
		// would report a failed reservation against funds TB is already holding —
		// the caller would never post or void them.
		it("treats `exists` on a reconnect retry as the committed reservation it is", async () => {
			mockCreateTransfers
				.mockRejectedValueOnce(new Error("connection refused"))
				.mockResolvedValueOnce([{ status: 46 }]);

			const id = await client.createPendingTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 100,
				code: XFER_SPEND,
			});

			expect(typeof id).toBe("bigint");
			expect(mockCreateTransfers).toHaveBeenCalledTimes(2);
			// Same id on both attempts — that identity is what makes `exists` proof.
			const first = mockCreateTransfers.mock.calls[0]?.[0][0].id;
			expect(mockCreateTransfers.mock.calls[1]?.[0][0].id).toBe(first);
			expect(id).toBe(first);
		});

		// `exists` means every field matched; a mismatch is a distinct code and is
		// still a hard failure.
		it("still throws when the pending id exists with different terms", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ status: 39 }]); // exists_with_different_amount
			await expect(
				client.createPendingTransfer({
					debitAccountId: 1n,
					creditAccountId: 2n,
					amount: 100,
					code: XFER_SPEND,
				}),
			).rejects.toThrow(TBTransferError);
		});
	});

	describe("postTransfer", () => {
		it("posts pending transfer", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.postTransfer(123n);
			expect(typeof id).toBe("bigint");
		});

		it("throws on failure", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ status: 5 }]);
			await expect(client.postTransfer(123n)).rejects.toThrow("Post transfer failed");
		});

		it("throws when error array element is undefined", async () => {
			mockCreateTransfers.mockResolvedValueOnce([undefined]);
			await expect(client.postTransfer(123n)).rejects.toThrow("Unknown account/transfer error");
		});

		it("uses amount_max when no amount provided", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			await client.postTransfer(123n);
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.amount).toBe((1n << 128n) - 1n);
		});

		it("uses specified amount when provided", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			await client.postTransfer(123n, 42);
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.amount).toBe(42n);
		});

		// This is the live metering settlement path (govern.ts postPendingSpend).
		// The post id is generated OUTSIDE the withReconnect closure, so the retry
		// resubmits the same id and TigerBeetle answers `exists`. Throwing there
		// would report a failed settlement for a spend that committed — the governor
		// would leave the entry in pendingMap and then void an already-posted
		// transfer, so the ledger holds the debit and the governor does not.
		it("treats `exists` on a reconnect retry as the settled post it is", async () => {
			mockCreateTransfers
				.mockRejectedValueOnce(new Error("ECONNRESET"))
				.mockResolvedValueOnce([{ status: 46 }]);

			const id = await client.postTransfer(123n);

			expect(typeof id).toBe("bigint");
			expect(mockCreateTransfers).toHaveBeenCalledTimes(2);
			const first = mockCreateTransfers.mock.calls[0]?.[0][0].id;
			expect(mockCreateTransfers.mock.calls[1]?.[0][0].id).toBe(first);
			expect(id).toBe(first);
		});

		it("still throws when the post id exists with different terms", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ status: 39 }]); // exists_with_different_amount
			await expect(client.postTransfer(123n)).rejects.toThrow("Post transfer failed");
		});
	});

	describe("voidTransfer", () => {
		it("voids pending transfer", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.voidTransfer(123n);
			expect(typeof id).toBe("bigint");
		});

		it("throws on failure", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ status: 5 }]);
			await expect(client.voidTransfer(123n)).rejects.toThrow("Void transfer failed");
		});

		it("throws when error array element is undefined", async () => {
			mockCreateTransfers.mockResolvedValueOnce([undefined]);
			await expect(client.voidTransfer(123n)).rejects.toThrow("Unknown account/transfer error");
		});

		// The void id is generated OUTSIDE the withReconnect closure, so the retry
		// resubmits the same id and TigerBeetle answers `exists`. Throwing there
		// would fail the caller's cleanup path over a hold TB already released.
		it("treats `exists` on a reconnect retry as the released hold it is", async () => {
			mockCreateTransfers
				.mockRejectedValueOnce(new Error("socket hang up"))
				.mockResolvedValueOnce([{ status: 46 }]);

			const id = await client.voidTransfer(123n);

			expect(typeof id).toBe("bigint");
			expect(mockCreateTransfers).toHaveBeenCalledTimes(2);
			const first = mockCreateTransfers.mock.calls[0]?.[0][0].id;
			expect(mockCreateTransfers.mock.calls[1]?.[0][0].id).toBe(first);
			expect(id).toBe(first);
		});

		it("still throws when the void id exists with different terms", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ status: 40 }]); // exists_with_different_flags
			await expect(client.voidTransfer(123n)).rejects.toThrow("Void transfer failed");
		});
	});

	describe("immediateTransfer", () => {
		it("creates an immediate (non-pending) transfer", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.immediateTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 500,
				code: XFER_PURCHASE,
			});
			expect(typeof id).toBe("bigint");
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.flags).toBe(0); // no pending flag
			expect(transfer.pending_id).toBe(0n);
			expect(transfer.timeout).toBe(0);
		});

		it("throws TBTransferError on failure", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ status: 22 }]);
			await expect(
				client.immediateTransfer({
					debitAccountId: 1n,
					creditAccountId: 2n,
					amount: 500,
					code: XFER_PURCHASE,
				}),
			).rejects.toThrow(TBTransferError);
		});

		it("throws when error array element is undefined", async () => {
			mockCreateTransfers.mockResolvedValueOnce([undefined]);
			await expect(
				client.immediateTransfer({
					debitAccountId: 1n,
					creditAccountId: 2n,
					amount: 500,
					code: XFER_PURCHASE,
				}),
			).rejects.toThrow("Unknown account/transfer error");
		});

		it("uses provided transferId when given", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.immediateTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 500,
				code: XFER_PURCHASE,
				transferId: 999n,
			});
			expect(id).toBe(999n);
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.id).toBe(999n);
		});

		it("passes optional userData fields", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			await client.immediateTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 500,
				code: XFER_PURCHASE,
				userData128: 10n,
				userData64: 20n,
				userData32: 30,
			});
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.user_data_128).toBe(10n);
			expect(transfer.user_data_64).toBe(20n);
			expect(transfer.user_data_32).toBe(30);
		});

		it("retries on connection error via withReconnect", async () => {
			mockCreateTransfers.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce([]);
			const id = await client.immediateTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 500,
				code: XFER_PURCHASE,
			});
			expect(typeof id).toBe("bigint");
			expect(mockCreateTransfers).toHaveBeenCalledTimes(2);
		});

		// The id is generated OUTSIDE the withReconnect closure, so the retry
		// resubmits the same id and TigerBeetle answers `exists`. Throwing there
		// would report failure for money that actually moved — and a caller
		// retrying that "failure" would double-spend.
		it("treats `exists` on a reconnect retry as the committed transfer it is", async () => {
			mockCreateTransfers
				.mockRejectedValueOnce(new Error("connection refused"))
				.mockResolvedValueOnce([{ status: 46 }]);

			const id = await client.immediateTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 500,
				code: XFER_PURCHASE,
				transferId: 4242n,
			});

			expect(id).toBe(4242n);
			expect(mockCreateTransfers).toHaveBeenCalledTimes(2);
			// Same id on both attempts — that identity is what makes `exists` proof.
			expect(mockCreateTransfers.mock.calls[0]?.[0][0].id).toBe(4242n);
			expect(mockCreateTransfers.mock.calls[1]?.[0][0].id).toBe(4242n);
		});

		// `exists` means every field matched; a mismatch is a distinct code and is
		// still a hard failure.
		it("still throws when the id exists with different terms", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ status: 39 }]); // exists_with_different_amount
			await expect(
				client.immediateTransfer({
					debitAccountId: 1n,
					creditAccountId: 2n,
					amount: 500,
					code: XFER_PURCHASE,
				}),
			).rejects.toThrow(TBTransferError);
		});
	});

	describe("lookupAccounts", () => {
		it("returns accounts from TB", async () => {
			const mockAccount = {
				id: 1n,
				credits_posted: 1000n,
				debits_posted: 200n,
				debits_pending: 50n,
			};
			mockLookupAccounts.mockResolvedValueOnce([mockAccount]);
			const accounts = await client.lookupAccounts([1n]);
			expect(accounts).toHaveLength(1);
			expect(accounts[0]?.id).toBe(1n);
		});

		it("returns empty array when no accounts found", async () => {
			mockLookupAccounts.mockResolvedValueOnce([]);
			const accounts = await client.lookupAccounts([999n]);
			expect(accounts).toHaveLength(0);
		});
	});

	describe("lookupBalance", () => {
		it("returns available, pending, and total", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: 1000n,
					debits_posted: 200n,
					debits_pending: 50n,
					credits_pending: 0n,
				},
			]);
			const bal = await client.lookupBalance(1n);
			expect(bal.total).toBe(800); // 1000 - 200
			expect(bal.pending).toBe(50);
			expect(bal.available).toBe(750); // 800 - 50
		});

		it("throws if account not found", async () => {
			mockLookupAccounts.mockResolvedValueOnce([]);
			await expect(client.lookupBalance(999n)).rejects.toThrow("Account not found");
		});

		it("clamps available to 0 when pending exceeds posted", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: 100n,
					debits_posted: 0n,
					debits_pending: 200n,
					credits_pending: 0n,
				},
			]);
			const bal = await client.lookupBalance(1n);
			expect(bal.available).toBe(0);
			expect(bal.total).toBe(100);
			expect(bal.pending).toBe(200);
		});

		it("clamps total to 0 when debits exceed credits", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: 100n,
					debits_posted: 200n,
					debits_pending: 0n,
					credits_pending: 0n,
				},
			]);
			const bal = await client.lookupBalance(1n);
			expect(bal.total).toBe(0); // Math.max(0, -100)
			expect(bal.available).toBe(0);
		});

		it("throws on balance overflow exceeding MAX_SAFE_INTEGER", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: BigInt(Number.MAX_SAFE_INTEGER) + 100n,
					debits_posted: 0n,
					debits_pending: 0n,
					credits_pending: 0n,
				},
			]);
			await expect(client.lookupBalance(1n)).rejects.toThrow("Balance overflow");
		});

		it("throws on negative balance overflow exceeding -MAX_SAFE_INTEGER", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: 0n,
					debits_posted: BigInt(Number.MAX_SAFE_INTEGER) + 100n,
					debits_pending: 0n,
					credits_pending: 0n,
				},
			]);
			await expect(client.lookupBalance(1n)).rejects.toThrow("Balance overflow");
		});

		it("throws on pending overflow exceeding MAX_SAFE_INTEGER", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: 1000n,
					debits_posted: 0n,
					debits_pending: BigInt(Number.MAX_SAFE_INTEGER) + 100n,
					credits_pending: 0n,
				},
			]);
			await expect(client.lookupBalance(1n)).rejects.toThrow("Pending overflow");
		});
	});

	describe("lookupTransfer", () => {
		it("returns transfer when found", async () => {
			const mockTransfer = { id: 100n, amount: 500n };
			mockLookupTransfers.mockResolvedValueOnce([mockTransfer]);
			const result = await client.lookupTransfer(100n);
			expect(result).toEqual(mockTransfer);
		});

		it("returns null when not found", async () => {
			mockLookupTransfers.mockResolvedValueOnce([]);
			const result = await client.lookupTransfer(999n);
			expect(result).toBeNull();
		});
	});

	describe("destroy", () => {
		it("destroys the underlying client", () => {
			client.destroy();
			expect(mockDestroy).toHaveBeenCalledOnce();
		});

		it("clears health check interval on destroy", () => {
			client.destroy();
			mockLookupAccounts.mockResolvedValue([]);
			vi.advanceTimersByTime(60_000);
			expect(mockLookupAccounts).not.toHaveBeenCalled();
		});

		it("calling destroy twice does not throw", () => {
			client.destroy();
			expect(() => client.destroy()).not.toThrow();
		});
	});

	describe("treasury", () => {
		it("setTreasuryId stores the ID", () => {
			client.setTreasuryId(42n);
			expect(client.getTreasuryId()).toBe(42n);
		});

		it("getTreasuryId throws when not initialized", () => {
			expect(() => client.getTreasuryId()).toThrow("Treasury not initialized");
		});

		it("createTreasury creates a new treasury account", async () => {
			mockCreateAccounts.mockResolvedValueOnce([]);
			const id = await client.createTreasury();
			expect(typeof id).toBe("bigint");
			expect(mockCreateAccounts).toHaveBeenCalledOnce();
			expect(client.getTreasuryId()).toBe(id);
		});

		it("createTreasury returns existing treasury when already set and found", async () => {
			client.setTreasuryId(42n);
			mockLookupAccounts.mockResolvedValueOnce([{ id: 42n }]);
			const id = await client.createTreasury();
			expect(id).toBe(42n);
			expect(mockCreateAccounts).not.toHaveBeenCalled();
		});

		it("createTreasury re-creates when treasuryId is set but account not found", async () => {
			client.setTreasuryId(42n);
			mockLookupAccounts.mockResolvedValueOnce([]); // not found
			mockCreateAccounts.mockResolvedValueOnce([]);
			const id = await client.createTreasury();
			expect(id).toBe(42n); // reuses the set ID
			expect(mockCreateAccounts).toHaveBeenCalledOnce();
		});

		it("createTreasury throws on creation errors", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ status: 99 }]);
			await expect(client.createTreasury()).rejects.toThrow("Failed to create treasury");
		});

		it("createTreasury throws when error array element is undefined", async () => {
			mockCreateAccounts.mockResolvedValueOnce([undefined]);
			await expect(client.createTreasury()).rejects.toThrow("Unknown account/transfer error");
		});
	});

	describe("account mapping", () => {
		it("setAccountMapping and getAccountId round-trip", () => {
			client.setAccountMapping("user_x", 99n);
			expect(client.getAccountId("user_x")).toBe(99n);
		});

		it("getAccountId throws for unknown user", () => {
			expect(() => client.getAccountId("unknown")).toThrow("No TigerBeetle account for user");
		});

		it("setAccountMapping overwrites previous mapping", () => {
			client.setAccountMapping("user_x", 99n);
			client.setAccountMapping("user_x", 200n);
			expect(client.getAccountId("user_x")).toBe(200n);
		});
	});

	describe("ping", () => {
		it("returns true within grace period when not initialized", async () => {
			const result = await client.ping();
			expect(result).toBe(true);
		});

		it("returns true when initialized and treasury account found", async () => {
			client.setTreasuryId(42n);
			mockLookupAccounts.mockResolvedValueOnce([{ id: 42n }]);
			const result = await client.ping();
			expect(result).toBe(true);
		});

		it("returns false when initialized and treasury account not found", async () => {
			client.setTreasuryId(42n);
			mockLookupAccounts.mockResolvedValueOnce([]);
			const result = await client.ping();
			expect(result).toBe(false);
		});

		it("returns false on lookup error (catches all exceptions)", async () => {
			client.setTreasuryId(42n);
			// Make lookupAccounts reject with a non-connection error so withReconnect
			// rethrows it (no reconnect attempt), then ping's catch returns false.
			mockLookupAccounts.mockRejectedValueOnce(new Error("unexpected failure"));
			const result = await client.ping();
			expect(result).toBe(false);
		});

		it("returns false after grace period when not initialized", async () => {
			vi.advanceTimersByTime(61_000);
			const result = await client.ping();
			expect(result).toBe(false);
		});
	});

	describe("withReconnect", () => {
		it("retries on connection error (ECONNREFUSED)", async () => {
			mockLookupAccounts
				.mockRejectedValueOnce(new Error("connection refused"))
				.mockResolvedValueOnce([{ id: 1n }]);
			const accounts = await client.lookupAccounts([1n]);
			expect(accounts).toHaveLength(1);
			expect(mockLookupAccounts).toHaveBeenCalledTimes(2);
		});

		it("retries on ECONNRESET", async () => {
			mockCreateTransfers.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce([]);
			const id = await client.voidTransfer(1n);
			expect(typeof id).toBe("bigint");
			expect(mockCreateTransfers).toHaveBeenCalledTimes(2);
		});

		it("retries on 'client is closed' error", async () => {
			mockLookupTransfers
				.mockRejectedValueOnce(new Error("client is closed"))
				.mockResolvedValueOnce([{ id: 1n }]);
			const result = await client.lookupTransfer(1n);
			expect(result).toEqual({ id: 1n });
		});

		it("retries on 'not connected' error", async () => {
			mockLookupAccounts
				.mockRejectedValueOnce(new Error("not connected"))
				.mockResolvedValueOnce([]);
			const accounts = await client.lookupAccounts([1n]);
			expect(accounts).toHaveLength(0);
		});

		it("retries on 'socket' error", async () => {
			mockLookupAccounts
				.mockRejectedValueOnce(new Error("socket hang up"))
				.mockResolvedValueOnce([]);
			const accounts = await client.lookupAccounts([1n]);
			expect(accounts).toHaveLength(0);
		});

		it("retries on 'timeout' error", async () => {
			mockLookupAccounts
				.mockRejectedValueOnce(new Error("request timeout"))
				.mockResolvedValueOnce([]);
			const accounts = await client.lookupAccounts([1n]);
			expect(accounts).toHaveLength(0);
		});

		it("does not retry on non-connection errors", async () => {
			mockLookupAccounts.mockRejectedValueOnce(new Error("invalid argument"));
			await expect(client.lookupAccounts([1n])).rejects.toThrow("invalid argument");
			expect(mockLookupAccounts).toHaveBeenCalledTimes(1);
		});

		it("does not treat non-Error objects as connection errors", async () => {
			mockLookupAccounts.mockRejectedValueOnce("string error");
			await expect(client.lookupAccounts([1n])).rejects.toBe("string error");
			expect(mockLookupAccounts).toHaveBeenCalledTimes(1);
		});
	});

	describe("reconnect", () => {
		it("deduplicates concurrent reconnect calls", async () => {
			mockCreateAccounts
				.mockRejectedValueOnce(new Error("connection refused"))
				.mockResolvedValueOnce([]);

			const promise1 = client.createUserWallet("user_dedup1");
			await promise1;
			expect(mockCreateAccounts).toHaveBeenCalledTimes(2);
		});

		it("reconnect destroys old client and creates new one", async () => {
			mockLookupAccounts.mockRejectedValueOnce(new Error("closed")).mockResolvedValueOnce([]);
			await client.lookupAccounts([1n]);
			expect(mockDestroy).toHaveBeenCalled();
			// createClient called: once in constructor, once in reconnect
			expect(mockCreateClient).toHaveBeenCalledTimes(2);
		});
	});

	describe("health check interval", () => {
		it("triggers ping at 30-second intervals", async () => {
			client.setTreasuryId(42n);
			mockLookupAccounts.mockResolvedValue([{ id: 42n }]);

			await vi.advanceTimersByTimeAsync(30_000);

			expect(mockLookupAccounts).toHaveBeenCalled();
		});

		it("exercises health check failure path when ping rejects (onAlert)", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			client.destroy();

			const onAlert = vi.fn();
			const alertClient = new TrustTBClient({
				addresses: ["3000"],
				onAlert,
			});

			// Override ping to reject — forces the health check .catch path
			vi.spyOn(alertClient, "ping").mockRejectedValue(new Error("ping boom"));
			// Override reconnect to also reject
			vi.spyOn(alertClient, "reconnect").mockRejectedValue(new Error("reconnect boom"));

			// Fire health check interval
			await vi.advanceTimersByTimeAsync(30_000);

			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Health check reconnection failed"),
				expect.any(Error),
			);
			expect(onAlert).toHaveBeenCalledWith(
				expect.stringContaining("health check failed"),
				expect.objectContaining({ error: "reconnect boom" }),
			);

			alertClient.destroy();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("exercises health check failure path when ping rejects (console.warn fallback)", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			client.destroy();

			// No onAlert callback
			const noAlertClient = new TrustTBClient({ addresses: ["3000"] });

			vi.spyOn(noAlertClient, "ping").mockRejectedValue(new Error("ping boom"));
			vi.spyOn(noAlertClient, "reconnect").mockRejectedValue(new Error("reconnect boom"));

			await vi.advanceTimersByTimeAsync(30_000);

			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Health check reconnection failed"),
				expect.any(Error),
			);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("[usertrust]"),
				expect.objectContaining({ error: "reconnect boom" }),
			);

			noAlertClient.destroy();
			warnSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("exercises health check failure path with non-Error rejection", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			client.destroy();

			const noAlertClient = new TrustTBClient({ addresses: ["3000"] });

			vi.spyOn(noAlertClient, "ping").mockRejectedValue("string error");
			vi.spyOn(noAlertClient, "reconnect").mockRejectedValue("string reconnect error");

			await vi.advanceTimersByTimeAsync(30_000);

			// Non-Error → String(err) path
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("[usertrust]"),
				expect.objectContaining({ error: "string reconnect error" }),
			);

			noAlertClient.destroy();
			warnSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("clears health check interval on reconnection failure", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			client.destroy();

			const alertClient = new TrustTBClient({
				addresses: ["3000"],
				onAlert: vi.fn(),
			});

			vi.spyOn(alertClient, "ping").mockRejectedValue(new Error("ping boom"));
			vi.spyOn(alertClient, "reconnect").mockRejectedValue(new Error("reconnect boom"));

			// Fire first health check
			await vi.advanceTimersByTimeAsync(30_000);

			// After failure, interval should be cleared — no more calls
			const pingMock = alertClient.ping as ReturnType<typeof vi.fn>;
			const callCount = pingMock.mock.calls.length;

			// Advance another 30s — should NOT trigger another health check
			await vi.advanceTimersByTimeAsync(30_000);
			expect(pingMock.mock.calls.length).toBe(callCount);

			alertClient.destroy();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});
	});

	describe("_doReconnect error handling", () => {
		it("calls onAlert when all reconnection attempts fail", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			client.destroy();

			const onAlert = vi.fn();
			const alertClient = new TrustTBClient({
				addresses: ["3000"],
				onAlert,
			});
			alertClient.destroy(); // Stop health check interval

			mockCreateClient.mockImplementation(() => {
				throw new Error("cannot connect");
			});

			// Start reconnect — don't await yet (backoff uses setTimeout)
			const promise = alertClient.reconnect().catch((e: Error) => e);

			// Advance time to flush all exponential backoff delays (1+2+4+8=15s)
			await vi.advanceTimersByTimeAsync(16_000);

			const err = await promise;
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe("cannot connect");

			expect(onAlert).toHaveBeenCalledWith(
				expect.stringContaining("all reconnection attempts failed"),
				expect.any(Object),
			);

			resetCreateClient();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("logs to console when all reconnection attempts fail and no onAlert", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			client.destroy();

			const noAlertClient = new TrustTBClient({ addresses: ["3000"] });
			noAlertClient.destroy();

			mockCreateClient.mockImplementation(() => {
				throw new Error("cannot connect");
			});

			const promise = noAlertClient.reconnect().catch((e: Error) => e);
			await vi.advanceTimersByTimeAsync(16_000);

			const err = await promise;
			expect(err).toBeInstanceOf(Error);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[usertrust]"));

			resetCreateClient();
			warnSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("reconnect deduplicates concurrent calls", async () => {
			client.destroy();
			const testClient = new TrustTBClient({ addresses: ["3000"] });
			testClient.destroy();

			// reconnect() deduplicates via reconnectPromise
			const p1 = testClient.reconnect();
			const p2 = testClient.reconnect();

			await p1;
			await p2;

			// createClient called: constructor + 1 reconnect (deduplicated)
			expect(mockCreateClient).toHaveBeenCalledTimes(3); // main client + testClient + reconnect
		});
	});

	describe("constructor options", () => {
		it("defaults clusterId to 0n", () => {
			const call = mockCreateClient.mock.calls[0]?.[0];
			expect(call.cluster_id).toBe(0n);
		});

		it("accepts custom clusterId", () => {
			const customClient = new TrustTBClient({
				addresses: ["3000"],
				clusterId: 5n,
			});
			const lastCall = mockCreateClient.mock.calls[mockCreateClient.mock.calls.length - 1]?.[0];
			expect(lastCall.cluster_id).toBe(5n);
			customClient.destroy();
		});

		it("accepts onAlert callback", () => {
			const onAlert = vi.fn();
			const customClient = new TrustTBClient({
				addresses: ["3000"],
				onAlert,
			});
			expect(onAlert).not.toHaveBeenCalled();
			customClient.destroy();
		});
	});

	describe("TBTransferError", () => {
		it("carries error code", () => {
			const err = new TBTransferError(22, "exceeds_credits");
			expect(err.code).toBe(22);
			expect(err.message).toBe("exceeds_credits");
			expect(err.name).toBe("TBTransferError");
		});

		it("is an instance of Error", () => {
			const err = new TBTransferError(30, "overflow");
			expect(err).toBeInstanceOf(Error);
		});
	});

	describe("constants", () => {
		it("LEDGER_USERTOKENS is 1", () => {
			expect(LEDGER_USERTOKENS).toBe(1);
		});

		it("account codes are distinct", () => {
			expect(CODE_USER_WALLET).not.toBe(CODE_PLATFORM_TREASURY);
			expect(CODE_PLATFORM_TREASURY).not.toBe(CODE_ESCROW);
			expect(CODE_USER_WALLET).not.toBe(CODE_ESCROW);
		});

		it("transfer codes are distinct sequential integers", () => {
			const codes = [
				XFER_PURCHASE,
				XFER_SPEND,
				XFER_TRANSFER,
				XFER_REFUND,
				XFER_ALLOCATION,
				XFER_TOOL_CALL,
				XFER_A2A_DELEGATION,
			];
			expect(new Set(codes).size).toBe(7);
			expect(codes).toEqual([1, 2, 3, 4, 5, 6, 7]);
		});
	});
});
