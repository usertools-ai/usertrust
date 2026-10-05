"use client";

import { useEffect } from "react";

/**
 * The usertools brand field behind the receipt: the shared dot lattice in gold,
 * one wave on load and then frozen. A receipt has nothing to watch, so after
 * the wave the page does no animation work at all; reduced motion, a missing
 * WebGL context and a hidden tab are handled inside the module.
 *
 * `../vendor/lattice.js` is a byte-for-byte copy of the usertools site kit's
 * lattice. It is never edited here: `lib/lattice-vendor.test.ts` pins its
 * sha256, so a change fails the build. To update it, copy the new file and
 * the new hash together.
 *
 * The module configures itself from this canvas's data attributes and starts
 * on import, so it is loaded after mount, when the canvas exists.
 */
export default function LatticeField() {
	useEffect(() => {
		void import("../vendor/lattice.js");
	}, []);
	return (
		// biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas is not focusable; the rule treats it as interactive
		<canvas id="field" data-network data-accent="gold" data-mode="wave-once" aria-hidden="true" />
	);
}
