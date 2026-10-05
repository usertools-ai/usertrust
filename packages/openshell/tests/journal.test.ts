// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	HoldConflictError,
	HoldJournal,
	JOURNAL_SCHEMA_VERSION,
	JournalBusyError,
	JournalSchemaError,
	JournalUnavailableError,
	LedgerDeadlineError,
	loadSqlite,
	MIN_NODE_FOR_JOURNAL,
	OrphanRiskError,
	PlacementHorizonError,
} from "../src/journal.js";

const dirs: string[] = [];
const journals: HoldJournal[] = [];
function fresh(opts?: Parameters<typeof HoldJournal.open>[1]) {
	const dir = mkdtempSync(join(tmpdir(), "openshell-journal-"));
	dirs.push(dir);
	const path = join(dir, "holds.db");
	// The fixtures' ttlAt values are small epoch numbers (0, 1, 5, 1,000): a test that does not
	// set its own clock stands just BEFORE all of them, so every fixture hold is still live.
	// Under Date.now each one had expired decades ago (#167 MEDIUM P1 made that visible).
	const j = HoldJournal.open(path, { now: () => -1, ...opts });
	journals.push(j);
	return { j, path, dir };
}
afterEach(() => {
	for (const j of journals.splice(0)) {
		try {
			j.close();
		} catch {
			// already closed
		}
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const open = (j: HoldJournal, holdId: string, budgetId = "b", amount = 100) =>
	j.reserve({
		holdId,
		budgetId,
		amount,
		ttlAt: 1_000,
		admitBy: 1_000,
		availableCredit: () => 1e9,
		placeHold: () => {},
	});

describe("hold journal: node:sqlite is required, and its absence says so", () => {
	it("a runtime without node:sqlite gets JournalUnavailableError naming the requirement — not an opaque import failure", () => {
		const missing = () => {
			const e = new Error("No such built-in module: node:sqlite") as Error & { code: string };
			e.code = "ERR_UNKNOWN_BUILTIN_MODULE";
			throw e;
		};
		let caught: unknown;
		try {
			loadSqlite(missing);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(JournalUnavailableError);
		expect((caught as Error).message).toContain(`Node >= ${MIN_NODE_FOR_JOURNAL}`);
		expect((caught as Error).message).toContain(process.versions.node);
		expect((caught as Error & { cause: { code: string } }).cause.code).toBe(
			"ERR_UNKNOWN_BUILTIN_MODULE",
		);
		expect(() => loadSqlite(() => ({}))).toThrow(JournalUnavailableError);
	});

	it("engines.node pins the same minimum, and this runtime meets it", () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
		expect(pkg.engines?.node).toBe(`>=${MIN_NODE_FOR_JOURNAL}`);
		const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
		expect(maj > 22 || (maj === 22 && min >= 13), `Node ${process.versions.node}`).toBe(true);
		expect(typeof loadSqlite().DatabaseSync).toBe("function");
	});
});

describe("hold journal: the compare-and-set", () => {
	it("a transition wins exactly once; a second claim from the same state loses", async () => {
		const { j } = fresh();
		await open(j, "h1");
		expect(await j.writeTx(() => j.cas("h1", "open", "settling"))).toBe(true);
		expect(await j.writeTx(() => j.cas("h1", "open", "settling"))).toBe(false);
		expect(await j.writeTx(() => j.cas("h1", "open", "expiring"))).toBe(false);
		expect(j.get("h1")?.state).toBe("settling");
	});

	it("an illegal transition throws, and a CAS outside a write transaction throws", async () => {
		const { j } = fresh();
		await open(j, "h1");
		await expect(j.writeTx(() => j.cas("h1", "open", "settled"))).rejects.toThrow(
			/illegal transition/,
		);
		await expect(j.writeTx(() => j.cas("h1", "settled", "open"))).rejects.toThrow(
			/illegal transition/,
		);
		expect(() => j.cas("h1", "open", "settling")).toThrow(/inside its own writeTx/);
	});

	it("the journal runs in WAL mode", () => {
		const { path } = fresh();
		const raw = new DatabaseSync(path);
		expect(
			(raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
		).toBe("wal");
		raw.close();
	});
});

describe("hold journal: BUSY is never a lost CAS", () => {
	it("a write lock held by another connection THROWS JournalBusyError — the claim is not reported as lost", async () => {
		const { j, path } = fresh({ busyTimeoutMs: 10, busyRetries: 2 });
		await open(j, "h1");
		const rival = new DatabaseSync(path);
		rival.exec("BEGIN IMMEDIATE");
		await expect(j.claimSettlement("h1", { usage: 1 })).rejects.toBeInstanceOf(JournalBusyError);
		expect(j.get("h1")?.state, "nothing moved").toBe("open");
		rival.exec("COMMIT");
		rival.close();
		expect(await j.claimSettlement("h1", { usage: 1 })).toEqual({ won: true });
	});

	it("a busy reservation throws (the caller fails closed); no row, no hold placed", async () => {
		const { j, path } = fresh({ busyTimeoutMs: 10, busyRetries: 1 });
		const rival = new DatabaseSync(path);
		rival.exec("BEGIN IMMEDIATE");
		let placed = 0;
		await expect(
			j.reserve({
				holdId: "h1",
				budgetId: "b",
				amount: 1,
				ttlAt: 0,
				admitBy: 0,
				availableCredit: () => 10,
				placeHold: () => void placed++,
			}),
		).rejects.toBeInstanceOf(JournalBusyError);
		rival.exec("ROLLBACK");
		rival.close();
		expect(placed).toBe(0);
		expect(j.get("h1")).toBeUndefined();
	});
});

describe("hold journal: one writer inside the process too", () => {
	it("reserve's transaction, held open across its ledger call, is not entered by a second in-process transaction", async () => {
		const { j } = fresh();
		await open(j, "h1");
		const order: string[] = [];
		const first = j.reserve({
			holdId: "r1",
			budgetId: "b",
			amount: 10,
			ttlAt: 1_000,
			admitBy: 1_000,
			availableCredit: () => 1e9,
			placeHold: async () => {
				order.push("1:begin");
				await new Promise((r) => setTimeout(r, 30));
				order.push("1:end");
			},
		});
		const second = j.writeTx(() => {
			order.push("2:begin");
			j.cas("h1", "open", "settling");
			order.push("2:end");
		});
		await Promise.all([first, second]);
		expect(order).toEqual(["1:begin", "1:end", "2:begin", "2:end"]);
	});

	it("#167 P2-3: writeTx refuses an ASYNC body (a claim commits before any ledger call) and rolls it back", async () => {
		const { j } = fresh();
		await open(j, "h1");
		await expect(
			// biome-ignore lint/suspicious/useAwait: the async body IS the case under test
			j.writeTx(async () => {
				j.cas("h1", "open", "settling");
			}),
		).rejects.toThrow(/SYNCHRONOUS body/);
		expect(j.get("h1")?.state, "rolled back").toBe("open");
	});

	it("#167 P2-2: a direct cas / applyDebt / recordTerminalEvent from ANOTHER request while reserve awaits is refused, not run inside its transaction", async () => {
		const { j } = fresh();
		await open(j, "h2");
		let release: () => void = () => {};
		const parked = new Promise<void>((r) => {
			release = r;
		});
		let entered: () => void = () => {};
		const inside = new Promise<void>((r) => {
			entered = r;
		});
		const pending = j.reserve({
			holdId: "r1",
			budgetId: "b",
			amount: 10,
			ttlAt: 1_000,
			admitBy: 1_000,
			availableCredit: () => 1e9,
			placeHold: async () => {
				entered();
				await parked;
				throw new Error("placement refused"); // the reservation ROLLS BACK
			},
		});
		await inside;
		expect(() => j.cas("h2", "open", "settling")).toThrow(/inside its own writeTx/);
		expect(() => j.applyDebt("b", "t-x", 5)).toThrow(/inside its own writeTx/);
		expect(() => j.recordTerminalEvent("h2", "e")).toThrow(/inside its own writeTx/);
		release();
		await expect(pending).rejects.toThrow("placement refused");
		expect(j.get("h2")?.state, "h2 untouched").toBe("open");
		expect(j.debtOf("b")).toBe(0);
	});

	it("#167 P3: a nested writeTx is refused loudly (it would wait on itself)", async () => {
		const { j } = fresh();
		let nested: Promise<unknown> | undefined;
		await j.reserve({
			holdId: "r1",
			budgetId: "b",
			amount: 10,
			ttlAt: 1_000,
			admitBy: 1_000,
			availableCredit: () => 1e9,
			placeHold: () => {
				nested = j.writeTx(() => 1);
			},
		});
		await expect(nested).rejects.toThrow(/nested writeTx/);
	});

	it("#167 P2-4: a ledger call that never answers fails the reservation at the deadline — rolled back, the lock released", async () => {
		const { j } = fresh({ ledgerTimeoutMs: 50 });
		await expect(
			j.reserve({
				holdId: "r1",
				budgetId: "b",
				amount: 10,
				ttlAt: 1_000,
				admitBy: 1_000,
				availableCredit: () => 1e9,
				placeHold: () => new Promise<void>(() => {}),
			}),
		).rejects.toBeInstanceOf(LedgerDeadlineError);
		expect(j.get("r1")?.state, "ambiguous (the call may still land): committed as voiding").toBe(
			"voiding",
		);
		await expect(open(j, "r2"), "the next reservation is not wedged").resolves.toMatchObject({
			admitted: true,
		});
	});

	it("#167 P3: reads outside a transaction see only COMMITTED rows (a separate read connection)", async () => {
		const { j } = fresh();
		let release: () => void = () => {};
		const parked = new Promise<void>((r) => {
			release = r;
		});
		let entered: () => void = () => {};
		const inside = new Promise<void>((r) => {
			entered = r;
		});
		const pending = j.reserve({
			holdId: "r1",
			budgetId: "b",
			amount: 10,
			ttlAt: 1_000,
			admitBy: 1_000,
			availableCredit: () => 1e9,
			placeHold: async () => {
				j.applyDebt("b", "t-1", 50); // inside reserve's own transaction: allowed
				entered();
				await parked;
			},
		});
		await inside;
		expect(j.debtOf("b"), "the uncommitted debt is invisible outside the transaction").toBe(0);
		release();
		await pending;
		expect(j.debtOf("b"), "and visible once committed").toBe(50);
	});

	it("a failed transaction rolls back and does not wedge the next one", async () => {
		const { j } = fresh();
		await open(j, "h1");
		await expect(
			j.writeTx(() => {
				j.cas("h1", "open", "settling");
				throw new Error("ledger said no");
			}),
		).rejects.toThrow("ledger said no");
		expect(j.get("h1")?.state, "rolled back").toBe("open");
		expect(await j.writeTx(() => j.cas("h1", "open", "voiding"))).toBe(true);
	});
});

describe("hold journal: a settlement claim — the loser acts BY STATE", () => {
	it("the winner writes its intent with the claim; a duplicate sees `settling` and the winner's intent", async () => {
		const { j } = fresh();
		await open(j, "h1");
		expect(await j.claimSettlement("h1", { actual: 42 })).toEqual({ won: true });
		expect(j.get("h1")?.intent).toEqual({ actual: 42 });
		expect(await j.claimSettlement("h1", { actual: 43 })).toEqual({
			won: false,
			state: "settling",
			intent: { actual: 42 },
		});
	});
	it("after the sweeper's claim the loser sees `expiring` (the one state that permits a late settlement)", async () => {
		const { j } = fresh();
		await open(j, "h1");
		await j.writeTx(() => j.cas("h1", "open", "expiring"));
		expect(await j.claimSettlement("h1", { actual: 1 })).toMatchObject({
			won: false,
			state: "expiring",
		});
	});
	it("a claim on an unknown hold reports `missing`", async () => {
		const { j } = fresh();
		expect(await j.claimSettlement("nope", {})).toEqual({
			won: false,
			state: "missing",
			intent: null,
		});
	});
});

describe("hold journal: reservation is atomic with the debt it is checked against", () => {
	it("admits when available − debt covers the hold, and records an open row", async () => {
		const { j } = fresh();
		let placed = 0;
		const r = await j.reserve({
			holdId: "h1",
			budgetId: "b",
			amount: 100,
			ttlAt: 5,
			admitBy: 5,
			availableCredit: () => 100,
			placeHold: () => void placed++,
		});
		expect(r).toEqual({ admitted: true, existing: false });
		expect(placed).toBe(1);
		expect(j.get("h1")).toMatchObject({ state: "open", amount: 100, ttlAt: 5, budgetId: "b" });
	});
	it("outstanding debt counts against the budget", async () => {
		const { j } = fresh();
		await j.writeTx(() => j.applyDebt("b", "t-overage-1", 30));
		let placed = 0;
		const r = await j.reserve({
			holdId: "h1",
			budgetId: "b",
			amount: 100,
			ttlAt: 0,
			admitBy: 0,
			availableCredit: () => 120,
			placeHold: () => void placed++,
		});
		expect(r).toEqual({ admitted: false, reason: "budget_exceeded", existing: false });
		expect(placed, "no hold placed").toBe(0);
	});
	it("a retried evaluation of the same hold places nothing and answers from the row", async () => {
		const { j } = fresh({ now: () => -1 }); // inside the hold's lifetime (ttlAt 0)
		let placed = 0;
		const input = {
			holdId: "h1",
			budgetId: "b",
			amount: 10,
			ttlAt: 0,
			admitBy: 0,
			availableCredit: () => 100,
			placeHold: () => void placed++,
		};
		await j.reserve(input);
		expect(await j.reserve(input)).toEqual({ admitted: true, existing: true });
		expect(placed).toBe(1);
		await j.writeTx(() => j.cas("h1", "open", "voiding"));
		expect(await j.reserve(input)).toEqual({ admitted: false, reason: "not_open", existing: true });
	});
	it("a placement that throws is AMBIGUOUS: the row is committed as `voiding` (never orphaned), the error rethrown, and a retry is refused — never placed twice", async () => {
		const { j } = fresh();
		let placed = 0;
		const attempt = () =>
			j.reserve({
				holdId: "h1",
				budgetId: "b",
				amount: 10,
				ttlAt: 0,
				admitBy: 0,
				availableCredit: () => 100,
				placeHold: () => {
					placed += 1;
					throw new Error("ledger timeout");
				},
			});
		await expect(attempt()).rejects.toThrow("ledger timeout");
		const row = j.get("h1");
		expect(row?.state).toBe("voiding");
		expect(row?.intent).toEqual({ ambiguousPlacement: "ledger timeout" });
		expect(
			j.inFlight().map((r) => r.holdId),
			"the release path's work list",
		).toContain("h1");
		await expect(attempt()).resolves.toEqual({
			admitted: false,
			reason: "not_open",
			existing: true,
		});
		expect(placed, "the retry placed nothing").toBe(1);
	});

	it("an availableCredit failure placed nothing: rolled back, no row", async () => {
		const { j } = fresh();
		await expect(
			j.reserve({
				holdId: "h1",
				budgetId: "b",
				amount: 10,
				ttlAt: 0,
				admitBy: 0,
				availableCredit: () => {
					throw new Error("ledger down");
				},
				placeHold: () => {},
			}),
		).rejects.toThrow("ledger down");
		expect(j.get("h1")).toBeUndefined();
	});
});

describe("#167: reserve's contract — validated input, the same hold only, and its own id", () => {
	it("invalid input is refused BEFORE any lock or ledger call", async () => {
		const { j } = fresh();
		let calls = 0;
		const base = {
			holdId: "r1",
			budgetId: "b",
			amount: 10,
			ttlAt: 1_000,
			admitBy: 1_000,
			availableCredit: () => {
				calls += 1;
				return 1e9;
			},
			placeHold: () => {
				calls += 1;
			},
		};
		for (const bad of [
			{ amount: 0 },
			{ amount: -1 },
			{ amount: 1.5 },
			{ amount: Number.NaN },
			{ amount: 2 ** 53 },
			{ holdId: "" },
			{ budgetId: "" },
			{ ttlAt: Number.POSITIVE_INFINITY },
			{ admitBy: Number.NaN },
			{ admitBy: 2_000 }, // after ttlAt (1,000): the earliest expiry cannot be after the latest
		]) {
			await expect(j.reserve({ ...base, ...bad }), JSON.stringify(bad)).rejects.toBeInstanceOf(
				TypeError,
			);
		}
		expect(calls).toBe(0);
	});

	it("a retry answers from the row only when it is the SAME hold; different fields are a conflict", async () => {
		const { j } = fresh({ now: () => 0 }); // inside the hold's lifetime (ttlAt 1,000)
		await open(j, "h1", "b", 100);
		await expect(open(j, "h1", "b", 100)).resolves.toEqual({ admitted: true, existing: true });
		await expect(open(j, "h1", "b", 999)).rejects.toBeInstanceOf(HoldConflictError);
		await expect(open(j, "h1", "other-budget", 100)).rejects.toBeInstanceOf(HoldConflictError);
	});

	it("#167 MEDIUM P1: a placement that completes AFTER ttlAt is not admitted — the row is committed `voiding`, hold_expired, never forwarded", async () => {
		let now = 0;
		const { j } = fresh({ now: () => now });
		const slow = (finishAt: number) => ({
			budgetId: "b",
			amount: 100,
			ttlAt: 1_000,
			admitBy: 1_000,
			availableCredit: () => 1e9,
			placeHold: async () => {
				now = finishAt; // the ledger answered this late
			},
		});
		await expect(j.reserve({ holdId: "late", ...slow(1_000) })).resolves.toEqual({
			admitted: false,
			reason: "hold_expired",
			existing: false,
		});
		expect(j.get("late")?.state, "the release path voids it").toBe("voiding");
		now = 0;
		await expect(
			j.reserve({ holdId: "late", ...slow(0) }),
			"a retry is never placed again",
		).resolves.toEqual({
			admitted: false,
			reason: "not_open",
			existing: true,
		});
		now = 0;
		await expect(j.reserve({ holdId: "in-time", ...slow(999) })).resolves.toEqual({
			admitted: true,
			existing: false,
		});
		expect(j.get("in-time")?.state).toBe("open");
	});

	it("#167 connector P1: a fresh reservation whose ttlAt has already passed places nothing and writes no row", async () => {
		const { j } = fresh({ now: () => 1_000 });
		let placed = 0;
		let asked = 0;
		await expect(
			j.reserve({
				holdId: "dead",
				budgetId: "b",
				amount: 100,
				ttlAt: 1_000,
				admitBy: 1_000,
				availableCredit: () => {
					asked++;
					return 1e9;
				},
				placeHold: () => void placed++,
			}),
		).resolves.toEqual({ admitted: false, reason: "hold_expired", existing: false });
		expect([placed, asked]).toEqual([0, 0]);
		expect(j.get("dead")).toBeUndefined();
	});

	it("#167 connector P2: an availableCredit that is not a non-negative safe integer fails closed — nothing placed, no row", async () => {
		for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, "100" as unknown as number]) {
			const { j } = fresh();
			let placed = 0;
			await expect(
				j.reserve({
					holdId: "h",
					budgetId: "b",
					amount: 100,
					ttlAt: 1_000,
					admitBy: 1_000,
					availableCredit: () => bad,
					placeHold: () => void placed++,
				}),
				String(bad),
			).rejects.toThrow(/availableCredit must return a non-negative safe integer/);
			expect(placed, String(bad)).toBe(0);
			expect(j.get("h"), String(bad)).toBeUndefined();
		}
	});

	it("availableCredit is told WHICH hold is reserving (it must exclude that hold's own orphaned transfer)", async () => {
		const { j } = fresh();
		const seen: string[] = [];
		await j.reserve({
			holdId: "r-42",
			budgetId: "b",
			amount: 10,
			ttlAt: 1_000,
			admitBy: 1_000,
			availableCredit: (holdId) => {
				seen.push(holdId);
				return 1e9;
			},
			placeHold: () => {},
		});
		expect(seen).toEqual(["r-42"]);
	});
});

describe("#167 P3: the journal opens in WAL mode or not at all", () => {
	it("a database that cannot enter WAL (in-memory) is refused at open", () => {
		expect(() => HoldJournal.open(":memory:")).toThrow(/did not enter WAL mode/);
	});
});

describe("hold journal: debt changes apply exactly once per transfer", () => {
	it("the applied marker and the debt update commit together; a replay changes nothing", async () => {
		const { j } = fresh();
		expect(await j.writeTx(() => j.applyDebt("b", "overage:h1", 25))).toBe(true);
		expect(await j.writeTx(() => j.applyDebt("b", "overage:h1", 25))).toBe(false);
		expect(await j.writeTx(() => j.applyDebt("b", "late:h2", 5))).toBe(true);
		expect(j.debtOf("b")).toBe(30);
		expect(() => j.applyDebt("b", "x", 1)).toThrow(/inside its own writeTx/);
	});

	it("#167 MEDIUM P2: a repayment (negative delta) applies while the total stays >= 0; below zero is refused and changes nothing", async () => {
		const { j } = fresh();
		expect(await j.writeTx(() => j.applyDebt("b", "overage:h1", 30))).toBe(true);
		expect(await j.writeTx(() => j.applyDebt("b", "repay:1", -20))).toBe(true);
		expect(j.debtOf("b")).toBe(10);
		expect(await j.writeTx(() => j.applyDebt("b", "repay:2", -10))).toBe(true);
		expect(j.debtOf("b")).toBe(0);
		await expect(j.writeTx(() => j.applyDebt("b", "repay:3", -1))).rejects.toThrow();
		expect(j.debtOf("b"), "the refused repayment rolled back with its marker").toBe(0);
		await expect(j.writeTx(() => j.applyDebt("fresh-budget", "repay:4", -1))).rejects.toThrow();
		expect(j.debtOf("fresh-budget")).toBe(0);
	});
});

describe("#167 connector folds", () => {
	it("P1: a late settlement can finish from `expiring` — it and the sweeper's expiry race on one CAS, exactly one wins", async () => {
		const { j } = fresh();
		await open(j, "h1");
		await open(j, "h2");
		await j.writeTx(() => j.cas("h1", "open", "expiring"));
		await j.writeTx(() => j.cas("h2", "open", "expiring"));
		// h1: the late settlement wins, the sweeper loses.
		expect(
			await j.writeTx(() => j.cas("h1", "expiring", "settled", { terminalKind: "late_settled" })),
		).toBe(true);
		expect(await j.writeTx(() => j.cas("h1", "expiring", "expired"))).toBe(false);
		expect(j.get("h1")).toMatchObject({ state: "settled", terminalKind: "late_settled" });
		// h2: the sweeper wins, the late settlement loses.
		expect(await j.writeTx(() => j.cas("h2", "expiring", "expired"))).toBe(true);
		expect(await j.writeTx(() => j.cas("h2", "expiring", "settled"))).toBe(false);
	});

	it("P2: a debt-marker replay with DIFFERENT fields throws; the same replay is a quiet no-op", async () => {
		const { j } = fresh();
		expect(await j.writeTx(() => j.applyDebt("b", "t1", 40))).toBe(true);
		expect(await j.writeTx(() => j.applyDebt("b", "t1", 40))).toBe(false);
		await expect(j.writeTx(() => j.applyDebt("b", "t1", 41))).rejects.toThrow(
			/applied with budget b, delta 40/,
		);
		await expect(j.writeTx(() => j.applyDebt("other", "t1", 40))).rejects.toThrow(
			/replayed with budget other/,
		);
		expect(j.debtOf("b")).toBe(40);
		expect(j.debtOf("other")).toBe(0);
	});

	it("P2: opening a journal while another process holds the write lock retries, then throws JournalBusyError — never a raw SQLITE_BUSY", () => {
		const dir = mkdtempSync(join(tmpdir(), "openshell-journal-"));
		dirs.push(dir);
		const path = join(dir, "holds.db");
		const holder = new DatabaseSync(path);
		holder.exec("PRAGMA journal_mode = WAL");
		holder.exec("BEGIN IMMEDIATE");
		try {
			expect(() => HoldJournal.open(path, { busyTimeoutMs: 5, busyRetries: 1 })).toThrow(
				JournalBusyError,
			);
		} finally {
			holder.exec("ROLLBACK");
			holder.close();
		}
		const j = HoldJournal.open(path, { busyTimeoutMs: 5, busyRetries: 1 });
		journals.push(j);
		expect(j.get("nothing")).toBeUndefined();
	});
});

describe("hold journal: the sweeper's work lists", () => {
	it("open-past-TTL, in-flight claims, and terminal rows without their event", async () => {
		const { j } = fresh();
		for (const [id, ttl] of [
			["a", 10],
			["b", 20],
			["c", 99],
		] as const) {
			await j.reserve({
				holdId: id,
				budgetId: "b",
				amount: 1,
				ttlAt: ttl,
				admitBy: ttl,
				availableCredit: () => 100,
				placeHold: () => {},
			});
		}
		expect(j.openPast(50).map((r) => r.holdId)).toEqual(["a", "b"]);
		await j.writeTx(() => j.cas("a", "open", "expiring"));
		expect(j.inFlight().map((r) => r.holdId)).toEqual(["a"]);
		await j.writeTx(() =>
			j.cas("a", "expiring", "expired", { terminalKind: "hold_expired_unsettled" }),
		);
		expect(j.terminalWithoutEvent().map((r) => r.holdId)).toEqual(["a"]);
		expect(await j.writeTx(() => j.recordTerminalEvent("a", "hash-1"))).toBe(true);
		expect(await j.writeTx(() => j.recordTerminalEvent("a", "hash-2")), "recorded once").toBe(
			false,
		);
		expect(j.get("a")).toMatchObject({
			state: "expired",
			terminalKind: "hold_expired_unsettled",
			terminalEventHash: "hash-1",
		});
		expect(j.terminalWithoutEvent()).toEqual([]);
	});
});

// ── Two OS processes on one journal file ──

const RACER = join(__dirname, "fixtures", "journal-racer.ts");
const REPO_ROOT = join(__dirname, "..", "..", "..");

type RacerResult = {
	role: string;
	won: number[];
	busy: number;
	startedAt: number;
	endedAt: number;
};

/** Releases both racers only once BOTH are up, then proves their runs overlapped. */
async function race(dir: string, a: string[], b: string[]): Promise<[RacerResult, RacerResult]> {
	const go = join(dir, "go");
	const racing = Promise.all([
		racer([...a.slice(0, 2), go, ...a.slice(2)]),
		racer([...b.slice(0, 2), go, ...b.slice(2)]),
	]);
	while (readdirSync(dir).filter((f) => f.endsWith(".ready")).length < 2) {
		await new Promise((r) => setTimeout(r, 5));
	}
	writeFileSync(go, "");
	const [ra, rb] = await racing;
	// The two runs genuinely overlapped: each started before the other ended.
	expect(
		ra.startedAt < rb.endedAt && rb.startedAt < ra.endedAt,
		"the racers ran concurrently",
	).toBe(true);
	return [ra, rb];
}

function racer(args: string[]): Promise<RacerResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--no-warnings", "--import", "tsx", RACER, ...args], {
			cwd: REPO_ROOT,
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("exit", (code) =>
			code === 0
				? resolve(JSON.parse(out.trim()))
				: reject(new Error(`racer exited ${code}: ${err}`)),
		);
	});
}

