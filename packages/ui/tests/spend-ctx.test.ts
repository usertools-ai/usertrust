// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	buildCtx,
	dispatchKey,
	firstAreaClip,
	peakRinged,
	resolveScale,
} from "../src/app/windows/spend/ctx.js";
import { type ChartCtx, RING_SELECTOR, type SpendLayer } from "../src/app/windows/spend/layers.js";
import { HEADROOM, MIN_TOP, niceTicks } from "../src/shared/spend-scale.js";
import { chartFixture } from "./helpers/spend-fixture.js";

type Scale = NonNullable<SpendLayer["scale"]>;

function layer(over: Partial<SpendLayer> = {}): SpendLayer {
	return {
		id: "knee",
		z: "mid",
		Layer: (() => null) as unknown as SpendLayer["Layer"],
		...over,
	};
}

describe("resolveScale", () => {
	const fx = chartFixture();
	const peak = fx.model.drawnPeak;

	it("gives no knee and no ticks when no layer has a scale", () => {
		expect(resolveScale([], fx.model.rates, peak)).toEqual({
			knee: Number.POSITIVE_INFINITY,
			ticks: null,
		});
		expect(resolveScale([layer()], fx.model.rates, peak)).toEqual({
			knee: Number.POSITIVE_INFINITY,
			ticks: null,
		});
	});

	it("calls the first layer with a scale with the true rates, the smoothed peak's top and the tick function", () => {
		let seen: Parameters<Scale>[0] | null = null;
		const out = { knee: 100, ticks: [{ drawn: 50, label: 80 }] };
		const first = layer({
			scale: (s) => {
				seen = s;
				return out;
			},
		});
		const second = layer({ id: "bands", scale: () => ({ knee: 5, ticks: [] }) });
		const got = resolveScale([layer({ id: "unusual" }), first, second], fx.model.rates, peak);
		expect(got).toEqual(out);
		const s = seen as unknown as Parameters<Scale>[0];
		expect(s.rate).toBe(fx.model.rates);
		// The top is the passed (smoothed) peak's, never the largest true rate in `rate`.
		expect(peak).toBeLessThan(fx.model.peakRate);
		expect(s.top).toBe(peak * HEADROOM);
		expect(s.ticks(37)).toEqual(niceTicks(37));
	});

	it("falls back to a top of at least the minimum for a quiet range", () => {
		let top = -1;
		resolveScale(
			[
				layer({
					scale: (s) => {
						top = s.top;
						return { knee: Number.POSITIVE_INFINITY, ticks: [] };
					},
				}),
			],
			new Float64Array(4),
			0,
		);
		expect(top).toBe(1);
	});

	it("a peak that is NaN or infinite gives the smallest top, never NaN or infinity", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			let top = -1;
			resolveScale(
				[
					layer({
						scale: (s) => {
							top = s.top;
							return { knee: Number.POSITIVE_INFINITY, ticks: [] };
						},
					}),
				],
				Float64Array.from([1, 2, 3]),
				bad,
			);
			expect(top).toBe(MIN_TOP);
		}
	});
	it("sets the top from the peak it is given, not from the rates, whichever bucket is highest", () => {
		const topFor = (rate: number[], peak: number): number => {
			let top = -1;
			resolveScale(
				[
					layer({
						scale: (s) => {
							top = s.top;
							return { knee: Number.POSITIVE_INFINITY, ticks: [] };
						},
					}),
				],
				Float64Array.from(rate),
				peak,
			);
			return top;
		};
		expect(topFor([1, 2, 30], 30)).toBe(30 * HEADROOM);
		expect(topFor([1, 2, 30], 5)).toBe(5 * HEADROOM);
	});

	it("treats a knee that is NaN, zero or negative as none", () => {
		for (const knee of [Number.NaN, 0, -0.5, -3]) {
			const got = resolveScale(
				[layer({ scale: () => ({ knee, ticks: [] }) })],
				fx.model.rates,
				peak,
			);
			expect(got.knee).toBe(Number.POSITIVE_INFINITY);
		}
	});
});

