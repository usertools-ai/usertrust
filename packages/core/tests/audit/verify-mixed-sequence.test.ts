// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A MIXED LOG: some events carry a `sequence`, some do not. One event without a numeric
 * `sequence` used to switch the whole vault to the sequence-less file-order walk, which skips
 * both sequence checks, so a single such line hid a leading deletion or a gap among the events
 * that do carry one.
 *
 * In a mixed log every event without a numeric `sequence` is its own error, naming its segment
 * and 1-based line, and is left out of the ordered walk: the sequence checks run over the
 * sequenced events sorted by sequence, so the deletion and the gap are still named. A log where
 * NO event carries a sequence (the legacy shape) is walked in file order as before.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyVaultReading as pkgVerifyVaultReading } from "../../../verify/src/index.js";
import { canonicalize } from "../../src/audit/canonical.js";
import { AuditSequencelessTailError, createAuditWriter } from "../../src/audit/chain.js";
import { readLedgerEvents } from "../../src/audit/read.js";
import {
	verifyVault,
	verifyVaultReading,
	verifyVaultWithAnchorsReading,
} from "../../src/audit/verify.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";

const dirs: string[] = [];
const writers: ReturnType<typeof createAuditWriter>[] = [];

afterEach(() => {
	for (const w of writers.splice(0)) {
		w.release();
	}
	for (const d of dirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

/**
 * One line per event, each hashed over its canonical form and linked to the one before it; the
 * first links to GENESIS. `null` in `sequences` builds an event with no `sequence` field at all.
 */
function buildChain(sequences: readonly (number | null)[]): string[] {
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];
	for (let i = 0; i < sequences.length; i++) {
		const seq = sequences[i];
		const event: Record<string, unknown> = {
			id: `evt-${i + 1}`,
			kind: "test.event",
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			previousHash,
			data: { n: i + 1 },
		};
		if (typeof seq === "number") event.sequence = seq;
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		lines.push(JSON.stringify({ ...event, hash }));
		previousHash = hash;
	}
	return lines;
}

/** A new vault directory holding `audit/<name>` for every entry of `segments`. */
function writeVault(segments: Record<string, readonly string[]>): string {
	const vault = mkdtempSync(join(tmpdir(), "trust-verify-mixed-"));
	dirs.push(vault);
	const auditDir = join(vault, "audit");
	mkdirSync(auditDir, { recursive: true });
	for (const [name, lines] of Object.entries(segments)) {
		writeFileSync(join(auditDir, name), `${lines.join("\n")}\n`);
	}
	return vault;
}

/** `lines` with `extra` inserted before index `at` (an index equal to the length appends). */
function insertAt(lines: readonly string[], at: number, extra: string): string[] {
	const out = [...lines];
	out.splice(at, 0, extra);
	return out;
}

const noSequence = (file: string, line: number): string =>
	`event without sequence (${file}:${line})`;
const nonObject = (file: string, line: number): string => `non-object line (${file}:${line})`;

const SEQ_START_5 = "Sequence starts at 5, expected 1 (leading events deleted)";
const GAP_4_AFTER_2 = "Sequence gap: event 4 follows 2";

const has = (errors: readonly string[], fragment: string): boolean =>
	errors.some((e) => e.includes(fragment));

describe("verifyVault: an event without a sequence in a log of sequenced events", () => {
	it("R1. a sequence-less event after sequenced ones is named with its line", () => {
		const vault = writeVault({ "events.jsonl": buildChain([1, 2, null, 4]) });
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toContain(noSequence("events.jsonl", 3));
		// The sequence-less event does not fill slot 3: the sequenced events are 1, 2, 4.
		expect(has(r.errors, GAP_4_AFTER_2)).toBe(true);
	});

	it("R9. chainLength and validHashes count only the sequenced events", () => {
		const vault = writeVault({ "events.jsonl": buildChain([1, 2, null, 4]) });
		const r = verifyVault(vault);
		expect(r.chainLength).toBe(3);
		expect(r.validHashes).toBe(3);
	});

	it("R3. a sequence-less event in a rotated segment names that segment and its line", () => {
		const chain = buildChain([1, null, 2, 3]);
		const vault = writeVault({
			// seq 1, then the sequence-less event on line 2
			"events-0001.jsonl": chain.slice(0, 2),
			"events.jsonl": chain.slice(2),
		});
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toContain(noSequence("events-0001.jsonl", 2));
		expect(r.errors.filter((e) => e.startsWith("event without sequence"))).toHaveLength(1);
	});

	it("R3. a segment name carrying a control character is scrubbed in the error", () => {
		const chain = buildChain([1, null, 2, 3]);
		const hostile = "events-\u001b[2K0001.jsonl";
		const vault = writeVault({
			[hostile]: chain.slice(0, 2),
			"events.jsonl": chain.slice(2),
		});
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toContain(noSequence("events-?[2K0001.jsonl", 2));
		expect(r.errors.some((e) => e.includes("\u001b"))).toBe(false);
	});

	it("R4. a gap among the sequenced events is named beside the sequence-less event", () => {
		const vault = writeVault({ "events.jsonl": buildChain([null, 1, 2, 4, 5]) });
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toContain(noSequence("events.jsonl", 1));
		expect(has(r.errors, GAP_4_AFTER_2)).toBe(true);
	});

	it("R5. a leading deletion is named beside the sequence-less event", () => {
		const vault = writeVault({ "events.jsonl": buildChain([5, 6, null, 7]) });
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toContain(SEQ_START_5);
		expect(r.errors).toContain(noSequence("events.jsonl", 3));
	});

	it("R7. a first sequence of 0 in a mixed log is named, never silently ordered", () => {
		const vault = writeVault({ "events.jsonl": buildChain([0, 1, 2, null]) });
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(has(r.errors, "Sequence starts at 0, expected 1")).toBe(true);
		expect(r.errors).toContain(noSequence("events.jsonl", 4));
	});

	it("R7. a sequence of 2.5 in a mixed log is named as a gap", () => {
		const vault = writeVault({ "events.jsonl": buildChain([1, 2.5, 3, null]) });
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(has(r.errors, "Sequence gap: event 2.5 follows 1")).toBe(true);
		expect(r.errors).toContain(noSequence("events.jsonl", 4));
	});

	it("R8. a non-object line, a sequence-less event and a leading deletion are all named", () => {
		// ev5, sequence-less, ev6, 42, ev7
		const lines = insertAt(buildChain([5, null, 6, 7]), 3, "42");
		const vault = writeVault({ "events.jsonl": lines });
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toContain(nonObject("events.jsonl", 4));
		expect(r.errors).toContain(noSequence("events.jsonl", 2));
		expect(r.errors).toContain(SEQ_START_5);
		// Two messages for two different faults: an auditor tells them apart by the text.
		expect(r.errors.filter((e) => e.startsWith("non-object line"))).toHaveLength(1);
		expect(r.errors.filter((e) => e.startsWith("event without sequence"))).toHaveLength(1);
	});
});

/**
 * INTENDED CHANGE. The writer used to count a sequence-less log's lines and continue after them
 * (at 4 here), which turned a sequence-less log that passes the file-order walk into a mixed log
 * that fails for good. It now refuses to continue a log whose last event has no sequence: at open
 * when the log is already there, and at the first append when the log appears after the writer
 * was made. The log keeps its bytes either way.
 */
describe("verifyVault: a legacy log the writer refuses to continue (INTENDED CHANGE)", () => {
	const legacy = () => `${buildChain([null, null, null]).join("\n")}\n`;

	it("R2. INTENDED CHANGE: the writer refuses at open to continue a legacy log; nothing is written", () => {
		const root = mkdtempSync(join(tmpdir(), "trust-verify-mixed-writer-"));
		dirs.push(root);
		const auditDir = join(root, VAULT_DIR, "audit");
		mkdirSync(auditDir, { recursive: true });
		const logPath = join(auditDir, "events.jsonl");
		writeFileSync(logPath, legacy());
		const before = readFileSync(logPath);

		let thrown: unknown;
		try {
			writers.push(createAuditWriter(root));
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(AuditSequencelessTailError);
		expect(thrown).toMatchObject({ logPath, line: 3 });

		// Nothing was written: the log's bytes, no dead-letter directory, no lock, no anchor.
		expect(readFileSync(logPath).equals(before)).toBe(true);
		expect(existsSync(join(root, VAULT_DIR, "dlq"))).toBe(false);
		expect(existsSync(join(auditDir, ".audit-writer.lock"))).toBe(false);
		expect(existsSync(`${logPath}.meta`)).toBe(false);

		// The legacy log is still the legacy shape the file-order walk accepts.
		const r = verifyVault(join(root, VAULT_DIR));
		expect(r.errors).toEqual([]);
		expect(r.valid).toBe(true);
		expect(r.chainLength).toBe(3);
	});

	it("R2. INTENDED CHANGE: a legacy log that appears after the writer opened is refused at the first append", async () => {
		const root = mkdtempSync(join(tmpdir(), "trust-verify-mixed-writer-"));
		dirs.push(root);
		const writer = createAuditWriter(root);
		writers.push(writer);
		// The writer created the audit directory; the legacy lines are on disk before its first append.
		const logPath = join(root, VAULT_DIR, "audit", "events.jsonl");
		writeFileSync(logPath, legacy());
		const before = readFileSync(logPath);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const first = await writer
			.appendEvent({ kind: "test.a", actor: "sys", data: { n: 1 } })
			.catch((e: unknown) => e);
		expect(first).toBeInstanceOf(AuditSequencelessTailError);
		expect(first).toMatchObject({ logPath, line: 3 });
		// Every later append refuses the same way: the tail is read again each time.
		const second = await writer
			.appendEvent({ kind: "test.a", actor: "sys", data: { n: 2 } })
			.catch((e: unknown) => e);
		expect(second).toBeInstanceOf(AuditSequencelessTailError);
		warn.mockRestore();

		// The degraded path, as for any failed append: counted, and each event dead-lettered.
		expect(writer.isDegraded()).toBe(true);
		expect(writer.getWriteFailures()).toBe(2);
		const letters = readFileSync(join(root, VAULT_DIR, "dlq", "dead-letters.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { source?: unknown; error?: unknown; eventHash?: unknown });
		expect(letters).toHaveLength(2);
		for (const letter of letters) {
			expect(letter.source).toBe("audit.chain.appendEvent");
			expect(String(letter.error)).toContain("not an event with a sequence (line 3)");
			expect(letter.eventHash).toBeUndefined();
		}

		// The log keeps its bytes, and still reads as the legacy shape.
		expect(readFileSync(logPath).equals(before)).toBe(true);
		const r = verifyVault(join(root, VAULT_DIR));
		expect(r.valid).toBe(true);
		expect(r.chainLength).toBe(3);
	});
});

describe("verifyVault: positive controls for the rows above", () => {
	it("R6. four sequence-less events with intact hashes and links pass in file order", () => {
		const vault = writeVault({ "events.jsonl": buildChain([null, null, null, null]) });
		const r = verifyVault(vault);
		expect(r.errors).toEqual([]);
		expect(r.valid).toBe(true);
		expect(r.chainLength).toBe(4);
		expect(r.validHashes).toBe(4);
	});

	it("R6. a sequence-less log split over a rotated segment passes in file order", () => {
		// File order is events.jsonl first, then the rotated segments by name.
		const chain = buildChain([null, null, null, null]);
		const vault = writeVault({
			"events.jsonl": chain.slice(0, 2),
			"events-0001.jsonl": chain.slice(2),
		});
		const r = verifyVault(vault);
		expect(r.errors).toEqual([]);
		expect(r.valid).toBe(true);
		expect(r.chainLength).toBe(4);
	});

	it("a fully sequenced clean chain passes", () => {
		const vault = writeVault({ "events.jsonl": buildChain([1, 2, 3, 4]) });
		const r = verifyVault(vault);
		expect(r.errors).toEqual([]);
		expect(r.valid).toBe(true);
		expect(r.chainLength).toBe(4);
	});

	it("a fully sequenced re-rooted chain names the deletion", () => {
		const vault = writeVault({ "events.jsonl": buildChain([5, 6, 7]) });
		const r = verifyVault(vault);
		expect(r.errors).toEqual([SEQ_START_5]);
	});
});

/**
 * The events a reading hands back are what every figure is built from (the spend, the transaction
 * table, the report), so they are EVERY event of the log, never only the walked ones: a figure
 * that drops an event understates the spend. Only the walk (its checks, `chainLength`,
 * `orderedHashes`) is limited to the sequenced events. In a mixed log the events come in the order
 * `readLedgerEvents` gives: the sequenced ones by sequence, then the rest in file order.
 */
describe("verifyVaultReading: the events handed back are every event of a mixed log", () => {
	const idsOf = (events: readonly { id?: unknown }[]): unknown[] => events.map((e) => e.id);
	const hashOf = (line: string): string => (JSON.parse(line) as { hash: string }).hash;

	/**
	 * Sequences 1, 2, 3 with one sequence-less event in each file. File order is events.jsonl
	 * first (evt-3, evt-4, evt-5), then events-0001.jsonl (evt-1, evt-2).
	 */
	function mixedVault(): { vault: string; chain: string[] } {
		const chain = buildChain([1, null, 2, null, 3]);
		const vault = writeVault({
			"events-0001.jsonl": chain.slice(0, 2),
			"events.jsonl": chain.slice(2),
		});
		return { vault, chain };
	}

	it("E1. events holds every event: the sequenced ones by sequence, then the rest in file order", () => {
		const { vault } = mixedVault();
		const reading = verifyVaultReading(vault);
		expect(idsOf(reading.events)).toEqual(["evt-1", "evt-3", "evt-5", "evt-4", "evt-2"]);
	});

	it("E1. the walk is still only the sequenced events", () => {
		const { vault, chain } = mixedVault();
		const reading = verifyVaultReading(vault);
		expect(reading.orderedHashes).toEqual([
			hashOf(chain[0] as string),
			hashOf(chain[2] as string),
			hashOf(chain[4] as string),
		]);
		expect(reading.result.chainLength).toBe(3);
		expect(reading.result.validHashes).toBe(3);
		expect(reading.result.errors).toContain(noSequence("events.jsonl", 2));
		expect(reading.result.errors).toContain(noSequence("events-0001.jsonl", 2));
	});

	it("E2. a mixed log: the reading's events are exactly what readLedgerEvents returns", () => {
		const { vault } = mixedVault();
		expect(verifyVaultReading(vault).events).toEqual(readLedgerEvents(vault));
	});

	it("E3. the anchored reading hands back the same full set", () => {
		const { vault } = mixedVault();
		const anchored = verifyVaultWithAnchorsReading(vault);
		expect(idsOf(anchored.events)).toEqual(["evt-1", "evt-3", "evt-5", "evt-4", "evt-2"]);
		expect(anchored.events).toEqual(verifyVaultReading(vault).events);
	});

	it("E4. a non-object line is still not an event: the full set holds objects only", () => {
		// ev5, sequence-less, ev6, 42, ev7
		const vault = writeVault({
			"events.jsonl": insertAt(buildChain([5, null, 6, 7]), 3, "42"),
		});
		const reading = verifyVaultReading(vault);
		expect(idsOf(reading.events)).toEqual(["evt-1", "evt-3", "evt-4", "evt-2"]);
		expect(reading.result.chainLength).toBe(3);
	});

	it("E5. positive control: a log with no sequence at all hands back every event in file order", () => {
		const chain = buildChain([null, null, null, null]);
		const vault = writeVault({
			"events.jsonl": chain.slice(0, 2),
			"events-0001.jsonl": chain.slice(2),
		});
		const reading = verifyVaultReading(vault);
		expect(idsOf(reading.events)).toEqual(["evt-1", "evt-2", "evt-3", "evt-4"]);
		expect(reading.result.chainLength).toBe(4);
	});

	it("E6. positive control: a fully sequenced log hands back every event sorted", () => {
		const chain = buildChain([1, 2, 3, 4]);
		const vault = writeVault({
			"events-0001.jsonl": chain.slice(0, 2),
			"events.jsonl": chain.slice(2),
		});
		const reading = verifyVaultReading(vault);
		expect(idsOf(reading.events)).toEqual(["evt-1", "evt-2", "evt-3", "evt-4"]);
		expect(reading.result.chainLength).toBe(4);
		expect(reading.result.valid).toBe(true);
	});
});

/**
 * THE INVARIANT every consumer of a reading relies on: `events` is the walked list (the sequenced
 * events, sorted) FOLLOWED BY the sequence-less events in file order. So `events[i]` is walked
 * event `i` (its hash is `orderedHashes[i]`) for every `i < chainLength`, and an index at or past
 * `chainLength` has no leaf. Held by both packages.
 */
describe.each([
	["core", verifyVaultReading],
	["package", pkgVerifyVaultReading],
] as const)("verifyVaultReading (%s): the walked events are the prefix of events", (_n, read) => {
	/** The reading with its events typed alike for both packages. */
	const readOf = (vault: string) => {
		const r = read(vault);
		return {
			events: r.events as unknown as readonly Record<string, unknown>[],
			orderedHashes: r.orderedHashes,
			chainLength: r.result.chainLength,
		};
	};
	const ids = (events: readonly Record<string, unknown>[]): unknown[] => events.map((e) => e.id);

	function mixedVault(): string {
		// events-0001.jsonl: evt-1 (1), evt-2 (none); events.jsonl: evt-3 (2), evt-4 (none), evt-5 (3)
		const chain = buildChain([1, null, 2, null, 3]);
		return writeVault({
			"events-0001.jsonl": chain.slice(0, 2),
			"events.jsonl": chain.slice(2),
		});
	}

	it("I1. the first chainLength events are the walked ones, in order, with their own hashes", () => {
		const r = readOf(mixedVault());
		expect(r.orderedHashes).toHaveLength(3);
		expect(r.chainLength).toBe(r.orderedHashes.length);
		const walked = r.events.slice(0, r.chainLength);
		expect(ids(walked)).toEqual(["evt-1", "evt-3", "evt-5"]);
		expect(walked.map((e) => e.hash)).toEqual(r.orderedHashes);
	});

	it("I2. the events past chainLength are the sequence-less ones, in file order", () => {
		const r = readOf(mixedVault());
		const rest = r.events.slice(r.chainLength);
		expect(ids(rest)).toEqual(["evt-4", "evt-2"]);
		expect(rest.every((e) => e.sequence === undefined)).toBe(true);
		expect(rest.some((e) => r.orderedHashes.includes(e.hash as string))).toBe(false);
	});

	it("I3. positive control: in a log with no sequence at all every event is walked", () => {
		const r = readOf(writeVault({ "events.jsonl": buildChain([null, null, null]) }));
		expect(r.events).toHaveLength(r.chainLength);
		expect(r.events.map((e) => e.hash)).toEqual(r.orderedHashes);
	});
});
