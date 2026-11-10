// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Share window's ring. It is drawn once in a fixed 300 x 300 box and sized by CSS, so a resize or a fill never
 * rebuilds it. Each slice is a body shaded from its outer edge inward, outlined in its own colour, with a rim along
 * the outer edge; the gaps between slices are equal and parallel. A slice in focus (selected, or under the pointer)
 * grows outward and never moves. The legend's buttons are the keyboard route to the same filter a slice's click sets.
 */

import { useEffect, useId, useMemo, useRef } from "react";
import type { Dimension } from "../../../shared/breakdown.js";
import { toggleCategory } from "../../../shared/desk-filters.js";
import {
	FADE,
	FADE_HOT,
	GROW,
	HALF_GAP,
	INNER,
	OUTLINE_INSET,
	RIM_W,
	RIM_W_HOT,
	rimPath,
	ringPath,
	ringShape,
	VB,
} from "../../../shared/donut.js";
import { middleTruncate } from "../../../shared/format.js";
import type { Lit } from "../../../shared/selection.js";
import {
	setHoverCategory,
	useDeskData,
	useFilters,
	useHoverCategory,
} from "../../desk/desk-state.js";
import { useArcTween } from "./use-arc-tween.js";
import { useLitOf } from "./use-lit-at.js";

const C = VB / 2;
/** The outer radius at rest: the box, less the room a grown slice and its rim take. */
const RO = C - GROW - RIM_W_HOT;
const RI = RO * INNER;
/** The centre's first line holds this many characters; a longer name is cut in the middle, whole in its title. */
const NAME_MAX = 24;

const inFocus = (lit: Lit): boolean => lit === "selected" || lit === "hover";

export interface ShareCentre {
	name: string;
	amount: string;
	sub: string;
	/** The lit category the amount is for, or null when it is the total. */
	key: string | null;
}

function Slice(props: {
	name: string;
	level: Dimension;
	color: string;
	lit: Lit;
	a0: number;
	a1: number;
	grow: number;
	gradient: string;
}): React.JSX.Element {
	const { name, level, color, lit, a0, a1, grow, gradient } = props;
	const { filters, setFilters } = useFilters();
	const hot = inFocus(lit);
	// A slice that goes away while the pointer is on it never sees the pointer leave: it takes its hover with it.
	const hovering = useRef(false);
	useEffect(
		() => () => {
			if (hovering.current) setHoverCategory(null);
		},
		[],
	);
	const body = ringPath(
		C,
		C,
		RO + grow - OUTLINE_INSET,
		RI + OUTLINE_INSET,
		a0,
		a1,
		HALF_GAP + OUTLINE_INSET,
	);
	const rim = rimPath(C, C, RO + grow - 1, a0, a1, HALF_GAP);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the legend's buttons are the keyboard route to the same filter
		<g
			className="ut-sh-slice"
			data-key={name}
			data-lit={lit}
			onPointerEnter={() => {
				hovering.current = true;
				setHoverCategory({ dim: level, key: name, from: "share" });
			}}
			onPointerLeave={() => {
				hovering.current = false;
				setHoverCategory(null);
			}}
			onClick={() => setFilters(toggleCategory(filters, level, name, false))}
		>
			<radialGradient id={gradient} gradientUnits="userSpaceOnUse" cx={C} cy={C} r={RO}>
				{[...(hot ? FADE_HOT : FADE)].reverse().map(([band, opacity]) => (
					<stop
						key={band}
						offset={1 - band * (1 - INNER)}
						stopColor={color}
						stopOpacity={opacity}
					/>
				))}
			</radialGradient>
			{body !== "" && (
				<path
					className="body"
					d={body}
					fill={`url(#${gradient})`}
					fillRule="evenodd"
					stroke={color}
					style={{ strokeOpacity: hot ? 0.9 : 0.6 }}
				/>
			)}
			{rim !== "" && (
				<path
					className="rim"
					d={rim}
					stroke={color}
					style={{ strokeWidth: hot ? RIM_W_HOT : RIM_W }}
				/>
			)}
		</g>
	);
}

export function ShareDonut(props: {
	/** The categories, in the order the range fixed; one slice each. */
	keys: readonly string[];
	/** Each key's spend in what is shown (the range, or one bucket). */
	values: readonly number[];
	level: Dimension;
	centre: ShareCentre;
	/** The moment shown: a change of it is drawn at once, any other change eases. */
	snapKey: string;
	ariaLabel: string;
}): React.JSX.Element {
	const { keys, values, level, centre, snapKey, ariaLabel } = props;
	const colors = useDeskData().colorsFor(level);
	const litOf = useLitOf(level);
	const hover = useHoverCategory();
	const uid = useId();
	const target = useMemo(
		() => ringShape(keys, values, (key) => inFocus(litOf(key))),
		[keys, values, litOf],
	);
	const shown = useArcTween(target, snapKey);
	const hot = hover !== null && hover.dim === level && keys.includes(hover.key);
	const name = middleTruncate(centre.name, NAME_MAX);
	return (
		<svg className="ut-sh-ring" viewBox={`0 0 ${VB} ${VB}`} role="img" aria-label={ariaLabel}>
			<circle className="ut-sh-hair" cx={C} cy={C} r={RI} />
			<g className="ut-sh-slices" data-hot={hot}>
				{keys.map((key, i) => {
					const arc = shown.arcs.get(key) ?? target.arcs.get(key);
					return (
						<Slice
							key={key}
							name={key}
							level={level}
							color={colors.of(key)}
							lit={litOf(key)}
							a0={arc?.a0 ?? 0}
							a1={arc?.a1 ?? 0}
							grow={shown.grow.get(key) ?? target.grow.get(key) ?? 0}
							gradient={`${uid}g${i}`}
						/>
					);
				})}
			</g>
			<text className="c1" x={C} y={C - RI * 0.3} textAnchor="middle">
				{name !== centre.name && <title>{centre.name}</title>}
				{name}
			</text>
			<text
				className="c2"
				x={C}
				y={C + RI * 0.12}
				textAnchor="middle"
				data-fig="share.centre"
				{...(centre.key === null ? {} : { "data-key": centre.key })}
			>
				{centre.amount}
			</text>
			<text className="c3" x={C} y={C + RI * 0.4} textAnchor="middle">
				{centre.sub}
			</text>
		</svg>
	);
}
