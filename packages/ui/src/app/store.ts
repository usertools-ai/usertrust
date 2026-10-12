// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useState } from "react";
import type { SummaryPayload } from "../shared/api.js";
import { applyStatusChanges, novelRows, type StatusChange } from "../shared/live.js";
import { frameVersion, SnapshotReplay, type Update } from "../shared/replay.js";
import type { LedgerRow } from "../shared/rows.js";

export interface LedgerData {
	rows: LedgerRow[];
	summary: SummaryPayload | null;
	live: boolean;
	/**
	 * Ephemeral UI state (P6): the event hashes of rows that just arrived over SSE, kept for
	 * ~1.6s so the table can one-shot flash them. Never persisted — reset
	 * on resync, pruned by per-batch timers so virtualization remounts
	 * cannot re-trigger the flash.
	 */
	liveIds: Set<string>;
}

async function fetchAll(): Promise<{
	rows: LedgerRow[];
	summary: SummaryPayload;
	version: number;
}> {
	// ONE request: the rows and the summary are taken at the same version. Two requests let an append land between
	// them, and its summary frame (the same version as the newer half) was never re-applied over the stale one.
	const res = await fetch("/api/events");
	const { rows, summary, version } = (await res.json()) as {
		rows: LedgerRow[];
		summary: SummaryPayload;
		version?: unknown;
	};
	// No version: older than every frame, so every kept frame is re-applied on top.
	return { rows, summary, version: typeof version === "number" ? version : -1 };
}

export function useLedger(): LedgerData {
	const [data, setData] = useState<LedgerData>({
		rows: [],
		summary: null,
		live: false,
		liveIds: new Set(),
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
		const resync = (): void => {
			const generation = replay.begin();
			fetchAll()
				.then(({ rows, summary, version }) => {
					// liveIds is flash state for SSE arrivals only — a resync
					// replaces the row set wholesale, so it starts clean (after
					// the replay too: a re-applied frame is not a new arrival).
					if (!cancelled) {
						// Undefined: a newer snapshot, or a newer connection's, is already installed.
						const install = replay.land(generation, version, (d) => ({ ...d, rows, summary }));
						if (install !== undefined)
							setData((d) => ({ ...install(d), liveIds: new Set<string>() }));
					}
				})
				.catch((err: unknown) => {
					// Amendment A6: never leave an unhandled rejection; drop the
					// live indicator so the UI shows the data may be stale.
					console.error("usertrust-ui: ledger fetch failed", err);
					if (!cancelled) setData((d) => ({ ...d, live: false }));
				})
				.finally(() => replay.end());
		};
		resync();

		const source = new EventSource("/api/tail");
		source.addEventListener("open", () => {
			replay.reset();
			setData((d) => ({ ...d, live: true }));
			// Amendment A6: resync on every open — covers rows missed while
			// disconnected (EventSource auto-reconnects).
			resync();
		});
		source.addEventListener("error", () => setData((d) => ({ ...d, live: false })));
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
			cancelled = true;
			for (const timer of flashTimers) clearTimeout(timer);
			source.close();
		};
	}, []);

	return data;
}
