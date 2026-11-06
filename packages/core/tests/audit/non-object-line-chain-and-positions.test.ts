// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A LINE THAT PARSES BUT IS NOT AN EVENT, in the two other places that read a log line by line:
 *
 *  - `verifyChain`, the single-log walk (core and the zero-dependency package). Before, `null` threw on
 *    its first field read, and a number, string, boolean or array was hashed as an object it is not and
 *    left `undefined` as the link the next real event was checked against.
 *  - `gatherOrderedEventHashes`, the position list the anchors count. It is documented as the same
 *    gathering and ordering as the vault walk, so a stray line must not switch it to file order either.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatherOrderedEventHashes as pkgGather } from "../../../verify/src/anchor-verify.js";
import { verifyChain as pkgVerifyChain } from "../../../verify/src/verify.js";
import { gatherOrderedEventHashes as coreGather } from "../../src/audit/anchor-verify.js";
import { canonicalize } from "../../src/audit/canonical.js";
import { verifyChain as coreVerifyChain } from "../../src/audit/verify.js";
import { GENESIS_HASH } from "../../src/shared/constants.js";

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "trust-nonobject-chain-"));
	dirs.push(d);
	return d;
}

/** One line per event, each hashed over its canonical form and linked to the one before it. */
function buildChain(count: number): { lines: string[]; hashes: string[] } {
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];
	const hashes: string[] = [];
	for (let i = 0; i < count; i++) {
		const event: Record<string, unknown> = {
			id: `evt-${i + 1}`,
			kind: "test.event",
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			previousHash,
			data: { n: i + 1 },
		};
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		lines.push(JSON.stringify({ ...event, hash }));
		hashes.push(hash);
		previousHash = hash;
	}
	return { lines, hashes };
}

const GARBAGE = ["42", "[]", "null", '"x"', "true"] as const;

const IMPLS = [
	["core", coreVerifyChain],
	["package", pkgVerifyChain],
] as const;

describe.each(IMPLS)("verifyChain (%s): a non-object line", (_name, verifyChain) => {
	it.each(GARBAGE)("a %s line in the middle of a clean chain is the one and only error", (g) => {
		const { lines, hashes } = buildChain(3);
		const dir = tempDir();
		const log = join(dir, "events.jsonl");
		writeFileSync(log, `${[lines[0], g, lines[1], lines[2]].join("\n")}\n`);

		const result = verifyChain(log);
		expect(result.valid).toBe(false);
		expect(result.errors).toHaveLength(1);
		const err = JSON.parse(result.errors[0] as string) as Record<string, unknown>;
		expect(err.error).toBe("non-object line");
		expect(err.line).toBe(2);
		expect(result.skipped).toBe(1);
		// The real events still chain to each other, and the tail is the last real event's hash.
		expect(result.latestHash).toBe(hashes[2]);
	});

	it.each(GARBAGE)("a %s line as the LAST line leaves the tail hash a string", (g) => {
		const { lines, hashes } = buildChain(2);
		const dir = tempDir();
		const log = join(dir, "events.jsonl");
		writeFileSync(log, `${[lines[0], lines[1], g].join("\n")}\n`);

		const result = verifyChain(log);
		expect(result.valid).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(typeof result.latestHash).toBe("string");
		expect(result.latestHash).toBe(hashes[1]);
	});

	it("a clean chain with no stray line is still valid (positive control)", () => {
		const { lines } = buildChain(3);
		const dir = tempDir();
		const log = join(dir, "events.jsonl");
		writeFileSync(log, `${lines.join("\n")}\n`);
		expect(verifyChain(log).valid).toBe(true);
	});
});

describe.each([
	["core", coreGather],
	["package", pkgGather],
] as const)("gatherOrderedEventHashes (%s): a non-object line", (_name, gather) => {
	/** events.jsonl holds sequences 3 and 4, a rotated segment holds 1 and 2, so file order differs from sequence order. */
	function writeSegments(strayIn: "main" | "rotated" | null, stray: string): string {
		const vault = tempDir();
		const audit = join(vault, "audit");
		mkdirSync(audit);
		const ev = (sequence: number) => JSON.stringify({ hash: `h${sequence}`, sequence });
		const main = [ev(3), ...(strayIn === "main" ? [stray] : []), ev(4)];
		const rotated = [ev(1), ...(strayIn === "rotated" ? [stray] : []), ev(2)];
		writeFileSync(join(audit, "events.jsonl"), `${main.join("\n")}\n`);
		writeFileSync(join(audit, "events-0001.jsonl"), `${rotated.join("\n")}\n`);
		return vault;
	}

	it("positive control: with no stray line the hashes come back in sequence order", () => {
		expect(gather(writeSegments(null, "42"))).toEqual(["h1", "h2", "h3", "h4"]);
	});

	it.each(GARBAGE)("a %s line does not switch the order to file order", (g) => {
		expect(gather(writeSegments("main", g))).toEqual(["h1", "h2", "h3", "h4"]);
		expect(gather(writeSegments("rotated", g))).toEqual(["h1", "h2", "h3", "h4"]);
	});
});
