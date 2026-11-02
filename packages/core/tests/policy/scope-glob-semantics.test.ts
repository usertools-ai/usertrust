/**
 * Scope-glob semantics pinned against minimatch 11
 *
 * `matchesScope` (policy rules), `fileMatchesScope` and `scopesOverlap` (scope leases) all call the bare
 * `minimatch(path, pattern)` with no options. Moving from minimatch 10.2.6 to 11.0.x changes the verdict for
 * two shapes of input, and sets a ceiling on a glob's length that the policy schema relies on. These rows write
 * the new behaviour down, so a later minimatch release that moves it again fails here rather than in a verdict.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { describe, expect, it } from "vitest";
import { loadPolicies, matchesScope, PolicyLoadError } from "../../src/policy/gate.js";
import { fileMatchesScope, scopesOverlap } from "../../src/resilience/scope.js";

describe("several ** segments in one pattern", () => {
	const PATTERN = "**/a/b/c/**/d/**";

	it("matchesScope: the pattern now matches a/b/c/d/d (10.2.x did not)", () => {
		expect(matchesScope([PATTERN], ["a/b/c/d/d"])).toBe(true);
	});

	it("fileMatchesScope: the same verdict for a lease's file check", () => {
		expect(fileMatchesScope("a/b/c/d/d", [PATTERN])).toBe(true);
	});

	it("controls: a path that has no d segment after c is still outside, and a plain match still matches", () => {
		expect(matchesScope([PATTERN], ["a/b/c/x/y"])).toBe(false);
		expect(fileMatchesScope("a/b/c/x/y", [PATTERN])).toBe(false);
		expect(matchesScope([PATTERN], ["a/b/c/x/d/y"])).toBe(true);
	});

	it("scopesOverlap: the pattern and the literal path overlap", () => {
		expect(scopesOverlap([PATTERN], ["a/b/c/d/d"])).toBe(true);
		expect(scopesOverlap(["a/b/c/d/d"], [PATTERN])).toBe(true);
	});
});

describe("a scope with a trailing slash against an optional-extglob tail", () => {
	it("matchesScope: a/b/ no longer matches a/b/?(x) or a/b/*(x) (10.2.x did)", () => {
		expect(matchesScope(["a/b/?(x)"], ["a/b/"])).toBe(false);
		expect(matchesScope(["a/b/*(x)"], ["a/b/"])).toBe(false);
	});

	it("fileMatchesScope: the same verdict for a lease's file check", () => {
		expect(fileMatchesScope("a/b/", ["a/b/?(x)"])).toBe(false);
		expect(fileMatchesScope("a/b/", ["a/b/*(x)"])).toBe(false);
	});

	it("controls: the same patterns still match a real tail, and a/b/* was already false for a/b/", () => {
		expect(matchesScope(["a/b/?(x)"], ["a/b/x"])).toBe(true);
		expect(matchesScope(["a/b/*(x)"], ["a/b/xx"])).toBe(true);
		expect(matchesScope(["a/b/*"], ["a/b/"])).toBe(false);
	});

	it("scopesOverlap: the pairs still overlap, through the prefix fallback rather than the glob", () => {
		expect(scopesOverlap(["a/b/"], ["a/b/?(x)"])).toBe(true);
		expect(scopesOverlap(["a/b/?(x)"], ["a/b/"])).toBe(true);
		expect(scopesOverlap(["a/b/"], ["a/b/*(x)"])).toBe(true);
		expect(scopesOverlap(["a/b/*(x)"], ["a/b/"])).toBe(true);
		// and the fallback is what holds them: with the glob refusing both ways, an unrelated pair still does not overlap
		expect(scopesOverlap(["a/b/"], ["c/d/?(x)"])).toBe(false);
	});
});

describe("the glob length ceiling the policy schema relies on", () => {
	const dir = mkdtempSync(join(tmpdir(), "usertrust-scope-glob-"));

	function policyWithPattern(name: string, pattern: string): string {
		const p = join(dir, name);
		writeFileSync(
			p,
			`rules:
  - name: scoped
    effect: deny
    enforcement: hard
    conditions:
      - field: model
        operator: contains
        value: opus
    scopePatterns:
      - "${pattern}"
`,
		);
		return p;
	}

	it("minimatch itself compiles a 65,536-character glob and throws 'pattern is too long' at 65,537", () => {
		expect(() => minimatch("probe", "a".repeat(65_536))).not.toThrow();
		expect(() => minimatch("probe", "a".repeat(65_537))).toThrow(/pattern is too long/);
	});

	it("a 65,535-character scope pattern loads", () => {
		expect(loadPolicies(policyWithPattern("p-65535.yaml", "a".repeat(65_535)))).toHaveLength(1);
	});

	it("a 65,536- or 65,537-character scope pattern is refused at load, not mid-evaluation", () => {
		for (const length of [65_536, 65_537]) {
			const p = policyWithPattern(`p-${length}.yaml`, "a".repeat(length));
			expect(() => loadPolicies(p), `length ${length}`).toThrow(PolicyLoadError);
			expect(() => loadPolicies(p), `length ${length}`).toThrow(/too long/);
		}
	});
});
