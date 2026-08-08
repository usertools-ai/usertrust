import assert from "node:assert/strict";
import { test } from "node:test";
import { barcodeBars } from "../app/lib/barcode";

test("known vector: '0f' -> widths 1 and 4 with unit gaps", () => {
	const { bars, total } = barcodeBars("0f");
	// '0' -> (0 % 4) + 1 = 1 wide at x=0; gap 1; 'f' -> (15 % 4) + 1 = 4 wide at x=2.
	assert.deepEqual(bars, [
		{ x: 0, width: 1 },
		{ x: 2, width: 4 },
	]);
	assert.equal(total, 6);
});

test("24-char prefix yields 24 bars, deterministic, widths in 1..4, unit gaps", () => {
	const prefix = "a3f09b1c4d7e2058a3f09b1c";
	const a = barcodeBars(prefix);
	const b = barcodeBars(prefix);
	assert.deepEqual(a, b, "same input must give identical geometry");
	assert.equal(a.bars.length, 24);
	for (let i = 0; i < a.bars.length; i++) {
		assert.ok(a.bars[i].width >= 1 && a.bars[i].width <= 4);
		if (i > 0) assert.equal(a.bars[i].x, a.bars[i - 1].x + a.bars[i - 1].width + 1);
	}
});

test("rejects non-hex input", () => {
	assert.throws(() => barcodeBars("xyz"), /non-hex/);
});
