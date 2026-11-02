// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CI RUNS scan-linear.test.ts IN ITS OWN JOB, WITHOUT COVERAGE, AND NOWHERE ELSE.
 *
 * Its linearity rows take minutes of measuring, so the `test` job excludes the file and the
 * `scan-linear` job runs it, plain. Dropping the exclusion would put minutes back on the test
 * job; dropping the job, or its step, would leave the file unrun while every job passes. This
 * reads the workflow as YAML (not matched as prose) and requires both sides.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "../../../..");
const FILE = "packages/core/tests/harden/scan-linear.test.ts";

interface Step {
	run?: unknown;
}

const jobs = (
	parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
		jobs: Record<string, { steps?: Step[] }>;
	}
).jobs;

/** The words of each step of `job` that runs vitest. */
function vitestRuns(job: string): string[][] {
	return (jobs[job]?.steps ?? [])
		.map((step) => (typeof step.run === "string" ? step.run.split(/\s+/).filter(Boolean) : []))
		.filter((words) => words.includes("vitest"));
}

describe("scan-linear.test.ts runs in its own CI job", () => {
	it("the test job's vitest runs all exclude it", () => {
		const runs = vitestRuns("test");
		expect(runs.length).toBeGreaterThan(0);
		for (const words of runs) {
			const at = words.indexOf("--exclude");
			expect(at, words.join(" ")).toBeGreaterThan(-1);
			expect(words[at + 1], words.join(" ")).toBe(FILE);
		}
	});

	it("the scan-linear job runs it, without coverage", () => {
		const runs = vitestRuns("scan-linear");
		expect(runs).toHaveLength(1);
		const words = runs[0] as string[];
		expect(words).toContain(FILE);
		expect(words.some((w) => w.startsWith("--coverage"))).toBe(false);
	});
});
