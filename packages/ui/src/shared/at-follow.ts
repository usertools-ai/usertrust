// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Keeps the page's past view in step with the position it wants. No `fetch` and no `window`: the loader is passed in,
 * so every path is tested with a stub.
 *
 * - One request in flight at a time, and the latest wanted position wins: a preview that moves faster than the server
 *   answers asks only for where it ended up, and each answer that lands on the way is shown, so the screen follows.
 * - A navigation (Back, Forward, a link: `navigated()`) cancels the preview: an answer to a request sent before it is
 *   no longer shown on the way, so the screen never moves to a point the user navigated away from, also when the
 *   destination's own read then fails. An answer for the position wanted next is still the destination's.
 * - A request that has not answered in `timeoutMs` is aborted (its signal) and goes down the failure path, so a hung
 *   server never freezes the view: the next move or refresh asks again.
 * - A refresh (the live vault changed) re-reads the position answered, not the one asked for, so a position asked
 *   for past the head stays the record the reader was shown. A later record can change the status a row had there
 *   (a hold settled after it), so the answer is taken again; its `head` and `clamped` stay those of the answer the
 *   position was chosen with, which is what "N new since" counts from. A re-read that changes nothing keeps the same
 *   answer object and publishes nothing (unless its snapshot reaches the position and the kept one does not: then the
 *   snapshot is replaced).
 * - An answer from another `epoch` (a reload whose records differ: the position may now name another record) is shown
 *   as it is, flagged `reloaded`, and becomes the baseline. Moving to another position or going live clears the flag.
 * - `reconnected()`: the live stream came back, and the server may have restarted, which restarts its epochs. The
 *   epoch and the baseline are forgotten, answers to requests sent before it are dropped, and the re-read is a new
 *   baseline, never compared with the old server's epoch.
 * - Each request takes a snapshot of the rows the page holds in the tick it is sent, and its answer is shown with that
 *   snapshot (`AtView.rows`), never with the rows held when the answer lands. The server answers at a head at least as
 *   new as the snapshot, so every record after the position that the snapshot reflects is also known to the server,
 *   and `statusAt` corrects its rows; a live frame that arrives after the send never touches the snapshot. A
 *   superseded request's answer goes with its snapshot.
 * - `resolved` is the record the wanted position was answered with, kept across reconnects: the re-read of a clamped
 *   position is asked for by the record answered and comes back unclamped, but the selection stays on that record.
 * - A resync replaces the page's rows wholesale (a reload with other records, a reconnect that missed frames), and an
 *   answer can land before its rows do. Each request also notes how many resyncs the page had installed when it was
 *   sent; an identical re-read sent after another resync replaces the kept snapshot, so rows from before a resync
 *   never outlast the one that corrected them.
 * - Each request also notes the epoch of the vault the page's rows came from (`rowsEpoch`), read with the rows. The
 *   page draws a past view only from rows whose epoch is the answer's (`pastRows`), whichever of a reload's rows and
 *   answer lands first.
 * - A failure keeps the last good view and says why. It is not retried on its own.
 */

import type { AtPayload } from "./api.js";
import type { LedgerRow } from "./rows.js";

export interface AtView {
	/** The position wanted (a preview, or the address's), or null for live. */
	wanted: number | null;
	/** The answer shown, or null: live, or nothing has loaded for the wanted position yet. */
	at: AtPayload | null;
	/**
	 * The rows the page held when the request for `at` was sent (null with `at`): the rows the answer is read against.
	 * Not the rows held when it lands.
	 */
	rows: readonly LedgerRow[] | null;
	/**
	 * The record the wanted position was answered with (a position past the head is answered with the head), kept
	 * across reconnects; null until the first answer for the wanted position, and live.
	 */
	resolved: number | null;
	/** True while a position is wanted and no answer for it has been shown yet. */
	loading: boolean;
	/** Why the last request failed (a short phrase), or null. */
	error: string | null;
	/** The vault was reloaded with other records while this position was shown. */
	reloaded: boolean;
	/**
	 * The epoch of the vault the page's rows came from when the request for `at` was sent (null live, and when the
	 * page had none): taken with `rows`, never when the answer lands. `pastRows` pairs it with `at.epoch`.
	 */
	rowsEpoch: number | null;
}

export const LIVE_VIEW: AtView = {
	wanted: null,
	at: null,
	rows: null,
	resolved: null,
	loading: false,
	error: null,
	reloaded: false,
	rowsEpoch: null,
};

/**
 * True while a position is wanted and no answer for it has landed yet: the first read of an address's position, or a
 * new position while an older one is still on screen. False live, once the read has failed (the failure note speaks
 * then), during a reconnect's re-read (the point shown is still the one asked for) and for a position past the head
 * once it is answered (with the head). `loading` covers only the first case: nothing shown at all.
 */
