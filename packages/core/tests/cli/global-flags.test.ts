// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The flags `main.ts` accepts in front of every command have ONE definition (`cli/flags.ts`).
 *
 * The list used to exist five times (main.ts, flags.ts, target.ts, verify.ts, budget.ts). Copies
 * agree until someone adds a flag to one: then that command takes it and the rest refuse it as
 * unknown, or worse, one skips it as "probably a flag". Two guards, because each catches what the
 * other cannot: a source scan finds a second spelling, a behavioural run finds a command that
 * stopped honouring the shared list.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { GLOBAL_FLAGS } from "../../src/cli/flags.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const cliDir = join(repoRoot, "packages", "core", "src", "cli");
const TSX = join(repoRoot, "node_modules", ".bin", "tsx");
const MAIN = join(cliDir, "main.ts");

describe("global flags are defined once", () => {
	it("no second spelling of a global flag exists in the CLI sources", () => {
		for (const flag of GLOBAL_FLAGS) {
			const spelled = `"${flag}"`;
			// `--json` is also a literal in unrelated commands' own filters; hold the five files
			// that carried the list to the strict rule, and the rest of the tree for the two flags
			// nothing else has a reason to name.
			const strict = ["main.ts", "flags.ts", "target.ts", "verify.ts", "budget.ts"];
			const files = readdirSync(cliDir).filter((f) => f.endsWith(".ts"));
			const holders = files.filter(
				(f) =>
					(flag === "--json" ? strict.includes(f) : true) &&
					readFileSync(join(cliDir, f), "utf-8").includes(spelled),
			);
			expect(holders, `${flag} is spelled outside flags.ts`).toEqual(["flags.ts"]);
		}
	});

	it("the list names exactly the flags main.ts strips", () => {
		expect([...GLOBAL_FLAGS].sort()).toEqual(["--json", "--reconfigure", "--skip-verify"]);
	});
});

describe("every command that reads the list still honours it", () => {
	let tmp: string;
	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "trust-global-flags-"));
		const w = createAuditWriter(tmp);
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { i: 0 } });
		await w.flush();
		w.release();
	});
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	it("none of them is refused as unknown by inspect, verify, or budget", () => {
		const { FORCE_COLOR: _f, ...env } = process.env;
		for (const flag of GLOBAL_FLAGS) {
			for (const cmd of ["inspect", "verify", "budget"]) {
				let out = "";
				try {
					out = execFileSync(TSX, [MAIN, cmd, flag], {
						cwd: tmp,
						encoding: "utf-8",
						env: { ...env, NO_COLOR: "1" },
						stdio: ["ignore", "pipe", "pipe"],
						timeout: 60_000,
					});
				} catch (e) {
					out = String((e as { stdout?: string }).stdout ?? "");
				}
				expect(out, `${cmd} ${flag}`).not.toMatch(/unknown (flag|option)|has no option/i);
			}
		}
	}, 120_000);
});
