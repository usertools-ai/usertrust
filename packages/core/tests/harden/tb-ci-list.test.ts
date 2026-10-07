// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CI MUST RUN EVERY REAL-LEDGER SUITE.
 *
 * Every TigerBeetle-backed suite self-skips when `USERTRUST_TB_ADDRESS` is unset, which is
 * exactly the state of the ordinary `test` job. The `tb-integration` job is therefore the
 * ONLY place such a suite ever runs, and it runs an explicit list of files. A suite that is
 * missing from that list is skipped everywhere, reports green, and says nothing — which is
 * how `reconciliation-cache-day.tb.test.ts` went unrun until this guard existed.
 *
 * This reads the workflow's actual step (parsed as YAML, not matched as prose), finds every
 * real-ledger suite on disk, and requires each to appear in the list.
 *
 * WHAT COUNTS AS A REAL-LEDGER SUITE: a file named `*.tb.test.ts`, OR any test file that
 * READS the env key from `process.env` (every current suite does, as
 * `const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;`, but any spelling counts: an inline
 * `describe.skipIf(!process.env.…)`, an `export const`, a destructuring). The second rule is
 * what catches `openclaw/tests/envelope-integration.test.ts`, which lives outside any
 * `integration/` folder and has no `.tb` in its name. Matching the READ rather than one
 * binding shape is what keeps a differently-gated future suite from escaping silently.
 * Comment lines do not count, the guard's own path is excluded (it names the key to parse
 * the YAML), and `NOT_SUITES` is the explicit exemption list for anything else.
 *
 * Declared residue: a suite that reaches the env through a helper (`const env = process.env`
 * then `env.K`, or an imported gate function) cannot be found by text; none exists today.
 * And the workflow check is that the key is SET on the step, not that its value is non-empty.
 *
 * The root is derived from this file's own location, so the guard compares a tree's suites
 * against that tree's workflow, never a sibling worktree's.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "../../../..");
const WORKFLOW = join(ROOT, ".github/workflows/ci.yml");
const GUARD = "packages/core/tests/harden/tb-ci-list.test.ts";
const JOB = "tb-integration";
const ENV_KEY = "USERTRUST_TB_ADDRESS";

/**
 * A READ of the env key from `process.env`, in any spelling: `process.env.K`,
 * `process.env["K"]`, or `{ K } = process.env` (the destructuring may span lines). A suite
 * gated any way other than today's `const TB_ADDRESS = ...` binding (an inline
 * `describe.skipIf(!process.env.K)`, an `export const`) is therefore still discovered, so
 * it fails loud when unlisted instead of escaping silently.
 */
const READS_KEY =
	/process\.env(?:\.USERTRUST_TB_ADDRESS\b|\[\s*["'`]USERTRUST_TB_ADDRESS["'`]\s*\])|\{[^}]*\bUSERTRUST_TB_ADDRESS\b[^}]*\}\s*=\s*process\.env\b/;

/** Comment lines are prose, not reads: a doc block quoting the key must not make a suite. */
const COMMENT_LINE = /^\s*(?:\*|\/\/|\/\*)/;

/**
 * Files that read the key without being a gated suite. Empty today; an entry is a decision
 * to exempt a file from CI, so add one only with a reason beside it.
 */
const NOT_SUITES: ReadonlySet<string> = new Set();

interface SourceFile {
	rel: string;
	source: string;
}

/** The files `tb-integration` runs, from its test step's `run` scalar. Throws if absent. */
function listedSuites(workflowYaml: string): string[] {
	const doc = parse(workflowYaml) as {
		jobs?: Record<string, { steps?: { env?: Record<string, unknown>; run?: unknown }[] }>;
	};
	const steps = doc?.jobs?.[JOB]?.steps;
	if (!Array.isArray(steps)) throw new Error(`job ${JOB} has no steps`);
	const step = steps.find((s) => s.env && ENV_KEY in s.env && typeof s.run === "string");
	if (!step || typeof step.run !== "string") {
		throw new Error(`job ${JOB} has no step that sets ${ENV_KEY} and runs tests`);
	}
	const tokens = step.run.split(/\s+/).filter(Boolean);
	if (tokens.slice(0, 3).join(" ") !== "npx vitest run") {
		throw new Error(`job ${JOB} test step does not start with "npx vitest run"`);
	}
	return tokens.slice(3);
}

/** Every real-ledger suite among `files`, never counting the guard itself. */
function discoverSuites(
	files: SourceFile[],
	notSuites: ReadonlySet<string> = NOT_SUITES,
): string[] {
	const readsKey = (source: string): boolean =>
		READS_KEY.test(
			source
				.split("\n")
				.filter((line) => !COMMENT_LINE.test(line))
				.join("\n"),
		);
	return files
		.filter((f) => f.rel !== GUARD && !notSuites.has(f.rel))
		.filter((f) => f.rel.endsWith(".tb.test.ts") || readsKey(f.source))
		.map((f) => f.rel)
		.sort();
}

function missingFrom(discovered: string[], listed: string[]): string[] {
	const have = new Set(listed);
	return discovered.filter((d) => !have.has(d));
}

function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.name.endsWith(".test.ts")) out.push(full);
	}
}

