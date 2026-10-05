"use client";

import { useEffect } from "react";

/**
 * Where the brand field's script lives: the brand site's kit. No brand asset
 * is kept in this public repo, so the lattice is loaded at runtime, never
 * vendored. It is a classic script that finds every `[data-network]` canvas
 * and starts on load; reduced motion, a missing WebGL context and a hidden tab
 * are handled inside it.
 */
export const LATTICE_SRC = "https://usertrust.ai/kit/lattice.js";

/**
 * Appends the kit's lattice script once, in the usertrust theme. The kit reads
 * its theme from the script element's `data-theme`; without it the field draws
 * the usertools settlement spectrum, green and red included, behind a receipt
 * whose own register may be neither. The canvas's `data-accent` and
 * `data-mode` are read by later kit versions, which use them instead.
 */
export function appendLatticeScript(doc: Document): void {
	if (doc.querySelector(`script[src="${LATTICE_SRC}"]`)) return;
	const script = doc.createElement("script");
	script.src = LATTICE_SRC;
	script.async = true;
	script.dataset.theme = "usertrust";
	doc.body.appendChild(script);
}

/**
 * The usertools brand field behind the receipt: the shared dot lattice in
 * gold. The script is appended after mount, when the canvas exists. If it
 * fails to load, the canvas stays empty and the page's plain ground shows:
 * nothing on the receipt depends on it.
 */
export default function LatticeField() {
	useEffect(() => appendLatticeScript(document), []);
	return (
		// biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas is not focusable; the rule treats it as interactive
		<canvas id="field" data-network data-accent="gold" data-mode="wave-once" aria-hidden="true" />
	);
}
