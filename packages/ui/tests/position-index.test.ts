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
import type { PersistedAuditEvent } from "usertrust";
import { canonicalize } from "usertrust-verify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { PositionIndex } from "../src/server/position-index.js";
import { createUiServer, type UiServer } from "../src/server/server.js";
import { loadState } from "../src/server/state.js";
import { isHeaderSpend } from "../src/shared/aggregate.js";

const GENESIS = "0".repeat(64);
const T0 = Date.parse("2026-11-06T10:00:00.000Z");

/** A hash-linked chain as a writer that records no `sequence` would persist it, one event per spec. */
function chain(
	specs: ReadonlyArray<{ kind: string; data?: Record<string, unknown>; timestamp?: string }>,
): PersistedAuditEvent[] {
	let previousHash = GENESIS;
	return specs.map((s, i) => {
		const rest = {
			actor: "local",
			data: s.data ?? {},
			id: `evt-${i}`,
			kind: s.kind,
			previousHash,
			timestamp: s.timestamp ?? new Date(T0 + i * 1000).toISOString(),
		};
		const hash = createHash("sha256").update(canonicalize(rest)).digest("hex");
		previousHash = hash;
		return { ...rest, hash } as PersistedAuditEvent;
	});
}

/** A mix of costed calls, uncosted calls and denials, deterministic from `n`. */
function mixed(n: number): PersistedAuditEvent[] {
	const specs = [];
	for (let i = 0; i < n; i++) {
		const r = (i * 7919) % 5;
		if (r === 0 || r === 1) specs.push({ kind: "llm_call", data: { cost: ((i * 31) % 97) + 0.1 } });
		else if (r === 2) specs.push({ kind: "llm_call", data: {} });
		else if (r === 3) specs.push({ kind: "policy_denied", data: { cost: 50 } });
		else specs.push({ kind: "tool_use", data: { cost: 3 } });
	}
	return chain(specs);
}

function indexOf(events: readonly PersistedAuditEvent[]): PositionIndex {
	const index = new PositionIndex();
	for (const e of events) index.add(e);
	return index;
}

describe("PositionIndex", () => {
	it("prefix spend matches a naive sum", () => {
		const events = mixed(1000);
		const index = indexOf(events);
		expect(index.length).toBe(1000);
		let naive = 0;
		let llm = 0;
		let denied = 0;
		for (let p = 0; p < events.length; p++) {
			const e = events[p] as PersistedAuditEvent;
			if (isHeaderSpend(e.kind, e.data.cost)) naive += e.data.cost;
			if (e.kind === "llm_call") llm += 1;
			if (e.kind === "policy_denied") denied += 1;
			expect(index.spentUtAt(p)).toBe(naive);
			expect(index.countsAt(p)).toEqual({ llm_call: llm, denied, other: p + 1 - llm - denied });
			expect(index.tsAt(p)).toBe(e.timestamp);
		}
	});

	it("positions ignore sequence", () => {
		const events = chain([{ kind: "llm_call" }, { kind: "llm_call" }, { kind: "policy_denied" }]);
		for (const e of events) expect(e.sequence).toBeUndefined();
		const index = new PositionIndex();
		expect(events.map((e) => index.add(e))).toEqual([0, 1, 2]);
		expect(index.length).toBe(3);
	});

	it("positionAt with out-of-order ts", () => {
		const index = indexOf(
			chain([
				{ kind: "llm_call", timestamp: "2026-11-06T10:00:00.000Z" },
				{ kind: "llm_call", timestamp: "2026-11-06T09:59:00.000Z" },
				{ kind: "llm_call", timestamp: "2026-11-06T10:02:00.000Z" },
			]),
		);
		expect(index.positionAt("2026-11-06T10:01:00.000Z")).toBe(1);
		expect(index.positionAt("2026-11-06T09:00:00.000Z")).toBeNull();
		expect(index.positionAt("2026-11-06T10:02:00.000Z")).toBe(2);
		// 10:00Z, written with an offset: compared as an instant, never as text.
		expect(index.positionAt("2026-11-06T12:00:00+02:00")).toBe(1);
		expect(index.positionAt("2026-11-06T11:00:00+02:00")).toBeNull();
		// Each event keeps its own recorded time; only the search runs over the running max.
		expect(index.tsAt(1)).toBe("2026-11-06T09:59:00.000Z");
	});

	it("positionAt refuses a time with no zone, and one that does not parse", () => {
		const index = indexOf(chain([{ kind: "llm_call" }]));
		expect(() => index.positionAt("2026-11-06T10:01:00")).toThrow(RangeError);
		expect(() => index.positionAt("not a time")).toThrow(RangeError);
		// A date alone ends in digits an offset would end in; it names no time and no zone.
		expect(() => index.positionAt("2026-11-06")).toThrow(RangeError);
		expect(() => index.positionAt("2026-11-06T10:01:00+0200")).toThrow(RangeError);
		expect(new PositionIndex().positionAt("2026-11-06T10:01:00.000Z")).toBeNull();
	});

	it("tsAt gives back a recorded time that is not in toISOString form, or does not parse", () => {
		const index = indexOf(
			chain([
				{ kind: "llm_call", timestamp: "2026-11-06T12:00:00+02:00" },
				{ kind: "llm_call", timestamp: "garbled" },
				{ kind: "llm_call", timestamp: "2026-11-06T10:05:00.000Z" },
			]),
		);
		expect([0, 1, 2].map((p) => index.tsAt(p))).toEqual([
			"2026-11-06T12:00:00+02:00",
			"garbled",
			"2026-11-06T10:05:00.000Z",
		]);
		// An unparseable time does not move the running max.
		expect(index.positionAt("2026-11-06T10:01:00.000Z")).toBe(1);
	});

	it("a position outside the index is a RangeError", () => {
		const index = indexOf(chain([{ kind: "llm_call", data: { cost: 1 } }]));
		for (const p of [-1, 1, 0.5, Number.NaN]) {
			expect(() => index.spentUtAt(p)).toThrow(RangeError);
			expect(() => index.countsAt(p)).toThrow(RangeError);
			expect(() => index.tsAt(p)).toThrow(RangeError);
		}
	});

	it("grows past initial capacity", () => {
		const n = 70_000;
		const index = new PositionIndex();
		let naive = 0;
		let previousHash = GENESIS;
		for (let i = 0; i < n; i++) {
			const cost = (i % 13) + 0.25;
			const e = {
				actor: "local",
				data: { cost },
				id: `e${i}`,
				kind: i % 3 === 0 ? "policy_denied" : "llm_call",
				previousHash,
				timestamp: new Date(T0 + i).toISOString(),
				hash: `h${i}`,
			} as PersistedAuditEvent;
			previousHash = e.hash;
			if (isHeaderSpend(e.kind, e.data.cost)) naive += cost;
			expect(index.add(e)).toBe(i);
		}
		expect(index.length).toBe(n);
		expect(index.spentUtAt(n - 1)).toBe(naive);
		const denied = Math.ceil(n / 3);
		expect(index.countsAt(n - 1)).toEqual({ llm_call: n - denied, denied, other: 0 });
		expect(index.tsAt(n - 1)).toBe(new Date(T0 + n - 1).toISOString());
		expect(index.positionAt(new Date(T0 + 65_536).toISOString())).toBe(65_536);
	});
});

