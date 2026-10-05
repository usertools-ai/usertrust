// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { HoldDetector } from "../src/detector.js";
import {
	DebtChargeFailedError,
	HoldEngine,
	InvalidSettlementIntentError,
	PlacementWindowError,
} from "../src/engine.js";
import { HoldJournal, LedgerDeadlineError } from "../src/journal.js";
import {
	BudgetIdError,
	type ChargeOutcome,
	type LedgerPort,
	type PostOutcome,
	transferIdFor,
	type VoidOutcome,
} from "../src/ledger.js";

/**
 * A ledger fake with TigerBeetle's one property the engine relies on: a transfer
 * id is applied AT MOST ONCE. `crashAfter` makes the next call of that op record
 * its transfer and then throw, the way a process dies after the ledger committed.
 */
class FakeLedger implements LedgerPort {
	balances = new Map<string, number>();
	applied = new Map<string, number>(); // transfer id → amount (once)
	debt = new Map<string, number>();
	expired = new Set<string>(); // hold keys the ledger's own timeout has voided
	crashAfter: "post" | "chargeDebt" | null = null;
	/** Answer the next post / release with this outcome (a retired id's read-back). */
	postAnswer: PostOutcome | null = null;
	releaseAnswer: VoidOutcome | null = null;
	/** Holds whose release throws (a step that fails for ONE row). */
	releaseThrows = new Set<string>();
	/** ensureDebtAccount throws this (a debt account the ledger refuses), when set. */
	debtAccountRefusal: Error | null = null;
	ensuredDebt: string[] = [];
	/** Run while ensureDebtAccount / post is pending: a caller mutating its own object. */
	onEnsure: (() => void) | null = null;
	onPost: (() => void) | null = null;
	/** Runs inside available(): a slow balance lookup (advances the test clock). */
	onAvailable: (() => void) | null = null;
	/** While set, chargeDebt waits on it: the gap between the claim and the ledger charge. */
	chargeGate: Promise<void> | null = null;
	/** Answer every chargeDebt with this outcome (both ids retired, nothing charged). */
	chargeAnswer: ChargeOutcome | null = null;
	hang: "placeHold" | null = null;

	private once(id: bigint, amount: number): boolean {
		const k = id.toString();
		if (this.applied.has(k)) return false;
		this.applied.set(k, amount);
		return true;
	}
	private crash(op: "post" | "chargeDebt"): void {
		if (this.crashAfter === op) {
			this.crashAfter = null;
			throw new Error(`process died after ${op}`);
		}
	}
	private has(holdKey: string, role: Parameters<typeof transferIdFor>[1]): boolean {
		return this.applied.has(transferIdFor(holdKey, role).toString());
	}
	async ensureDebtAccount(budgetId: string): Promise<void> {
		this.onEnsure?.();
		await Promise.resolve();
		if (this.debtAccountRefusal !== null) throw this.debtAccountRefusal;
		this.ensuredDebt.push(budgetId);
	}
	/** Like the TigerBeetle port: the hold's OWN reserve amount is added back. */
	async available(budgetId: string, holdKey: string): Promise<number> {
		this.onAvailable?.();
		const own = this.applied.get(transferIdFor(holdKey, "reserve").toString()) ?? 0;
		return (this.balances.get(budgetId) ?? 0) + own;
	}
	async placeHold(p: { budgetId: string; holdKey: string; amount: number }): Promise<void> {
		if (this.hang === "placeHold") await new Promise(() => {});
		// Like the client's PendingReplayError: a pending replay is never a live hold.
		if (this.has(p.holdKey, "reserve")) throw new Error("pending replay: reserve under a new id");
		this.once(transferIdFor(p.holdKey, "reserve"), p.amount);
		this.balances.set(p.budgetId, (this.balances.get(p.budgetId) ?? 0) - p.amount);
	}
	async post(p: { holdKey: string; amount: number }): Promise<PostOutcome> {
		this.onPost?.();
		if (this.postAnswer !== null) return this.postAnswer;
		if (this.expired.has(p.holdKey)) return "expired";
		this.once(transferIdFor(p.holdKey, "post"), p.amount);
		this.crash("post");
		return "done";
	}
	async release(p: { holdKey: string }): Promise<VoidOutcome> {
		if (this.releaseThrows.has(p.holdKey)) throw new Error(`release ${p.holdKey} failed`);
		if (this.releaseAnswer !== null) return this.releaseAnswer;
		if (!this.has(p.holdKey, "reserve")) return "not_found";
		if (this.has(p.holdKey, "post")) return "posted";
		if (this.expired.has(p.holdKey)) return "expired";
		this.once(transferIdFor(p.holdKey, "void"), 0);
		return "done";
	}
	async chargeDebt(p: {
		budgetId: string;
		holdKey: string;
		role: "overage" | "late";
		amount: number;
	}): Promise<ChargeOutcome> {
		if (this.chargeGate !== null) await this.chargeGate;
		if (this.chargeAnswer !== null) return this.chargeAnswer;
		if (this.once(transferIdFor(p.holdKey, p.role), p.amount)) {
			this.debt.set(p.budgetId, (this.debt.get(p.budgetId) ?? 0) + p.amount);
		}
		this.crash("chargeDebt");
		return "done";
	}
	/** Probes the sweep made for a landed late charge. */
	probes: string[] = [];
	async lateChargeLanded(holdKey: string): Promise<boolean> {
		this.probes.push(holdKey);
		return this.has(holdKey, "late") || this.has(holdKey, "late-retry");
	}
	/** How many distinct transfers of a role were applied for a hold (0 or 1). */
	count(holdKey: string, role: Parameters<typeof transferIdFor>[1]): number {
		return this.applied.has(transferIdFor(holdKey, role).toString()) ? 1 : 0;
	}
}

const dirs: string[] = [];
const journals: HoldJournal[] = [];
afterEach(() => {
	for (const j of journals.splice(0)) j.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const GRACE = 60_000;
function setup(available = 1_000) {
	const dir = mkdtempSync(join(tmpdir(), "openshell-engine-"));
	dirs.push(dir);
	// ONE clock for the journal and the engine: the journal checks ttlAt against its own.
	const clock = { now: 1_000 };
	const journal = HoldJournal.open(join(dir, "holds.db"), {
		ledgerTimeoutMs: 50,
		placementGraceMs: GRACE,
		now: () => clock.now,
	});
	journals.push(journal);
	const ledger = new FakeLedger();
	ledger.balances.set("b", available);
	const engine = new HoldEngine(journal, ledger, { holdTtlSeconds: 900, now: () => clock.now });
	return { journal, ledger, engine, clock };
}

describe("hold engine: reserve", () => {
	it("admits within the budget, places the hold with the derived reserve id, and records the TTL", async () => {
		const { journal, ledger, engine } = setup(500);
		expect(await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 200 })).toEqual({
			admitted: true,
			existing: false,
		});
		expect(ledger.count("k1", "reserve")).toBe(1);
		// ttlAt covers the placement deadline: the ledger's timeout starts when the hold commits.
		expect(journal.get("k1")).toMatchObject({
			state: "open",
			amount: 200,
			ttlAt: 1_000 + 900_000 + 100, // placeBy (start + one deadline) + one deadline + lifetime
		});
	});
	it("refuses over budget (debt included) and places nothing", async () => {
		const { journal, ledger, engine } = setup(150);
		await journal.writeTx(() => journal.applyDebt("b", "seed", 60));
		expect(await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 })).toEqual({
			admitted: false,
			reason: "budget_exceeded",
		});
		expect(ledger.count("k1", "reserve")).toBe(0);
	});
	it("a placement that does not answer by the journal's deadline is AMBIGUOUS: the request fails, and the row is `voiding` for the release path", async () => {
		const { journal, ledger, engine } = setup();
		ledger.hang = "placeHold";
		await expect(
			engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 }),
		).rejects.toBeInstanceOf(LedgerDeadlineError);
		expect(journal.get("k1")?.state).toBe("voiding");
	});
	it("an ORPHAN from a lost commit (the ledger holds it, the journal has no row) does not count against its own retry: the retry reaches the placement, which refuses the replay, and the row is `voiding` — then voided", async () => {
		const { journal, ledger, engine } = setup(100);
		// The first attempt placed the hold, then its COMMIT was lost.
		await ledger.placeHold({ budgetId: "b", holdKey: "k1", amount: 100 });
		expect(journal.get("k1")).toBeUndefined();
		await expect(engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 })).rejects.toThrow(
			/pending replay/,
		);
		expect(journal.get("k1")?.state, "never budget_exceeded with no row").toBe("voiding");
		expect(await engine.release("k1")).toEqual({ outcome: "voided" });
		expect(ledger.count("k1", "void")).toBe(1);
	});
	it("a hold already past its lifetime is not reserved: hold_expired", async () => {
		const { engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 });
		clock.now = 1_000 + 900_000 + 50;
		expect(await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 })).toEqual({
			admitted: false,
			reason: "hold_expired",
		});
	});
});

