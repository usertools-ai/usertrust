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
 *   an in-process lock, and every in-transaction operation (`cas`, `applyDebt`,
 *   `recordTerminalEvent`) checks a per-transaction token carried by
 *   AsyncLocalStorage — a call from ANOTHER request while a transaction awaits is
 *   refused, never run inside it.
 * - **Claims COMMIT before any ledger call.** {@link HoldJournal.writeTx} takes a
 *   SYNCHRONOUS body: a body that returns a promise is rolled back and refused.
 *   Only {@link HoldJournal.reserve} holds a transaction across a ledger call (its
 *   debt check must be atomic with the placement), and every such call runs under
 *   a deadline, so a hung ledger cannot wedge the lock.
 * - **Reads outside a transaction see only COMMITTED rows**: they use a separate
 *   read-only connection, never the writer, whose open transaction would show its
 *   uncommitted changes.
 *
 * Built on `node:sqlite` (Node ≥ 22.13, no dependency; still marked experimental
 * by Node). It is loaded when a journal is OPENED, not at import, so a runtime
 * without it gets {@link JournalUnavailableError} naming the requirement instead of
 * an opaque module-resolution failure at load time.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

/** The Node version the journal needs (`engines.node` in package.json says the same). */
export const MIN_NODE_FOR_JOURNAL = "22.13.0";

export class JournalUnavailableError extends Error {
	constructor(cause: unknown) {
		super(
			`the hold journal needs node:sqlite (Node >= ${MIN_NODE_FOR_JOURNAL}); this runtime is Node ${process.versions.node} and could not load it`,
			{ cause },
		);
		this.name = "JournalUnavailableError";
	}
}

type SqliteModule = { DatabaseSync: typeof DatabaseSync };
type ModuleLoader = (id: string) => unknown;
const nodeRequire: ModuleLoader = createRequire(import.meta.url);

/** Loads node:sqlite, or throws {@link JournalUnavailableError}. `load` is a test seam. */
export function loadSqlite(load: ModuleLoader = nodeRequire): SqliteModule {
	try {
		const mod = load("node:sqlite") as Partial<SqliteModule> | undefined;
		if (typeof mod?.DatabaseSync !== "function")
			throw new TypeError("node:sqlite has no DatabaseSync");
		return mod as SqliteModule;
	} catch (err) {
		throw new JournalUnavailableError(err);
	}
}

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
	// A late settlement that POSTED the still-pending hold after the sweeper's claim: it
	// and the sweeper's `expiring → expired` race on the same CAS — exactly one wins.
	["expiring", "settled"],
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
	/**
	 * Epoch ms: the LATEST the ledger's own timeout can release the hold (an upper bound).
	 * The sweeper expires an `open` hold past it, and the placement horizon counts from it.
	 */
	ttlAt: number;
	/**
	 * Epoch ms: the EARLIEST the ledger's own timeout can release the hold (a lower bound).
	 * Nothing is admitted at or past it: neither a retry of an `open` row nor a placement.
	 */
	admitBy: number;
	/** The settlement (or late-settlement) intent, written WITH the claim. */
	intent: unknown;
	terminalKind: string | null;
	terminalEventHash: string | null;
	/**
	 * A terminal INCIDENT an operator must act on (e.g. a debt charge the ledger can never
	 * take), recorded once. A row carrying one is not in flight: replay and the sweeper skip it.
	 */
	incident: unknown;
	reservedSeq: number | null;
	/**
	 * The late settlement of an expiring or expired hold, a POSITIVE state recorded once:
	 * `none` (no late settlement yet; amount null), `recorded` (amount > 0: its debt counted, the
	 * ledger charge pending), `charged` (amount > 0, the ledger took it), or `zero` (amount 0: a
	 * zero-cost late settlement, terminal, no transfer). The first recorded disposition wins.
	 */
	lateState: LateState;
	lateAmount: number | null;
}

export interface JournalOptions {
	/** SQLite `busy_timeout` per attempt. */
	busyTimeoutMs?: number;
	/** Extra `BEGIN IMMEDIATE` attempts after the first is busy. */
	busyRetries?: number;
	/**
	 * The deadline for each ledger call {@link HoldJournal.reserve} makes INSIDE its
	 * transaction (default 5,000 ms). A call that does not answer fails the
	 * reservation (rolled back) instead of holding the write lock indefinitely.
	 */
	ledgerTimeoutMs?: number;
	/**
	 * How long after a hold's `ttlAt` an abandoned placement could still land (the
	 * deadline plus the ledger client's own retries). A NOT-FOUND void finalizes a
	 * hold only after `ttlAt + placementGraceMs` (default 10 minutes).
	 *
	 * Note the budgets: another PROCESS waiting for the write lock gives up after
	 * about `busyTimeoutMs × (busyRetries + 1)` (≈ 300 ms by default) and fails closed
	 * with JournalBusyError, while one reservation may hold the lock for up to two
	 * ledger deadlines. Size `busyTimeoutMs`/`busyRetries` for the deadline when several
	 * processes share a journal, or accept that they fail closed under a slow ledger.
	 */
	placementGraceMs?: number;
	/** The clock (epoch ms); a test seam. */
	now?: () => number;
}

