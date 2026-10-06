// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Caller idempotency keys: TigerBeetle is the record of "already charged".
 *
 * A key is derived as `scope ‖ 0x00 ‖ key` and becomes ONE transfer id: the POST
 * id, `derive(k, "post")` — restart-stable, the at-most-once anchor. The reserve
 * stays MINTED, like every unkeyed call's: a derived reserve id would turn a
 * release-then-retry, a top-up-then-retry and a lost reply into failures (the
 * three rows under "the reserve is minted" pin each one).
 *
 * Driven through the REAL `createTBEngine` copies — `govern.ts`'s by name for the
 * engine rows, `headless.ts`'s through `createGovernor()` for the governor rows —
 * against a stateful fake that stores every transfer and answers a resubmitted id
 * the way the server does (docs.tigerbeetle.com, create_transfers): `exists` when
 * every field matches, the `exists_with_different_*` status for the first field
 * that differs, in the documented precedence order, and `id_already_failed` for an
 * id whose first attempt failed with one of the documented TRANSIENT errors. Status
 * codes, flags and `amount_max` come from the INSTALLED tigerbeetle-node, never
 * hand-copied.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { AuditEvent } from "../../src/shared/types.js";

interface Xfer {
	id: bigint;
	debit_account_id: bigint;
	credit_account_id: bigint;
	amount: bigint;
	pending_id: bigint;
	user_data_128: bigint;
	user_data_64: bigint;
	user_data_32: number;
	timeout: number;
	ledger: number;
	code: number;
	flags: number;
	timestamp: bigint;
}

const { ledger, mockClient, tb } = vi.hoisted(() => {
	interface Acct {
		id: bigint;
		flags: number;
		credits_posted: bigint;
		debits_posted: bigint;
		debits_pending: bigint;
		credits_pending: bigint;
	}
	interface HoistedXfer {
		id: bigint;
		debit_account_id: bigint;
		credit_account_id: bigint;
		amount: bigint;
		pending_id: bigint;
		user_data_128: bigint;
		user_data_64: bigint;
		user_data_32: number;
		timeout: number;
		ledger: number;
		code: number;
		flags: number;
		timestamp: bigint;
	}
	// Filled from the INSTALLED package by the module mock below.
	const tb = {} as {
		AccountFlags: typeof import("tigerbeetle-node").AccountFlags;
		TransferFlags: typeof import("tigerbeetle-node").TransferFlags;
		CreateAccountStatus: typeof import("tigerbeetle-node").CreateAccountStatus;
		CreateTransferStatus: typeof import("tigerbeetle-node").CreateTransferStatus;
		amount_max: bigint;
	};
	const ledger = {
		accounts: new Map<bigint, Acct>(),
		/** Account ids in creation order: [treasury, holding wallet, …] per engine. */
		created: [] as bigint[],
		/** Every committed transfer, by id — immutable once written, as on the server. */
		transfers: new Map<bigint, HoistedXfer>(),
		/** Resolution state of each PENDING transfer, by its id. */
		resolved: new Map<bigint, "posted" | "voided">(),
		/**
		 * A lost reply: commit the next transfer this matches, then fail the call the way
		 * a reset socket does, so the client's reconnect retry resubmits the same id.
		 */
		dropReplyOnce: null as null | ((t: HoistedXfer) => boolean),
		/** Make `lookupTransfers` fail (a non-connection error, so no reconnect retry). */
		failLookups: false,
		/** While set, every POST waits on it before it is applied — a POST held in flight. */
		holdPosts: null as null | Promise<void>,
		/** While set, every lookup waits on it — a ledger read held in flight. */
		holdLookups: null as null | Promise<void>,
		/** Ids whose first attempt failed with a TRANSIENT error: retired for good. */
		retired: new Set<bigint>(),
		clock: 0n,
	};

	const isResolving = (flags: number): boolean =>
		(flags & (tb.TransferFlags.post_pending_transfer | tb.TransferFlags.void_pending_transfer)) !==
		0;

	/** TigerBeetle's `create_transfer_exists`: the first differing field names the status. */
	const existsStatus = (t: HoistedXfer, e: HoistedXfer): number => {
		const S = tb.CreateTransferStatus;
		if (t.flags !== e.flags) return S.exists_with_different_flags;
		if (t.pending_id !== e.pending_id) return S.exists_with_different_pending_id;
		if (t.timeout !== e.timeout) return S.exists_with_different_timeout;
		// A post/void inherits zero-valued fields from its pending transfer.
		const inherited = (v: bigint | number): boolean =>
			isResolving(t.flags) && (v === 0n || v === 0);
		if (!inherited(t.debit_account_id) && t.debit_account_id !== e.debit_account_id) {
			return S.exists_with_different_debit_account_id;
		}
		if (!inherited(t.credit_account_id) && t.credit_account_id !== e.credit_account_id) {
			return S.exists_with_different_credit_account_id;
		}
		const amountInherited = isResolving(t.flags) && (t.amount === tb.amount_max || t.amount === 0n);
		if (!amountInherited && t.amount !== e.amount) return S.exists_with_different_amount;
		if (!inherited(t.ledger) && t.ledger !== e.ledger) return S.exists_with_different_ledger;
		if (!inherited(t.code) && t.code !== e.code) return S.exists_with_different_code;
		return S.exists;
	};

	const applyNew = (t: HoistedXfer): number => {
		const S = tb.CreateTransferStatus;
		const F = tb.TransferFlags;
		ledger.clock += 1n;
		if (isResolving(t.flags)) {
			const p = ledger.transfers.get(t.pending_id);
			if (p === undefined || (p.flags & F.pending) === 0) return S.pending_transfer_not_found;
			const state = ledger.resolved.get(p.id);
			if (state === "posted") return S.pending_transfer_already_posted;
			if (state === "voided") return S.pending_transfer_already_voided;
			const debit = ledger.accounts.get(p.debit_account_id) as Acct;
			const credit = ledger.accounts.get(p.credit_account_id) as Acct;
			const posting = (t.flags & F.post_pending_transfer) !== 0;
			const amount = posting ? (t.amount === tb.amount_max ? p.amount : t.amount) : p.amount;
			if (posting && amount > p.amount) return S.exceeds_pending_transfer_amount;
			debit.debits_pending -= p.amount;
			credit.credits_pending -= p.amount;
			if (posting) {
				debit.debits_posted += amount;
				credit.credits_posted += amount;
			}
			ledger.resolved.set(p.id, posting ? "posted" : "voided");
			ledger.transfers.set(t.id, {
				...t,
				debit_account_id: p.debit_account_id,
				credit_account_id: p.credit_account_id,
				ledger: p.ledger,
				code: p.code,
				amount,
				timestamp: ledger.clock,
			});
			return S.created;
		}
		const debit = ledger.accounts.get(t.debit_account_id);
		const credit = ledger.accounts.get(t.credit_account_id);
		if (debit === undefined) return S.debit_account_not_found;
		if (credit === undefined) return S.credit_account_not_found;
		const dmnec = (debit.flags & tb.AccountFlags.debits_must_not_exceed_credits) !== 0;
		if (dmnec && debit.debits_pending + debit.debits_posted + t.amount > debit.credits_posted) {
			return S.exceeds_credits;
		}
		if ((t.flags & F.pending) !== 0) {
			debit.debits_pending += t.amount;
			credit.credits_pending += t.amount;
		} else {
			debit.debits_posted += t.amount;
			credit.credits_posted += t.amount;
		}
		ledger.transfers.set(t.id, { ...t, timestamp: ledger.clock });
		return S.created;
	};

	/**
	 * The documented transient errors (create_transfers, `id_already_failed`): a
	 * transfer that fails with one of these retires its id, and every later attempt
	 * with that id is answered `id_already_failed` — even once the state that caused
	 * the failure (a balance, a missing account) has changed.
	 */
	const isTransient = (status: number): boolean => {
		const S = tb.CreateTransferStatus;
		return (
			status === S.debit_account_not_found ||
			status === S.credit_account_not_found ||
			status === S.pending_transfer_not_found ||
			status === S.exceeds_credits ||
			status === S.exceeds_debits ||
			status === S.debit_account_already_closed ||
			status === S.credit_account_already_closed
		);
	};

	const mockClient = {
		createAccounts: async (accts: Array<{ id: bigint; flags: number }>) => {
			for (const a of accts) {
				if (ledger.accounts.has(a.id)) return [{ index: 0, status: tb.CreateAccountStatus.exists }];
				ledger.accounts.set(a.id, {
					id: a.id,
					flags: a.flags,
					credits_posted: 0n,
					debits_posted: 0n,
					debits_pending: 0n,
					credits_pending: 0n,
				});
				ledger.created.push(a.id);
			}
			return [];
		},
		createTransfers: vi.fn(async (xs: HoistedXfer[]) => {
			for (const t of xs) {
				if (ledger.holdPosts !== null && (t.flags & tb.TransferFlags.post_pending_transfer) !== 0) {
					await ledger.holdPosts;
				}
				const existing = ledger.transfers.get(t.id);
				// Precedence as documented: every `exists*` outranks `id_already_failed`,
				// which outranks every check against the current state.
				const status =
					existing !== undefined
						? existsStatus(t, existing)
						: ledger.retired.has(t.id)
							? tb.CreateTransferStatus.id_already_failed
							: applyNew(t);
				if (existing === undefined && isTransient(status)) ledger.retired.add(t.id);
				if (ledger.dropReplyOnce?.(t) === true) {
					ledger.dropReplyOnce = null;
					throw new Error("socket hang up: ECONNRESET");
				}
				if (status !== tb.CreateTransferStatus.created) return [{ index: 0, status }];
			}
			return [];
		}),
		lookupTransfers: vi.fn(async (ids: bigint[]) => {
			if (ledger.holdLookups !== null) await ledger.holdLookups;
			if (ledger.failLookups) throw new Error("tb: lookup refused");
			return ids
				.map((id) => ledger.transfers.get(id))
				.filter((t): t is HoistedXfer => t !== undefined);
		}),
		lookupAccounts: async (ids: bigint[]) =>
			ids.map((id) => ledger.accounts.get(id)).filter((a): a is Acct => a !== undefined),
		destroy: () => {},
	};
	return { ledger, mockClient, tb };
});