describe("hold engine: settle — exactly one post, exactly one terminal", () => {
	it("settles: one post of the intent, the hold `settled`", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		expect(await engine.settle("k1", { post: 70, overage: 0 })).toEqual({
			outcome: "settled",
			resumed: false,
		});
		expect(ledger.applied.get(transferIdFor("k1", "post").toString())).toBe(70);
		expect(journal.get("k1")).toMatchObject({ state: "settled", terminalKind: "settled" });
	});
	it("an overage posts the hold and charges the excess to debt exactly once", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await engine.settle("k1", { post: 100, overage: 30 });
		expect(ledger.debt.get("b")).toBe(30);
		expect(journal.debtOf("b"), "the journal counts the debt the next reservation sees").toBe(30);
	});
	it("a duplicate settlement of a settled hold makes no ledger operation", async () => {
		const { ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await engine.settle("k1", { post: 50, overage: 0 });
		expect(await engine.settle("k1", { post: 99, overage: 5 })).toEqual({ outcome: "duplicate" });
		expect(
			ledger.applied.get(transferIdFor("k1", "post").toString()),
			"the first intent stands",
		).toBe(50);
		expect(ledger.count("k1", "overage")).toBe(0);
	});
	it("a crash AFTER the post and before `settled` is resumed from the stored intent: one post, settled", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.crashAfter = "post";
		await expect(engine.settle("k1", { post: 80, overage: 0 })).rejects.toThrow(/died after post/);
		expect(journal.get("k1")?.state, "claimed, not settled").toBe("settling");
		// A retried response evaluation (or the next sweep) settles it — with ANY intent
		// it carries, the stored one wins.
		expect(await engine.settle("k1", { post: 1, overage: 0 })).toEqual({
			outcome: "settled",
			resumed: true,
		});
		expect(ledger.applied.get(transferIdFor("k1", "post").toString())).toBe(80);
		expect(journal.get("k1")?.state).toBe("settled");
	});
	it("a crash after the ledger's debt charge: the debt was recorded WITH the claim, and the resume neither charges nor records it twice", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.crashAfter = "chargeDebt";
		await expect(engine.settle("k1", { post: 100, overage: 25 })).rejects.toThrow(
			/died after chargeDebt/,
		);
		expect(journal.debtOf("b"), "recorded with the claim, before any ledger call").toBe(25);
		await engine.settle("k1", { post: 100, overage: 25 });
		expect(ledger.debt.get("b")).toBe(25);
		expect(journal.debtOf("b")).toBe(25);
		await engine.settle("k1", { post: 100, overage: 25 });
		expect(journal.debtOf("b"), "a third attempt changes nothing").toBe(25);
	});
	it("a crash AFTER the debt is recorded and before `settled`: the resume never counts the debt twice", async () => {
		// The window the applied marker exists for: step 3 committed, step 4 never ran.
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		const realCas = journal.cas.bind(journal);
		let died = false;
		journal.cas = (holdId, from, to, set) => {
			if (!died && from === "settling" && to === "settled") {
				died = true;
				throw new Error("process died before settled");
			}
			return realCas(holdId, from, to, set);
		};
		await expect(engine.settle("k1", { post: 100, overage: 25 })).rejects.toThrow(
			/died before settled/,
		);
		expect(journal.debtOf("b"), "step 3 committed").toBe(25);
		expect(await engine.settle("k1", { post: 100, overage: 25 })).toEqual({
			outcome: "settled",
			resumed: true,
		});
		expect(journal.debtOf("b"), "the resume re-applied nothing").toBe(25);
		expect(ledger.debt.get("b")).toBe(25);
	});

	it("the ledger expired the hold before the post: the one terminal is `expired`, and the actual amount is LATE-SETTLED to debt — never a post", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.expired.add("k1");
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toEqual({
			outcome: "late_settled",
			state: "expired",
			resumed: false,
		});
		expect(journal.get("k1")).toMatchObject({
			state: "expired",
			terminalKind: "hold_expired_unsettled",
			lateAmount: 60,
			lateState: "charged",
		});
		expect(ledger.count("k1", "post")).toBe(0);
		expect(ledger.applied.get(transferIdFor("k1", "late").toString())).toBe(60);
		expect(journal.debtOf("b")).toBe(60);
	});
	it("after the sweeper's claim, a settlement takes the late path: never a post, the actual amount late-settled once", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toEqual({
			outcome: "late_settled",
			state: "expiring",
			resumed: false,
		});
		expect(ledger.count("k1", "post")).toBe(0);
		expect(journal.get("k1")).toMatchObject({ lateAmount: 60, lateState: "charged" });
		// A duplicate acts on the STORED amount: no second charge.
		expect(await engine.settle("k1", { post: 99, overage: 0 })).toEqual({
			outcome: "late_settled",
			state: "expiring",
			resumed: true,
		});
		expect(ledger.applied.get(transferIdFor("k1", "late").toString())).toBe(60);
		expect(journal.debtOf("b")).toBe(60);
	});
	it("a settlement against a voided or unknown hold is an incident with no ledger operation", async () => {
		const { ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await engine.release("k1");
		expect(await engine.settle("k1", { post: 10, overage: 0 })).toEqual({
			outcome: "incident",
			state: "voided",
		});
		expect(await engine.settle("nope", { post: 10, overage: 0 })).toEqual({
			outcome: "incident",
			state: "missing",
		});
		expect(ledger.count("k1", "post")).toBe(0);
	});
});

