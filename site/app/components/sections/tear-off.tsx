"use client";

import { motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { TEAR_LATCH_MS, TEAR_SPRING } from "./lib/tear-off-motion";

/*
 * THE TEAR-OFF. Rendered as a real <a href="/docs/quickstart"> so no-JS and
 * middle-click/cmd-click work unmodified. With JS and motion allowed we
 * intercept the plain left-click, play the 300ms tear (y-offset + slight
 * rotate + fade — a physical object, so a spring), then router.push. Under
 * prefers-reduced-motion the handler returns without preventDefault: instant
 * native navigation, feature intact. Set-piece fires once (tearing latches).
 */
export default function TearOff() {
	const router = useRouter();
	const reduceMotion = useReducedMotion();
	const [tearing, setTearing] = useState(false);

	function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
		if (reduceMotion) return; // plain <a> navigation
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new-tab intents stay native
		e.preventDefault();
		if (tearing) return;
		setTearing(true);
		window.setTimeout(() => router.push("/docs/quickstart"), TEAR_LATCH_MS);
	}

	return (
		<div className="mt-6">
			{/* perforation line the stub tears along */}
			<div aria-hidden="true" className="border-t-2 border-dashed border-ink/30" />
			<motion.a
				href="/docs/quickstart"
				onClick={onClick}
				animate={tearing ? { y: 2, rotate: -1.2, opacity: 0.35 } : { y: 0, rotate: 0, opacity: 1 }}
				transition={TEAR_SPRING}
				className="lift-2 focus-ring mt-px flex min-h-[56px] w-full items-center justify-center bg-paper font-mono text-base font-bold uppercase tracking-widest text-ink hover:bg-paper/90"
			>
				open your ledger →
			</motion.a>
		</div>
	);
}
