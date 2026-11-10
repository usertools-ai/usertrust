// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's rows, fitted to the Now window: the lower row takes the rows Now's content needs, so Now never scrolls,
 * and the desk scrolls instead when it is too short for both rows.
 *
 * The page is read in a layout effect and in what it installs, never while rendering: a server render and the tests
 * have no page, and get `null` (the desk then keeps its first-paint rows). A layout effect, so the first frame is
 * already fitted: the Now window holds its boxes before its data loads, and its rows can be told before anything is
 * painted. The arithmetic is `shared/desk-grid`.
 */

import { type RefObject, useLayoutEffect, useState } from "react";
import {
	gridRowsStyle,
	homeGrid,
	type RowSplit,
	rowsFor,
	rowsToFit,
} from "../../shared/desk-grid.js";
import { COMPACT_QUERY } from "../../shared/desk-layout.js";
import { useMedia } from "./use-box-size.js";

/** What the fit reads off the page, in CSS px. */
export interface FitSizes {
	/** The desk's own height: what its two rows and the gap between them have to fit. */
	deskHeightPx: number;
	/** The Now window around its body: the title bar and the frame. */
	nowBarPx: number;
	/** What the Now window's body holds, at its full height. */
	nowChildrenPx: number;
}

/** The two rows for those sizes: the rows the desk holds, and of them the rows the whole Now window needs. */
export function fitRows(s: FitSizes): RowSplit {
	return homeGrid(rowsFor(s.deskHeightPx), rowsToFit(s.nowBarPx + s.nowChildrenPx));
}

/** The Now window inside the desk, and a window's body inside it. */
const NOW_WINDOW = '[data-win="now"]';
const WINDOW_BODY = ".ut-win-body";

/** The Now window and its body, or null when the desk has no Now window. */
function nowParts(desk: HTMLElement): { now: HTMLElement; body: HTMLElement } | null {
	const now = desk.querySelector<HTMLElement>(NOW_WINDOW);
	const body = now?.querySelector<HTMLElement>(WINDOW_BODY) ?? null;
	return now === null || body === null ? null : { now, body };
}

/**
 * The sizes the fit needs, read off the page; null when there is nothing to read: no Now window, one that is not
 * laid out, or one on its way to or from filling the desk (it is then the desk's size, not its own cell's).
 *
 * What is around the body is the window's height less its body's, so the frame's two borders count with the title
 * bar: with the bar alone the body would come out 2 px short of its content, and scroll. What the body holds is the
 * sum of its children's heights; they take their content's height, whatever the body's own.
 */
export function measureDesk(desk: HTMLElement): FitSizes | null {
	const parts = nowParts(desk);
	if (parts === null) return null;
	const { now, body } = parts;
	if (now.offsetWidth === 0 || now.getAttribute("data-state") !== "home") return null;
	let held = 0;
	for (const child of Array.from(body.children)) held += (child as HTMLElement).offsetHeight;
	return {
		deskHeightPx: desk.clientHeight,
		nowBarPx: now.offsetHeight - body.offsetHeight,
		nowChildrenPx: held,
	};
}

/**
 * Keeps the fit current: measures at once, then again whenever the desk or one of the Now body's children changes
 * size, and when the browser window does. `onFit` is told the rows only when they differ from the last it was told.
 * Returns the clean-up.
 */
export function watchRowFit(desk: HTMLElement, onFit: (rows: string) => void): () => void {
	let last: string | null = null;
	const measure = (): void => {
		const sizes = measureDesk(desk);
		if (sizes === null) return;
		const rows = gridRowsStyle(fitRows(sizes));
		if (rows === last) return;
		last = rows;
		onFit(rows);
	};
	measure();
	const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
	if (observer !== null) {
		observer.observe(desk);
		// A line of Now that changes height (a wrap, a font that loads, Details opened) changes the rows it needs.
		for (const child of Array.from(nowParts(desk)?.body.children ?? [])) observer.observe(child);
	}
	window.addEventListener("resize", measure);
	return () => {
		observer?.disconnect();
		window.removeEventListener("resize", measure);
	};
}

/**
 * What the effect does for one state of the desk, and its clean-up. In the compact column there are no rows to fit.
 * While a window fills the desk nothing is measured, and the desk is put back at its top: the filled window lies
 * over the desk, which must not be scrolled under it.
 */
export function rowFitEffect(
	desk: HTMLElement | null,
	paused: boolean,
	compact: boolean,
	onFit: (rows: string) => void,
): (() => void) | undefined {
	if (desk === null || compact) return undefined;
	if (paused) {
		desk.scrollTop = 0;
		return undefined;
	}
	return watchRowFit(desk, onFit);
}

/**
 * The desk's `grid-template-rows`, fitted to the Now window; `null` before the first measure and in the compact
 * column, where the caller keeps its first-paint rows. While `paused` (a window fills the desk) nothing is measured
 * and the rows stay as they were, so the windows are where they were when the fill started and when it ends.
 */
export function useRowFit(deskRef: RefObject<HTMLElement | null>, paused: boolean): string | null {
	const [fit, setFit] = useState<string | null>(null);
	const compact = useMedia(COMPACT_QUERY, false);
	useLayoutEffect(
		() => rowFitEffect(deskRef.current, paused, compact, setFit),
		[deskRef, paused, compact],
	);
	return compact ? null : fit;
}
