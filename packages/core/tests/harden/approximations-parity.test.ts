// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// AGENTS.md calls its "Documented pricing approximations" paragraph "verbatim, also
// published at /docs/api/pricing". A mirror is only worth anything if it is exact:
// let the two drift and a contributor reading either one is told a different list of
// what the pricing table does NOT model (a Haiku 5.5 tier overstated 5x, fast mode
// unpriced, ...), with nothing failing. This reads both paragraphs out of the repo
// and requires them byte-equal.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The lines after `marker` up to the next blank line, joined with "\n". */
function paragraphAfter(text: string, marker: string): string {
	const at = text.indexOf(marker);
	if (at === -1) throw new Error(`marker not found: ${marker}`);
	const rest = text.slice(at + marker.length).replace(/^\n+/, "");
	return rest.split("\n\n", 1)[0] ?? "";
}

describe("documented pricing approximations: AGENTS.md and /docs/api/pricing stay verbatim", () => {
	const agents = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf-8");
	const docs = readFileSync(join(REPO_ROOT, "site/content/docs/api/pricing.mdx"), "utf-8");

	const fromAgents = paragraphAfter(
		agents,
		"**Documented pricing approximations — verbatim, also published at `/docs/api/pricing`:**",
	);
	const fromDocs = paragraphAfter(docs, "line-for-line, because:");

	it("both paragraphs were found and carry the clauses that matter", () => {
		for (const p of [fromAgents, fromDocs]) {
			expect(p).toContain("Per-TTL write premium collapsed");
			expect(p).toContain("claude-haiku-5-5");
			expect(p).toContain("fast mode is not priced");
			expect(p).toContain("Estimates never model cache state.");
		}
	});

	it("are byte-identical", () => {
		expect(fromDocs).toBe(fromAgents);
	});
});