const { fsHooks } = vi.hoisted(() => ({
	fsHooks: { beforeExclusiveOpen: null as null | ((path: string) => void) },
}));

// The real filesystem, with one seam: a test can act just before an exclusive ("wx")
// open — playing another process that creates the vault's scope file between this
// one's read and its link. No other call is changed.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: (async (path: string, flags?: string, mode?: number) => {
			if (flags === "wx" && fsHooks.beforeExclusiveOpen !== null) {
				fsHooks.beforeExclusiveOpen(String(path));
			}
			return await actual.open(path, flags, mode);
		}) as typeof actual.open,
	};
});

// Only `createClient` is faked; every enum and sentinel is the installed package's.
vi.mock("tigerbeetle-node", async (importOriginal) => {
	const actual = await importOriginal<typeof import("tigerbeetle-node")>();
	tb.AccountFlags = actual.AccountFlags;
	tb.TransferFlags = actual.TransferFlags;
	tb.CreateAccountStatus = actual.CreateAccountStatus;
	tb.CreateTransferStatus = actual.CreateTransferStatus;
	tb.amount_max = actual.amount_max;
	return { ...actual, createClient: vi.fn(() => mockClient) };
});

import { createTBEngine, type TrustEngine } from "../../src/govern.js";
import { createGovernor, type Governor, type GovernorOpts } from "../../src/headless.js";
import {
	DEFAULT_PENDING_TIMEOUT_SECONDS,
	TBTransferError,
	TrustTBClient,
} from "../../src/ledger/client.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import {
	AlreadySettledError,
	InsufficientBalanceError,
	LedgerUnavailableError,
} from "../../src/shared/errors.js";
import { TrustConfigSchema } from "../../src/shared/types.js";

// ── Helpers ──

const CONFIG = TrustConfigSchema.parse({ budget: 100_000 });
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 100, maxOutputTokens: 500 };
const USAGE = { inputTokens: 80, outputTokens: 200 };
const SCOPE = "tenant:acme";

function reset(): void {
	ledger.accounts.clear();
	ledger.created.length = 0;
	ledger.transfers.clear();
	ledger.resolved.clear();
	ledger.dropReplyOnce = null;
	ledger.failLookups = false;
	ledger.holdPosts = null;
	ledger.holdLookups = null;
	ledger.retired.clear();
	fsHooks.beforeExclusiveOpen = null;
	mockClient.createTransfers.mockClear();
	mockClient.lookupTransfers.mockClear();
}

const derived = (scope: string, key: string): string => `${scope}\u0000${key}`;
const postIdFor = (scope: string, key: string): bigint =>
	TrustTBClient.deriveTransferId(derived(scope, key), "post");
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function isPending(t: Xfer): boolean {
	return (t.flags & tb.TransferFlags.pending) !== 0;
}
function isPost(t: Xfer): boolean {
	return (t.flags & tb.TransferFlags.post_pending_transfer) !== 0;
}
function pendings(): Xfer[] {
	return [...ledger.transfers.values()].filter(isPending);
}
function posts(): Xfer[] {
	return [...ledger.transfers.values()].filter(isPost);
}

interface AuditHandle extends AuditWriter {
	events: AppendEventInput[];
	/** While set, every append waits for it before it lands. */
	holdAppends: null | Promise<void>;
}

function makeAudit(): AuditHandle {
	const events: AppendEventInput[] = [];
	const handle: AuditHandle = {
		events,
		holdAppends: null,
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			if (handle.holdAppends !== null) await handle.holdAppends;
			events.push(input);
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		}),
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
	return handle;
}

// ── Engine rows: govern.ts's createTBEngine, by name ──

