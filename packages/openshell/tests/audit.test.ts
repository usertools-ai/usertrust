// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	AuditWriterLockHeldError,
	canonicalize,
	GENESIS_HASH,
	VAULT_DIR,
	verifyVault,
} from "usertrust";
import { afterEach, describe, expect, it } from "vitest";
import {
	AuditChainUnverifiableError,
	type AuditPort,
	HOLD_EVENT_ACTOR,
	type HoldEventKind,
	VaultAudit,
} from "../src/audit.js";
import { HoldDetector } from "../src/detector.js";
import { HoldEngine } from "../src/engine.js";
import {
	type ChainCheckpoint,
	type ChainRecord,
	HoldJournal,
	type RecordedEvent,
} from "../src/journal.js";
import { startRuntime } from "../src/runtime.js";
import { FakeLedger } from "./fixtures/fake-ledger.js";

/**
 * An audit port with {@link AuditPort.record}'s contract — verify from the checkpoint, find the
 * event in the TAIL after it or append it, return that tail and the new checkpoint; one
 * operation serialized against every other record — and the failures the engine must survive.
 * Like the real port, it sees only the tail after the journal's checkpoint: an event before the
 * checkpoint is "absent" unless the journal absorbed it into its row.
 */
class FakeAudit implements AuditPort {
	events: Array<RecordedEvent & { kind: HoldEventKind; data: Record<string, unknown> }> = [];
	appends = 0;
	verifies = 0;
	/** The next append throws before writing (`refuse`) or after writing (`die_after`). */
	failNext: "refuse" | "die_after" | null = null;
	/** The chain does not verify: every record and full verify throws, nothing is appended. */
	broken = false;
	/** While set, an append waits on it. */
	gate: Promise<void> | null = null;
	/** Runs just before an append (e.g. the clock moving during the audit await). */
	beforeAppend: (() => void) | null = null;
	private tail: Promise<unknown> = Promise.resolve();

	private cp(sequence: number): ChainCheckpoint {
		return {
			offset: sequence,
			lineStart: Math.max(0, sequence - 1),
			sequence,
			hash: `h${sequence}`,
		};
	}

	record(
		kind: HoldEventKind,
		afterSequence: number,
		data: Record<string, unknown> & { holdId: string },
		from: ChainCheckpoint | null,
	): Promise<ChainRecord> {
		const run = async (): Promise<ChainRecord> => {
			if (this.broken) throw new AuditChainUnverifiableError("the chain breaks at index 0");
			const since = from?.sequence ?? 0;
			const visible = this.events.filter((e) => e.sequence > since);
			const tail = visible.map((e) => ({
				kind: e.kind,
				holdId: String(e.data.holdId),
				sequence: e.sequence,
				hash: e.hash,
			}));
			const found = visible.find(
				(e) => e.kind === kind && e.data.holdId === data.holdId && e.sequence > afterSequence,
			);
			if (found !== undefined) {
				return {
					event: { hash: found.hash, sequence: found.sequence },
					tail,
					checkpoint: this.cp(this.events.length),
				};
			}
			if (this.gate !== null) await this.gate;
			this.beforeAppend?.();
			const fail = this.failNext;
			this.failNext = null;
			if (fail === "refuse") throw new Error("audit append refused");
			const sequence = this.events.length + 1;
			const ev = { hash: `h${sequence}`, sequence, kind, data };
			this.events.push(ev);
			this.appends++;
			if (fail === "die_after") throw new Error("process died after the append");
			return {
				event: { hash: ev.hash, sequence },
				tail: [...tail, { kind, holdId: data.holdId, sequence, hash: ev.hash }],
				checkpoint: this.cp(sequence),
			};
		};
		const next = this.tail.then(run, run);
		this.tail = next.catch(() => undefined);
		return next;
	}

	async verifyFull(): Promise<void> {
		this.verifies++;
		if (this.broken) throw new AuditChainUnverifiableError("the chain breaks at index 0");
	}

	of(holdId: string, kind: HoldEventKind) {
		return this.events.filter((e) => e.kind === kind && e.data.holdId === holdId);
	}
}

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
	for (const c of closers.splice(0)) c();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}
function openJournal(path: string, clock: { now: number }, extra = {}) {
	const j = HoldJournal.open(path, { ledgerTimeoutMs: 50, now: () => clock.now, ...extra });
	closers.push(() => j.close());
	return j;
}
function setup(withAudit = true) {
	const path = join(tmp("openshell-audit-"), "holds.db");
	const clock = { now: 1_000 };
	const journal = openJournal(path, clock);
	const ledger = new FakeLedger();
	ledger.balances.set("b", 1_000);
	const audit = new FakeAudit();
	const engine = new HoldEngine(journal, ledger, {
		holdTtlSeconds: 900,
		now: () => clock.now,
		...(withAudit ? { audit } : {}),
	});
	return { path, journal, ledger, audit, engine, clock };
}
// reserve at t=1,000 → ttlAt = 1,000 + 50 + 50 + 900,000; the sweeper's default grace is 60 s.
const TTL_AT = 1_000 + 100 + 900_000;
const SWEEPABLE = TTL_AT + 60_000 + 1;

