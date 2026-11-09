// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/** How long a window takes to fill the desk or return, in ms. */
export const FILL_MS = 340;
/** How long the other windows take to fade out and back, in ms. */
export const FADE_MS = 270;
/** The easing of the fill. */
export const FILL_EASE = "cubic-bezier(.2,.8,.2,1)";

/**
 * Whether the reader asked for reduced motion. False with no window (a server render) or no `matchMedia`, so a render
 * never reads the browser; the caller reads this in an effect or an event handler, not while rendering.
 */
export function motionStill(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
