// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Window: the chrome every desk window shares. A labelled section with a title bar, a fill button and a body that
 * scrolls on its own. One path fills the desk or restores it (`useFill().toggle`): the button, a double-click on the
 * bar, Enter on the bar, and Esc and Back elsewhere all end there.
 *
 * A window is a slot (the grid item, always in the tree at its home cell) holding the section. Filling clips the
 * section from its home cell out to the whole desk, so nothing inside it reflows during the flight; the other windows
 * fade and turn inert but never leave the tree, so focus and state stay put.
 */

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	COMPACT_QUERY,
	homeInset,
	isDimmed,
	isFilled,
	nextPhase,
	type Phase,
	phaseDone,
	placeStyle,
	type WindowId,
} from "../../shared/desk-layout.js";
import { FILL_EASE, FILL_MS, motionStill } from "../../shared/motion.js";
import { useDeskData, useFill } from "./desk-state.js";
import { useMedia } from "./use-box-size.js";

export type { WindowId } from "../../shared/desk-layout.js";

interface WindowInfo {
	id: WindowId;
	filled: boolean;
	settling: boolean;
	/** Another window fills the desk: this one is inert and hidden, so it holds nothing open. */
	dimmed: boolean;
}

const WindowContext = createContext<WindowInfo | null>(null);

/** Which window this is, whether it fills the desk, whether it is in the flight to or from filling, and whether
 *  another window fills the desk. */
export function useWindow(): WindowInfo {
	const w = useContext(WindowContext);
	if (w === null) throw new Error("useWindow outside Window");
	return w;
}

/**
 * Whether another window fills the desk, so the window this is drawn in is inert and out of sight; false outside a
 * window. Something it holds open (an explainer) closes then: left open, it would take the next Esc from the desk.
 */
export function useWindowDimmed(): boolean {
	return useContext(WindowContext)?.dimmed ?? false;
}

/** The controls inside the title bar: a gesture that starts on one of them belongs to it, not to the bar. */
const CONTROLS = "button, a, input, select, [role=button]";

/**
 * Whether a key or double-click on the title bar should fill the desk: yes on the bar itself or its text, no when it
 * began on a control inside the bar (a range chip, the fill button).
 */
export function fillGesture(
	_kind: "enter" | "dblclick",
	target: { closest(sel: string): unknown } | null,
	bar: unknown,
): boolean {
	if (target === null) return false;
	const control = target.closest(CONTROLS);
	return control === null || control === undefined || control === bar;
}

/** The `Element` an event began on, or null for a target that is not one. */
function elementOf(target: EventTarget): Element | null {
	return typeof Element !== "undefined" && target instanceof Element ? target : null;
}