const N = 1_000;

describe("hold journal: two OS processes racing on one file", { timeout: 120_000 }, () => {
	for (const [a, b] of [
		["settle", "sweep"],
		["settle", "settle"],
		["sweep", "sweep"],
	] as const) {
		it(`${a} vs ${b}: exactly one winner per hold, ${N} holds`, async () => {
			const { j, path, dir } = fresh();
			for (let i = 0; i < N; i++) await open(j, `h${i}`);
			const [ra, rb] = await race(dir, ["cas", path, a, String(N)], ["cas", path, b, String(N)]);
			const wins = new Map<number, number>();
			for (const i of [...ra.won, ...rb.won]) wins.set(i, (wins.get(i) ?? 0) + 1);
			const notExactlyOne = [...Array(N).keys()].filter((i) => wins.get(i) !== 1);
			expect(notExactlyOne, "holds without exactly one winner").toEqual([]);
			// Positive control: with a 2 ms busy timeout BUSY really surfaced, was retried, and was never a lost claim.
			expect(ra.busy + rb.busy, "BUSY surfaced between the processes").toBeGreaterThan(0);
			for (let i = 0; i < N; i++) {
				expect(j.get(`h${i}`)?.state).not.toBe("open");
			}
		});
	}

	it(`reservations: a budget whose debt-adjusted headroom fits ONE hold admits exactly one, ${N} budgets`, async () => {
		const { j, path, dir } = fresh();
		const ledgerPath = join(dir, "ledger.db");
		const ledger = new DatabaseSync(ledgerPath);
		ledger.exec(
			"PRAGMA journal_mode = WAL; CREATE TABLE bal (budget TEXT PRIMARY KEY, available INTEGER)",
		);
		for (let i = 0; i < N; i++) {
			ledger.prepare("INSERT INTO bal VALUES (?, 200)").run(`b${i}`);
			// available 200 − debt 50 = 150: one hold of 100 fits, a second does not.
			await j.writeTx(() => j.applyDebt(`b${i}`, `seed-${i}`, 50));
		}
		ledger.close();
		const [rp, rq] = await race(
			dir,
			["reserve", path, "p", String(N), ledgerPath],
			["reserve", path, "q", String(N), ledgerPath],
		);
		const admitted = new Map<number, number>();
		for (const i of [...rp.won, ...rq.won]) admitted.set(i, (admitted.get(i) ?? 0) + 1);
		const notExactlyOne = [...Array(N).keys()].filter((i) => admitted.get(i) !== 1);
		expect(notExactlyOne, "budgets that did not admit exactly one hold").toEqual([]);
	});
});

