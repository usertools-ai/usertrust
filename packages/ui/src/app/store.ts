// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useState } from "react";
import type { SummaryPayload } from "../shared/api.js";
import { vaultKey } from "../shared/asof.js";
import type { LoadPhase } from "../shared/display.js";
import { applyStatusChanges, novelRows, type StatusChange } from "../shared/live.js";
import { frameVersion, resyncRetryDelay, SnapshotReplay, type Update } from "../shared/replay.js";
import type { LedgerRow } from "../shared/rows.js";

/**
 * The live stream. `reconnecting` is what EventSource does on its own after an error: the indicator said "offline"
 * for it. `offline` is a stream the browser has given up on.
 */
export type LiveState = "connecting" | "live" | "reconnecting" | "offline";

export interface LedgerData {
	rows: LedgerRow[];
	summary: SummaryPayload | null;
	/** Whether a snapshot has landed: rows start empty, and an empty list before one is loading, not "no rows". */
	phase: LoadPhase;
	live: LiveState;
	/**
	 * Ephemeral UI state (P6): the event hashes of rows that just arrived over SSE, kept for
	 * ~1.6s so the table can one-shot flash them. Never persisted — reset
	 * on resync, pruned by per-batch timers so virtualization remounts
	 * cannot re-trigger the flash.
	 */
	liveIds: Set<string>;
	/**
	 * How many snapshots have replaced the rows wholesale (the first load, a reload with other records, a reconnect):
	 * the past view uses it to tell rows from before a replacement from the rows that corrected them.
	 */
	resyncs: number;
	/**
	 * The vault the rows come from (`vaultKey`: the server's boot and epoch), installed with them in each resync. Null
	 * when not loaded, while a resync is under way, or from a server that sends no boot. Frames never change it.
	 */
	rowsVault: string | null;
}

async function fetchAll(): Promise<{
	rows: LedgerRow[];
	summary: SummaryPayload;
	version: number;
	vault: string | null;
}> {
	// ONE request: the rows and the summary are taken at the same version. Two requests let an append land between
	// them, and its summary frame (the same version as the newer half) was never re-applied over the stale one.
	const res = await fetch("/api/events");
	const { rows, summary, version, epoch, boot } = (await res.json()) as {
		rows: LedgerRow[];
		summary: SummaryPayload;
		version?: unknown;
		epoch?: unknown;
		boot?: unknown;
	};
	// No version: older than every frame, so every kept frame is re-applied on top.
	return {
		rows,
		summary,
		version: typeof version === "number" ? version : -1,
		vault: vaultKey(boot, epoch),
	};
}

