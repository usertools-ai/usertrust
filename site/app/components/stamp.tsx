"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

const BASE =
	"lift-2 inline-block select-none border-[3px] border-current px-3 py-1 font-display text-2xl font-bold uppercase tracking-[0.18em]";

/**
 * Rubber-stamp set-piece (BLOCKED / VOID). SSR and no-JS render the FINISHED
 * stamp (island contract: server-rendered finished state); after hydration it
 * swaps to a motion spring that fires ONCE when scrolled into view
 * (whileInView + viewport.once = IntersectionObserver, disconnected after the
 * first hit). Reduced motion: static finished state, no spring.
 * COLOR IS ITS OWN PROP, and that is a bug fix, not a preference. It used to
 * ride `className ?? "text-danger"`, so the default applied only when the
 * caller passed NO className at all — and every caller passes one, because a
 * stamp is positioned by its host (`absolute -right-2 -top-3`). The fallback
 * was therefore dead in practice and the stamp inherited body white: exhibit
 * F's BLOCKED sampled 1299 near-white pixels against a danger-red border,
 * breaking the danger-ink language on the one element that most depends on
 * it. Positioning and color cannot share one slot. `colorClassName` defaults
 * to text-danger for dark ground; pass "text-paper-red" on paper — the stamp
 * is a >=3:1 graphic at 24px, so full danger is correct here (the <16px
 * danger-ink rule does not reach it).
 *
 * `UNPROVEN` (verify-page spec §6.2) extends the word union for the 410
 * `billedUnfinalized` state: work was billed but the artifact association
 * was never proven. It is a component-level extension, not a new component
 * — §6.2 asks for exactly this ("`Stamp`, extended beyond `BLOCKED | VOID`
 * as needed").
 */
export default function Stamp({
	word,
	className,
	colorClassName = "text-danger",
}: {
	word: "BLOCKED" | "VOID" | "UNPROVEN";
	className?: string;
	colorClassName?: string;
}) {
	const reduce = useReducedMotion();
	const [hydrated, setHydrated] = useState(false);

	useEffect(() => {
		setHydrated(true);
	}, []);

	if (!hydrated || reduce) {
		return (
			<span
				className={`${BASE} ${colorClassName} ${className ?? ""}`}
				style={{ transform: "rotate(-8deg)" }}
			>
				{word}
			</span>
		);
	}

	return (
		<motion.span
			className={`${BASE} ${colorClassName} ${className ?? ""}`}
			initial={{ opacity: 0, scale: 1.6, rotate: -14 }}
			whileInView={{ opacity: 1, scale: 1, rotate: -8 }}
			viewport={{ once: true, amount: 0.6 }}
			transition={{ type: "spring", stiffness: 380, damping: 16, mass: 0.9 }}
		>
			{word}
		</motion.span>
	);
}
