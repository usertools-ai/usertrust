// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust-verify --tx` must PRINT the verdict's errors, not only the receipt. A deleted middle segment
 * is named in `errors` (the absent event range and the two files around it), and neither receipt renderer
 * carries that text: before the errors were printed, an operator saw only `CHAIN INCONSISTENT` or
 * `Transaction not found`, never what was missing. Every line goes through `forDisplay`.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical.js";
import { GENESIS_HASH } from "../src/constants.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function chain(count: number, transferFor: (i: number) => string): string[] {
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		const event = {
			id: `evt-${i + 1}`,
			timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
			previousHash,
			kind: "llm_call",
			actor: "local",
			data: { transferId: transferFor(i), model: "m", cost: 1, settled: true },
			sequence: i + 1,
		};
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		lines.push(canonicalize({ ...event, hash }));
		previousHash = hash;
	}
	return lines;
}

/** Events 1-2 in the first segment, 3-4 DELETED, 5-6 in the live file. */
function vaultMissingMiddle(firstSegment: string): string {
	const root = mkdtempSync(join(tmpdir(), "verify-tx-cli-"));
	dirs.push(root);
	const audit = join(root, ".usertrust", "audit");
	mkdirSync(audit, { recursive: true });
	const lines = chain(6, (i) => (i === 4 ? "tx-live" : `tx-${i}`));
	writeFileSync(join(audit, firstSegment), `${lines.slice(0, 2).join("\n")}\n`);
	writeFileSync(join(audit, "events.jsonl"), `${lines.slice(4).join("\n")}\n`);
	return join(root, ".usertrust");
}

function runCli(...args: string[]) {
	const repoRoot = join(import.meta.dirname, "..", "..", "..");
	return spawnSync("npx", ["tsx", join(repoRoot, "packages", "verify", "src", "cli.ts"), ...args], {
		cwd: repoRoot,
		encoding: "utf-8",
	});
}

describe("--tx prints the verdict's errors", () => {
	it("a missing middle segment is NAMED on the terminal, with the absent range and both neighbours", () => {
		const vault = vaultMissingMiddle("events-0001.jsonl");
		const res = runCli(vault, "--tx", "tx-live");
		const out = res.stdout + res.stderr;
		expect(res.status).toBe(1);
		expect(out).toContain("audit segment missing: events 3..4 are absent between");
		expect(out).toContain("events-0001.jsonl (ends at 2)");
		expect(out).toContain("events.jsonl (starts at 5)");
		expect(out).toContain("Sequence gap: event 5 follows 2");
	}, 60_000);

	it("a transfer that is not found still prints the gap that may hold it", () => {
		const vault = vaultMissingMiddle("events-0001.jsonl");
		const res = runCli(vault, "--tx", "tx-in-the-missing-segment");
		const out = res.stdout + res.stderr;
		expect(res.status).toBe(2);
		expect(out).toContain("audit segment missing: events 3..4 are absent between");
	}, 60_000);

	it("a hostile segment file name is defanged on the terminal", () => {
		const vault = vaultMissingMiddle("events-\u001b[2K\u009bX.jsonl");
		const res = runCli(vault, "--tx", "tx-live");
		const out = res.stdout + res.stderr;
		expect(out).toContain("audit segment missing");
		expect(out).not.toContain("\u001b[2K");
		expect(out).not.toContain("\u009b");
	}, 60_000);

	it("a bidi override (U+202E) in a segment file name never reaches stdout", () => {
		// The library scrubs C0, DEL and C1; U+202E is a format character, so only the CLI's forDisplay stands
		// between it and the terminal (a name that visually reorders the verdict line).
		const bidi = String.fromCharCode(0x202e);
		const vault = vaultMissingMiddle(`events-${bidi}X.jsonl`);
		const res = runCli(vault, "--tx", "tx-live");
		const out = res.stdout + res.stderr;
		expect(out).toContain("audit segment missing");
		expect(out).not.toContain(bidi);
	}, 60_000);

	it("a long error list reaches a piped stdout whole, the named range included", () => {
		// 3,000 malformed lines in the older segment: well past a pipe buffer. process.exit does not drain an
		// asynchronous stdout, so the lines appended last (the named gap) used to be lost to `| tool`.
		const vault = vaultMissingMiddle("events-0001.jsonl");
		const first = join(vault, "audit", "events-0001.jsonl");
		appendFileSync(first, `${Array.from({ length: 3000 }, () => "not json").join("\n")}\n`);
		// A SLOW reader: the consumer sleeps before reading, so the pipe is backpressured while the CLI exits.
		const repoRoot = join(import.meta.dirname, "..", "..", "..");
		const cli = join(repoRoot, "packages", "verify", "src", "cli.ts");
		const res = spawnSync(
			"sh",
			["-c", `npx tsx "$1" "$2" --tx tx-live | (sleep 2; cat)`, "sh", cli, vault],
			{ cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
		);
		const out = res.stdout;
		expect(out.split("\n").filter((l) => l.startsWith("  - malformed JSON")).length).toBe(3000);
		expect(out).toContain("audit segment missing: events 3..4 are absent between");
	}, 60_000);

	it("a clean transaction prints no error lines", () => {
		const root = mkdtempSync(join(tmpdir(), "verify-tx-cli-"));
		dirs.push(root);
		const audit = join(root, ".usertrust", "audit");
		mkdirSync(audit, { recursive: true });
		const lines = chain(3, () => "tx-ok");
		writeFileSync(join(audit, "events.jsonl"), `${lines.join("\n")}\n`);
		// With its anchor: a chain of several events with no anchor is refused (ANCHOR_MISSING).
		const head = (JSON.parse(lines[2] as string) as { hash: string }).hash;
		writeFileSync(
			join(audit, "events.jsonl.meta"),
			JSON.stringify({ lastHash: head, sequence: 3 }),
		);
		const res = runCli(join(root, ".usertrust"), "--tx", "tx-ok");
		expect(res.status).toBe(0);
		expect(res.stdout).not.toMatch(/^ {2}- /m);
	}, 60_000);

	it("a transfer that may sit in a segment nobody could read is FAILED (exit 1), never 'not found' (exit 2)", () => {
		const root = mkdtempSync(join(tmpdir(), "verify-tx-cli-"));
		dirs.push(root);
		const audit = join(root, ".usertrust", "audit");
		mkdirSync(audit, { recursive: true });
		writeFileSync(join(audit, "events.jsonl"), `${chain(1, () => "tx-live").join("\n")}\n`);
		// A DIRECTORY named like a segment: unreadable whatever user runs the tests.
		mkdirSync(join(audit, "events-0001.jsonl"));
		const res = runCli(join(root, ".usertrust"), "--tx", "tx-elsewhere");
		expect(res.status).toBe(1);
		expect(res.stdout).toContain("Vault integrity: FAILED");
		expect(res.stdout).toContain("  - Audit segment could not be read: events-0001.jsonl");
		expect(res.stdout).not.toContain("not found");
	}, 60_000);
});
