// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Rate now: the last hour's spend, what it reads as against the usual range, and the past 24 hours as a small line.
 * Props only. It reads now wherever it is drawn (at a past position too), so its heading never names a position;
 * under a filter the heading says the rate is the filtered records'.
 *
 * The figure is never cut: it shrinks to fit its column as the other facts' figures do, and its title gives it in
 * full.
 *
 * The line is the default ink, or the one filtered category's colour; an unusual rate is gold. The last hour always
 * has a dot, in the line's colour. The small form shades the usual range behind the line, and the line's name says
 * so only when it does; the filled form's tile is the plain line (the week's chart beside it shades the range).
 *
 * With no view (the records have not loaded) it states no figure: the fact keeps its heading, and its words and its
 * line are held empty and unseen in the boxes they will take, so nothing moves when they arrive.
 */

import type { CSSProperties } from "react";
import { monotone } from "../../../shared/curve.js";
import { formatUsd, formatUsdTotal } from "../../../shared/format.js";
import { NOW_COPY } from "../../../shared/now-copy.js";
import { type RateNowView, rateWords } from "../../../shared/now-rate.js";

/** The hours the small line covers. */
const SPARK_HOURS = 24;
/** The line's box, in px: the svg is drawn at exactly this size, so nothing in it is stretched. */
const W = 96;
const H = 32;
const PAD = 2;

export function RateNow(props: {
	view: RateNowView | null;
	color: string | null;
	filled: boolean;
	/** The rate is of the filtered records, not of the whole vault. */
	filtered?: boolean;
	/** The records could not be read: nothing is coming, so the box is not announced as busy. */
	failed?: boolean;
}): React.JSX.Element {
	const { view } = props;
	const heading = props.filtered === true ? NOW_COPY.rateHeadingFiltered : NOW_COPY.rateHeading;
	if (view === null)
		return (
			<div className="ut-fact ut-nw-rate" aria-busy={props.failed === true ? undefined : "true"}>
				<b>{heading}</b>
				<span className="v na">…</span>
				<span className="ut-nw-words" aria-hidden="true" data-reserve="true">
					{"\u00a0"}
				</span>
				<span className="ut-nw-spark" aria-hidden="true" data-reserve="true" />
			</div>
		);
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
	const banded = shade && first < last;
	const figure = formatUsdTotal(view.ratePerHourUt);
	return (
		<div className="ut-fact ut-nw-rate" data-unusual={view.unusual}>
			<b>{heading}</b>
			<span className="v" data-fig="now.rate" title={`${formatUsd(view.ratePerHourUt)}/h`}>
				{/* The figure and its "/h", counted as characters of the figure's own size: a little more room than they take. */}
				<span className="ut-fit" style={{ "--n": figure.length + 2 } as CSSProperties}>
					{figure}
					<small>/h</small>
				</span>
			</span>
			<span className="ut-nw-words" title={NOW_COPY.rateTip}>
				{rateWords(view)}
			</span>
			<svg
				className="ut-nw-spark"
				role="img"
				aria-label={`The past 24 hours, hour by hour${banded ? ", over the usual range" : ""}`}
				width={W}
				height={H}
				viewBox={`0 0 ${W} ${H}`}
			>
				{banded && <path className="ut-nw-band" d={`${top}${bottom}Z`} />}
				<path className="ut-nw-line" d={monotone(xs, ys).path()} style={{ stroke }} />
				<circle
					className="ut-nw-dot"
					cx={x(last)}
					cy={y(hours[last] as number)}
					r={2.5}
					style={{ fill: stroke }}
				/>
			</svg>
		</div>
	);
}