describe("createTBEngine — the keyed post", () => {
	beforeEach(reset);

	const POST = postIdFor(SCOPE, "call-1");

	/** The one PENDING transfer debiting this holding wallet: the engine's hold. */
	function holdOf(holdingWallet: bigint): Xfer {
		const [hold, ...rest] = pendings().filter((t) => t.debit_account_id === holdingWallet);
		expect(rest).toHaveLength(0);
		return hold as Xfer;
	}

	it("posts a keyed settle under the supplied post id, against its own hold", async () => {
		const engine = await createTBEngine(CONFIG, 10_000);
		const holding = ledger.created[1] as bigint;

		await engine.spendPending({ transferId: "t1", amount: 40 });
		await expect(engine.postPendingSpend("t1", 30, POST)).resolves.toEqual({
			posted: 30,
			shortfall: 0,
		});

		const post = ledger.transfers.get(POST);
		expect(post?.pending_id).toBe(holdOf(holding).id);
		expect(post?.amount).toBe(30n);
		engine.destroy?.();
	});

	it("unkeyed calls are unchanged: minted ids, never the derived ones", async () => {
		const engine = await createTBEngine(CONFIG, 10_000);

		await engine.spendPending({ transferId: "t1", amount: 40 });
		await engine.postPendingSpend("t1", 30);

		expect(ledger.transfers.has(POST)).toBe(false);
		expect(posts()).toHaveLength(1);
		engine.destroy?.();
	});

	it("a post id ANOTHER hold already took is AlreadySettledError — and this hold stays voidable", async () => {
		// Two processes, two holding wallets, two holds, ONE post anchor.
		const first = await createTBEngine(CONFIG, 10_000);
		const second = await createTBEngine(CONFIG, 10_000);
		await first.spendPending({ transferId: "a", amount: 40 });
		await second.spendPending({ transferId: "b", amount: 40 });
		await first.postPendingSpend("a", 30, POST);

		const err = await second.postPendingSpend("b", 30, POST).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(AlreadySettledError);
		expect(posts()).toHaveLength(1);
		// Never a second post — and the losing hold is still PENDING and still in the
		// engine's map, so the governor can release it.
		const secondHold = holdOf(ledger.created[3] as bigint).id;
		expect(ledger.resolved.get(secondHold)).toBeUndefined();
		await second.voidPendingSpend("b");
		expect(ledger.resolved.get(secondHold)).toBe("voided");
		first.destroy?.();
		second.destroy?.();
	});

	it("the decision rests on the LOOKUP: a stored post naming THIS hold stays a hard failure", async () => {
		// A post id that already holds a post of THIS very hold, under a different
		// amount, is not "charged by someone else" — it is a mismatch, and the exists
		// rule says every `exists_with_different_*` stays a hard failure.
		const engine = await createTBEngine(CONFIG, 10_000);
		const holding = ledger.created[1] as bigint;
		await engine.spendPending({ transferId: "t1", amount: 40 });
		ledger.transfers.set(POST, {
			id: POST,
			debit_account_id: holding,
			credit_account_id: ledger.created[0] as bigint,
			amount: 7n,
			pending_id: holdOf(holding).id,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			timeout: 0,
			ledger: 1,
			code: 2,
			flags: tb.TransferFlags.post_pending_transfer,
			timestamp: 1n,
		});

		const err = await engine.postPendingSpend("t1", 30, POST).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(AlreadySettledError);
		expect((err as TBTransferError).code).toBe(
			tb.CreateTransferStatus.exists_with_different_amount,
		);
		engine.destroy?.();
	});

	it("a lookup that fails after exists_with_different_* is never read as AlreadySettledError", async () => {
		// The lookup is the decision. Without it there is no evidence the key was
		// charged, so the post stays a hard failure (the governor records it ambiguous).
		const first = await createTBEngine(CONFIG, 10_000);
		const second = await createTBEngine(CONFIG, 10_000);
		await first.spendPending({ transferId: "a", amount: 40 });
		await second.spendPending({ transferId: "b", amount: 40 });
		await first.postPendingSpend("a", 30, POST);
		ledger.failLookups = true;

		const err = await second.postPendingSpend("b", 30, POST).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(AlreadySettledError);
		expect(posts()).toHaveLength(1);
		first.destroy?.();
		second.destroy?.();
	});

	it("lookupTransfer delegates to the client: the stored transfer, or null", async () => {
		const engine = await createTBEngine(CONFIG, 10_000);
		await engine.spendPending({ transferId: "t1", amount: 40 });
		await engine.postPendingSpend("t1", 30, POST);

		expect((await engine.lookupTransfer?.(POST))?.pending_id).toBeTypeOf("bigint");
		expect(await engine.lookupTransfer?.(postIdFor(SCOPE, "never-used"))).toBeNull();
		engine.destroy?.();
	});
});

// ── Governor rows: headless.ts's copy of the factory, through createGovernor() ──

