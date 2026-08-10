"use client";

import { useEffect, useRef, useState } from "react";

/*
 * THE CUSTOM CURSOR (Addendum M1, REVISION 2 — Cam-decided) — THE
 * REGISTRATION MARK. While this island is mounted it REPLACES the native
 * pointer (`html.cursor-active, html.cursor-active * { cursor: none
 * !important; }` in globals.css, scoped to the class this component alone
 * applies) rather than drawing a decorative layer on top of it.
 *
 * WHAT IT DRAWS. At rest: a printer's registration mark — a ~14px hairline
 * crosshair (two 1px strokes) with a 2px dot at the crossing. Over any
 * [data-cursor-hover] target: four L-shaped 1px corner ticks snap outward
 * ~10px and hold, framing the target the way crop marks frame a plate. The
 * ticks carry the CURRENT SECTION's accent, read off the nearest
 * [data-theme] ancestor at hoverstart, so the mark speaks the colour of
 * whatever it is standing on.
 *
 * WHAT IT NO LONGER DRAWS. The bullseye's trailing ring is gone, and with it
 * the spring that lagged it and the scale bloom it grew on hover. Nothing
 * here is filled and nothing is larger than 14px across, so the cursor
 * cannot occlude the text under it — the skip link reads through the mark by
 * construction, not by tuning. That also retires this file's motion/react
 * import: the mark tracks 1:1, so there is nothing left to spring.
 *
 * BLEND AND STACKING (the 19I finding, preserved verbatim). The three
 * hairline parts — h-stroke, v-stroke, dot — each carry
 * `mix-blend-mode: difference` so the mark inverts against whatever it
 * crosses, dark ground or the one paper surface on the page. That only works
 * if each blending element sits ONE stacking context away from the page:
 * nesting them inside a positioned wrapper made their blend backdrop come
 * back fully transparent and the difference math never ran (measured live in
 * 19I by resampling the same pixel). So they are direct children of the
 * unpositioned `.cursor-layer`, each `position: fixed` with its own z-index,
 * and each takes its own transform write. The corner ticks do NOT blend —
 * they are accent-coloured on purpose — so they may share one positioned
 * wrapper.
 *
 * Every position write is batched into a single requestAnimationFrame per
 * burst of pointermove events: pointermove can fire faster than the display
 * refreshes, so this lands the mark 1:1 on the pointer at rAF resolution
 * without a commit per event.
 *
 * Mounts ONLY when `(pointer: fine)` matches AND reduced motion is NOT
 * requested at mount — touch/coarse pointers and reduced-motion users never
 * get the class, so they keep the native cursor everywhere (there is no
 * script that could ever fire `cursor: none` for them, not just a CSS
 * override sitting on top of it). That combined gate is also why nothing can
 * render at a stale position after a tap or get "stuck" showing on a
 * touchscreen. `cursor-active` comes off again on unmount and on window blur
 * (alt-tab, devtools stealing focus) — re-applied on focus — so a user who
 * leaves the tab is never stranded without any visible cursor at all.
 */

/** Section accent to fall back to when the pointer is over no themed section. */
const ACCENT_FALLBACK = "var(--color-ut)";

/**
 * Where the mark sits when it has nowhere to be: off the top-left corner, far
 * enough that no part of a 14px crosshair can reach the viewport.
 *
 * THIS IS ALSO THE INITIAL RENDER. Every part below ships parked in its own
 * inline style, because the imperative `place()` cannot run before the first
 * pointermove: the mount effect returns while `enabled` is still false, so the
 * refs it would write through are null, and the elements only exist on the
 * render AFTER it. Without the inline transform they render at transform:none
 * — the crosshair painted over the very top-left corner of the page on every
 * fresh load until the pointer moved. (The bullseye this replaced never showed
 * it because it was positioned from a spring whose resting value was already
 * this constant.)
 *
 * React keeps the imperative writes: the style prop's `transform` value is
 * identical on every render, so the reconciler never re-applies it and never
 * clobbers the value `place()` has written since.
 */
const PARK_PX = -100;
const PARKED: React.CSSProperties = {
	transform: `translate3d(${PARK_PX}px, ${PARK_PX}px, 0)`,
};

