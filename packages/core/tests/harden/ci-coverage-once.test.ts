// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The `test` job runs the whole suite ONCE, and the coverage thresholds are enforced in that run.
 *
 * They used to be checked by a second, identical run of the suite with the thresholds on the command line, which
 * doubled the job's wall time (about 25 of its 51 minutes). vitest enforces `coverage.thresholds` in the run that
 * collects the coverage, exiting non-zero below them, so the thresholds live in vitest.config.ts and the job has one
 * `vitest run`. These rows keep it that way: a second run, or a weaker threshold, fails here.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf-8");
const CONFIG = readFileSync(join(ROOT, "vitest.config.ts"), "utf-8");

/** The text of one job of ci.yml: from `  <name>:` up to the next job key at the same indent. */
function jobBlock(workflow: string, name: string): string {
	const start = workflow.search(new RegExp(`^  ${name}:\\n`, "m"));
	if (start === -1) throw new Error(`job ${name} not found`);
	const rest = workflow.slice(start + 1);
	const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\n/m);
	return next === -1 ? rest : rest.slice(0, next);
}

/** A job's text without its comment lines. */
function withoutComments(job: string): string {
	return job
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

/** The `vitest run` steps of a job's text, comments excluded. */
function vitestRuns(job: string): number {
	return withoutComments(job)
		.split("\n")
		.filter((line) => /\bvitest run\b/.test(line)).length;
}

/** The numbers under `coverage.thresholds` in the config. */
function thresholds(config: string): Record<string, number> {
	const block = config.match(/thresholds:\s*\{([^}]*)\}/)?.[1] ?? "";
	const out: Record<string, number> = {};
	for (const m of block.matchAll(/(\w+):\s*(\d+)/g)) out[m[1] as string] = Number(m[2]);
	return out;
}

describe("the test job runs the suite once, with the coverage thresholds in that run", () => {
	it("has exactly one vitest run, and it collects coverage", () => {
		const job = jobBlock(CI, "test");
		expect(vitestRuns(job)).toBe(1);
		expect(job).toMatch(/npx vitest run --coverage\b/);
		// the control: the counter sees a second run when there is one
		expect(vitestRuns(`${job}\n      - run: npx vitest run --coverage\n`)).toBe(2);
	});

	it("passes no threshold on the command line, so the config is the one place they are stated", () => {
		expect(withoutComments(jobBlock(CI, "test"))).not.toContain("coverage.thresholds");
		// the control: a threshold flag on a run is seen
		expect(
			withoutComments("      - run: npx vitest run --coverage --coverage.thresholds.lines=92"),
		).toContain("coverage.thresholds");
	});

	it("the config holds all four thresholds at their floors", () => {
		const t = thresholds(CONFIG);
		expect(t.lines).toBeGreaterThanOrEqual(92);
		expect(t.branches).toBeGreaterThanOrEqual(84);
		expect(t.functions).toBeGreaterThanOrEqual(90);
		expect(t.statements).toBeGreaterThanOrEqual(92);
		// the control: a config missing one is read as missing, not as passing
		expect(thresholds(CONFIG.replace(/statements:\s*\d+,?/, "")).statements).toBeUndefined();
	});

	it("the artifact upload still runs after a failing test run, so a threshold failure keeps its report", () => {
		const job = jobBlock(CI, "test");
		const upload = job.slice(job.indexOf("Upload coverage artifact"));
		expect(upload).toMatch(/if:\s*always\(\)/);
	});
});