export function pointLoading(view: AtView): boolean {
	return view.wanted !== null && view.resolved === null && view.error === null;
}

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
		a.budget.source === b.budget.source &&
		a.budget.writtenAt === b.budget.writtenAt &&
		a.budget.provenance === b.budget.provenance &&
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
	/** Bumped by every navigation: an answer to a request sent before one is not shown on the way (`navigated`). */
	private navigations = 0;
	/** The answer the current choice was first answered with: its position, head and clamped flag stay. */
	private chosen: AtPayload | null = null;
	private shown: AtPayload | null = null;
	/** The rows held when the request for `shown` was sent. */
	private shownRows: readonly LedgerRow[] | null = null;
	/** How many resyncs the page had installed when `shownRows` were taken. */
	private shownResyncs = 0;
	/** The epoch of the vault `shownRows` came from. */
	private shownRowsEpoch: number | null = null;
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
		/** The rows the page holds right now: read in the tick a request is sent. */
		private readonly heldRows: () => readonly LedgerRow[] = () => [],
		/** How many resyncs (wholesale replacements of the rows) the page has installed: read with the rows. */
		private readonly resyncs: () => number = () => 0,
		private readonly rowsEpoch: () => number | null = () => null,
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
			this.shownRows = null;
			this.shownResyncs = 0;
			this.shownRowsEpoch = null;
			this.error = null;
			this.epoch = null;
			this.due = false;
		} else {
			// A failure belongs to the position it was for: the new one has not failed.
			this.error = null;
			this.kick();
		}
		this.emit();
	}

	/**
	 * The user navigated (Back, Forward, a link, a typed address). Call it before `want` with the address's position.
	 * An answer to a request sent before this is no longer shown on the way: the preview that asked for it was cancelled,
	 * and the screen must never move to a point the user navigated away from. An answer for the position wanted next is
	 * still taken: it is the destination's own.
	 */
	navigated(): void {
		this.navigations += 1;
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
		// A second reconnect before the re-read answers has no answer in `chosen`: keep the position the first one found.
		this.reread = this.chosen?.pos ?? this.reread;
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
		const navigations = this.navigations;
		const chosen = this.chosen;
		// Taken in this tick, with the request: see the header.
		const rows = this.heldRows();
		const resyncs = this.resyncs();
		const rowsEpoch = this.rowsEpoch();
		const abort = new AbortController();
		// The timeout settles the request whether or not the loader honours the signal.
		const timedOut = new Promise<never>((_, reject) => {
			abort.signal.addEventListener("abort", () => reject(new Error(NO_ANSWER)), { once: true });
		});
		const timer = setTimeout(() => abort.abort(), this.timeoutMs);
		Promise.race([this.load(chosen?.pos ?? this.reread ?? wanted, abort.signal), timedOut])
			.then(
				(answer) =>
					this.take(answer, wanted, rows, resyncs, rowsEpoch, choice, generation, navigations),
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

	private take(
		answer: AtPayload,
		/** The position wanted when the request was sent. */
		sentFor: number,
		rows: readonly LedgerRow[],
		resyncs: number,
		rowsEpoch: number | null,
		choice: number,
		generation: number,
		navigations: number,
	): void {
		if (this.wanted === null || generation !== this.generation) return;
		// Sent before a navigation, for a position other than the one wanted now: the preview that asked for it was
		// cancelled, so it is not shown on the way. The position is compared, not the choice: a preview in between moves
		// the choice on, and an answer for the destination itself is still the destination's.
		if (navigations !== this.navigations && sentFor !== this.wanted) return;
		if (this.epoch !== null && answer.epoch !== this.epoch) {
			this.reloaded = true;
			// The records changed under the position: this answer is the new baseline.
			if (choice === this.choice) this.chosen = answer;
		}
		this.epoch = answer.epoch;
		this.error = null;
		if (choice !== this.choice) {
			// An answer for a position the preview has moved past: shown on the way; the latest is already due.
			this.shown = answer;
			this.shownRows = rows;
			this.shownResyncs = resyncs;
			this.shownRowsEpoch = rowsEpoch;
		} else if (this.chosen === null || this.chosen === answer) {
			this.chosen = answer;
			this.shown = answer;
			this.shownRows = rows;
			this.shownResyncs = resyncs;
			this.shownRowsEpoch = rowsEpoch;
			this.reread = null;
		} else if (this.shown === null || !sameReading(this.shown, answer)) {
			this.shown = { ...answer, head: this.chosen.head, clamped: this.chosen.clamped };
			this.shownRows = rows;
			this.shownResyncs = resyncs;
			this.shownRowsEpoch = rowsEpoch;
		} else if (
			resyncs !== this.shownResyncs ||
			(this.shownRows?.at(-1)?.pos ?? -1) < this.shown.pos
		) {
			// The same reading, but the kept snapshot was taken before a resync replaced the rows (an answer can land
			// before its rows do), or before the page held the position (the address's, on load): the snapshot of this
			// request, sent later and before this answer, is as valid and is the one the page holds now.
			this.shownRows = rows;
			this.shownResyncs = resyncs;
			this.shownRowsEpoch = rowsEpoch;
		}
	}

	private emit(): void {
		const view: AtView =
			this.wanted === null
				? LIVE_VIEW
				: {
						wanted: this.wanted,
						at: this.shown,
						rows: this.shownRows,
						resolved: this.chosen?.pos ?? this.reread,
						loading: this.shown === null && this.error === null,
						error: this.error,
						reloaded: this.reloaded,
						rowsEpoch: this.shownRowsEpoch,
					};
		const last = this.published;
		if (
			last !== null &&
			last.wanted === view.wanted &&
			last.at === view.at &&
			last.rows === view.rows &&
			last.rowsEpoch === view.rowsEpoch &&
			last.resolved === view.resolved &&
			last.loading === view.loading &&
			last.error === view.error &&
			last.reloaded === view.reloaded
		)
			return;
		this.published = view;
		this.publish(view);
	}
}