describe("hold engine: release (a non-2xx response)", () => {
	it("voids an open hold once; a release of a settled hold does nothing", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		expect(await engine.release("k1")).toEqual({ outcome: "voided" });
		expect(ledger.count("k1", "void")).toBe(1);
		expect(journal.get("k1")).toMatchObject({ state: "voided", terminalKind: "voided" });
		await engine.reserve({ holdKey: "k2", budgetId: "b", amount: 100 });
		await engine.settle("k2", { post: 10, overage: 0 });
		expect(await engine.release("k2")).toEqual({ outcome: "not_open", state: "settled" });
		expect(ledger.count("k2", "void")).toBe(0);
	});
	it("a hold the ledger already expired is still released (nothing was charged), and says so", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.expired.add("k1");
		expect(await engine.release("k1")).toEqual({ outcome: "voided" });
		expect(journal.get("k1")).toMatchObject({ state: "voided", terminalKind: "voided_expired" });
	});
	it("a void that finds NO transfer before the placement horizon stays in flight; past it, the hold is voided_not_found", async () => {
		const { journal, ledger, engine, clock } = setup();
		ledger.hang = "placeHold";
		await expect(engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 })).rejects.toThrow();
		ledger.hang = null;
		expect(await engine.release("k1"), "an abandoned placement may still land").toEqual({
			outcome: "in_flight",
		});
		expect(journal.get("k1")?.state).toBe("voiding");
		clock.now = 1_000 + 900_000 + 100 + GRACE; // ttlAt + grace
		expect(await engine.release("k1")).toEqual({ outcome: "voided" });
		expect(journal.get("k1")).toMatchObject({ state: "voided", terminalKind: "voided_not_found" });
	});
	it("the late placement LANDS before the re-void: the next release voids the real transfer", async () => {
		const { journal, ledger, engine } = setup();
		ledger.hang = "placeHold";
		await expect(engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 })).rejects.toThrow();
		ledger.hang = null;
		expect(await engine.release("k1")).toEqual({ outcome: "in_flight" });
		await ledger.placeHold({ budgetId: "b", holdKey: "k1", amount: 10 }); // it landed
		expect(await engine.release("k1")).toEqual({ outcome: "voided" });
		expect(journal.get("k1")).toMatchObject({ state: "voided", terminalKind: "voided" });
		expect(ledger.count("k1", "void")).toBe(1);
	});
	it("a void the ledger answers as POSTED is an incident: no void, the row left for an operator", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await ledger.post({ holdKey: "k1", amount: 10 });
		expect(await engine.release("k1")).toEqual({ outcome: "incident", state: "voiding" });
		expect(journal.get("k1")?.state).toBe("voiding");
		expect(ledger.count("k1", "void")).toBe(0);
	});
});

describe("#174 r1: the three unbilled-cost paths", () => {
	it("P1 admission: a retry after the EARLIEST ledger expiry (admitBy) and before ttlAt is refused hold_expired", async () => {
		const { journal, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 });
		expect(journal.get("k1")).toMatchObject({
			admitBy: 1_000 + 900_000,
			ttlAt: 1_000 + 900_000 + 100, // placeBy (start + one deadline) + one deadline + lifetime
		});
		clock.now = 1_000 + 900_000 + 10; // the ledger may already have released it
		expect(await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 })).toEqual({
			admitted: false,
			reason: "hold_expired",
		});
	});

	it("P1 budget id: an id the debt account cannot be named for is refused BEFORE anything is placed", async () => {
		const { journal, ledger, engine } = setup();
		await expect(
			engine.reserve({ holdKey: "k1", budgetId: "team::a", amount: 10 }),
		).rejects.toBeInstanceOf(BudgetIdError);
		expect(ledger.count("k1", "reserve")).toBe(0);
		expect(journal.get("k1")).toBeUndefined();
	});

	it("P1 retired post id: an outcome the read-back cannot confirm leaves the hold `settling` (in flight), never a throw; a confirmed expiry then routes it to late settlement", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.postAnswer = "unknown";
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toEqual({ outcome: "in_flight" });
		expect(journal.get("k1")?.state).toBe("settling");
		ledger.postAnswer = "expired"; // the read-back confirms it later
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toEqual({
			outcome: "late_settled",
			state: "expired",
			resumed: true,
		});
	});

	it("a post the ledger answers as voided or never placed is an incident, the row left `settling`", async () => {
		for (const answer of ["voided", "not_found"] as const) {
			const { journal, ledger, engine } = setup();
			await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
			ledger.postAnswer = answer;
			expect(await engine.settle("k1", { post: 60, overage: 0 }), answer).toEqual({
				outcome: "incident",
				state: "settling",
			});
			expect(journal.get("k1")?.state, answer).toBe("settling");
		}
	});

	it("P1 retired void id: an inconclusive read-back leaves the hold `voiding` (in flight), never a throw", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.releaseAnswer = "unknown";
		expect(await engine.release("k1")).toEqual({ outcome: "in_flight" });
		expect(journal.get("k1")?.state).toBe("voiding");
	});
});

describe("#174 r1 connector: the overage's debt blocks reservations from the moment it is known", () => {
	it("a reservation in the gap between the claim and the ledger's debt charge sees the debt (no admission past the budget)", async () => {
		const { journal, ledger, engine } = setup(200);
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		let open!: () => void;
		ledger.chargeGate = new Promise<void>((r) => {
			open = r;
		});
		const settling = engine.settle("k1", { post: 100, overage: 50 });
		await new Promise((r) => setTimeout(r, 10)); // the charge is in flight
		expect(journal.debtOf("b")).toBe(50);
		// 100 available − 50 debt < 100: refused (it was admitted while the debt was unrecorded).
		expect(await engine.reserve({ holdKey: "k2", budgetId: "b", amount: 100 })).toEqual({
			admitted: false,
			reason: "budget_exceeded",
		});
		open();
		expect(await settling).toEqual({ outcome: "settled", resumed: false });
		expect(journal.debtOf("b")).toBe(50);
		expect(ledger.debt.get("b")).toBe(50);
	});

	it("a confirmed expiry reverses the overage debt recorded with the claim (never charged as overage) and records the full actual as the LATE debt, once", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.expired.add("k1");
		expect(await engine.settle("k1", { post: 100, overage: 30 })).toEqual({
			outcome: "late_settled",
			state: "expired",
			resumed: false,
		});
		expect(journal.debtOf("b"), "overage 30 reversed, late 130 recorded").toBe(130);
		expect(ledger.count("k1", "overage")).toBe(0);
		expect(ledger.applied.get(transferIdFor("k1", "late").toString())).toBe(130);
		expect(await engine.settle("k1", { post: 100, overage: 30 })).toMatchObject({
			outcome: "late_settled",
			resumed: true,
		});
		expect(journal.debtOf("b"), "a repeat changes nothing").toBe(130);
		expect(ledger.applied.get(transferIdFor("k1", "late").toString())).toBe(130);
	});
});

describe("#174 r2: every account a settlement touches is ensured before placement; one shared placement deadline", () => {
	it("a debt account the ledger refuses refuses the RESERVATION — nothing placed, no row", async () => {
		const { journal, ledger, engine } = setup();
		ledger.debtAccountRefusal = new Error("exists_with_different_flags");
		await expect(engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 })).rejects.toThrow(
			/exists_with_different_flags/,
		);
		expect(ledger.count("k1", "reserve")).toBe(0);
		expect(journal.get("k1")).toBeUndefined();
	});

	it("the debt account is ensured before the placement on every reservation", async () => {
		const { ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 });
		expect(ledger.ensuredDebt).toEqual(["b"]);
		expect(ledger.count("k1", "reserve")).toBe(1);
	});

	it("a placement that would START after the shared window (a slow balance lookup ate it) is not placed: ttlAt stays an upper bound", async () => {
		const { journal, ledger, engine, clock } = setup();
		ledger.onAvailable = () => {
			clock.now += 51; // past placeBy (start + 50)
		};
		await expect(
			engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 }),
		).rejects.toBeInstanceOf(PlacementWindowError);
		expect(ledger.count("k1", "reserve"), "nothing placed").toBe(0);
		expect(journal.get("k1")?.state, "the release path finalizes it").toBe("voiding");
	});

	it("control: a balance lookup inside the window still places", async () => {
		const { ledger, engine, clock } = setup();
		ledger.onAvailable = () => {
			clock.now += 50; // exactly at placeBy
		};
		expect(await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 })).toEqual({
			admitted: true,
			existing: false,
		});
	});
});

