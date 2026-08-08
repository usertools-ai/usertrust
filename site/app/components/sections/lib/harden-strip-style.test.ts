import assert from "node:assert/strict";
import { test } from "node:test";
import { statValueClassName } from "./harden-strip-style";

test("the shared-verifier-lines stat is the sole emerald mark", () => {
	const cls = statValueClassName("shared verifier lines");
	assert.match(cls, /\btext-ut\b/);
	assert.doesNotMatch(cls, /text-white\/90/);
});

test("every other stat renders in plain off-white, never emerald", () => {
	for (const label of ["harden suites", "test cases", "test assertions", "AGENTS.md invariants"]) {
		const cls = statValueClassName(label);
		assert.match(cls, /text-white\/90/);
		assert.doesNotMatch(cls, /\btext-ut\b/);
	}
});