export function useLedger(): LedgerData {
	const [data, setData] = useState<LedgerData>({
		rows: [],
		summary: null,
		phase: "loading",
		live: "connecting",
		liveIds: new Set(),
		resyncs: 0,
		rowsVault: null,
	});

	useEffect(() => {
		let cancelled = false;
		const flashTimers = new Set<ReturnType<typeof setTimeout>>();
		// A snapshot replaces the rows wholesale; frames that overtook it are re-applied on top (shared/replay.ts).
		const replay = new SnapshotReplay<LedgerData>();
		const frame = (e: Event, apply: Update<LedgerData>): void => {
			replay.record(frameVersion((e as MessageEvent).lastEventId), apply);
			setData(apply);
		};
		// Resyncs begun so far: a snapshot labels its rows with its vault only if it is still the newest one begun, so a
		// slower, older snapshot never labels rows a newer resync has made unknown. A failed fetch is tried again.
		let resyncsBegun = 0;
		let failures = 0;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const resync = (): void => {
			clearTimeout(retry);
			const mine = ++resyncsBegun;
			const generation = replay.begin();
			// The rows held are about to be replaced: until the snapshot lands their vault is unknown, so a frame that
			// arrives meanwhile is never taken for the old vault's (the server sends `resync` before any later append).
			if (!cancelled) setData((d) => ({ ...d, rowsVault: null }));
			fetchAll()
				.then(({ rows, summary, version, vault }) => {
					failures = 0;
					// liveIds is flash state for SSE arrivals only — a resync
					// replaces the row set wholesale, so it starts clean (after
					// the replay too: a re-applied frame is not a new arrival).
					if (!cancelled) {
						// Undefined: a newer snapshot, or a newer connection's, is already installed.
						const install = replay.land(generation, version, (d) => ({
							...d,
							rows,
							summary,
							rowsVault: mine === resyncsBegun ? vault : null,
							phase: "loaded" as const,
						}));
						if (install !== undefined)
							setData((d) => ({
								...install(d),
								liveIds: new Set<string>(),
								resyncs: d.resyncs + 1,
							}));
					}
				})
				.catch((err: unknown) => {
					// Amendment A6: never leave an unhandled rejection; drop the
					// live indicator so the UI shows the data may be stale.
					console.error("usertrust-ui: ledger fetch failed", err);
					// Tried again with backoff: until a snapshot lands the rows' vault is unknown and a past view waits.
					// Only the newest resync begun retries: an older one that fails after a newer one began is moot.
					if (!cancelled && mine === resyncsBegun) {
						failures += 1;
						retry = setTimeout(resync, resyncRetryDelay(failures));
					}
					// A snapshot already held stays "loaded": its rows are still shown, and the next resync replaces them.
					if (!cancelled)
						setData((d) => ({
							...d,
							live: d.live === "live" ? "reconnecting" : d.live,
							phase: d.phase === "loaded" ? "loaded" : "failed",
						}));
				})
				.finally(() => replay.end());
		};
		resync();

		const source = new EventSource("/api/tail");
		source.addEventListener("open", () => {
			replay.reset();
			setData((d) => ({ ...d, live: "live" }));
			// Amendment A6: resync on every open — covers rows missed while
			// disconnected (EventSource auto-reconnects).
			resync();
		});
		source.addEventListener("error", () => {
			const live: LiveState = source.readyState === EventSource.CLOSED ? "offline" : "reconnecting";
			setData((d) => ({ ...d, live }));
		});
		source.addEventListener("rows", (e) => {
			const fresh = JSON.parse((e as MessageEvent).data) as LedgerRow[];
			frame(e, (d) => {
				// Dedup by event hash (shared/live.ts): a frame can redeliver rows
				// the resync fetch already returned, and an id can repeat.
				const novel = novelRows(d.rows, fresh);
				if (novel.length === 0) return d;
				const liveIds = new Set(d.liveIds);
				for (const r of novel) liveIds.add(r.hash);
				return { ...d, rows: [...d.rows, ...novel], liveIds };
			});
			// One-shot flash (P6): drop this batch's ids once the row-flash
			// animation window has passed, so remounted virtual rows stay quiet.
			const ids = fresh.map((r) => r.hash);
			const timer = setTimeout(() => {
				flashTimers.delete(timer);
				setData((d) => {
					if (d.liveIds.size === 0) return d;
					const liveIds = new Set(d.liveIds);
					let changed = false;
					for (const id of ids) changed = liveIds.delete(id) || changed;
					return changed ? { ...d, liveIds } : d;
				});
			}, 1600);
			flashTimers.add(timer);
		});
		// A new record can change an EARLIER row's verdict (an ambiguity after an optimistic settlement): the server
		// sends each changed row's new status.
		source.addEventListener("status", (e) => {
			const changes = JSON.parse((e as MessageEvent).data) as StatusChange[];
			// Applied to the row whose event HASH each change names (shared/live.ts), never to every row sharing an id.
			frame(e, (d) => ({ ...d, rows: applyStatusChanges(d.rows, changes) }));
		});
		source.addEventListener("summary", (e) => {
			const summary = JSON.parse((e as MessageEvent).data) as SummaryPayload;
			frame(e, (d) => ({ ...d, summary }));
		});
		source.addEventListener("resync", resync);

		return () => {
			clearTimeout(retry);
			cancelled = true;
			for (const timer of flashTimers) clearTimeout(timer);
			source.close();
		};
	}, []);

	return data;
}