describe("#174 r3: the caller's objects are snapshotted before any await", () => {
	it("a reservation whose caller mutates budgetId and amount while the ensure is pending: the ensure, the row and the placement all use the ORIGINAL values", async () => {
		const { journal, ledger, engine } = setup(1_000);
		ledger.balances.set("other", 1_000);
		const p = { holdKey: "k1", budgetId: "b", amount: 10 };
		ledger.onEnsure = () => {
			p.budgetId = "other";
			p.amount = 999;
		};
		expect(await engine.reserve(p)).toEqual({ admitted: true, existing: false });
		expect(ledger.ensuredDebt).toEqual(["b"]);
		expect(journal.get("k1")).toMatchObject({ budgetId: "b", amount: 10 });
		expect(ledger.applied.get(transferIdFor("k1", "reserve").toString())).toBe(10);
		expect(ledger.balances.get("b"), "placed on the original budget").toBe(990);
		expect(ledger.balances.get("other")).toBe(1_000);
	});

	it("a settlement whose caller mutates the intent's overage mid-post: the ledger charge equals the debt recorded with the claim", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		const intent = { post: 100, overage: 25 };
		ledger.onPost = () => {
			intent.overage = 500;
			intent.post = 1;
		};
		expect(await engine.settle("k1", intent)).toEqual({ outcome: "settled", resumed: false });
		expect(journal.debtOf("b")).toBe(25);
		expect(ledger.debt.get("b"), "charged what was recorded").toBe(25);
		expect(ledger.applied.get(transferIdFor("k1", "post").toString())).toBe(100);
	});
});

describe("#176: the settlement intent is validated at the claim", () => {
	const broken: Array<[string, { post: number; overage: number }]> = [
		["post NaN", { post: Number.NaN, overage: 0 }],
		["post negative", { post: -1, overage: 0 }],
		["post fractional", { post: 1.5, overage: 0 }],
		["overage negative", { post: 100, overage: -5 }],
		["overage Infinity", { post: 100, overage: Number.POSITIVE_INFINITY }],
		["post above the hold", { post: 101, overage: 0 }],
		["an overage with the hold not posted in full", { post: 60, overage: 30 }],
	];
	for (const [name, intent] of broken) {
		it(`${name}: refused — the row stays open, nothing posted, no debt`, async () => {
			const { journal, ledger, engine } = setup();
			await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
			await expect(engine.settle("k1", intent)).rejects.toBeInstanceOf(
				InvalidSettlementIntentError,
			);
			expect(journal.get("k1")?.state).toBe("open");
			expect(ledger.count("k1", "post")).toBe(0);
			expect(journal.debtOf("b")).toBe(0);
		});
	}

	it("control: the boundaries pass — post equal to the hold with an overage, and post zero", async () => {
		for (const intent of [
			{ post: 100, overage: 7 },
			{ post: 0, overage: 0 },
		]) {
			const { engine } = setup();
			await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
			expect(await engine.settle("k1", intent), JSON.stringify(intent)).toMatchObject({
				outcome: "settled",
			});
		}
	});

	it("a resume of a `settling` hold acts on its STORED intent: a duplicate caller's intent is not judged", async () => {
		const { engine, ledger } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.crashAfter = "post";
		await expect(engine.settle("k1", { post: 80, overage: 0 })).rejects.toThrow(/died after post/);
		expect(await engine.settle("k1", { post: 999, overage: 0 })).toEqual({
			outcome: "settled",
			resumed: true,
		});
	});

	it("both overage ids retired and nothing charged: TERMINAL — a loud DebtChargeFailedError naming both ids, the row marked (not in flight), and a later settle makes no ledger call", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.chargeAnswer = { failed: true, role: "overage", transferIds: ["111", "222"] };
		const err = await engine.settle("k1", { post: 100, overage: 20 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DebtChargeFailedError);
		expect((err as DebtChargeFailedError).transferIds).toEqual(["111", "222"]);
		expect(String((err as Error).message)).toMatch(/111.*222/);
		expect(journal.get("k1")).toMatchObject({
			state: "settling",
			incident: {
				kind: "debt_charge_failed",
				role: "overage",
				transferIds: ["111", "222"],
				amount: 20,
			},
		});
		expect(
			journal.inFlight().map((r) => r.holdId),
			"never re-reported as in flight",
		).toEqual([]);
		expect(journal.incidents().map((r) => r.holdId)).toEqual(["k1"]);
		expect(journal.debtOf("b"), "admission stays bounded").toBe(20);
		ledger.chargeAnswer = null;
		const posts = ledger.count("k1", "post");
		expect(await engine.settle("k1", { post: 100, overage: 20 })).toEqual({
			outcome: "incident",
			state: "settling",
		});
		expect(ledger.count("k1", "post")).toBe(posts);
		expect(ledger.count("k1", "overage"), "no further charge attempt").toBe(0);
	});
});

describe("#177 r6 (A): EVERY completion — a resume of a stored intent included — passes the intent contract", () => {
	it("a v0 `settling` row written by the pre-validation engine ({post:60, overage:30} on a 100 hold) is migrated, then RESUMED into a terminal invalid_stored_intent incident — no post, no charge, debt unchanged", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openshell-engine-v0-"));
		dirs.push(dir);
		const path = join(dir, "holds.db");
		const raw = new DatabaseSync(path);
		raw.exec("PRAGMA journal_mode = WAL");
		raw.exec(`
			CREATE TABLE hold (
				hold_id TEXT PRIMARY KEY, budget_id TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('open','settling','settled','voiding','voided','expiring','expired')),
				amount INTEGER NOT NULL CHECK (amount > 0), ttl_at INTEGER NOT NULL, admit_by INTEGER NOT NULL,
				intent_json TEXT, terminal_kind TEXT, terminal_event_hash TEXT, reserved_seq INTEGER
			);
			CREATE INDEX hold_state_ttl ON hold (state, ttl_at);
			CREATE TABLE debt (budget_id TEXT PRIMARY KEY, amount INTEGER NOT NULL CHECK (amount >= 0));
			CREATE TABLE applied (transfer_id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, delta INTEGER NOT NULL);
		`);
		raw.exec(
			`INSERT INTO hold (hold_id, budget_id, state, amount, ttl_at, admit_by, intent_json) VALUES ('h1', 'b', 'settling', 100, 2000000, 1900000, '{"post":60,"overage":30}')`,
		);
		raw.exec("INSERT INTO debt (budget_id, amount) VALUES ('b', 30)"); // recorded with the claim
		raw.close();
		const journal = HoldJournal.open(path, { now: () => 1_000, ledgerTimeoutMs: 50 });
		journals.push(journal);
		const ledger = new FakeLedger();
		const engine = new HoldEngine(journal, ledger, { holdTtlSeconds: 900, now: () => 1_000 });
		// A duplicate settlement (any intent) loses the claim and RESUMES the stored one.
		expect(await engine.settle("h1", { post: 100, overage: 0 })).toEqual({
			outcome: "incident",
			state: "settling",
		});
		expect(journal.get("h1")).toMatchObject({
			state: "settling",
			incident: { kind: "invalid_stored_intent", intent: { post: 60, overage: 30 } },
		});
		expect(ledger.count("h1", "post"), "no post").toBe(0);
		expect(ledger.count("h1", "overage"), "no charge").toBe(0);
		expect(journal.debtOf("b"), "recorded debt left as is").toBe(30);
		expect(journal.inFlight()).toEqual([]);
		expect(await engine.settle("h1", { post: 100, overage: 0 })).toEqual({
			outcome: "incident",
			state: "settling",
		});
		expect(ledger.count("h1", "post")).toBe(0);
	});
});

