import assert from "node:assert/strict";
import { test } from "node:test";
import { denialThrowText, THROWN_DENIAL } from "./exhibit-c-data";

test("the captured artifact is the real PolicyDeniedError the SDK throws", () => {
	assert.equal(THROWN_DENIAL.name, "PolicyDeniedError");
	assert.match(THROWN_DENIAL.message, /^Policy denied: /);
	// the rule that actually denied the overshoot, named in the thrown message
	assert.match(THROWN_DENIAL.message, /\[block-budget-overshoot\]/);
});

test("the card renders the WHOLE throw — hint and docs line included", () => {
	assert.match(THROWN_DENIAL.message, /\n {2}Hint: /);
	assert.match(
		THROWN_DENIAL.message,
		/\n {2}Docs: https:\/\/usertrust\.ai\/docs\/errors\/policy-denied$/,
	);
	assert.equal(denialThrowText(), `${THROWN_DENIAL.name}: ${THROWN_DENIAL.message}`);
});

test("the denial artifact claims neither a receipt nor an audit event", () => {
	// A blocked call throws and nothing moves: no receipt, and (product gap
	// filed 2026-08-07) no audit event either. The page must never imply one.
	const text = denialThrowText().toLowerCase();
	assert.ok(!text.includes("receipt"), "a denial has no receipt to show");
	assert.ok(!text.includes("audit"), "a denial writes no audit event today");
});

test("provenance records the probe that produced the throw", () => {
	assert.match(THROWN_DENIAL.capturedFrom, /dry-run/);
	assert.match(THROWN_DENIAL.capturedFrom, /max_tokens/);
	assert.ok(THROWN_DENIAL.capturedWith.length > 0);
});
