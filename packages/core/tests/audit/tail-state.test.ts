// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The audit tail's ONE classification (`tail-state.ts`), on its own: every state of the decision
 * order from a synthetic snapshot built for it (each fixture's event hashed exactly as the writer
 * hashes it, so a row reaches the state it names and not an earlier refusal), what the writer does in
 * each, and a seeded property run over generated snapshots, malformed and unhashable inputs among them:
 * exactly one state each, and never a throw.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import {
	classifyAuditTail,
	type FileObservation,
	type InventoryObservation,
	type LogObservation,
	type TailSnapshot,
	type TailState,
	type TailStateName,
	writerAction,
} from "../../src/audit/tail-state.js";
import { GENESIS_HASH } from "../../src/shared/constants.js";

type Event = Record<string, unknown> & { hash: string; previousHash: string };

/** An event as the writer persists it: hashed over its canonical form without `hash`. */
function event(
	previousHash: string,
	sequence: number | undefined,
	extra: Record<string, unknown> = {},
): Event {
	const body: Record<string, unknown> = {
		id: `e${sequence ?? "legacy"}-${previousHash.slice(0, 6)}`,
		timestamp: "2026-10-12T00:00:00.000Z",
		previousHash,
		kind: "llm_call",
		actor: "local",
		data: { n: sequence ?? 0, ...extra },
		...(sequence === undefined ? {} : { sequence }),
	};
	const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
	return { ...body, hash } as Event;
}

/** A chain of `n` sequenced events from genesis. */
function chain(n: number): Event[] {
	const out: Event[] = [];
	let prev = GENESIS_HASH;
	for (let i = 1; i <= n; i++) {
		const e = event(prev, i);
		out.push(e);
		prev = e.hash;
	}
	return out;
}

const line = (e: unknown) => Buffer.from(JSON.stringify(e));
const ok = (names: string[] = ["events.jsonl", "events.jsonl.meta"]): InventoryObservation => ({
	kind: "ok",
	names,
});
const anchorOf = (sequence: number, lastHash: string): FileObservation => ({
	kind: "read",
	bytes: Buffer.from(JSON.stringify({ lastHash, sequence })),
});

/** A log observation of these complete lines (all of them: `fromStart`), and optional trailing bytes. */
function logOf(lines: Buffer[], trailing = ""): LogObservation {
	return {
		kind: "tail",
		tail: {
			lines,
			fromStart: true,
			trailing: Buffer.from(trailing),
			trailingOffset: lines.reduce((n, l) => n + l.length + 1, 0),
		},
	};
}

function classify(
	log: LogObservation,
	anchor: FileObservation,
	over: Partial<TailSnapshot> = {},
	mode: "writer" | "reader" = "writer",
): TailState {
	return classifyAuditTail(
		{ audit: ok(), quarantine: { kind: "missing" }, log, anchor, ...over },
		mode,
	);
}

const absent: FileObservation = { kind: "absent" };

