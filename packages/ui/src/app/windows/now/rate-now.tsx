// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Rate now: the last hour's spend, what it reads as against the usual range, and the past 24 hours as a small line.
 * Props only. It reads now wherever it is drawn (at a past position too), so its heading never changes.
 *
 * The line is the default ink, or the one filtered category's colour; an unusual rate is gold, with a dot on the last
 * hour. The small form shades the usual range behind the line; the filled form's tile is the plain line (the week's
 * chart beside it shades the range).
 */

import { monotone } from "../../../shared/curve.js";
import { formatUsdTotal } from "../../../shared/format.js";
import { NOW_COPY } from "../../../shared/now-copy.js";
import { type RateNowView, rateWords } from "../../../shared/now-rate.js";

/** The hours the small line covers. */
const SPARK_HOURS = 24;
/** The line's box, in px: the svg is drawn at exactly this size, so nothing in it is stretched. */
const W = 96;
const H = 32;
const PAD = 2;

export function RateNow(props: {
	view: RateNowView;
	color: string | null;
	filled: boolean;
}): React.JSX.Element {
	const { view } = props;
	const { hours, band } = view;
	const from = hours.length - SPARK_HOURS;
	const last = hours.length - 1;
	const shade = view.known && !props.filled;
	// The shaded hours: back from the last one for as long as the range is defined.
	let first = last;
	while (first > from && Number.isFinite(band.hi[first - 1]) && Number.isFinite(band.lo[first - 1]))
		first--;
	// From zero to the 24 hours' peak (at least 1 UT, so a flat zero is a flat line), and the range's top when shaded.
	let max = 1;
	for (let k = from; k <= last; k++) max = Math.max(max, hours[k] as number);
	if (shade) for (let k = first; k <= last; k++) max = Math.max(max, band.hi[k] as number);
	const x = (k: number): number => PAD + ((k - from) / (SPARK_HOURS - 1)) * (W - 2 * PAD);
	const y = (v: number): number => H - PAD - (v / max) * (H - 2 * PAD);
	const xs: number[] = [];
	const ys: number[] = [];
	for (let k = from; k <= last; k++) {
		xs.push(x(k));
		ys.push(y(hours[k] as number));
	}
	let top = "";
	let bottom = "";
	for (let k = first; k <= last; k++) {
		top += `${k === first ? "M" : "L"}${x(k).toFixed(1)} ${y(band.hi[k] as number).toFixed(1)}`;
		bottom = `L${x(k).toFixed(1)} ${y(band.lo[k] as number).toFixed(1)}${bottom}`;
	}
	const stroke = view.unusual ? "var(--dk-gold)" : (props.color ?? "var(--dk-text)");
	return (
		<div className="ut-fact ut-nw-rate" data-unusual={view.unusual}>
			<b>Rate now</b>
			<span className="v" data-fig="now.rate">
				{formatUsdTotal(view.ratePerHourUt)}
				<small>/h</small>
			</span>
			<span className="ut-nw-words" title={NOW_COPY.rateTip}>
				{rateWords(view)}
			</span>
			<svg
				role="img"
				aria-label="The past 24 hours, hour by hour"
				width={W}
				height={H}
				viewBox={`0 0 ${W} ${H}`}
			>
				{shade && first < last && <path className="ut-nw-band" d={`${top}${bottom}Z`} />}
				<path className="ut-nw-line" d={monotone(xs, ys).path()} style={{ stroke }} />
				{view.unusual && (
					<circle className="ut-nw-dot" cx={x(last)} cy={y(view.ratePerHourUt)} r={2.5} />
				)}
			</svg>
		</div>
	);
}
