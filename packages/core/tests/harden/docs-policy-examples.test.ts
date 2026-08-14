// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Every policy example we ship must be a policy that works.
 *
 * The documented flagship rule — `site/content/docs/concepts/policy-engine.mdx`,
 * presented as the canonical `.usertrust/policies/default.yml` and titled "Deny
 * requests to opus-class models in production" — shipped with **no `effect`
 * field**. Run against master with every one of its conditions satisfied
 * (matching model, matching scope, inside the time window) it returned:
 *
 *   decision       : allow
 *   hardViolations : 0
 *   matched        : 1        <- the rule MATCHED and still did not deny
 *
 * An operator copying the documented example got a rule that loads, matches, and
 * never fires. Same shape as everything else on this branch: it looks correct,
 * nothing errors, and the guard is not there.
 *
 * The loader now rejects such a rule outright, which means a stale example is no
 * longer merely useless — it is a startup failure for whoever copies it. That
 * raises the cost of doc drift enough to be worth a mechanical guard.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePolicyFile } from "../../src/policy/gate.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const DOC_FILES = [
	"site/content/docs/policy/rules.mdx",
	"site/content/docs/concepts/policy-engine.mdx",
	"site/content/docs/policy/operators.mdx",
];

interface DocBlock {
	file: string;
	yaml: string;
}

/** Fenced yaml blocks that look like a policy document (not a result payload). */
function policyBlocks(): DocBlock[] {
	const blocks: DocBlock[] = [];
	for (const rel of DOC_FILES) {
		const abs = join(REPO_ROOT, rel);
		// Deliberately NOT skip-if-missing: a guard that silently passes when it
		// cannot find its subject is the exact defect this file exists to catch.
		expect(existsSync(abs), `${rel} not found — update DOC_FILES`).toBe(true);
		const src = readFileSync(abs, "utf-8");
		for (const m of src.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
			const raw = m[1] ?? "";
			const isDoc = raw.includes("rules:");
			// Some examples are shown as a bare rule list, without the `rules:`
			// wrapper. Those are still policies a reader will copy.
			const isBareList = /^\s*-\s+(id|name):/m.test(raw);
			if (!isDoc && !isBareList) continue;
			const yaml = isDoc
				? raw
				: `rules:\n${raw
						.split("\n")
						.map((l) => (l.trim() === "" ? l : `  ${l}`))
						.join("\n")}`;
			blocks.push({ file: rel, yaml });
		}
	}
	return blocks;
}

describe("shipped policy examples in the docs", () => {
	const blocks = policyBlocks();

	it("finds the examples (guards against a vacuous test)", () => {
		expect(blocks.length).toBeGreaterThanOrEqual(3);
	});

	for (const [i, block] of blocks.entries()) {
		it(`${block.file} example #${i + 1} loads under the real validator`, () => {
			// Written to a scratch dir, never into the repo.
			const dir = mkdtempSync(join(tmpdir(), "ut-doc-policy-"));
			const tmp = join(dir, "example.yaml");
			writeFileSync(tmp, block.yaml, "utf-8");
			try {
				const { rules, issues } = validatePolicyFile(tmp);
				expect(
					issues,
					`${block.file} ships a policy example the loader refuses. A reader who copies it gets a startup failure. Issues: ${JSON.stringify(issues)}`,
				).toEqual([]);
				expect(rules.length).toBeGreaterThan(0);
				// A rule with no `effect` used to load, match, and deny nothing.
				for (const r of rules) {
					expect(r.effect, `a documented rule with no effect denies nothing`).toBeDefined();
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
