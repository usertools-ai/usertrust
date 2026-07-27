// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useMemo, useState } from "react";
import { EMPTY_FILTERS, type FilterState, applyFilters } from "../shared/filters.js";
import type { LedgerRow } from "../shared/rows.js";
import { AuditTable } from "./audit-table.js";
import { FilterBar } from "./filter-bar.js";
import { RowPanel } from "./row-panel.js";
import { useLedger } from "./store.js";
import { SummaryStrip } from "./summary-strip.js";
import { Trends } from "./trends.js";

export type View = "audit" | "trends";

export function App(): React.JSX.Element {
	const { rows, summary, live } = useLedger();
	const [view, setView] = useState<View>("audit");
	const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
	const [open, setOpen] = useState<LedgerRow | null>(null);
	const filtered = useMemo(() => applyFilters(rows, filters), [rows, filters]);

	return (
		<div className="mx-auto flex h-screen max-w-[1400px] flex-col gap-3 p-4">
			<SummaryStrip summary={summary} live={live} />
			<nav className="flex gap-2">
				{(["audit", "trends"] as const).map((v) => (
					<button
						key={v}
						type="button"
						onClick={() => setView(v)}
						className={`rounded px-3 py-1 text-sm capitalize ${view === v ? "bg-[var(--panel)] text-[var(--text)]" : "text-[var(--muted)]"}`}
					>
						{v}
					</button>
				))}
			</nav>
			{view === "audit" ? (
				<>
					<FilterBar rows={rows} filters={filters} onChange={setFilters} />
					<AuditTable rows={filtered} onOpen={setOpen} />
				</>
			) : (
				<>
					<FilterBar rows={rows} filters={filters} onChange={setFilters} />
					<Trends rows={filtered} />
				</>
			)}
			{open && <RowPanel row={open} onClose={() => setOpen(null)} />}
		</div>
	);
}
