// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { BAND_MIN_HISTORY, BAND_WINDOW, usualBand } from "../src/shared/band.js";

describe("usualBand", () => {
	it("has no bounds until a bucket has 6 buckets of history", () => {
		const b = usualBand(new Array(20).fill(4));
		for (let k = 0; k < BAND_MIN_HISTORY; k++) {
			expect(b.mid[k]).toBeNaN();
			expect(b.lo[k]).toBeNaN();
			expect(b.hi[k]).toBeNaN();
		}
		expect(b.mid[BAND_MIN_HISTORY]).toBe(4);
		expect(b.hi.length).toBe(20);
	});

	it("keeps hi at or above mid, and lo between 0 and mid, wherever it is defined", () => {
		const values = Array.from({ length: 80 }, (_, i) => (i * 37) % 11);
		const b = usualBand(values);
		let defined = 0;
		for (let k = 0; k < values.length; k++) {
			if (Number.isNaN(b.hi[k])) continue;
			defined += 1;
			expect(b.hi[k] as number).toBeGreaterThanOrEqual(b.mid[k] as number);
			expect(b.lo[k] as number).toBeLessThanOrEqual(b.mid[k] as number);
			expect(b.lo[k] as number).toBeGreaterThanOrEqual(0);
		}
		expect(defined).toBe(values.length - BAND_MIN_HISTORY);
	});

	it("is the median of the buckets before it, and leaves the bucket itself out", () => {
		// Bucket 6 sees [1, 2, 3, 4, 5, 6]: median 3.5. Its own value (1000) is not in its history.
		const b = usualBand([1, 2, 3, 4, 5, 6, 1000, 7]);
		expect(b.mid[6]).toBe(3.5);
		expect(b.hi[6] as number).toBeLessThan(100);
		// Bucket 7 now sees the 1000, but the median of [1..6, 1000] is still 4.
		expect(b.mid[7]).toBe(4);
	});

	it("looks back 24 buckets and no further", () => {
		const values = [...new Array(BAND_WINDOW).fill(1), ...new Array(11).fill(9)];
		const b = usualBand(values);
		// Bucket 24 sees 24 ones. Bucket 25 sees 23 ones and a 9: the median is still 1.
		expect(b.mid[BAND_WINDOW]).toBe(1);
		expect(b.mid[BAND_WINDOW + 1]).toBe(1);
		// Bucket 34 sees only the last 24 buckets (indices 10..33): 14 ones and 10 nines.
		expect(b.mid[BAND_WINDOW + 10]).toBe(1);
		// A 25th-oldest bucket never counts: change index 0 and bucket 24 does not move.
		const other = usualBand([100, ...values.slice(1)]);
		expect(other.mid[BAND_WINDOW]).toBe(1);
		expect(other.hi[BAND_WINDOW]).toBe(b.hi[BAND_WINDOW]);
	});

	it("collapses to the median on a flat or empty series, with no NaN once defined", () => {
		const flat = usualBand(new Array(30).fill(0));
		expect(flat.hi[10]).toBe(0);
		expect(flat.lo[10]).toBe(0);
		expect(flat.mid[10]).toBe(0);
	});
});
