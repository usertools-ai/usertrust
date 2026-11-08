// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Escape takes the desk apart one layer at a time, outermost first: the record panel, the fill, the pin, then the
 * newest filter. Removing a filter never closes a fill. Escape that something else owns (a search box, a select, a
 * dialog, an open popover, anything that already called `preventDefault`) is left alone.
 */

import { useEffect, useRef } from "react";
import type { WindowId } from "../../shared/desk-layout.js";
import { popoverOwnsEscape } from "../../shared/row-nav.js";

export interface PeelState {
	recordOpen: boolean;
	fill: WindowId | null;
	pinned: boolean;
	newestFilter: string | null;
}

export type Peel = "record" | "fill" | "pin" | "filter";

/** The layer Escape removes next, or null when the desk is bare. */
export function nextPeel(s: PeelState): Peel | null {
	if (s.recordOpen) return "record";
	if (s.fill !== null) return "fill";
	if (s.pinned) return "pin";
	if (s.newestFilter !== null) return "filter";
	return null;
}

/** Controls and layers that handle their own Escape. */
export const PEEL_SKIP = "input, textarea, select, [role=dialog], .ut-pop";

export function shouldPeel(e: {
	key: string;
	defaultPrevented: boolean;
	target: { closest?: (sel: string) => unknown } | null;
}): boolean {
	if (e.key !== "Escape" || e.defaultPrevented) return false;
	const inside = e.target?.closest?.(PEEL_SKIP);
	return !inside;
}

/**
 * One document listener (bubble phase). The record panel closes itself in the capture phase, so by the time this runs
 * its state may already be closed: the "record" step only has to be safe to repeat.
 */
export function useEscapePeel(state: PeelState, act: Record<Peel, () => void>): void {
	const latest = useRef({ state, act });
	useEffect(() => {
		latest.current = { state, act };
	});
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent): void => {
			// `e.target` is an `EventTarget`; only an `Element` has `closest`, and `shouldPeel` checks for it.
			const target = e.target as Element | null;
			if (!shouldPeel({ key: e.key, defaultPrevented: e.defaultPrevented, target })) return;
			// A popover open elsewhere on the page owns this Escape even when focus is not inside it.
			if (popoverOwnsEscape(document)) return;
			const step = nextPeel(latest.current.state);
			if (step === null) return;
			e.preventDefault();
			latest.current.act[step]();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);
}
