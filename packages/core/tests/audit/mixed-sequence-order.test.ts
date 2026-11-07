// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A MIXED LOG (some events carry a `sequence`, some do not) in the two other places that order a
 * vault's events:
 *
 *  - `gatherOrderedEventHashes` (core and the zero-dependency package), the position list the
 *    anchors count. It is documented as the same gathering and ordering as the vault walk, so in a
 *    mixed log it holds the sequenced events' hashes sorted by sequence, and nothing else: one
 *    event without a sequence must not switch it to file order and shift every position.
 *  - `readLedgerEvents`, the reader behind the dashboard and the export. It drops nothing: the
 *    sequenced events come first, sorted by sequence, then the ones without a sequence in file
 *    order.
 *
 * A log where no event carries a sequence keeps file order (events.jsonl first, then the rotated
 * segments by name), and a fully sequenced log is sorted, in both.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatherOrderedEventHashes as pkgGather } from "../../../verify/src/anchor-verify.js";
import { gatherOrderedEventHashes as coreGather } from "../../src/audit/anchor-verify.js";
import { readLedgerEvents } from "../../src/audit/read.js";

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

/** A new vault directory holding `audit/<name>` for every entry of `segments`. */
function writeVault(segments: Record<string, readonly object[]>): string {
	const vault = mkdtempSync(join(tmpdir(), "trust-mixed-order-"));
	dirs.push(vault);
	const auditDir = join(vault, "audit");
	mkdirSync(auditDir, { recursive: true });
	for (const [name, events] of Object.entries(segments)) {
		writeFileSync(join(auditDir, name), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
	}
	return vault;
}

/** An event line carrying a sequence, or none when `sequence` is null. */
const ev = (id: string, sequence: number | null): object =>
	sequence === null ? { id, hash: `h-${id}` } : { id, hash: `h-${id}`, sequence };

/**
 * events.jsonl holds sequences 3 and 4 around a sequence-less event, the rotated segment holds 1
 * and 2 around another, so file order (events.jsonl first) differs from sequence order.
 */
function mixedVault(): string {
	return writeVault({
		"events.jsonl": [ev("s3", 3), ev("u1", null), ev("s4", 4)],
		"events-0001.jsonl": [ev("s1", 1), ev("u2", null), ev("s2", 2)],
	});
}

function legacyVault(): string {
	return writeVault({
		"events.jsonl": [ev("a", null), ev("b", null)],
		"events-0001.jsonl": [ev("c", null), ev("d", null)],
	});
}

function sequencedVault(): string {
	return writeVault({
		"events.jsonl": [ev("s3", 3), ev("s4", 4)],
		"events-0001.jsonl": [ev("s1", 1), ev("s2", 2)],
	});
}

describe.each([
	["core", coreGather],
	["package", pkgGather],
] as const)("gatherOrderedEventHashes (%s): a mixed log", (_name, gather) => {
	it("returns only the sequenced events' hashes, sorted by sequence", () => {
		const hashes = gather(mixedVault());
		expect(hashes).toEqual(["h-s1", "h-s2", "h-s3", "h-s4"]);
		expect(hashes).not.toContain("h-u1");
		expect(hashes).not.toContain("h-u2");
	});

	it("positive control: a log with no sequence at all keeps file order", () => {
		expect(gather(legacyVault())).toEqual(["h-a", "h-b", "h-c", "h-d"]);
	});

	it("positive control: a fully sequenced log is sorted by sequence", () => {
		expect(gather(sequencedVault())).toEqual(["h-s1", "h-s2", "h-s3", "h-s4"]);
	});
});

describe("gatherOrderedEventHashes: core and the package agree on a mixed log", () => {
	it("the two lists are equal", () => {
		const vault = mixedVault();
		expect(pkgGather(vault)).toEqual(coreGather(vault));
	});
});

describe("readLedgerEvents: a mixed log", () => {
	const ids = (vault: string): string[] => readLedgerEvents(vault).map((e) => e.id);

	it("returns the sequenced events sorted, then the sequence-less ones in file order", () => {
		expect(ids(mixedVault())).toEqual(["s1", "s2", "s3", "s4", "u1", "u2"]);
	});

	it("drops nothing", () => {
		expect(readLedgerEvents(mixedVault())).toHaveLength(6);
	});

	it("positive control: a log with no sequence at all keeps file order", () => {
		expect(ids(legacyVault())).toEqual(["a", "b", "c", "d"]);
	});

	it("positive control: a fully sequenced log is sorted by sequence", () => {
		expect(ids(sequencedVault())).toEqual(["s1", "s2", "s3", "s4"]);
	});
});
