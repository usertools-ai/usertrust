// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * TigerBeetle client wrapper for the usertrust SDK.
 * Provides account/transfer CRUD with reconnect logic and
 * deterministic account IDs.
 */

import { createHash } from "node:crypto";
import type { Account, Client, Transfer } from "tigerbeetle-node";
import {
	AccountFlags,
	amount_max,
	CreateAccountStatus,
	CreateTransferStatus,
	createClient,
	TransferFlags,
} from "tigerbeetle-node";
import { LedgerUnavailableError } from "../shared/errors.js";
import {
	COST_CENTER_PATTERN,
	LEGACY_COST_CENTER_SEPARATOR,
	parentUserIdRefusal,
	tbId,
} from "../shared/ids.js";
import { PRINCIPAL_FIELD_PATTERN } from "../shared/principal.js";

/** Typed error carrying the numeric TB error code for structured matching. */
export class TBTransferError extends Error {
	constructor(
		public readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "TBTransferError";
	}
}

/**
 * A caller-supplied transfer id was answered `exists`, but the STORED transfer is not the
 * one this call describes. `field` names the first difference. Extends TBTransferError so
 * existing catch sites still match; `code` is `exists`.
 *
 * Defence in depth. Measured against a real TigerBeetle 0.17.9
 * (`tests/integration/replay.tb.test.ts`), the server itself refuses every amount-changing
 * post replay with `exists_with_different_amount` — including a larger amount after a full
 * post, and `amount_max` after a partial one. The only amount it answers plain `exists` for
 * is `amount_max` after a FULL post, which is the same intent. The client still verifies
 * every `exists` for a caller-supplied id, so success never rests on that server rule alone.
 */
export class TransferReplayMismatchError extends TBTransferError {
	constructor(
		public readonly transferId: bigint,
		public readonly field: string,
	) {
		super(
			CreateTransferStatus.exists,
			`Transfer ${transferId} exists with a different ${field}: a replay must resubmit the same intent`,
		);
		this.name = "TransferReplayMismatchError";
	}
}

/**
 * A caller-supplied PENDING transfer id was answered `exists` (fields verified): this is a
 * replay, and it must never be read as "reserved". A pending transfer's stored record is
 * immutable — posting, voiding or expiring the hold changes nothing on the row TigerBeetle
 * returns — so the client cannot tell a live hold from one already spent, released or
 * expired. Treating the replay as a live reservation is an overspend path. The caller
 * re-reserves under a NEW id (a new role, e.g. `"reserve#2"`) or denies; if it still holds
 * the old id it may void it, which fails harmlessly when the hold is no longer pending.
 * Extends TBTransferError so existing catch sites still match; `code` is `exists`.
 *
 * Accepted residue (fail closed): if the FIRST attempt's reply was lost after the hold
 * committed, the retry sees `exists` and gets this error although the hold IS live. The
 * caller's re-reserve then holds the amount twice until the first hold leaves — at its
 * timeout, or, with `timeoutSeconds: 0` (no expiry), only when it is voided. A caller that
 * uses `timeoutSeconds: 0` must void the old id itself; nothing else will release it.
 */
export class PendingReplayError extends TBTransferError {
	constructor(public readonly transferId: bigint) {
		super(
			CreateTransferStatus.exists,
			`Pending transfer ${transferId} already exists: a replayed reservation is not a live hold — reserve under a new id`,
		);
		this.name = "PendingReplayError";
	}
}

/**
 * The FIRST attempt under this caller-supplied id failed (e.g. `exceeds_credits`), and
 * TigerBeetle answers `id_already_failed` to every later attempt with the same id: a
 * derived `(key, role)` is permanently retired once it fails. Retrying cannot succeed —
 * the caller must derive a different id. Distinct from a transient failure on purpose.
 */
export class TransferIdRetiredError extends TBTransferError {
	constructor(public readonly transferId: bigint) {
		super(
			CreateTransferStatus.id_already_failed,
			`Transfer id ${transferId} is retired: its first attempt failed, and the same id can never succeed`,
		);
		this.name = "TransferIdRetiredError";
	}
}

/**
 * The task-limit leg of a linked pair was refused: the payer leg answered `linked_event_failed`
 * and this leg carries the real code (`exceeds_credits` when the task is at its limit). Kept apart
 * from a plain TBTransferError so a payer-leg refusal reads exactly as it does without a task,
 * and a task's refusal is never reported as the budget's. `code` is the limit leg's status.
 */
export class TaskLimitLegError extends TBTransferError {
	constructor(code: number, message: string) {
		super(code, message);
		this.name = "TaskLimitLegError";
	}
}

/**
 * This ledger client was destroyed. An operation on it fails rather than reconnecting:
 * a reconnect would build a native client that nothing destroys, and an open TigerBeetle
 * client keeps the process alive (#249). An operation that was in flight at `destroy()`
 * fails with its own error; one started after it fails with this, before any check of its
 * arguments, as does any request a later step or a retry would have made.
 */
export class LedgerClientClosedError extends Error {
	constructor() {
		super("TigerBeetle client was destroyed");
		this.name = "LedgerClientClosedError";
	}
}

const refuseClosed = (): Promise<never> => Promise.reject(new LedgerClientClosedError());

/**
 * The tigerbeetle-node error codes that say the cluster EVICTED this client's session (too
 * many sessions, or a release the cluster does not take). An evicted native client must
 * never be destroyed: in tigerbeetle-node 0.17.9, `destroy()` on one aborts the whole
 * process (SIGABRT, "attempt to unwrap error: ClientInvalid"), which no try/catch can stop.
 */
const EVICTION_CODES: ReadonlySet<string> = new Set([
	"ERR_CLIENT_EVICTED",
	"ERR_CLIENT_RELEASE_TOO_LOW",
	"ERR_CLIENT_RELEASE_TOO_HIGH",
]);

/** A request failed because the cluster evicted the client's session (`EVICTION_CODES`). */
function isEviction(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" && EVICTION_CODES.has(code);
}

/**
 * A request failed `ERR_CLIENT_CLOSED`. tigerbeetle-node raises it in two cases only:
 *  - its JavaScript wrapper, for a request made after OUR `destroy()` of that native client
 *    (`if (!context) throw new RequestError(ERR_CLIENT_CLOSED)` in its `dist/index.js`, 0.17.9),
 *    and for one in flight at that destroy;
 *  - the native client, for every request once it has learned of its own eviction. Measured on
 *    a 0.17.9 cluster: a client whose session was pushed out while it was idle logs "session
 *    evicted" about 25 s later, from its own traffic, and from then on every request fails
 *    `ERR_CLIENT_CLOSED`, at once (0-1 ms), never `ERR_CLIENT_EVICTED`.
 * So a CLOSED from a native client this wrapper never destroyed means that client was evicted
 * (`send`). If a tigerbeetle-node release raises it in another case, the rows that pin both
 * cases (client-destroy.test.ts) are where that shows.
 */
function isClosedByClient(err: unknown): boolean {
	return err instanceof Error && (err as { code?: unknown }).code === "ERR_CLIENT_CLOSED";
}

/**
 * How long `close()` waits for its probe. On loopback the probe answers in about 1 ms. A
 * client that has learned of its eviction fails it at once, so one that has not answered
 * within this has learned of none.
 */
const CLOSE_PROBE_TIMEOUT_MS = 2_000;

/** How long `connectDeadline` waits for a first answer (`tigerbeetle.connectTimeoutMs`, the server's figure). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * What a TrustTBClient holds in place of its native client once destroy() has closed it:
 * every request is refused, so even a read of the field fails closed, and destroying it
 * again is a no-op.
 */
const CLOSED_CLIENT: Client = {
	createAccounts: refuseClosed,
	createTransfers: refuseClosed,
	lookupAccounts: refuseClosed,
	lookupTransfers: refuseClosed,
	getAccountTransfers: refuseClosed,
	getAccountBalances: refuseClosed,
	queryAccounts: refuseClosed,
	queryTransfers: refuseClosed,
	destroy: () => {},
};

// Ledger ID: all usertokens live on ledger 1
export const LEDGER_USERTOKENS = 1;

// Account codes
export const CODE_USER_WALLET = 1;
export const CODE_PLATFORM_TREASURY = 2;
export const CODE_ESCROW = 3;

// Transfer codes
export const XFER_PURCHASE = 1;
export const XFER_SPEND = 2;
export const XFER_TRANSFER = 3;
export const XFER_REFUND = 4;
export const XFER_ALLOCATION = 5;
export const XFER_TOOL_CALL = 6;
export const XFER_A2A_DELEGATION = 7;
/** Cost-center budget returned to its parent. Distinct from XFER_REFUND, which
 * reverses a purchase — a reclaim reverses a delegation, not a sale. */
export const XFER_BUDGET_RECLAIM = 8;
/**
 * Budget delegated from a parent wallet into one of its cost centers.
 *
 * Deliberately NOT XFER_SPEND: a grant moves usertokens between two wallets the
 * same owner controls and consumes nothing. Reconciliation that sums XFER_SPEND
 * debits would otherwise count a delegated budget twice — once moving into the
 * cost center, and again when the cost center actually spends it.
 */
export const XFER_BUDGET_GRANT = 9;

/**
 * Task limits live on their own ledger. They are counters, not usertokens: kept off ledger 1, no
 * usertoken sum or XFER_SPEND reconciliation ever counts a limit or a limit hold.
 */