export default function Cursor() {
	const [enabled, setEnabled] = useState(false);
	const [framing, setFraming] = useState(false);
	const [accent, setAccent] = useState<string>(ACCENT_FALLBACK);
	// One ref per independently-positioned part. The three blend parts cannot
	// share a wrapper (see the stacking note above); the ticks can.
	const hRef = useRef<HTMLSpanElement>(null);
	const vRef = useRef<HTMLSpanElement>(null);
	const dotRef = useRef<HTMLSpanElement>(null);
	const frameRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (
			!window.matchMedia("(pointer: fine)").matches ||
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			return;
		}
		setEnabled(true);

		const root = document.documentElement;
		root.classList.add("cursor-active");

		let rafId = 0;
		let pendingX = PARK_PX;
		let pendingY = PARK_PX;
		const parts = [hRef, vRef, dotRef, frameRef];
		function place() {
			const t = `translate3d(${pendingX}px, ${pendingY}px, 0)`;
			for (const p of parts) {
				if (p.current) p.current.style.transform = t;
			}
		}
		function onMove(e: PointerEvent) {
			pendingX = e.clientX;
			pendingY = e.clientY;
			if (rafId) return;
			rafId = requestAnimationFrame(() => {
				place();
				rafId = 0;
			});
		}
		// pointerover (not pointermove) for hover detection — it only fires when
		// the element under the pointer actually changes, so this is a handful of
		// events per interaction rather than one per animation frame. The accent
		// is read HERE, once per hoverstart, never per frame.
		function onOver(e: PointerEvent) {
			const target = e.target as Element | null;
			const hit = target?.closest?.("[data-cursor-hover]") ?? null;
			setFraming(Boolean(hit));
			if (!hit) return;
			const themed = hit.closest("[data-theme]");
			const value = themed
				? getComputedStyle(themed).getPropertyValue("--section-accent").trim()
				: "";
			setAccent(value || ACCENT_FALLBACK);
		}
		// Pointer left the whole document (relatedTarget null) — drop the framing
		// and park the mark off-screen so it can't linger mid-scene. This guard is
		// unchanged by the reskin: it only ever moved the decorative parts, never
		// the cursor-active class.
		function onLeave() {
			setFraming(false);
			pendingX = PARK_PX;
			pendingY = PARK_PX;
			place();
		}
		function onPointerOut(e: PointerEvent) {
			if (e.relatedTarget === null) onLeave();
		}
		// Window itself lost focus (alt-tab, devtools) — restore the native
		// pointer along with parking the mark, so a user who tabs away is never
		// left with neither cursor visible; re-suppress on refocus.
		function onBlur() {
			onLeave();
			root.classList.remove("cursor-active");
		}
		function onFocus() {
			root.classList.add("cursor-active");
		}
		window.addEventListener("pointermove", onMove, { passive: true });
		window.addEventListener("pointerover", onOver, { passive: true });
		window.addEventListener("pointerout", onPointerOut, { passive: true });
		window.addEventListener("blur", onBlur);
		window.addEventListener("focus", onFocus);
		return () => {
			if (rafId) cancelAnimationFrame(rafId);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerover", onOver);
			window.removeEventListener("pointerout", onPointerOut);
			window.removeEventListener("blur", onBlur);
			window.removeEventListener("focus", onFocus);
			root.classList.remove("cursor-active");
		};
	}, []);

	if (!enabled) return null;

	const frameClass = `cursor-frame${framing ? " cursor-frame--on" : ""}`;
	return (
		<div aria-hidden="true" className="cursor-layer">
			{/* The three blending parts: each its own fixed, top-level layer. */}
			<span ref={hRef} style={PARKED} className="cursor-rule cursor-rule--h" />
			<span ref={vRef} style={PARKED} className="cursor-rule cursor-rule--v" />
			<span ref={dotRef} style={PARKED} className="cursor-dot" />
			{/* The crop marks. One wrapper, four L-shaped ticks, accent-tinted from
			    the section under the pointer. */}
			<span
				ref={frameRef}
				className={frameClass}
				style={{ ...PARKED, "--cursor-accent": accent } as React.CSSProperties}
			>
				<i className="cursor-tick cursor-tick--tl" />
				<i className="cursor-tick cursor-tick--tr" />
				<i className="cursor-tick cursor-tick--bl" />
				<i className="cursor-tick cursor-tick--br" />
			</span>
		</div>
	);
}