export class LedgerDeadlineError extends Error {
	constructor(op: string, ms: number) {
		super(
			op === "placeHold"
				? `hold journal: placeHold did not answer within ${ms} ms — the placement may still land, so the hold is committed as \`voiding\` (never rolled back into an orphan)`
				: `hold journal: ${op} did not answer within ${ms} ms (inside the write lock) — nothing was placed; reservation rolled back`,
		);
		this.name = "LedgerDeadlineError";
	}
}

/** `voiding → voided` on a NOT-FOUND void before the placement horizon: a late create may still land. */
export class PlacementHorizonError extends Error {
	constructor(holdId: string, horizonAt: number) {
		super(
			`hold journal: ${holdId} cannot be finalized as voided-not-found before ${new Date(horizonAt).toISOString()} — an abandoned placement may still land; re-void until the ledger reports it voided or expired`,
		);
		this.name = "PlacementHorizonError";
	}
}

/**
 * The hold journal's schema version (`PRAGMA user_version`). Every version this code can READ
 * has an exact shape in {@link SHAPES}; a file at one of the older ones is MIGRATED to this
 * version at open (one transaction). Every other version is refused.
 */
export const JOURNAL_SCHEMA_VERSION = 3;

/** The hold table's columns as the slice-1b code wrote them (schema version 0). */
const V0_HOLD_COLUMNS: readonly string[] = [
	"hold_id",
	"budget_id",
	"state",
	"amount",
	"ttl_at",
	"admit_by",
	"intent_json",
	"terminal_kind",
	"terminal_event_hash",
	"reserved_seq",
];
const V2_HOLD_COLUMNS: readonly string[] = [...V0_HOLD_COLUMNS, "incident_json"];
const V3_HOLD_COLUMNS: readonly string[] = [...V2_HOLD_COLUMNS, "late_amount", "late_state"];

/** A hold's late-settlement disposition (see {@link HoldRow.lateState}). */
export type LateState = "none" | "recorded" | "charged" | "zero";

/**
 * The legal (late_state, late_amount) pairs, enforced by the DATABASE. ADD COLUMN cannot add a
 * cross-column CHECK, so the v3 schema carries these two triggers; they are part of its exact
 * shape (name AND sql), so no other trigger is ever adopted.
 */
// Written so it is always TRUE or FALSE, never NULL: SQL's three-valued logic makes
// `NULL > 0` NULL, and a trigger whose WHEN is NULL does not fire — so every amount comparison
// is guarded by an explicit IS NOT NULL.
const LATE_LEGAL =
	"(NEW.late_state = 'none' AND NEW.late_amount IS NULL) OR (NEW.late_state IN ('recorded', 'charged') AND NEW.late_amount IS NOT NULL AND NEW.late_amount > 0) OR (NEW.late_state = 'zero' AND NEW.late_amount IS NOT NULL AND NEW.late_amount = 0)";
const V3_TRIGGERS: Readonly<Record<string, string>> = {
	hold_late_legal_insert: `CREATE TRIGGER hold_late_legal_insert BEFORE INSERT ON hold WHEN NOT (${LATE_LEGAL}) BEGIN SELECT RAISE(ABORT, 'hold journal: illegal late settlement state'); END`,
	hold_late_legal_update: `CREATE TRIGGER hold_late_legal_update BEFORE UPDATE OF late_state, late_amount ON hold WHEN NOT (${LATE_LEGAL}) BEGIN SELECT RAISE(ABORT, 'hold journal: illegal late settlement state'); END`,
};
const DEBT_COLUMNS: readonly string[] = ["budget_id", "amount"];
const APPLIED_COLUMNS: readonly string[] = ["transfer_id", "budget_id", "delta"];

/**
 * The EXACT shape of every version this code reads: each table and its columns (#184: every
 * table's columns, not only hold's). A file is one of these, or it is fresh (no objects at all),
 * or it is refused.
 */
/** The triggers each version's exact shape carries (name → its sql, as stored). */
const SHAPE_TRIGGERS: Readonly<Record<number, Readonly<Record<string, string>>>> = {
	0: {},
	2: {},
	3: V3_TRIGGERS,
};

const SHAPES: Readonly<Record<number, Readonly<Record<string, readonly string[]>>>> = {
	0: { hold: V0_HOLD_COLUMNS, debt: DEBT_COLUMNS, applied: APPLIED_COLUMNS },
	2: { hold: V2_HOLD_COLUMNS, debt: DEBT_COLUMNS, applied: APPLIED_COLUMNS },
	3: {
		hold: V3_HOLD_COLUMNS,
		debt: DEBT_COLUMNS,
		applied: APPLIED_COLUMNS,
		meta: ["key", "value"],
	},
};

/**
 * The journal file was written by a schema this code cannot read safely. The file is LEFT
 * UNTOUCHED: it may hold open or settling holds and recorded debt, so it must never be deleted
 * or recreated to get past this — that would forget the debt (admission would over-admit) and
 * drop every hold still in flight.
 */