describe("#167: an abandoned placement may still land — `voiding` waits out the placement horizon", () => {
	const ambiguous = (j: HoldJournal, holdId = "h1") =>
		j.reserve({
			holdId,
			budgetId: "b",
			amount: 10,
			ttlAt: 1_000,
			admitBy: 1_000,
			availableCredit: () => 1e9,
			placeHold: () => {
				throw new Error("lost response");
			},
		});

	it("P1: a NOT-FOUND void before ttlAt + grace is refused — the row stays `voiding` (in flight) for a re-void", async () => {
		let now = 0; // reserved while the hold is live…
		const { j } = fresh({ placementGraceMs: 60_000, now: () => now });
		await expect(ambiguous(j)).rejects.toThrow("lost response");
		now = 1_000; // …voided at ttlAt, still inside the placement horizon
		await expect(
			j.writeTx(() => j.cas("h1", "voiding", "voided", { terminalKind: "voided_not_found" })),
		).rejects.toBeInstanceOf(PlacementHorizonError);
		expect(j.get("h1")?.state).toBe("voiding");
		expect(j.inFlight().map((r) => r.holdId)).toContain("h1");
		now = 1_000 + 60_000; // the horizon has passed: a late create can no longer land
		expect(
			await j.writeTx(() => j.cas("h1", "voiding", "voided", { terminalKind: "voided_not_found" })),
		).toBe(true);
	});

	it("P1: the late create LANDS after the refused not-found: the next void finds it and finalizes as voided, at any time", async () => {
		let now = 0; // reserved while the hold is live…
		const { j } = fresh({ placementGraceMs: 60_000, now: () => now });
		await expect(ambiguous(j)).rejects.toThrow("lost response");
		now = 1_000; // …voided at ttlAt, still inside the placement horizon
		await expect(
			j.writeTx(() => j.cas("h1", "voiding", "voided", { terminalKind: "voided_not_found" })),
		).rejects.toBeInstanceOf(PlacementHorizonError);
		// …the abandoned create lands; the re-void now voids a real pending transfer.
		expect(
			await j.writeTx(() => j.cas("h1", "voiding", "voided", { terminalKind: "voided" })),
		).toBe(true);
		expect(j.get("h1")).toMatchObject({ state: "voided", terminalKind: "voided" });
	});

	it("P3: the deadline error tells the truth — placeHold may still land (committed `voiding`); availableCredit placed nothing", async () => {
		const { j } = fresh({ ledgerTimeoutMs: 20 });
		const hang = () => new Promise<never>(() => {});
		const place = j.reserve({
			holdId: "a",
			budgetId: "b",
			amount: 1,
			ttlAt: 1,
			admitBy: 1,
			availableCredit: () => 1e9,
			placeHold: hang,
		});
		await expect(place).rejects.toThrow(/may still land.*voiding/);
		const credit = j.reserve({
			holdId: "c",
			budgetId: "b",
			amount: 1,
			ttlAt: 1,
			admitBy: 1,
			availableCredit: hang,
			placeHold: () => {},
		});
		await expect(credit).rejects.toThrow(/nothing was placed; reservation rolled back/);
		expect(j.get("c")).toBeUndefined();
	});

	it("P3: a `voiding` row that cannot be written fails LOUDLY as an orphan risk", async () => {
		const { j } = fresh();
		const writer = (j as unknown as { db: DatabaseSync }).db;
		await expect(
			j.reserve({
				holdId: "h1",
				budgetId: "b",
				amount: 10,
				ttlAt: 1_000,
				admitBy: 1_000,
				availableCredit: () => 1e9,
				placeHold: () => {
					writer.exec("DROP TABLE hold"); // inside the transaction: rolled back with it
					throw new Error("lost response");
				},
			}),
		).rejects.toBeInstanceOf(OrphanRiskError);
		expect(j.get("h1"), "the table is back (DDL rolled back) and holds no row").toBeUndefined();
	});

	it("P3: applyDebt validates its fields", async () => {
		const { j } = fresh();
		for (const [b, t, d] of [
			["", "t", 1],
			["b", "", 1],
			["b", "t", 1.5],
			["b", "t", Number.NaN],
		] as const) {
			await expect(
				j.writeTx(() => j.applyDebt(b, t, d)),
				`${b}/${t}/${d}`,
			).rejects.toBeInstanceOf(TypeError);
		}
	});

	it("P3: a read BUSY on the read connection ends in JournalBusyError (after the retries), never a raw SQLITE_BUSY", async () => {
		const { j } = fresh({ busyTimeoutMs: 5, busyRetries: 2 });
		await open(j, "h1");
		// A reader whose every query is SQLITE_BUSY (errcode 5) — a live lock cannot be forced
		// on demand against a WAL reader from a test, so the busy answer is substituted.
		const real = (j as unknown as { reader: DatabaseSync }).reader;
		let attempts = 0;
		(j as unknown as { reader: unknown }).reader = {
			prepare: () => {
				attempts += 1;
				throw Object.assign(new Error("database is locked"), { errcode: 5 });
			},
		};
		try {
			expect(() => j.get("h1")).toThrow(JournalBusyError);
			expect(attempts, "retried busyRetries + 1 times").toBe(3);
		} finally {
			(j as unknown as { reader: DatabaseSync }).reader = real;
		}
		expect(j.get("h1")?.state).toBe("open");
	});
});

