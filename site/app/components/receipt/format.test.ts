import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUsertokens, usdFromUsertokens } from "./format";

test("formatUsertokens groups thousands and suffixes ut", () => {
	assert.equal(formatUsertokens(49958), "49,958 ut");
	assert.equal(formatUsertokens(0), "0 ut");
});

test("usdFromUsertokens converts at 1 ut = $0.0001", () => {
	assert.equal(usdFromUsertokens(42), "$0.0042");
	assert.equal(usdFromUsertokens(50000), "$5.00");
});
