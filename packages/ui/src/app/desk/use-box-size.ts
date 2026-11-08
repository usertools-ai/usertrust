// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Reading an element's size and the viewport's width, without reading the browser while rendering (a server render and
 * the tests render with neither).
 *
 * The box is the content box in CSS pixels exactly as the browser reports it, fractions and all (700.4, not 700): a
 * chart whose viewBox equals the CSS box lands its crosshair within half a pixel at 125% zoom, and a rounded box
 * cannot. Nothing in this file rounds.
 */

import { type RefObject, useCallback, useEffect, useState, useSyncExternalStore } from "react";

/** The content box a ResizeObserver entry reports, unrounded. */
export function boxOf(entry: { contentRect: { width: number; height: number } }): {
	w: number;
	h: number;
} {
	return { w: entry.contentRect.width, h: entry.contentRect.height };
}

/**
 * The content box of the element in `ref`: `{w:0,h:0}` until it is measured (and for ever under a server render).
 * One ResizeObserver, at most one state update per frame, and none when the size is exactly what it was.
 */
export function useBoxSize(ref: RefObject<Element | null>): { w: number; h: number } {
	const [box, setBox] = useState({ w: 0, h: 0 });
	useEffect(() => {
		const el = ref.current;
		if (el === null || typeof ResizeObserver === "undefined") return;
		let raf = 0;
		let pending: { w: number; h: number } | null = null;
		const flush = (): void => {
			raf = 0;
			const next = pending;
			pending = null;
			if (next !== null) setBox((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
		};
		const observer = new ResizeObserver((entries) => {
			const last = entries[entries.length - 1];
			if (last === undefined) return;
			pending = boxOf(last);
			if (raf !== 0) return;
			if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(flush);
			else flush();
		});
		observer.observe(el);
		return () => {
			observer.disconnect();
			if (raf !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
		};
	}, [ref]);
	return box;
}

/**
 * Whether a media query matches, kept current. `server` is the answer for a render with no browser (a server render,
 * the tests), so the first paint never reads `matchMedia` while rendering.
 */
export function useMedia(query: string, server: boolean): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (typeof window === "undefined" || typeof window.matchMedia !== "function")
				return () => undefined;
			const m = window.matchMedia(query);
			m.addEventListener("change", onChange);
			return () => m.removeEventListener("change", onChange);
		},
		[query],
	);
	const snapshot = useCallback(
		() =>
			typeof window === "undefined" || typeof window.matchMedia !== "function"
				? server
				: window.matchMedia(query).matches,
		[query, server],
	);
	return useSyncExternalStore(subscribe, snapshot, () => server);
}