export class JournalSchemaError extends Error {
	constructor(why: string) {
		super(
			`hold journal: unsupported schema — ${why}. The file is left untouched. Do NOT delete or recreate it while it holds open or settling holds or any debt: that forgets the debt (over-admitting) and drops every hold in flight. Run a usertrust-openshell version that reads this schema, or drain the journal first.`,
		);
		this.name = "JournalSchemaError";
	}
}

/** The `voiding` row of an ambiguous placement could not be written: a ledger hold may exist with no row. */
export class OrphanRiskError extends Error {
	constructor(holdId: string, cause: unknown) {
		super(
			`hold journal: ORPHAN RISK — the placement of ${holdId} failed ambiguously AND its \`voiding\` row could not be written; a pending ledger hold may exist with no journal row (it expires at its ledger timeout)`,
			{ cause },
		);
		this.name = "OrphanRiskError";
	}
}

/** A hold id already journaled with DIFFERENT fields: never answered from the existing row. */
export class HoldConflictError extends Error {
	constructor(holdId: string, detail: string) {
		super(`hold journal: ${holdId} already exists with different fields (${detail})`);
		this.name = "HoldConflictError";
	}
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
	typeof (v as { then?: unknown } | null)?.then === "function";

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
	admit_by: number;
	intent_json: string | null;
	terminal_kind: string | null;
	terminal_event_hash: string | null;
	reserved_seq: number | null;
	incident_json: string | null;
	late_amount: number | null;
	late_state: LateState;
}

function toRow(r: RawRow): HoldRow {
	return {
		holdId: r.hold_id,
		budgetId: r.budget_id,
		state: r.state,
		amount: r.amount,
		ttlAt: r.ttl_at,
		admitBy: r.admit_by,
		intent: r.intent_json === null ? null : JSON.parse(r.intent_json),
		terminalKind: r.terminal_kind,
		terminalEventHash: r.terminal_event_hash,
		incident: r.incident_json === null ? null : JSON.parse(r.incident_json),
		lateState: r.late_state,
		lateAmount: r.late_amount,
		reservedSeq: r.reserved_seq,
	};
}

export type SettlementClaim =
	| { won: true }
	| { won: false; state: HoldState | "missing"; intent: unknown };

export type Reservation =
	| { admitted: true; existing: boolean }
	| {
			admitted: false;
			/**
			 * `hold_expired`: a retry found its `open` row past `ttlAt` — the ledger's
			 * pending transfer may already have expired, so nothing is forwarded on it.
			 */
			reason: "budget_exceeded" | "not_open" | "hold_expired";
			existing: boolean;
	  };

/**
 * A reservation. The ledger calls are made INSIDE the journal's write transaction,
 * so a crash or a failed COMMIT after {@link placeHold} can leave a ledger hold
 * with NO journal row (an orphan). The contract that makes a retry safe:
 */
export interface ReserveInput {
	/** Non-empty. The id every ledger transfer of this hold is DERIVED from. */
	holdId: string;
	/** Non-empty. */
	budgetId: string;
	/** A positive safe integer (usertokens). */
	amount: number;
	/**
	 * Epoch ms; finite. The LATEST the ledger's timeout can release this hold (its timeout
	 * starts when the placement commits): the sweeper's deadline and the placement horizon's base.
	 */
	ttlAt: number;
	/**
	 * Epoch ms; finite, and not after `ttlAt`. The EARLIEST the ledger's timeout can release
	 * this hold — the clock read BEFORE the placement plus the hold's lifetime. Admission is
	 * judged against it: a retry of an `open` row, and the placement itself, are refused
	 * (`hold_expired`) at or past it, because from then on the ledger hold may be gone.
	 */
	admitBy: number;
	/**
	 * Usertokens the budget can still reserve (the ledger's available credit),
	 * EXCLUDING any pending transfer this `holdId` already placed — an orphan from
	 * a lost COMMIT must not count against its own retry.
	 */
	availableCredit: (holdId: string) => Promise<number> | number;
	/**
	 * Place the pending transfer. MUST use the transfer id derived from `holdId`
	 * (never a fresh one), so a retry can never place a SECOND hold: a transfer
	 * already under that id is either confirmed as this same still-pending hold
	 * (success) or refused (throw). It MUST create the pending transfer with a
	 * ledger-side timeout that expires no later than `ttlAt`, so a placement that
	 * lands after the journal gave up on it expires by itself. A throw or a missed
	 * deadline is AMBIGUOUS: the row is committed as `voiding`, and the error rethrown.
	 */
	placeHold: () => Promise<void> | void;
}

function validateReserve(input: ReserveInput): void {
	const bad = (what: string) => new TypeError(`hold journal: reserve: ${what}`);
	if (typeof input.holdId !== "string" || input.holdId.length === 0)
		throw bad("holdId must be a non-empty string");
	if (typeof input.budgetId !== "string" || input.budgetId.length === 0)
		throw bad("budgetId must be a non-empty string");
	if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
		throw bad(`amount must be a positive safe integer, got ${String(input.amount)}`);
	if (!Number.isFinite(input.ttlAt)) throw bad("ttlAt must be finite");
	if (!Number.isFinite(input.admitBy)) throw bad("admitBy must be finite");
	if (input.admitBy > input.ttlAt)
		throw bad("admitBy (the earliest ledger expiry) must not be after ttlAt (the latest)");
}

