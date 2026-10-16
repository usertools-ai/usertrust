// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A test filter that matches no test file must fail, not pass.
 *
 * The defect class is a probe that fails toward success. The root vitest config
 * once set `test.passWithNoTests: true`, so a mis-written filter (a path written
 * relative to a package directory instead of the repo root, a typo, a file that
 * was renamed) printed "No test files found" and EXITED 0. Every script, CI step
 * and lane that reads the exit code then read "zero tests ran" as "tests passed".
 *
 * Row (a) pins the config value, exactly `false` rather than merely falsy. Row (b)
 * pins the behavior end to end: a real run of the repo's own vitest, with a filter
 * that cannot match, exits non-zero and says why. Its control runs the same spawn
 * with a filter that does match, so the non-zero exit is attributable to the empty
 * match and not to the spawn itself being broken (wrong entry file, wrong cwd, a
 * nested-worker environment).
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CONFIG = resolve(REPO_ROOT, "vitest.config.ts");
const VITEST_ENTRY = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");

/** Run the repo's own vitest as a fresh top-level process, not as a nested worker. */
function runVitest(filter: string): { status: number | null; output: string } {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "TEST" || key.startsWith("VITEST")) continue;
		env[key] = value;
	}
	const result = spawnSync(process.execPath, [VITEST_ENTRY, "run", filter, "--config", CONFIG], {
		cwd: REPO_ROOT,
		env,
		encoding: "utf8",
		timeout: 55_000,
	});
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("a vitest filter that matches no test file fails", () => {
	it("(a) the root config sets passWithNoTests to exactly false", async () => {
		const mod = (await import(/* @vite-ignore */ pathToFileURL(CONFIG).href)) as {
			default: { test?: { passWithNoTests?: unknown } };
		};
		expect(mod.default.test?.passWithNoTests).toBe(false);
	});

	it("(b) a filter matching no test file exits non-zero and says so", { timeout: 60_000 }, () => {
		const { status, output } = runVitest("packages/this-path-matches-no-test-file-xyz");
		expect(output).toContain("No test files found");
		expect(status).not.toBe(0);
		expect(status).not.toBeNull();
	});

	it("(b, control) a filter matching one real test file exits 0", { timeout: 60_000 }, () => {
		const { status, output } = runVitest("packages/acs-adapter/tests/vocabulary.test.ts");
		expect(output).not.toContain("No test files found");
		expect(status).toBe(0);
	});
});
