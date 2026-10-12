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
import { clipForDisplay, forDisplay } from "../src/receipt.js";

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

describe("clipForDisplay — sanitize first, then clip by code points", () => {
	it("red-first (a lone surrogate): a clip falling inside a surrogate pair keeps the WHOLE character", () => {
		const emoji = String.fromCodePoint(0x1f600); // two UTF-16 code units
		const keyId = `${"a".repeat(18)}${emoji}zz`;
		const out = clipForDisplay(keyId, 19);
		expect(out).toBe(`${"a".repeat(18)}${emoji}`);
		expect(out).not.toMatch(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
		);
	});
	it("a control byte is replaced, then counted as one character", () => {
		const esc = String.fromCharCode(0x1b);
		expect(clipForDisplay(`${esc}[2Kabcdef`, 4)).toBe("?[2K");
	});
});

describe("forDisplay — characters that reorder or hide text are replaced too", () => {
	const INVISIBLE = [
		0x200b,
		0x200c,
		0x200d,
		0x200e,
		0x200f, // zero-width space/joiners, LRM, RLM
		0x202a,
		0x202b,
		0x202c,
		0x202d,
		0x202e, // bidi embeddings and overrides
		0x2066,
		0x2067,
		0x2068,
		0x2069, // bidi isolates
		0xfeff, // zero-width no-break space
	];
	it.each(INVISIBLE)("U+%s is replaced with ? (red-first: passed through)", (code) => {
		expect(forDisplay(`a${String.fromCodePoint(code)}b`)).toBe("a?b");
	});
	it("control: the neighbours of each range are printable and left alone", () => {
		for (const code of [0x200a, 0x2010, 0x2029, 0x202f, 0x2065, 0x206a, 0xfefe, 0xff01]) {
			const ch = String.fromCodePoint(code);
			expect(forDisplay(`a${ch}b`)).toBe(`a${ch}b`);
		}
	});
	it("the CLI: an RLO in a vault event id never reaches the terminal", () => {
		const rlo = String.fromCodePoint(0x202e);
		const root = mkdtempSync(join(tmpdir(), "verify-cli-bidi-"));
		dirs.push(root);
		const audit = join(root, ".usertrust", "audit");
		mkdirSync(audit, { recursive: true });
		const event = {
			id: `evt${rlo}DEIFIREV`,
			previousHash: `x${rlo}`,
			hash: "0".repeat(64),
			sequence: 1,
			kind: "llm_call",
		};
		writeFileSync(join(audit, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf-8");
		const res = runCli(join(root, ".usertrust"));
		expect(res.status).toBe(1);
		const out = `${res.stdout}${res.stderr}`;
		expect(out).toContain("evt?DEIFIREV");
		expect(out).not.toContain(rlo);
	}, 60_000);
});
