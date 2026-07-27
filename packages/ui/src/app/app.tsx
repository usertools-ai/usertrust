// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useMemo, useState } from "react";
import { applyFilters, EMPTY_FILTERS, type FilterState } from "../shared/filters.js";
import type { LedgerRow } from "../shared/rows.js";
import { AuditTable } from "./audit-table.js";
import { FilterBar } from "./filter-bar.js";
import { RowPanel } from "./row-panel.js";
import { useLedger } from "./store.js";
import { SummaryStrip } from "./summary-strip.js";
import { Trends } from "./trends.js";

export type View = "audit" | "trends";

export function App(): React.JSX.Element {
	const { rows, summary, live, liveIds } = useLedger();
	const [view, setView] = useState<View>("audit");
	const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
	const [open, setOpen] = useState<LedgerRow | null>(null);
	const filtered = useMemo(() => applyFilters(rows, filters), [rows, filters]);

	return (
		<div className="mx-auto flex h-screen max-w-[1400px] flex-col gap-3 p-4">
			<SummaryStrip summary={summary} live={live} />
			<nav
				aria-label="view"
				className="reveal reveal-2 inline-flex gap-0.5 self-start rounded-md border border-[var(--border)] bg-[var(--panel)] p-0.5"
			>
				{(["audit", "trends"] as const).map((v) => (
					<button
						key={v}
						type="button"
						onClick={() => setView(v)}
						aria-pressed={view === v}
						className={`rounded px-3 py-1 text-xs uppercase tracking-wider transition-colors duration-100 ${view === v ? "bg-[var(--panel-2)] text-[var(--text)]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}
					>
						{v}
					</button>
				))}
			</nav>
			{/* P6: reveal stays on chrome — the table/scroll surface never animates */}
			<div className="reveal reveal-3">
				<FilterBar rows={rows} filters={filters} onChange={setFilters} />
			</div>
			{view === "audit" ? (
				<AuditTable rows={filtered} liveIds={liveIds} onOpen={setOpen} />
			) : (
				<Trends rows={filtered} />
			)}
			{open && <RowPanel row={open} onClose={() => setOpen(null)} />}
		</div>
	);
}
