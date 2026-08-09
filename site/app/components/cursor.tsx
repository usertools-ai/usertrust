"use client";

import { motion, useMotionValue, useSpring } from "motion/react";
import { useEffect, useState } from "react";

/*
 * THE CUSTOM CURSOR (Addendum M1, REVISED — Cam overrule) — the bullseye IS
 * the cursor. While this island is mounted it REPLACES the native pointer
 * (`html.cursor-active, html.cursor-active * { cursor: none !important; }`
 * in globals.css, scoped to the class this component alone applies) rather
 * than drawing a decorative layer on top of it.
 *
 * A small dot tracks the raw pointer position 1:1 — unsprung, batched to a
 * single requestAnimationFrame write per burst of pointermove events so the
 * transform lands at rAF resolution without spamming a motion-value commit
 * per event. A trailing ring lags behind it on a spring. Over any
 * [data-cursor-hover] target the ring scales up and switches to
 * mix-blend-mode: difference, inverting whatever ground it crosses.
 *
 * useSpring (motion/react — already a page dependency, so this is zero new
 * packages) drives the trail rather than a hand-rolled rAF lerp: both run on
 * the same requestAnimationFrame loop, but the spring settles to a full stop
 * on its own once the pointer is still, where a manual lerp needs its own
 * epsilon-and-cancel bookkeeping to do the same — one fewer thing to get
 * wrong at 120Hz for the same feel.
 *
 * Mounts ONLY when `(pointer: fine)` matches AND reduced motion is NOT
 * requested at mount — touch/coarse pointers and reduced-motion users never
 * get the class, so they keep the native cursor everywhere (there is no
 * script that could ever fire `cursor: none` for them, not just a CSS
 * override sitting on top of it). That combined gate is also why nothing
 * can render at a stale position after a tap or get "stuck" showing on a
 * touchscreen. `cursor-active` comes off again on unmount and on window
 * blur (alt-tab, devtools stealing focus) — re-applied on focus — so a user
 * who leaves the tab is never stranded without any visible cursor at all.
 */

// Trailing-ring spring — tuned for a short, controlled lag behind the dot
// rather than a loose, springy overshoot (this tracks a pointer, not a card).
const RING_SPRING = { stiffness: 320, damping: 28, mass: 0.6 };
// Scale transition for the hover-target ring bloom — a quick settle, no bounce.
const SCALE_TRANSITION = { type: "spring", stiffness: 300, damping: 24 } as const;

export default function Cursor() {
	const [enabled, setEnabled] = useState(false);
	const [hovering, setHovering] = useState(false);
	const mouseX = useMotionValue(-100);
	const mouseY = useMotionValue(-100);
	const ringX = useSpring(mouseX, RING_SPRING);
	const ringY = useSpring(mouseY, RING_SPRING);

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

		// The dot's transform is written at most once per animation frame —
		// pointermove can fire far faster than the display refreshes, so this
		// coalesces a burst of events into a single commit per frame, landing
		// the dot 1:1 on the pointer at rAF resolution with no spring/lerp.
		let rafId = 0;
		let pendingX = -100;
		let pendingY = -100;
		function onMove(e: PointerEvent) {
			pendingX = e.clientX;
			pendingY = e.clientY;
			if (rafId) return;
			rafId = requestAnimationFrame(() => {
				mouseX.set(pendingX);
				mouseY.set(pendingY);
				rafId = 0;
			});
		}
		// pointerover (not pointermove) for hover detection — it only fires when
		// the element under the pointer actually changes, so this is a handful
		// of events per interaction rather than one per animation frame.
		function onOver(e: PointerEvent) {
			const target = e.target as Element | null;
			setHovering(Boolean(target?.closest?.("[data-cursor-hover]")));
		}
		// Pointer left the whole document (relatedTarget null) — clear the
		// hover bloom and park the overlay off-screen so it can't linger
		// mid-scene. This guard is unchanged by the M1 revision: it only ever
		// moved the decorative dot/ring, never the cursor-active class.
		function onLeave() {
			setHovering(false);
			mouseX.set(-100);
			mouseY.set(-100);
		}
		function onPointerOut(e: PointerEvent) {
			if (e.relatedTarget === null) onLeave();
		}
		// Window itself lost focus (alt-tab, devtools) — restore the native
		// pointer along with parking the overlay, so a user who tabs away is
		// never left with neither cursor visible; re-suppress on refocus.
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
	}, [mouseX, mouseY]);

	if (!enabled) return null;

	return (
		<div aria-hidden="true" className="cursor-layer">
			<motion.div className="cursor-dot" style={{ x: mouseX, y: mouseY }} />
			<motion.div
				className={`cursor-ring${hovering ? " cursor-ring--hover" : ""}`}
				style={{ x: ringX, y: ringY }}
				animate={{ scale: hovering ? 2.2 : 1 }}
				transition={SCALE_TRANSITION}
			/>
		</div>
	);
}
