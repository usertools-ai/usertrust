// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Which hover the Share window's legend owns. The legend publishes the row under the pointer or, failing that, the
 * row holding keyboard focus; it clears only a hover it published itself, so one set by the ring or by another window
 * is never wiped by a blur or a pointer-leave here.
 */

import type { Dimension } from "../../../shared/breakdown.js";
import type { HoverCategory } from "../../../shared/hover-bus.js";

/** The sender the legend names on the hover it publishes. */
export const LEGEND_FROM = "share-legend";

/** The row to show: the one under the pointer, else the focused one, else none. */
export function rowToShow(pointer: string | null, focus: string | null): string | null {
	return pointer ?? focus;
}

/** Whether the hover now on the bus is the one this legend published last (`published`) at this level. */
export function isOurs(
	current: HoverCategory | null,
	level: Dimension,
	published: string | null,
): boolean {
	return (
		published !== null &&
		current !== null &&
		current.from === LEGEND_FROM &&
		current.dim === level &&
		current.key === published
	);
}

/** What the owner needs of the hover bus: set it, and read the hover most recently set (even one still queued). */
export interface HoverIo {
	set(c: HoverCategory | null): void;
	latest(): HoverCategory | null;
}

/** One string that is the same for two lists only when the lists are the same; a name may hold any character. */
export function listedKey(keys: readonly string[]): string {
	return JSON.stringify(keys);
}

export interface HoverOwner {
	enter(key: string): void;
	leave(): void;
	focus(key: string): void;
	blur(): void;
	/** The rows now listed: a row that is gone stops being held, and its hover is cleared or handed on. */
	rows(listed: readonly string[]): void;
	/** The legend is going away (or changing level): clear its own hover. */
	dispose(): void;
}

/**
 * The legend's hover, one per level. The pointer's row is shown before the focused one; the hover is cleared only
 * when the latest one set is the legend's own, so one the ring or another window set, even if it is still waiting for
 * its frame, is left alone.
 */
export function createHoverOwner(io: HoverIo, level: Dimension): HoverOwner {
	let published: string | null = null;
	let pointer: string | null = null;
	let focused: string | null = null;
	const publish = (key: string | null): void => {
		if (key !== null) {
			published = key;
			io.set({ dim: level, key, from: LEGEND_FROM });
			return;
		}
		const ours = isOurs(io.latest(), level, published);
		published = null;
		if (ours) io.set(null);
	};
	const settle = (): void => publish(rowToShow(pointer, focused));
	return {
		enter(key) {
			pointer = key;
			settle();
		},
		leave() {
			pointer = null;
			settle();
		},
		focus(key) {
			focused = key;
			settle();
		},
		blur() {
			focused = null;
			settle();
		},
		rows(listed) {
			const gone = (k: string | null): boolean => k !== null && !listed.includes(k);
			if (gone(pointer)) pointer = null;
			if (gone(focused)) focused = null;
			if (gone(published)) settle();
		},
		dispose() {
			pointer = null;
			focused = null;
			publish(null);
		},
	};
}
