// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend chart's cursor: a small store, not React state, so a move re-renders only what reads it (the layers and
 * the headline) and never the static marks. Pure.
 */

export interface CursorValue {
	/** The bucket the cursor is in. */
	k: number;
	/** What put it there: the live cursor (`pointer`, `key`), another window's hover (`sync`) or the pinned record (`pin`). */
	via: "pointer" | "key" | "pin" | "sync";
	/** The record's index among the spend records; -1 when there is none. */
	i: number;
}

export interface CursorStore {
	subscribe(fn: () => void): () => void;
	/** The same object until a change, so `useSyncExternalStore` sees no change. */
	get(): CursorValue | null;
	set(v: CursorValue | null): void;
}

export function createCursorStore(): CursorStore {
	let value: CursorValue | null = null;
	const listeners = new Set<() => void>();
	return {
		subscribe(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		get: () => value,
		set(v) {
			if (v === null) {
				if (value === null) return;
			} else if (value !== null && value.k === v.k && value.via === v.via && value.i === v.i) {
				return;
			}
			value = v;
			for (const fn of [...listeners]) fn();
		},
	};
}
