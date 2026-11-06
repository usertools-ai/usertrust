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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { verifyVault } from "../../src/audit/verify.js";
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

describe("verifyVault: a legacy log continued by the writer", () => {
	it("R2. the writer continues a legacy log at 4, and verify names all of it", async () => {
		const root = mkdtempSync(join(tmpdir(), "trust-verify-mixed-writer-"));
		dirs.push(root);
		const writer = createAuditWriter(root);
		writers.push(writer);
		// The writer created the audit directory; the legacy lines are on disk before its first append.
		const logPath = join(root, VAULT_DIR, "audit", "events.jsonl");
		writeFileSync(logPath, `${buildChain([null, null, null]).join("\n")}\n`);

		await writer.appendEvent({ kind: "test.a", actor: "sys", data: { n: 1 } });
		await writer.appendEvent({ kind: "test.a", actor: "sys", data: { n: 1 } });

		// The writer counts the legacy lines and continues after them. Pinned here as the
		// behaviour that produces a mixed log in the first place.
		const written = readFileSync(logPath, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { sequence?: unknown });
		expect(written).toHaveLength(5);
		expect(written.slice(0, 3).every((e) => e.sequence === undefined)).toBe(true);
		expect(written[3]?.sequence).toBe(4);
		expect(written[4]?.sequence).toBe(5);

		const r = verifyVault(join(root, VAULT_DIR));
		expect(r.valid).toBe(false);
		expect(r.errors).toContain(noSequence("events.jsonl", 1));
		expect(r.errors).toContain(noSequence("events.jsonl", 2));
		expect(r.errors).toContain(noSequence("events.jsonl", 3));
		expect(r.errors).toContain("Sequence starts at 4, expected 1 (leading events deleted)");
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
