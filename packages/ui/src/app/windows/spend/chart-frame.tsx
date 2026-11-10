// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend chart's static marks: grid, area, the three-stroke line, the marks a reader is pointed to (a chain break,
 * the open record, the pin) and the live dot, with the three SVG layer slots in between. No state and no effects, so
 * a cursor move never redraws it. Colour is CSS (`--sp-ink`, `--sp-glow`, `--dk-*`, and the sheet's rules for the
 * marks), so this file never branches on it.
 */

import { memo, useId } from "react";
import { formatUsdAxis } from "../../../shared/format.js";
import {
	AREA_HIGHLIGHT,
	AREA_STOPS,
	areaFadeTop,
	type DrawnSeries,
	type Geometry,
	LINE_RECIPE,
	niceTicks,
} from "../../../shared/spend-scale.js";
import { firstAreaClip } from "./ctx.js";
import type { ChartCtx, LayerZ, SpendLayer } from "./layers.js";

export interface ChartFrameProps {
	ctx: ChartCtx;
	geo: Geometry;
	series: DrawnSeries;
	/** The grid; null draws the plain ticks of the scale's top, each labelled with its own value. */
	ticks: Array<{ drawn: number; label: number }> | null;
	layers: readonly SpendLayer[];
	live: boolean;
	/** A pointer or key cursor is on the plot: the area brightens. It changes on enter and leave, not per move. */
	hover: boolean;
	/** The pinned record on the line; null when none is pinned or it is outside the window. */
	pin: { x: number; y: number } | null;
	/** The record open in the Ledger's panel, on the line; null when none is open or it is outside the window. */
	mark: { x: number; y: number } | null;
	/** The first spend record at or after a chain break, on the line; null for a clean chain. */
	brk: { x: number; y: number } | null;
	/** Under a filter: all spend's line, drawn faint on the same scale; null when nothing is filtered. */
	ghost: string | null;
	/** The words that say what the faint line is; drawn only with it. */
	note: string | null;
	idPrefix: string;
}

const DOT_R = 4.5;
const MARK_R = 6.5;
const BREAK_R = 4.5;

/** A stop's opacity, scaled by the highlight and kept to a short decimal (0.13 x 1.25 is 0.1625, not 0.16250000000000003). */
function stopOpacity(a: number, k: number): number {
	return Number(Math.min(1, a * k).toPrecision(12));
}

function slot(layers: readonly SpendLayer[], z: LayerZ, ctx: ChartCtx): React.ReactNode {
	return layers.filter((l) => l.z === z).map((l) => <l.Layer key={l.id} ctx={ctx} />);
}