export class HoldJournal {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly tx = new AsyncLocalStorage<object>();
	/** The token of the transaction now open, or null. */
	private active: object | null = null;
	private readonly retries: number;
	/** The deadline on each ledger call a reservation makes inside its transaction (ms). */
	readonly ledgerTimeoutMs: number;
	private readonly placementGraceMs: number;
	private readonly now: () => number;

	private constructor(
		private readonly db: DatabaseSync,
		private readonly reader: DatabaseSync,
		opts: JournalOptions,
	) {
		this.retries = opts.busyRetries ?? 2;
		this.ledgerTimeoutMs = opts.ledgerTimeoutMs ?? 5_000;
		this.placementGraceMs = opts.placementGraceMs ?? 10 * 60_000;
		this.now = opts.now ?? Date.now;
	}

	static open(path: string, opts: JournalOptions = {}): HoldJournal {
		const { DatabaseSync: Database } = loadSqlite();
		const busy = `PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 100))}`;
		const db = new Database(path);
		try {
			// busy_timeout FIRST: switching to WAL and migrating take locks and can themselves be
			// busy — another process may hold the write lock. Both run under the same retry policy
			// as a write transaction, ending in JournalBusyError, never a raw SQLITE_BUSY.
			db.exec(busy);
			const retries = opts.busyRetries ?? 2;
			// A file this code must refuse is refused BEFORE anything writes to it (the WAL switch
			// writes the header and creates -wal/-shm): a refused file is left byte-for-byte as it was.
			HoldJournal.retryBusy(retries, () => HoldJournal.classifySnapshot(db));
			const mode = HoldJournal.retryBusy(retries, () =>
				db.prepare("PRAGMA journal_mode = WAL").get(),
			) as { journal_mode?: unknown } | undefined;
			if (String(mode?.journal_mode).toLowerCase() !== "wal") {
				throw new Error(
					`hold journal: ${path} did not enter WAL mode (journal_mode = ${String(mode?.journal_mode)}) — the read connection and the cross-process CAS depend on it`,
				);
			}
			HoldJournal.retryBusy(retries, () => HoldJournal.migrate(db));
		} catch (err) {
			db.close(); // no handle leaks from a refused or failed open
			throw err;
		}
		const reader = new Database(path, { readOnly: true });
		reader.exec(busy);
		return new HoldJournal(db, reader, opts);
	}

	private static retryBusy<T>(retries: number, op: () => T): T {
		for (let attempt = 1; ; attempt++) {
			try {
				return op();
			} catch (err) {
				if (!isBusy(err)) throw err;
				if (attempt > retries) throw new JournalBusyError(attempt);
			}
		}
	}

	close(): void {
		this.reader.close();
		this.db.close();
	}

	private inThisTx(): boolean {
		const t = this.tx.getStore();
		return t !== undefined && t === this.active;
	}

	/**
	 * What the file is, read-only — each answer defined POSITIVELY, everything else refused
	 * ({@link JournalSchemaError}). The primitive is the file's VERSION and its OBJECTS: every
	 * table and trigger in `sqlite_master`, except SQLite's own `sqlite_*` internals (e.g. the
	 * `sqlite_stat1` an operator's ANALYZE adds; that prefix is reserved, so no user table takes
	 * it). Indexes are not part of the shape.
	 * - `fresh`: a readable version and NO objects at all (a new, empty file);
	 * - a version number (`0`, `2`, `3`): exactly that version's tables, each with exactly its
	 *   columns ({@link SHAPES}), and exactly its triggers, by name and sql ({@link SHAPE_TRIGGERS}:
	 *   none before v3; v3's two late-state guards).
	 */
	private static classify(db: DatabaseSync): "fresh" | 0 | 2 | 3 {
		const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
			.user_version;
		const shape = SHAPES[version];
		// Only a version with a known shape is readable at all: any OTHER version (a newer one, 1,
		// or a negative one, which the pragma accepts) is a schema this code does not know,
		// whatever objects the file holds.
		if (shape === undefined) {
			throw new JournalSchemaError(
				`schema version ${version}, this code reads ${JOURNAL_SCHEMA_VERSION}`,
			);
		}
		const objects = db
			.prepare(
				"SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
			)
			.all() as Array<{ type: string; name: string; sql: string | null }>;
		if (objects.length === 0) return "fresh";
		const columnsOf = (table: string) =>
			(
				db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{
					name: string;
				}>
			).map((c) => c.name);
		// A journal written before the admission deadline existed has no `admit_by` to judge an
		// `open` row by; reading its `ttl_at` (an upper bound) in its place would admit after the
		// ledger may have released the hold. Refused, never guessed.
		const hold = columnsOf("hold");
		if (hold.length > 0 && !hold.includes("admit_by")) {
			throw new JournalSchemaError("the hold table has no admit_by column");
		}
		const same = (a: readonly string[], b: readonly string[]) =>
			[...a].sort().join(",") === [...b].sort().join(",");
		const triggers = objects.filter((o) => o.type === "trigger");
		const tables = objects.filter((o) => o.type === "table").map((o) => o.name);
		// Triggers: EXACTLY this version's (name and stored sql) — so a foreign trigger, or one
		// of ours altered, is never adopted.
		const expectedTriggers = SHAPE_TRIGGERS[version] ?? {};
		const triggersExact =
			same(
				triggers.map((t) => t.name),
				Object.keys(expectedTriggers),
			) && triggers.every((t) => t.sql === expectedTriggers[t.name]);
		const exact =
			triggersExact &&
			same(tables, Object.keys(shape)) &&
			tables.every((t) => same(columnsOf(t), shape[t] ?? []));
		if (exact) return version as 0 | 2 | 3;
		const found = objects.map((o) => (o.type === "table" ? o.name : `trigger ${o.name}`));
		throw new JournalSchemaError(
			`schema version ${version} (an unrecognised shape: tables ${found.sort().join(", ")}), this code reads ${JOURNAL_SCHEMA_VERSION}`,
		);
	}

