// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A drag along the timeline, kept off the address until it settles. Each move is previewed (the page asks for that
 * position) at most once an animation frame, with the latest value; the address is written once, when the drag is
 * released (pointer up, key up, blur) or has sat still for `COMMIT_IDLE_MS`. Browsers rate-limit `replaceState`, and a
 * drag writing every frame ran into it. No `window`: the frame and the timer are passed in, so every path is tested
 * with a stub.
 */

export interface ScrubIo {
	/** Run `fn` on the next animation frame; returns a function that cancels it. */
	frame(fn: () => void): () => void;
	/** Run `fn` after `ms`; returns a function that cancels it. */
	later(fn: () => void, ms: number): () => void;
}

/** How long a drag sits still before its position is written to the address. */
export const COMMIT_IDLE_MS = 250;

export class Scrubber {
	private latest: number | null = null;
	private cancelFrame: (() => void) | null = null;
	private cancelIdle: (() => void) | null = null;
	/** The last position this drag wrote to the address: the address catching up with it is not an outside change. */
	private committed: number | null = null;

	constructor(
		private readonly io: ScrubIo,
		private readonly onPreview: (pos: number) => void,
		private readonly onCommit: (pos: number) => void,
	) {}

	/** The position moved to and not yet written to the address, or null. */
	get pending(): number | null {
		return this.latest;
	}

	move(pos: number): void {
		this.latest = pos;
		if (this.cancelFrame === null) {
			this.cancelFrame = this.io.frame(() => {
				this.cancelFrame = null;
				if (this.latest !== null) this.onPreview(this.latest);
			});
		}
		this.cancelIdle?.();
		this.cancelIdle = this.io.later(() => {
			this.cancelIdle = null;
			this.release();
		}, COMMIT_IDLE_MS);
	}

	/** The drag ended: preview and write the latest position, once. Nothing pending: nothing happens. */
	release(): void {
		const pos = this.latest;
		this.cancel();
		if (pos === null) return;
		this.committed = pos;
		this.onPreview(pos);
		this.onCommit(pos);
	}

	/**
	 * The address now says `at`. A change this drag did not write (Back, Forward, a followed link, going live) drops a
	 * pending move, so a commit 250 ms later never overwrites where the user went.
	 */
	sync(at: number | null): void {
		if (at === this.committed) return;
		this.committed = at;
		this.cancel();
	}

	/** Drop whatever is pending, writing nothing (going live mid-drag, unmount). */
	cancel(): void {
		this.latest = null;
		this.cancelFrame?.();
		this.cancelFrame = null;
		this.cancelIdle?.();
		this.cancelIdle = null;
	}
}
