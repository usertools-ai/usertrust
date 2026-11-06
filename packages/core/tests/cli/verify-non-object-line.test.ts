// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust verify` on a vault whose leading events were deleted (the chain re-rooted at sequence
 * 5) and whose log also holds a line that parses as JSON but is not an object. The printed verdict
 * must name both: the deletion, and the stray line by file and line number. A stray line once hid
 * the deletion entirely, leaving only a hash mismatch on the line itself to read.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { run } from "../../src/cli/verify.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";

let tempDir: string;
let out: string[];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "trust-verify-nonobject-cli-"));
	out = [];
	process.exitCode = 0;
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		out.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	// A failing verdict sets the exit code; do not let it leak into the worker's own exit.
	process.exitCode = 0;
	rmSync(tempDir, { recursive: true, force: true });
});

/** Events with the given sequences, hashed over their canonical form and linked from GENESIS. */
function buildChain(sequences: readonly number[]): string[] {
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];
	for (let i = 0; i < sequences.length; i++) {
		const event = {
			id: `evt-${i + 1}`,
			kind: "test.event",
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			previousHash,
			data: { n: i + 1 },
			sequence: sequences[i] as number,
		};
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		lines.push(JSON.stringify({ ...event, hash }));
		previousHash = hash;
	}
	return lines;
}

describe("usertrust verify: a non-object line beside a leading deletion", () => {
	it("prints the deletion and the stray line, and exits 1", async () => {
		const auditDir = join(tempDir, VAULT_DIR, "audit");
		mkdirSync(auditDir, { recursive: true });
		const lines = buildChain([5, 6, 7, 8]);
		// ev5, ev6, 42, ev7, ev8: the stray line is line 3.
		lines.splice(2, 0, "42");
		writeFileSync(join(auditDir, "events.jsonl"), `${lines.join("\n")}\n`);

		// No flags, plain output: the human-readable verdict.
		await run(tempDir, undefined, []);

		const combined = out.join("\n");
		expect(combined).toContain("FAILED");
		expect(combined).toContain("Sequence starts at 5, expected 1");
		expect(combined).toContain("non-object line (events.jsonl:3)");
		expect(combined).toContain("2 error(s) found");
		expect(process.exitCode).toBe(1);
	});
});
