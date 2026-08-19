// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Teardown must not hold the event loop open with its own bound.
 *
 * The bound added so `destroy()` could always reach the ledger client was a
 * `Promise.race` against a `setTimeout`. When the work wins — which is EVERY
 * healthy governor, including every dry-run one with nothing to void — the losing
 * timer stays referenced, so `destroy()` returns promptly and Node still cannot
 * exit for the full budget. The fix for "the process cannot exit" delayed process
 * exit, on every teardown, forever.
 *
 * Measured as a real process exit rather than as an assertion inside the test
 * runner: a leaked timer does not fail an assertion, it delays a process, and only
 * a process can observe that. The runner's own handles would mask it entirely.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

describe("teardown does not delay process exit", () => {
	it("exits promptly after destroy(), rather than waiting out its own budget", () => {
		const dir = mkdtempSync(join(tmpdir(), "ut-timer-leak-"));
		const script = join(dir, "exit-timing.mjs");
		// dryRun: no engine, nothing to void — the case where the teardown budget is
		// pure overhead and a leaked timer is pure delay.
		writeFileSync(
			script,
			`import { createGovernor } from "${join(REPO_ROOT, "packages/core/dist/headless.js")}";
const governor = await createGovernor({ vaultBase: ${JSON.stringify(dir)}, dryRun: true, budget: 1000 });
await governor.destroy();
process.stdout.write("destroyed");
// No process.exit(): the point is whether the loop DRAINS on its own.
`,
			"utf-8",
		);

		const startedAt = Date.now();
		const out = execFileSync(process.execPath, [script], { encoding: "utf-8", timeout: 60_000 });
		const elapsedMs = Date.now() - startedAt;

		expect(out).toContain("destroyed");
		// A leaked 5s teardown timer shows up here and nowhere else. Generous, since
		// this pays Node startup and module load too.
		expect(elapsedMs).toBeLessThan(4_500);
	}, 90_000);
});
