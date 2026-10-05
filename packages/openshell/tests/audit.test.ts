// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuditWriterLockHeldError, VAULT_DIR, verifyVault } from "usertrust";
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
import { HoldJournal, type RecordedEvent } from "../src/journal.js";
import { startRuntime } from "../src/runtime.js";
import { FakeLedger } from "./fixtures/fake-ledger.js";

/**
 * An audit port with {@link AuditPort.record}'s contract — scan, then append if absent, one
 * operation serialized against every other record — and the failures the engine must survive.
 */
class FakeAudit implements AuditPort {
	events: Array<RecordedEvent & { kind: HoldEventKind; data: Record<string, unknown> }> = [];
	appends = 0;
	/** The next append throws before writing (`refuse`) or after writing (`die_after`). */
	failNext: "refuse" | "die_after" | null = null;
	/** The chain does not verify: every record throws, nothing is appended. */
	broken = false;
	/** While set, an append waits on it. */
	gate: Promise<void> | null = null;
	private tail: Promise<unknown> = Promise.resolve();

	record(
		kind: HoldEventKind,
		afterSequence: number,
		data: Record<string, unknown> & { holdId: string },
	): Promise<RecordedEvent> {
		const run = async (): Promise<RecordedEvent> => {
			if (this.broken) throw new AuditChainUnverifiableError("the chain breaks at index 0");
			const found = this.events.find(
				(e) => e.kind === kind && e.data.holdId === data.holdId && e.sequence > afterSequence,
			);
			if (found !== undefined) return { hash: found.hash, sequence: found.sequence };
			if (this.gate !== null) await this.gate;
			const fail = this.failNext;
			this.failNext = null;
			if (fail === "refuse") throw new Error("audit append refused");
			const sequence = this.events.length + 1;
			const ev = { hash: `h${sequence}`, sequence, kind, data };
			this.events.push(ev);
			this.appends++;
			if (fail === "die_after") throw new Error("process died after the append");
			return { hash: ev.hash, sequence };
		};
		const next = this.tail.then(run, run);
		this.tail = next.catch(() => undefined);
		return next;
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

describe("1c-2: recordEventOnce eligibility, defined positively per slot", () => {
	it("terminal only for settled / voided / expired; late only for charged / zero; an absent row is not eligible", async () => {
		const { journal, engine } = setup(false);
		await engine.reserve({ holdKey: "k1", budgetId: "b", amount: 100 });
		const ev = () => Promise.resolve({ hash: "x", sequence: 1 });
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
		const first = await a.record("openshell.hold.reserved", 0, { holdId: "k1", amount: 100 });
		const again = await a.record("openshell.hold.reserved", 0, { holdId: "k1", amount: 100 });
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
			a.record("openshell.hold.settled", 0, { holdId: "k1" }),
			a.record("openshell.hold.settled", 0, { holdId: "k1" }),
		]);
		expect(x).toEqual(y);
		expect(lines(v)).toHaveLength(1);
	});

	it("only an event AFTER the given sequence counts", async () => {
		const v = vault();
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		const old = await a.record("openshell.hold.settled", 0, { holdId: "k1" });
		const fresh = await a.record("openshell.hold.settled", old.sequence, { holdId: "k1" });
		expect(fresh.sequence).toBeGreaterThan(old.sequence);
		expect(lines(v)).toHaveLength(2);
	});

	it("a malformed line refuses (core's reader would skip it and read 'absent'): nothing appended, the file untouched", async () => {
		const v = vault();
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		await a.record("openshell.hold.reserved", 0, { holdId: "k1" });
		appendFileSync(eventsFile(v), "{not json\n");
		const before = readFileSync(eventsFile(v));
		await expect(a.record("openshell.hold.settled", 0, { holdId: "k1" })).rejects.toBeInstanceOf(
			AuditChainUnverifiableError,
		);
		expect(readFileSync(eventsFile(v)).equals(before)).toBe(true);
	});

	it("a tampered event refuses: the chain must verify before 'absent' means absent", async () => {
		const v = vault();
		const a = VaultAudit.open(v);
		closers.push(() => a.release());
		await a.record("openshell.hold.reserved", 0, { holdId: "k1" });
		const tampered = (lines(v)[0] as string).replace('"k1"', '"k2"');
		const { writeFileSync } = await import("node:fs");
		writeFileSync(eventsFile(v), `${tampered}\n`);
		await expect(a.record("openshell.hold.reserved", 0, { holdId: "k2" })).rejects.toBeInstanceOf(
			AuditChainUnverifiableError,
		);
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
		expect(held).toMatchObject({ code: 3, out: { started: false } });
		expect(existsSync(second), "the second process never opened its journal").toBe(false);
		rt.close();
		expect(await starter(v, second)).toMatchObject({ code: 0, out: { started: true } });
	});
});

const STARTER = join(__dirname, "fixtures", "runtime-starter.ts");
const REPO_ROOT = join(__dirname, "..", "..", "..");
function starter(
	vaultPath: string,
	journalPath: string,
): Promise<{ code: number | null; out: unknown; err: string }> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			["--no-warnings", "--import", "tsx", STARTER, vaultPath, journalPath],
			{ cwd: REPO_ROOT },
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
