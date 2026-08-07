"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

const BASE =
	"inline-block select-none border-[3px] border-current px-3 py-1 font-display text-2xl font-bold uppercase tracking-[0.18em]";

/**
 * Rubber-stamp set-piece (BLOCKED / VOID). SSR and no-JS render the FINISHED
 * stamp (island contract: server-rendered finished state); after hydration it
 * swaps to a motion spring that fires ONCE when scrolled into view
 * (whileInView + viewport.once = IntersectionObserver, disconnected after the
 * first hit). Reduced motion: static finished state, no spring.
 * Color comes from the caller: default text-danger for dark ground; pass
 * className="text-paper-red" on paper — the stamp is a >=3:1 graphic, its
 * caption stays ink.
 */
export default function Stamp({
	word,
	className,
}: {
	word: "BLOCKED" | "VOID";
	className?: string;
}) {
	const reduce = useReducedMotion();
	const [hydrated, setHydrated] = useState(false);

	useEffect(() => {
		setHydrated(true);
	}, []);

	if (!hydrated || reduce) {
		return (
			<span
				className={`${BASE} ${className ?? "text-danger"}`}
				style={{ transform: "rotate(-8deg)" }}
			>
				{word}
			</span>
		);
	}

	return (
		<motion.span
			className={`${BASE} ${className ?? "text-danger"}`}
			initial={{ opacity: 0, scale: 1.6, rotate: -14 }}
			whileInView={{ opacity: 1, scale: 1, rotate: -8 }}
			viewport={{ once: true, amount: 0.6 }}
			transition={{ type: "spring", stiffness: 380, damping: 16, mass: 0.9 }}
		>
			{word}
		</motion.span>
	);
}
