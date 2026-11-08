// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend chart's static marks: grid, area, the three-stroke line, the pin and the live dot, with the three SVG
 * layer slots in between. No state and no effects, so a cursor move never redraws it. Colour is CSS (`--sp-ink`,
 * `--sp-glow`, `--dk-*`), so this file never branches on it.
 */

import { memo, useId } from "react";
import { formatUsdAxis } from "../../../shared/format.js";
import {
	AREA_STOPS,
	areaFadeTop,
	type DrawnSeries,
	type Geometry,
	LINE_RECIPE,
} from "../../../shared/spend-scale.js";
import type { ChartCtx, LayerZ, SpendLayer } from "./layers.js";

export interface ChartFrameProps {
	ctx: ChartCtx;
	geo: Geometry;
	series: DrawnSeries;
	ticks: Array<{ drawn: number; label: number }>;
	layers: readonly SpendLayer[];
	live: boolean;
	pin: { x: number; y: number } | null;
	idPrefix: string;
}

const DOT_R = 4.5;

function slot(layers: readonly SpendLayer[], z: LayerZ, ctx: ChartCtx): React.ReactNode {
	return layers.filter((l) => l.z === z).map((l) => <l.Layer key={l.id} ctx={ctx} />);
}

export const ChartFrame = memo(function ChartFrame(p: ChartFrameProps): React.JSX.Element {
	const { ctx, geo, series, ticks, layers, live, pin, idPrefix } = p;
	const uid = `${idPrefix}${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
	const gradId = `${uid}-area`;
	const glowId = `${uid}-glow`;
	const drawn = series.d !== "";
	const fadeTop = areaFadeTop(ctx.rate, ctx.y, ctx.baseY);
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
							stopOpacity={opacity}
							style={{ stopColor: "var(--sp-ink)" }}
						/>
					))}
				</linearGradient>
				<filter id={glowId} x="-5%" y="-50%" width="110%" height="200%">
					<feGaussianBlur stdDeviation={LINE_RECIPE.glowBlur} />
				</filter>
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
								{formatUsdAxis(t.label)}
							</text>
						</g>
					);
				})}
				<text className="ut-sp-unit" x={4} y={10} style={{ fill: "var(--dk-label)" }}>
					$/h
				</text>
			</g>
			{slot(layers, "under", ctx)}
			{drawn && (
				<path className="ut-sp-area" d={series.area} fill={`url(#${gradId})`} stroke="none" />
			)}
			{slot(layers, "mid", ctx)}
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
			{slot(layers, "over", ctx)}
			{pin !== null && (
				<circle
					className="ut-sp-pin"
					cx={pin.x}
					cy={pin.y}
					r={DOT_R}
					strokeWidth={1.5}
					style={{ fill: "var(--sp-ink)", stroke: "var(--dk-pane)" }}
				/>
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
