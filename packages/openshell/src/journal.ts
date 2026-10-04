// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The hold journal: one SQLite file per middleware host, the compare-and-set
 * store that gives every hold EXACTLY ONE terminal.
 *
 * - **The CAS.** Every transition is `UPDATE hold SET state = :to … WHERE hold_id
 *   = :id AND state = :from`, and the caller wins only when the statement changed
 *   exactly one row. Statement success is never the signal (a zero-row UPDATE
 *   succeeds too).
 * - **BUSY is never a lost CAS.** A write transaction opens with `BEGIN
 *   IMMEDIATE` under `busy_timeout`; a lock still busy after the retries THROWS
 *   {@link JournalBusyError}, and callers fail closed. Only a completed UPDATE that
 *   changed 0 rows is a loss.
 * - **One writer at a time, across processes AND inside one.** SQLite serializes
 *   writers across processes; node:sqlite is synchronous, so a transaction held
 *   open across an `await` (a ledger call) would let a second in-process request
 *   run its statements INSIDE it. Every write transaction therefore also takes
 *   an in-process lock.
 *
 * Built on `node:sqlite` (Node ≥ 22.13, no dependency; still marked experimental
 * by Node).
 */

import { DatabaseSync } from "node:sqlite";

export type HoldState =
	| "open"
	| "settling"
	| "settled"
	| "voiding"
	| "voided"
	| "expiring"
	| "expired";

export const TERMINAL_STATES: ReadonlySet<HoldState> = new Set(["settled", "voided", "expired"]);

/** Every legal transition. Anything else is a programming error, thrown. */
const TRANSITIONS: ReadonlyArray<readonly [HoldState, HoldState]> = [
	["open", "settling"],
	["open", "voiding"],
	["open", "expiring"],
	["settling", "settled"],
	// The ledger confirmed the pending transfer expired before the post landed.
	["settling", "expired"],
	["voiding", "voided"],
	["expiring", "expired"],
];

export class JournalBusyError extends Error {
	constructor(public readonly attempts: number) {
		super(`hold journal: write lock still busy after ${attempts} attempts`);
		this.name = "JournalBusyError";
	}
}

export interface HoldRow {
	holdId: string;
	budgetId: string;
	state: HoldState;
	amount: number;
	/** Epoch ms after which the sweeper may expire an `open` hold. */
	ttlAt: number;
	/** The settlement (or late-settlement) intent, written WITH the claim. */
	intent: unknown;
	terminalKind: string | null;
	terminalEventHash: string | null;
	reservedSeq: number | null;
}

export interface JournalOptions {
	/** SQLite `busy_timeout` per attempt. */
	busyTimeoutMs?: number;
	/** Extra `BEGIN IMMEDIATE` attempts after the first is busy. */
	busyRetries?: number;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function isBusy(err: unknown): boolean {
	const code = (err as { errcode?: unknown })?.errcode;
	return (
		typeof code === "number" && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED)
	);
}

interface RawRow {
	hold_id: string;
	budget_id: string;
	state: HoldState;
	amount: number;
	ttl_at: number;
	intent_json: string | null;
	terminal_kind: string | null;
	terminal_event_hash: string | null;
	reserved_seq: number | null;
}

function toRow(r: RawRow): HoldRow {
	return {
		holdId: r.hold_id,
		budgetId: r.budget_id,
		state: r.state,
		amount: r.amount,
		ttlAt: r.ttl_at,
		intent: r.intent_json === null ? null : JSON.parse(r.intent_json),
		terminalKind: r.terminal_kind,
		terminalEventHash: r.terminal_event_hash,
		reservedSeq: r.reserved_seq,
	};
}

export type SettlementClaim =
	| { won: true }
	| { won: false; state: HoldState | "missing"; intent: unknown };

export type Reservation =
	| { admitted: true; existing: boolean }
	| { admitted: false; reason: "budget_exceeded" | "not_open"; existing: boolean };

export interface ReserveInput {
	holdId: string;
	budgetId: string;
	amount: number;
	ttlAt: number;
	/** Usertokens the budget can still reserve (the ledger's available credit). */
	availableCredit: () => Promise<number> | number;
	/** Place the pending transfer. Throwing rolls the whole reservation back. */
	placeHold: () => Promise<void> | void;
}

