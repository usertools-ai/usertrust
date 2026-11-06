// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A LINE THAT PARSES BUT IS NOT AN EVENT. `42`, `[]`, `null`, `"x"` and `true` are all valid JSON,
 * and none is a JSON object. Walked as an event, such a line has no `sequence`, and one event with
 * no `sequence` switched the whole vault to the sequence-less file-order walk, which skips both
 * sequence checks. A vault whose leading events were deleted (the chain re-rooted at sequence 5)
 * then reported only a hash mismatch on the stray line, and never named the deletion.
 *
 * A non-object line is its own error, naming its segment and 1-based line, and is never walked: the
 * sequence checks run over the events that remain, so the deletion and the gap are still named.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { verifyVault } from "../../src/audit/verify.js";
import { GENESIS_HASH } from "../../src/shared/constants.js";

const dirs: string[] = [];

afterEach(() => {
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
	const vault = mkdtempSync(join(tmpdir(), "trust-verify-nonobject-"));
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

const nonObject = (file: string, line: number): string => `non-object line (${file}:${line})`;

const SEQ_START_5 = "Sequence starts at 5, expected 1";
const GAP_4_AFTER_2 = "Sequence gap: event 4 follows 2";

/** Every JSON value that parses and is not an object, as the raw text of a line. */
const GARBAGE = ["42", "[]", "null", '"x"', "true"] as const;

/** Where the stray line goes in a four-event segment, and the 1-based line it then occupies. */
const POSITIONS = [
	{ where: "the first line", at: 0, line: 1 },
	{ where: "the middle (between events 2 and 3)", at: 2, line: 3 },
	{ where: "the last line", at: 4, line: 5 },
] as const;

const GRID = GARBAGE.flatMap((garbage) =>
	POSITIONS.map((p) => ({ garbage, where: p.where, at: p.at, line: p.line })),
);

describe("verifyVault: a leading deletion is named even with a non-object line in the log", () => {
	it.each(GRID)(
		"a $garbage line at $where: the deletion and the line are both named",
		({ garbage, at, line }) => {
			const vault = writeVault({
				"events.jsonl": insertAt(buildChain([5, 6, 7, 8]), at, garbage),
			});
			const r = verifyVault(vault);
			expect(r.valid).toBe(false);
			expect(r.errors.some((e) => e.includes(SEQ_START_5))).toBe(true);
			expect(r.errors).toContain(nonObject("events.jsonl", line));
			// Nothing else is wrong with this vault: its hashes and links are intact.
			expect(r.errors).toHaveLength(2);
			expect(r.chainLength).toBe(4);
			expect(r.validHashes).toBe(4);
		},
	);
});

describe("verifyVault: a sequence gap is named even with a non-object line in the log", () => {
	it.each(GRID)(
		"a $garbage line at $where: the gap and the line are both named",
		({ garbage, at, line }) => {
			const vault = writeVault({
				"events.jsonl": insertAt(buildChain([1, 2, 4, 5]), at, garbage),
			});
			const r = verifyVault(vault);
			expect(r.valid).toBe(false);
			expect(r.errors.some((e) => e.includes(GAP_4_AFTER_2))).toBe(true);
			expect(r.errors).toContain(nonObject("events.jsonl", line));
			expect(r.errors).toHaveLength(2);
			expect(r.chainLength).toBe(4);
			expect(r.validHashes).toBe(4);
		},
	);
});

describe("verifyVault: a non-object line in an otherwise intact chain", () => {
	it("a 42 line between events 2 and 3 of a clean chain is the one and only error", () => {
		const vault = writeVault({
			"events.jsonl": insertAt(buildChain([1, 2, 3, 4]), 2, "42"),
		});
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toEqual([nonObject("events.jsonl", 3)]);
		expect(r.chainLength).toBe(4);
		expect(r.validHashes).toBe(4);
	});
});

describe("verifyVault: positive controls for the rows above", () => {
	it("the leading-deletion vault with no stray line reports the deletion", () => {
		const vault = writeVault({ "events.jsonl": buildChain([5, 6, 7, 8]) });
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain(SEQ_START_5);
	});

	it("the gap vault with no stray line reports the gap", () => {
		const vault = writeVault({ "events.jsonl": buildChain([1, 2, 4, 5]) });
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain(GAP_4_AFTER_2);
	});

	it("four sequence-less events with intact hashes and links still pass in file order", () => {
		const vault = writeVault({ "events.jsonl": buildChain([null, null, null, null]) });
		const r = verifyVault(vault);
		expect(r.errors).toEqual([]);
		expect(r.valid).toBe(true);
		expect(r.chainLength).toBe(4);
		expect(r.validHashes).toBe(4);
	});
});

describe("verifyVault: an unparseable line and a non-object line are different errors", () => {
	it("an unparseable line still reports malformed JSON with its line", () => {
		const vault = writeVault({
			"events.jsonl": insertAt(buildChain([1, 2, 3, 4]), 2, "{ not json"),
		});
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toEqual(["malformed JSON (events.jsonl:3)"]);
	});

	it("a 42 line reports the non-object error and no malformed JSON error", () => {
		const vault = writeVault({
			"events.jsonl": insertAt(buildChain([1, 2, 3, 4]), 2, "42"),
		});
		const r = verifyVault(vault);
		expect(r.errors).toEqual([nonObject("events.jsonl", 3)]);
		expect(r.errors.some((e) => e.includes("malformed JSON"))).toBe(false);
	});

	it("both lines in one segment give both errors, each with its own line", () => {
		const chain = buildChain([1, 2, 3, 4]);
		// ev1, unparseable, ev2, 42, ev3, ev4
		const lines = insertAt(insertAt(chain, 1, "{ not json"), 3, "42");
		const vault = writeVault({ "events.jsonl": lines });
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toEqual(["malformed JSON (events.jsonl:2)", nonObject("events.jsonl", 4)]);
		expect(r.chainLength).toBe(4);
		// Two messages, not one message twice: an auditor tells the two faults apart by the text.
		expect(new Set(r.errors.map((e) => e.slice(0, e.indexOf("(")))).size).toBe(2);
	});
});

describe("verifyVault: a non-object line in a rotated segment", () => {
	it("a 42 line in events-0001.jsonl names that segment and its own line", () => {
		const chain = buildChain([1, 2, 3, 4]);
		const vault = writeVault({
			// ev1, 42, ev2
			"events-0001.jsonl": insertAt(chain.slice(0, 2), 1, "42"),
			"events.jsonl": chain.slice(2),
		});
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toEqual([nonObject("events-0001.jsonl", 2)]);
		expect(r.chainLength).toBe(4);
		expect(r.validHashes).toBe(4);
	});

	it("a 42 line in a rotated segment of a re-rooted chain: the deletion is still named", () => {
		const chain = buildChain([5, 6, 7, 8]);
		const vault = writeVault({
			"events-0001.jsonl": insertAt(chain.slice(0, 2), 1, "42"),
			"events.jsonl": chain.slice(2),
		});
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes(SEQ_START_5))).toBe(true);
		expect(r.errors).toContain(nonObject("events-0001.jsonl", 2));
		expect(r.errors).toHaveLength(2);
	});

	it("a segment name carrying a control character is scrubbed in the non-object error", () => {
		const chain = buildChain([1, 2, 3, 4]);
		const hostile = "events-\u001b[2K0001.jsonl";
		const vault = writeVault({
			[hostile]: insertAt(chain.slice(0, 2), 1, "42"),
			"events.jsonl": chain.slice(2),
		});
		const r = verifyVault(vault);
		expect(r.valid).toBe(false);
		expect(r.errors).toEqual([nonObject("events-?[2K0001.jsonl", 2)]);
	});
});