export const ChartFrame = memo(function ChartFrame(p: ChartFrameProps): React.JSX.Element {
	const { ctx, geo, series, layers, live, hover, pin, mark, brk, ghost, note, idPrefix } = p;
	const uid = `${idPrefix}${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
	const gradId = `${uid}-area`;
	const glowId = `${uid}-glow`;
	const clipId = `${uid}-clip`;
	const breakId = `${uid}-break`;
	const drawn = series.d !== "";
	const fadeTop = areaFadeTop(ctx.drawn, ctx.y, ctx.baseY);
	const strength = hover ? AREA_HIGHLIGHT : 1;
	const clip = firstAreaClip(layers, ctx);
	const ticks = p.ticks ?? niceTicks(geo.top).map((t) => ({ drawn: t, label: t }));
	return (
		<svg
			className="ut-sp-svg"
			width={ctx.w}
			height={ctx.h}
			viewBox={`0 0 ${ctx.w} ${ctx.h}`}
			aria-hidden="true"
		>
			<defs>
				<linearGradient
					id={gradId}
					gradientUnits="userSpaceOnUse"
					x1="0"
					x2="0"
					y1={fadeTop}
					y2={ctx.baseY}
				>
					{AREA_STOPS.map(([offset, opacity]) => (
						<stop
							key={offset}
							offset={offset}
							stopOpacity={stopOpacity(opacity, strength)}
							style={{ stopColor: "var(--sp-ink)" }}
						/>
					))}
				</linearGradient>
				<filter id={glowId} x="-5%" y="-50%" width="110%" height="200%">
					<feGaussianBlur stdDeviation={LINE_RECIPE.glowBlur} />
				</filter>
				{clip !== null && (
					<clipPath id={clipId}>
						<path d={clip} />
					</clipPath>
				)}
				{brk !== null && (
					<clipPath id={breakId}>
						<rect x={brk.x} y={0} width={Math.max(0, ctx.w - brk.x)} height={ctx.h} />
					</clipPath>
				)}
			</defs>
			<g className="ut-sp-grid-g">
				{ticks.map((t) => {
					const y = geo.yOfDrawn(t.drawn);
					return (
						<g key={`${t.drawn}:${t.label}`}>
							<line
								className="ut-sp-grid"
								x1={0}
								x2={ctx.w}
								y1={y}
								y2={y}
								style={{ stroke: "var(--dk-grid)" }}
							/>
							<text
								className="ut-sp-tick"
								x={ctx.w - 4}
								y={y - 3}
								textAnchor="end"
								style={{ fill: "var(--dk-label)" }}
							>
								{/* A tick is a per-hour rate; shown as one bucket's spend, the unit every figure here uses. */}
								{formatUsdAxis(t.label / ctx.perHour)}
							</text>
						</g>
					);
				})}
			</g>
			{slot(layers, "under", ctx)}
			{drawn && (
				<path
					className="ut-sp-area"
					d={series.area}
					fill={`url(#${gradId})`}
					stroke="none"
					clipPath={clip !== null ? `url(#${clipId})` : undefined}
				/>
			)}
			{slot(layers, "mid", ctx)}
			{ghost !== null && (
				<>
					<path className="ut-sp-ghost" d={ghost} fill="none" />
					{note !== null && (
						<text className="ut-sp-fcap" x={4} y={30}>
							{note}
						</text>
					)}
				</>
			)}
			{drawn && (
				<>
					<path
						className="ut-sp-glow"
						d={series.d}
						fill="none"
						strokeWidth={LINE_RECIPE.glowW}
						opacity={LINE_RECIPE.glowOpacity}
						strokeLinejoin="round"
						strokeLinecap="round"
						filter={`url(#${glowId})`}
						style={{ stroke: "var(--sp-glow)" }}
					/>
					<path
						className="ut-sp-knock"
						d={series.d}
						fill="none"
						strokeWidth={LINE_RECIPE.knockW}
						opacity={LINE_RECIPE.knockOpacity}
						strokeLinejoin="round"
						strokeLinecap="round"
						style={{ stroke: "var(--dk-pane)" }}
					/>
					<path
						className="ut-sp-line"
						d={series.d}
						fill="none"
						strokeWidth={LINE_RECIPE.lineW}
						strokeLinejoin="round"
						strokeLinecap="round"
						style={{ stroke: "var(--sp-ink)" }}
					/>
				</>
			)}
			{drawn && brk !== null && (
				// From the break on the line is dashed: a pane-coloured copy hides the solid stroke between the dashes.
				<g clipPath={`url(#${breakId})`}>
					<path className="ut-sp-line ut-sp-gap" d={series.d} fill="none" />
					<path className="ut-sp-line ut-sp-dashed" d={series.d} fill="none" />
				</g>
			)}
			{slot(layers, "over", ctx)}
			{brk !== null && (
				<g className="ut-sp-break">
					<circle cx={brk.x} cy={brk.y} r={BREAK_R} />
					<text x={brk.x + 8} y={brk.y - 6}>
						chain breaks here
					</text>
				</g>
			)}
			{mark !== null && (
				<circle className="ut-sp-mark" cx={mark.x} cy={mark.y} r={MARK_R} fill="none" />
			)}
			{pin !== null && (
				<g className="ut-sp-pin">
					<line x1={pin.x} x2={pin.x} y1={0} y2={ctx.h} />
					<circle cx={pin.x} cy={pin.y} r={DOT_R} />
				</g>
			)}
			{live && drawn && (
				<circle
					className="ut-sp-live"
					cx={Math.min(series.last, ctx.w - 5)}
					cy={series.curve.at(series.last)}
					r={DOT_R}
					strokeWidth={1.5}
					style={{ fill: "var(--dk-gold)", stroke: "var(--dk-pane)" }}
				/>
			)}
		</svg>
	);
});