export class HoldJournal {
	private tail: Promise<unknown> = Promise.resolve();
	private inTx = false;
	private readonly retries: number;

	private constructor(
		private readonly db: DatabaseSync,
		opts: JournalOptions,
	) {
		this.retries = opts.busyRetries ?? 2;
		db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 100))}`);
	}

	static open(path: string, opts: JournalOptions = {}): HoldJournal {
		const db = new DatabaseSync(path);
		db.exec("PRAGMA journal_mode = WAL");
		const j = new HoldJournal(db, opts);
		j.migrate();
		return j;
	}

	close(): void {
		this.db.close();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS hold (
				hold_id TEXT PRIMARY KEY,
				budget_id TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN
					('open','settling','settled','voiding','voided','expiring','expired')),
				amount INTEGER NOT NULL CHECK (amount > 0),
				ttl_at INTEGER NOT NULL,
				intent_json TEXT,
				terminal_kind TEXT,
				terminal_event_hash TEXT,
				reserved_seq INTEGER
			);
			CREATE INDEX IF NOT EXISTS hold_state_ttl ON hold (state, ttl_at);
			CREATE TABLE IF NOT EXISTS debt (
				budget_id TEXT PRIMARY KEY,
				amount INTEGER NOT NULL CHECK (amount >= 0)
			);
			CREATE TABLE IF NOT EXISTS applied (
				transfer_id TEXT PRIMARY KEY,
				budget_id TEXT NOT NULL,
				delta INTEGER NOT NULL
			);
		`);
	}

	/**
	 * One write transaction: the in-process lock, then `BEGIN IMMEDIATE` (retried
	 * while busy, then {@link JournalBusyError}), then `fn`, then COMMIT. Anything
	 * `fn` throws rolls the transaction back and rethrows.
	 */
	writeTx<T>(fn: () => Promise<T> | T): Promise<T> {
		const run = async (): Promise<T> => {
			this.begin();
			this.inTx = true;
			try {
				const out = await fn();
				this.db.exec("COMMIT");
				return out;
			} catch (err) {
				this.db.exec("ROLLBACK");
				throw err;
			} finally {
				this.inTx = false;
			}
		};
		const next = this.tail.then(run, run);
		this.tail = next.catch(() => undefined);
		return next;
	}

	private begin(): void {
		for (let attempt = 1; ; attempt++) {
			try {
				this.db.exec("BEGIN IMMEDIATE");
				return;
			} catch (err) {
				if (!isBusy(err)) throw err;
				if (attempt > this.retries) throw new JournalBusyError(attempt);
			}
		}
	}

	private requireTx(op: string): void {
		if (!this.inTx) throw new Error(`hold journal: ${op} must run inside writeTx`);
	}

	/**
	 * THE compare-and-set. Must run inside {@link writeTx}. Returns true only when
	 * exactly one row moved `from → to`.
	 */
	cas(
		holdId: string,
		from: HoldState,
		to: HoldState,
		set: { intent?: unknown; terminalKind?: string } = {},
	): boolean {
		this.requireTx("cas");
		if (!TRANSITIONS.some(([f, t]) => f === from && t === to)) {
			throw new Error(`hold journal: illegal transition ${from} → ${to}`);
		}
		const result = this.db
			.prepare(
				`UPDATE hold SET state = ?,
					intent_json = COALESCE(?, intent_json),
					terminal_kind = COALESCE(?, terminal_kind)
				 WHERE hold_id = ? AND state = ?`,
			)
			.run(
				to,
				set.intent === undefined ? null : JSON.stringify(set.intent),
				set.terminalKind ?? null,
				holdId,
				from,
			);
		return Number(result.changes) === 1;
	}

	get(holdId: string): HoldRow | undefined {
		const r = this.db.prepare("SELECT * FROM hold WHERE hold_id = ?").get(holdId) as
			| RawRow
			| undefined;
		return r === undefined ? undefined : toRow(r);
	}

	debtOf(budgetId: string): number {
		const r = this.db.prepare("SELECT amount FROM debt WHERE budget_id = ?").get(budgetId) as
			| { amount: number }
			| undefined;
		return r?.amount ?? 0;
	}

	/**
	 * Reserve, atomically with the debt it is checked against: inside ONE write
	 * transaction, read the debt, check `available − debt ≥ amount`, place the
	 * pending transfer, insert the `open` row, commit. A retried evaluation of the
	 * same hold places nothing and answers from the existing row.
	 */
	reserve(input: ReserveInput): Promise<Reservation> {
		return this.writeTx(async () => {
			const existing = this.get(input.holdId);
			if (existing !== undefined) {
				return existing.state === "open"
					? { admitted: true, existing: true }
					: { admitted: false, reason: "not_open", existing: true };
			}
			const debt = this.debtOf(input.budgetId);
			const available = await input.availableCredit();
			if (available - debt < input.amount) {
				return { admitted: false, reason: "budget_exceeded", existing: false };
			}
			await input.placeHold();
			this.db
				.prepare(
					"INSERT INTO hold (hold_id, budget_id, state, amount, ttl_at) VALUES (?, ?, 'open', ?, ?)",
				)
				.run(input.holdId, input.budgetId, input.amount, input.ttlAt);
			return { admitted: true, existing: false };
		});
	}

	/**
	 * Claim a settlement: the CAS `open → settling`, WRITING the intent in the same
	 * transaction. A loser re-reads the row in that transaction and reports its
	 * state, so the caller acts BY STATE, never by default.
	 */
	claimSettlement(holdId: string, intent: unknown): Promise<SettlementClaim> {
		return this.writeTx(() => {
			if (this.cas(holdId, "open", "settling", { intent })) return { won: true } as const;
			const row = this.get(holdId);
			return { won: false, state: row?.state ?? "missing", intent: row?.intent ?? null } as const;
		});
	}

	/**
	 * Apply a debt change exactly once per ledger transfer: the applied marker
	 * (keyed by the deterministic transfer id) and the debt update commit together.
	 * Must run inside {@link writeTx}. Returns false when this transfer was already
	 * applied.
	 */
	applyDebt(budgetId: string, transferId: string, delta: number): boolean {
		this.requireTx("applyDebt");
		const marker = this.db
			.prepare("INSERT OR IGNORE INTO applied (transfer_id, budget_id, delta) VALUES (?, ?, ?)")
			.run(transferId, budgetId, delta);
		if (Number(marker.changes) !== 1) return false;
		this.db
			.prepare(
				"INSERT INTO debt (budget_id, amount) VALUES (?, ?) ON CONFLICT (budget_id) DO UPDATE SET amount = amount + excluded.amount",
			)
			.run(budgetId, delta);
		return true;
	}

	/** `open` holds whose TTL (plus grace) has passed: the sweeper's work list. */
	openPast(nowMs: number): HoldRow[] {
		return (
			this.db
				.prepare("SELECT * FROM hold WHERE state = 'open' AND ttl_at < ? ORDER BY ttl_at")
				.all(nowMs) as unknown as RawRow[]
		).map(toRow);
	}

	/** Rows in a non-terminal, non-open state: a claim whose winner may have crashed. */
	inFlight(): HoldRow[] {
		return (
			this.db
				.prepare("SELECT * FROM hold WHERE state IN ('settling','voiding','expiring')")
				.all() as unknown as RawRow[]
		).map(toRow);
	}

	/** Terminal rows whose terminal event was never recorded. */
	terminalWithoutEvent(): HoldRow[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM hold WHERE state IN ('settled','voided','expired') AND terminal_event_hash IS NULL",
				)
				.all() as unknown as RawRow[]
		).map(toRow);
	}

	/** Record the terminal event's hash, once. Must run inside {@link writeTx}. */
	recordTerminalEvent(holdId: string, hash: string): boolean {
		this.requireTx("recordTerminalEvent");
		const r = this.db
			.prepare(
				"UPDATE hold SET terminal_event_hash = ? WHERE hold_id = ? AND terminal_event_hash IS NULL AND state IN ('settled','voided','expired')",
			)
			.run(hash, holdId);
		return Number(r.changes) === 1;
	}
}