// reserve at t=1,000 → ttlAt = 1,000 + 50 + 50 + 900,000; the sweeper's default grace is 60 s.
const TTL_AT = 1_000 + 100 + 900_000;
const SWEEPABLE = TTL_AT + 60_000 + 1;

describe("1c-1: the late path enforces the same intent contract", () => {
	it("a broken intent on an `expiring` row is refused — nothing recorded, nothing charged, no debt", async () => {
		for (const intent of [
			{ post: 101, overage: 0 },
			{ post: 60, overage: 30 },
			{ post: -1, overage: 0 },
		]) {
			const { journal, ledger, engine } = setup();
			await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
			await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
			await expect(engine.settle("k1", intent), JSON.stringify(intent)).rejects.toBeInstanceOf(
				InvalidSettlementIntentError,
			);
			expect(journal.get("k1"), JSON.stringify(intent)).toMatchObject({
				state: "expiring",
				lateAmount: null,
			});
			expect(ledger.count("k1", "late"), JSON.stringify(intent)).toBe(0);
			expect(journal.debtOf("b"), JSON.stringify(intent)).toBe(0);
		}
	});
});

describe("#185 r1: a zero-cost late settlement is a TERMINAL disposition, not an absence", () => {
	it("{0,0} late-settles as `zero` (no transfer); a later, conflicting {60,0} charges NOTHING and leaves debt unchanged; a duplicate {0,0} is idempotent", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		expect(await engine.settle("k1", { post: 0, overage: 0 })).toEqual({
			outcome: "late_settled",
			state: "expiring",
			resumed: false,
		});
		expect(journal.get("k1")).toMatchObject({ lateState: "zero", lateAmount: 0 });
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toMatchObject({
			outcome: "late_settled",
			resumed: true,
		});
		expect(journal.get("k1")).toMatchObject({ lateState: "zero", lateAmount: 0 });
		expect(ledger.count("k1", "late"), "never charged").toBe(0);
		expect(journal.debtOf("b"), "debt unchanged").toBe(0);
		expect(await engine.settle("k1", { post: 0, overage: 0 })).toMatchObject({ resumed: true });
		expect(journal.lateUncharged()).toEqual([]);
	});

	it("the same through a confirmed expired post: {0,0} records `zero`, and nothing later can charge the hold", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.expired.add("k1");
		expect(await engine.settle("k1", { post: 0, overage: 0 })).toMatchObject({
			outcome: "late_settled",
			state: "expired",
		});
		expect(journal.get("k1")).toMatchObject({ state: "expired", lateState: "zero" });
		await engine.settle("k1", { post: 60, overage: 0 });
		expect(ledger.count("k1", "late")).toBe(0);
		expect(journal.debtOf("b")).toBe(0);
	});
});

describe("#185 r1 P1: `late_settled` only when a late disposition is POSITIVELY recorded", () => {
	it("an expiry incident that lands BETWEEN settleLate's read and its write: the answer is `incident`, the actual cost is attached to it for billing, nothing is charged", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		// A second connection on the same file plays finishExpiry's incident, interleaved.
		const other = HoldJournal.open(join(dirs[dirs.length - 1] as string, "holds.db"), {
			now: () => 1_000,
		});
		journals.push(other);
		const realWriteTx = journal.writeTx.bind(journal);
		let interleaved = false;
		journal.writeTx = (async (fn: () => unknown) => {
			if (!interleaved) {
				interleaved = true;
				await other.writeTx(() =>
					other.recordIncident("k1", { kind: "expiry_ledger_disagrees", voided: "posted" }),
				);
			}
			return realWriteTx(fn as () => never);
		}) as typeof journal.writeTx;
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toEqual({
			outcome: "incident",
			state: "expiring",
		});
		journal.writeTx = realWriteTx;
		expect(journal.get("k1")).toMatchObject({
			lateState: "none",
			incident: {
				kind: "expiry_ledger_disagrees",
				unbilled: [{ kind: "late_settlement", actual: 60, intent: { post: 60, overage: 0 } }],
			},
		});
		expect(ledger.count("k1", "late"), "nothing charged").toBe(0);
		expect(journal.debtOf("b")).toBe(0);
	});

	it("#185 r2 P1: an expiry incident that lands AFTER recordLate commits and BEFORE the charge: the answer is `incident` (one post-charge view), unbilled says the late amount WAS recorded, nothing charged", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		const other = HoldJournal.open(join(dirs[dirs.length - 1] as string, "holds.db"), {
			now: () => 1_000,
		});
		journals.push(other);
		const realWriteTx = journal.writeTx.bind(journal);
		let calls = 0;
		journal.writeTx = (async (fn: () => unknown) => {
			const out = await realWriteTx(fn as () => never);
			calls += 1;
			if (calls === 2) {
				// Transaction 1 is settle's claim (lost to `expiring`); transaction 2 is recordLate's,
				// which has just COMMITTED — finishExpiry's incident lands now, before the charge.
				await other.writeTx(() =>
					other.recordIncident("k1", { kind: "expiry_ledger_disagrees", voided: "posted" }),
				);
			}
			return out;
		}) as typeof journal.writeTx;
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toEqual({
			outcome: "incident",
			state: "expiring",
		});
		journal.writeTx = realWriteTx;
		expect(journal.get("k1")).toMatchObject({
			lateState: "recorded",
			lateAmount: 60,
			incident: {
				kind: "expiry_ledger_disagrees",
				unbilled: [{ kind: "late_settlement", actual: 60, lateRecorded: true }],
			},
		});
		expect(ledger.count("k1", "late"), "never charged").toBe(0);
		expect(journal.debtOf("b"), "the recorded debt keeps admission bounded").toBe(60);
	});

	it("a settlement arriving at a row that ALREADY carries an incident: `incident`, the cost attached once", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		await journal.writeTx(() => journal.recordIncident("k1", { kind: "expiry_ledger_disagrees" }));
		expect(await engine.settle("k1", { post: 40, overage: 0 })).toEqual({
			outcome: "incident",
			state: "expiring",
		});
		// #188.2: a second, CONFLICTING lost settlement is APPENDED — never dropped — and an
		// identical retry of either is not appended twice.
		await engine.settle("k1", { post: 99, overage: 0 });
		await engine.settle("k1", { post: 40, overage: 0 });
		await engine.settle("k1", { post: 99, overage: 0 });
		const unbilled = (journal.get("k1")?.incident as { unbilled: unknown[] } | undefined)?.unbilled;
		expect(unbilled).toHaveLength(2);
		expect(unbilled).toMatchObject([
			{ actual: 40, intent: { post: 40 } },
			{ actual: 99, intent: { post: 99 } },
		]);
		expect(ledger.count("k1", "late")).toBe(0);
	});

	it("#185 r1: an intent whose post + overage is not a safe integer is refused at the claim — the row stays open", async () => {
		const { journal, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await expect(
			engine.settle("k1", { post: 100, overage: Number.MAX_SAFE_INTEGER }),
		).rejects.toBeInstanceOf(InvalidSettlementIntentError);
		expect(journal.get("k1")?.state).toBe("open");
	});
});

