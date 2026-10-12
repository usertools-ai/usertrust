// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useState } from "react";
import type { SummaryPayload } from "../shared/api.js";
import { frameVersion, SnapshotReplay, type Update } from "../shared/replay.js";
import type { LedgerRow, RowStatus } from "../shared/rows.js";

export interface LedgerData {
	rows: LedgerRow[];
	summary: SummaryPayload | null;
	live: boolean;
	/**
	 * Ephemeral UI state (P6): ids that just arrived over SSE, kept for
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
	const [eventsRes, summaryRes] = await Promise.all([fetch("/api/events"), fetch("/api/summary")]);
	const { rows, version } = (await eventsRes.json()) as { rows: LedgerRow[]; version?: unknown };
	const summary = (await summaryRes.json()) as SummaryPayload;
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
			replay.begin();
			fetchAll()
				.then(({ rows, summary, version }) => {
					// liveIds is flash state for SSE arrivals only — a resync
					// replaces the row set wholesale, so it starts clean (after
					// the replay too: a re-applied frame is not a new arrival).
					if (!cancelled) {
						const install = replay.land(version, (d) => ({ ...d, rows, summary }));
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
				// Dedup by id: an SSE frame can race the open-triggered resync
				// fetch and redeliver rows the fetch already returned.
				const seen = new Set(d.rows.map((r) => r.id));
				const novel = fresh.filter((r) => !seen.has(r.id));
				if (novel.length === 0) return d;
				const liveIds = new Set(d.liveIds);
				for (const r of novel) liveIds.add(r.id);
				return { ...d, rows: [...d.rows, ...novel], liveIds };
			});
			// One-shot flash (P6): drop this batch's ids once the row-flash
			// animation window has passed, so remounted virtual rows stay quiet.
			const ids = fresh.map((r) => r.id);
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
			const changes = JSON.parse((e as MessageEvent).data) as Array<{
				id: string;
				status: RowStatus;
			}>;
			const next = new Map(changes.map((c) => [c.id, c.status]));
			frame(e, (d) => ({
				...d,
				rows: d.rows.map((r) => {
					const status = next.get(r.id);
					return status === undefined ? r : { ...r, status };
				}),
			}));
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