describe("1c-2: every hold records its events — once each", () => {
	it("reserve records `reserved` (its sequence on the row); a repeated reserve records nothing more", async () => {
		const { journal, audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		const [ev] = audit.of("k1", "openshell.hold.reserved");
		expect(ev).toMatchObject({
			data: { holdId: "k1", budgetId: "b", amount: 100, ttlAt: TTL_AT },
		});
		expect(journal.get("k1")?.reservedSeq).toBe(ev?.sequence);
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		expect(audit.appends).toBe(1);
	});

	it("settle records `settled` once (its hash on the row); a duplicate settle records nothing more", async () => {
		const { journal, audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await engine.settle("k1", { post: 40, overage: 0 });
		const [ev] = audit.of("k1", "openshell.hold.settled");
		expect(ev?.data).toMatchObject({ holdId: "k1", state: "settled", terminalKind: "settled" });
		expect(journal.get("k1")?.terminalEventHash).toBe(ev?.hash);
		await engine.settle("k1", { post: 40, overage: 0 });
		expect(audit.of("k1", "openshell.hold.settled")).toHaveLength(1);
		expect(audit.appends).toBe(2);
	});

	it("release records `voided`", async () => {
		const { journal, audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await engine.release("k1");
		const [ev] = audit.of("k1", "openshell.hold.voided");
		expect(journal.get("k1")?.terminalEventHash).toBe(ev?.hash);
	});

	it("the sweeper's expiry records `expired_unsettled` in the same sweep", async () => {
		const { journal, ledger, audit, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.expired.add("k1");
		clock.now = SWEEPABLE;
		expect(await engine.sweep()).toMatchObject({
			expired: ["k1"],
			events: [{ holdId: "k1", slot: "terminal" }], // recorded by step 5 of the same sweep
		});
		const [ev] = audit.of("k1", "openshell.hold.expired_unsettled");
		expect(journal.get("k1")?.terminalEventHash).toBe(ev?.hash);
	});

	it("a late settlement records `expired_unsettled` AND the `late_settlement` correction, each once", async () => {
		const { journal, ledger, audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		ledger.expired.add("k1");
		expect(await engine.settle("k1", { post: 60, overage: 0 })).toMatchObject({
			outcome: "late_settled",
		});
		const [late] = audit.of("k1", "openshell.hold.late_settlement");
		expect(late?.data).toMatchObject({ lateState: "charged", lateAmount: 60 });
		expect(journal.get("k1")).toMatchObject({
			terminalEventHash: audit.of("k1", "openshell.hold.expired_unsettled")[0]?.hash,
			lateEventHash: late?.hash,
		});
		await engine.settle("k1", { post: 60, overage: 0 });
		expect(audit.of("k1", "openshell.hold.late_settlement")).toHaveLength(1);
	});

	it("a zero-cost late settlement records its correction too (`zero` is a disposition)", async () => {
		const { journal, audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await journal.writeTx(() => journal.cas("k1", "open", "expiring"));
		await engine.settle("k1", { post: 0, overage: 0 });
		expect(audit.of("k1", "openshell.hold.late_settlement")[0]?.data).toMatchObject({
			lateState: "zero",
		});
	});

	it("without an audit port nothing is appended and the sweep records nothing (the engine as 1c-1 left it)", async () => {
		const { engine, audit } = setup(false);
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await engine.settle("k1", { post: 40, overage: 0 });
		expect((await engine.sweep()).events).toEqual([]);
		expect(audit.appends).toBe(0);
	});
});

describe("1c-2: the `reserved` event FAILS CLOSED", () => {
	it("an append that fails: the reservation throws, the hold is RELEASED at the ledger, the row is voided", async () => {
		const { journal, ledger, audit, engine } = setup();
		audit.failNext = "refuse";
		await expect(engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 })).rejects.toThrow(
			/audit append refused/,
		);
		expect(ledger.count("k1", "void"), "the hold is released").toBe(1);
		expect(journal.get("k1")).toMatchObject({ state: "voided", reservedSeq: null });
	});

	it("a chain that does not verify: the reservation throws AuditChainUnverifiableError and NOTHING is appended", async () => {
		const { ledger, audit, engine } = setup();
		audit.broken = true;
		await expect(
			engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 }),
		).rejects.toBeInstanceOf(AuditChainUnverifiableError);
		expect(audit.appends).toBe(0);
		expect(ledger.count("k1", "void")).toBe(1);
	});
});

describe("1c-2: a missing event is recovered by the sweep — once", () => {
	it("a terminal event whose append failed: the settlement stands, the sweep records the event", async () => {
		const { journal, audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		audit.failNext = "refuse";
		expect(await engine.settle("k1", { post: 40, overage: 0 })).toMatchObject({
			outcome: "settled",
		});
		expect(journal.get("k1")?.terminalEventHash).toBeNull();
		expect((await engine.sweep()).events).toEqual([{ holdId: "k1", slot: "terminal" }]);
		expect(audit.of("k1", "openshell.hold.settled")).toHaveLength(1);
		expect((await engine.sweep()).events, "nothing left to record").toEqual([]);
	});

	it("an append that LANDED before the process died: the sweep finds it on the chain and appends nothing", async () => {
		const { journal, audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		audit.failNext = "die_after";
		await engine.settle("k1", { post: 40, overage: 0 });
		expect(journal.get("k1")?.terminalEventHash).toBeNull();
		expect(audit.appends).toBe(2);
		expect((await engine.sweep()).events).toEqual([{ holdId: "k1", slot: "terminal" }]);
		expect(audit.appends, "found, not appended again").toBe(2);
		expect(journal.get("k1")?.terminalEventHash).toBe(
			audit.of("k1", "openshell.hold.settled")[0]?.hash,
		);
	});

	it("an append that outlives the journal's deadline still finishes before the next record scans: one event", async () => {
		const { journal, audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		let open: () => void = () => {};
		audit.gate = new Promise<void>((r) => {
			open = r;
		});
		await engine.settle("k1", { post: 40, overage: 0 }); // its event times out (50 ms)
		const during = await engine.sweep(); // queued behind the pending append; times out too
		expect(during.errors.map((e) => e.holdId)).toEqual(["k1"]);
		audit.gate = null;
		open();
		expect((await engine.sweep()).events).toEqual([{ holdId: "k1", slot: "terminal" }]);
		expect(audit.of("k1", "openshell.hold.settled")).toHaveLength(1);
		expect(journal.get("k1")?.terminalEventHash).not.toBeNull();
	});

	it("rows from an engine that recorded nothing: the sweep records `reserved` FIRST, then the terminal event after it", async () => {
		const { journal, ledger, engine: bare, clock } = setup(false);
		await bare.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await bare.settle("k1", { post: 40, overage: 0 });
		const audit = new FakeAudit();
		const engine = new HoldEngine(journal, ledger, {
			holdTtlSeconds: 900,
			now: () => clock.now,
			audit,
		});
		expect((await engine.sweep()).events).toEqual([
			{ holdId: "k1", slot: "reserved" },
			{ holdId: "k1", slot: "terminal" },
		]);
		const reserved = audit.of("k1", "openshell.hold.reserved")[0];
		const settled = audit.of("k1", "openshell.hold.settled")[0];
		expect(settled?.data.reservedSeq).toBe(reserved?.sequence);
	});

	it("a chain that does not verify: the sweep reports the error and appends NOTHING", async () => {
		const { audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		audit.failNext = "refuse";
		await engine.settle("k1", { post: 40, overage: 0 });
		audit.broken = true;
		const report = await engine.sweep();
		expect(report.events).toEqual([]);
		expect(report.errors[0]?.error).toBeInstanceOf(AuditChainUnverifiableError);
		expect(audit.appends).toBe(1);
	});

	it("a row carrying an incident records NO event (deliberate: the incident is the record)", async () => {
		const { journal, audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		audit.failNext = "refuse";
		await engine.settle("k1", { post: 40, overage: 0 });
		await journal.writeTx(() => journal.recordIncident("k1", { kind: "operator" }));
		expect(journal.terminalWithoutEvent()).toEqual([]);
		expect((await engine.sweep()).events).toEqual([]);
		expect(
			await journal.recordEventOnce("k1", "terminal", () => Promise.reject(new Error("never"))),
		).toBe("not_eligible");
	});

	it("three sweepers at once (two on one journal, one on a second connection to the file): every event appended once", async () => {
		const { path, journal, ledger, engine: bare, clock } = setup(false);
		for (const k of ["k1", "k2", "k3"]) {
			await bare.reserve({ holdKey: k, budgetId: "b", amount: 10 });
			await bare.settle(k, { post: 5, overage: 0 });
		}
		const audit = new FakeAudit();
		const opts = { holdTtlSeconds: 900, now: () => clock.now, audit };
		const other = openJournal(path, clock, { busyTimeoutMs: 20, busyRetries: 50 });
		// A sweeper on the second connection may lose the write lock (JournalBusyError): allowed.
		// Appending an event twice is not.
		await Promise.allSettled([
			new HoldEngine(journal, ledger, opts).sweep(),
			new HoldEngine(journal, ledger, opts).sweep(),
			new HoldEngine(other, ledger, opts).sweep(),
		]);
		await new HoldEngine(journal, ledger, opts).sweep(); // whatever lost to busy
		for (const k of ["k1", "k2", "k3"]) {
			expect(audit.of(k, "openshell.hold.reserved"), k).toHaveLength(1);
			expect(audit.of(k, "openshell.hold.settled"), k).toHaveLength(1);
		}
	});
});

describe("#191 r1 A: the admission is decided AFTER the audit await, and only its own admitter may release it", () => {
	it("admitBy passing DURING the audit await: not admitted (hold_expired), and the hold is released — never an authorization past admitBy", async () => {
		const { journal, ledger, audit, engine, clock } = setup();
		audit.beforeAppend = () => {
			clock.now = 1_000 + 900_000; // exactly admitBy: no longer admissible
		};
		expect(await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 })).toEqual({
			admitted: false,
			reason: "hold_expired",
		});
		expect(ledger.count("k1", "void"), "released").toBe(1);
		expect(journal.get("k1")?.state).toBe("voided");
	});

	it("a same-key retry ADMITTED while the first caller's audit failed: the first caller's cleanup leaves the hold ALIVE", async () => {
		const { journal, ledger, audit, engine } = setup();
		let retryDone: () => void = () => {};
		const retried = new Promise<void>((r) => {
			retryDone = r;
		});
		// The scheduler delays the first caller's cleanup until the retry has finished (the
		// interleaving the review describes), made explicit here.
		const e = engine as unknown as { releaseUnrecorded: (k: string) => Promise<void> };
		const cleanup = e.releaseUnrecorded.bind(engine);
		e.releaseUnrecorded = async (k) => {
			await retried;
			return cleanup(k);
		};
		audit.failNext = "refuse";
		const first = engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		const firstResult = first.catch((err: unknown) => err);
		await new Promise((r) => setTimeout(r, 5));
		const retry = await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		retryDone();
		expect(retry).toEqual({ admitted: true, existing: true });
		expect(await firstResult).toBeInstanceOf(Error);
		expect(ledger.count("k1", "void"), "the admitted hold is never released").toBe(0);
		expect(journal.get("k1")).toMatchObject({ state: "open" });
		expect(journal.get("k1")?.reservedSeq).not.toBeNull();
	});

	it("the failed caller's cleanup landing BETWEEN a retry's reserve and its record: the retry is NOT admitted (the row it re-reads is no longer open)", async () => {
		const { journal, ledger, audit, engine } = setup();
		const orig = journal.recordEventOnce.bind(journal);
		let calls = 0;
		journal.recordEventOnce = (async (...args: Parameters<typeof orig>) => {
			calls++;
			if (calls === 2) {
				// The first caller's cleanup: its admission never completed, so it may claim.
				expect(await journal.writeTx(() => journal.claimUnrecordedRelease("k1"))).toBe(true);
			}
			return orig(...args);
		}) as typeof journal.recordEventOnce;
		audit.failNext = "refuse";
		const e = engine as unknown as { releaseUnrecorded: (k: string) => Promise<void> };
		e.releaseUnrecorded = async () => {}; // the first caller's cleanup is the one above
		await expect(engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 })).rejects.toThrow(
			/refused/,
		);
		expect(await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 })).toEqual({
			admitted: false,
			reason: "not_open",
		});
		expect(ledger.count("k1", "void")).toBe(0); // voiding, its release left to the release path
	});

	it("the release claim of a failed admission LOSES once the `reserved` event is recorded (the journal primitive)", async () => {
		const { journal, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		expect(await journal.writeTx(() => journal.claimUnrecordedRelease("k1"))).toBe(false);
		expect(journal.get("k1")?.state).toBe("open");
	});
});

describe("#191 r1 B: the checkpoint — every hold event before it is absorbed into its row", () => {
	it("an append that landed but whose caller died, PASSED by the checkpoint of a later record: absorbed into its row, never appended again", async () => {
		const { journal, audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		audit.failNext = "die_after";
		await engine.settle("k1", { post: 40, overage: 0 }); // `settled` lands; its slot is not set
		expect(journal.get("k1")?.terminalEventHash).toBeNull();
		await engine.reserve({ holdKey: "k2", budgetId: "b", amount: 10 }); // the checkpoint passes it
		expect(journal.get("k1")?.terminalEventHash, "absorbed").toBe(
			audit.of("k1", "openshell.hold.settled")[0]?.hash,
		);
		expect(journal.auditCheckpoint()?.sequence).toBe(3);
		expect((await engine.sweep()).events).toEqual([]);
		expect(audit.of("k1", "openshell.hold.settled")).toHaveLength(1);
	});
});

describe("#191 r1 B: the sweep re-verifies the WHOLE chain — at the first sweep, then on its interval", () => {
	it("first sweep `ok`; then `not_due` until auditFullVerifyMs has passed; then `ok` again", async () => {
		const { journal, ledger, audit, clock } = setup();
		const engine = new HoldEngine(journal, ledger, {
			holdTtlSeconds: 900,
			now: () => clock.now,
			audit,
			auditFullVerifyMs: 10_000,
		});
		expect((await engine.sweep()).auditVerify).toBe("ok");
		clock.now += 9_999;
		expect((await engine.sweep()).auditVerify).toBe("not_due");
		clock.now += 1;
		expect((await engine.sweep()).auditVerify).toBe("ok");
		expect(audit.verifies).toBe(2);
	});

	it("a failed full verification clears the checkpoint and is reported — every record then verifies from genesis", async () => {
		const { journal, audit, engine } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		expect(journal.auditCheckpoint()).not.toBeNull();
		audit.broken = true;
		const r = await engine.sweep();
		expect(r.auditVerify).toBe("failed");
		expect(r.errors.map((e) => e.holdId)).toContain("(audit chain)");
		expect(journal.auditCheckpoint()).toBeNull();
	});
});

describe("#191 r1 C: a dependent event never precedes its `reserved` predecessor", () => {
	it("a reservation whose `reserved` event failed is released WITHOUT a `voided` event; the sweep then records `reserved` FIRST, then `voided`, each once", async () => {
		const { journal, audit, engine } = setup();
		audit.failNext = "refuse";
		await expect(engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 })).rejects.toThrow();
		expect(journal.get("k1")?.state).toBe("voided");
		expect(audit.events, "nothing on the chain before its predecessor").toEqual([]);
		expect((await engine.sweep()).events).toEqual([
			{ holdId: "k1", slot: "reserved" },
			{ holdId: "k1", slot: "terminal" },
		]);
		const [reserved] = audit.of("k1", "openshell.hold.reserved");
		const [voided] = audit.of("k1", "openshell.hold.voided");
		expect((reserved?.sequence ?? 0) < (voided?.sequence ?? 0)).toBe(true);
		expect(audit.events).toHaveLength(2);
	});
});

describe("1c-2: recordEventOnce eligibility, defined positively per slot", () => {
	it("#191 r1 C: a terminal or late event is NOT eligible before its `reserved` predecessor is recorded — even on a settled row", async () => {
		const { journal, engine } = setup(false);
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		await engine.settle("k1", { post: 1, overage: 0 });
		const never = () => Promise.reject(new Error("never produced"));
		expect(await journal.recordEventOnce("k1", "terminal", never)).toBe("not_eligible");
	});

	it("terminal only for settled / voided / expired; late only for charged / zero; an absent row is not eligible", async () => {
		const { journal, engine } = setup(false);
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		const ev = () =>
			Promise.resolve({
				event: { hash: "x", sequence: 1 },
				tail: [],
				checkpoint: { offset: 1, lineStart: 0, sequence: 1, hash: "x" },
			});
		expect(await journal.recordEventOnce("k1", "terminal", ev)).toBe("not_eligible");
		expect(await journal.recordEventOnce("k1", "late", ev)).toBe("not_eligible");
		expect(await journal.recordEventOnce("nope", "reserved", ev)).toBe("not_eligible");
		expect(await journal.recordEventOnce("k1", "reserved", ev)).toBe("recorded");
		expect(await journal.recordEventOnce("k1", "reserved", ev)).toBe("already");
		await engine.settle("k1", { post: 1, overage: 0 });
		expect(await journal.recordEventOnce("k1", "terminal", ev)).toBe("recorded");
		expect(await journal.recordEventOnce("k1", "late", ev)).toBe("not_eligible");
	});
});

describe("1c-2: the detector raises an event missing past its deadline", () => {
	it("terminal event missing: not before the overdue bound, `event_missing_overdue` after; nothing without auditEvents", async () => {
		const { journal, audit, engine, clock } = setup();
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		audit.failNext = "refuse";
		await engine.settle("k1", { post: 40, overage: 0 });
		const det = (auditEvents: boolean) =>
			new HoldDetector(journal, { sweepIntervalMs: 10_000, auditEvents, now: () => clock.now });
		const overdue = TTL_AT + 60_000 + 20_000 + 1;
		clock.now = overdue - 1;
		await journal.writeTx(() => journal.recordHeartbeat(clock.now));
		expect(det(true).check()).toMatchObject({ readable: true, incidents: [] });
		clock.now = overdue + 1;
		await journal.writeTx(() => journal.recordHeartbeat(clock.now));
		expect(det(true).check()).toMatchObject({
			incidents: [{ kind: "event_missing_overdue", slot: "terminal", holdIds: ["k1"] }],
		});
		expect(det(false).check()).toMatchObject({ incidents: [] });
	});

	it("each slot is reported: a missing `reserved` and a missing `late` event", async () => {
		const { journal, ledger, engine: bare, clock } = setup(false);
		await bare.reserve({ holdKey: "r", budgetId: "b", amount: 10 });
		await bare.reserve({ holdKey: "l", budgetId: "b", amount: 10 });
		ledger.expired.add("l");
		await bare.settle("l", { post: 5, overage: 0 });
		clock.now = TTL_AT + 60_000 + 20_000 + 2;
		await journal.writeTx(() => journal.recordHeartbeat(clock.now));
		const r = new HoldDetector(journal, {
			sweepIntervalMs: 10_000,
			auditEvents: true,
			now: () => clock.now,
		}).check();
		expect(r).toMatchObject({ readable: true });
		const missing = r.readable ? r.incidents : [];
		expect(missing).toContainEqual({
			kind: "event_missing_overdue",
			slot: "reserved",
			holdIds: ["r", "l"],
		});
		expect(missing).toContainEqual({ kind: "event_missing_overdue", slot: "late", holdIds: ["l"] });
	});
});

describe("1c-2: the journal migrates v3 → v4", () => {
	it("a v3 file gains `late_event_hash` (empty), keeps its rows, and its terminal rows are owed an event", async () => {
		const dir = tmp("openshell-audit-v3-");
		const path = join(dir, "holds.db");
		HoldJournal.open(path).close();
		const raw = new DatabaseSync(path);
		raw.exec("ALTER TABLE hold DROP COLUMN late_event_hash");
		raw.exec("PRAGMA user_version = 3");
		raw.exec(
			"INSERT INTO hold (hold_id, budget_id, state, amount, ttl_at, admit_by, terminal_kind) VALUES ('h1', 'b', 'settled', 100, 9000, 8000, 'settled')",
		);
		raw.close();
		const j = openJournal(path, { now: 0 });
		const v = new DatabaseSync(path);
		expect((v.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
			4,
		);
		v.close();
		expect(j.get("h1")).toMatchObject({ state: "settled", lateEventHash: null });
		expect(j.terminalWithoutEvent().map((r) => r.holdId)).toEqual(["h1"]);
	});
});

// ── The real chain ──

function vault(): string {
	return tmp("openshell-vault-");
}
const eventsFile = (v: string) => join(v, VAULT_DIR, "audit", "events.jsonl");
const lines = (v: string) =>
	readFileSync(eventsFile(v), "utf-8")
		.split("\n")
		.filter((l) => l.trim() !== "");

describe("1c-2: VaultAudit on a real usertrust chain", () => {
	it("records an event on a chain verifyVault accepts; recording it again returns it and appends nothing", async () => {
		const v = vault();
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		const first = (
			await a.record("openshell.hold.reserved", 0, { holdId: "k1", amount: 100 }, null)
		).event;
		const again = (
			await a.record("openshell.hold.reserved", 0, { holdId: "k1", amount: 100 }, null)
		).event;
		expect(again).toEqual(first);
		expect(lines(v)).toHaveLength(1);
		expect(JSON.parse(lines(v)[0] as string)).toMatchObject({
			kind: "openshell.hold.reserved",
			actor: HOLD_EVENT_ACTOR,
			data: { holdId: "k1" },
			sequence: first.sequence,
			hash: first.hash,
		});
		expect(verifyVault(join(v, VAULT_DIR)).valid).toBe(true);
	});

	it("two records of one event issued together append ONE (the scan and the append are one serialized operation)", async () => {
		const v = vault();
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		const [x, y] = await Promise.all([
			a.record("openshell.hold.settled", 0, { holdId: "k1" }, null),
			a.record("openshell.hold.settled", 0, { holdId: "k1" }, null),
		]);
		expect(x.event).toEqual(y.event);
		expect(lines(v)).toHaveLength(1);
	});

	it("only an event AFTER the given sequence counts", async () => {
		const v = vault();
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		const old = (await a.record("openshell.hold.settled", 0, { holdId: "k1" }, null)).event;
		const fresh = (await a.record("openshell.hold.settled", old.sequence, { holdId: "k1" }, null))
			.event;
		expect(fresh.sequence).toBeGreaterThan(old.sequence);
		expect(lines(v)).toHaveLength(2);
	});

	it("a malformed line refuses (core's reader would skip it and read 'absent'): nothing appended, the file untouched", async () => {
		const v = vault();
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		await a.record("openshell.hold.reserved", 0, { holdId: "k1" }, null);
		appendFileSync(eventsFile(v), "{not json\n");
		const before = readFileSync(eventsFile(v));
		await expect(
			a.record("openshell.hold.settled", 0, { holdId: "k1" }, null),
		).rejects.toBeInstanceOf(AuditChainUnverifiableError);
		expect(readFileSync(eventsFile(v)).equals(before)).toBe(true);
	});

	it("a tampered event refuses: the chain must verify before 'absent' means absent", async () => {
		const v = vault();
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		await a.record("openshell.hold.reserved", 0, { holdId: "k1" }, null);
		const tampered = (lines(v)[0] as string).replace('"k1"', '"k2"');
		const { writeFileSync } = await import("node:fs");
		writeFileSync(eventsFile(v), `${tampered}\n`);
		await expect(
			a.record("openshell.hold.reserved", 0, { holdId: "k2" }, null),
		).rejects.toBeInstanceOf(AuditChainUnverifiableError);
		expect(lines(v)).toHaveLength(1);
	});

	it("opening takes the vault's lock NOW: a second open in this process fails until the first releases", () => {
		const v = vault();
		const a = VaultAudit.open(v);
		expect(() => VaultAudit.open(v)).toThrow(AuditWriterLockHeldError);
		a.release();
		VaultAudit.open(v).release();
	});
});

/** A chain written directly, linked and hashed as core's writer does (canonical bytes). */
function writeChain(
	v: string,
	n: number,
	extra: (i: number) => Record<string, unknown> = () => ({}),
) {
	const dir = join(v, VAULT_DIR, "audit");
	mkdirSync(dir, { recursive: true });
	const out: string[] = [];
	let prev = GENESIS_HASH;
	for (let i = 1; i <= n; i++) {
		const event = {
			id: `e${i}`,
			timestamp: "2026-10-05T00:00:00.000Z",
			previousHash: prev,
			kind: "test.filler",
			actor: "sys",
			data: { i, ...extra(i) },
			sequence: i,
		};
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		out.push(canonicalize({ ...event, hash }));
		prev = hash;
	}
	writeFileSync(join(dir, "events.jsonl"), out.length === 0 ? "" : `${out.join("\n")}\n`);
	writeFileSync(join(dir, "events.jsonl.meta"), JSON.stringify({ lastHash: prev, sequence: n }));
}
/** Append one forged event, chained and hashed correctly, and move the anchor to it. */
function forgeAppend(v: string) {
	const ls = lines(v);
	const last = JSON.parse(ls[ls.length - 1] as string) as { hash: string; sequence: number };
	const event = {
		id: "forged",
		timestamp: "2026-10-05T00:00:00.000Z",
		previousHash: last.hash,
		kind: "test.forged",
		actor: "sys",
		data: {},
		sequence: last.sequence + 1,
	};
	const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
	appendFileSync(eventsFile(v), `${canonicalize({ ...event, hash })}\n`);
	writeFileSync(
		`${eventsFile(v)}.meta`,
		JSON.stringify({ lastHash: hash, sequence: event.sequence }),
	);
}

describe("#191 r1 B: VaultAudit verifies from the checkpoint — and refuses a chain that lost what it verified", () => {
	it("a TRUNCATED chain (the .meta anchor ahead of the log) is refused, nothing appended", async () => {
		const v = vault();
		writeChain(v, 3);
		writeFileSync(eventsFile(v), `${lines(v).slice(0, 2).join("\n")}\n`);
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		await expect(
			a.record("openshell.hold.reserved", 0, { holdId: "k1" }, null),
		).rejects.toBeInstanceOf(AuditChainUnverifiableError);
		expect(lines(v)).toHaveLength(2);
	});

	it("truncated, then a valid event APPENDED with a consistent anchor: the journal's checkpoint is no longer on the chain — refused", async () => {
		const v = vault();
		writeChain(v, 2);
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		const rec = await a.record("openshell.hold.reserved", 0, { holdId: "k1" }, null);
		expect(rec.checkpoint.sequence).toBe(3);
		writeFileSync(eventsFile(v), `${lines(v).slice(0, 2).join("\n")}\n`);
		forgeAppend(v); // a different sequence-3 event, chained and anchored consistently
		await expect(
			a.record("openshell.hold.settled", 3, { holdId: "k1" }, rec.checkpoint),
		).rejects.toThrow(/no longer on the chain/);
		expect(lines(v)).toHaveLength(3);
	});

	it("the anchor exactly ONE behind at the head's predecessor (the sidecar write failed) is accepted; any other disagreement refuses", async () => {
		const v = vault();
		writeChain(v, 3);
		const second = JSON.parse(lines(v)[1] as string) as { hash: string };
		writeFileSync(`${eventsFile(v)}.meta`, JSON.stringify({ lastHash: second.hash, sequence: 2 }));
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		expect(
			(await a.record("openshell.hold.reserved", 0, { holdId: "k1" }, null)).event.sequence,
		).toBe(4);
		writeFileSync(`${eventsFile(v)}.meta`, JSON.stringify({ lastHash: second.hash, sequence: 2 }));
		await expect(
			a.record("openshell.hold.reserved", 0, { holdId: "k2" }, null),
		).rejects.toBeInstanceOf(AuditChainUnverifiableError);
	});

	it("a TORN final line (no newline) refuses", async () => {
		const v = vault();
		writeChain(v, 2);
		appendFileSync(eventsFile(v), '{"id":"half');
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		await expect(a.record("openshell.hold.reserved", 0, { holdId: "k1" }, null)).rejects.toThrow(
			/torn/,
		);
	});

	it("a same-size REWRITE of an old line, before the checkpoint: the per-record read cannot see it, verifyFull does", async () => {
		const v = vault();
		writeChain(v, 3, (i) => ({ tag: `t${i}` }));
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		const rec = await a.record("openshell.hold.reserved", 0, { holdId: "k1" }, null);
		const ls = lines(v);
		ls[0] = (ls[0] as string).replace('"t1"', '"t9"');
		writeFileSync(eventsFile(v), `${ls.join("\n")}\n`);
		await a.record("openshell.hold.settled", 4, { holdId: "k1" }, rec.checkpoint); // not seen here
		await expect(a.verifyFull(rec.checkpoint)).rejects.toBeInstanceOf(AuditChainUnverifiableError);
	});

	it("verifyFull accepts an intact chain up to the checkpoint, and refuses a checkpoint that is not on it", async () => {
		const v = vault();
		writeChain(v, 5);
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		const rec = await a.record("openshell.hold.reserved", 0, { holdId: "k1" }, null);
		await a.verifyFull(rec.checkpoint);
		await expect(a.verifyFull({ ...rec.checkpoint, hash: "f".repeat(64) })).rejects.toBeInstanceOf(
			AuditChainUnverifiableError,
		);
	});

	it("a 100k-event chain: the first record verifies it all; every record after it reads only what is new — O(new), not O(chain)", {
		timeout: 120_000,
	}, async () => {
		const v = vault();
		writeChain(v, 100_000);
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		const first = await a.record("openshell.hold.reserved", 0, { holdId: "k1" }, null);
		expect(a.lastScanned).toBe(100_000);
		let cp = first.checkpoint;
		for (let i = 2; i <= 5; i++) {
			const r = await a.record("openshell.hold.reserved", 0, { holdId: `k${i}` }, cp);
			expect(a.lastScanned, `record ${i}`).toBe(0);
			expect(r.tail.map((e) => e.holdId)).toEqual([`k${i}`]);
			cp = r.checkpoint;
		}
		expect(cp.sequence).toBe(100_005);
		expect(verifyVault(join(v, VAULT_DIR)).valid).toBe(true);
	});
});

describe("1c-2: one process per vault, enforced at START", () => {
	it("startRuntime takes the lock, opens the journal, sweeps once (the replay at start), and close releases the lock", async () => {
		const v = vault();
		const journalPath = join(tmp("openshell-rt-"), "holds.db");
		const ledger = new FakeLedger();
		ledger.balances.set("b", 1_000);
		const rt = await startRuntime({
			vaultPath: v,
			journalPath,
			ledger,
			engine: { holdTtlSeconds: 900 },
		});
		expect(rt.startup).toMatchObject({ expired: [], errors: [], events: [] });
		expect(rt.journal.heartbeat(), "the startup sweep ran").not.toBeNull();
		await rt.engine.reserve({ holdKey: "k1", budgetId: "b", amount: 10 });
		expect(lines(v)).toHaveLength(1);
		rt.close();
		VaultAudit.open(v).release();
	});

	it("a second runtime in this process fails at the lock and NEVER opens its journal", async () => {
		const v = vault();
		const rt = await startRuntime({
			vaultPath: v,
			journalPath: join(tmp("openshell-rt-"), "holds.db"),
			ledger: new FakeLedger(),
			engine: { holdTtlSeconds: 900 },
		});
		closers.push(() => rt.close());
		const second = join(tmp("openshell-rt-"), "holds.db");
		await expect(
			startRuntime({
				vaultPath: v,
				journalPath: second,
				ledger: new FakeLedger(),
				engine: { holdTtlSeconds: 900 },
			}),
		).rejects.toBeInstanceOf(AuditWriterLockHeldError);
		expect(existsSync(second)).toBe(false);
	});

	it("a second PROCESS on the vault exits at the lock — before any journal write, sweep or replay — and starts once the first closes", {
		timeout: 60_000,
	}, async () => {
		const v = vault();
		const rt = await startRuntime({
			vaultPath: v,
			journalPath: join(tmp("openshell-rt-"), "holds.db"),
			ledger: new FakeLedger(),
			engine: { holdTtlSeconds: 900 },
		});
		const second = join(tmp("openshell-rt-"), "holds.db");
		const held = await starter(v, second);
		expect(held, held.err).toMatchObject({ code: 3, out: { started: false } });
		expect(existsSync(second), "the second process never opened its journal").toBe(false);
		rt.close();
		const after = await starter(v, second);
		expect(after, after.err).toMatchObject({ code: 0, out: { started: true } });
	});
});

const STARTER = join(__dirname, "fixtures", "runtime-starter.ts");
const CHILD_TSCONFIG = join(__dirname, "fixtures", "tsconfig.child.json");
const REPO_ROOT = join(__dirname, "..", "..", "..");
function starter(
	vaultPath: string,
	journalPath: string,
): Promise<{ code: number | null; out: unknown; err: string }> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			["--no-warnings", "--import", "tsx", STARTER, vaultPath, journalPath],
			{
				cwd: REPO_ROOT,
				// `usertrust` → core's source, as vitest's alias: CI does not build dist/ for tests.
				env: { ...process.env, TSX_TSCONFIG_PATH: CHILD_TSCONFIG },
			},
		);
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("exit", (code) => {
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(out.trim());
			} catch {
				parsed = out;
			}
			resolve({ code, out: parsed, err });
		});
	});
}