describe("#185 r3: an INCIDENT OUTRANKS EVERY SUCCESS — every outcome, one final view, the incident first", () => {
	/** A second connection on the same file: the "concurrent" writer of the incident. */
	const otherOn = () => {
		const other = HoldJournal.open(join(dirs[dirs.length - 1] as string, "holds.db"), {
			now: () => 1_000,
		});
		journals.push(other);
		return (holdId: string) =>
			other.writeTx(() => other.recordIncident(holdId, { kind: "concurrent_incident" }));
	};

	it("R1 (the connector's window): the incident lands AFTER the ledger took the late charge and BEFORE it was marked — `incident`, the charge recorded on the incident (never lost), charged once", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		const incident = otherOn();
		const realCharge = ledger.chargeDebt.bind(ledger);
		ledger.chargeDebt = async (p) => {
			const out = await realCharge(p);
			await incident("k1"); // the ledger has the charge; the row turns incident now
			return out;
		};
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toEqual({
			outcome: "incident",
			state: "expiring",
		});
		expect(journal.get("k1")).toMatchObject({
			lateState: "recorded", // markLateCharged never moves an incident row
			incident: {
				kind: "concurrent_incident",
				late_charged_on_ledger: 60,
				unbilled: [{ actual: 60, lateRecorded: true, lateCharged: true }],
			},
		});
		expect(ledger.applied.get(transferIdFor("k1", "late").toString()), "charged once").toBe(60);
		expect(journal.lateUncharged(), "never charged again").toEqual([]);
	});

	it("R6: an incident that lands AFTER the late charge was MARKED (a `charged` row) still outranks the success — `incident`, lateCharged true", async () => {
		const { journal, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		const incident = otherOn();
		const realWriteTx = journal.writeTx.bind(journal);
		let calls = 0;
		journal.writeTx = (async (fn: () => unknown) => {
			const out = await realWriteTx(fn as () => never);
			calls += 1;
			// 1 the claim (lost to expiring), 2 recordLate, 3 markLateCharged — then the incident.
			if (calls === 3) await incident("k1");
			return out;
		}) as typeof journal.writeTx;
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toEqual({
			outcome: "incident",
			state: "expiring",
		});
		journal.writeTx = realWriteTx;
		expect(journal.get("k1")).toMatchObject({
			lateState: "charged",
			incident: { unbilled: [{ lateRecorded: true, lateCharged: true }] },
		});
	});

	it("R7: an incident that lands after a ZERO disposition still outranks it — `incident`, not late_settled", async () => {
		const { journal, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		const incident = otherOn();
		const realWriteTx = journal.writeTx.bind(journal);
		let calls = 0;
		journal.writeTx = (async (fn: () => unknown) => {
			const out = await realWriteTx(fn as () => never);
			calls += 1;
			if (calls === 2) await incident("k1"); // after recordLate recorded `zero`
			return out;
		}) as typeof journal.writeTx;
		expect(await engine.settle("k1", { post: 0, overage: 0 })).toEqual({
			outcome: "incident",
			state: "expiring",
		});
		journal.writeTx = realWriteTx;
		expect(journal.get("k1")).toMatchObject({
			lateState: "zero",
			incident: { unbilled: [{ actual: 0, lateRecorded: true, lateCharged: false }] },
		});
	});

	it("R2: the journal's CAS never moves a row carrying an incident", async () => {
		const { journal, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.recordIncident("k1", { kind: "x" }));
		expect(await journal.writeTx(() => journal.cas("k1", "open", "settling"))).toBe(false);
		expect(journal.get("k1")?.state).toBe("open");
	});

	it("R3: completeSettlement — an incident that lands after the POST is `incident`, never `settled`", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		const incident = otherOn();
		const realPost = ledger.post.bind(ledger);
		ledger.post = async (p) => {
			const out = await realPost(p);
			await incident("k1");
			return out;
		};
		expect(await engine.settle("k1", { post: 40, overage: 0 })).toEqual({
			outcome: "incident",
			state: "settling",
		});
		expect(journal.get("k1")?.state).toBe("settling");
	});

	it("R4/R5: finishExpiry and release — an incident between the void and the final transition is reported as an incident, never expired / voided", async () => {
		const exp = setup();
		await exp.engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		exp.ledger.expired.add("k1");
		const expIncident = otherOn();
		const realRelease = exp.ledger.release.bind(exp.ledger);
		exp.ledger.release = async (p) => {
			const out = await realRelease(p);
			await expIncident("k1");
			return out;
		};
		exp.clock.now = SWEEPABLE;
		expect(await exp.engine.sweep()).toMatchObject({ expired: [], incidents: ["k1"] });
		expect(exp.journal.get("k1")?.state).toBe("expiring");

		const rel = setup();
		await rel.engine.reserve({ holdKey: "k2", budgetId: "b", amount: 100 });
		const relIncident = otherOn();
		const realRelease2 = rel.ledger.release.bind(rel.ledger);
		rel.ledger.release = async (p) => {
			const out = await realRelease2(p);
			await relIncident("k2");
			return out;
		};
		expect(await rel.engine.release("k2")).toEqual({ outcome: "incident", state: "voiding" });
		expect(rel.journal.get("k2")?.state).toBe("voiding");
	});
});

