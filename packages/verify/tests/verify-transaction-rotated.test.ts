// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `--tx` over a ROTATED vault. A transfer's records can straddle a rotated segment and the live
 * file, so a verifier that reads `events.jsonl` alone judges it from partial history: the live
 * file does not start at GENESIS (a chain failure that is not one), the detection and the spend
 * that sit in the older segment vanish from the receipt, and a deleted segment is never named.
 * The verdict for a rotated vault must equal the verdict for the same events in one file.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical.js";
import { GENESIS_HASH } from "../src/constants.js";
import { verifyTransaction } from "../src/index.js";

// Copied from verify-transaction.test.ts / harden/rotation-continuity.test.ts: test files do not
// import each other.
interface Ev {
	kind: string;
	data: Record<string, unknown>;
}

function buildChain(events: Ev[]): { lines: string[]; hashes: string[] } {
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];
	const hashes: string[] = [];
	for (let i = 0; i < events.length; i++) {
		const ev = events[i] as Ev;
		const event = {
			id: `evt-${i + 1}`,
			timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
			previousHash,
			kind: ev.kind,
			actor: "local",
			data: ev.data,
			sequence: i + 1,
		};
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		lines.push(canonicalize({ ...event, hash }));
		hashes.push(hash);
		previousHash = hash;
	}
	return { lines, hashes };
}

// Six events; the target transfer `tx-x` has a record in each third of the chain, so any split
// into segments of two puts its history across every file.
const EVENTS: Ev[] = [
	{ kind: "llm_call", data: { transferId: "tx-a", model: "m", cost: 5, settled: true } },
	{ kind: "anomaly_detected", data: { transferId: "tx-x", message: "velocity spike" } },
	{ kind: "anomaly_detected", data: { transferId: "tx-x", message: "second look" } },
	{ kind: "llm_call", data: { transferId: "tx-b", model: "m", cost: 3, settled: true } },
	{ kind: "llm_call", data: { transferId: "tx-x", model: "m", cost: 7, settled: true } },
	{ kind: "llm_call", data: { transferId: "tx-c", model: "m", cost: 2, settled: true } },
];

/** The receipt's only legitimately varying line is the verification time. */
function stable(receipt: string): string {
	return receipt
		.split("\n")
		.filter((l) => !l.includes("  Verified"))
		.join("\n");
}

