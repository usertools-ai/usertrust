// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Every declaration of this plugin's version must agree.
 *
 * The plugin ships through a VERSIONED CACHE: an existing install is not replaced
 * while the advertised version is unchanged. So a version left behind does not
 * degrade the release, it silently withholds it — users keep running the old hooks
 * and every fix in the update is invisible. That is a distribution defect, and no
 * amount of testing the code can catch it.
 *
 * It has already happened once, in the commit that existed to fix exactly this:
 * `package.json` and both `marketplace.json` entries were bumped and
 * `plugin.json` — the one Claude Code gives PRECEDENCE — was not, so the bump was
 * inert (usertools-ai/usertrust#133, Codex round 5).
 *
 * DERIVED, not enumerated: the file list is discovered by globbing, so a new
 * manifest is covered the day it is added rather than the day someone remembers to
 * add it here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "tinyglobby";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

describe("plugin version agreement", () => {
	it("declares one version across every manifest that gates delivery", async () => {
		const files = await glob(["packages/claude-code-plugin/**/*.json", ".claude-plugin/*.json"], {
			cwd: REPO_ROOT,
			ignore: ["**/node_modules/**"],
			absolute: false,
			// REQUIRED: the manifests live in DOT-directories (`.claude-plugin/`), which
			// globs skip by default. Without this the sweep silently misses the very file
			// whose staleness caused the defect — and the size assertion below is what
			// caught that while writing this test.
			dot: true,
		});

		const declared = new Map<string, string>();
		for (const relative of files) {
			const parsed = JSON.parse(readFileSync(join(REPO_ROOT, relative), "utf-8")) as {
				version?: unknown;
				plugins?: Array<{ name?: unknown; version?: unknown }>;
			};
			if (typeof parsed.version === "string") declared.set(relative, parsed.version);
			for (const [index, plugin] of (parsed.plugins ?? []).entries()) {
				if (plugin.name === "usertrust-claude-code" && typeof plugin.version === "string") {
					declared.set(`${relative}#plugins[${index}]`, plugin.version);
				}
			}
		}

		// The guard is only as good as its reach: if the glob stops finding the
		// manifests, every assertion below passes vacuously.
		expect(declared.size).toBeGreaterThanOrEqual(4);
		expect([...declared.keys()]).toContain(
			"packages/claude-code-plugin/.claude-plugin/plugin.json",
		);

		const versions = new Set(declared.values());
		expect(
			versions.size,
			`plugin version declarations disagree: ${JSON.stringify(Object.fromEntries(declared), null, 2)}`,
		).toBe(1);
	});
});
