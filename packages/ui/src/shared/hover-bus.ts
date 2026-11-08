// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * One hover shared across the desk's windows: the chart under the pointer says which moment it is on, and the others
 * follow; a category under the pointer says which one, and the others light it. `from` names the sender, so no window
 * follows itself. Display only: nothing here is a figure.
 *
 * A bus holds one value and keeps the same object until the next different `set`, so `useSyncExternalStore` can read
 * it as a stable snapshot.
 */

import type { Dimension } from "./breakdown.js";

export interface HoverMoment {
	/** The moment, ms; null: nothing is hovered any more. */
	ms: number | null;
	/** The bucket around it, [t0, t1), for "the hour" in the ledger. */
	span: [number, number] | null;
	from: string;
}

export interface HoverCategory {
	dim: Dimension;
	key: string;
	from: string;
}

export interface Bus<T> {
	get(): T | null;
	set(v: T | null): void;
	subscribe(fn: () => void): () => void;
}

/** Same fields, same values (arrays compared element by element). */
function same(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((v, i) => same(v, b[i]));
	}
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	return ka.every(
		(k) =>
			Object.hasOwn(b, k) &&
			same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
	);
}

export function createBus<T>(): Bus<T> {
	let value: T | null = null;
	const subs = new Set<() => void>();
	return {
		get: () => value,
		set(v) {
			if (same(value, v)) return;
			value = v;
			for (const fn of [...subs]) fn();
		},
		subscribe(fn) {
			subs.add(fn);
			return () => {
				subs.delete(fn);
			};
		},
	};
}

export const momentBus: Bus<HoverMoment> = createBus<HoverMoment>();
export const categoryBus: Bus<HoverCategory> = createBus<HoverCategory>();

/**
 * A setter that publishes at most once per `frame`: calls before the frame runs keep only the last value. `frame` is
 * `requestAnimationFrame` in the browser and a stub in tests.
 */
export function frameLimited<T>(
	bus: Bus<T>,
	frame: (fn: () => void) => void,
): (v: T | null) => void {
	let pending: T | null = null;
	let queued = false;
	return (v) => {
		pending = v;
		if (queued) return;
		queued = true;
		frame(() => {
			queued = false;
			bus.set(pending);
		});
	};
}