describe("verifyTransaction over rotated segments", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "verify-tx-rot-"));
	});

	afterEach(() => {
		// A test may leave an audit dir unreadable; restore it so the cleanup can descend.
		for (const name of ["unenumerable", "unenumerable-empty-live"]) {
			try {
				chmodSync(join(root, name, "audit"), 0o700);
			} catch {
				// not created by this test
			}
		}
		rmSync(root, { recursive: true, force: true });
	});

	/** Write a vault whose audit dir holds `files` (name → lines), anchored at the chain head. */
	function vault(name: string, files: Record<string, string[]>, head?: string): string {
		const vaultPath = join(root, name);
		const auditDir = join(vaultPath, "audit");
		mkdirSync(auditDir, { recursive: true });
		for (const [file, lines] of Object.entries(files)) {
			writeFileSync(join(auditDir, file), `${lines.join("\n")}\n`);
		}
		if (head !== undefined) {
			writeFileSync(
				join(auditDir, "events.jsonl.meta"),
				JSON.stringify({ lastHash: head, sequence: EVENTS.length }),
			);
		}
		return vaultPath;
	}

	function expectSameVerdict(rotated: string, single: string): void {
		const r = verifyTransaction(rotated, "tx-x");
		const s = verifyTransaction(single, "tx-x");
		expect(s.found).toBe(true);
		expect(s.valid).toBe(true);
		expect(r.found).toBe(s.found);
		expect(r.valid).toBe(s.valid);
		expect(r.errors).toEqual(s.errors);
		expect(stable(r.receipt)).toBe(stable(s.receipt));
		// Spelled out, so the equality cannot pass on two equally partial readings.
		expect(r.receipt).toContain("Event 5 of 6");
		expect(r.receipt).toContain("velocity spike");
	}

	it("a transfer straddling ONE rotation verifies exactly as the unrotated vault", () => {
		const { lines, hashes } = buildChain(EVENTS);
		const head = hashes[5];
		const single = vault("single", { "events.jsonl": lines }, head);
		const rotated = vault(
			"rotated",
			{ "events-0001.jsonl": lines.slice(0, 3), "events.jsonl": lines.slice(3) },
			head,
		);
		expectSameVerdict(rotated, single);
	});

	it("a transfer split across TWO rotations (three files) verifies exactly as the unrotated vault", () => {
		const { lines, hashes } = buildChain(EVENTS);
		const head = hashes[5];
		const single = vault("single", { "events.jsonl": lines }, head);
		const rotated = vault(
			"rotated",
			{
				"events-0001.jsonl": lines.slice(0, 2),
				"events-0002.jsonl": lines.slice(2, 4),
				"events.jsonl": lines.slice(4),
			},
			head,
		);
		expectSameVerdict(rotated, single);
	});

	it("a missing MIDDLE segment fails and is NAMED by its range and both neighbouring files", () => {
		const { lines, hashes } = buildChain(EVENTS);
		const rotated = vault(
			"gap",
			{ "events-0001.jsonl": lines.slice(0, 2), "events.jsonl": lines.slice(4) },
			hashes[5],
		);
		const result = verifyTransaction(rotated, "tx-x");
		expect(result.found).toBe(true);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Sequence gap: event 5 follows 2 (segment/event deletion)");
		expect(result.errors).toContain(
			"audit segment missing: events 3..4 are absent between events-0001.jsonl (ends at 2) and events.jsonl (starts at 5)",
		);
	});

	it("a transfer whose records were ALL in the missing segment is not found, and the gap is named", () => {
		const { lines, hashes } = buildChain([
			...EVENTS.slice(0, 2),
			{ kind: "llm_call", data: { transferId: "tx-gone", model: "m", cost: 1, settled: true } },
			...EVENTS.slice(3),
		]);
		const rotated = vault(
			"gap-target",
			{ "events-0001.jsonl": lines.slice(0, 2), "events.jsonl": lines.slice(4) },
			hashes[5],
		);
		const result = verifyTransaction(rotated, "tx-gone");
		expect(result.found).toBe(false);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"audit segment missing: events 3..4 are absent between events-0001.jsonl (ends at 2) and events.jsonl (starts at 5)",
		);
	});

	it("an UNREADABLE rotated segment fails loudly, as an unreadable live file always did", () => {
		const { lines } = buildChain(EVENTS);
		const rotated = vault("unreadable", { "events.jsonl": lines.slice(3) });
		// A DIRECTORY named like a segment: readFileSync throws EISDIR on it, whatever user runs the tests
		// (a chmod 000 file is readable by root).
		mkdirSync(join(rotated, "audit", "events-0001.jsonl"));
		// A verdict here would read "not found" for a transfer whose records sit in the file nobody could
		// open: the CLI's exit 2, where the vault was never read.
		expect(() => verifyTransaction(rotated, "tx-x")).toThrow();
	});

	it("a gap is named from the verdict's own sequences, not each file's first and last lines", () => {
		// events 1,4,2 in the older segment (out of order), 6.. in the live file: 3 and 5 are absent. A name
		// built from physical first/last lines said "events 3..5 are absent" (4 exists).
		const { lines } = buildChain([
			...EVENTS,
			{ kind: "llm_call", data: { transferId: "tx-d", model: "m", cost: 1, settled: true } },
		]);
		const [e1, e2, , e4, , e6, e7] = lines as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];
		const rotated = vault("shuffled", {
			"events-0001.jsonl": [e1, e4, e2],
			"events.jsonl": [e6, e7],
		});
		const result = verifyTransaction(rotated, "tx-c");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"audit events missing: event 3 is absent inside events-0001.jsonl (between 2 and 4)",
		);
		expect(result.errors).toContain(
			"audit segment missing: event 5 is absent between events-0001.jsonl (ends at 4) and events.jsonl (starts at 6)",
		);
		expect(result.errors.some((e) => e.includes("3..5"))).toBe(false);
	});

	it("a duplicated sequence is not turned into an impossible 'missing' range", () => {
		const { lines } = buildChain(EVENTS);
		// events.jsonl repeats event 3: the verdict says "Sequence gap: event 3 follows 3"; nothing is absent.
		const dup = vault("dup", {
			"events-0001.jsonl": lines.slice(0, 3),
			"events.jsonl": lines.slice(2),
		});
		const result = verifyTransaction(dup, "tx-x");
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.startsWith("Sequence gap:"))).toBe(true);
		expect(result.errors.some((e) => e.includes("missing"))).toBe(false);
	});

	it("a not-found transfer's errors are scrubbed too (a hostile segment name beside the gap)", () => {
		const { lines } = buildChain(EVENTS);
		const hostile = vault("hostile-notfound", {
			"events-\u001b[2K\u009bX.jsonl": lines.slice(0, 2),
			"events.jsonl": lines.slice(4),
		});
		const result = verifyTransaction(hostile, "tx-in-the-missing-segment");
		expect(result.found).toBe(false);
		const text = result.errors.join("\n");
		expect(text).toContain("audit segment missing");
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("\u009b");
	});

	it("a vault holding only rotated segments is a vault with history, not 'Audit log not found'", () => {
		const { lines } = buildChain(EVENTS);
		const onlyRotated = vault("only-rotated", {
			"events-0001.jsonl": lines.slice(0, 3),
			"events-0002.jsonl": lines.slice(3),
		});
		const result = verifyTransaction(onlyRotated, "tx-x");
		expect(result.errors.some((e) => e.startsWith("Audit log not found"))).toBe(false);
		expect(result.found).toBe(true);
		expect(result.valid).toBe(true);
		expect(result.receipt).toContain("Event 5 of 6");
	});

	it("a hostile segment file name is control-character scrubbed in the verdict", () => {
		const { lines, hashes } = buildChain(EVENTS);
		const hostile = "events-\x1b]0;pwned\x07\x9b2J.jsonl";
		const rotated = vault(
			"hostile",
			// The malformed line makes the VAULT verdict quote the name too.
			{ [hostile]: [...lines.slice(0, 2), "not json"], "events.jsonl": lines.slice(4) },
			hashes[5],
		);
		const result = verifyTransaction(rotated, "tx-x");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"audit segment missing: events 3..4 are absent between events-?]0;pwned??2J.jsonl (ends at 2) and events.jsonl (starts at 5)",
		);
		expect(result.errors).toContain("malformed JSON (events-?]0;pwned??2J.jsonl:3)");
		for (const e of result.errors) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: the probe must match them.
			expect(e).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		}
	});

	const INCOMPLETE = "in the records that could be read";
	const ABSOLUTE = "No event with this transferId exists";

	it("a transfer whose records were ALL in the missing segment is not 'nonexistent': the box says what was read", () => {
		const { lines, hashes } = buildChain([
			...EVENTS.slice(0, 2),
			{ kind: "llm_call", data: { transferId: "tx-gone", model: "m", cost: 1, settled: true } },
			...EVENTS.slice(3),
		]);
		const rotated = vault(
			"gap-receipt",
			{ "events-0001.jsonl": lines.slice(0, 2), "events.jsonl": lines.slice(4) },
			hashes[5],
		);
		const result = verifyTransaction(rotated, "tx-gone");
		expect(result.found).toBe(false);
		expect(result.receipt).not.toContain(ABSOLUTE);
		expect(result.receipt).toContain(INCOMPLETE);
		expect(result.receipt).toContain("Transaction not found");
		expect(result.errors.some((e) => e.startsWith("Sequence gap: event 5 follows 2"))).toBe(true);
		expect(result.errors.some((e) => e.startsWith("audit segment missing:"))).toBe(true);
	});

	it.skipIf(process.getuid?.() === 0)(
		"an audit dir that cannot be enumerated, with the transfer only in a rotated segment, does not claim non-existence",
		() => {
			const { lines, hashes } = buildChain(EVENTS);
			const dir = vault(
				"unenumerable",
				{ "events-0001.jsonl": lines.slice(0, 3), "events.jsonl": lines.slice(3) },
				hashes[5],
			);
			chmodSync(join(dir, "audit"), 0o300);
			const result = verifyTransaction(dir, "tx-a");
			chmodSync(join(dir, "audit"), 0o700);
			expect(result.found).toBe(false);
			expect(result.receipt).not.toContain(ABSOLUTE);
			expect(result.receipt).toContain(INCOMPLETE);
			expect(result.errors.some((e) => e.includes("could not be enumerated"))).toBe(true);
		},
	);

	it.skipIf(process.getuid?.() === 0)(
		"an audit dir that cannot be enumerated, with an EMPTY live log, is not an empty complete reading",
		() => {
			const { lines, hashes } = buildChain(EVENTS);
			const dir = vault(
				"unenumerable-empty-live",
				{ "events-0001.jsonl": lines, "events.jsonl": [] },
				hashes[5],
			);
			chmodSync(join(dir, "audit"), 0o300);
			const result = verifyTransaction(dir, "tx-a");
			expect(result.found).toBe(false);
			expect(result.receipt).not.toContain(ABSOLUTE);
			expect(result.receipt).toContain(INCOMPLETE);
			expect(result.errors).not.toContain("Audit log is empty");
			expect(
				result.errors.some((e) => e.startsWith("Audit directory could not be enumerated:")),
			).toBe(true);
		},
	);

	/** A vault whose live log is empty, with `anchor` as its `.meta` (absent when undefined). */
	function emptyLogVault(name: string, anchor?: string): string {
		const vaultPath = join(root, name);
		const auditDir = join(vaultPath, "audit");
		mkdirSync(auditDir, { recursive: true });
		writeFileSync(join(auditDir, "events.jsonl"), "");
		if (anchor !== undefined) writeFileSync(join(auditDir, "events.jsonl.meta"), anchor);
		return vaultPath;
	}

	it("an EMPTY log whose anchor records events is not a complete reading", () => {
		const dir = emptyLogVault(
			"empty-anchor-records",
			JSON.stringify({ lastHash: "a".repeat(64), sequence: 5 }),
		);
		const result = verifyTransaction(dir, "tx-a");
		expect(result.found).toBe(false);
		expect(result.errors).toEqual(["Audit log is empty"]);
		expect(result.receipt).toContain(INCOMPLETE);
		expect(result.receipt).not.toContain(ABSOLUTE);
	});

	it("an EMPTY log with a malformed anchor is not a complete reading", () => {
		const dir = emptyLogVault("empty-anchor-corrupt", "{not json");
		const result = verifyTransaction(dir, "tx-a");
		expect(result.found).toBe(false);
		expect(result.errors).toEqual(["Audit log is empty"]);
		expect(result.receipt).toContain(INCOMPLETE);
		expect(result.receipt).not.toContain(ABSOLUTE);
	});

	it("guard: an EMPTY log with no anchor keeps the absolute sentence", () => {
		const dir = emptyLogVault("empty-no-anchor");
		const result = verifyTransaction(dir, "tx-a");
		expect(result.found).toBe(false);
		expect(result.errors).toEqual(["Audit log is empty"]);
		expect(result.receipt).toContain(ABSOLUTE);
		expect(result.receipt).not.toContain(INCOMPLETE);
	});

	// Hand-made: the writer only writes `.meta` after an append (sequence >= 1), so it never produces this
	// shape; the verifier accepts it as an agreeing empty anchor (`verifyChain`), so the receipt does too.
	it("guard: an EMPTY log with an anchor at sequence 0 on the genesis hash keeps the absolute sentence", () => {
		const dir = emptyLogVault(
			"empty-anchor-genesis",
			JSON.stringify({ lastHash: GENESIS_HASH, sequence: 0 }),
		);
		const result = verifyTransaction(dir, "tx-a");
		expect(result.found).toBe(false);
		expect(result.errors).toEqual(["Audit log is empty"]);
		expect(result.receipt).toContain(ABSOLUTE);
		expect(result.receipt).not.toContain(INCOMPLETE);
	});

	it("guard: a clean rotated vault and an id that exists nowhere keeps the absolute sentence", () => {
		const { lines, hashes } = buildChain(EVENTS);
		const rotated = vault(
			"clean-notfound",
			{ "events-0001.jsonl": lines.slice(0, 3), "events.jsonl": lines.slice(3) },
			hashes[5],
		);
		const result = verifyTransaction(rotated, "tx-nowhere");
		expect(result.found).toBe(false);
		expect(result.errors).toEqual([]);
		expect(result.receipt).toContain(ABSOLUTE);
		expect(result.receipt).not.toContain(INCOMPLETE);
	});

	it("regression: a same-length tamper inside a ROTATED segment fails every transfer's verdict", () => {
		const { lines, hashes } = buildChain(EVENTS);
		const tampered = (lines[1] as string).replace("velocity spike", "velocity spikE");
		expect(tampered).not.toBe(lines[1]);
		expect(tampered.length).toBe((lines[1] as string).length);
		const rotated = vault(
			"tampered",
			{
				"events-0001.jsonl": [lines[0] as string, tampered, lines[2] as string],
				"events.jsonl": lines.slice(3),
			},
			hashes[5],
		);
		// tx-x has records in the rotated segment; tx-c only in the live file.
		for (const tx of ["tx-x", "tx-c"]) {
			const result = verifyTransaction(rotated, tx);
			expect(result.valid, tx).toBe(false);
			expect(
				result.errors.some((e) => /Event 2\b.*hash mismatch/i.test(e)),
				tx,
			).toBe(true);
		}
	});
});