export const LEDGER_TASK_LIMITS = 2;
/** A task's limit account: `debits_must_not_exceed_credits | history`, on LEDGER_TASK_LIMITS. */
export const CODE_TASK_LIMIT = 4;
/** The per-namespace source a task's limit is credited from: `history` only, unconstrained. */
export const CODE_TASK_LIMIT_OPERATOR = 5;
/** The one immediate credit of a task's limit into its account. */
export const XFER_TASK_LIMIT_GRANT = 10;
/** The task-limit leg of a hold made inside a task (pending, linked to the payer leg). */
export const XFER_TASK_LIMIT_HOLD = 11;
/**
 * `user_data_32` of every task-limit account this version creates: the account's schema. An
 * account's fields cannot change once created, so a later format writes another value and readers
 * branch on it.
 */
export const TASK_ACCOUNT_SCHEMA = 1;

/**
 * The `process.emitWarning` code under which a linked pair's replay that did not match is
 * reported: TigerBeetle answered `exists` for an id this client minted, and the stored transfer is
 * missing or is not the one sent.
 */
export const LINKED_PAIR_MISMATCH_WARNING = "USERTRUST_LEDGER_PAIR_MISMATCH";

/** The `field` of a TransferReplayMismatchError whose transfer was not found at all. */
const NO_RECORD = "record (none found)";

// A pending transfer's `timeout` is a u32 count of seconds in TigerBeetle.
const MAX_TIMEOUT_SECONDS = 0xffff_ffff;

// Domain tag for cost-center account derivation. Versioned so a future encoding change can
// coexist; deliberately NOT "wallet:"-prefixed — prefix disjointness from deriveAccountId's
// preimages is the entire separation mechanism (flags cannot distinguish cost-center wallets).
// Any future domain tag must be prefix-free against every existing tag, or two domains could
// share preimages. The KAT suite pins these bytes: changing them breaks every known answer.
const COST_CENTER_DOMAIN_TAG = Buffer.from("usertrust:cost-center:v1", "utf8");

// Domain tag for caller-derived TRANSFER ids (deriveTransferId). Prefix-free against
// "wallet:" and "usertrust:cost-center:v1" under the same policy as above, although transfer
// and account ids already live in separate TigerBeetle namespaces. The KAT suite pins it.
const TRANSFER_ID_DOMAIN_TAG = Buffer.from("usertrust:transfer:v1", "utf8");

// Domain tags for task-limit derivations, under the same policy: versioned, and prefix-free
// against every tag above and each other ("usertrust:task-limit:" and "usertrust:task-limit-"
// part at their 21st byte). The namespace tag is domain-separated too, rather than a bare hash of
// the namespace, so it cannot equal any other derivation's preimage. The KAT suite pins all three.
const TASK_LIMIT_DOMAIN_TAG = Buffer.from("usertrust:task-limit:v1", "utf8");
const TASK_LIMIT_OPERATOR_DOMAIN_TAG = Buffer.from("usertrust:task-limit-operator:v1", "utf8");
const TASK_NAMESPACE_DOMAIN_TAG = Buffer.from("usertrust:task-namespace:v1", "utf8");

// TigerBeetle reserves 0 and 2^128 - 1; a transfer may use neither as its id.
const MAX_TRANSFER_ID = (1n << 128n) - 1n;

/**
 * Validate a caller-supplied transfer id, or mint a fresh one. Callers that need a
 * transfer to be idempotent ACROSS process restarts (a durable replay, not just a
 * reconnect retry) pass an id derived from their own durable key — see
 * {@link TrustTBClient.deriveTransferId}.
 */
function transferIdOrFresh(transferId: bigint | undefined): bigint {
	if (transferId === undefined) return tbId();
	if (transferId <= 0n || transferId >= MAX_TRANSFER_ID) {
		throw new RangeError(`Transfer id must be in (0, 2^128 - 1): ${transferId}`);
	}
	return transferId;
}

/**
 * sha256 of `tag`, then each part as a big-endian u32 UTF-8 byte length and its bytes; the first
 * 16 bytes, big-endian. The encoding of deriveCostCenterAccountId and deriveTransferId, for the
 * task-limit derivations.
 */
function taggedTupleId(tag: Buffer, parts: string[]): bigint {
	const chunks: Buffer[] = [tag];
	for (const part of parts) {
		const bytes = Buffer.from(part, "utf8");
		const len = Buffer.alloc(4);
		len.writeUInt32BE(bytes.length);
		chunks.push(len, bytes);
	}
	const digest = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
	return BigInt(`0x${digest.slice(0, 32)}`);
}

/** The first field of a replayed create transfer that differs from what was sent, or null. */
function createMismatch(sent: Transfer, stored: Transfer): string | null {
	const checks: Array<[string, bigint | number, bigint | number]> = [
		["flags", sent.flags, stored.flags],
		["pending_id", sent.pending_id, stored.pending_id],
		["debit_account_id", sent.debit_account_id, stored.debit_account_id],
		["credit_account_id", sent.credit_account_id, stored.credit_account_id],
		["amount", sent.amount, stored.amount],
		["ledger", sent.ledger, stored.ledger],
		["code", sent.code, stored.code],
		["timeout", sent.timeout, stored.timeout],
		["user_data_128", sent.user_data_128, stored.user_data_128],
		["user_data_64", sent.user_data_64, stored.user_data_64],
		["user_data_32", sent.user_data_32, stored.user_data_32],
	];
	for (const [field, want, got] of checks) if (want !== got) return field;
	return null;
}

/**
 * The first field of a replayed post or void that differs from what was sent, by TigerBeetle's own
 * exists rule for posts and voids (tigerbeetle 0.17.9, `post_or_void_pending_transfer_exists`).
 * A post or void STORES fields it was not sent: the pending transfer's accounts, ledger and code,
 * its user data where 0 was sent, and for a void sent at 0 the pending's whole amount. So a field
 * sent as 0 is a wildcard and every other field must match. A full-field compare would read every
 * genuine replay as a mismatch, and a settled call as a failed one. The wildcards are exact here:
 * what a stored post or void inherits is fixed by its `pending_id`, which must match, and a void
 * must release the whole pending amount (a smaller one is refused).
 */
function postOrVoidMismatch(sent: Transfer, stored: Transfer): string | null {
	const exact: Array<[string, bigint | number, bigint | number]> = [
		["flags", sent.flags, stored.flags],
		["pending_id", sent.pending_id, stored.pending_id],
		["timeout", sent.timeout, stored.timeout],
	];
	for (const [field, want, got] of exact) if (want !== got) return field;
	// A void sent at 0 stores the pending's amount; any other amount, a post's 0 included, is
	// stored as sent. The pair methods never send amount_max, so that branch of the rule is not
	// reachable from here.
	const voidAtZero = (sent.flags & TransferFlags.void_pending_transfer) !== 0 && sent.amount === 0n;
	if (!voidAtZero && sent.amount !== stored.amount) return "amount";
	const unlessZero: Array<[string, bigint | number, bigint | number]> = [
		["debit_account_id", sent.debit_account_id, stored.debit_account_id],
		["credit_account_id", sent.credit_account_id, stored.credit_account_id],
		["user_data_128", sent.user_data_128, stored.user_data_128],
		["user_data_64", sent.user_data_64, stored.user_data_64],
		["user_data_32", sent.user_data_32, stored.user_data_32],
		["ledger", sent.ledger, stored.ledger],
		["code", sent.code, stored.code],
	];
	for (const [field, want, got] of unlessZero) {
		if (want === 0n || want === 0) continue;
		if (want !== got) return field;
	}
	return null;
}

/**
 * Report a linked pair's replay that did not match, beside the error the caller throws: an id this
 * client minted answered `exists` for a transfer it did not send, or for none at all. That is an
 * integrity fault, not a retryable failure, so it is said on `console.warn` and as a process
 * warning with the stable code {@link LINKED_PAIR_MISMATCH_WARNING}. It names the transfer id and
 * the field, nothing else.
 */
function reportPairMismatch(transferId: bigint, field: string): void {
	const what = field === NO_RECORD ? "no stored record was found" : `its stored ${field} differs`;
	const message = `linked pair replay did not match: transfer ${transferId} answered exists, but ${what}`;
	console.warn(`[TB] ${message}`);
	process.emitWarning(message, { code: LINKED_PAIR_MISMATCH_WARNING });
}

/**
 * Per-account available/pending/total balance, shared by {@link TrustTBClient.lookupBalance}
 * and {@link TrustTBClient.lookupBalances} so the overflow guards live in exactly ONE
 * place. Module-private: nothing outside this file computes a balance from raw `Account`
 * fields, which is the documented anti-pattern — the guards below are what stand between a
 * corrupted TB response and a `NaN`/silently-wrapped balance reaching budget arithmetic.
 */
function accountBalance(acct: Account): {
	available: number;
	pending: number;
	total: number;
} {
	const postedBig = acct.credits_posted - acct.debits_posted;
	if (postedBig > BigInt(Number.MAX_SAFE_INTEGER) || postedBig < -BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(
			`[TB] Balance overflow: ${postedBig.toString()} exceeds Number.MAX_SAFE_INTEGER`,
		);
	}
	const pendingBig = acct.debits_pending;
	if (pendingBig > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(
			`[TB] Pending overflow: ${pendingBig.toString()} exceeds Number.MAX_SAFE_INTEGER`,
		);
	}
	const posted = Number(postedBig);
	const pending = Number(acct.debits_pending);
	return {
		available: Math.max(0, posted - pending),
		pending,
		total: Math.max(0, posted),
	};
}

export interface TrustTBClientOptions {
	addresses: string[];
	clusterId?: bigint;
	/** Optional callback invoked on connection issues (replaces sendAlert) */
	onAlert?: (message: string, meta: Record<string, unknown>) => void;
}

