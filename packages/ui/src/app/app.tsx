// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useMemo, useState } from "react";
import { csvFilename, toCsv } from "../shared/csv.js";
import { applyFilters, EMPTY_FILTERS, type FilterState, isFiltering } from "../shared/filters.js";
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

	// Export what the operator is looking at — the filtered set, not the vault.
	// BOM first: Excel reads UTF-8 CSV as latin-1 without it.
	function exportCsv(): void {
		const blob = new Blob([`﻿${toCsv(filtered)}`], { type: "text/csv;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = csvFilename(new Date(), isFiltering(filters));
		a.click();
		URL.revokeObjectURL(url);
	}

	return (
		<div className="mx-auto flex h-screen max-w-[1400px] flex-col gap-3 p-4">
			<SummaryStrip summary={summary} live={live} />
			<div className="reveal reveal-2 flex items-center justify-between gap-3">
				<nav
					aria-label="view"
					className="inline-flex gap-0.5 self-start rounded-md border border-[var(--border)] bg-[var(--panel)] p-0.5"
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
				<button
					type="button"
					onClick={exportCsv}
					disabled={filtered.length === 0}
					title="Download the filtered ledger as CSV"
					className="h-8 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 text-xs uppercase tracking-wider text-[var(--muted)] transition-colors duration-100 hover:text-[var(--text)] disabled:opacity-40"
				>
					Export CSV
				</button>
			</div>
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