describe("PositionIndex in loadState", () => {
	let tempDir: string;
	let vaultPath: string;
	let logPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-pos-"));
		vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		logPath = join(vaultPath, "audit", "events.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function seed(count: number): Promise<void> {
		const writer = createAuditWriter(tempDir);
		for (let i = 0; i < count; i++) {
			await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost: i + 1 } });
		}
		writer.release();
	}

	it("loadState sets row.pos", async () => {
		await seed(5);
		const all = loadState(vaultPath);
		expect(all.rows.map((r) => r.pos)).toEqual([0, 1, 2, 3, 4]);
		expect(all.positions.length).toBe(5);
		expect(all.positions.spentUtAt(4)).toBe(all.summary.spentUt);
		const capped = loadState(vaultPath, 3);
		expect(capped.rows.map((r) => r.pos)).toEqual([2, 3, 4]);
		// The index covers the whole vault, not only the rows held.
		expect(capped.positions.length).toBe(5);
		expect(capped.positions.spentUtAt(1)).toBe(3);
	});

	it("an unparseable line takes no position", () => {
		const events = chain([
			{ kind: "llm_call", data: { cost: 1 } },
			{ kind: "llm_call", data: { cost: 2 } },
			{ kind: "llm_call", data: { cost: 4 } },
			{ kind: "llm_call", data: { cost: 8 } },
			{ kind: "llm_call", data: { cost: 16 } },
		]);
		const lines = events.map((e) => JSON.stringify(e));
		writeFileSync(
			logPath,
			`${[...lines.slice(0, 3), "{ not json", ...lines.slice(3)].join("\n")}\n`,
		);
		const state = loadState(vaultPath);
		expect(state.positions.length).toBe(5);
		expect(state.rows.map((r) => r.pos)).toEqual([0, 1, 2, 3, 4]);
		expect(state.rows.map((r) => r.id)).toEqual(events.map((e) => e.id));
		expect([0, 1, 2, 3, 4].map((p) => state.positions.spentUtAt(p))).toEqual([1, 3, 7, 15, 31]);
		// The verifier's list holds the same five events: a break it finds indexes the same positions.
		expect(state.summary.chain.events).toBe(5);
	});

	it("positions ignore sequence in a vault whose events carry none", () => {
		const events = chain([{ kind: "llm_call" }, { kind: "policy_denied" }, { kind: "llm_call" }]);
		writeFileSync(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
		const state = loadState(vaultPath);
		expect(state.summary.chain.breakIndex).toBeNull();
		expect(state.rows.map((r) => [r.seq, r.pos, r.id])).toEqual([
			[null, 0, "evt-0"],
			[null, 1, "evt-1"],
			[null, 2, "evt-2"],
		]);
		expect(state.positions.countsAt(2)).toEqual({ llm_call: 2, denied: 1, other: 0 });
	});
});

