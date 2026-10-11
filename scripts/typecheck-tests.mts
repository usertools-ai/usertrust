// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Typecheck every package's TESTS (#193) — with a ratchet.
 *
 * The packages' own tsconfigs include `src` only, so a test could assert on the wrong shape (a
 * wrong destructure, a missing required field) and still pass. `tsconfig.tests.json` typechecks
 * `packages/*\/tests/**\/*.ts`, resolving the workspace packages to source as vitest does.
 *
 * The tests carried 439 errors when this landed, nearly all in core's mock typing. Rather than
 * rewrite them in one sweep, the errors are FROZEN in `tsconfig.tests.baseline.json`, keyed by
 * file and error code (never by line: line numbers move whenever a file is edited):
 *  - a NEW key, or a key whose count GREW, fails — no test may add a type error;
 *  - a key whose count SHRANK also fails until the baseline is tightened (`--update`), so the
 *    baseline only ever moves down and never hides a regression behind a fixed error;
 *  - an error tsc reports outside any file (a config error) always fails;
 *  - tsc exiting non-zero with no parseable diagnostic fails (it did not run).
 *
 *   tsx scripts/typecheck-tests.mts            # check against the baseline
 *   tsx scripts/typecheck-tests.mts --update   # rewrite the baseline to the current errors
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Counts = Record<string, number>;

export interface Comparison {
	added: string[];
	grown: Array<{ key: string; baseline: number; now: number }>;
	shrunk: Array<{ key: string; baseline: number; now: number }>;
	global: string[];
}

const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error (TS\d+): /;

/** tsc's `--pretty false` output → counts keyed `<file> <code>`, and file-less errors. */
export function parse(output: string): { counts: Counts; global: string[] } {
	const counts: Counts = {};
	const global: string[] = [];
	for (const line of output.split("\n")) {
		const m = DIAGNOSTIC.exec(line);
		if (m !== null) {
			const key = `${(m[1] as string).replaceAll("\\", "/")} ${m[2]}`;
			counts[key] = (counts[key] ?? 0) + 1;
		} else if (/\berror TS\d+:/.test(line)) {
			global.push(line.trim());
		}
	}
	return { counts, global };
}

/** The ratchet's verdict: anything in `added`, `grown`, `shrunk` or `global` fails. */
export function compare(baseline: Counts, now: Counts, global: string[] = []): Comparison {
	const added: string[] = [];
	const grown: Comparison["grown"] = [];
	const shrunk: Comparison["shrunk"] = [];
	for (const [key, n] of Object.entries(now)) {
		const b = baseline[key];
		if (b === undefined) added.push(key);
		else if (n > b) grown.push({ key, baseline: b, now: n });
		else if (n < b) shrunk.push({ key, baseline: b, now: n });
	}
	for (const [key, b] of Object.entries(baseline)) {
		if (now[key] === undefined) shrunk.push({ key, baseline: b, now: 0 });
	}
	return { added: added.sort(), grown, shrunk, global };
}

export function failed(c: Comparison): boolean {
	return c.added.length + c.grown.length + c.shrunk.length + c.global.length > 0;
}

function sorted(c: Counts): Counts {
	return Object.fromEntries(Object.entries(c).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function main(): number {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const baselinePath = join(root, "tsconfig.tests.baseline.json");
	const tsc = createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");
	const r = spawnSync(process.execPath, [tsc, "-p", "tsconfig.tests.json", "--pretty", "false"], {
		cwd: root,
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	const { counts, global } = parse(output);
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	if (r.status !== 0 && total === 0 && global.length === 0) {
		console.error(
			`typecheck-tests: tsc exited ${r.status} with no diagnostics — it did not run:\n${output}`,
		);
		return 1;
	}
	if (process.argv.includes("--update")) {
		if (global.length > 0) {
			console.error(
				`typecheck-tests: refusing to baseline file-less errors:\n${global.join("\n")}`,
			);
			return 1;
		}
		writeFileSync(baselinePath, `${JSON.stringify(sorted(counts), null, "\t")}\n`);
		console.log(
			`typecheck-tests: baseline written — ${total} error(s) in ${Object.keys(counts).length} key(s)`,
		);
		return 0;
	}
	const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as Counts;
	const c = compare(baseline, counts, global);
	if (!failed(c)) {
		console.log(`typecheck-tests: OK — ${total} baselined error(s), none new`);
		return 0;
	}
	for (const g of c.global) console.error(`  config error: ${g}`);
	for (const k of c.added) console.error(`  NEW type error(s): ${k} (×${counts[k]})`);
	for (const g of c.grown) console.error(`  MORE type errors: ${g.key} ${g.baseline} → ${g.now}`);
	for (const s of c.shrunk)
		console.error(`  fixed (tighten the baseline): ${s.key} ${s.baseline} → ${s.now}`);
	if (c.added.length + c.grown.length + c.global.length > 0) {
		console.error(
			"typecheck-tests: a test added a type error. Fix it — the baseline only ever shrinks. (Details: node_modules/.bin/tsc -p tsconfig.tests.json)",
		);
	} else {
		console.error(
			"typecheck-tests: errors were fixed — run `npm run typecheck:tests -- --update` to tighten the baseline.",
		);
	}
	return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main();
}
