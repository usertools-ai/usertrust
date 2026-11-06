// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveChainIntegrity, type PersistedAuditEvent, readLedgerEvents } from "usertrust";
import { canonicalize } from "usertrust-verify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { parseZonedTime } from "../src/server/position-index.js";
import { createUiServer, type UiServer } from "../src/server/server.js";
import { __tailTestSeam } from "../src/server/tail.js";
import { TransferIndex } from "../src/server/verdicts.js";
import { Workspace } from "../src/server/workspace.js";
import { isHeaderSpend } from "../src/shared/aggregate.js";
import type { AtPayload } from "../src/shared/api.js";
import { toLedgerRows } from "../src/shared/rows.js";

const GENESIS = "0".repeat(64);
const T0 = Date.parse("2026-11-06T10:00:00.000Z");
const NOTE = "budget history starts with the first budget record; this is today's budget";

type Spec = { kind: string; data?: Record<string, unknown>; timestamp?: string };
type SummaryChain = { valid: boolean; breakIndex: number | null; errors: string[] };

/** A hash-linked chain with `sequence`, one event per spec; event i is at 10:00Z plus i minutes unless given. */
function chain(specs: readonly Spec[]): PersistedAuditEvent[] {
	let previousHash = GENESIS;
	return specs.map((s, i) => {
		const rest = {
			actor: "local",
			data: s.data ?? {},
			id: `evt-${i}`,
			kind: s.kind,
			previousHash,
			sequence: i + 1,
			timestamp: s.timestamp ?? new Date(T0 + i * 60_000).toISOString(),
		};
		const hash = createHash("sha256").update(canonicalize(rest)).digest("hex");
		previousHash = hash;
		return { ...rest, hash } as PersistedAuditEvent;
	});
}