describe("the classification: every state of the decision order, from a snapshot built for it", () => {
	const three = chain(3);
	const head = three[2] as Event;
	const rows: Array<[TailStateName, () => TailState]> = [
		[
			"INVENTORY_UNREADABLE",
			() => classify(logOf([]), absent, { audit: { kind: "unreadable", code: "EACCES" } }),
		],
		[
			"RECOVERY_PENDING",
			() => classify(logOf([]), absent, { quarantine: { kind: "ok", names: ["PENDING"] } }),
		],
		["LOG_UNREADABLE", () => classify({ kind: "unavailable", code: "EIO" }, absent)],
		["LOG_NOT_REGULAR", () => classify({ kind: "not_regular", fileKind: "fifo" }, absent)],
		["TAIL_OVERSIZE", () => classify({ kind: "oversize", size: 1 << 25 }, absent)],
		[
			"SEGMENTED",
			() => classify(logOf([]), absent, { audit: ok(["events.jsonl", "events-1.jsonl"]) }),
		],
		[
			"ANCHOR_UNREADABLE",
			() => classify(logOf([]), { kind: "read", bytes: Buffer.from("not json") }),
		],
		["FRESH", () => classify({ kind: "absent" }, absent)],
		["LOG_EMPTY_ANCHOR_RECORDS_EVENTS", () => classify(logOf([]), anchorOf(3, head.hash))],
		["TAIL_UNPARSEABLE", () => classify(logOf([Buffer.from("{nope")]), absent)],
		["TAIL_NOT_AN_EVENT", () => classify(logOf([Buffer.from("null")]), absent)],
		[
			"TAIL_MALFORMED",
			() => classify(logOf([line({ ...head, sequence: "3" })]), anchorOf(3, head.hash)),
		],
		[
			"CORRUPT_TAIL",
			() => classify(logOf([line({ ...head, data: { n: 99 } })]), anchorOf(3, head.hash)),
		],
		["ONE_PAST_ANCHOR", () => classify(logOf([line(three[0])]), absent)],
		["ANCHOR_MISSING", () => classify(logOf(three.map(line)), absent)],
		["MATCH", () => classify(logOf(three.map(line)), anchorOf(3, head.hash))],
		["HEAD_MISMATCH", () => classify(logOf(three.map(line)), anchorOf(3, "f".repeat(64)))],
		[
			"FEWER_THAN_ANCHOR",
			() => classify(logOf(three.slice(0, 2).map(line)), anchorOf(3, head.hash)),
		],
		[
			"UNCHAINED_PAST_ANCHOR",
			// Correctly hashed, wrongly linked: the event past the anchor names another predecessor.
			() => {
				const stray = event("e".repeat(64), 3);
				return classify(
					logOf([...three.slice(0, 2), stray].map(line)),
					anchorOf(2, (three[1] as Event).hash),
				);
			},
		],
		[
			"MORE_THAN_ONE_PAST_ANCHOR",
			() => classify(logOf(three.map(line)), anchorOf(1, (three[0] as Event).hash)),
		],
		[
			"SEQUENCE_EXHAUSTED",
			() => {
				const last = event(GENESIS_HASH, Number.MAX_SAFE_INTEGER);
				return classify(
					{
						kind: "tail",
						tail: {
							lines: [line(last)],
							fromStart: false,
							trailing: Buffer.alloc(0),
							trailingOffset: 0,
						},
					},
					anchorOf(Number.MAX_SAFE_INTEGER, last.hash),
				);
			},
		],
	];

	for (const [state, run] of rows) {
		it(state, () => {
			expect(run().state).toBe(state);
		});
	}

	it("CORRUPT_TAIL, never a throw, for an event canonicalization refuses (a nested 1e400 parses to Infinity)", () => {
		const raw = Buffer.from(
			`{"hash":"${"a".repeat(64)}","previousHash":"${GENESIS_HASH}","sequence":1,"data":{"x":1e400}}`,
		);
		let s: TailState | undefined;
		expect(() => {
			s = classify(logOf([raw]), anchorOf(1, "a".repeat(64)));
		}).not.toThrow();
		expect(s?.state).toBe("CORRUPT_TAIL");
	});

	it("ONE_PAST_ANCHOR also covers the event one past a valid anchor that chains from it", () => {
		const s = classify(logOf(three.map(line)), anchorOf(2, (three[1] as Event).hash));
		expect(s.state).toBe("ONE_PAST_ANCHOR");
		expect(s.found).toEqual({ sequence: 3, hash: head.hash });
		expect(writerAction(s)).toBe("roll_forward");
	});

	it("a legacy chain (events without a sequence) is classified at its line positions when counted", () => {
		const a = event(GENESIS_HASH, undefined);
		const b = event(a.hash, undefined);
		const s = classifyAuditTail(
			{
				audit: ok(),
				quarantine: { kind: "missing" },
				log: {
					kind: "tail",
					tail: {
						lines: [line(a), line(b)],
						fromStart: false,
						count: 2,
						trailing: Buffer.alloc(0),
						trailingOffset: 0,
					},
				},
				anchor: anchorOf(2, b.hash),
			},
			"writer",
		);
		expect(s.state).toBe("MATCH");
	});

	it("bytes after the last newline travel with the state as `torn`, by kind, and the writer refuses them in every state", () => {
		for (const [trailing, kind] of [
			['{"cut', "fragment"],
			["null", "non_event"],
			[JSON.stringify(event(head.hash, 4)), "unterminated_event"],
		] as const) {
			const s = classify(logOf(three.map(line), trailing), anchorOf(3, head.hash));
			expect(s.state).toBe("MATCH");
			expect(s.torn?.kind).toBe(kind);
			expect(writerAction(s)).toBe("refuse");
		}
	});

	it("reader mode does not refuse a rotated vault (the caller hands it the global chain)", () => {
		expect(
			classify(
				logOf(three.map(line)),
				anchorOf(3, head.hash),
				{ audit: ok(["events.jsonl", "events-1.jsonl"]) },
				"reader",
			).state,
		).toBe("MATCH");
	});
});

