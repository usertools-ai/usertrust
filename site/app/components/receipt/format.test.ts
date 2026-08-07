import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTimestamp, formatUsertokens, truncateHash, usdFromUsertokens } from "./format";

test("formatUsertokens groups thousands and suffixes ut", () => {
	assert.equal(formatUsertokens(49958), "49,958 ut");
	assert.equal(formatUsertokens(0), "0 ut");
});

test("usdFromUsertokens converts at 1 ut = $0.0001", () => {
	assert.equal(usdFromUsertokens(42), "$0.0042");
	assert.equal(usdFromUsertokens(50000), "$5.00");
});

test("truncateHash keeps short ids intact and middles-out 64-hex digests", () => {
	assert.equal(truncateHash("tx_mdl3k9q2_1f3c9d2e"), "tx_mdl3k9q2_1f3c9d2e");
	assert.equal(
		truncateHash("9b3c2f6e8a1d4c5b7e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d"),
		"9b3c2f6e8a…9b0c1d",
	);
});

test("formatTimestamp renders date + minute UTC", () => {
	assert.equal(formatTimestamp("2026-07-26T12:00:00.000Z"), "2026-07-26 12:00 UTC");
});
