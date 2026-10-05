import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, failed, parse } from "./typecheck-tests.mts";

const OUT = [
	"packages/a/tests/x.test.ts(1,2): error TS2554: Expected 0 arguments, but got 1.",
	"packages/a/tests/x.test.ts(9,9): error TS2554: Expected 0 arguments, but got 1.",
	"packages/b/tests/y.test.ts(3,4): error TS2345: Argument of type ...",
	"  continuation line of a long message",
	"error TS5058: The specified path does not exist: 'nope.json'.",
].join("\n");

test("parse: counts per file and code (no line numbers), and file-less errors apart", () => {
	assert.deepEqual(parse(OUT), {
		counts: { "packages/a/tests/x.test.ts TS2554": 2, "packages/b/tests/y.test.ts TS2345": 1 },
		global: ["error TS5058: The specified path does not exist: 'nope.json'."],
	});
});

test("compare: identical counts pass", () => {
	assert.equal(failed(compare({ k: 2 }, { k: 2 })), false);
});

test("compare: a NEW key fails", () => {
	const c = compare({ k: 2 }, { k: 2, other: 1 });
	assert.deepEqual(c.added, ["other"]);
	assert.equal(failed(c), true);
});

test("compare: a key that GREW fails", () => {
	const c = compare({ k: 2 }, { k: 3 });
	assert.deepEqual(c.grown, [{ key: "k", baseline: 2, now: 3 }]);
	assert.equal(failed(c), true);
});

test("compare: a key that SHRANK, or vanished, fails until the baseline is tightened", () => {
	const c = compare({ k: 2, gone: 1 }, { k: 1 });
	assert.deepEqual(c.shrunk, [
		{ key: "k", baseline: 2, now: 1 },
		{ key: "gone", baseline: 1, now: 0 },
	]);
	assert.equal(failed(c), true);
});

test("compare: a file-less (config) error always fails", () => {
	assert.equal(failed(compare({}, {}, ["error TS5058: ..."])), true);
});