	/**
	 * {@link classify} under ONE read transaction: its reads see one snapshot, so an opener racing
	 * a migration that COMMITS between them cannot see a half-old, half-new file and refuse a
	 * healthy one. A read transaction takes no write lock and changes nothing on disk.
	 */
	private static classifySnapshot(db: DatabaseSync): "fresh" | 0 | 2 | 3 {
		db.exec("BEGIN");
		try {
			return HoldJournal.classify(db);
		} finally {
			db.exec("COMMIT");
		}
	}

	/**
	 * Create or migrate the schema in ONE write transaction, re-deciding INSIDE it: a second
	 * opener that raced the first one waits on the lock, then finds the file already current and
	 * does nothing (never a "duplicate column"). Each step's columns and its version stamp commit
	 * together, so a crash can never leave a file half-migrated; every row and all debt are kept.
	 * v0 → (incident_json) → v2 → (late_amount, late_state, meta, the late-state triggers) → v3.
	 */
	private static migrate(db: DatabaseSync): void {
		db.exec("BEGIN IMMEDIATE");
		try {
			const kind = HoldJournal.classify(db);
			if (kind === "fresh") {
				db.exec(`
					CREATE TABLE hold (
						hold_id TEXT PRIMARY KEY,
						budget_id TEXT NOT NULL,
						state TEXT NOT NULL CHECK (state IN
							('open','settling','settled','voiding','voided','expiring','expired')),
						amount INTEGER NOT NULL CHECK (amount > 0),
						ttl_at INTEGER NOT NULL,
						admit_by INTEGER NOT NULL,
						intent_json TEXT,
						terminal_kind TEXT,
						terminal_event_hash TEXT,
						reserved_seq INTEGER,
						incident_json TEXT
					);
					CREATE INDEX hold_state_ttl ON hold (state, ttl_at);
					CREATE TABLE debt (
						budget_id TEXT PRIMARY KEY,
						amount INTEGER NOT NULL CHECK (amount >= 0)
					);
					CREATE TABLE applied (
						transfer_id TEXT PRIMARY KEY,
						budget_id TEXT NOT NULL,
						delta INTEGER NOT NULL
					);
				`);
			}
			if (kind === 0) db.exec("ALTER TABLE hold ADD COLUMN incident_json TEXT");
			if (kind === "fresh" || kind === 0 || kind === 2) {
				// The late settlement (slice 1c-1): its amount, recorded once on an expiring or
				// expired row, and whether the ledger has taken it.
				db.exec(`
					ALTER TABLE hold ADD COLUMN late_amount INTEGER CHECK (late_amount IS NULL OR late_amount >= 0);
					ALTER TABLE hold ADD COLUMN late_state TEXT NOT NULL DEFAULT 'none' CHECK (late_state IN ('none', 'recorded', 'charged', 'zero'));
					CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
				`);
				for (const sql of Object.values(V3_TRIGGERS)) db.exec(sql);
				db.exec(`PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION}`);
			}
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	/**
	 * One write transaction with a SYNCHRONOUS body: the in-process lock, then
	 * `BEGIN IMMEDIATE` (retried while busy, then {@link JournalBusyError}), then
	 * `fn`, then COMMIT. Anything `fn` throws rolls back and rethrows. A body that
	 * returns a promise is refused (rolled back): a claim COMMITS before any ledger
	 * call. The refusal rolls back the JOURNAL only — a ledger call the body already
	 * dispatched before returning its promise is not unsent, which is why the rule is
	 * "never call the ledger in a claim", not "the journal will catch it". A writeTx
	 * inside another is refused loudly (it would deadlock).
	 */
	writeTx<T>(fn: () => T): Promise<T> {
		return this.runTx(() => {
			const out = fn();
			if (isThenable(out)) {
				// The refused body may still reject later; that is not this caller's to handle,
				// and an unhandled rejection can end the process (#172).
				(out as PromiseLike<unknown>).then(undefined, () => {});
				throw new Error(
					"hold journal: writeTx takes a SYNCHRONOUS body — a claim commits before any ledger call; only reserve holds a transaction across one",
				);
			}
			return out;
		});
	}

	private runTx<T>(fn: () => Promise<T> | T): Promise<T> {
		if (this.tx.getStore() !== undefined) {
			return Promise.reject(
				new Error(
					"hold journal: nested writeTx — a transaction cannot open another (it would wait on itself)",
				),
			);
		}
		const run = async (): Promise<T> => {
			this.begin();
			const token = {};
			this.active = token;
			try {
				const out = await this.tx.run(token, fn);
				this.db.exec("COMMIT");
				return out;
			} catch (err) {
				try {
					this.db.exec("ROLLBACK");
				} catch {
					// A failed ROLLBACK must not mask the error that caused it (often a failed COMMIT).
				}
				throw err;
			} finally {
				this.active = null;
			}
		};
		const next = this.tail.then(run, run);
		this.tail = next.catch(() => undefined);
		return next;
	}

	/** A ledger call made inside reserve's transaction, bounded by the journal's deadline. */
	private async bounded<T>(op: string, call: () => Promise<T> | T): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				Promise.resolve().then(call),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new LedgerDeadlineError(op, this.ledgerTimeoutMs)),
						this.ledgerTimeoutMs,
					);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
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

