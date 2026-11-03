// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Keeps the page address in step with the dashboard's state, and knows when it is not. A browser can refuse a history
 * write (a sandboxed frame; a burst of `replaceState` calls while someone types, which browsers rate-limit): the
 * address then still describes the previous state, so a reload or a copied link would open something else. A refused
 * write (thrown, or silently ignored and caught by reading the address back) is therefore never swallowed: the address is marked BEHIND (the page says so) and the write is retried, with
 * the newest state, until it lands or a newer state or a navigation supersedes it.
 *
 * No `window` here: the browser is passed in (`AddressIo`), so every path is tested with a stub.
 */

import { decodeUrlState, encodeUrlState, planHistory, type UrlState } from "./url-state.js";

/** How long to wait before retrying a refused write, in ms. */
export const ADDRESS_RETRY_MS = 1000;

/** Why the address does not describe the page, or null when it does. */
export type AddressNote = "cannot-hold" | "behind" | null;

/**
 * Which note the page shows. BEHIND wins: while a write is refused the address still holds the PREVIOUS view, so "a
 * reload opens a clean page" (the cannot-hold note) would be false until the clear lands.
 */
export function addressNoteFor(holds: boolean, behind: boolean): AddressNote {
	if (behind) return "behind";
	return holds ? null : "cannot-hold";
}

export interface AddressIo {
	/** The address's current fragment (`location.hash`). */
	hash(): string;
	/** Write the fragment as a new history entry (`push`) or over the current one (`replace`). May throw. */
	write(kind: "push" | "replace", hash: string): void;
	/** Run `fn` after `ms`; returns a function that cancels it. */
	later(fn: () => void, ms: number): () => void;
}

export class AddressSync {
	/** The state the address last took: a view or record change from it pushes, a filter tweak replaces. */
	private written: UrlState;
	private cancelRetry: (() => void) | null = null;
	private isBehind = false;

	constructor(
		initial: UrlState,
		private readonly io: AddressIo,
		private readonly onBehind: (behind: boolean) => void,
	) {
		this.written = initial;
	}

	/** True while a refused write has left the address describing an older state. */
	get behind(): boolean {
		return this.isBehind;
	}

	/** Bring the address to `state`: write what `planHistory` says, or, if the browser refuses, mark it behind and retry. */
	sync(state: UrlState): void {
		// A newer state replaces any pending retry: the retry below always writes the newest state.
		this.cancel();
		const plan = planHistory(this.written, state, this.io.hash());
		if (plan.kind !== "none") {
			try {
				this.io.write(plan.kind, plan.hash);
				// A browser can also IGNORE a write without throwing (Chromium's navigation rate limit, e.g. a key held
				// down in the search box): read the address back, compared canonically, and treat a mismatch as refused.
				if (encodeUrlState(decodeUrlState(this.io.hash())) !== plan.hash)
					throw new Error("write ignored");
			} catch {
				// Not written: `written` stays the old state, so a refused push is retried as a push.
				this.setBehind(true);
				this.cancelRetry = this.io.later(() => {
					this.cancelRetry = null;
					this.sync(state);
				}, ADDRESS_RETRY_MS);
				return;
			}
		}
		this.written = state;
		this.setBehind(false);
	}

	/**
	 * The user navigated (Back, Forward, an edited or followed link) and the page applied the address's state: the
	 * address describes `state` now. The pending retry is dropped (an older state must not be written over where they
	 * went), the address is no longer behind, and the next change is planned from `state`. Called on EVERY applied
	 * navigation, also when the page already showed that state and so re-renders nothing: otherwise a refused write
	 * followed by a navigation to the same view would leave the note up and the next push or replace wrong.
	 */
	adopt(state: UrlState): void {
		this.cancel();
		this.written = state;
		this.setBehind(false);
	}

	/** Drop a pending retry (the page is going away). */
	cancel(): void {
		this.cancelRetry?.();
		this.cancelRetry = null;
	}

	private setBehind(behind: boolean): void {
		if (behind === this.isBehind) return;
		this.isBehind = behind;
		this.onBehind(behind);
	}
}
