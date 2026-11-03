// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Keeps the page address in step with the dashboard's state, and knows when it is not. A browser can refuse a history
 * write (a sandboxed frame; a burst of `replaceState` calls while someone types, which browsers rate-limit): the
 * address then still describes the previous state, so a reload or a copied link would open something else. A refused
 * write is therefore never swallowed: the address is marked BEHIND (the page says so) and the write is retried, with
 * the newest state, until it lands or a newer state or a navigation supersedes it.
 *
 * No `window` here: the browser is passed in (`AddressIo`), so every path is tested with a stub.
 */

import { planHistory, type UrlState } from "./url-state.js";

/** How long to wait before retrying a refused write, in ms. */
export const ADDRESS_RETRY_MS = 1000;

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
	 * Drop a pending retry. Called when the user navigates (Back, Forward, an edited or followed link): the address they
	 * went to wins, and an older state must not be written over it.
	 */
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