	/** Inside THIS caller's own open transaction — not merely while some transaction is open. */
	private requireTx(op: string): void {
		if (!this.inThisTx()) throw new Error(`hold journal: ${op} must run inside its own writeTx`);
	}

	/**
	 * THE compare-and-set. Must run inside {@link writeTx}. Returns true only when
	 * exactly one row moved `from → to`.
	 */
	/**
	 * The compare-and-set every transition uses: `from → to` only when the row is in `from`
	 * AND CARRIES NO INCIDENT. An incident is terminal: no transition from it is legal, so the
	 * rule lives here, once, rather than at each caller. False when nothing changed.
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
		if (from === "voiding" && to === "voided" && set.terminalKind === "voided_not_found") {
			// The ledger says the transfer does not exist. An abandoned placement (the call
			// timed out but was never cancelled) may still create it; finalizing now would
			// leave that late hold with nothing to void it. Wait out the horizon.
			const row = this.get(holdId);
			if (row !== undefined) {
				const horizonAt = row.ttlAt + this.placementGraceMs;
				if (this.now() < horizonAt) throw new PlacementHorizonError(holdId, horizonAt);
			}
		}
		const result = this.db
			.prepare(
				`UPDATE hold SET state = ?,
					intent_json = COALESCE(?, intent_json),
					terminal_kind = COALESCE(?, terminal_kind)
				 WHERE hold_id = ? AND state = ? AND incident_json IS NULL`,
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

	/** A read: on the writer inside this caller's transaction; on the reader otherwise, busy-retried. */
	private read<T>(q: (db: DatabaseSync) => T): T {
		if (this.inThisTx()) return q(this.db);
		return HoldJournal.retryBusy(this.retries, () => q(this.reader));
	}

	get(holdId: string): HoldRow | undefined {
		const r = this.read(
			(db) => db.prepare("SELECT * FROM hold WHERE hold_id = ?").get(holdId) as RawRow | undefined,
		);
		return r === undefined ? undefined : toRow(r);
	}

	debtOf(budgetId: string): number {
		const r = this.read(
			(db) =>
				db.prepare("SELECT amount FROM debt WHERE budget_id = ?").get(budgetId) as
					| { amount: number }
					| undefined,
		);
		return r?.amount ?? 0;
	}

