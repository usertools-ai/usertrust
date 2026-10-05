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
	JournalBusyError,
	JournalUnavailableError,
	LedgerDeadlineError,
	loadSqlite,
	MIN_NODE_FOR_JOURNAL,
} from "../src/journal.js";

const dirs: string[] = [];
const journals: HoldJournal[] = [];
function fresh(opts?: Parameters<typeof HoldJournal.open>[1]) {
	const dir = mkdtempSync(join(tmpdir(), "openshell-journal-"));
	dirs.push(dir);
	const path = join(dir, "holds.db");
	const j = HoldJournal.open(path, opts);
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
			availableCredit: () => 120,
			placeHold: () => void placed++,
		});
		expect(r).toEqual({ admitted: false, reason: "budget_exceeded", existing: false });
		expect(placed, "no hold placed").toBe(0);
	});
	it("a retried evaluation of the same hold places nothing and answers from the row", async () => {
		const { j } = fresh();
		let placed = 0;
		const input = {
			holdId: "h1",
			budgetId: "b",
			amount: 10,
			ttlAt: 0,
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
		]) {
			await expect(j.reserve({ ...base, ...bad }), JSON.stringify(bad)).rejects.toBeInstanceOf(
				TypeError,
			);
		}
		expect(calls).toBe(0);
	});

	it("a retry answers from the row only when it is the SAME hold; different fields are a conflict", async () => {
		const { j } = fresh();
		await open(j, "h1", "b", 100);
		await expect(open(j, "h1", "b", 100)).resolves.toEqual({ admitted: true, existing: true });
		await expect(open(j, "h1", "b", 999)).rejects.toBeInstanceOf(HoldConflictError);
		await expect(open(j, "h1", "other-budget", 100)).rejects.toBeInstanceOf(HoldConflictError);
	});

	it("availableCredit is told WHICH hold is reserving (it must exclude that hold's own orphaned transfer)", async () => {
		const { j } = fresh();
		const seen: string[] = [];
		await j.reserve({
			holdId: "r-42",
			budgetId: "b",
			amount: 10,
			ttlAt: 1_000,
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
