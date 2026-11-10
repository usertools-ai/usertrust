// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The windows' side of the hover bus. Writers publish at most once a frame; readers subscribe with
 * `useSyncExternalStore`, so pointer movement never goes through the desk's contexts.
 */

import { useMemo, useSyncExternalStore } from "react";
import type { Dimension } from "../../shared/breakdown.js";
import {
	categoryBus,
	frameLimited,
	type HoverCategory,
	type HoverMoment,
	momentBus,
} from "../../shared/hover-bus.js";

/** `requestAnimationFrame` where there is one, else run the callback at once (a server render, a test). */
function frame(fn: () => void): void {
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
	else fn();
}

const publishMoment = frameLimited(momentBus, frame);
const publishCategory = frameLimited(categoryBus, frame);

export function setHoverMoment(m: HoverMoment): void {
	publishMoment(m);
}

/** The moment another window is hovering, or null when nothing is, or when `self` is the one hovering. */
export function useHoverMoment(self: string): { ms: number; span: [number, number] } | null {
	const m = useSyncExternalStore(momentBus.subscribe, momentBus.get, momentBus.get);
	return useMemo(
		() =>
			m === null || m.from === self || m.ms === null || m.span === null
				? null
				: { ms: m.ms, span: m.span },
		[m, self],
	);
}

/** The category most recently handed to `setHoverCategory`, which the bus shows only when the frame flushes. */
let latestCategory: HoverCategory | null = null;

export function setHoverCategory(c: HoverCategory | null): void {
	latestCategory = c;
	publishCategory(c);
}

/**
 * The hover that is, or is about to be, on the bus: the last one set, including one still waiting for its frame. A
 * writer that must know whether a hover is its own reads this, not `categoryBus.get()`, which lags by a frame.
 */
export function latestHoverCategory(): HoverCategory | null {
	return latestCategory;
}

export function useHoverCategory(): { dim: Dimension; key: string } | null {
	const c = useSyncExternalStore(categoryBus.subscribe, categoryBus.get, categoryBus.get);
	return useMemo(() => (c === null ? null : { dim: c.dim, key: c.key }), [c]);
}