	/**
	 * Reserve, atomically with the debt it is checked against: inside ONE write
	 * transaction, read the debt, check `available − debt ≥ amount`, place the
	 * pending transfer, insert the `open` row, commit. A retried evaluation of the
	 * same hold places nothing and answers from the existing row.
	 */
	reserve(input: ReserveInput): Promise<Reservation> {
		try {
			validateReserve(input); // before any lock or ledger call
		} catch (err) {
			return Promise.reject(err);
		}
		return this.runTx<Reservation | { ambiguous: unknown }>(async () => {
			const existing = this.get(input.holdId);
			if (existing !== undefined) {
				// A retry answers from its row ONLY when it is the same hold.
				if (existing.budgetId !== input.budgetId || existing.amount !== input.amount) {
					throw new HoldConflictError(
						input.holdId,
						`row: budget ${existing.budgetId}, amount ${existing.amount}; request: budget ${input.budgetId}, amount ${input.amount}`,
					);
				}
				if (existing.state !== "open")
					return { admitted: false, reason: "not_open", existing: true };
				// An `open` row is NOT proof of a live ledger hold once its lifetime has passed
				// (a restart, a delayed sweeper): the pending transfer may have expired. Fail closed.
				if (this.now() >= existing.admitBy)
					return { admitted: false, reason: "hold_expired", existing: true };
				return { admitted: true, existing: true };
			}
			// Nothing is placed for a hold whose lifetime has already passed.
			if (this.now() >= input.admitBy)
				return { admitted: false, reason: "hold_expired", existing: false };
			const debt = this.debtOf(input.budgetId);
			const available = await this.bounded("availableCredit", () =>
				input.availableCredit(input.holdId),
			);
			// A malformed balance (NaN, negative, fractional) would make the comparison below
			// false and admit past the debt limit: fail closed before anything is placed.
			if (!Number.isSafeInteger(available) || available < 0) {
				throw new TypeError(
					`hold journal: availableCredit must return a non-negative safe integer, got ${String(available)}`,
				);
			}
			if (available - debt < input.amount) {
				return { admitted: false, reason: "budget_exceeded", existing: false };
			}
			try {
				await this.bounded("placeHold", () => input.placeHold());
			} catch (err) {
				// AMBIGUOUS: the ledger may have placed the hold even though the call failed (a lost
				// response, a deadline). Rolling the row back would orphan it, so the row is COMMITTED
				// as `voiding`: the release path voids the derived id (a hold that was never placed
				// voids as not-found), and a retry sees `voiding` and is refused — never placed twice.
				try {
					this.db
						.prepare(
							"INSERT INTO hold (hold_id, budget_id, state, amount, ttl_at, admit_by, intent_json) VALUES (?, ?, 'voiding', ?, ?, ?, ?)",
						)
						.run(
							input.holdId,
							input.budgetId,
							input.amount,
							input.ttlAt,
							input.admitBy,
							JSON.stringify({
								ambiguousPlacement: err instanceof Error ? err.message : String(err),
							}),
						);
				} catch (insertErr) {
					throw new OrphanRiskError(input.holdId, insertErr);
				}
				return { ambiguous: err };
			}
			// A placement that answered at or past ttlAt is NOT a live reservation: the ledger's
			// pending transfer may already have expired. It is never forwarded on; the row is
			// committed `voiding`, so the release path voids it under the placement-horizon rule.
			if (this.now() >= input.admitBy) {
				this.db
					.prepare(
						"INSERT INTO hold (hold_id, budget_id, state, amount, ttl_at, admit_by, intent_json) VALUES (?, ?, 'voiding', ?, ?, ?, ?)",
					)
					.run(
						input.holdId,
						input.budgetId,
						input.amount,
						input.ttlAt,
						input.admitBy,
						JSON.stringify({ placedPastTtl: true }),
					);
				return { admitted: false, reason: "hold_expired", existing: false };
			}
			this.db
				.prepare(
					"INSERT INTO hold (hold_id, budget_id, state, amount, ttl_at, admit_by) VALUES (?, ?, 'open', ?, ?, ?)",
				)
				.run(input.holdId, input.budgetId, input.amount, input.ttlAt, input.admitBy);
			return { admitted: true, existing: false };
		}).then((out) => {
			// The `voiding` row is committed; the placement's own error is the answer.
			if ("ambiguous" in out) throw out.ambiguous;
			return out;
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
		if (typeof budgetId !== "string" || budgetId.length === 0)
			throw new TypeError("hold journal: applyDebt: budgetId must be a non-empty string");
		if (typeof transferId !== "string" || transferId.length === 0)
			throw new TypeError("hold journal: applyDebt: transferId must be a non-empty string");
		if (!Number.isSafeInteger(delta))
			throw new TypeError(
				`hold journal: applyDebt: delta must be a safe integer, got ${String(delta)}`,
			);
		const marker = this.db
			.prepare("INSERT OR IGNORE INTO applied (transfer_id, budget_id, delta) VALUES (?, ?, ?)")
			.run(transferId, budgetId, delta);
		if (Number(marker.changes) !== 1) {
			// A replay of the SAME transfer is a no-op; the same id with different fields is a bug
			// that would otherwise leave debt on the wrong budget or amount, silently.
			const seen = this.db
				.prepare("SELECT budget_id, delta FROM applied WHERE transfer_id = ?")
				.get(transferId) as { budget_id: string; delta: number } | undefined;
			if (seen === undefined || seen.budget_id !== budgetId || seen.delta !== delta) {
				throw new Error(
					`hold journal: transfer ${transferId} was applied with budget ${String(seen?.budget_id)}, delta ${String(seen?.delta)}; replayed with budget ${budgetId}, delta ${delta}`,
				);
			}
			return false;
		}
		// Two statements, not an upsert: SQLite checks `amount >= 0` on an upsert's PROPOSED
		// insert row before DO UPDATE, so a repayment (negative delta) always failed. The CHECK
		// still applies to the UPDATE's result — debt never goes below zero.
		this.db
			.prepare(
				"INSERT INTO debt (budget_id, amount) VALUES (?, 0) ON CONFLICT (budget_id) DO NOTHING",
			)
			.run(budgetId);
		this.db.prepare("UPDATE debt SET amount = amount + ? WHERE budget_id = ?").run(delta, budgetId);
		return true;
	}

	/** `open` holds whose TTL (plus grace) has passed: the sweeper's work list. */
	openPast(nowMs: number): HoldRow[] {
		return this.read(
			(db) =>
				db
					.prepare("SELECT * FROM hold WHERE state = 'open' AND ttl_at < ? ORDER BY ttl_at")
					.all(nowMs) as unknown as RawRow[],
		).map(toRow);
	}

	/**
	 * Rows in a non-terminal, non-open state: a claim whose winner may have crashed. A row
	 * carrying an incident is NOT in flight — nothing can complete it; see {@link incidents}.
	 */
	inFlight(): HoldRow[] {
		return this.read(
			(db) =>
				db
					.prepare(
						"SELECT * FROM hold WHERE state IN ('settling','voiding','expiring') AND incident_json IS NULL",
					)
					.all() as unknown as RawRow[],
		).map(toRow);
	}

	/** Rows carrying a terminal incident: an operator must act on each. */
	incidents(): HoldRow[] {
		return this.read(
			(db) =>
				db
					.prepare("SELECT * FROM hold WHERE incident_json IS NOT NULL")
					.all() as unknown as RawRow[],
		).map(toRow);
	}

	/**
	 * Record the LATE settlement of a hold the ledger released before it could be posted: its
	 * full actual amount, once: `none → recorded` (amount > 0) or `none → zero` (amount 0, a
	 * terminal disposition with no transfer). Only an `expiring` or `expired` row without an
	 * incident takes it (anything else is not late), and only from `none`, so the FIRST recorded
	 * disposition wins, zero included. Must run inside {@link writeTx}; the caller records the
	 * debt of a non-zero amount in the same transaction. False when nothing changed.
	 */
	recordLate(holdId: string, amount: number): boolean {
		this.requireTx("recordLate");
		if (!Number.isSafeInteger(amount) || amount < 0) {
			throw new TypeError(
				`hold journal: recordLate: amount must be a non-negative safe integer, got ${String(amount)}`,
			);
		}
		const r = this.db
			.prepare(
				"UPDATE hold SET late_amount = ?, late_state = ? WHERE hold_id = ? AND late_state = 'none' AND incident_json IS NULL AND state IN ('expiring','expired')",
			)
			.run(amount, amount > 0 ? "recorded" : "zero", holdId);
		return Number(r.changes) === 1;
	}

	/** The ledger took a recorded late settlement: `recorded → charged`, once. Inside {@link writeTx}. */
	markLateCharged(holdId: string): boolean {
		this.requireTx("markLateCharged");
		const r = this.db
			.prepare(
				"UPDATE hold SET late_state = 'charged' WHERE hold_id = ? AND late_state = 'recorded' AND incident_json IS NULL",
			)
			.run(holdId);
		return Number(r.changes) === 1;
	}

	/** Recorded late settlements the ledger has not taken yet (rows with an incident excluded). */
	lateUncharged(): HoldRow[] {
		return this.read(
			(db) =>
				db
					.prepare("SELECT * FROM hold WHERE late_state = 'recorded' AND incident_json IS NULL")
					.all() as unknown as RawRow[],
		).map(toRow);
	}

	/** The sweeper's heartbeat: the clock reading of its latest run. Inside {@link writeTx}. */
	recordHeartbeat(atMs: number): void {
		this.requireTx("recordHeartbeat");
		this.db
			.prepare(
				"INSERT INTO meta (key, value) VALUES ('sweeper_heartbeat', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			)
			.run(String(atMs));
	}

	/** The sweeper's latest heartbeat, or null if it has never run. */
	heartbeat(): number | null {
		const r = this.read(
			(db) =>
				db.prepare("SELECT value FROM meta WHERE key = 'sweeper_heartbeat'").get() as
					| { value: string }
					| undefined,
		);
		return r === undefined ? null : Number(r.value);
	}

	/**
	 * Attach the actual cost of a settlement that could NOT be recorded (the row already carries
	 * an incident) to that incident, once, so an operator can bill it. Inside {@link writeTx}.
	 */
	recordUnbilled(holdId: string, unbilled: unknown): boolean {
		this.requireTx("recordUnbilled");
		const r = this.db
			.prepare(
				"UPDATE hold SET incident_json = json_set(incident_json, '$.unbilled', json(?)) WHERE hold_id = ? AND incident_json IS NOT NULL AND json_extract(incident_json, '$.unbilled') IS NULL",
			)
			.run(JSON.stringify(unbilled), holdId);
		return Number(r.changes) === 1;
	}

	/**
	 * The ledger TOOK a late charge for a row that became an incident meanwhile (so the row could
	 * not be marked `charged`): record that fact on the incident, once, so it is never lost — the
	 * operator sees "charged on the ledger" next to the incident. Inside {@link writeTx}.
	 */
	recordLedgerChargedOnIncident(holdId: string, amount: number): boolean {
		this.requireTx("recordLedgerChargedOnIncident");
		const r = this.db
			.prepare(
				"UPDATE hold SET incident_json = json_set(incident_json, '$.late_charged_on_ledger', ?) WHERE hold_id = ? AND incident_json IS NOT NULL AND json_extract(incident_json, '$.late_charged_on_ledger') IS NULL",
			)
			.run(amount, holdId);
		return Number(r.changes) === 1;
	}

	/** Record a terminal incident on a row, once. Must run inside {@link writeTx}. */
	recordIncident(holdId: string, incident: unknown): boolean {
		this.requireTx("recordIncident");
		const r = this.db
			.prepare("UPDATE hold SET incident_json = ? WHERE hold_id = ? AND incident_json IS NULL")
			.run(JSON.stringify(incident), holdId);
		return Number(r.changes) === 1;
	}

	/** Terminal rows whose terminal event was never recorded. */
	terminalWithoutEvent(): HoldRow[] {
		return this.read(
			(db) =>
				db
					.prepare(
						"SELECT * FROM hold WHERE state IN ('settled','voided','expired') AND terminal_event_hash IS NULL",
					)
					.all() as unknown as RawRow[],
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
