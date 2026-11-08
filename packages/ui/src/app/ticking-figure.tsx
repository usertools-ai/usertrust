// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useRef, useState } from "react";
import { formatUsdTotal } from "../shared/format.js";
import { frameAt, TICK_FRAME_MS, tickFrames } from "../shared/tick.js";

/** Whether the reader asked for reduced motion. Outside a browser (server rendering, tests) there is no motion. */
function reducedMotion(): boolean {
	return (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function" ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/**
 * A dollar total that counts to its new value when it changes, like a precision counter: whole usertokens a frame,
 * eased out, landing exactly on the value. The digits are tabular and the span holds the widest string of the count
 * (the final value's width at rest), so nothing beside it moves. The counting span is hidden from assistive tech; a
 * visually hidden span beside it holds the final value, so a screen reader reads that and never the count. With reduced motion asked for, the final
 * value shows at once. The first render shows the value as it is: only a change counts.
 *
 * `jump`: show every change at once, never counting. A figure at a past position takes it: moving between positions is a
 * jump from one recorded value to another, not money arriving, and a count would still be running frames behind the
 * position.
 */
export function TickingFigure(props: { ut: number; jump?: boolean }): React.JSX.Element {
	const { ut } = props;
	const jump = props.jump === true;
	const [shown, setShown] = useState(ut);
	const [width, setWidth] = useState(() => formatUsdTotal(ut).length);
	const [ticking, setTicking] = useState(false);
	// The value on screen now: a change mid-count starts from it, so the count never jumps back.
	const shownRef = useRef(ut);

	useEffect(() => {
		const from = shownRef.current;
		const frames = tickFrames(from, ut);
		const land = (): void => {
			shownRef.current = ut;
			setShown(ut);
			setWidth(formatUsdTotal(ut).length);
			setTicking(false);
		};
		if (frames.length === 1 || jump || reducedMotion()) {
			land();
			return;
		}
		setWidth(Math.max(...[from, ...frames].map((f) => formatUsdTotal(f).length)));
		setTicking(true);
		const start = performance.now();
		const end = (frames.length - 1) * TICK_FRAME_MS;
		let raf = requestAnimationFrame(function step(now: number): void {
			const elapsed = now - start;
			if (elapsed >= end) {
				land();
				return;
			}
			const v = frameAt(frames, elapsed);
			shownRef.current = v;
			setShown(v);
			raf = requestAnimationFrame(step);
		});
		return () => cancelAnimationFrame(raf);
	}, [ut, jump]);

	const final = formatUsdTotal(ut);
	return (
		<>
			<span
				className="ut-tick"
				aria-hidden="true"
				data-ticking={ticking ? "true" : undefined}
				// Held only where it fits: in a column narrower than the figure it wraps, as the fact's text always has.
				style={{ minWidth: `min(${width}ch, 100%)` }}
			>
				{formatUsdTotal(shown)}
			</span>
			<span className="sr-only">{final}</span>
		</>
	);
}
