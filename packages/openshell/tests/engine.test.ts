// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HoldEngine } from "../src/engine.js";
import { HoldJournal, LedgerDeadlineError } from "../src/journal.js";
import {
	BudgetIdError,
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
	/** While set, chargeDebt waits on it: the gap between the claim and the ledger charge. */
	chargeGate: Promise<void> | null = null;
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
	/** Like the TigerBeetle port: the hold's OWN reserve amount is added back. */
	async available(budgetId: string, holdKey: string): Promise<number> {
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
		if (this.postAnswer !== null) return this.postAnswer;
		if (this.expired.has(p.holdKey)) return "expired";
		this.once(transferIdFor(p.holdKey, "post"), p.amount);
		this.crash("post");
		return "done";
	}
	async release(p: { holdKey: string }): Promise<VoidOutcome> {
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
	}): Promise<void> {
		if (this.chargeGate !== null) await this.chargeGate;
		if (this.once(transferIdFor(p.holdKey, p.role), p.amount)) {
			this.debt.set(p.budgetId, (this.debt.get(p.budgetId) ?? 0) + p.amount);
		}
		this.crash("chargeDebt");
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
			ttlAt: 1_000 + 900_000 + 50,
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

	it("the ledger expired the hold before the post: the one terminal is `expired`, and late settlement is required", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.expired.add("k1");
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toEqual({
			outcome: "late_required",
			state: "expired",
		});
		expect(journal.get("k1")).toMatchObject({
			state: "expired",
			terminalKind: "hold_expired_unsettled",
		});
		expect(ledger.count("k1", "post")).toBe(0);
	});
	it("after the sweeper's claim, a settlement takes the late path and never posts", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toEqual({
			outcome: "late_required",
			state: "expiring",
		});
		expect(ledger.count("k1", "post")).toBe(0);
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
		clock.now = 1_000 + 900_000 + 50 + GRACE; // ttlAt + grace
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
			ttlAt: 1_000 + 900_000 + 50,
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
			outcome: "late_required",
			state: "expired",
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

	it("a confirmed expiry reverses the overage debt recorded with the claim (it was never charged), once", async () => {
		const { journal, ledger, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.expired.add("k1");
		expect(await engine.settle("k1", { post: 100, overage: 30 })).toEqual({
			outcome: "late_required",
			state: "expired",
		});
		expect(journal.debtOf("b")).toBe(0);
		expect(ledger.count("k1", "overage")).toBe(0);
		expect(await engine.settle("k1", { post: 100, overage: 30 })).toMatchObject({
			outcome: "late_required",
		});
		expect(journal.debtOf("b"), "a repeat reverses nothing more").toBe(0);
	});
});
