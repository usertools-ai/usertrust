import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalEntryString, flipFirstByte, sha256Hex } from "./sha256";

test("sha256Hex matches the known vector for 'test' (echo -n test | shasum -a 256)", async () => {
	assert.equal(
		await sha256Hex("test"),
		"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
	);
});

test("sha256Hex of the empty string matches the canonical empty digest", async () => {
	assert.equal(
		await sha256Hex(""),
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	);
});

test("canonicalEntryString sorts keys alphabetically and injects the linked prevHash", () => {
	const s = canonicalEntryString(
		{
			seq: 2,
			type: "llm_call_settled",
			timestamp: "2026-08-07T00:00:00.000Z",
			summary: "settled",
		},
		"abc123",
	);
	assert.equal(
		s,
		'{"prevHash":"abc123","seq":2,"summary":"settled","timestamp":"2026-08-07T00:00:00.000Z","type":"llm_call_settled"}',
	);
});

test("flipFirstByte changes exactly one byte and is its own inverse", () => {
	const flipped = flipFirstByte("settled");
	assert.notEqual(flipped, "settled");
	assert.equal(flipped.length, "settled".length);
	assert.equal(flipped.slice(1), "ettled");
	assert.equal(flipFirstByte(flipped), "settled");
});

test("a flipped byte changes the digest — the tamper demo's core claim", async () => {
	const entry = {
		seq: 3,
		type: "llm_call_settled",
		timestamp: "2026-08-07T00:00:00.000Z",
		summary: "settled tx_01",
	};
	const intact = await sha256Hex(canonicalEntryString(entry, "prev-hash"));
	const tampered = await sha256Hex(
		canonicalEntryString({ ...entry, summary: flipFirstByte(entry.summary) }, "prev-hash"),
	);
	assert.notEqual(intact, tampered);
});
