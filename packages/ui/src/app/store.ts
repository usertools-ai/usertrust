// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useState } from "react";
import type { SummaryPayload } from "../shared/api.js";
import type { LedgerRow } from "../shared/rows.js";

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

async function fetchAll(): Promise<{ rows: LedgerRow[]; summary: SummaryPayload }> {
	const [eventsRes, summaryRes] = await Promise.all([fetch("/api/events"), fetch("/api/summary")]);
	const { rows } = (await eventsRes.json()) as { rows: LedgerRow[] };
	const summary = (await summaryRes.json()) as SummaryPayload;
	return { rows, summary };
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
		const resync = (): void => {
			fetchAll()
				.then(({ rows, summary }) => {
					// liveIds is flash state for SSE arrivals only — a resync
					// replaces the row set wholesale, so it starts clean.
					if (!cancelled) setData((d) => ({ ...d, rows, summary, liveIds: new Set<string>() }));
				})
				.catch((err: unknown) => {
					// Amendment A6: never leave an unhandled rejection; drop the
					// live indicator so the UI shows the data may be stale.
					console.error("usertrust-ui: ledger fetch failed", err);
					if (!cancelled) setData((d) => ({ ...d, live: false }));
				});
		};
		resync();

		const source = new EventSource("/api/tail");
		source.addEventListener("open", () => {
			setData((d) => ({ ...d, live: true }));
			// Amendment A6: resync on every open — covers rows missed while
			// disconnected (EventSource auto-reconnects).
			resync();
		});
		source.addEventListener("error", () => setData((d) => ({ ...d, live: false })));
		source.addEventListener("rows", (e) => {
			const fresh = JSON.parse((e as MessageEvent).data) as LedgerRow[];
			setData((d) => {
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
		source.addEventListener("summary", (e) => {
			const summary = JSON.parse((e as MessageEvent).data) as SummaryPayload;
			setData((d) => ({ ...d, summary }));
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