export class TrustTBClient {
	// The native client, and CLOSED_CLIENT once destroy() has closed it. Read only by the
	// constructor, native(), _doReconnect() and destroy(): every request goes through
	// native(). A test parses this file to hold that.
	private client: Client;
	private accountMap = new Map<string, bigint>();
	private treasuryId: bigint | undefined;
	private initialized = false;
	private readonly startedAt = Date.now();
	private readonly initGraceMs = 60_000;
	private opts: Required<Pick<TrustTBClientOptions, "addresses" | "clusterId">>;
	private onAlert?: (message: string, meta: Record<string, unknown>) => void;
	private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
	private reconnectPromise: Promise<void> | null = null;
	// The health check's ping is still outstanding.
	private healthCheckInFlight = false;
	// The health check has said it is failing, and no check has answered since (noteHealth).
	private healthAlerted = false;
	// Set first by destroy(); from then on this client never reconnects (#249). The native
	// client cannot say so itself: its ERR_CLIENT_CLOSED does not tell a destroy() from our
	// own reconnect, which closes the old client too, and an operation in flight on THAT one
	// must still retry on the new client. Only this wrapper knows it was destroyed.
	private closed = false;
	// Native clients the cluster has evicted (a request on one failed with an eviction code, or
	// with CLOSED though this wrapper never destroyed it: `isClosedByClient`). Never destroyed:
	// a reconnect drops one and builds a fresh client, and destroy() leaves one alone. Weak, so
	// a dropped client is not kept alive by this set.
	private readonly evicted = new WeakSet<Client>();
	// Native clients this wrapper has destroyed (or tried to: one whose native destroy threw is
	// here too), each added BEFORE its native destroy is called. A CLOSED from one of these is
	// our own destroy's, never an eviction.
	private readonly released = new WeakSet<Client>();
	// How many native clients were evicted, counted once each, when first marked. Each is left
	// open (it cannot be released) and keeps the process from exiting on its own: destroy()
	// says so, once.
	private droppedEvicted = 0;
	private evictionAlerted = false;
	// Which native client is current, as a count: _doReconnect bumps it each time it installs
	// one. A failed request carries the generation it ran on, so a failure from a client already
	// replaced is told apart without reading the client itself.
	private generation = 0;

	constructor(opts: TrustTBClientOptions) {
		this.opts = {
			addresses: opts.addresses,
			clusterId: opts.clusterId ?? 0n,
		};
		if (opts.onAlert) {
			this.onAlert = opts.onAlert;
		}
		this.client = createClient({
			cluster_id: this.opts.clusterId,
			replica_addresses: this.opts.addresses,
		});
		this.healthCheckInterval = setInterval(() => {
			// Single-flight: a tick submits nothing while the previous tick's check is outstanding.
			// tigerbeetle-node has no request timeout, and a request the cluster never answers stays
			// queued in the native client, so during an outage each tick would otherwise add one more
			// request (and its callback) for as long as the outage lasts.
			// A check still unanswered a whole interval later is itself the ledger not answering.
			if (this.healthCheckInFlight) {
				this.noteHealth(false, "the previous check has not been answered for 30 s");
				return;
			}
			this.healthCheckInFlight = true;
			// ping() answers false rather than rejecting, and its lookup already reconnects on a lost
			// connection or an eviction (withReconnect): the tick reads the answer and reconnects nothing.
			this.ping()
				.then((healthy) =>
					this.noteHealth(healthy, "the treasury lookup failed or found no account"),
				)
				// ping() answers false rather than rejecting today. Should that ever change, a rejection
				// here would have no consumer, and an unhandled rejection ends the process.
				.catch(() => this.noteHealth(false, "the health check itself failed"))
				.finally(() => {
					this.healthCheckInFlight = false;
				});
		}, 30_000);
		// Do not let the health-check timer keep the Node event loop alive. Without
		// this, a process that forgets to call destroy() can never exit — and the
		// beforeExit cleanup net (which only fires on an otherwise-empty loop) never
		// runs. The timer still fires while the loop is busy.
		this.healthCheckInterval.unref?.();
	}

	/**
	 * What the health check concluded, said once per outage: one alert when a check first fails,
	 * none while it keeps failing, and one when a check answers again. Only a client with a
	 * treasury is checked (without one, ping() answers its start-up grace, not the ledger), and
	 * nothing is said once destroy() has run. The alert never throws out of here: an onAlert that
	 * throws would otherwise reject the tick's promise, with nothing to catch it.
	 */
	private noteHealth(healthy: boolean, why: string): void {
		if (this.closed || !this.initialized || !this.treasuryId) return;
		if (healthy !== this.healthAlerted) return;
		this.healthAlerted = !healthy;
		const msg = healthy
			? "TigerBeetle health check recovered: the ledger answers again"
			: `TigerBeetle health check failed: ${why}`;
		const meta = healthy ? {} : { reason: why };
		try {
			if (this.onAlert) this.onAlert(msg, meta);
			else console.warn(`[usertrust] ${msg}`, meta);
		} catch {
			/* an alert sink that throws must not break the health check */
		}
	}

	private isConnectionError(err: unknown): boolean {
		if (!(err instanceof Error)) return false;
		const msg = err.message.toLowerCase();
		return (
			msg.includes("connection refused") ||
			msg.includes("econnrefused") ||
			msg.includes("econnreset") ||
			msg.includes("client is closed") ||
			msg.includes("closed") ||
			msg.includes("not connected") ||
			msg.includes("socket") ||
			msg.includes("timeout")
		);
	}

	/**
	 * Every public ledger operation calls this FIRST, before its own input checks and any
	 * shortcut, so one started after destroy() fails with LedgerClientClosedError whatever its
	 * arguments: a caller can tell shutdown from a refused input.
	 */
	private assertOpen(): void {
		if (this.closed) throw new LedgerClientClosedError();
	}

	/**
	 * The native client, for ONE request made right now. The check is here, at the moment
	 * of each request, and not only at an operation's entry: an await lets destroy() land
	 * between an operation's steps, and between a reconnect and its retry. A native destroy
	 * that threw leaves its client open, and this check is all that stands in the way.
	 * Only withReconnect() calls this, and it passes the client to a closure that makes its
	 * one request synchronously, so no native reference outlives an await.
	 */
	private native(): Client {
		this.assertOpen();
		return this.client;
	}

	/**
	 * Replace the native client, or join the reconnect in flight. `from`: the generation a
	 * failed request ran on. When that client was already replaced, nothing is started and
	 * nothing is cached: the request retries on the current client. So a late failure from an
	 * old client (its eviction, or the "closed" after it) neither churns a healthy replacement
	 * nor leaves a no-op behind for a failure on the current client to join.
	 */
	async reconnect(from?: number): Promise<void> {
		// Refused once destroyed, BEFORE the dedup. A reconnect that just finished stays
		// cached until its cleanup runs, and handing it back would answer success for a
		// client destroy() has closed.
		this.assertOpen();
		if (this.reconnectPromise) return this.reconnectPromise;
		// Staleness is decided only now, after joining any reconnect in flight, and a stale
		// failure never caches anything: its retry goes to the client that replaced its own.
		if (from !== undefined && from !== this.generation) return;
		this.reconnectPromise = this._doReconnect().finally(() => {
			this.reconnectPromise = null;
		});
		return this.reconnectPromise;
	}

