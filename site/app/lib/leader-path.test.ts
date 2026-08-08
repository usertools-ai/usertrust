import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLeaderPath } from "./leader-path";

test("starts at the label edge and ends at the field edge", () => {
	const d = buildLeaderPath(10, 20, 200, 80);
	assert.ok(d.startsWith("M 10 20 C "), `unexpected start: ${d}`);
	assert.ok(d.endsWith(" 200 80"), `unexpected end: ${d}`);
});

test("control handles are horizontal (hold the label y and the field y)", () => {
	const d = buildLeaderPath(0, 50, 300, 10);
	const m = d.match(/^M 0 50 C ([\d.]+) 50, ([\d.]+) 10, 300 10$/);
	assert.ok(m, `unexpected path: ${d}`);
	assert.ok(Number(m[1]) > 0 && Number(m[1]) < 300);
	assert.ok(Number(m[2]) > 0 && Number(m[2]) < 300);
});

test("short spans keep a minimum 24px handle so the curve stays visible", () => {
	assert.equal(buildLeaderPath(0, 0, 30, 0), "M 0 0 C 24 0, 6 0, 30 0");
});
