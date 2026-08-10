import assert from "node:assert/strict";
import { test } from "node:test";
import { chainSeqFor, jsonLines, tokenClass } from "./receipt-json";

test("punctuation ink clears the 14px contrast floor (H2)", () => {
	// white/40 on bg-terminal #0d0d20 measures 3.81:1 at the frame's 14px body
	// size; white/60 measures 7.21:1. The token lives here, not in the section.
	assert.equal(tokenClass("punct", false), "text-white/60");
	assert.equal(tokenClass("key", false), "text-tim");
	assert.equal(tokenClass("string", false), "text-white");
	assert.equal(tokenClass("punct", true), "text-ut");
});

test("scalar fields render as single lines keyed by their dotted path", () => {
	const lines = jsonLines({ transferId: "tx_1", settled: true });
	assert.deepEqual(
		lines.map((l) => l.key),
		["root", "transferId", "settled", "root.close"],
	);
	assert.equal(lines[1].indent, 1);
	assert.equal(lines[1].tokens.map((t) => t.text).join(""), '"transferId": "tx_1",');
	assert.equal(lines[2].tokens.map((t) => t.text).join(""), '"settled": true');
});

test("nested objects open at their path, close at path.close, commas placed right", () => {
	const lines = jsonLines({ cost: { estimated: 40, actual: null }, settled: true });
	assert.deepEqual(
		lines.map((l) => l.key),
		["root", "cost", "cost.estimated", "cost.actual", "cost.close", "settled", "root.close"],
	);
	assert.equal(lines[1].tokens.map((t) => t.text).join(""), '"cost": {');
	assert.equal(lines[2].tokens.map((t) => t.text).join(""), '"estimated": 40,');
	assert.equal(lines[3].tokens.map((t) => t.text).join(""), '"actual": null');
	assert.equal(lines[4].tokens.map((t) => t.text).join(""), "},");
	assert.equal(lines[4].indent, 1);
});

test("token roles drive the syntax tinting", () => {
	const lines = jsonLines({ model: "m", cost: { estimated: 40 }, settled: true });
	const model = lines.find((l) => l.key === "model");
	assert.deepEqual(
		model?.tokens.map((t) => t.role),
		["key", "punct", "string", "punct"],
	);
	const est = lines.find((l) => l.key === "cost.estimated");
	assert.deepEqual(
		est?.tokens.map((t) => t.role),
		["key", "punct", "number"],
	);
	const settled = lines.find((l) => l.key === "settled");
	assert.deepEqual(
		settled?.tokens.map((t) => t.role),
		["key", "punct", "boolean"],
	);
});

test("every token key is unique (stable render keys)", () => {
	const lines = jsonLines({ a: "x", b: { c: "y", d: "z" } });
	const keys = lines.flatMap((l) => l.tokens.map((t) => t.key));
	assert.equal(new Set(keys).size, keys.length);
});

test("chainSeqFor: exact auditHash match wins; a miss is null, never the newest entry", () => {
	const slice = {
		entries: [
			{ seq: 4, type: "llm_call", hash: "aaa", prevHash: "zzz", timestamp: "t", summary: "s" },
			{ seq: 5, type: "llm_call", hash: "bbb", prevHash: "aaa", timestamp: "t", summary: "s" },
		],
	};
	assert.equal(chainSeqFor(slice, "aaa"), 4);
	// The old fallback answered 5 here — a real sequence number about a
	// DIFFERENT record, which is how "link 9 of the chain" came to annotate a
	// receipt from another vault entirely.
	assert.equal(chainSeqFor(slice, "not-there"), null);
});