describe("1c-1: the sweeper", () => {
	it("expires an `open` hold only PAST ttlAt + grace, by the ledger's answer (`expired`, hold_expired_unsettled), and writes its heartbeat", async () => {
		const { journal, ledger, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		clock.now = TTL_AT + 60_000; // not yet past the grace
		expect((await engine.sweep()).expired).toEqual([]);
		expect(journal.get("k1")?.state).toBe("open");
		expect(journal.heartbeat()).toBe(TTL_AT + 60_000);
		ledger.expired.add("k1");
		clock.now = SWEEPABLE;
		expect((await engine.sweep()).expired).toEqual(["k1"]);
		expect(journal.get("k1")).toMatchObject({
			state: "expired",
			terminalKind: "hold_expired_unsettled",
		});
		expect(ledger.count("k1", "post")).toBe(0);
	});

	it("a settlement that claimed first wins: the sweeper's CAS loses and does nothing", async () => {
		const { journal, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await engine.settle("k1", { post: 40, overage: 0 });
		clock.now = SWEEPABLE;
		expect((await engine.sweep()).expired).toEqual([]);
		expect(journal.get("k1")?.state).toBe("settled");
	});

	it("a void the ledger answers POSTED or NOT FOUND for an expiring hold is a terminal incident, never `expired`", async () => {
		for (const answer of ["posted", "not_found"] as const) {
			const { journal, ledger, engine, clock } = setup();
			await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
			ledger.releaseAnswer = answer;
			clock.now = SWEEPABLE;
			await engine.sweep();
			expect(journal.get("k1"), answer).toMatchObject({
				state: "expiring",
				incident: { kind: "expiry_ledger_disagrees", voided: answer },
			});
		}
	});

	it("#185 r1: the sweep REPORTS what the ledger answered — a void answered posted is under `incidents`, never `expired`; an unconfirmed one under `inFlight`", async () => {
		const posted = setup();
		await posted.engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		posted.ledger.releaseAnswer = "posted";
		posted.clock.now = SWEEPABLE;
		expect(await posted.engine.sweep()).toMatchObject({
			expired: [],
			incidents: ["k1"],
			inFlight: [],
		});
		const unsure = setup();
		await unsure.engine.reserve({ holdKey: "k2", budgetId: "b", amount: 100 });
		unsure.ledger.releaseAnswer = "unknown";
		unsure.clock.now = SWEEPABLE;
		expect(await unsure.engine.sweep()).toMatchObject({
			expired: [],
			incidents: [],
			inFlight: ["k2"],
		});
	});

	it("an unconfirmed void leaves the hold `expiring` (in flight); the next sweep finishes it", async () => {
		const { journal, ledger, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.releaseAnswer = "unknown";
		clock.now = SWEEPABLE;
		await engine.sweep();
		expect(journal.get("k1")?.state).toBe("expiring");
		ledger.releaseAnswer = "expired";
		expect((await engine.sweep()).replayed).toEqual([{ holdId: "k1", outcome: "expired" }]);
		expect(journal.get("k1")?.state).toBe("expired");
	});

	it("REPLAY: a `settling` row whose winner crashed after the post is completed by the sweep, from its stored intent", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.crashAfter = "post";
		await expect(engine.settle("k1", { post: 70, overage: 0 })).rejects.toThrow(/died after post/);
		expect((await engine.sweep()).replayed).toEqual([{ holdId: "k1", outcome: "settled" }]);
		expect(journal.get("k1")?.state).toBe("settled");
		expect(ledger.applied.get(transferIdFor("k1", "post").toString())).toBe(70);
	});

	it("REPLAY never resumes a row carrying an INCIDENT", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.chargeAnswer = { failed: true, role: "overage", transferIds: ["1", "2"] };
		await expect(engine.settle("k1", { post: 100, overage: 10 })).rejects.toThrow();
		ledger.chargeAnswer = null;
		const posts = ledger.count("k1", "post");
		const report = await engine.sweep();
		expect(report.replayed).toEqual([]);
		expect(ledger.count("k1", "post")).toBe(posts);
		expect(journal.get("k1")?.incident).not.toBeNull();
	});

	it("REPLAY: a late settlement whose charge landed but was never marked is completed — charged once", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		ledger.crashAfter = "chargeDebt";
		await expect(engine.settle("k1", { post: 60, overage: 0 })).rejects.toThrow(
			/died after chargeDebt/,
		);
		expect(journal.get("k1")).toMatchObject({ lateAmount: 60, lateState: "recorded" });
		expect(journal.lateUncharged().map((r) => r.holdId)).toEqual(["k1"]);
		const report = await engine.sweep();
		expect(report.lateCharged).toEqual(["k1"]);
		expect(journal.get("k1")).toMatchObject({ lateAmount: 60, lateState: "charged" });
		expect(ledger.debt.get("b"), "charged once").toBe(60);
	});

	it("one row whose step THROWS is reported and the sweep goes on: the next row is still expired", async () => {
		const { journal, ledger, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await engine.reserve({ holdKey: "k2", budgetId: "b", amount: 100 });
		ledger.releaseThrows.add("k1");
		ledger.expired.add("k2");
		clock.now = SWEEPABLE;
		const report = await engine.sweep();
		expect(report.errors.map((e) => e.holdId)).toEqual(["k1"]);
		expect(report.expired).toEqual(["k2"]);
		expect(journal.get("k1")?.state, "claimed; finished by a later sweep").toBe("expiring");
	});
});

describe("1c-1: the independent detector", () => {
	const detector = (journal: HoldJournal, clock: { now: number }) =>
		new HoldDetector(journal, { sweepIntervalMs: 30_000, now: () => clock.now });

	it("#185 r1: its numbers are validated as the engine's are — NaN, Infinity or a negative grace, or a non-positive / non-finite interval, is refused at construction", () => {
		const { journal, clock } = setup();
		for (const g of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
			expect(
				() =>
					new HoldDetector(journal, {
						sweepIntervalMs: 30_000,
						expiryGraceMs: g,
						now: () => clock.now,
					}),
				String(g),
			).toThrow(TypeError);
		}
		for (const i of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
			expect(() => new HoldDetector(journal, { sweepIntervalMs: i }), String(i)).toThrow(TypeError);
		}
	});

	it("#185 r2: the sweep interval is SNAPSHOTTED at construction — a caller mutating its opts afterwards changes nothing", async () => {
		const { journal, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await engine.sweep(); // heartbeat at t = 1,000
		const opts = { sweepIntervalMs: 30_000, now: () => clock.now };
		const d = new HoldDetector(journal, opts);
		opts.sweepIntervalMs = Number.NaN; // would make BOTH thresholds NaN if read live
		clock.now = TTL_AT + 60_000 + 60_001; // past the overdue bound; the heartbeat long stale
		const r = d.check();
		if (!r.readable) throw new Error("readable");
		// Both uses of the interval: the stale-heartbeat check AND the overdue threshold.
		expect(r.incidents.map((i) => i.kind)).toEqual(["sweeper_stale", "open_overdue"]);
	});

	it("an EMPTY journal with a fresh heartbeat reads as readable, zero incidents — distinct from an unreadable one", async () => {
		const { journal, engine, clock } = setup();
		await engine.sweep();
		expect(detector(journal, clock).check()).toEqual({
			readable: true,
			incidents: [],
			counts: { open: 0, inFlight: 0, lateUncharged: 0, rowIncidents: 0 },
		});
	});

	it("an UNREADABLE journal is `readable: false` — never zero counts", () => {
		const { journal, clock } = setup();
		journals.splice(journals.indexOf(journal), 1);
		journal.close();
		const r = detector(journal, clock).check();
		expect(r.readable).toBe(false);
		expect(r).not.toHaveProperty("counts");
	});

	it("a sweeper that never ran, or whose heartbeat is stale, is an incident", async () => {
		const { journal, engine, clock } = setup();
		expect(detector(journal, clock).check()).toMatchObject({
			incidents: [{ kind: "sweeper_never_ran" }],
		});
		await engine.sweep();
		clock.now += 60_001; // > 2 intervals
		expect(detector(journal, clock).check()).toMatchObject({
			incidents: [{ kind: "sweeper_stale", ageMs: 60_001 }],
		});
	});

	it("a hold that is merely SWEEPABLE (past ttlAt + grace, within two sweep intervals) is not overdue — no false incident", async () => {
		const { journal, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		clock.now = SWEEPABLE + 59_000; // < ttlAt + grace + 2 × 30 s
		await journal.writeTx(() => journal.recordHeartbeat(clock.now));
		expect(detector(journal, clock).check()).toEqual({
			readable: true,
			incidents: [],
			counts: { open: 0, inFlight: 0, lateUncharged: 0, rowIncidents: 0 },
		});
	});

	it("with the sweeper DISABLED, an overdue `open` hold is an incident (not just stale)", async () => {
		const { journal, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		clock.now = TTL_AT + 60_000 + 60_001;
		const r = detector(journal, clock).check();
		expect(r).toMatchObject({ readable: true });
		if (!r.readable) throw new Error("readable");
		expect(r.incidents).toContainEqual({ kind: "open_overdue", holdIds: ["k1"] });
	});

	it("with the sweeper's WRITES FAILING, the detector still raises: no fresh heartbeat, the hold overdue", async () => {
		const { journal, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await engine.sweep(); // one good heartbeat at t=1,000
		const realWriteTx = journal.writeTx.bind(journal);
		journal.writeTx = (() => Promise.reject(new Error("disk full"))) as typeof journal.writeTx;
		clock.now = TTL_AT + 60_000 + 60_001;
		await expect(engine.sweep()).rejects.toThrow(/disk full/);
		journal.writeTx = realWriteTx;
		const r = detector(journal, clock).check();
		if (!r.readable) throw new Error("readable");
		expect(r.incidents.map((i) => i.kind)).toEqual(["sweeper_stale", "open_overdue"]);
	});

	it("an overdue in-flight row, an overdue uncharged late settlement, and every row incident are each reported", async () => {
		const { journal, ledger, engine, clock } = setup();
		await engine.reserve({ holdKey: "s", budgetId: "b", amount: 100 });
		await engine.reserve({ holdKey: "l", budgetId: "b", amount: 100 });
		await engine.reserve({ holdKey: "i", budgetId: "b", amount: 100 });
		ledger.crashAfter = "post"; // s: stuck `settling`
		await expect(engine.settle("s", { post: 10, overage: 0 })).rejects.toThrow();
		await journal.writeTx(() => journal.cas("l", "open", "expiring"));
		ledger.crashAfter = "chargeDebt"; // l: late recorded, its charge never marked
		await expect(engine.settle("l", { post: 20, overage: 0 })).rejects.toThrow();
		ledger.chargeAnswer = { failed: true, role: "overage", transferIds: ["1", "2"] };
		await expect(engine.settle("i", { post: 100, overage: 5 })).rejects.toThrow();
		// The sweeper is alive (a fresh heartbeat) but has not resolved these: no sweep runs.
		clock.now = TTL_AT + 60_000 + 60_001;
		await journal.writeTx(() => journal.recordHeartbeat(clock.now));
		const r = detector(journal, clock).check();
		if (!r.readable) throw new Error("readable");
		const sortIds = (i: (typeof r.incidents)[number]) =>
			"holdIds" in i ? { ...i, holdIds: [...i.holdIds].sort() } : i;
		// `l` is `expiring` (in flight) AND carries an uncharged late settlement: both readings.
		expect(r.incidents.map(sortIds)).toEqual([
			{ kind: "in_flight_overdue", holdIds: ["l", "s"] },
			{ kind: "late_uncharged_overdue", holdIds: ["l"] },
			{
				kind: "row_incident",
				holdId: "i",
				incident: expect.objectContaining({ kind: "debt_charge_failed" }),
			},
		]);
		expect(r.counts).toEqual({ open: 0, inFlight: 2, lateUncharged: 1, rowIncidents: 1 });
	});
});

describe("#188.2: unbilled is a LIST — every different lost settlement kept", () => {
	it("an incident carrying a single-object `unbilled` (earlier code) is read as a one-element list: a conflicting settlement is appended after it", async () => {
		const { journal, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		await journal.writeTx(() =>
			journal.recordIncident("k1", {
				kind: "expiry_ledger_disagrees",
				unbilled: { kind: "late_settlement", intent: { post: 10, overage: 0 }, actual: 10 },
			}),
		);
		await engine.settle("k1", { post: 70, overage: 0 });
		expect(
			(journal.get("k1")?.incident as { unbilled: unknown } | undefined)?.unbilled,
		).toMatchObject([{ actual: 10 }, { actual: 70 }]);
	});
});

describe("#188 (#185 LOW r4): the sweep probes the ledger for a late charge on an incident row", () => {
	it("a charge that LANDED, its mark lost (a crash), on a row that took an incident: the probe writes it onto the incident — probed once, never charged again", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		ledger.crashAfter = "chargeDebt"; // the late charge lands, then the process dies
		await expect(engine.settle("k1", { post: 60, overage: 0 })).rejects.toThrow(/died/);
		expect(journal.get("k1")).toMatchObject({ lateState: "recorded" });
		await journal.writeTx(() => journal.recordIncident("k1", { kind: "expiry_ledger_disagrees" }));
		expect((await engine.sweep()).lateProbed).toEqual([{ holdId: "k1", landed: true }]);
		expect(journal.get("k1")?.incident).toMatchObject({ late_charged_on_ledger: 60 });
		await engine.sweep();
		expect(ledger.probes, "probed once: a landed charge is final").toEqual(["k1"]);
		expect(ledger.count("k1", "late")).toBe(1);
	});

	it("a charge that never landed: the probe records WHEN it was absent, and probes again every sweep", async () => {
		const { journal, ledger, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		ledger.chargeGate = new Promise(() => {}); // the charge never completes
		await expect(engine.settle("k1", { post: 60, overage: 0 })).rejects.toThrow();
		ledger.chargeGate = null;
		await journal.writeTx(() => journal.recordIncident("k1", { kind: "expiry_ledger_disagrees" }));
		expect((await engine.sweep()).lateProbed).toEqual([{ holdId: "k1", landed: false }]);
		expect(journal.get("k1")?.incident).toMatchObject({ late_absent_from_ledger_at: clock.now });
		clock.now += 5_000;
		await engine.sweep();
		expect(journal.get("k1")?.incident).toMatchObject({ late_absent_from_ledger_at: clock.now });
		expect(ledger.probes).toEqual(["k1", "k1"]);
		expect(ledger.count("k1", "late"), "a probe never charges").toBe(0);
	});
});

describe("#188 (#185 connector): a DEFINITIVE ledger answer contradicting the claim is RECORDED as an incident", () => {
	for (const answer of ["voided", "not_found"] as const) {
		it(`the post answers \`${answer}\`: an incident recorded with the answer and the intent — the sweep never replays it, the detector raises it`, async () => {
			const { journal, ledger, engine, clock } = setup();
			await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
			let posts = 0;
			ledger.onPost = () => {
				posts++;
			};
			ledger.postAnswer = answer;
			expect(await engine.settle("k1", { post: 40, overage: 0 })).toEqual({
				outcome: "incident",
				state: "settling",
			});
			expect(journal.get("k1")?.incident).toEqual({
				kind: "settlement_ledger_disagrees",
				ledgerAnswer: answer,
				intent: { post: 40, overage: 0 },
			});
			await engine.sweep();
			expect(posts, "never replayed").toBe(1);
			const det = new HoldDetector(journal, {
				sweepIntervalMs: 10_000,
				now: () => clock.now,
			}).check();
			expect(det.readable && det.incidents.map((i) => i.kind)).toContain("row_incident");
		});
	}

	it("the release answers `posted`: an incident recorded — never voided, never replayed", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.releaseAnswer = "posted";
		expect(await engine.release("k1")).toEqual({ outcome: "incident", state: "voiding" });
		expect(journal.get("k1")?.incident).toEqual({
			kind: "release_ledger_disagrees",
			ledgerAnswer: "posted",
		});
		expect(journal.inFlight()).toEqual([]);
	});
});