describe("what the writer does in each state", () => {
	it("goes on only from FRESH and MATCH, rolls ONE_PAST_ANCHOR forward, and refuses every other state", () => {
		const proceed: TailStateName[] = ["FRESH", "MATCH"];
		const all: TailStateName[] = [
			"INVENTORY_UNREADABLE",
			"RECOVERY_PENDING",
			"LOG_UNREADABLE",
			"LOG_NOT_REGULAR",
			"TAIL_OVERSIZE",
			"SEGMENTED",
			"ANCHOR_UNREADABLE",
			"FRESH",
			"LOG_EMPTY_ANCHOR_RECORDS_EVENTS",
			"TAIL_UNPARSEABLE",
			"TAIL_NOT_AN_EVENT",
			"TAIL_MALFORMED",
			"CORRUPT_TAIL",
			"ONE_PAST_ANCHOR",
			"ANCHOR_MISSING",
			"MATCH",
			"HEAD_MISMATCH",
			"FEWER_THAN_ANCHOR",
			"UNCHAINED_PAST_ANCHOR",
			"MORE_THAN_ONE_PAST_ANCHOR",
			"SEQUENCE_EXHAUSTED",
		];
		for (const state of all) {
			const action = writerAction({ state, torn: null, found: null, anchored: null, note: "" });
			expect(action, state).toBe(
				proceed.includes(state)
					? "proceed"
					: state === "ONE_PAST_ANCHOR"
						? "roll_forward"
						: "refuse",
			);
		}
	});
});

describe("property: every generated snapshot gets exactly one named state, and the classifier never throws", () => {
	/** A small seeded PRNG (mulberry32): the same run every time, any failure reproducible by its seed. */
	function rng(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	it("10 000 snapshots from seed 20261012", () => {
		const r = rng(20261012);
		const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
		const base = chain(4);
		const weird: unknown[] = [
			null,
			true,
			1,
			"s",
			[],
			{},
			{ hash: 1, previousHash: 2 },
			{ hash: "x" },
			{ ...base[0], sequence: 1.5 },
			{ ...base[0], sequence: 2 ** 53 },
			{ ...base[0], sequence: "1" },
		];
		const seen = new Set<TailStateName>();
		for (let i = 0; i < 10_000; i++) {
			const n = Math.floor(r() * 5);
			const lines: Buffer[] = [];
			for (let k = 0; k < n; k++) {
				const roll = r();
				lines.push(
					roll < 0.6
						? line(base[Math.min(k, 3)])
						: roll < 0.8
							? line(pick(weird))
							: Buffer.from(
									pick([
										"",
										"{",
										"not json",
										"1e400",
										"[1,2",
										`{"hash":"${"a".repeat(64)}","previousHash":"${GENESIS_HASH}","data":{"x":1e400}}`,
									]),
								),
				);
			}
			const anchor: FileObservation = pick<FileObservation>([
				{ kind: "absent" },
				{ kind: "unavailable", code: "EIO" },
				{ kind: "not_regular", fileKind: "symlink" },
				{ kind: "oversize", size: 5000 },
				anchorOf(Math.floor(r() * 6), pick([GENESIS_HASH, base[1]?.hash ?? "", "z".repeat(64)])),
				{
					kind: "read",
					bytes: Buffer.from(pick(["{}", "[]", "null", '{"lastHash":"a","sequence":-1}'])),
				},
			]);
			const snapshot: TailSnapshot = {
				audit: pick<InventoryObservation>([
					ok(),
					ok(["events.jsonl", "x.jsonl"]),
					{ kind: "unreadable", code: "EACCES" },
				]),
				quarantine: pick<InventoryObservation>([{ kind: "missing" }, ok(["PENDING"]), ok([])]),
				log: pick<LogObservation>([
					{ kind: "absent" },
					{ kind: "unavailable", code: "EIO" },
					logOf(lines, pick(["", "{", "null", "x"])),
					{
						kind: "tail",
						tail: { lines, fromStart: false, trailing: Buffer.alloc(0), trailingOffset: 0 },
					},
				]),
				anchor,
			};
			let state: TailState | undefined;
			expect(() => {
				state = classifyAuditTail(snapshot, r() < 0.5 ? "writer" : "reader");
			}).not.toThrow();
			expect(typeof state?.state).toBe("string");
			expect(() => writerAction(state as TailState)).not.toThrow();
			seen.add((state as TailState).state);
		}
		// The run reaches most of the decision order: a generator that produced only one state would
		// pass the two checks above while testing almost nothing.
		expect(seen.size).toBeGreaterThanOrEqual(14);
	});
});
