// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Keeps the page's past view in step with the position it wants. No `fetch` and no `window`: the loader is passed in,
 * so every path is tested with a stub.
 *
 * - One request in flight at a time, and the latest wanted position wins: a drag that moves faster than the server
 *   answers asks only for where it ended up, and each answer that lands on the way is shown, so the screen follows.
 * - A request that has not answered in `timeoutMs` is aborted (its signal) and goes down the failure path, so a hung
 *   server never freezes the timeline: the next move or refresh asks again.
 * - A refresh (the live vault changed) re-reads the position answered, not the one asked for, so a position asked
 *   for past the head stays the record the reader was shown. A later record can change the status a row had there
 *   (a hold settled after it), so the answer is taken again; its `head` and `clamped` stay those of the answer the
 *   position was chosen with, which is what "N new since" counts from. A re-read that changes nothing keeps the same
 *   answer object and publishes nothing.
 * - An answer from another `epoch` (a reload whose records differ: the position may now name another record) is shown
 *   as it is, flagged `reloaded`, and becomes the baseline. Moving to another position or going live clears the flag.
 * - `reconnected()`: the live stream came back, and the server may have restarted, which restarts its epochs. The
 *   epoch and the baseline are forgotten, answers to requests sent before it are dropped, and the re-read is a new
 *   baseline, never compared with the old server's epoch.
 * - A failure keeps the last good view and says why. It is not retried on its own.
 */

import type { AtPayload } from "./api.js";

export interface AtView {
	/** The position wanted (a preview during a drag, or the address's), or null for live. */
	wanted: number | null;
	/** The answer shown, or null: live, or nothing has loaded for the wanted position yet. */
	at: AtPayload | null;
	/** True while a position is wanted and no answer for it has been shown yet. */
	loading: boolean;
	/** Why the last request failed (a short phrase), or null. */
	error: string | null;
	/** The vault was reloaded with other records while this position was shown. */
	reloaded: boolean;
}

export const LIVE_VIEW: AtView = {
	wanted: null,
	at: null,
	loading: false,
	error: null,
	reloaded: false,
};

/** How long a request may go unanswered before it is given up. */
export const AT_TIMEOUT_MS = 10_000;

const NO_ANSWER = "the dashboard did not answer";

/** The same reading of the vault at the same position: everything but `head` and `clamped`, which the baseline keeps. */
function sameReading(a: AtPayload, b: AtPayload): boolean {
	return (
		a.pos === b.pos &&
		a.ts === b.ts &&
		a.epoch === b.epoch &&
		a.spentUt === b.spentUt &&
		a.plan === b.plan &&
		a.windowStartPos === b.windowStartPos &&
		a.chain.valid === b.chain.valid &&
		a.chain.breakIndex === b.chain.breakIndex &&
		a.budget.ut === b.budget.ut &&
		a.budget.note === b.budget.note &&
		a.counts.llm_call === b.counts.llm_call &&
		a.counts.denied === b.counts.denied &&
		a.counts.other === b.counts.other &&
		sameStatuses(a.statusAt, b.statusAt)
	);
}

function sameStatuses(a: AtPayload["statusAt"], b: AtPayload["statusAt"]): boolean {
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

export class AtFollower {
	private wanted: number | null = null;
	/** Bumped by every new wanted position (live included): an answer to an older one is not the current choice. */
	private choice = 0;
	/** Bumped by every reconnect: an answer to a request sent before one is dropped. */
	private generation = 0;
	/** The answer the current choice was first answered with: its position, head and clamped flag stay. */
	private chosen: AtPayload | null = null;
	private shown: AtPayload | null = null;
	private epoch: number | null = null;
	private inFlight = false;
	private due = false;
	private error: string | null = null;
	private reloaded = false;
	/** After a reconnect, the position the lost baseline was answered at: re-read that, not the one asked for. */
	private reread: number | null = null;
	private published: AtView | null = null;

	constructor(
		private readonly load: (pos: number, signal: AbortSignal) => Promise<AtPayload>,
		private readonly publish: (view: AtView) => void,
		private readonly timeoutMs: number = AT_TIMEOUT_MS,
	) {}

	/** Show the vault at `pos`, or live (null). */
	want(pos: number | null): void {
		if (pos === this.wanted) return;
		this.wanted = pos;
		this.choice += 1;
		this.chosen = null;
		this.reread = null;
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

	/**
	 * The live stream reconnected: the server may be a new one. Forget its epoch, the baseline and any reloaded note
	 * (the old server's epochs say nothing about the new one), and re-read the position answered (a clamped one stays
	 * the record shown). Nothing while live.
	 */
	reconnected(): void {
		this.generation += 1;
		this.reread = this.chosen?.pos ?? null;
		this.epoch = null;
		this.chosen = null;
		this.reloaded = false;
		this.choice += 1;
		if (this.wanted === null) return;
		this.kick();
		this.emit();
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
		const generation = this.generation;
		const chosen = this.chosen;
		const abort = new AbortController();
		// The timeout settles the request whether or not the loader honours the signal.
		const timedOut = new Promise<never>((_, reject) => {
			abort.signal.addEventListener("abort", () => reject(new Error(NO_ANSWER)), { once: true });
		});
		const timer = setTimeout(() => abort.abort(), this.timeoutMs);
		Promise.race([this.load(chosen?.pos ?? this.reread ?? wanted, abort.signal), timedOut])
			.then(
				(answer) => this.take(answer, choice, generation),
				(err: unknown) => {
					if (this.wanted === null || generation !== this.generation) return;
					// A failure for a position the user has left says nothing about the one they are on now.
					if (choice !== this.choice) return;
					this.error = err instanceof Error && err.message !== "" ? err.message : NO_ANSWER;
				},
			)
			.finally(() => {
				clearTimeout(timer);
				this.inFlight = false;
				if (this.due && this.wanted !== null) this.start();
				this.emit();
			});
	}

	private take(answer: AtPayload, choice: number, generation: number): void {
		if (this.wanted === null || generation !== this.generation) return;
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
		} else if (this.chosen === null || this.chosen === answer) {
			this.chosen = answer;
			this.shown = answer;
			this.reread = null;
		} else if (this.shown === null || !sameReading(this.shown, answer)) {
			this.shown = { ...answer, head: this.chosen.head, clamped: this.chosen.clamped };
		}
	}

	private emit(): void {
		const view: AtView =
			this.wanted === null
				? LIVE_VIEW
				: {
						wanted: this.wanted,
						at: this.shown,
						loading: this.shown === null && this.error === null,
						error: this.error,
						reloaded: this.reloaded,
					};
		const last = this.published;
		if (
			last !== null &&
			last.wanted === view.wanted &&
			last.at === view.at &&
			last.loading === view.loading &&
			last.error === view.error &&
			last.reloaded === view.reloaded
		)
			return;
		this.published = view;
		this.publish(view);
	}
}
