// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Keeps the page's past view in step with the position it wants. No `fetch` and no `window`: the loader is passed in,
 * so every path is tested with a stub.
 *
 * - One request in flight at a time, and the latest wanted position wins: a drag that moves faster than the server
 *   answers asks only for where it ended up, and each answer that lands on the way is shown, so the screen follows.
 * - A refresh (the live vault changed) re-reads the position answered, not the one asked for, so a position asked
 *   for past the head stays the record the reader was shown. A later record can change the status a row had there
 *   (a hold settled after it), so the answer is taken again; its `head` and `clamped` stay those of the answer the
 *   position was chosen with, which is what "N new since" counts from.
 * - An answer from another `epoch` (a reload whose records differ: the position may now name another record) is shown
 *   as it is, flagged `reloaded`, and becomes the baseline. Moving to another position or going live clears the flag.
 * - A failure keeps the last good view and says why. It is not retried on its own: the next move or refresh asks again.
 */

import type { AtPayload } from "./api.js";

export interface AtView {
	/** The answer shown, or null: live, or nothing has loaded for the wanted position yet. */
	at: AtPayload | null;
	/** True while a position is wanted and no answer for it has been shown yet. */
	loading: boolean;
	/** Why the last request failed (a short phrase), or null. */
	error: string | null;
	/** The vault was reloaded with other records while this position was shown. */
	reloaded: boolean;
}

export const LIVE_VIEW: AtView = { at: null, loading: false, error: null, reloaded: false };

export class AtFollower {
	private wanted: number | null = null;
	/** Bumped by every new wanted position (live included): an answer to an older one is not the current choice. */
	private choice = 0;
	/** The answer the current choice was first answered with: its position, head and clamped flag stay. */
	private chosen: AtPayload | null = null;
	private shown: AtPayload | null = null;
	private epoch: number | null = null;
	private inFlight = false;
	private due = false;
	private error: string | null = null;
	private reloaded = false;

	constructor(
		private readonly load: (pos: number) => Promise<AtPayload>,
		private readonly publish: (view: AtView) => void,
	) {}

	/** Show the vault at `pos`, or live (null). */
	want(pos: number | null): void {
		if (pos === this.wanted) return;
		this.wanted = pos;
		this.choice += 1;
		this.chosen = null;
		this.reloaded = false;
		if (pos === null) {
			this.shown = null;
			this.error = null;
			this.epoch = null;
			this.due = false;
		} else {
			this.kick();
		}
		this.emit();
	}

	/** The live vault changed: read the position shown again. Nothing while live. */
	refresh(): void {
		if (this.wanted === null) return;
		this.kick();
	}

	private kick(): void {
		if (this.inFlight) {
			this.due = true;
			return;
		}
		this.start();
	}

	private start(): void {
		const wanted = this.wanted;
		if (wanted === null) return;
		this.inFlight = true;
		this.due = false;
		const choice = this.choice;
		const chosen = this.chosen;
		this.load(chosen?.pos ?? wanted)
			.then(
				(answer) => {
					if (this.wanted === null) return;
					if (this.epoch !== null && answer.epoch !== this.epoch) {
						this.reloaded = true;
						// The records changed under the position: this answer is the new baseline.
						if (choice === this.choice) this.chosen = answer;
					}
					this.epoch = answer.epoch;
					this.error = null;
					if (choice !== this.choice) {
						// An answer for a position the drag has moved past: shown on the way; the latest is already due.
						this.shown = answer;
					} else if (this.chosen === null) {
						this.chosen = answer;
						this.shown = answer;
					} else if (this.chosen === answer) {
						this.shown = answer;
					} else {
						this.shown = { ...answer, head: this.chosen.head, clamped: this.chosen.clamped };
					}
				},
				(err: unknown) => {
					if (this.wanted === null) return;
					this.error =
						err instanceof Error && err.message !== ""
							? err.message
							: "the dashboard did not answer";
				},
			)
			.finally(() => {
				this.inFlight = false;
				if (this.due && this.wanted !== null) this.start();
				this.emit();
			});
	}

	private emit(): void {
		if (this.wanted === null) {
			this.publish(LIVE_VIEW);
			return;
		}
		this.publish({
			at: this.shown,
			loading: this.shown === null && this.error === null,
			error: this.error,
			reloaded: this.reloaded,
		});
	}
}
