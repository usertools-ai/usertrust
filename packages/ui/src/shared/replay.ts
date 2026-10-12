// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Snapshots and live frames, reconciled by the server's state version: each SSE frame carries it as its `id`, and
 * GET /api/events returns the version its snapshot was taken at, with the summary taken at the same instant.
 *
 * A snapshot fetch can be overtaken by frames sent while it is in flight, and it replaces the rows wholesale. Without
 * this, a `status` correction (an optimistic settlement downgraded to ambiguous) applied before an older snapshot
 * landed was lost under it, and the server never resends a verdict that has not changed again. So each frame is
 * applied at once AND kept while any snapshot is in flight; a landing snapshot gets every kept frame newer than it
 * applied on top.
 *
 * A snapshot can also be overtaken by a NEWER snapshot. One older than the newest already installed is dropped, and so
 * is one begun on an earlier connection: a reconnect starts a new generation (the server may have restarted, and its
 * versions with it), and its own snapshot is the one that counts.
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
	private generation = 0;
	/** The version of the newest snapshot installed on this connection. */
	private installed = Number.NEGATIVE_INFINITY;

	/** A snapshot fetch starts; pass what this returns to `land`. */
	begin(): number {
		this.inFlight += 1;
		return this.generation;
	}

	/** A live frame the caller applies at once; kept while a snapshot is in flight. */
	record(version: number, apply: Update<D>): void {
		if (this.inFlight > 0) this.frames.push({ version, apply });
	}

	/**
	 * A snapshot begun at `generation` and taken at `version` landed: the update that installs it and re-applies every
	 * kept frame newer than it, or undefined when it must be dropped (an earlier connection's, or older than one
	 * already installed).
	 */
	land(generation: number, version: number, install: Update<D>): Update<D> | undefined {
		if (generation !== this.generation || version < this.installed) return undefined;
		this.installed = version;
		const replay = this.frames.filter((f) => f.version > version);
		return (d) => replay.reduce((acc, f) => f.apply(acc), install(d));
	}

	/** A snapshot fetch ended, landed or failed. */
	end(): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
		if (this.inFlight === 0) this.frames = [];
	}

	/**
	 * The stream (re)connected: a new generation. Kept frames, and snapshots still in flight, belong to a connection
	 * whose server may be gone, so its versions mean nothing now.
	 */
	reset(): void {
		this.frames = [];
		this.generation += 1;
		this.installed = Number.NEGATIVE_INFINITY;
	}
}
