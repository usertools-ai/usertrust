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
 * The exact bytes of that script this page runs (Subresource Integrity). The
 * script is not in this repository, and it runs on the page that shows the
 * verdict and the amount, so the browser refuses any other bytes: a changed
 * kit file fails to load and the field fails closed (no lattice, nothing else
 * changes). Updating it is a reviewed one-line change here, with the hash of
 * the new file: `curl -s <LATTICE_SRC> | openssl dgst -sha384 -binary |
 * openssl base64 -A`. The kit serves it with `access-control-allow-origin: *`,
 * which a CORS-mode (`crossOrigin = "anonymous"`) integrity check needs.
 */
export const LATTICE_INTEGRITY =
	"sha384-7yb4l6jM/tzLwkgPjiRrtn1uHNkOZ8hLcY+Z5WE/A7SzN6uozT02+rYtRhKK2oNg";

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
	script.integrity = LATTICE_INTEGRITY;
	script.crossOrigin = "anonymous";
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