	private async _doReconnect(): Promise<void> {
		const maxRetries = 5;
		for (let attempt = 0; attempt < maxRetries; attempt++) {
			// destroy() may have landed while this waited out its backoff: build no client.
			// createClient is synchronous below, so one check per attempt covers it.
			this.assertOpen();
			try {
				console.log(`[TB] Reconnection attempt ${attempt + 1}/${maxRetries}`);
				// An evicted client is dropped, never destroyed: destroy() on one aborts the
				// process (`EVICTION_CODES`). Its requests have all failed already, and nothing
				// here keeps a reference to it once the fresh client below replaces it.
				if (!this.evicted.has(this.client)) {
					this.released.add(this.client);
					try {
						this.client.destroy();
					} catch {
						/* ignore destroy errors */
					}
				}
				this.client = createClient({
					cluster_id: this.opts.clusterId,
					replica_addresses: this.opts.addresses,
				});
				this.generation += 1;
				return;
			} catch (err) {
				if (attempt === maxRetries - 1) {
					console.error("[TB] CRITICAL: All reconnection attempts failed");
					const msg = "TigerBeetle connection lost — all reconnection attempts failed";
					if (this.onAlert) {
						this.onAlert(msg, {});
					} else {
						console.warn(`[usertrust] ${msg}`);
					}
					throw err;
				}
				const delay = 1000 * 2 ** attempt;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	/**
	 * One request on `native`. A request the cluster refuses with an eviction code, or that fails
	 * CLOSED on a client this wrapper never destroyed (it learned of its eviction on its own:
	 * `isClosedByClient`), marks the client it ran on as evicted (counted once), so nothing ever
	 * destroys it. Every attempt goes through here, the retry and close()'s probe included, so a
	 * fresh client evicted in turn is marked too.
	 */
	private async send<T>(request: (native: Client) => Promise<T>, native: Client): Promise<T> {
		try {
			return await request(native);
		} catch (err) {
			const evicted = isEviction(err) || (isClosedByClient(err) && !this.released.has(native));
			if (evicted && !this.evicted.has(native)) {
				this.evicted.add(native);
				this.droppedEvicted += 1;
			}
			throw err;
		}
	}

	private async withReconnect<T>(request: (native: Client) => Promise<T>): Promise<T> {
		// Read with the client, before the request: the generation this request runs on.
		const from = this.generation;
		try {
			return await this.send(request, this.native());
		} catch (err) {
			// Destroyed while this was in flight: its own error stands, and no reconnect.
			// A POST that committed but lost its reply here would, by reconnecting, have been
			// answered `exists` on a fresh client: a success, on a client nothing destroys.
			// It now fails (a settle records `settlement_ambiguous`); its charge stands.
			// native()'s own LedgerClientClosedError is rethrown here too.
			if (this.closed) throw err;
			// The cluster evicted this client (`send` marked it, so no reconnect or destroy() ever
			// destroys it): the request is retried on a fresh client, as for a lost connection.
			// A client that learned of its eviction on its own fails "closed" instead, which
			// `send` marked too, and which reaches the same reconnect. A client whose release the
			// cluster refuses is evicted again: one more dropped client per call.
			if (isEviction(err) || this.isConnectionError(err)) {
				await this.reconnect(from);
				// native() again: destroy() may have landed while the reconnect settled.
				return await this.send(request, this.native());
			}
			throw err;
		}
	}

	/**
	 * Derive a deterministic TigerBeetle account ID from a userId via SHA-256
	 * truncation. Uses 128 bits (full TB u128 space) to minimize collision risk.
	 */
	static deriveAccountId(userId: string): bigint {
		const hash = createHash("sha256").update(`wallet:${userId}`).digest("hex");
		return BigInt(`0x${hash.slice(0, 32)}`);
	}

	/**
	 * Cost-center account ids hash the (parent, costCenter) TUPLE — domain-separated from the
	 * "wallet:" namespace and length-prefixed with UTF-8 byte lengths — never a joined string.
	 * Pure and total over strings: no validation, no Unicode normalization (both live at the
	 * doors); normalizing here would alias two byte strings to one account. The length prefixes
	 * are what make ("ab","c") ≠ ("a","bc") regardless of charset, which is what lets parent ids
	 * contain ":" (issue #64). Length prefixes count UTF-8 BYTES. Code-unit counts would be
	 * injective too, but a reimplementation reading "length" the other way derives different ids
	 * for every multibyte parent — silent cross-implementation divergence, which the multibyte
	 * KAT in the test suite pins shut.
	 */
	static deriveCostCenterAccountId(parentUserId: string, costCenter: string): bigint {
		const parent = Buffer.from(parentUserId, "utf8");
		const cc = Buffer.from(costCenter, "utf8");
		const lenParent = Buffer.alloc(4);
		lenParent.writeUInt32BE(parent.length);
		const lenCc = Buffer.alloc(4);
		lenCc.writeUInt32BE(cc.length);
		const digest = createHash("sha256")
			.update(Buffer.concat([COST_CENTER_DOMAIN_TAG, lenParent, parent, lenCc, cc]))
			.digest("hex");
		return BigInt(`0x${digest.slice(0, 32)}`);
	}

	/**
	 * A deterministic TRANSFER id for a caller's durable `(key, role)` — e.g. a hold key and
	 * `"reserve" | "post" | "void"` — so a replay after a crash resubmits the SAME id and
	 * TigerBeetle answers `exists` (every field identical) instead of creating a second
	 * transfer. Same encoding discipline as {@link deriveCostCenterAccountId}: domain tag, then
	 * UTF-8 byte-length-prefixed parts, sha256, first 16 BYTES big-endian. Pure and total; it
	 * never validates or normalizes. The 2^-128-scale chance of a reserved value (0 or
	 * 2^128 - 1) is refused at the door ({@link transferIdOrFresh}), not remapped here.
	 *
	 * Three consequences of a derived id, all enforced by the client:
	 * - `exists` is VERIFIED against the stored transfer before it counts as success
	 *   ({@link TransferReplayMismatchError}) — defence in depth: TigerBeetle 0.17.9 already
	 *   refuses an amount-changing replay with `exists_with_different_amount`.
	 * - A replayed PENDING transfer is never "reserved" ({@link PendingReplayError}): its
	 *   stored record cannot say whether the hold is still live. Re-reserve under a new role
	 *   or deny. Post and void replays are unaffected.
	 * - An id whose FIRST attempt failed is retired for good: TigerBeetle answers
	 *   `id_already_failed` to every later attempt, surfaced as {@link TransferIdRetiredError}.
	 *   Retrying after, say, a top-up cannot succeed under the same `(key, role)` — derive a
	 *   new role (e.g. `"post#2"`) for the new attempt.
	 */
	static deriveTransferId(key: string, role: string): bigint {
		const k = Buffer.from(key, "utf8");
		const r = Buffer.from(role, "utf8");
		const lenK = Buffer.alloc(4);
		lenK.writeUInt32BE(k.length);
		const lenR = Buffer.alloc(4);
		lenR.writeUInt32BE(r.length);
		const digest = createHash("sha256")
			.update(Buffer.concat([TRANSFER_ID_DOMAIN_TAG, lenK, k, lenR, r]))
			.digest("hex");
		return BigInt(`0x${digest.slice(0, 32)}`);
	}

	/**
	 * A task's limit account id, which is also the task's key: derived from the `(namespace,
	 * taskId)` tuple, never looked up, so every process on one cluster reaches the same account for
	 * the same task. Same encoding discipline as {@link deriveCostCenterAccountId}; pure and total,
	 * validation lives at the doors.
	 */
	static deriveTaskLimitAccountId(namespace: string, taskId: string): bigint {
		return taggedTupleId(TASK_LIMIT_DOMAIN_TAG, [namespace, taskId]);
	}

	/** The per-namespace account task limits are credited from. Derived, never looked up. */
	static deriveTaskLimitOperatorId(namespace: string): bigint {
		return taggedTupleId(TASK_LIMIT_OPERATOR_DOMAIN_TAG, [namespace]);
	}

	/**
	 * The namespace tag a task-limit account carries in `user_data_128`, so the accounts of one
	 * namespace can be listed by a ledger query. Not an id: a value in its own domain.
	 */
	static taskNamespaceTag(namespace: string): bigint {
		return taggedTupleId(TASK_NAMESPACE_DOMAIN_TAG, [namespace]);
	}

	/**
	 * Create (or return) the balance-enforced wallet for a user id.
	 *
	 * `::` IS QUARANTINED — see {@link LEGACY_COST_CENTER_SEPARATOR}. Not as the
	 * retired derivation reservation: the tuple hash killed that, and no string
	 * passed here is a preimage of any account
	 * {@link TrustTBClient.deriveCostCenterAccountId} produces. It is refused
	 * because on a cluster upgraded from v2.x an unreclaimed legacy cost center
	 * still SITS at `deriveAccountId("parent::cc")` with `CODE_USER_WALLET` and
	 * an ordinary wallet's flags. Without this refusal `createUserWallet`
	 * hashes straight onto it, TigerBeetle answers `exists` (not
	 * `exists_with_different_flags` — the flags match exactly), this method
	 * reads that as success, and the caller's brand-new wallet silently adopts a
	 * stranded cost center's balance. A pending hold voided after the upgrade
	 * re-strands funds there even on a cleanly reclaimed cluster, which is why
	 * the migration alone is not enough.
	 *
	 * Single `:` stays legal (issue #64) — `acct:123` is a wallet id like any
	 * other. Only the doubled separator is quarantined, and it was refused here
	 * on every released version before v3, so nothing legal is lost.
	 *
	 * Ordinary wallet ids and escrow labels still hash through the SAME
	 * `"wallet:"` namespace as each other — see
	 * {@link TrustTBClient.ensureEscrowAccount}, which carries the same refusal
	 * for the same reason — and collide safely only because their differing
	 * account flags make TigerBeetle answer `exists_with_different_flags` rather
	 * than silently sharing a balance.
	 *
	 * There is no `{ derived: true }` opt-in any more: it retired with its last
	 * caller. A cost-center account is reachable only by handing the PAIR to
	 * {@link TrustTBClient.createCostCenterWallet}, so no single string — however
	 * it is punctuated, and whatever flag accompanies it — is a preimage of one.
	 */
	async createUserWallet(userId: string): Promise<bigint> {
		this.assertOpen();
		if (userId.includes(LEGACY_COST_CENTER_SEPARATOR)) {
			throw new Error(
				`Invalid userId: "${LEGACY_COST_CENTER_SEPARATOR}" is reserved for pre-v3 cost-center accounts and may not name a wallet`,
			);
		}

		const existing = this.accountMap.get(userId);
		if (existing) return existing;

		const accountId = TrustTBClient.deriveAccountId(userId);
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			reserved: 0,
			ledger: LEDGER_USERTOKENS,
			code: CODE_USER_WALLET,
			flags: AccountFlags.debits_must_not_exceed_credits | AccountFlags.history,
			timestamp: 0n,
		};

		const results = await this.withReconnect((native) => native.createAccounts([account]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// `exists` is treated as success — the wallet is already present.
			if (res.status !== CreateAccountStatus.created && res.status !== CreateAccountStatus.exists) {
				throw new Error(
					`Failed to create account: ${CreateAccountStatus[res.status] ?? res.status}`,
				);
			}
		}

		this.accountMap.set(userId, accountId);
		return accountId;
	}

	/**
	 * Create (or return) the balance-enforced wallet for a cost center.
	 *
	 * The id comes from {@link TrustTBClient.deriveCostCenterAccountId} — the tuple is
	 * never joined into a string, so no `(parent, costCenter)` pair can reach another
	 * pair's account and no ordinary wallet id can reach any of them. That determinism
	 * is exactly what licenses `exists` as success: the account TigerBeetle reports is
	 * the account this call asked for, so a retry after a socket reset is a no-op
	 * rather than a second wallet. Every `exists_with_different_*` stays a hard failure
	 * — `exists_with_different_flags` is an account missing its
	 * `debits_must_not_exceed_credits` enforcement, which a blanket `try/catch` around
	 * this call would silently accept.
	 *
	 * Validation here is a BELT to the budget path's braces: the derivation is total
	 * over strings, so nothing but this door keeps a control character out of a wallet
	 * that the audit trail then quotes. ASCII is door policy, not a property of the
	 * derivation. The parent rule comes from `parentUserIdRefusal` — one authoritative
	 * source shared with `budget/allocation.ts` — so the `::` quarantine that
	 * {@link TrustTBClient.createUserWallet} applies to wallet ids reaches parent ids
	 * here without a second copy of the rule.
	 *
	 * Deliberately does NOT write `accountMap`: the id is derived, never looked up, and
	 * a cache would only be a second source of truth that a client in another process
	 * does not share.
	 *
	 * @throws Error when either part is outside its charset, when the parent is inside
	 * the quarantined `::` namespace, or when TigerBeetle refuses.
	 */
	async createCostCenterWallet(parentUserId: string, costCenter: string): Promise<bigint> {
		this.assertOpen();
		const parentRefusal = parentUserIdRefusal(parentUserId);
		if (parentRefusal !== null) {
			throw new Error(`Invalid parentUserId: ${parentRefusal}`);
		}
		if (typeof costCenter !== "string" || !COST_CENTER_PATTERN.test(costCenter)) {
			throw new Error(`Invalid costCenter: must match ${COST_CENTER_PATTERN.source}`);
		}

		const accountId = TrustTBClient.deriveCostCenterAccountId(parentUserId, costCenter);
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			reserved: 0,
			ledger: LEDGER_USERTOKENS,
			code: CODE_USER_WALLET,
			flags: AccountFlags.debits_must_not_exceed_credits | AccountFlags.history,
			timestamp: 0n,
		};

		const results = await this.withReconnect((native) => native.createAccounts([account]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// `exists` is treated as success — the wallet is already present.
			if (res.status !== CreateAccountStatus.created && res.status !== CreateAccountStatus.exists) {
				throw new Error(
					`Failed to create cost-center wallet: ${CreateAccountStatus[res.status] ?? res.status}`,
				);
			}
		}

		return accountId;
	}

	/**
	 * Create (or return) the account a namespace's task limits are credited from, on
	 * LEDGER_TASK_LIMITS. Unconstrained (`history` only), like the treasury: it is the source the
	 * limits are counted out of, and nothing spends from it. Derived, so `exists` is this same
	 * account and is success; every `exists_with_different_*` stays a hard failure.
	 *
	 * @throws Error when the namespace is outside the parent-id charset (or in the quarantined `::`
	 * form), before any request, or when TigerBeetle refuses.
	 */
	async createTaskLimitOperator(namespace: string): Promise<bigint> {
		this.assertOpen();
		const refusal = parentUserIdRefusal(namespace);
		if (refusal !== null) throw new Error(`Invalid task-limit namespace: ${refusal}`);
		const accountId = TrustTBClient.deriveTaskLimitOperatorId(namespace);
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			reserved: 0,
			ledger: LEDGER_TASK_LIMITS,
			code: CODE_TASK_LIMIT_OPERATOR,
			flags: AccountFlags.history,
			timestamp: 0n,
		};
		await this.createDerivedAccount(account, "task-limit operator");
		return accountId;
	}

	/**
	 * Create (or return) a task's limit account, on LEDGER_TASK_LIMITS. Its
	 * `debits_must_not_exceed_credits` flag bounds what the task's holds and charges may add up to
	 * by what its limit credited. Derived from
	 * `(namespace, taskId)`, so a second process, or a restart, reaches this same account, and
	 * `exists` is success. Every `exists_with_different_*` is a hard failure: an account without the
	 * flag, or of another schema, is not a task limit this version can trust.
	 *
	 * Its fields are fixed at creation and reserved for later versions: `user_data_128` is the
	 * namespace tag, `user_data_64` is 0, and `user_data_32` is TASK_ACCOUNT_SCHEMA.
	 *
	 * @throws Error when the namespace or the task id is outside its charset, before any request,
	 * or when TigerBeetle refuses.
	 */
	async createTaskLimitAccount(namespace: string, taskId: string): Promise<bigint> {
		this.assertOpen();
		const refusal = parentUserIdRefusal(namespace);
		if (refusal !== null) throw new Error(`Invalid task-limit namespace: ${refusal}`);
		if (typeof taskId !== "string" || !PRINCIPAL_FIELD_PATTERN.test(taskId)) {
			throw new Error(`Invalid task id: must match ${PRINCIPAL_FIELD_PATTERN.source}`);
		}
		const accountId = TrustTBClient.deriveTaskLimitAccountId(namespace, taskId);
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: TrustTBClient.taskNamespaceTag(namespace),
			user_data_64: 0n,
			user_data_32: TASK_ACCOUNT_SCHEMA,
			reserved: 0,
			ledger: LEDGER_TASK_LIMITS,
			code: CODE_TASK_LIMIT,
			flags: AccountFlags.debits_must_not_exceed_credits | AccountFlags.history,
			timestamp: 0n,
		};
		await this.createDerivedAccount(account, "task-limit account");
		return accountId;
	}

	/** One derived account: `created` and `exists` are success, every other status throws. */
	private async createDerivedAccount(account: Account, what: string): Promise<void> {
		const results = await this.withReconnect((native) => native.createAccounts([account]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			if (res.status !== CreateAccountStatus.created && res.status !== CreateAccountStatus.exists) {
				const status = CreateAccountStatus[res.status] ?? res.status;
				throw new Error(`Failed to create ${what}: ${status}`);
			}
		}
	}

	setTreasuryId(id: bigint): void {
		this.treasuryId = id;
		this.initialized = true;
	}

	async createTreasury(): Promise<bigint> {
		this.assertOpen();
		if (this.treasuryId) {
			const tid = this.treasuryId;
			const accounts = await this.withReconnect((native) => native.lookupAccounts([tid]));
			if (accounts.length > 0) return this.treasuryId;
		}

		const accountId = this.treasuryId ?? tbId();
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			reserved: 0,
			ledger: LEDGER_USERTOKENS,
			code: CODE_PLATFORM_TREASURY,
			flags: AccountFlags.history,
			timestamp: 0n,
		};

		const results = await this.withReconnect((native) => native.createAccounts([account]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			if (res.status !== CreateAccountStatus.created) {
				throw new Error(
					`Failed to create treasury: ${CreateAccountStatus[res.status] ?? res.status}`,
				);
			}
		}

		this.treasuryId = accountId;
		this.initialized = true;
		return accountId;
	}

	/**
	 * Create (or return) the escrow account for a label.
	 *
	 * `::` IS QUARANTINED here too — see {@link LEGACY_COST_CENTER_SEPARATOR}.
	 * Escrow labels hash through the same {@link TrustTBClient.deriveAccountId}
	 * `"wallet:"` namespace as ordinary wallets, so
	 * `ensureEscrowAccount("parent::cc")` lands on exactly the account an
	 * unreclaimed pre-v3 cost center still occupies on an upgraded cluster. The
	 * flags differ there (escrow carries no `debits_must_not_exceed_credits`),
	 * so THIS door would be told `exists_with_different_flags` and throw — but
	 * the quarantine holds at every door into the namespace rather than at the
	 * ones where a flag mismatch happens to save us, because that is a property
	 * of today's account codes and not of the names. A future escrow account
	 * created with wallet flags, or a legacy account created before the escrow
	 * flags settled, turns the flag mismatch back into a bare `exists` — and an
	 * `exists` read as success is a stranded legacy balance adopted as escrow.
	 *
	 * The real cost-center account space is unreachable from here regardless: it
	 * comes from {@link TrustTBClient.deriveCostCenterAccountId}, a
	 * domain-separated preimage disjoint from `"wallet:"`. Single `:` stays
	 * legal — `escrow:session-1` is an ordinary label.
	 */
	async ensureEscrowAccount(label: string): Promise<bigint> {
		this.assertOpen();
		if (label.includes(LEGACY_COST_CENTER_SEPARATOR)) {
			throw new Error(
				`Invalid escrow label: "${LEGACY_COST_CENTER_SEPARATOR}" is reserved for pre-v3 cost-center accounts and may not name an escrow account`,
			);
		}

		const accountId = TrustTBClient.deriveAccountId(label);
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			reserved: 0,
			ledger: LEDGER_USERTOKENS,
			code: CODE_ESCROW,
			flags: AccountFlags.history,
			timestamp: 0n,
		};

		const results = await this.withReconnect((native) => native.createAccounts([account]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// `exists` is treated as success — the escrow account is already present.
			if (res.status !== CreateAccountStatus.created && res.status !== CreateAccountStatus.exists) {
				throw new Error(
					`Failed to create escrow account: ${CreateAccountStatus[res.status] ?? res.status}`,
				);
			}
		}

		return accountId;
	}

	/**
	 * Create a per-session budget wallet that TigerBeetle balance-enforces.
	 *
	 * The account carries `debits_must_not_exceed_credits` and is seeded with
	 * `seedCredits` usertokens via an ALLOCATION transfer from the treasury (the
	 * mint). Any pending debit against this wallet is atomically REJECTED by TB
	 * once cumulative (debits_pending + debits_posted) would exceed the seed —
	 * surfaced by createPendingTransfer as a {@link TBTransferError}.
	 *
	 * Returns a FRESH, non-deterministic account id (tbId()) every call, so
	 * re-initialising across processes never double-funds a shared deterministic
	 * account (which would inflate the enforced budget on every restart).
	 */
	async createFundedBudgetWallet(seedCredits: number): Promise<bigint> {
		this.assertOpen();
		const treasury = this.getTreasuryId(); // throws if treasury not initialized
		const accountId = tbId();
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			reserved: 0,
			ledger: LEDGER_USERTOKENS,
			code: CODE_USER_WALLET,
			flags: AccountFlags.debits_must_not_exceed_credits | AccountFlags.history,
			timestamp: 0n,
		};
		const results = await this.withReconnect((native) => native.createAccounts([account]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			if (res.status !== CreateAccountStatus.created) {
				throw new Error(
					`Failed to create budget wallet: ${CreateAccountStatus[res.status] ?? res.status}`,
				);
			}
		}
		// Fund from the treasury mint. The account id is fresh, so this seeding
		// transfer runs exactly once per wallet.
		const seed = Number.isFinite(seedCredits) && seedCredits > 0 ? Math.floor(seedCredits) : 0;
		if (seed > 0) {
			await this.immediateTransfer({
				debitAccountId: treasury,
				creditAccountId: accountId,
				amount: seed,
				code: XFER_ALLOCATION,
			});
		}
		return accountId;
	}

	setAccountMapping(userId: string, accountId: bigint): void {
		this.accountMap.set(userId, accountId);
	}

	getAccountId(userId: string): bigint {
		const id = this.accountMap.get(userId);
		if (!id) throw new Error(`No TigerBeetle account for user: ${userId}`);
		return id;
	}

	getTreasuryId(): bigint {
		if (!this.treasuryId) throw new Error("Treasury not initialized");
		return this.treasuryId;
	}

	/**
	 * A caller-supplied id answered `exists`: confirm the STORED transfer is the one `submitted`
	 * describes before treating it as success (see {@link TransferReplayMismatchError}). A
	 * submitted field TigerBeetle fills in from the pending transfer (0 ids/ledger/code/user
	 * data on a post or void, `amount_max` or 0 for the amount) is skipped; every other field
	 * must match exactly. A minted id needs none of this: its only replay is a reconnect retry
	 * of the identical transfer.
	 */
	private async assertReplayMatches(submitted: Transfer): Promise<void> {
		const stored = await this.lookupTransfer(submitted.id);
		if (!stored) throw new TransferReplayMismatchError(submitted.id, "record (none found)");
		const resolvesPending =
			(submitted.flags &
				(TransferFlags.post_pending_transfer | TransferFlags.void_pending_transfer)) !==
			0;
		const inherited = (v: bigint | number) => resolvesPending && (v === 0n || v === 0);
		const checks: Array<[string, bigint | number, bigint | number]> = [
			["flags", submitted.flags, stored.flags],
			["pending_id", submitted.pending_id, stored.pending_id],
			["debit_account_id", submitted.debit_account_id, stored.debit_account_id],
			["credit_account_id", submitted.credit_account_id, stored.credit_account_id],
			["ledger", submitted.ledger, stored.ledger],
			["code", submitted.code, stored.code],
			["timeout", submitted.timeout, stored.timeout],
			["user_data_128", submitted.user_data_128, stored.user_data_128],
			["user_data_64", submitted.user_data_64, stored.user_data_64],
			["user_data_32", submitted.user_data_32, stored.user_data_32],
		];
		for (const [field, want, got] of checks) {
			if (inherited(want)) continue;
			if (want !== got) throw new TransferReplayMismatchError(submitted.id, field);
		}
		// amount_max (post) and 0 (void) mean "whatever the pending transfer holds".
		const amountInherited =
			resolvesPending && (submitted.amount === amount_max || submitted.amount === 0n);
		if (!amountInherited && submitted.amount !== stored.amount) {
			throw new TransferReplayMismatchError(submitted.id, "amount");
		}
	}

	/**
	 * The shared `exists` / `id_already_failed` handling for a caller-supplied id. Returns
	 * normally when the result is a verified success; throws otherwise. Callers keep their
	 * own message for every other status.
	 */
	private async settleCallerSuppliedStatus(status: number, submitted: Transfer): Promise<void> {
		if (status === CreateTransferStatus.id_already_failed) {
			throw new TransferIdRetiredError(submitted.id);
		}
		if (status === CreateTransferStatus.exists) await this.assertReplayMatches(submitted);
	}

	async createPendingTransfer(p: {
		debitAccountId: bigint;
		creditAccountId: bigint;
		amount: number;
		code: number;
		timeoutSeconds?: number;
		userData128?: bigint;
		userData64?: bigint;
		userData32?: number;
		/** Caller-supplied id for cross-restart idempotency; minted fresh when omitted. */
		transferId?: bigint;
	}): Promise<bigint> {
		this.assertOpen();
		// Decided ONCE, synchronously, before any await: re-reading `p.transferId` after the
		// await would let a caller that mutates its options mid-call skip verification.
		const callerSupplied = p.transferId !== undefined;
		const transferId = transferIdOrFresh(p.transferId);
		const transfer: Transfer = {
			id: transferId,
			debit_account_id: p.debitAccountId,
			credit_account_id: p.creditAccountId,
			amount: BigInt(p.amount),
			pending_id: 0n,
			user_data_128: p.userData128 ?? 0n,
			user_data_64: p.userData64 ?? 0n,
			user_data_32: p.userData32 ?? 0,
			timeout: p.timeoutSeconds ?? 300,
			ledger: LEDGER_USERTOKENS,
			code: p.code,
			flags: TransferFlags.pending,
			timestamp: 0n,
		};

		const results = await this.withReconnect((native) => native.createTransfers([transfer]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// A caller-supplied id: `exists` must be VERIFIED, and a retired id is its own error.
			if (callerSupplied) {
				await this.settleCallerSuppliedStatus(res.status, transfer);
				// Verified, and still a REPLAY: a pending record cannot say whether the hold is
				// live, spent, released or expired, so it is never reported as reserved.
				if (res.status === CreateTransferStatus.exists) {
					throw new PendingReplayError(transferId);
				}
			}
			// `exists` IS SUCCESS HERE. transferId is fixed above, OUTSIDE the
			// withReconnect closure (minted, or supplied by a caller replaying a durable
			// intent), so a retry or replay resubmits the same id; TigerBeetle
			// deduplicates on it and answers `exists` only when every field of the
			// submitted transfer matches the one already
			// committed (a mismatch is a distinct exists_with_different_* code that
			// still throws). Receiving it is therefore proof the reservation landed.
			// Throwing would report a failed reservation against funds TB is already
			// holding pending — nobody would ever post or void them, and the hold would
			// sit on the wallet until its timeout expires.
			if (
				res.status !== CreateTransferStatus.created &&
				res.status !== CreateTransferStatus.exists
			) {
				throw new TBTransferError(
					res.status,
					`Pending transfer failed: ${CreateTransferStatus[res.status] ?? res.status}`,
				);
			}
		}
		return transferId;
	}

	async postTransfer(
		pendingId: bigint,
		amount?: number,
		opts?: { transferId?: bigint },
	): Promise<bigint> {
		this.assertOpen();
		const callerSupplied = opts?.transferId !== undefined; // decided before any await
		const postId = transferIdOrFresh(opts?.transferId);
		const transfer: Transfer = {
			id: postId,
			debit_account_id: 0n,
			credit_account_id: 0n,
			amount: amount != null ? BigInt(amount) : amount_max,
			pending_id: pendingId,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			timeout: 0,
			ledger: 0,
			code: 0,
			flags: TransferFlags.post_pending_transfer,
			timestamp: 0n,
		};

		const results = await this.withReconnect((native) => native.createTransfers([transfer]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// A caller-supplied id: `exists` must be VERIFIED, and a retired id is its own error.
			if (callerSupplied) await this.settleCallerSuppliedStatus(res.status, transfer);
			// `exists` IS SUCCESS HERE. postId is fixed above, OUTSIDE the
			// withReconnect closure (minted, or supplied by a caller replaying a durable
			// intent), so a retry or replay resubmits the same id; TigerBeetle
			// deduplicates on it and answers `exists` only when every field of the
			// submitted transfer matches the one already
			// committed (a mismatch is a distinct exists_with_different_* code that
			// still throws). Receiving it is therefore proof the debit settled.
			// Throwing would report a failed settlement for money that moved — and the
			// governor, seeing failure, would void a pending transfer that is already
			// posted, leaving the ledger holding a debit its accounting does not.
			if (
				res.status !== CreateTransferStatus.created &&
				res.status !== CreateTransferStatus.exists
			) {
				throw new TBTransferError(
					res.status,
					`Post transfer failed: ${CreateTransferStatus[res.status] ?? res.status}`,
				);
			}
		}
		return postId;
	}

	async voidTransfer(pendingId: bigint, opts?: { transferId?: bigint }): Promise<bigint> {
		this.assertOpen();
		const callerSupplied = opts?.transferId !== undefined; // decided before any await
		const voidId = transferIdOrFresh(opts?.transferId);
		const transfer: Transfer = {
			id: voidId,
			debit_account_id: 0n,
			credit_account_id: 0n,
			amount: 0n,
			pending_id: pendingId,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			timeout: 0,
			ledger: 0,
			code: 0,
			flags: TransferFlags.void_pending_transfer,
			timestamp: 0n,
		};

		const results = await this.withReconnect((native) => native.createTransfers([transfer]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// A caller-supplied id: `exists` must be VERIFIED, and a retired id is its own error.
			if (callerSupplied) await this.settleCallerSuppliedStatus(res.status, transfer);
			// `exists` IS SUCCESS HERE. voidId is fixed above, OUTSIDE the
			// withReconnect closure (minted, or supplied by a caller replaying a durable
			// intent), so a retry or replay resubmits the same id; TigerBeetle
			// deduplicates on it and answers `exists` only when every field of the
			// submitted transfer matches the one already
			// committed (a mismatch is a distinct exists_with_different_* code that
			// still throws). Receiving it is therefore proof the hold was released.
			// Throwing would fail the caller's cleanup path over a reservation TB has
			// already returned, and a retry could only ever fail again.
			if (
				res.status !== CreateTransferStatus.created &&
				res.status !== CreateTransferStatus.exists
			) {
				// A TBTransferError like every other transfer path, so a caller can tell an
				// already-expired hold (pending_transfer_expired) from a real failure by code.
				throw new TBTransferError(
					res.status,
					`Void transfer failed: ${CreateTransferStatus[res.status] ?? res.status}`,
				);
			}
		}
		return voidId;
	}

	async immediateTransfer(p: {
		debitAccountId: bigint;
		creditAccountId: bigint;
		amount: number;
		code: number;
		transferId?: bigint;
		userData128?: bigint;
		userData64?: bigint;
		userData32?: number;
		/** The ledger both accounts are on: LEDGER_USERTOKENS when omitted. */
		ledger?: number;
	}): Promise<bigint> {
		this.assertOpen();
		// Decided ONCE, synchronously, before any await (as on the other transfer paths).
		const callerSupplied = p.transferId !== undefined;
		// The same range check as the sibling transfer paths (#183): 0, 2^128 - 1 and anything
		// outside (0, 2^128 - 1) throw RangeError before any client call.
		const transferId = transferIdOrFresh(p.transferId);
		const transfer: Transfer = {
			id: transferId,
			debit_account_id: p.debitAccountId,
			credit_account_id: p.creditAccountId,
			amount: BigInt(p.amount),
			pending_id: 0n,
			user_data_128: p.userData128 ?? 0n,
			user_data_64: p.userData64 ?? 0n,
			user_data_32: p.userData32 ?? 0,
			timeout: 0,
			ledger: p.ledger ?? LEDGER_USERTOKENS,
			code: p.code,
			flags: 0,
			timestamp: 0n,
		};

		const results = await this.withReconnect((native) => native.createTransfers([transfer]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// A caller-supplied id: `exists` is VERIFIED against the stored transfer, and a
			// retired id (`id_already_failed`) is TransferIdRetiredError — the same contract as
			// createPendingTransfer, postTransfer and voidTransfer (#178).
			if (callerSupplied) await this.settleCallerSuppliedStatus(res.status, transfer);
			// `exists` IS SUCCESS HERE. The transfer id is generated above, OUTSIDE the
			// withReconnect closure, so a retry after a connection error resubmits the
			// same unique id; TigerBeetle deduplicates on it and answers `exists`, which
			// it returns only when every field of the submitted transfer matches the one
			// already committed (a mismatch is a distinct exists_with_different_* code
			// that still throws). Receiving it is therefore proof our transfer landed.
			// Throwing would report failure for money that moved — and a caller retrying
			// that "failure" would double-allocate.
			if (
				res.status !== CreateTransferStatus.created &&
				res.status !== CreateTransferStatus.exists
			) {
				throw new TBTransferError(
					res.status,
					`Transfer failed: ${CreateTransferStatus[res.status] ?? res.status}`,
				);
			}
		}
		return transferId;
	}

	/**
	 * Hold `amount` on a payer and on a task's limit at once: two pending transfers in ONE request,
	 * the payer leg first and linked, so TigerBeetle creates both or neither. The payer leg is the
	 * ordinary hold (ledger 1, its own code and user data); the limit leg debits the task's account
	 * on LEDGER_TASK_LIMITS with XFER_TASK_LIMIT_HOLD and the same amount and timeout. Equal timeouts
	 * and the later timestamp of the second leg mean the limit leg never expires before the payer's.
	 *
	 * Which leg refused decides the error: the payer leg's refusal is a plain TBTransferError with
	 * its code, as for a hold made outside a task, so every existing catch reads it unchanged; the
	 * limit leg's is a TaskLimitLegError. See `submitPair` for the replay rule.
	 *
	 * `timeoutSeconds` must be a whole number of seconds from 1 to the u32 maximum: a pair with no
	 * timeout would never expire, and a process that stopped before settling it would hold the
	 * task's capacity until someone voided it by hand.
	 *
	 * @throws RangeError for a timeout outside that range, or an amount BigInt refuses, before any
	 * request.
	 */
	async createLinkedPendingPair(p: {
		amount: number;
		timeoutSeconds: number;
		payer: {
			debitAccountId: bigint;
			creditAccountId: bigint;
			code: number;
			userData128?: bigint;
			userData64?: bigint;
			userData32?: number;
		};
		limit: { debitAccountId: bigint; creditAccountId: bigint; userData128: bigint };
	}): Promise<{ payerId: bigint; limitId: bigint }> {
		this.assertOpen();
		const timeout = p.timeoutSeconds;
		if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
			throw new RangeError(
				`A linked pair's timeout must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}: ${timeout}`,
			);
		}
		const amount = BigInt(p.amount);
		// Minted here, OUTSIDE withReconnect: a retry resubmits these same two ids, which is what
		// makes a lost reply a replay rather than a second hold.
		const payerId = tbId();
		const limitId = tbId();
		const batch: [Transfer, Transfer] = [
			{
				id: payerId,
				debit_account_id: p.payer.debitAccountId,
				credit_account_id: p.payer.creditAccountId,
				amount,
				pending_id: 0n,
				user_data_128: p.payer.userData128 ?? 0n,
				user_data_64: p.payer.userData64 ?? 0n,
				user_data_32: p.payer.userData32 ?? 0,
				timeout,
				ledger: LEDGER_USERTOKENS,
				code: p.payer.code,
				flags: TransferFlags.pending | TransferFlags.linked,
				timestamp: 0n,
			},
			{
				id: limitId,
				debit_account_id: p.limit.debitAccountId,
				credit_account_id: p.limit.creditAccountId,
				amount,
				pending_id: 0n,
				user_data_128: p.limit.userData128,
				user_data_64: 0n,
				user_data_32: 0,
				timeout,
				ledger: LEDGER_TASK_LIMITS,
				code: XFER_TASK_LIMIT_HOLD,
				flags: TransferFlags.pending,
				timestamp: 0n,
			},
		];
		await this.submitPair(batch, "Pending transfer", false);
		return { payerId, limitId };
	}

	/**
	 * Post both legs of a pair at `amount`, linked: both or neither. `amount` is required and
	 * concrete, never amount_max: a post stores the amount it is sent, so a replay compares it
	 * exactly, where amount_max would be stored as the pending's amount and could only be checked
	 * against the pending record. Every other field is sent as 0, which TigerBeetle fills in from
	 * the pending transfer.
	 */
	async postLinkedPair(payerId: bigint, limitId: bigint, amount: number): Promise<void> {
		this.assertOpen();
		const posted = BigInt(amount);
		await this.submitPair(
			[
				this.resolvingTransfer(payerId, posted, TransferFlags.post_pending_transfer, true),
				this.resolvingTransfer(limitId, posted, TransferFlags.post_pending_transfer, false),
			],
			"Post transfer",
			true,
		);
	}

	/**
	 * Void both legs of a pair, linked. `pending_transfer_expired` is not turned into success here:
	 * it is the payer leg's code on a plain TBTransferError, for the caller to read.
	 */
	async voidLinkedPair(payerId: bigint, limitId: bigint): Promise<void> {
		this.assertOpen();
		await this.submitPair(
			[
				this.resolvingTransfer(payerId, 0n, TransferFlags.void_pending_transfer, true),
				this.resolvingTransfer(limitId, 0n, TransferFlags.void_pending_transfer, false),
			],
			"Void transfer",
			true,
		);
	}

	/** A post or void of `pendingId` under a freshly minted id, inheriting every other field. */
	private resolvingTransfer(
		pendingId: bigint,
		amount: bigint,
		flag: number,
		linked: boolean,
	): Transfer {
		return {
			id: tbId(),
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
			flags: linked ? flag | TransferFlags.linked : flag,
			timestamp: 0n,
		};
	}

	/**
	 * Submit a linked pair and read its two answers. TigerBeetle 0.17.9 answers one result per
	 * event, so anything but exactly two is a hard failure: reading an empty answer as "both
	 * created" would report a hold the ledger may never have made.
	 *  - `created`, `created`: success.
	 *  - a payer-leg failure, then `linked_event_failed`: a plain TBTransferError with the payer's
	 *    code (an `exists_with_different_*` on the payer leg included: a hard conflict).
	 *  - `linked_event_failed`, then a limit-leg failure: TaskLimitLegError with the limit's code.
	 *  - `exists`, then `linked_event_failed`: possibly a replay. An `exists` breaks a linked chain
	 *    like any other status but `created` (tigerbeetle 0.17.9 `execute_create`), so a pair resent
	 *    after its reply was lost answers this, and its second leg is never evaluated. One lookup
	 *    of the two ids this call minted settles it (`verifyReplayedPair`).
	 *  - anything else, `[exists, exists]` included, cannot come from one linked chain: a hard
	 *    failure, fail closed.
	 * The batch is fixed before withReconnect, so a reconnect's retry resubmits these same ids.
	 */
	private async submitPair(
		batch: [Transfer, Transfer],
		what: string,
		resolvesPending: boolean,
	): Promise<void> {
		const results = await this.withReconnect((native) => native.createTransfers(batch));
		if (results.length !== 2) {
			throw new Error(`Linked pair answered ${results.length} results for 2 transfers`);
		}
		const payer = results[0]?.status;
		const limit = results[1]?.status;
		if (payer === undefined || limit === undefined) {
			throw new Error("Unknown account/transfer error");
		}
		const S = CreateTransferStatus;
		const name = (status: number) => CreateTransferStatus[status] ?? String(status);
		const fails = (status: number) =>
			status !== S.created && status !== S.exists && status !== S.linked_event_failed;
		if (payer === S.created && limit === S.created) return;
		if (payer === S.exists && limit === S.linked_event_failed) {
			await this.verifyReplayedPair(batch, resolvesPending);
			return;
		}
		if (limit === S.linked_event_failed && fails(payer)) {
			throw new TBTransferError(payer, `${what} failed: ${name(payer)}`);
		}
		if (payer === S.linked_event_failed && fails(limit)) {
			throw new TaskLimitLegError(limit, `${what} failed on the task-limit leg: ${name(limit)}`);
		}
		const first = payer !== S.created ? payer : limit;
		throw new TBTransferError(
			first,
			`Linked pair answered inconsistently: ${name(payer)}, ${name(limit)}`,
		);
	}

	/**
	 * A pair answered `[exists, linked_event_failed]`: look up the two transfers this call minted
	 * and sent, in ONE request, and match the results by id (a lookup returns only what it finds,
	 * not one answer per id). Success only if both are stored and each matches what was sent:
	 * exactly for a create, by TigerBeetle's own exists rule for a post or void
	 * ({@link postOrVoidMismatch}). A pending pair's ids are looked up for a create; a post's or
	 * void's own ids for those, never the pending ids, which are always stored and so show
	 * nothing. Anything else throws TransferReplayMismatchError and is reported as an integrity
	 * warning.
	 */
	private async verifyReplayedPair(
		batch: [Transfer, Transfer],
		resolvesPending: boolean,
	): Promise<void> {
		const ids = batch.map((t) => t.id);
		const found = await this.withReconnect((native) => native.lookupTransfers(ids));
		const byId = new Map<bigint, Transfer>();
		for (const t of found as Transfer[]) byId.set(t.id, t);
		for (const sent of batch) {
			const stored = byId.get(sent.id);
			const field =
				stored === undefined
					? NO_RECORD
					: resolvesPending
						? postOrVoidMismatch(sent, stored)
						: createMismatch(sent, stored);
			if (field !== null) {
				reportPairMismatch(sent.id, field);
				throw new TransferReplayMismatchError(sent.id, field);
			}
		}
	}

	async lookupTransfer(transferId: bigint): Promise<Transfer | null> {
		this.assertOpen();
		const transfers = await this.withReconnect((native) => native.lookupTransfers([transferId]));
		return transfers.length > 0 ? (transfers[0] as Transfer) : null;
	}

	async lookupAccounts(accountIds: bigint[]): Promise<Account[]> {
		this.assertOpen();
		return await this.withReconnect((native) => native.lookupAccounts(accountIds));
	}

	async lookupBalance(accountId: bigint): Promise<{
		available: number;
		pending: number;
		total: number;
	}> {
		this.assertOpen();
		const accounts = await this.withReconnect((native) => native.lookupAccounts([accountId]));
		if (accounts.length === 0) throw new Error(`Account not found: ${accountId}`);
		return accountBalance(accounts[0] as Account);
	}

	/**
	 * Batched {@link TrustTBClient.lookupBalance}: one `lookupAccounts` round trip for
	 * every account in `accountIds`, sharing the exact same per-account computation (and
	 * its overflow guards) via {@link accountBalance} — never a hand-rolled second copy.
	 *
	 * Two deliberate differences from the single-account method, both required by its
	 * callers (budget/context.ts's envelope reads): a missing account is ABSENT from the
	 * returned map rather than throwing — "never allocated" and "fully reclaimed" are the
	 * same observable state with no registry, so the caller's implicit-zero reading is
	 * `balances.get(id) ?? 0`, never a per-account try/catch; and only the `available`
	 * figure is returned, since that is all any caller of the batch path needs.
	 *
	 * Results are matched to requests by `Account.id`, never by array position — TB is not
	 * documented to preserve request order, and index-matching would silently mispair
	 * balances the moment it didn't.
	 *
	 * Duplicate input ids are deduped before the round trip: TigerBeetle is queried once
	 * per unique id, which is also what keeps this to exactly ONE `lookupAccounts` call
	 * regardless of how many times a caller repeats an id. Empty input short-circuits
	 * before any I/O — there is nothing to look up and no reason to open a round trip.
	 */
	async lookupBalances(accountIds: bigint[]): Promise<Map<bigint, number>> {
		this.assertOpen();
		if (accountIds.length === 0) return new Map();
		const uniqueIds = [...new Set(accountIds)];
		const accounts = await this.withReconnect((native) => native.lookupAccounts(uniqueIds));
		const balances = new Map<bigint, number>();
		for (const acct of accounts as Account[]) {
			balances.set(acct.id, accountBalance(acct).available);
		}
		return balances;
	}

	async ping(): Promise<boolean> {
		// A destroyed client is not healthy, its start-up grace period included.
		if (this.closed) return false;
		try {
			if (!this.initialized || !this.treasuryId) {
				return Date.now() - this.startedAt < this.initGraceMs;
			}
			const tid = this.treasuryId;
			const accounts = await this.withReconnect((native) => native.lookupAccounts([tid]));
			return accounts.length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Fail within `timeoutMs` when nothing usable answers. tigerbeetle-node retries a connection forever and has no
	 * request timeout, so without this a governor pointed at a port where something else listens (or a cluster
	 * with another id) waits indefinitely. This makes ONE request first, `lookupAccounts([1n])`, on the current
	 * native client, through `send` and with no reconnect, and races it against the deadline:
	 *  - answered: resolves, and the client is usable;
	 *  - not answered in time: takes the `close()` path (the client is destroyed, and the process can exit) and
	 *    throws "something is listening but no usertrust ledger answered";
	 *  - the cluster evicts the client (a release mismatch): `send` marks it, `close()` leaves it open, and the
	 *    error says the process must exit on its own, because an evicted native client cannot be released;
	 *  - any other failure is rethrown as it came.
	 */
	async connectDeadline(timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
		const current = this.native();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const bound = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		const probe = this.send((native) => native.lookupAccounts([1n]), current).then(
			() => "answered" as const,
			(err: unknown) => ({ err }),
		);
		const outcome = await Promise.race([probe, bound]);
		clearTimeout(timer);
		if (outcome === "answered") return;
		const where = this.opts.addresses.join(",");
		if (outcome === "timeout") {
			await this.close();
			const seconds = timeoutMs / 1000;
			throw new LedgerUnavailableError(
				`something is listening at ${where} but no usertrust ledger answered in ${seconds} s: run npx usertrust tb status`,
				where,
				{ hint: "Run `npx usertrust tb status`, or pass { dryRun: true } to skip the ledger." },
			);
		}
		const { err } = outcome;
		if (isEviction(err) || isClosedByClient(err)) {
			await this.close();
			throw new LedgerUnavailableError(
				`the ledger at ${where} evicted this client (${(err as { code?: string }).code ?? "closed"}), usually a tigerbeetle-node release the cluster does not accept. The evicted client cannot be released, so this process will not exit on its own: end it with process.exit()`,
				where,
				{ hint: "Run a TigerBeetle server of the same release as the bundled client (0.17.9)." },
			);
		}
		await this.close();
		throw err;
	}

	/**
	 * @internal Not part of the public API: the governors' teardown (the ledger engine's
	 * `close()`) and `usertrust budget` are its only supported callers, and it may change in
	 * any release. Code outside this package calls `destroy()`.
	 *
	 * `destroy()`, after asking the native client whether it was evicted. A client whose
	 * session the cluster pushed out while it was idle learns of that from its own traffic,
	 * with no request failing, and `destroy()` on it aborts the process (tigerbeetle-node
	 * 0.17.9). This makes ONE request first, an empty `lookupAccounts`, on the current native
	 * client, through `send` and with no reconnect:
	 *  - it fails CLOSED at once if the client has learned of its eviction, or with an eviction
	 *    code if the cluster tells it now: either way `send` marks it, and `destroy()` leaves it;
	 *  - it is answered by a client still registered: `destroy()` destroys it;
	 *  - it is not answered within `timeoutMs` (the cluster is unreachable or slow): `destroy()`
	 *    destroys it. A client that has heard nothing back has learned of no eviction, since one
	 *    that has fails at once, and leaving it open would keep the process from exiting.
	 * What is left: an eviction the native client learns of between the probe's answer and its
	 * destroy, which follows with no await between them.
	 * A client already closed, or already known to be evicted, is not asked.
	 *
	 * Resolves `true` when an evicted native client was left open, now or earlier (a reconnect
	 * dropped one): it cannot be released, and keeps the process from exiting on its own, so a
	 * caller that ends when its work is done must end the process itself.
	 */
	async close(timeoutMs = CLOSE_PROBE_TIMEOUT_MS): Promise<boolean> {
		if (this.closed) return this.droppedEvicted > 0;
		const current = this.native();
		if (!this.evicted.has(current)) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const bound = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			});
			const probe = this.send((native) => native.lookupAccounts([]), current).then(
				() => {},
				() => {},
			);
			await Promise.race([probe, bound]);
			clearTimeout(timer);
		}
		this.destroy();
		return this.droppedEvicted > 0;
	}

	destroy(): void {
		// First, so this client is closed even if the native destroy below throws: it is native
		// and unguarded, and a throw there leaves the native client open. The rejections it
		// causes for requests in flight reach withReconnect() only later, as promise reactions.
		this.closed = true;
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
		// An evicted native client is left as it is: destroy() on one aborts the process. One this
		// wrapper does not know is evicted is destroyed, and aborts if it learned of an eviction
		// that no request has seen since: close() asks it first.
		if (!this.evicted.has(this.client)) {
			this.released.add(this.client);
			this.client.destroy();
		}
		// Only once that returned. A native destroy that throws leaves its client here, refused
		// by native(), for a second destroy() to retry. Past this line nothing in this object
		// holds the native client.
		this.client = CLOSED_CLIENT;
		// Said once, and only now: the client is already closed, so an onAlert that calls
		// destroy() again finds nothing left to do and returns.
		if (this.droppedEvicted > 0 && !this.evictionAlerted) {
			this.evictionAlerted = true;
			const msg = `TigerBeetle evicted this client's session; ${this.droppedEvicted} evicted native client(s) could not be released (tigerbeetle-node aborts the process on destroying one), so this process will not exit on its own: end it with process.exit()`;
			const meta = { droppedEvicted: this.droppedEvicted };
			if (this.onAlert) this.onAlert(msg, meta);
			else console.warn(`[usertrust] ${msg}`, meta);
		}
	}
}