describe("createGovernor — caller idempotency keys", () => {
	const vaults: string[] = [];
	const governors: Governor[] = [];

	beforeEach(reset);

	afterEach(async () => {
		for (const gov of governors.splice(0)) await gov.destroy();
		for (const dir of vaults.splice(0)) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	});

	function vault(): string {
		const dir = join(tmpdir(), `headless-idempotency-${randomUUID()}`);
		mkdirSync(dir, { recursive: true });
		vaults.push(dir);
		return dir;
	}

	/** A governor over the shared fake: its own treasury, its own holding wallet. */
	async function governor(
		opts: Partial<GovernorOpts> & { audit?: AuditHandle } = {},
	): Promise<{ gov: Governor; audit: AuditHandle }> {
		const audit = opts.audit ?? makeAudit();
		const { audit: _ignored, ...rest } = opts;
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase: opts.vaultBase ?? vault(),
			idempotencyScope: SCOPE,
			...rest,
			_audit: audit,
		});
		governors.push(gov);
		return { gov, audit };
	}

	it("a replayed authorize returns the SAME handle and creates no second hold", async () => {
		const { gov } = await governor();

		const first = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
		const replay = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });

		expect(replay).toBe(first);
		expect(pendings()).toHaveLength(1);
	});

	it("concurrent same-key authorizes in ONE process converge on one handle", async () => {
		const { gov } = await governor();

		const [a, b] = await Promise.all([
			gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" }),
			gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" }),
		]);

		expect(b).toBe(a);
		expect(pendings()).toHaveLength(1);
	});

	it("different keys are different holds", async () => {
		const { gov } = await governor();

		const a = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
		const b = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-2" });

		expect(b.transferId).not.toBe(a.transferId);
		expect(pendings()).toHaveLength(2);
	});

	it("a key whose post anchor exists is AlreadySettledError at authorize — and no hold is created", async () => {
		const { gov: before } = await governor();
		await before.settle(await before.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" }), USAGE);
		expect(pendings()).toHaveLength(1);

		// A restart: a new process, a new holding wallet, the same scope.
		const { gov: after } = await governor();
		await expect(
			after.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" }),
		).rejects.toBeInstanceOf(AlreadySettledError);
		expect(pendings()).toHaveLength(1);

		// The same process answers the same way once the hold has settled.
		await expect(
			before.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" }),
		).rejects.toBeInstanceOf(AlreadySettledError);
		expect(pendings()).toHaveLength(1);
	});

	it("concurrent duplicates: two holds, one key, both settled — exactly one post; the second releases and throws", async () => {
		const { gov: a, audit: auditA } = await governor();
		const { gov: b, audit: auditB } = await governor();
		const bBefore = b.budgetRemaining();

		// Both authorize before either settles: neither post anchor exists yet.
		const authA = await a.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
		const authB = await b.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
		expect(pendings()).toHaveLength(2);

		const receipt = await a.settle(authA, USAGE);
		expect(receipt.settled).toBe(true);
		await expect(b.settle(authB, USAGE)).rejects.toBeInstanceOf(AlreadySettledError);

		// Never a second post: the anchor is the only post, and it is A's.
		expect(posts()).toHaveLength(1);
		expect(ledger.transfers.get(postIdFor(SCOPE, "call-1"))).toBeDefined();
		// B's hold was released — voided on the ledger, neutral on the chain.
		const bHold = pendings().find((t) => ledger.resolved.get(t.id) !== "posted");
		expect(bHold).toBeDefined();
		expect(ledger.resolved.get((bHold as Xfer).id)).toBe("voided");
		expect(auditB.events.map((e) => e.kind)).toEqual(["hold_released", "settlement_duplicate"]);
		const duplicate = auditB.events[1]?.data ?? {};
		expect(duplicate.transferId).toBe(authB.transferId);
		expect(duplicate.idempotencyKeyHash).toBe(sha256(derived(SCOPE, "call-1")));
		expect(auditB.events[0]?.data.transferId).toBe(authB.transferId);
		// The release returned B's session exposure, and nothing was charged to B.
		expect(b.budgetRemaining()).toBe(bBefore);
		expect(auditA.events.map((e) => e.kind)).toContain("llm_call");
	});

	it("a settle-duplicate records no breaker failure: one duplicate then four aborts stay under five", async () => {
		// Five duplicates in a row could not catch this: settle records a SUCCESS
		// before its POST, which resets the consecutive count, so even a duplicate
		// path that recorded a failure would never reach five. A duplicate followed by
		// four aborts can — with the bug it is the fifth consecutive failure.
		const { gov: a } = await governor();
		const { gov: b } = await governor();
		const authA = await a.authorize({ ...AUTHORIZE, idempotencyKey: "dup" });
		const authB = await b.authorize({ ...AUTHORIZE, idempotencyKey: "dup" });
		await a.settle(authA, USAGE);
		await expect(b.settle(authB, USAGE)).rejects.toBeInstanceOf(AlreadySettledError);
		for (let i = 0; i < 4; i++) {
			await b.abort(await b.authorize(AUTHORIZE), new Error("provider 500"));
		}
		await expect(b.authorize(AUTHORIZE)).resolves.toBeDefined();
	});

	it("a settle replay of the same post id is `exists` — and succeeds idempotently", async () => {
		const { gov } = await governor();
		const auth = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
		const POST = postIdFor(SCOPE, "call-1");
		// The post COMMITS and its reply is lost; the reconnect retry resubmits the
		// identical post under the identical id, and the server answers `exists`.
		ledger.dropReplyOnce = (t) => t.id === POST;

		const receipt = await gov.settle(auth, USAGE);

		expect(receipt.settled).toBe(true);
		const submissions = mockClient.createTransfers.mock.calls.filter(([xs]) =>
			(xs as Xfer[]).some((t) => t.id === POST),
		);
		expect(submissions).toHaveLength(2);
		expect(posts()).toHaveLength(1);
	});

	it("two scopes with the same key never collide", async () => {
		const { gov: tenantA } = await governor({ idempotencyScope: "server:a" });
		const { gov: tenantB } = await governor({ idempotencyScope: "server:b" });

		await tenantA.settle(await tenantA.authorize({ ...AUTHORIZE, idempotencyKey: "same" }), USAGE);
		const authB = await tenantB.authorize({ ...AUTHORIZE, idempotencyKey: "same" });
		const receiptB = await tenantB.settle(authB, USAGE);

		expect(receiptB.settled).toBe(true);
		expect(posts()).toHaveLength(2);
		expect(postIdFor("server:a", "same")).not.toBe(postIdFor("server:b", "same"));
		expect(ledger.transfers.has(postIdFor("server:a", "same"))).toBe(true);
		expect(ledger.transfers.has(postIdFor("server:b", "same"))).toBe(true);
	});

	describe("the default scope is a random id persisted in the vault", () => {
		const scopeFile = (dir: string): string => join(dir, VAULT_DIR, "idempotency-scope");

		it("one vault shares keys across restarts; another vault never does", async () => {
			const shared = vault();
			const { gov: first } = await governor({ vaultBase: shared, idempotencyScope: undefined });
			await first.settle(await first.authorize({ ...AUTHORIZE, idempotencyKey: "k" }), USAGE);
			const scope = readFileSync(scopeFile(shared), "utf-8").trim();
			expect(scope).toMatch(/^vault:[0-9a-f-]{36}$/);
			expect(ledger.transfers.has(postIdFor(scope, "k"))).toBe(true);

			// A restart: the same vault, the same scope, the same key → already charged.
			const { gov: sameVault } = await governor({ vaultBase: shared, idempotencyScope: undefined });
			await expect(
				sameVault.authorize({ ...AUTHORIZE, idempotencyKey: "k" }),
			).rejects.toBeInstanceOf(AlreadySettledError);

			const { gov: otherVault } = await governor({ idempotencyScope: undefined });
			await expect(
				otherVault.authorize({ ...AUTHORIZE, idempotencyKey: "k" }),
			).resolves.toBeDefined();
		});

		it("is NOT the vault path: the same path on a fresh vault gets a fresh scope", async () => {
			// Two containers mounting different vaults at one path must not share keys.
			const dir = vault();
			const { gov: before } = await governor({ vaultBase: dir, idempotencyScope: undefined });
			await before.authorize({ ...AUTHORIZE, idempotencyKey: "k" });
			const firstScope = readFileSync(scopeFile(dir), "utf-8").trim();
			rmSync(join(dir, VAULT_DIR), { recursive: true, force: true });

			const { gov: after } = await governor({ vaultBase: dir, idempotencyScope: undefined });
			await after.authorize({ ...AUTHORIZE, idempotencyKey: "k" });
			expect(readFileSync(scopeFile(dir), "utf-8").trim()).not.toBe(firstScope);
		});

		it("is created on the FIRST keyed call only — an unkeyed governor never writes it", async () => {
			const dir = vault();
			const { gov } = await governor({ vaultBase: dir, idempotencyScope: undefined });
			await gov.settle(await gov.authorize(AUTHORIZE), USAGE);
			expect(existsSync(scopeFile(dir))).toBe(false);
			await gov.authorize({ ...AUTHORIZE, idempotencyKey: "k" });
			expect(existsSync(scopeFile(dir))).toBe(true);
		});

		it("two governors opening one FRESH vault at once agree on a single scope", async () => {
			const dir = vault();
			const { gov: a } = await governor({ vaultBase: dir, idempotencyScope: undefined });
			const { gov: b } = await governor({ vaultBase: dir, idempotencyScope: undefined });

			const [authA, authB] = await Promise.all([
				a.authorize({ ...AUTHORIZE, idempotencyKey: "k" }),
				b.authorize({ ...AUTHORIZE, idempotencyKey: "k" }),
			]);
			await a.settle(authA, USAGE);

			// One scope, so one post anchor: B's settle is the duplicate.
			await expect(b.settle(authB, USAGE)).rejects.toBeInstanceOf(AlreadySettledError);
			expect(posts()).toHaveLength(1);
		});

		it("never overwrites a scope another process created after this one looked", async () => {
			// The creation race, forced: between this governor's read (absent) and its
			// link, another process writes its scope. A link fails with EEXIST and this
			// governor adopts theirs; an overwrite would leave the two disagreeing.
			const dir = vault();
			const theirs = `vault:${randomUUID()}`;
			fsHooks.beforeExclusiveOpen = (path) => {
				if (!path.includes("idempotency-scope")) return;
				fsHooks.beforeExclusiveOpen = null;
				writeFileSync(scopeFile(dir), `${theirs}\n`);
			};
			const { gov } = await governor({ vaultBase: dir, idempotencyScope: undefined });

			await gov.settle(await gov.authorize({ ...AUTHORIZE, idempotencyKey: "k" }), USAGE);

			expect(readFileSync(scopeFile(dir), "utf-8").trim()).toBe(theirs);
			expect(ledger.transfers.has(postIdFor(theirs, "k"))).toBe(true);
		});

		it("a scope file that holds no scope refuses keyed calls and is NEVER replaced", async () => {
			// A fresh scope would let every key this vault already charged charge again.
			const dir = vault();
			mkdirSync(join(dir, VAULT_DIR), { recursive: true });
			writeFileSync(scopeFile(dir), "not a scope\n");
			const { gov } = await governor({ vaultBase: dir, idempotencyScope: undefined });

			await expect(gov.authorize({ ...AUTHORIZE, idempotencyKey: "k" })).rejects.toThrow(
				/does not hold an idempotency scope/,
			);
			expect(readFileSync(scopeFile(dir), "utf-8")).toBe("not a scope\n");
			expect(pendings()).toHaveLength(0);
			// Unkeyed calls never read it.
			await expect(gov.authorize(AUTHORIZE)).resolves.toBeDefined();
		});
	});

	describe("an invalid key is refused with a TypeError, before any I/O", () => {
		const bad: Array<[string, unknown]> = [
			["empty", ""],
			["257 characters", "k".repeat(257)],
			["a space", "call 1"],
			["a control character", `call${String.fromCharCode(0x07)}1`],
			["DEL", `call${String.fromCharCode(0x7f)}`],
			["non-ASCII", "cäll"],
			["a number", 42],
			["null", null],
		];

		it.each(bad)("%s", async (_label, idempotencyKey) => {
			const { gov, audit } = await governor();
			mockClient.createTransfers.mockClear();
			mockClient.lookupTransfers.mockClear();

			await expect(
				gov.authorize({ ...AUTHORIZE, idempotencyKey } as unknown as Parameters<
					Governor["authorize"]
				>[0]),
			).rejects.toBeInstanceOf(TypeError);
			expect(mockClient.lookupTransfers).not.toHaveBeenCalled();
			expect(mockClient.createTransfers).not.toHaveBeenCalled();
			expect(audit.events).toHaveLength(0);
		});

		it("accepts the boundary: 256 printable ASCII characters", async () => {
			const { gov } = await governor();
			const edge = `${"!~".repeat(128)}`;
			await expect(gov.authorize({ ...AUTHORIZE, idempotencyKey: edge })).resolves.toBeDefined();
		});
	});

	it("an idempotencyScope that is not a string is refused at construction", async () => {
		await expect(governor({ idempotencyScope: 7 as unknown as string })).rejects.toBeInstanceOf(
			TypeError,
		);
	});

	it("the raw key appears on NO record — only its SHA-256, on the duplicate", async () => {
		const RAW = "raw-key-SENTINEL-7f3a";
		const dirA = vault();
		const dirB = vault();
		const { gov: a, audit: auditA } = await governor({ vaultBase: dirA });
		const { gov: b, audit: auditB } = await governor({ vaultBase: dirB });

		const authA = await a.authorize({ ...AUTHORIZE, idempotencyKey: RAW });
		const authB = await b.authorize({ ...AUTHORIZE, idempotencyKey: RAW });
		const receipt = await a.settle(authA, USAGE);
		await b.settle(authB, USAGE).catch(() => {});
		await a.release(await a.authorize({ ...AUTHORIZE, idempotencyKey: `${RAW}-2` }));
		await a.abort(await a.authorize({ ...AUTHORIZE, idempotencyKey: `${RAW}-3` }));

		const everything = JSON.stringify(
			{ a: auditA.events, b: auditB.events, receipt, authA, authB },
			(_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
		);
		expect(everything).not.toContain(RAW);
		// …and nothing the governors wrote to disk (rotated receipts, spend ledger).
		for (const dir of [dirA, dirB]) {
			for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) {
				if (!file.isFile()) continue;
				const body = readFileSync(join(file.parentPath, file.name), "utf-8");
				expect(body, `${file.name} carries the raw key`).not.toContain(RAW);
			}
		}
		// Every record a keyed hold leaves carries the key's SHA-256 — so a key can be
		// followed across the chain — and none carries the key itself.
		for (const event of [...auditA.events, ...auditB.events]) {
			expect(event.data.idempotencyKeyHash, `${event.kind} lacks the key hash`).toMatch(
				/^[0-9a-f]{64}$/,
			);
		}
	});

	describe("the reserve is minted: the three paths a derived reserve id would break", () => {
		it("release, then re-authorize the same key: a fresh hold, which settles and charges once", async () => {
			const { gov } = await governor();
			const first = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			await gov.release(first, "superseded");

			const again = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			expect(again.transferId).not.toBe(first.transferId);
			const receipt = await gov.settle(again, USAGE);

			expect(receipt.settled).toBe(true);
			expect(pendings()).toHaveLength(2);
			expect(posts()).toHaveLength(1);
			expect(ledger.transfers.has(postIdFor(SCOPE, "call-1"))).toBe(true);
		});

		it("an insufficient-balance refusal, a top-up, then a retry of the same key reserves", async () => {
			// A refused reserve RETIRES its id (`exceeds_credits` is transient), so a
			// retry under a derived reserve id would be `id_already_failed` forever.
			const { gov } = await governor();
			const holding = ledger.accounts.get(ledger.created[1] as bigint);
			const funded = holding?.credits_posted ?? 0n;
			// The ledger, not the governor's own numbers, is what runs short.
			if (holding !== undefined) holding.credits_posted = 1n;

			await expect(
				gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" }),
			).rejects.toBeInstanceOf(InsufficientBalanceError);

			if (holding !== undefined) holding.credits_posted = funded;
			const auth = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			const receipt = await gov.settle(auth, USAGE);

			expect(receipt.settled).toBe(true);
			expect(ledger.retired.size).toBe(1);
			expect(posts()).toHaveLength(1);
		});

		it("a lost reply on a reserve that LANDED is that reservation, not a deny and an orphan", async () => {
			// The reserve commits, the reply is lost, the reconnect retry resubmits the
			// same minted id, and TigerBeetle answers `exists`: the hold is live. A
			// derived id would make this a PendingReplayError — a deny, with the
			// committed hold left pending until its timeout.
			const { gov } = await governor();
			ledger.dropReplyOnce = (t) => isPending(t);

			const auth = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			const receipt = await gov.settle(auth, USAGE);

			expect(receipt.settled).toBe(true);
			expect(pendings()).toHaveLength(1);
			expect(posts()).toHaveLength(1);
			expect(gov.budgetRemaining()).toBe(100_000 - receipt.cost);
		});
	});

	it("abort frees the key: the next authorize is a fresh hold, never the voided one", async () => {
		const { gov } = await governor();
		const first = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
		await gov.abort(first, new Error("provider 500"));

		const again = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
		expect(again.transferId).not.toBe(first.transferId);
		await expect(gov.settle(again, USAGE)).resolves.toMatchObject({ settled: true });
	});

	it("a refused keyed authorize leaves no slot behind: the key's next authorize is fresh", async () => {
		const { gov } = await governor();
		ledger.failLookups = true;
		await expect(gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" })).rejects.toBeInstanceOf(
			LedgerUnavailableError,
		);

		ledger.failLookups = false;
		await expect(gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" })).resolves.toBeDefined();
		expect(pendings()).toHaveLength(1);
	});

	it("concurrent replays of a REFUSED authorize share its refusal and place no hold", async () => {
		const { gov } = await governor();
		ledger.failLookups = true;

		const results = await Promise.allSettled([
			gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" }),
			gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" }),
		]);

		expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
		expect(mockClient.lookupTransfers).toHaveBeenCalledTimes(1);
		expect(pendings()).toHaveLength(0);
	});

	it("the replay returns the FIRST call's handle, whatever the replay's own parameters say", async () => {
		// The key is the intent: the ledger records no parameters, so a process-local
		// comparison would make the same replay pass or fail depending on a restart.
		const { gov } = await governor();
		const first = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });

		const replay = await gov.authorize({
			...AUTHORIZE,
			model: "claude-opus-4-1",
			maxOutputTokens: 9_000,
			idempotencyKey: "call-1",
		});

		expect(replay).toBe(first);
		expect(replay.model).toBe(AUTHORIZE.model);
		expect(pendings()).toHaveLength(1);
	});

	it("an earlier hold's late terminal never forgets a LATER hold placed under the same key", async () => {
		// Settle claims hold A and throws before its POST (A waits in the claimed set,
		// still voidable); the key is free, so B is authorized under it. A's cleanup
		// must not free the key out from under B: a replay still answers B.
		const { gov } = await governor();
		const a = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
		const throwing = {
			get inputTokens(): number {
				throw new Error("throw after claim");
			},
		};
		await expect(gov.settle(a, throwing)).rejects.toThrow("throw after claim");

		const b = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
		await gov.release(a, "cleanup");

		expect(await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" })).toBe(b);
		expect(pendings()).toHaveLength(2);
		expect(ledger.resolved.size).toBe(1);
	});

	it("a failed post-anchor lookup refuses the keyed authorize as ledger-unavailable", async () => {
		const { gov } = await governor();
		ledger.failLookups = true;

		await expect(gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" })).rejects.toBeInstanceOf(
			LedgerUnavailableError,
		);
		expect(pendings()).toHaveLength(0);
	});

	it("an engine with no lookupTransfer refuses a keyed authorize, fail-closed", async () => {
		const engine: TrustEngine = {
			spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
			postPendingSpend: vi.fn(async () => {}),
			voidPendingSpend: vi.fn(async () => {}),
		};
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase: vault(),
			_engine: engine,
			_audit: makeAudit(),
		});
		governors.push(gov);

		await expect(gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" })).rejects.toBeInstanceOf(
			LedgerUnavailableError,
		);
		expect(engine.spendPending).not.toHaveBeenCalled();
		// An unkeyed call on the same engine is unaffected.
		await expect(gov.authorize(AUTHORIZE)).resolves.toBeDefined();
	});

	it("dryRun: in-process replay still holds, and keyed authorizes are not rejected", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase: vault(),
			_audit: makeAudit(),
		});
		governors.push(gov);

		const first = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
		expect(await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" })).toBe(first);
		await gov.settle(first, USAGE);
		// No ledger, no post anchor: after the hold resolves, the key authorizes afresh.
		const again = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
		expect(again.transferId).not.toBe(first.transferId);
		expect(mockClient.lookupTransfers).not.toHaveBeenCalled();
	});

	it("release and abort of a keyed hold are unchanged: the hold is voided", async () => {
		const { gov } = await governor();

		await gov.release(await gov.authorize({ ...AUTHORIZE, idempotencyKey: "r" }));
		await gov.abort(await gov.authorize({ ...AUTHORIZE, idempotencyKey: "x" }));

		expect(pendings().map((t) => ledger.resolved.get(t.id))).toEqual(["voided", "voided"]);
		expect(posts()).toHaveLength(0);
	});

	describe("a hold's ledger deadline, and a key's slot", () => {
		const TIMEOUT_MS = DEFAULT_PENDING_TIMEOUT_SECONDS * 1000;

		it("the reserve carries the ledger timeout the deadline is reckoned from — explicitly", async () => {
			const { gov } = await governor();
			await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			expect(pendings().map((t) => t.timeout)).toEqual([DEFAULT_PENDING_TIMEOUT_SECONDS]);
		});

		it("a keyed replay PAST the hold's ledger deadline reserves anew, and the unheld path no longer answers held", async () => {
			// No server sweep here: a direct createGovernor() keeps an expired hold in
			// memory, and a replay must not hand it back as a reservation.
			let clock = 1_000;
			const { gov } = await governor({ _now: () => clock });
			const first = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			clock += TIMEOUT_MS - 1;
			expect(await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" })).toBe(first);
			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).resolves.toEqual({ outcome: "held", transferId: first.transferId });

			clock += 1;
			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).resolves.toEqual({ outcome: "unrecoverable", recorded: true });
			const again = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			expect(again.transferId).not.toBe(first.transferId);
			expect(pendings()).toHaveLength(2);
		});

		it("a reserve that returns only after the hold's ledger deadline is released and refused — never handed out", async () => {
			// The deadline is read before the reserve; the next read, after it, is past.
			let reads = 0;
			const { gov, audit } = await governor({
				_now: () => (reads++ === 0 ? 1_000 : 1_000 + TIMEOUT_MS),
			});
			await expect(gov.authorize({ ...AUTHORIZE })).rejects.toBeInstanceOf(LedgerUnavailableError);
			expect(audit.events.map((e) => e.kind)).toContain("hold_released");
			expect([...ledger.resolved.values()]).toEqual(["voided"]);
		});

		it("dryRun has no ledger to expire a hold: its replay is the same hold, however late", async () => {
			let clock = 1_000;
			const { gov } = await governor({ dryRun: true, _now: () => clock });
			const first = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			clock += 10 * TIMEOUT_MS;
			expect(await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" })).toBe(first);
		});

		it("a key's slot leaves when its hold meets its terminal — settle, abort or release", async () => {
			const slots = new Map<string, unknown>();
			const { gov } = await governor({ _keySlots: slots });
			await gov.settle(await gov.authorize({ ...AUTHORIZE, idempotencyKey: "k-settle" }), USAGE);
			await gov.abort(
				await gov.authorize({ ...AUTHORIZE, idempotencyKey: "k-abort" }),
				new Error("provider down"),
			);
			await gov.release(await gov.authorize({ ...AUTHORIZE, idempotencyKey: "k-release" }), "done");
			expect(slots.size).toBe(0);
			await gov.authorize({ ...AUTHORIZE, idempotencyKey: "k-live" });
			expect(slots.size).toBe(1);
		});

		it("an expired hold's terminal never removes the slot of the newer hold under its key", async () => {
			let clock = 1_000;
			const slots = new Map<string, unknown>();
			const { gov } = await governor({ _now: () => clock, _keySlots: slots });
			const expired = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			clock += TIMEOUT_MS;
			const newer = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			await gov.abort(expired, new Error("too late"));
			expect(slots.size).toBe(1);
			expect(await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" })).toBe(newer);
		});
	});

	describe("recordUnheldSettlement — a settle whose hold is gone is recorded, never lost", () => {
		const PRINCIPAL = { id: "user-42", type: "human", origin: "cli" };
		const FOUR_TIERS = {
			inputTokens: 80,
			outputTokens: 200,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		// Settled into values at once, so no rejection is ever unhandled while a
		// test still holds a ledger or audit call.
		const settledValue = (p: Promise<unknown>): Promise<unknown> =>
			p.then(
				(v) => v,
				(e: unknown) => e,
			);

		it("after a restart: no live hold and no charge → settlement_unrecoverable, carrying the key's hash, the principal and the usage", async () => {
			const { gov: before } = await governor();
			await before.authorize({ ...AUTHORIZE, idempotencyKey: "call-1", principal: PRINCIPAL });
			// The process restarts: a new governor under the same scope, holding nothing.
			const { gov: after, audit } = await governor();

			const outcome = await after.recordUnheldSettlement({
				idempotencyKey: "call-1",
				usage: USAGE,
				principal: PRINCIPAL,
			});

			expect(outcome).toEqual({ outcome: "unrecoverable", recorded: true });
			expect(audit.events.map((e) => e.kind)).toEqual(["settlement_unrecoverable"]);
			const data = audit.events[0]?.data ?? {};
			expect(data.idempotencyKeyHash).toBe(sha256(derived(SCOPE, "call-1")));
			expect(data.principal).toEqual(PRINCIPAL);
			expect(data.usage).toEqual(FOUR_TIERS);
			expect(data.usageSource).toBe("provider");
			expect(data).not.toHaveProperty("transferId");
			// No ledger effect in any branch: nothing posted, voided or reserved.
			expect(posts()).toHaveLength(0);
			expect(pendings()).toHaveLength(1);
			expect(ledger.resolved.size).toBe(0);
		});

		it("after a TTL release in the same process, the late settle is recorded", async () => {
			const { gov, audit } = await governor();
			const auth = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			await gov.release(auth, "pending TTL expired");

			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).resolves.toEqual({ outcome: "unrecoverable", recorded: true });
			expect(audit.events.map((e) => e.kind)).toEqual([
				"hold_released",
				"settlement_unrecoverable",
			]);
		});

		it("a key whose hold is live answers held — naming the hold to settle — and records nothing", async () => {
			const { gov, audit } = await governor();
			const auth = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });

			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).resolves.toEqual({ outcome: "held", transferId: auth.transferId });
			expect(audit.events).toHaveLength(0);
		});

		it("a settle still POSTING is waited out: the key it charges is AlreadySettledError, never a false loss", async () => {
			// A client retries its settle while the first one is mid-POST. Recording
			// "unrecoverable" here would report a loss for a call whose charge lands a
			// moment later.
			const { gov, audit } = await governor();
			const auth = await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			let releasePosts: () => void = () => {};
			ledger.holdPosts = new Promise<void>((resolve) => {
				releasePosts = resolve;
			});
			const settling = gov.settle(auth, USAGE);
			await vi.waitFor(() =>
				expect(
					mockClient.createTransfers.mock.calls.some(([xs]) => (xs as Xfer[]).some(isPost)),
				).toBe(true),
			);

			const late = settledValue(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			);
			const replay = settledValue(gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" }));
			releasePosts();

			expect((await settling).settled).toBe(true);
			expect(await late).toBeInstanceOf(AlreadySettledError);
			expect(await replay).toBeInstanceOf(AlreadySettledError);
			expect(audit.events.map((e) => e.kind)).not.toContain("settlement_unrecoverable");
			expect(posts()).toHaveLength(1);
			expect(pendings()).toHaveLength(1);
		});

		it("an authorize in flight is waited out: its hold answers held; its refusal leaves the loss recorded", async () => {
			const { gov, audit } = await governor();
			const placing = gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			const late = await gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE });
			expect(late).toEqual({ outcome: "held", transferId: (await placing).transferId });

			// The ledger refuses the next reserve outright (the holding wallet runs dry).
			const holding = ledger.accounts.get(ledger.created[1] as bigint);
			if (holding !== undefined) holding.credits_posted = 1n;
			const refused = gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-2" });
			const afterRefusal = gov.recordUnheldSettlement({ idempotencyKey: "call-2", usage: USAGE });
			await expect(refused).rejects.toBeInstanceOf(InsufficientBalanceError);
			await expect(afterRefusal).resolves.toEqual({ outcome: "unrecoverable", recorded: true });
			expect(audit.events.map((e) => e.kind)).toEqual([
				"ledger_rejected",
				"settlement_unrecoverable",
			]);
		});

		it("an authorize that begins DURING the ledger read is noticed: its hold answers held", async () => {
			// The anchor read awaits. A loss recorded after it without asking again would
			// report as unrecoverable a key that, by then, has a hold that can charge it.
			const { gov, audit } = await governor();
			let releaseLookups: () => void = () => {};
			ledger.holdLookups = new Promise<void>((resolve) => {
				releaseLookups = resolve;
			});
			const late = gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE });
			await vi.waitFor(() => expect(mockClient.lookupTransfers).toHaveBeenCalledTimes(1));
			const placing = gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" });
			releaseLookups();

			const auth = await placing;
			await expect(late).resolves.toEqual({ outcome: "held", transferId: auth.transferId });
			expect(audit.events).toHaveLength(0);
		});

		it("an exact retry is answered without a second record; different usage is a second record", async () => {
			const { gov, audit } = await governor();
			const first = await gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE });
			const retry = await gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE });
			const other = await gov.recordUnheldSettlement({
				idempotencyKey: "call-1",
				usage: { ...USAGE, outputTokens: 999 },
			});

			expect([first, retry, other]).toEqual([
				{ outcome: "unrecoverable", recorded: true },
				{ outcome: "unrecoverable", recorded: false },
				{ outcome: "unrecoverable", recorded: true },
			]);
			expect(audit.events.filter((e) => e.kind === "settlement_unrecoverable")).toHaveLength(2);
		});

		it("a key already charged is AlreadySettledError, and records nothing more", async () => {
			const { gov, audit } = await governor();
			await gov.settle(await gov.authorize({ ...AUTHORIZE, idempotencyKey: "call-1" }), USAGE);

			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).rejects.toBeInstanceOf(AlreadySettledError);
			expect(audit.events.map((e) => e.kind)).toEqual(["llm_call"]);
		});

		it("an unreadable post anchor is LedgerUnavailableError, and records nothing", async () => {
			const { gov, audit } = await governor();
			ledger.failLookups = true;

			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).rejects.toBeInstanceOf(LedgerUnavailableError);
			expect(audit.events).toHaveLength(0);
		});

		it("a record that did not land is the caller's error — never reported as recorded", async () => {
			const { gov, audit } = await governor();
			vi.mocked(audit.appendEvent).mockRejectedValueOnce(new Error("audit: disk full"));

			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).rejects.toThrow("audit: disk full");
			// Nothing is remembered of it: the retry records the loss.
			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).resolves.toEqual({ outcome: "unrecoverable", recorded: true });
			expect(audit.events.map((e) => e.kind)).toEqual(["settlement_unrecoverable"]);
		});

		it("exact retries that arrive TOGETHER share one record — the retry answers once it has landed", async () => {
			// A client resends before its first answer arrives. Were the remembered
			// fingerprints the only check, both calls would pass it before either append
			// landed: one loss recorded, and counted on the server's health, twice.
			const { gov, audit } = await governor();
			let land: () => void = () => {};
			audit.holdAppends = new Promise<void>((resolve) => {
				land = resolve;
			});
			let retryAnswered = false;
			const first = settledValue(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			);
			const retry = settledValue(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).then((value) => {
				retryAnswered = true;
				return value;
			});
			// Both have read the anchor (nothing charged); one macrotask turn more lets
			// every continuation after that read run.
			await vi.waitFor(() => expect(mockClient.lookupTransfers).toHaveBeenCalledTimes(2));
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(audit.appendEvent).toHaveBeenCalledTimes(1);
			// Answered now, the retry would be vouching for a record still in flight.
			expect(retryAnswered).toBe(false);
			land();

			expect(await first).toEqual({ outcome: "unrecoverable", recorded: true });
			expect(await retry).toEqual({ outcome: "unrecoverable", recorded: false });
			expect(audit.events.map((e) => e.kind)).toEqual(["settlement_unrecoverable"]);
		});

		it("a record that did not land fails every retry that waited on it, and leaves nothing remembered", async () => {
			const { gov, audit } = await governor();
			let fail: () => void = () => {};
			const failing = new Promise<void>((resolve) => {
				fail = resolve;
			});
			vi.mocked(audit.appendEvent).mockImplementationOnce(async () => {
				await failing;
				throw new Error("audit: disk full");
			});
			const first = settledValue(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			);
			const retry = settledValue(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			);
			await vi.waitFor(() => expect(mockClient.lookupTransfers).toHaveBeenCalledTimes(2));
			await new Promise((resolve) => setTimeout(resolve, 0));
			fail();

			expect(await first).toEqual(new Error("audit: disk full"));
			expect(await retry).toEqual(new Error("audit: disk full"));
			expect(audit.appendEvent).toHaveBeenCalledTimes(1);
			expect(audit.events).toHaveLength(0);
			// The claim went with the failed append: the next retry records the loss.
			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).resolves.toEqual({ outcome: "unrecoverable", recorded: true });
			expect(audit.events.map((e) => e.kind)).toEqual(["settlement_unrecoverable"]);
		});

		it("a loss record that reached the chain though its append failed after it is remembered: no second record", async () => {
			// The event is fsynced to the log, then the `.meta` sidecar write fails: the
			// writer rejects, with the durable event's hash on the error.
			const { gov, audit } = await governor();
			const sidecarFailed = Object.assign(new Error("audit: meta sidecar write failed"), {
				[Symbol.for("usertrust.audit.durableEventHash")]: "f".repeat(64),
			});
			vi.mocked(audit.appendEvent).mockImplementationOnce(async (input) => {
				audit.events.push(input);
				throw sidecarFailed;
			});

			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).rejects.toThrow("sidecar");
			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).resolves.toEqual({ outcome: "unrecoverable", recorded: false });
			expect(audit.events.map((e) => e.kind)).toEqual(["settlement_unrecoverable"]);
		});

		it("usage without the provider label records the label and no four-tier block (D5)", async () => {
			const { gov, audit } = await governor();

			await gov.recordUnheldSettlement({
				idempotencyKey: "call-1",
				usage: { ...USAGE, usageSource: "estimated" },
			});

			const data = audit.events[0]?.data ?? {};
			expect(data.usageSource).toBe("estimated");
			expect(data).not.toHaveProperty("usage");
		});

		it("an unlabelled call records no principal key at all", async () => {
			const { gov, audit } = await governor();

			await gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE });

			expect(Object.keys(audit.events[0]?.data ?? {})).not.toContain("principal");
		});

		describe("caller input is refused with a TypeError, before any I/O", () => {
			const bad: Array<[string, Record<string, unknown>]> = [
				["no key", { usage: USAGE }],
				["an invalid key", { idempotencyKey: "call 1", usage: USAGE }],
				[
					"an invalid principal",
					{ idempotencyKey: "call-1", principal: { id: "a b", type: "human" } },
				],
			];

			it.each(bad)("%s", async (_label, params) => {
				const { gov, audit } = await governor();
				mockClient.lookupTransfers.mockClear();

				await expect(
					gov.recordUnheldSettlement(
						params as unknown as Parameters<Governor["recordUnheldSettlement"]>[0],
					),
				).rejects.toBeInstanceOf(TypeError);
				expect(mockClient.lookupTransfers).not.toHaveBeenCalled();
				expect(audit.events).toHaveLength(0);
			});
		});

		it("dryRun: no ledger to ask, so the record is written without an anchor read", async () => {
			const audit = makeAudit();
			const gov = await createGovernor({
				dryRun: true,
				budget: 100_000,
				vaultBase: vault(),
				_audit: audit,
			});
			governors.push(gov);

			await expect(
				gov.recordUnheldSettlement({ idempotencyKey: "call-1", usage: USAGE }),
			).resolves.toEqual({ outcome: "unrecoverable", recorded: true });
			expect(mockClient.lookupTransfers).not.toHaveBeenCalled();
			expect(audit.events.map((e) => e.kind)).toEqual(["settlement_unrecoverable"]);
		});
	});
});