describe("buildCtx", () => {
	const fx = chartFixture();

	it("carries the model, the series and the geometry", () => {
		const { ctx, model, series, geo } = fx;
		// The TRUE rates, never the smoothed ones the path is drawn from.
		expect(ctx.rate).toBe(model.rates);
		expect(ctx.rate).not.toBe(model.drawn);
		// The smoothed rates the line is drawn from, for a mark that sits on the line.
		expect(ctx.drawn).toBe(model.drawn);
		expect(ctx.nB).toBe(model.values.length);
		expect(ctx.bucketMs).toBe(model.bucketMs);
		expect(ctx.perHour).toBe(3_600_000 / model.bucketMs);
		expect(ctx.idx).toBe(series.idx);
		expect(ctx.w).toBe(geo.w);
		expect(ctx.h).toBe(geo.h);
		expect(ctx.baseY).toBe(geo.baseY);
		expect(ctx.win).toBe(fx.win);
		expect(ctx.rows).toBe(fx.rows);
		for (const k of [0, 5, ctx.nB - 1]) expect(ctx.x(k)).toBe(geo.centerX(k));
		for (const r of [0, 10, model.peakRate]) expect(ctx.y(r)).toBe(geo.yOf(r));
		expect(ctx.curve.path()).toBe(series.d);
	});

	it("has no knee by default and the geometry's knee when one is set", () => {
		expect(fx.ctx.knee).toBe(Number.POSITIVE_INFINITY);
		const kneed = chartFixture({ knee: 40 });
		expect(kneed.ctx.knee).toBe(40);
	});

	it("y maps a true rate through the knee, not as an already-drawn value", () => {
		const kneed = chartFixture({ knee: 40 });
		const r = kneed.model.peakRate;
		expect(kneed.ctx.y(r)).toBe(kneed.geo.yOf(r));
		expect(kneed.ctx.y(r)).not.toBe(kneed.geo.yOfDrawn(r));
	});

	it("passes the cursor and moveTo through untouched", () => {
		const cursor: ChartCtx["cursor"] = { subscribe: () => () => undefined, get: () => null };
		const moved: number[] = [];
		const ctx = buildCtx({
			geo: fx.geo,
			series: fx.series,
			model: fx.model,
			rows: fx.rows,
			win: fx.win,
			cursor,
			moveTo: (k) => {
				moved.push(k);
			},
		});
		expect(ctx.cursor).toBe(cursor);
		ctx.moveTo(4);
		expect(moved).toEqual([4]);
	});
});

describe("dispatchKey", () => {
	const { ctx } = chartFixture();

	it("offers the key to each layer in order and stops at the first that handles it", () => {
		const calls: string[] = [];
		const a = layer({
			id: "bands",
			onKey: () => {
				calls.push("a");
				return false;
			},
		});
		const b = layer({
			id: "unusual",
			onKey: (e) => {
				calls.push(`b:${e.key}`);
				return true;
			},
		});
		const c = layer({
			id: "knee",
			onKey: () => {
				calls.push("c");
				return true;
			},
		});
		expect(dispatchKey([a, b, c], { key: "ArrowLeft" }, ctx)).toBe(true);
		expect(calls).toEqual(["a", "b:ArrowLeft"]);
	});

	it("hands each layer the chart's context, unchanged", () => {
		const seen: unknown[] = [];
		const a = layer({
			onKey: (_e, c) => {
				seen.push(c);
				return false;
			},
		});
		dispatchKey([a], { key: "Home" }, ctx);
		expect(seen).toEqual([ctx]);
		expect(seen[0]).toBe(ctx);
	});

	it("does not call later layers once the first handled the key", () => {
		let second = 0;
		const first = layer({ onKey: () => true });
		const next = layer({
			id: "bands",
			onKey: () => {
				second++;
				return false;
			},
		});
		expect(dispatchKey([first, next], { key: "x" }, ctx)).toBe(true);
		expect(second).toBe(0);
	});

	it("is false when no layer has onKey or none handled it", () => {
		expect(dispatchKey([], { key: "x" }, ctx)).toBe(false);
		expect(dispatchKey([layer()], { key: "x" }, ctx)).toBe(false);
		expect(dispatchKey([layer({ onKey: () => false })], { key: "x" }, ctx)).toBe(false);
	});
});

describe("firstAreaClip", () => {
	const { ctx } = chartFixture();

	it("is null when no layer clips the area", () => {
		expect(firstAreaClip([], ctx)).toBeNull();
		expect(firstAreaClip([layer()], ctx)).toBeNull();
		expect(firstAreaClip([layer({ areaClip: () => null })], ctx)).toBeNull();
	});

	it("is the first path a layer returns, skipping layers that return none", () => {
		const seen: ChartCtx[] = [];
		const got = firstAreaClip(
			[
				layer({ id: "bands", areaClip: () => null }),
				layer({
					id: "unusual",
					areaClip: (c) => {
						seen.push(c);
						return "M0 0H10V10Z";
					},
				}),
				layer({ id: "knee", areaClip: () => "M1 1H2V2Z" }),
			],
			ctx,
		);
		expect(got).toBe("M0 0H10V10Z");
		expect(seen).toEqual([ctx]);
	});
});

describe("peakRinged", () => {
	const { ctx } = chartFixture();

	it("is false when no layer marks the peak", () => {
		expect(peakRinged([], 3, ctx)).toBe(false);
		expect(peakRinged([layer()], 3, ctx)).toBe(false);
	});

	it("is true when any layer says a ring already marks the bucket", () => {
		const ringAt3 = layer({ id: "unusual", marksPeak: (k, c) => k === 3 && c === ctx });
		expect(peakRinged([layer({ marksPeak: () => false }), ringAt3], 3, ctx)).toBe(true);
		expect(peakRinged([ringAt3], 4, ctx)).toBe(false);
	});
});

describe("the seam's optional members", () => {
	it("names the ring buttons by one attribute", () => {
		expect(RING_SELECTOR).toBe("[data-sp-ring]");
	});

	it("takes a layer with every optional member", () => {
		const full: SpendLayer = layer({
			id: "unusual",
			z: "over",
			scale: () => ({ knee: Number.POSITIVE_INFINITY, ticks: [] }),
			onKey: () => false,
			marksPeak: () => false,
			Overlay: () => null,
			Note: () => null,
			areaClip: () => null,
		});
		expect(full.marksPeak?.(0, chartFixture().ctx)).toBe(false);
	});
});
