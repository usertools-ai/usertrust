// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * No untrusted argument reaches an operator's terminal as a control byte, in any command.
 *
 * AGENTS.md's terminal-output rule is a property of every echo, but each echo site is a separate
 * `console.log` in a separate file, so a rule checked site by site is only ever as complete as the
 * last person's grep. This drives the real entry point instead: every command, with an argument
 * carrying ESC, a C1 CSI introducer, BEL and DEL in each position an argument can occupy (command
 * word, subcommand, positional, flag name, flag value), in human and `--json` mode, and asserts
 * that none of those bytes comes back out on stdout or stderr. C0 other than \t \n \r is covered by
 * the same class: `JSON.stringify` escapes it, a bare `console.log` does not.
 *
 * What this does NOT show is that the OUTPUT is right, only that it is inert. A command that
 * crashes on the hostile input before printing passes it, which is the correct direction for a
 * guard about what reaches a terminal.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const TSX = join(repoRoot, "node_modules", ".bin", "tsx");
const MAIN = join(repoRoot, "packages", "core", "src", "cli", "main.ts");

// ESC [ 2 J, C1 CSI (0x9b), BEL, DEL: one of each class the scrubbers exist for.
const H = `${String.fromCodePoint(0x1b)}[2J${String.fromCodePoint(0x9b)}2J${String.fromCodePoint(0x07)}${String.fromCodePoint(0x7f)}`;
// biome-ignore lint/suspicious/noControlCharactersInRegex: this IS the control-character detector
const RAW_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

/** Argument vectors per command, with H standing where untrusted text goes. */
const VECTORS: Array<[string, string[][]]> = [
	// `inspec<ESC>` is within two edits of `inspect`, so main.ts takes the "did you mean" path that
	// quotes the word back; an unrelated H only prints the usage text.
	[
		"top-level",
		[
			[H],
			[`-${H}`],
			[`--${H}`],
			[`inspec${String.fromCodePoint(0x1b)}`],
			[`inspec${String.fromCodePoint(0x9b)}`],
		],
	],
	[
		"inspect",
		[
			["inspect", H],
			["inspect", `-${H}`],
			["inspect", `--${H}`],
		],
	],
	[
		"health",
		[
			["health", H],
			["health", `--${H}`],
		],
	],
	[
		"pricing",
		[
			["pricing", H],
			["pricing", `--${H}`],
		],
	],
	[
		"verify",
		[
			["verify", H],
			["verify", `-${H}`],
			["verify", `--${H}`],
			["verify", "--anchor", H],
			["verify", "--bundle", H],
			["verify", "--pubkey", H],
			["verify", "--rekor-pubkey", H],
			["verify", "--rekor-receipts", H],
			["verify", "--successor-pin", H],
			["verify", "--max-anchor-age", H],
			["verify", "--max-unanchored-events", H],
			["verify", "--vault-id", H],
			["verify", "--anchor-url", H],
		],
	],
	[
		"export",
		[
			["export", H],
			["export", `--${H}`],
			["export", "--markdown", H],
		],
	],
	[
		"policy",
		[
			["policy", H],
			["policy", "validate", H],
			["policy", "validate", `--${H}`],
			["policy", "validate", H, H],
		],
	],
	[
		"anchor",
		[
			["anchor", H],
			["anchor", "init", "--key-file", H],
			["anchor", "status", `--${H}`],
			["anchor", "export", "--out", H],
			["anchor", "export-bundle", "--out", H],
			["anchor", "doctor", `--${H}`],
			["anchor", "now", "--publish-retries", H],
		],
	],
	[
		"snapshot",
		[
			["snapshot", H],
			["snapshot", "create", H],
			["snapshot", "restore", H],
			["snapshot", "list", H],
			["snapshot", "create", "ok", `--${H}`],
		],
	],
	[
		"budget",
		[
			["budget", H],
			["budget", `--${H}`],
			["budget", "--parent", H],
			["budget", "--cost-center", H],
			["budget", "--allocated", H],
			["budget", "--period-start", H],
			["budget", "--period-end", H],
		],
	],
	["completions", [["completions", H]]],
	[
		"secret",
		[
			["secret", H],
			["secret", "add", H, "v"],
			["secret", "get", H],
			["secret", "remove", H],
			["secret", "rotate", H, "v"],
			["secret", "list", H],
			["secret", "ls"],
		],
	],
	[
		"skill",
		[
			["skill", H],
			["skill", "verify", H],
			["skill", H, H],
		],
	],
];

let tmp: string;

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "trust-echo-"));
});
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function run(cwd: string, args: string[]): Promise<{ out: string; code: number | null }> {
	const { FORCE_COLOR: _force, ...env } = process.env;
	return new Promise((resolve) => {
		const child = execFile(
			TSX,
			[MAIN, ...args],
			{
				cwd,
				encoding: "utf-8",
				timeout: 40_000,
				env: { ...env, NO_COLOR: "1", USERTRUST_VAULT_KEY: "test-echo-vault-key-2026" },
			},
			(err, stdout, stderr) => {
				const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
				resolve({ out: `${stdout}${stderr}`, code });
			},
		);
		child.stdin?.end();
	});
}

describe("no untrusted argument reaches the terminal as a control byte", () => {
	for (const [label, vectors] of VECTORS) {
		for (const json of [false, true]) {
			it(`${label}${json ? " --json" : ""}`, async () => {
				// A fresh valid vault per group: some of these commands write to it.
				const cwd = join(tmp, `${label}-${json ? "j" : "h"}`);
				const w = createAuditWriter(cwd);
				await w.appendEvent({ kind: "llm_call", actor: "local", data: { i: 0 } });
				await w.flush();
				w.release();
				// `secret` loads the config before it prints anything; without one it throws and its
				// success paths (which echo the credential name) are never exercised.
				writeFileSync(join(cwd, ".usertrust", "usertrust.config.json"), '{"budget":1000}');

				const offenders: string[] = [];
				for (const args of vectors) {
					const argv = json ? [...args, "--json"] : args;
					const r = await run(cwd, argv);
					if (RAW_CONTROL.test(r.out)) {
						offenders.push(`${JSON.stringify(argv)} -> ${JSON.stringify(r.out.slice(0, 160))}`);
					}
				}
				expect(offenders, offenders.join("\n")).toEqual([]);
			}, 240_000);
		}
	}
});