describe("GET /api/at", () => {
	let tempDir: string;
	let vaultPath: string;
	let logPath: string;
	let wsBase: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-at-"));
		vaultPath = join(tempDir, ".usertrust");
		logPath = join(vaultPath, "audit", "events.jsonl");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		wsBase = mkdtempSync(join(tmpdir(), "trust-at-ws-"));
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(wsBase, { recursive: true, force: true });
	});

	async function start(opts: { rowCap?: number; workspaceDir?: string } = {}): Promise<UiServer> {
		ui = await createUiServer(tempDir, {
			port: 0,
			workspaceDir: opts.workspaceDir ?? join(wsBase, "workspace"),
			...(opts.rowCap !== undefined ? { rowCap: opts.rowCap } : {}),
		});
		return ui;
	}

	async function at(
		query: string,
	): Promise<{ status: number; body: AtPayload & { error?: string } }> {
		const res = await fetch(`http://127.0.0.1:${(ui as UiServer).port}/api/at?${query}`);
		return { status: res.status, body: (await res.json()) as AtPayload & { error?: string } };
	}

	/** The whole-vault verdict, as `/api/summary` gives it. */
	async function summaryChain(): Promise<SummaryChain> {
		const res = await fetch(`http://127.0.0.1:${(ui as UiServer).port}/api/summary`);
		return ((await res.json()) as { chain: SummaryChain }).chain;
	}

	async function seed(count: number, spec?: (i: number) => Spec): Promise<void> {
		const writer = createAuditWriter(tempDir);
		for (let i = 0; i < count; i++) {
			const s = spec?.(i) ?? { kind: "llm_call", data: { cost: 1 } };
			await writer.appendEvent({ kind: s.kind, actor: "local", data: s.data ?? {} });
		}
		writer.release();
	}

	function writeEvents(events: readonly PersistedAuditEvent[]): void {
		writeFileSync(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
	}

	/** Changes event `index`'s cost in place, so its hash no longer matches: the chain breaks AT that event. */
	function tamper(index: number): void {
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		const parsed = JSON.parse(lines[index] as string) as { data: { cost?: number } };
		parsed.data.cost = 9999;
		lines[index] = JSON.stringify(parsed);
		writeFileSync(logPath, `${lines.join("\n")}\n`);
	}

	it("at pos matches a full-vault reload cut at pos", async () => {
		const kinds = ["llm_call", "policy_denied", "llm_call_failed", "tool_use", "ledger_rejected"];
		await seed(50, (i) => ({
			kind: kinds[(i * 7) % kinds.length] as string,
			data: { cost: (i % 9) + 0.5, settled: true, transferId: `tx_${i}` },
		}));
		await start();
		expect(await summaryChain()).toMatchObject({ valid: true, breakIndex: null });
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		for (const pos of [0, 10, 49]) {
			const { status, body } = await at(`pos=${pos}`);
			expect(status).toBe(200);
			let spent = 0;
			const counts = { llm_call: 0, denied: 0, other: 0 };
			for (const line of lines.slice(0, pos + 1)) {
				const e = JSON.parse(line) as PersistedAuditEvent;
				if (isHeaderSpend(e.kind, e.data.cost)) spent += e.data.cost;
				if (e.kind === "llm_call") counts.llm_call += 1;
				else if (e.kind === "policy_denied" || e.kind === "ledger_rejected") counts.denied += 1;
				else counts.other += 1;
			}
			expect(body.pos).toBe(pos);
			expect(body.spentUt).toBe(spent);
			expect(body.counts).toEqual(counts);
			expect(body.ts).toBe((JSON.parse(lines[pos] as string) as PersistedAuditEvent).timestamp);
			expect(body).toMatchObject({ head: 49, clamped: false, epoch: 0, windowStartPos: 0 });
			expect(body.chain).toEqual({ valid: true, breakIndex: null });
			expect(body.budget.note).toBe(NOTE);
		}
	});

	it("status at T differs from now", async () => {
		await seed(7, (i) => {
			if (i === 3)
				return { kind: "llm_call", data: { cost: 5, settled: true, transferId: "tx_x" } };
			if (i === 6)
				return { kind: "settlement_ambiguous", data: { error: "post failed", transferId: "tx_x" } };
			return { kind: "llm_call", data: { cost: 1, settled: true, transferId: `tx_${i}` } };
		});
		await start();
		const { rows } = (await (await fetch(`http://127.0.0.1:${ui?.port}/api/events`)).json()) as {
			rows: Array<{ pos: number; hash: string; status: string }>;
		};
		const row3 = rows.find((r) => r.pos === 3);
		expect(row3?.status).toBe("ambiguous");
		const hashOf3 = row3?.hash as string;
		const before = await at("pos=4");
		// Only the rows whose transfer moves after the position: a small payload, not every row.
		expect(before.body.statusAt).toEqual({ [hashOf3]: "settled" });
		// Once every record of the transfer is in, the status is the one the rows carry.
		expect((await at("pos=6")).body.statusAt).toEqual({});
		// A row recorded after the position is not part of it.
		expect((await at("pos=2")).body.statusAt).toEqual({});
	});

	it("status at every position is the status a reload cut at that position gives", async () => {
		// Transfers that interleave, each closed by a later record that changes its verdict, or not.
		const specs: Spec[] = [];
		const step = (kind: string, tx: string, data: Record<string, unknown> = {}) =>
			specs.push({ kind, data: { transferId: tx, ...data } });
		step("llm_call", "a", { settled: true, cost: 5 });
		step("llm_call", "b", { settled: true, cost: 5 });
		step("anomaly_detected", "c", { message: "spike" });
		step("settlement_ambiguous", "a", { error: "post failed" });
		step("llm_call", "c", { settled: true, cost: 2 });
		step("hold_released", "d", { reason: "ttl" });
		step("llm_call", "b", { settled: false, cost: 5 });
		step("settlement_unrecoverable", "d", { reason: "no hold" });
		step("llm_call_failed", "e", { error: "500" });
		step("settlement_ambiguous", "c", { error: "post failed" });
		specs.push({ kind: "policy_denied", data: {} });
		const events = chain(specs);
		writeEvents(events);
		await start();
		const { rows } = (await (await fetch(`http://127.0.0.1:${ui?.port}/api/events`)).json()) as {
			rows: Array<{ pos: number; hash: string; status: string }>;
		};
		for (let pos = 0; pos < events.length; pos++) {
			const cut = events.slice(0, pos + 1);
			const index = new TransferIndex();
			index.add(cut, 0);
			const expected = toLedgerRows(cut, { valid: true, breakIndex: null }, index.verdictOf, 0);
			const { body } = await at(`pos=${pos}`);
			const shown = rows
				.filter((r) => r.pos <= pos)
				.map((r) => [r.pos, body.statusAt[r.hash] ?? r.status]);
			expect(shown).toEqual(expected.map((r) => [r.pos, r.status]));
		}
	});

	it("the transfers open across a position are found past the tree's first growth", () => {
		// 3000 transfers, one event each, and every 500th reopened by a record near the end.
		const specs: Spec[] = [];
		for (let i = 0; i < 3000; i++)
			specs.push({ kind: "llm_call", data: { transferId: `t${i}`, settled: true } });
		for (let i = 0; i < 3000; i += 500)
			specs.push({ kind: "settlement_ambiguous", data: { transferId: `t${i}` } });
		const events = chain(specs);
		const index = new TransferIndex();
		index.add(events.slice(0, 1500), 0);
		index.add(events.slice(1500), 1500);
		for (const pos of [0, 499, 500, 1024, 2999, 3002, events.length - 1]) {
			const open = index
				.openAcross(pos)
				.flatMap((o) => o.rowPositions)
				.sort((a, b) => a - b);
			// Brute force: a transfer whose first record is at or before `pos` and whose ambiguity comes after it.
			const expected: number[] = [];
			for (let i = 0; i < 3000; i += 500) if (i <= pos && 3000 + i / 500 > pos) expected.push(i);
			expect({ pos, open }).toEqual({ pos, open: expected });
		}
		const key = index.keyOfRow((events[500] as PersistedAuditEvent).hash) as string;
		expect(index.verdictAt(key, 2999)).toBe("SETTLED");
		expect(index.verdictAt(key, 3001)).toBe("AMBIGUOUS");
		expect(index.verdictAt(key, 3001)).toBe(index.verdictOfTransfer(key));
	});

	it("parseZonedTime takes a zoned ISO date and time only", () => {
		expect(parseZonedTime("2026-11-06T10:00:00Z")).toBe(T0);
		expect(parseZonedTime("2026-11-06T10:00Z")).toBe(T0);
		expect(parseZonedTime("2026-11-06T10:00:00.000Z")).toBe(T0);
		expect(parseZonedTime("2026-11-06T05:30:00-04:30")).toBe(T0);
		expect(parseZonedTime("2028-02-29T00:00:00Z")).toBe(Date.parse("2028-02-29T00:00:00Z"));
		expect(parseZonedTime("2026-11-06t10:00:00z")).toBe(T0);
		expect(parseZonedTime("2026-11-06t05:30:00-04:30")).toBe(T0);
		for (const bad of [
			"2026-11-06T23:59:60Z",
			"2026-11-06x10:00:00Z",
			"2026-11-06",
			"2026-11-06T10:00:00",
			"2026-11-06T10:00:00+02",
			"2026-11-06T10:00:00+0200",
			"2026-02-29T00:00:00Z",
			"2026-11-06T10:60:00Z",
			"2026-11-06T10:00:00+24:00",
			" 2026-11-06T10:00:00Z",
			"+002026-11-06T10:00:00Z",
		]) {
			expect({ bad, ms: parseZonedTime(bad) }).toEqual({ bad, ms: Number.NaN });
		}
	});

	it("chain prefix before a break is valid", async () => {
		await seed(12);
		tamper(8);
		await start();
		// The whole vault fails, and the break is its only failure: the prefix before it verifies.
		expect(await summaryChain()).toMatchObject({ valid: false, breakIndex: 8 });
		expect((await at("pos=5")).body.chain).toEqual({ valid: true, breakIndex: 8 });
		expect((await at("pos=7")).body.chain.valid).toBe(true);
		expect((await at("pos=8")).body.chain.valid).toBe(false);
		expect((await at("pos=9")).body.chain).toEqual({ valid: false, breakIndex: 8 });
	});

	it("break before the window, vault over rowCap", async () => {
		await seed(40);
		tamper(5);
		await start({ rowCap: 10 });
		expect(await summaryChain()).toMatchObject({ valid: false, breakIndex: 5 });
		const three = await at("pos=3");
		expect(three.body.chain).toEqual({ valid: true, breakIndex: 5 });
		expect(three.body.windowStartPos).toBe(30);
		expect((await at("pos=6")).body.chain).toEqual({ valid: false, breakIndex: 5 });
		expect((await at("pos=35")).body.chain).toEqual({ valid: false, breakIndex: 5 });
	});

	it("break inside the window, vault over rowCap", async () => {
		await seed(40);
		tamper(33);
		await start({ rowCap: 10 });
		expect(await summaryChain()).toMatchObject({ valid: false, breakIndex: 33 });
		// The slice-relative index (3) would read this position as past the break.
		expect((await at("pos=20")).body.chain).toEqual({ valid: true, breakIndex: 33 });
		expect((await at("pos=34")).body.chain).toEqual({ valid: false, breakIndex: 33 });
	});

	it("unparseable line before a tampered one: the break indexes the verifier's list, and the vault fails everywhere", async () => {
		await seed(12);
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		writeFileSync(
			logPath,
			`${[...lines.slice(0, 3), "{ not json", ...lines.slice(3)].join("\n")}\n`,
		);
		// File line 8 is the event at verifier index 7: the unparseable line takes no index.
		tamper(8);
		const verifierIndex = deriveChainIntegrity(readLedgerEvents(vaultPath)).breakIndex;
		expect(verifierIndex).toBe(7);
		await start();
		const tampered = JSON.parse(
			readFileSync(logPath, "utf-8").trim().split("\n")[8] as string,
		) as PersistedAuditEvent;
		const { rows } = (await (await fetch(`http://127.0.0.1:${ui?.port}/api/events`)).json()) as {
			rows: Array<{ pos: number; id: string }>;
		};
		expect(rows.find((r) => r.id === tampered.id)?.pos).toBe(verifierIndex);
		// The unparseable line is a failure no event marks: the break is not the vault's only one, so no position
		// before it reads valid.
		const summary = await summaryChain();
		expect(summary).toMatchObject({ valid: false, breakIndex: verifierIndex });
		expect(summary.errors.some((e) => e.startsWith("malformed JSON"))).toBe(true);
		expect((await at("pos=0")).body.chain).toEqual({ valid: false, breakIndex: verifierIndex });
		expect((await at("pos=6")).body.chain).toEqual({ valid: false, breakIndex: verifierIndex });
		expect((await at("pos=7")).body.chain).toEqual({ valid: false, breakIndex: verifierIndex });
	});

	it("a torn tail beside an earlier break: invalid at every position", async () => {
		await seed(8);
		tamper(3);
		appendFileSync(logPath, "{ not json");
		await start();
		expect(await summaryChain()).toMatchObject({ valid: false, breakIndex: 3 });
		expect((await at("pos=1")).body.chain).toEqual({ valid: false, breakIndex: 3 });
		expect((await at("pos=7")).body.chain).toEqual({ valid: false, breakIndex: 3 });
	});

	it("a mismatched anchor beside a break: invalid at every position", async () => {
		await seed(8);
		tamper(5);
		// The anchor records more events than the log holds: a failure no event marks.
		const meta = `${logPath}.meta`;
		const anchor = JSON.parse(readFileSync(meta, "utf-8")) as Record<string, unknown>;
		writeFileSync(meta, JSON.stringify({ ...anchor, sequence: 99 }));
		await start();
		const summary = await summaryChain();
		expect(summary).toMatchObject({ valid: false, breakIndex: 5 });
		expect(summary.errors.some((e) => e.startsWith("anchor mismatch"))).toBe(true);
		expect((await at("pos=2")).body.chain).toEqual({ valid: false, breakIndex: 5 });
	});

	it("t with mixed precision and no zone", async () => {
		writeEvents(chain(Array.from({ length: 5 }, () => ({ kind: "llm_call", data: { cost: 1 } }))));
		await start();
		const whole = await at("t=2026-11-06T10:02:00Z");
		expect(whole.status).toBe(200);
		expect(whole.body).toMatchObject({ pos: 2, ts: "2026-11-06T10:02:00.000Z", clamped: false });
		expect((await at("t=2026-11-06T10:02:00.000Z")).body.pos).toBe(2);
		expect((await at("t=2026-11-06T10:02:59.999Z")).body.pos).toBe(2);
		expect((await at("t=2026-11-06T10:02Z")).body.pos).toBe(2);
		// The same instant with an offset ('+' encoded: a bare '+' in a query is a space).
		expect((await at(`t=${encodeURIComponent("2026-11-06T12:02:00+02:00")}`)).body.pos).toBe(2);
		expect((await at("t=2026-11-06T10:02:00")).status).toBe(400);
		expect((await at("t=2026-11-06")).status).toBe(400);
		expect((await at("t=2026-11-06T12:02:00+02:00")).status).toBe(400);
		// After the last record: the head. Before the first: nothing to show.
		expect((await at("t=2027-01-01T00:00:00Z")).body).toMatchObject({ pos: 4, head: 4 });
		const early = await at("t=2026-11-06T09:59:59Z");
		expect(early).toEqual({ status: 404, body: { error: "no records before this time" } });
	});

	it("t edges: a leap second, the first and last years, a lowercase t and z", async () => {
		writeEvents(chain(Array.from({ length: 5 }, () => ({ kind: "llm_call", data: { cost: 1 } }))));
		await start();
		expect((await at("t=2026-11-06T23:59:60Z")).status).toBe(400);
		expect(await at("t=0000-01-01T00:00:00Z")).toEqual({
			status: 404,
			body: { error: "no records before this time" },
		});
		expect((await at("t=9999-12-31T23:59:59Z")).body).toMatchObject({ pos: 4, head: 4 });
		// RFC 3339 allows both letters in lower case.
		expect((await at("t=2026-11-06t10:02:00z")).body.pos).toBe(2);
		expect((await at("t=2026-11-06t10:02:00Z")).body.pos).toBe(2);
	});

	it("a first record whose time does not parse: a t before the first time that does is a 404", async () => {
		writeEvents(
			chain([
				{ kind: "llm_call", timestamp: "garbled" },
				{ kind: "llm_call", timestamp: "2026-11-06T10:01:00.000Z" },
				{ kind: "llm_call", timestamp: "2026-11-06T10:02:00.000Z" },
			]),
		);
		await start();
		expect(await at("t=2026-11-06T10:00:30Z")).toEqual({
			status: 404,
			body: { error: "no records before this time" },
		});
		expect((await at("t=2026-11-06T10:01:00Z")).body.pos).toBe(1);
		// By position, the record is there, with its time as recorded.
		expect((await at("pos=0")).body).toMatchObject({ pos: 0, ts: "garbled", plan: null });
	});

	it("epoch changes on resync", async () => {
		await seed(5);
		const other = mkdtempSync(join(tmpdir(), "trust-at-other-"));
		try {
			mkdirSync(join(other, ".usertrust", "audit"), { recursive: true });
			const writer = createAuditWriter(other);
			for (let i = 0; i < 5; i++) {
				await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost: 7 } });
			}
			writer.release();
			const s = await start();
			const first = await at("pos=4");
			expect(first.body.epoch).toBe(0);
			writeFileSync(logPath, readFileSync(join(other, ".usertrust", "audit", "events.jsonl")));
			s.reload();
			const second = await at("pos=4");
			expect(second.body.epoch).toBeGreaterThan(first.body.epoch);
			expect(second.body.head).toBe(first.body.head);
			expect(second.body.spentUt).toBe(35);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("epoch stays the same over a forced reload of an unchanged vault", async () => {
		await seed(5);
		const s = await start();
		const before = await at("pos=4");
		s.reload();
		s.reload();
		const after = await at("pos=4");
		expect(after.body.epoch).toBe(before.body.epoch);
		expect(after.body).toEqual(before.body);
	});

	it("epoch stays the same over the periodic re-verify of an unchanged vault", async () => {
		await seed(5);
		// Only the intervals are faked: the watcher's re-verify is a `setInterval`, so advancing the clock runs it
		// at once, with no wall-clock wait. Timeouts, I/O and HTTP stay real. The seam (read when the watcher starts)
		// makes the re-verify 1 s and the 1 s backstop an hour, so advancing 2 s runs the two re-verifies and nothing else.
		const saved = { reverifyMs: __tailTestSeam.reverifyMs, backstopMs: __tailTestSeam.backstopMs };
		__tailTestSeam.reverifyMs = 1000;
		__tailTestSeam.backstopMs = 3_600_000;
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const s = await start();
			const port = s.port;
			const version = async () =>
				((await (await fetch(`http://127.0.0.1:${port}/api/events`)).json()) as { version: number })
					.version;
			const v0 = await version();
			const e0 = (await at("pos=4")).body.epoch;
			// Two periods: two full reloads. Each bumps the version, which proves they ran.
			vi.advanceTimersByTime(2000);
			expect(await version()).toBe(v0 + 2);
			expect((await at("pos=4")).body.epoch).toBe(e0);
			await s.close();
			ui = undefined;
		} finally {
			vi.useRealTimers();
			__tailTestSeam.reverifyMs = saved.reverifyMs;
			__tailTestSeam.backstopMs = saved.backstopMs;
		}
	});

	it("an in-place rewrite that keeps the tip bumps epoch", async () => {
		await seed(6);
		const s = await start();
		const before = await at("pos=5");
		// Same log, same number of events, same tip: only the break index moves (null to 2).
		const tip = readFileSync(logPath, "utf-8").trim().split("\n").at(-1);
		tamper(2);
		expect(readFileSync(logPath, "utf-8").trim().split("\n").at(-1)).toBe(tip);
		s.reload();
		const after = await at("pos=5");
		expect(after.body.chain.breakIndex).toBe(2);
		expect(after.body.head).toBe(before.body.head);
		expect(after.body.epoch).toBeGreaterThan(before.body.epoch);
	});

	it("statusAt after a live append: an earlier position keeps the status it had", async () => {
		await seed(4, (i) =>
			i === 3
				? { kind: "llm_call", data: { cost: 5, settled: true, transferId: "tx_live" } }
				: { kind: "llm_call", data: { cost: 1, settled: true, transferId: `tx_${i}` } },
		);
		const s = await start();
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({
			kind: "settlement_ambiguous",
			actor: "local",
			data: { error: "post failed", transferId: "tx_live" },
		});
		writer.release();
		type Rows = { rows: Array<{ pos: number; hash: string; status: string }> };
		let rows: Rows["rows"] = [];
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			rows = ((await (await fetch(`http://127.0.0.1:${s.port}/api/events`)).json()) as Rows).rows;
			if (rows.length === 5) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(rows.map((r) => r.pos)).toEqual([0, 1, 2, 3, 4]);
		const row3 = rows[3] as Rows["rows"][number];
		expect(row3.status).toBe("ambiguous");
		const three = await at("pos=3");
		// Extended by the append, not reloaded: same epoch, and the appended record is the head.
		expect(three.body).toMatchObject({ head: 4, epoch: 0 });
		expect(three.body.statusAt).toEqual({ [row3.hash]: "settled" });
		expect((await at("pos=4")).body.statusAt).toEqual({});
	});

	it("a vault that fails with no break index reads invalid at every position", async () => {
		await seed(5);
		// A torn last line: the vault does not verify, and no event breaks the chain.
		appendFileSync(logPath, "{ not json");
		await start();
		const summary = (await (await fetch(`http://127.0.0.1:${ui?.port}/api/summary`)).json()) as {
			chain: { valid: boolean; breakIndex: number | null };
		};
		expect(summary.chain).toMatchObject({ valid: false, breakIndex: null });
		expect((await at("pos=0")).body.chain).toEqual({ valid: false, breakIndex: null });
		expect((await at("pos=4")).body.chain).toEqual({ valid: false, breakIndex: null });
	});

	it("at clamps after resync", async () => {
		await seed(20);
		const s = await start();
		expect((await at("pos=19")).body).toMatchObject({ pos: 19, head: 19, clamped: false });
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		writeFileSync(logPath, `${lines.slice(0, 10).join("\n")}\n`);
		s.reload();
		expect((await at("pos=19")).body).toMatchObject({ pos: 9, head: 9, clamped: true });
		expect((await at("pos=99999999999999999999999")).body).toMatchObject({ pos: 9, clamped: true });
	});

	it("plan at T", async () => {
		writeEvents(chain(Array.from({ length: 5 }, () => ({ kind: "llm_call", data: { cost: 1 } }))));
		const wsDir = join(wsBase, "workspace");
		const ws = Workspace.open(wsDir);
		ws.append("plan.monthlyUt", 100, new Date("2026-11-06T09:00:00.000Z"));
		ws.append("plan.monthlyUt", 200, new Date("2026-11-06T10:02:00.000Z"));
		await start({ workspaceDir: wsDir });
		expect((await at("pos=1")).body.plan).toBe(100);
		expect((await at("pos=2")).body.plan).toBe(200);
		expect((await at("t=2026-11-06T10:01:30Z")).body.plan).toBe(100);
		expect((await at("pos=4")).body.plan).toBe(200);
	});

	it("plan is null while settings are off, never an error", async () => {
		writeEvents(chain([{ kind: "llm_call" }, { kind: "llm_call" }]));
		// Inside the project: settings are off.
		await start({ workspaceDir: join(tempDir, "ws") });
		const { status, body } = await at("pos=1");
		expect(status).toBe(200);
		expect(body.plan).toBeNull();
	});

	it("plan is null with a workspace that cannot be read, never an error", async () => {
		writeEvents(chain([{ kind: "llm_call" }, { kind: "llm_call" }]));
		const wsDir = join(wsBase, "workspace");
		// The settings log is a directory: reading it fails.
		mkdirSync(join(wsDir, "settings.jsonl"), { recursive: true, mode: 0o700 });
		await start({ workspaceDir: wsDir });
		const { status, body } = await at("pos=1");
		expect(status).toBe(200);
		expect(body.plan).toBeNull();
		expect(body.pos).toBe(1);
	});

	it("bad params are 400", async () => {
		await seed(3);
		await start();
		for (const q of [
			"",
			"pos=1&t=2026-11-06T10:00:00Z",
			"pos=",
			"pos=-1",
			"pos=1.5",
			"pos=1e2",
			"pos=abc",
			"pos=%201",
			"pos=1&pos=2",
			"t=",
			"t=yesterday",
			"t=2026-11-06",
			"t=2026-11-06T10:00:00",
			"t=2026-13-01T00:00:00Z",
			"t=2026-02-30T00:00:00Z",
			"t=2026-11-06T24:00:00Z",
			"t=2026-11-06 10:00:00Z",
			"t=1762423200000",
		]) {
			const { status, body } = await at(q);
			expect({ q, status }).toEqual({ q, status: 400 });
			expect(typeof body.error).toBe("string");
		}
		const post = await fetch(`http://127.0.0.1:${ui?.port}/api/at?pos=1`, { method: "POST" });
		expect(post.status).toBe(405);
	});

	it("an empty vault has no position to show", async () => {
		await start();
		expect((await at("pos=0")).status).toBe(404);
		expect((await at("t=2026-11-06T10:00:00Z")).status).toBe(404);
	});
});
