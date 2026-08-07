import type { ReactNode } from "react";

/**
 * Thermal-paper receipt shell. SERVER component — pure markup.
 * Visual treatment comes from Task 1's globals.css utilities: `.paper-surface`
 * (paper texture + warm dimming + drop shadow) for the card itself, and
 * `.perforation` — a repeating punched-hole strip — rendered as its own edge
 * element (there is no `.perforation-top`/`.perforation-bottom` modifier;
 * Task 1 shipped a single `.perforation` strip meant to be placed at whichever
 * edge is wanted). `provenance` renders as the mandatory mono stub at the
 * bottom of every rendered artifact ("captured v3.1.0 · TigerBeetle x.y ·
 * 2026-08-07").
 */
export default function ReceiptPaper({
	children,
	provenance,
	perforated = "both",
	className,
}: {
	children: ReactNode;
	provenance?: string;
	perforated?: "both" | "top" | "bottom";
	className?: string;
}) {
	const perfTop = perforated === "both" || perforated === "top";
	const perfBottom = perforated === "both" || perforated === "bottom";
	const classes = ["paper-surface relative text-ink", className ?? ""].filter(Boolean).join(" ");
	return (
		<div className={classes}>
			{perfTop ? <div aria-hidden="true" className="perforation" /> : null}
			<div className="px-5 py-6 sm:px-6">{children}</div>
			{provenance ? (
				<div className="mx-5 border-t border-dashed border-ink/20 py-2 font-mono text-[10px] leading-tight text-ink/60">
					{provenance}
				</div>
			) : null}
			{perfBottom ? <div aria-hidden="true" className="perforation" /> : null}
		</div>
	);
}
