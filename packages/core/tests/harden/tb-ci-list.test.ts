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
 * carries the gating construct every current suite uses, a line-leading binding of the env
 * key (`const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;`). The second rule is what
 * catches `openclaw/tests/envelope-integration.test.ts`, which lives outside any
 * `integration/` folder and has no `.tb` in its name. The match is on that construct, never
 * on the bare key: this file reads the key out of the YAML, and a bare-key match would make
 * the guard demand its own place in the list. It is also excluded by path.
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

/** The gating construct: a binding of the env key at the START of a line (not a comment). */
const GATE = /^[ \t]*(?:const|let|var)[ \t]+\w+[ \t]*=[ \t]*process\.env\.USERTRUST_TB_ADDRESS\b/m;

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
function discoverSuites(files: SourceFile[]): string[] {
	return files
		.filter((f) => f.rel !== GUARD)
		.filter((f) => f.rel.endsWith(".tb.test.ts") || GATE.test(f.source))
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

	it("catches an unlisted non-.tb suite that carries the gating construct", () => {
		const found = discoverSuites([fixture("packages/x/tests/odd.test.ts", gated)]);
		expect(missingFrom(found, listed)).toEqual(["packages/x/tests/odd.test.ts"]);
	});

	it("does not demand a suite that merely mentions the env key", () => {
		const prose = ` * Self-skips without \`${ENV_KEY}\`.\n`;
		const read = `const v = parse(x).env.${ENV_KEY};\n`;
		expect(discoverSuites([fixture("packages/x/tests/a.test.ts", prose + read)])).toEqual([]);
	});

	it("does not discover the guard path even when it carries the gating construct", () => {
		expect(discoverSuites([fixture(GUARD, gated)])).toEqual([]);
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