describe("#167: a retry past the hold's lifetime is refused; the reservation errors are exported", () => {
	it("P1: an `open` row whose ttlAt has passed is NOT proof of a live hold — the retry is refused hold_expired", async () => {
		let now = 0;
		const { j } = fresh({ now: () => now });
		await open(j, "h1"); // ttlAt 1,000
		await expect(open(j, "h1")).resolves.toEqual({ admitted: true, existing: true });
		now = 1_000; // the lifetime (and the ledger's pending timeout, by contract) has passed
		await expect(open(j, "h1")).resolves.toEqual({
			admitted: false,
			reason: "hold_expired",
			existing: true,
		});
	});

	it("P2: every error reserve and its neighbours throw is importable from the package root", async () => {
		const root = await import("../src/index.js");
		for (const name of [
			"HoldConflictError",
			"LedgerDeadlineError",
			"OrphanRiskError",
			"PlacementHorizonError",
			"JournalBusyError",
			"JournalUnavailableError",
		]) {
			expect(typeof (root as Record<string, unknown>)[name], name).toBe("function");
		}
	});
});

describe("#174 P1: admission is judged by the EARLIEST ledger expiry (admitBy), never by ttlAt", () => {
	// admitBy 1,000 (the earliest the ledger can release the hold), ttlAt 1,050 (the latest).
	const reserve = (j: HoldJournal, placeHold: () => void = () => {}) =>
		j.reserve({
			holdId: "h1",
			budgetId: "b",
			amount: 100,
			ttlAt: 1_050,
			admitBy: 1_000,
			availableCredit: () => 1e9,
			placeHold,
		});

	it("a retry of an `open` row between admitBy and ttlAt is refused hold_expired: the ledger hold may already be gone", async () => {
		let now = 0;
		const { j } = fresh({ now: () => now });
		await expect(reserve(j)).resolves.toEqual({ admitted: true, existing: false });
		expect(j.get("h1")).toMatchObject({ ttlAt: 1_050, admitBy: 1_000 });
		now = 1_010; // past the earliest expiry, before the latest
		await expect(reserve(j)).resolves.toEqual({
			admitted: false,
			reason: "hold_expired",
			existing: true,
		});
	});

	it("a fresh reservation, or a placement that answers, between admitBy and ttlAt is not admitted", async () => {
		let now = 1_010;
		const { j } = fresh({ now: () => now });
		let placed = 0;
		await expect(reserve(j, () => void placed++)).resolves.toEqual({
			admitted: false,
			reason: "hold_expired",
			existing: false,
		});
		expect(placed, "nothing placed past the admission deadline").toBe(0);
		now = 0;
		const late = fresh({ now: () => now }).j;
		await expect(
			reserve(late, () => {
				now = 1_020; // the ledger answered after admitBy, before ttlAt
			}),
		).resolves.toEqual({ admitted: false, reason: "hold_expired", existing: false });
		expect(late.get("h1")?.state).toBe("voiding");
	});

	it("a journal written before admit_by existed is refused at open, never read with ttl_at in its place", () => {
		const dir = mkdtempSync(join(tmpdir(), "openshell-journal-old-"));
		dirs.push(dir);
		const path = join(dir, "holds.db");
		const raw = new DatabaseSync(path);
		raw.exec(
			"CREATE TABLE hold (hold_id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, state TEXT NOT NULL, amount INTEGER NOT NULL, ttl_at INTEGER NOT NULL, intent_json TEXT, terminal_kind TEXT, terminal_event_hash TEXT, reserved_seq INTEGER)",
		);
		raw.close();
		expect(() => HoldJournal.open(path)).toThrow(JournalSchemaError);
	});
});

describe("#172: writeTx's refusal of an async body leaves no unhandled rejection", () => {
	it("a REJECTING async body: the refusal is still thrown, and nothing is left unhandled", async () => {
		const { j } = fresh();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(
				j.writeTx(() =>
					(async () => {
						await new Promise((r) => setTimeout(r, 5));
						throw new Error("the async body failed later");
					})(),
				),
			).rejects.toThrow(/SYNCHRONOUS body/);
			await new Promise((r) => setTimeout(r, 50)); // the body rejects after the refusal
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(unhandled).toEqual([]);
	});
});

describe("#177: the journal schema carries a version", () => {
	it("a file stamped with another schema version is refused at open; a fresh file is stamped", () => {
		const dir = mkdtempSync(join(tmpdir(), "openshell-journal-ver-"));
		dirs.push(dir);
		const path = join(dir, "holds.db");
		HoldJournal.open(path).close();
		const raw = new DatabaseSync(path);
		expect(
			(raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
		).toBe(JOURNAL_SCHEMA_VERSION);
		raw.exec("PRAGMA user_version = 1");
		raw.close();
		expect(() => HoldJournal.open(path)).toThrow(JournalSchemaError);
	});
});