function repoTestFiles(): SourceFile[] {
	const out: string[] = [];
	for (const pkg of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		try {
			walk(join(ROOT, "packages", pkg.name, "tests"), out);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
	return out.map((full) => ({
		rel: relative(ROOT, full).split(sep).join("/"),
		source: readFileSync(full, "utf8"),
	}));
}

const workflowText = readFileSync(WORKFLOW, "utf8");
const listed = listedSuites(workflowText);
const discovered = discoverSuites(repoTestFiles());

describe("tb-integration runs every real-ledger suite", () => {
	it("lists every suite found on disk", () => {
		expect(missingFrom(discovered, listed)).toEqual([]);
	});

	it("lists only files that exist (a stale entry is a silent no-op)", () => {
		const onDisk = new Set(repoTestFiles().map((f) => f.rel));
		expect(listed.filter((l) => !onDisk.has(l))).toEqual([]);
	});

	it("lists no file twice", () => {
		expect(listed.filter((l, i) => listed.indexOf(l) !== i)).toEqual([]);
	});

	it("discovery is not vacuous: it finds the suites the issue names", () => {
		expect(discovered.length).toBeGreaterThanOrEqual(10);
		expect(discovered).toContain("packages/openclaw/tests/envelope-integration.test.ts");
		expect(discovered).toContain(
			"packages/core/tests/integration/reconciliation-cache-day.tb.test.ts",
		);
	});

	it("does not discover itself", () => {
		expect(discovered).not.toContain(GUARD);
	});
});

describe("the guard itself", () => {
	// Built by concatenation: a fixture line must never START with the gating construct, or
	// this file would match its own rule.
	const gated = `const TB_ADDRESS = process.env.${ENV_KEY};\n`;
	const fixture = (rel: string, source = ""): SourceFile => ({ rel, source });

	it("turns red when ANY single entry is deleted from the real list", () => {
		for (const entry of listed) {
			const without = listed.filter((l) => l !== entry);
			expect(missingFrom(discovered, without)).toContain(entry);
		}
	});

	it("catches an unlisted .tb.test.ts", () => {
		const found = discoverSuites([fixture("packages/x/tests/new.tb.test.ts")]);
		expect(missingFrom(found, listed)).toEqual(["packages/x/tests/new.tb.test.ts"]);
	});

	// Every spelling of "this file reads the env key from process.env" must be discovered; a
	// suite gated any other way than today's binding would otherwise escape silently.
	const readForms: Record<string, string> = {
		"a binding": gated,
		"an inline skipIf": `describe.skipIf(!process.env.${ENV_KEY})("x", () => {});\n`,
		"an export const": `export const TB = process.env.${ENV_KEY};\n`,
		"a destructuring": `const { ${ENV_KEY}: addr } = process.env;\n`,
		"a bracket read": `const a = process.env["${ENV_KEY}"];\n`,
		"an indented read": `\tif (process.env.${ENV_KEY}) run();\n`,
	};
	for (const [name, source] of Object.entries(readForms)) {
		it(`catches an unlisted non-.tb suite gated by ${name}`, () => {
			const found = discoverSuites([fixture("packages/x/tests/odd.test.ts", source)]);
			expect(missingFrom(found, listed)).toEqual(["packages/x/tests/odd.test.ts"]);
		});
	}

	it("does not demand a suite that merely mentions the env key", () => {
		const prose = ` * Self-skips without \`${ENV_KEY}\`.\n`;
		const commented = ` * e.g. process.env.${ENV_KEY}\n// process.env.${ENV_KEY}\n`;
		const read = `const v = parse(x).env.${ENV_KEY};\n`;
		const src = prose + commented + read;
		expect(discoverSuites([fixture("packages/x/tests/a.test.ts", src)])).toEqual([]);
	});

	it("does not discover the guard path even when it reads the key", () => {
		expect(discoverSuites([fixture(GUARD, gated)])).toEqual([]);
	});

	it("honours an explicit allowlist for a file that reads the key without being a suite", () => {
		const f = fixture("packages/x/tests/helper.test.ts", gated);
		expect(discoverSuites([f], new Set())).toEqual(["packages/x/tests/helper.test.ts"]);
		expect(discoverSuites([f], new Set(["packages/x/tests/helper.test.ts"]))).toEqual([]);
	});

	it("catches a listed path that does not exist", () => {
		const onDisk = new Set(repoTestFiles().map((f) => f.rel));
		const withGhost = [...listed, "packages/x/tests/ghost.tb.test.ts"];
		expect(withGhost.filter((l) => !onDisk.has(l))).toEqual(["packages/x/tests/ghost.tb.test.ts"]);
	});

	it("fails loud, not vacuous, when the job or its test step cannot be found", () => {
		const renamed = workflowText.replace(`  ${JOB}:`, "  renamed-job:");
		expect(renamed).not.toBe(workflowText);
		expect(() => listedSuites(renamed)).toThrow(/no steps/);
		const noEnv = workflowText.replace(`${ENV_KEY}: "3000"`, `OTHER_KEY: "3000"`);
		expect(noEnv).not.toBe(workflowText);
		expect(() => listedSuites(noEnv)).toThrow(/no step that sets/);
	});
});
