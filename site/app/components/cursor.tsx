"use client";

import { motion, useMotionValue, useSpring } from "motion/react";
import { useEffect, useState } from "react";

/*
 * THE CUSTOM CURSOR (Addendum M1) — a decorative overlay, never a system-cursor
 * replacement. `cursor: none` never appears anywhere on this page, so the
 * native pointer stays visible underneath the whole time; this is a second,
 * purely additive layer above it.
 *
 * A small dot tracks the raw pointer position every frame; a trailing ring
 * lags behind it on a spring. Over any [data-cursor-hover] target the ring
 * scales up and switches to mix-blend-mode: difference, inverting whatever
 * ground it crosses.
 *
 * useSpring (motion/react — already a page dependency, so this is zero new
 * packages) drives the trail rather than a hand-rolled rAF lerp: both run on
 * the same requestAnimationFrame loop, but the spring settles to a full stop
 * on its own once the pointer is still, where a manual lerp needs its own
 * epsilon-and-cancel bookkeeping to do the same — one fewer thing to get
 * wrong at 120Hz for the same feel.
 *
 * Mounts ONLY when `(pointer: fine)` matches at mount — touch and coarse
 * pointers never see the overlay, so there is nothing that can render at a
 * stale position after a tap or get "stuck" showing on a touchscreen. Reduced
 * motion is a pure CSS `display: none` on `.cursor-layer` (globals.css):
 * nothing here loops or fires once per pageview, so there is no motion
 * contract to satisfy beyond simply not drawing it.
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
		if (!window.matchMedia("(pointer: fine)").matches) return;
		setEnabled(true);

		function onMove(e: PointerEvent) {
			mouseX.set(e.clientX);
			mouseY.set(e.clientY);
		}
		// pointerover (not pointermove) for hover detection — it only fires when
		// the element under the pointer actually changes, so this is a handful
		// of events per interaction rather than one per animation frame.
		function onOver(e: PointerEvent) {
			const target = e.target as Element | null;
			setHovering(Boolean(target?.closest?.("[data-cursor-hover]")));
		}
		// Pointer left the whole document (relatedTarget null) or the window
		// itself lost focus (alt-tab, devtools) — clear the hover bloom and
		// park the overlay off-screen so it can't linger mid-scene.
		function onLeave() {
			setHovering(false);
			mouseX.set(-100);
			mouseY.set(-100);
		}
		function onPointerOut(e: PointerEvent) {
			if (e.relatedTarget === null) onLeave();
		}
		window.addEventListener("pointermove", onMove, { passive: true });
		window.addEventListener("pointerover", onOver, { passive: true });
		window.addEventListener("pointerout", onPointerOut, { passive: true });
		window.addEventListener("blur", onLeave);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerover", onOver);
			window.removeEventListener("pointerout", onPointerOut);
			window.removeEventListener("blur", onLeave);
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
