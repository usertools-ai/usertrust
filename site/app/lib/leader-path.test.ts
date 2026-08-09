import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLeaderPath } from "./leader-path";

/*
 * The leader used to be a cubic bezier, and these tests used to pin its
 * control handles. Addendum K replaced every connector on the page with ONE
 * routed circuit grammar, so the contract they should pin changed with it:
 * the endpoints are still exact, and the shape is now "orthogonal run, then a
 * diagonal, with filleted corners and no curves". The routing maths itself is
 * pinned in sections/lib/trace-style.test.ts — these are the delegation
 * contract, which is what this module still owns.
 */

test("starts at the label edge and ends at the field edge", () => {
	const d = buildLeaderPath(10, 20, 200, 80);
	assert.ok(d.startsWith("M 10 20 "), `unexpected start: ${d}`);
	assert.ok(d.endsWith(" 200 80"), `unexpected end: ${d}`);
});

test("leads HORIZONTALLY — the rail sits left of the terminal, so the run starts across", () => {
	// dx 300, dy -40: the surplus x is spent first, so the first segment holds
	// the label's y and the diagonal closes the rest.
	const d = buildLeaderPath(0, 50, 300, 10);
	const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
	// nums[0..1] is the M point; nums[2..3] is the end of the first straight run.
	assert.equal(nums[1], 50, "the leader must leave the label at the label's own y");
	assert.equal(nums[3], 50, "the first segment must not change y under a horizontal lead");
});

test("no curve commands — the grammar is lines and corner fillets only", () => {
	const d = buildLeaderPath(10, 20, 200, 80);
	assert.ok(!/[CSTA]/.test(d), `a bezier survived in the routed grammar: ${d}`);
	// L takes one point; Q takes a control point and an end point.
	assert.match(d, /^M [\d.]+ [\d.]+(?: L [\d.]+ [\d.]+| Q [\d.]+ [\d.]+ [\d.]+ [\d.]+)+$/);
});

test("a run with no vertical offset is one straight segment", () => {
	assert.equal(buildLeaderPath(0, 0, 30, 0), "M 0 0 L 30 0");
});
