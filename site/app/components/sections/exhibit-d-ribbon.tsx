"use client";

import { useEffect, useRef } from "react";
import type { ChainSlice } from "@/evidence/types";
import { createRibbonRenderer, RIBBON_HEIGHT, RIBBON_IO_THRESHOLD } from "@/lib/exhibit-d";

/**
 * Decorative canvas ribbon of the same captured entries the DOM demo shows.
 * The wrapper in exhibit-d.tsx is display:none under prefers-reduced-motion
 * and below the mobile breakpoint (IntersectionObserver never fires for
 * display:none), and this component ALSO bails on the same media queries —
 * belt and braces. All canvas work starts on the first IO intersection,
 * never on mount. The drawing math itself lives in app/lib/exhibit-d.ts —
 * see that file's header for why.
 */
export default function ExhibitDRibbon({ entries }: { entries: ChainSlice["entries"] }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		if (
			window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
			window.matchMedia("(max-width: 767px)").matches
		) {
			return;
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const mono =
			getComputedStyle(document.documentElement).getPropertyValue("--font-jetbrains").trim() ||
			"monospace";

		const renderer = createRibbonRenderer(canvas, ctx, entries, mono);
		let raf = 0;
		let initialized = false;

		function tick(t: number) {
			const stillAnimating = renderer.advance(t);
			raf = stillAnimating ? requestAnimationFrame(tick) : 0;
		}

		const io = new IntersectionObserver(
			(records) => {
				const visible = records.some((r) => r.isIntersecting);
				if (visible) {
					if (!initialized) {
						initialized = true;
						renderer.setSize();
					}
					if (raf === 0 && !renderer.isComplete()) {
						renderer.resetClock();
						raf = requestAnimationFrame(tick);
					}
				} else if (raf !== 0) {
					cancelAnimationFrame(raf);
					raf = 0;
					renderer.resetClock();
				}
			},
			{ threshold: RIBBON_IO_THRESHOLD },
		);
		io.observe(canvas);

		const onResize = () => {
			if (initialized) renderer.setSize();
		};
		window.addEventListener("resize", onResize);

		return () => {
			io.disconnect();
			window.removeEventListener("resize", onResize);
			if (raf !== 0) cancelAnimationFrame(raf);
		};
	}, [entries]);

	return (
		// biome-ignore lint: the accessibility rule against aria-hidden on focusable elements does not apply — this decorative canvas is never given a tabindex and receives no interaction; aria-hidden keeps it out of the accessibility tree while the DOM demo above stays the real, always-present interactive path
		<canvas
			ref={canvasRef}
			height={RIBBON_HEIGHT}
			aria-hidden="true"
			className="block h-[120px] w-full"
		/>
	);
}