describe("PositionIndex on the live tail", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-pos-tail-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function append(count: number): Promise<void> {
		const writer = createAuditWriter(tempDir);
		for (let i = 0; i < count; i++) {
			await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost: 2 } });
		}
		writer.release();
	}

	/** Opens the tail, runs `act`, and gives the `pos` of every row in the first `rows` frame, or the frame names. */
	async function nextRows(port: number, act: () => Promise<void>): Promise<number[] | string[]> {
		const res = await fetch(`http://127.0.0.1:${port}/api/tail`);
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await act();
		const decoder = new TextDecoder();
		const names: string[] = [];
		let buffer = "";
		const deadline = Date.now() + 8000;
		try {
			while (Date.now() < deadline) {
				const next = await Promise.race([
					reader.read(),
					new Promise<undefined>((r) => setTimeout(() => r(undefined), deadline - Date.now())),
				]);
				if (next === undefined || next.done) break;
				buffer += decoder.decode(next.value, { stream: true });
				const blocks = buffer.split("\n\n");
				buffer = blocks.pop() ?? "";
				for (const block of blocks) {
					const name = /event: (.+)/.exec(block)?.[1];
					if (name === undefined) continue;
					names.push(name);
					if (name === "rows") {
						const data = /data: (.+)/.exec(block)?.[1] ?? "[]";
						return (JSON.parse(data) as Array<{ pos: number }>).map((r) => r.pos);
					}
					if (name === "resync") return names;
				}
			}
		} finally {
			await reader.cancel();
		}
		return names;
	}

	it("each verified append extends the index: the appended rows carry the next positions", async () => {
		await append(3);
		ui = await createUiServer(tempDir, { port: 0 });
		const port = ui.port;
		expect(await nextRows(port, () => append(1))).toEqual([3]);
		expect(await nextRows(port, () => append(2))).toEqual([4, 5]);
		const { rows } = (await (await fetch(`http://127.0.0.1:${port}/api/events`)).json()) as {
			rows: Array<{ pos: number }>;
		};
		expect(rows.map((r) => r.pos)).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("an append whose sequence is not above the last is a full reload: positions are what a reload gives", async () => {
		await append(3);
		ui = await createUiServer(tempDir, { port: 0 });
		const port = ui.port;
		const vaultPath = join(tempDir, ".usertrust");
		const logPath = join(vaultPath, "audit", "events.jsonl");
		// Links onto the tip, so linkage and the hash pass; the reader would sort it to second place by its sequence.
		const tip = JSON.parse(readFileSync(logPath, "utf-8").trim().split("\n").at(-1) as string) as {
			hash: string;
			[k: string]: unknown;
		};
		const { hash: _tipHash, ...shape } = tip;
		const rest = {
			...shape,
			id: "late-sequence",
			previousHash: tip.hash,
			sequence: 1,
			timestamp: new Date().toISOString(),
		};
		const hash = createHash("sha256").update(canonicalize(rest)).digest("hex");
		appendFileSync(logPath, `${canonicalize({ ...rest, hash })}\n`);
		type Snapshot = {
			rows: Array<{ id: string; pos: number }>;
			summary: { chain: { valid: boolean } };
		};
		let snapshot: Snapshot | undefined;
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			snapshot = (await (await fetch(`http://127.0.0.1:${port}/api/events`)).json()) as Snapshot;
			if (snapshot.rows.length === 4) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const fresh = loadState(vaultPath);
		expect(snapshot?.rows.map((r) => [r.id, r.pos])).toEqual(fresh.rows.map((r) => [r.id, r.pos]));
		expect(snapshot?.rows.find((r) => r.id === "late-sequence")?.pos).toBe(1);
		expect(snapshot?.summary.chain.valid).toBe(false);
	});

	it("a resync rebuilds the index from the whole vault", async () => {
		await append(2);
		ui = await createUiServer(tempDir, { port: 0 });
		// A line that is not JSON takes no position; the events after it take the next ones.
		appendFileSync(join(tempDir, ".usertrust", "audit", "events.jsonl"), "{ not json\n");
		await append(1);
		ui.reload();
		const { rows } = (await (await fetch(`http://127.0.0.1:${ui.port}/api/events`)).json()) as {
			rows: Array<{ pos: number }>;
		};
		expect(rows.map((r) => r.pos)).toEqual([0, 1, 2]);
	});
});
