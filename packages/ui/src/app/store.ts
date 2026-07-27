// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useState } from "react";
import type { SummaryPayload } from "../shared/api.js";
import type { LedgerRow } from "../shared/rows.js";

export interface LedgerData {
	rows: LedgerRow[];
	summary: SummaryPayload | null;
	live: boolean;
}

async function fetchAll(): Promise<{ rows: LedgerRow[]; summary: SummaryPayload }> {
	const [eventsRes, summaryRes] = await Promise.all([fetch("/api/events"), fetch("/api/summary")]);
	const { rows } = (await eventsRes.json()) as { rows: LedgerRow[] };
	const summary = (await summaryRes.json()) as SummaryPayload;
	return { rows, summary };
}

export function useLedger(): LedgerData {
	const [data, setData] = useState<LedgerData>({ rows: [], summary: null, live: false });

	useEffect(() => {
		let cancelled = false;
		const resync = (): void => {
			fetchAll()
				.then(({ rows, summary }) => {
					if (!cancelled) setData((d) => ({ ...d, rows, summary }));
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
			setData((d) => ({ ...d, rows: [...d.rows, ...fresh] }));
		});
		source.addEventListener("summary", (e) => {
			const summary = JSON.parse((e as MessageEvent).data) as SummaryPayload;
			setData((d) => ({ ...d, summary }));
		});
		source.addEventListener("resync", resync);

		return () => {
			cancelled = true;
			source.close();
		};
	}, []);

	return data;
}
