// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Snapshots and live frames, reconciled by the server's state version: each SSE frame carries it as its `id`, and
 * GET /api/events returns the version its snapshot was taken at.
 *
 * A snapshot fetch can be overtaken by frames sent while it is in flight, and it replaces the rows wholesale. Without
 * this, a `status` correction (an optimistic settlement downgraded to ambiguous) applied before an older snapshot
 * landed was lost under it, and the server never resends a verdict that has not changed again. So each frame is
 * applied at once AND kept while any snapshot is in flight; a landing snapshot gets every kept frame newer than it
 * applied on top.
 */

export type Update<D> = (d: D) => D;

/** A frame's version from its SSE `id`. A frame without one is newer than any snapshot, so it is always re-applied. */
export function frameVersion(lastEventId: string): number {
	const v = lastEventId === "" ? Number.NaN : Number(lastEventId);
	return Number.isSafeInteger(v) ? v : Number.POSITIVE_INFINITY;
}

export class SnapshotReplay<D> {
	private inFlight = 0;
	private frames: Array<{ version: number; apply: Update<D> }> = [];

	/** A snapshot fetch starts. */
	begin(): void {
		this.inFlight += 1;
	}

	/** A live frame the caller applies at once; kept while a snapshot is in flight. */
	record(version: number, apply: Update<D>): void {
		if (this.inFlight > 0) this.frames.push({ version, apply });
	}

	/** A snapshot taken at `version` landed: the update that installs it and re-applies every kept frame newer than it. */
	land(version: number, install: Update<D>): Update<D> {
		const replay = this.frames.filter((f) => f.version > version);
		return (d) => replay.reduce((acc, f) => f.apply(acc), install(d));
	}

	/** A snapshot fetch ended, landed or failed. */
	end(): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
		if (this.inFlight === 0) this.frames = [];
	}

	/** The stream (re)connected: a kept frame may come from a server that is gone, whose versions mean nothing now. */
	reset(): void {
		this.frames = [];
	}
}
