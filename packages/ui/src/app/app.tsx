// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useCallback, useEffect, useMemo, useState } from "react";
import { csvFilename, toCsv } from "../shared/csv.js";
import { chainStatus } from "../shared/display.js";
import { applyFilters, EMPTY_FILTERS, type FilterState, isFiltering } from "../shared/filters.js";
import type { LedgerRow } from "../shared/rows.js";
import { AuditTable } from "./audit-table.js";
import { FilterBar } from "./filter-bar.js";
import { InspectorHint, RowPanel } from "./row-panel.js";
import { useLedger } from "./store.js";
import { SummaryStrip } from "./summary-strip.js";
import { Trends } from "./trends.js";

export type View = "audit" | "trends";

const VIEWS: Array<{ id: View; label: string }> = [
	{ id: "audit", label: "Audit" },
	{ id: "trends", label: "Trends" },
];

/** At this width the inspector docks beside the list; below it, it opens over the list. */
const DOCK_QUERY = "(min-width: 1100px)";

function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const m = window.matchMedia(query);
		const on = (): void => setMatches(m.matches);
		on();
		m.addEventListener("change", on);
		return () => m.removeEventListener("change", on);
	}, [query]);
	return matches;
}

export function App(): React.JSX.Element {
	const { rows, summary, phase, live, liveIds } = useLedger();
	const [view, setView] = useState<View>("audit");
	const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
	// The selected row's event HASH (unique on the chain, where an id can repeat), resolved from the current rows: a
	// `status` correction replaces the row object, and a panel holding the old one kept showing the old status.
	const [openHash, setOpenHash] = useState<string | null>(null);
	const open = useMemo(
		() => (openHash === null ? null : (rows.find((r) => r.hash === openHash) ?? null)),
		[rows, openHash],
	);
	const filtered = useMemo(() => applyFilters(rows, filters), [rows, filters]);
	const docked = useMediaQuery(DOCK_QUERY);
	const close = useCallback(() => setOpenHash(null), []);
	const newestOf = summary?.truncated ? summary.rowCount : undefined;

	// Export what the operator is looking at — the filtered set, not the vault, and within the server's window: the
	// filename says both. BOM first: Excel reads UTF-8 CSV as latin-1 without it.
	function exportCsv(): void {
		const blob = new Blob([`﻿${toCsv(filtered)}`], { type: "text/csv;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = csvFilename(new Date(), isFiltering(filters), newestOf);
		a.click();
		URL.revokeObjectURL(url);
	}

	const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		const next = view === "audit" ? "trends" : "audit";
		setView(next);
		document.getElementById(`tab-${next}`)?.focus();
	};

	const count =
		filtered.length === rows.length
			? `${rows.length.toLocaleString()} ${rows.length === 1 ? "record" : "records"}`
			: `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()} records`;
	// An empty vault has nothing to select: the list takes the width.
	const dock = docked && view === "audit" && rows.length > 0;

	return (
		<div className="ut-app">
			<SummaryStrip summary={summary} live={live} />
			<main className="ut-work">
				<div className="ut-head">
					<div className="ut-seg" role="tablist" aria-label="View" onKeyDown={onTabKey}>
						{VIEWS.map((v) => (
							<button
								key={v.id}
								id={`tab-${v.id}`}
								type="button"
								role="tab"
								aria-selected={view === v.id}
								aria-controls={`panel-${v.id}`}
								tabIndex={view === v.id ? 0 : -1}
								onClick={() => setView(v.id)}
							>
								{v.label}
							</button>
						))}
					</div>
					<span className="ut-label">{count}</span>
					<span className="ut-grow" />
					<input
						type="search"
						className="ut-search"
						placeholder="Search id, actor, model, error…"
						aria-label="search the ledger"
						value={filters.search}
						onChange={(e) => setFilters({ ...filters, search: e.currentTarget.value })}
					/>
					<button
						type="button"
						className="ut-btn"
						onClick={exportCsv}
						disabled={filtered.length === 0}
						title={
							newestOf === undefined
								? "Download the records in view as CSV"
								: `Download the records in view as CSV: these are within the newest ${newestOf.toLocaleString()} events only`
						}
					>
						Export {filtered.length.toLocaleString()} {filtered.length === 1 ? "row" : "rows"}
					</button>
				</div>
				<FilterBar rows={rows} filters={filters} onChange={setFilters} />
				<div className="ut-body" data-docked={dock}>
					<section
						className="ut-pane"
						role="tabpanel"
						id={`panel-${view}`}
						aria-labelledby={`tab-${view}`}
					>
						{view === "audit" ? (
							<AuditTable
								rows={filtered}
								total={rows.length}
								phase={phase}
								chain={summary === null ? null : chainStatus(summary.chain)}
								liveIds={liveIds}
								selected={openHash}
								onOpen={(r: LedgerRow) => setOpenHash(r.hash)}
								onClearFilters={() => setFilters(EMPTY_FILTERS)}
							/>
						) : (
							<Trends rows={filtered} newestOf={newestOf} />
						)}
					</section>
					{dock &&
						(open ? (
							// Keyed by the row: another row's inspector starts clean.
							<RowPanel key={open.hash} row={open} docked onClose={close} />
						) : (
							<InspectorHint />
						))}
				</div>
			</main>
			{!dock && view === "audit" && open && (
				<RowPanel key={open.hash} row={open} docked={false} onClose={close} />
			)}
		</div>
	);
}
