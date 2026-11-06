// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useRef, useState } from "react";
import { formatUsdTotal } from "../shared/format.js";
import { TICK_FRAME_MS, tickFrames } from "../shared/tick.js";

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
 * (the final value's width at rest), so nothing beside it moves. The counting span is hidden from assistive tech and
 * never announced; a visually hidden span beside it holds the final value. With reduced motion asked for, the final
 * value shows at once. The first render shows the value as it is: only a change counts.
 */
export function TickingFigure(props: { ut: number }): React.JSX.Element {
	const { ut } = props;
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
		if (frames.length === 1 || reducedMotion()) {
			land();
			return;
		}
		setWidth(Math.max(...[from, ...frames].map((f) => formatUsdTotal(f).length)));
		setTicking(true);
		const start = performance.now();
		let raf = requestAnimationFrame(function step(now: number): void {
			const i = Math.min(frames.length - 1, Math.floor((now - start) / TICK_FRAME_MS));
			if (i === frames.length - 1) {
				land();
				return;
			}
			const v = frames[i] ?? ut;
			shownRef.current = v;
			setShown(v);
			raf = requestAnimationFrame(step);
		});
		return () => cancelAnimationFrame(raf);
	}, [ut]);

	const final = formatUsdTotal(ut);
	return (
		<>
			<span
				className="ut-tick"
				aria-hidden="true"
				aria-live="off"
				data-ticking={ticking ? "true" : undefined}
				style={{ minWidth: `${width}ch` }}
			>
				{formatUsdTotal(shown)}
			</span>
			<span className="sr-only">{final}</span>
		</>
	);
}
