// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The STANDALONE verifier prints vault-controlled strings to an
 * auditor's terminal, and the vault belongs to the party under audit. An event's
 * `id`, `previousHash` and `timestamp` reach the verdict text verbatim (the
 * chain-error lines, `First event:`), so an escape sequence there could erase
 * the FAILED line and print a forged "VERIFIED". Every such value now goes
 * through `forDisplay` (the package's own scrubber, `receipt.ts`) before it is
 * printed — C0, DEL and C1 (the 8-bit CSI/OSC introducers) become `?`.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ERASE_LINE = "\u001b[2K";
const C1_CSI = "\u009b";
const HOSTILE = `evt${ERASE_LINE}\rVERIFIED${C1_CSI}31m`;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A vault whose one event carries the hostile string in every field the CLI prints. */
function hostileVault(): string {
	const root = mkdtempSync(join(tmpdir(), "verify-cli-scrub-"));
	dirs.push(root);
	const audit = join(root, ".usertrust", "audit");
	mkdirSync(audit, { recursive: true });
	const event = {
		id: HOSTILE,
		previousHash: HOSTILE, // not the genesis hash: the continuity error quotes it
		hash: "0".repeat(64),
		sequence: 1,
		timestamp: HOSTILE, // printed as `First event:`
		kind: "llm_call",
	};
	writeFileSync(join(audit, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf-8");
	return join(root, ".usertrust");
}

function runCli(...args: string[]) {
	const repoRoot = join(import.meta.dirname, "..", "..", "..");
	return spawnSync("npx", ["tsx", join(repoRoot, "packages", "verify", "src", "cli.ts"), ...args], {
		cwd: repoRoot,
		encoding: "utf-8",
	});
}

describe("the standalone CLI never prints a vault-controlled control byte", () => {
	// Plain mode and anchored mode print their chain errors at different sites.
	for (const extra of [[], ["--require-anchor"]]) {
		it(`red-first (raw ESC/CR/C1 reached the terminal): ${extra.join(" ") || "plain"} mode`, () => {
			const res = runCli(hostileVault(), ...extra);
			expect(res.status).toBe(1); // the hash and continuity checks fail …
			const out = `${res.stdout}${res.stderr}`;
			expect(out).toContain("FAILED");
			expect(out).toContain("evt?[2K?VERIFIED?31m"); // … the hostile id is SHOWN, defanged
			expect(out).not.toContain(ERASE_LINE);
			expect(out).not.toContain("\r");
			expect(out).not.toContain(C1_CSI);
		}, 60_000);
	}
});