export function Window(props: {
	id: WindowId;
	title: string;
	subtitle?: React.ReactNode;
	/** Header controls (range chips). */
	actions?: React.ReactNode;
	/**
	 * One render-prop: whether this window fills the desk, and whether another one does. This one is then inert and
	 * hidden, so it must hold nothing modal.
	 */
	children: (filled: boolean, dimmed: boolean) => React.ReactNode;
}): React.JSX.Element {
	const { id, title, subtitle, actions, children } = props;
	const { held } = useDeskData();
	const { fill, toggle } = useFill();
	const compact = useMedia(COMPACT_QUERY, false);
	const target = isFilled(fill, id, compact);
	// A link with `fill=` opens already filled: no flight on the first paint.
	const [phase, setPhase] = useState<Phase>(target ? "filled" : "home");
	const slotRef = useRef<HTMLDivElement>(null);
	const sectionRef = useRef<HTMLElement>(null);
	const lastTarget = useRef(target);
	const lastCompact = useRef(compact);

	// A change of target starts the next phase. Crossing the compact width is never a flight: the desk is a different
	// shape on each side of it.
	useLayoutEffect(() => {
		const crossed = lastCompact.current !== compact;
		lastCompact.current = compact;
		if (lastTarget.current === target) return;
		lastTarget.current = target;
		setPhase((from) => nextPhase(from, target, crossed || motionStill()));
	}, [target, compact]);

	// The flight: once the section is laid out at its filled size (the phase set it so), clip it between its home cell
	// and the whole desk. Content stays at filled size throughout, and the clip is held until the phase ends.
	useLayoutEffect(() => {
		if (phase !== "grow" && phase !== "shrink") return;
		const section = sectionRef.current;
		const slot = slotRef.current;
		const desk = slot?.parentElement;
		if (
			section === null ||
			slot === null ||
			slot === undefined ||
			desk === null ||
			desk === undefined ||
			typeof section.animate !== "function"
		) {
			setPhase(phaseDone(phase));
			return;
		}
		const home = homeInset(slot.getBoundingClientRect(), desk.getBoundingClientRect());
		const full = "inset(0px)";
		const animation = section.animate(
			{ clipPath: phase === "grow" ? [home, full] : [full, home] },
			{ duration: FILL_MS, easing: FILL_EASE, fill: "forwards" },
		);
		animation.onfinish = () => setPhase(phaseDone(phase));
		return () => animation.cancel();
	}, [phase]);

	const renderFilled = phase !== "home";
	const settling = phase === "grow" || phase === "shrink";
	// Another window fills the desk: this one fades, is inert and hidden from assistive tech, but stays in the tree.
	const dimmed = isDimmed(fill, id, compact);
	const info = useMemo<WindowInfo>(
		() => ({ id, filled: renderFilled, settling, dimmed }),
		[id, renderFilled, settling, dimmed],
	);
	// Compact: fill is ignored, so a gesture does nothing (and writes no history entry).
	const fillIfAsked = (): void => {
		if (!compact) toggle(id);
	};
	// Now follows the header, not the deferred list the other windows draw.
	const lagging = id === "now" ? {} : { "data-held": held, "aria-busy": held };

	return (
		<div className="ut-win-slot" ref={slotRef} style={placeStyle(id)}>
			<section
				ref={sectionRef}
				className="ut-win"
				aria-label={title}
				data-win={id}
				data-filled={renderFilled}
				data-state={phase}
				{...(dimmed ? { inert: true, "aria-hidden": true, "data-dim": true } : {})}
			>
				{/* biome-ignore lint/a11y/useSemanticElements: a fieldset is a form control group; this is a title bar. */}
				<div
					className="ut-win-bar"
					role="group"
					aria-label={`${title} title bar`}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the bar is a keyboard stop: Enter on it fills the desk (the contract's title bar).
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key !== "Enter") return;
						if (!fillGesture("enter", elementOf(e.target), e.currentTarget)) return;
						e.preventDefault();
						fillIfAsked();
					}}
					onDoubleClick={(e) => {
						if (fillGesture("dblclick", elementOf(e.target), e.currentTarget)) fillIfAsked();
					}}
				>
					<h2 className="ut-win-title">{title}</h2>
					{subtitle !== undefined && <span className="ut-win-sub">{subtitle}</span>}
					<span className="ut-win-grow" />
					{actions}
					<button
						type="button"
						className="ut-win-fill"
						aria-label={target ? `Restore ${title}` : `Fill the desk with ${title}`}
						aria-pressed={target}
						onClick={fillIfAsked}
					>
						<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
							{target ? (
								<path d="M6 2v4H2M10 14v-4h4M14 6h-4V2M2 10h4v4" />
							) : (
								<path d="M2 6V2h4M14 10v4h-4M10 2h4v4M6 14H2v-4" />
							)}
						</svg>
					</button>
				</div>
				<div className="ut-win-body" {...lagging}>
					<WindowContext.Provider value={info}>
						{children(renderFilled, dimmed)}
					</WindowContext.Provider>
				</div>
			</section>
		</div>
	);
}
