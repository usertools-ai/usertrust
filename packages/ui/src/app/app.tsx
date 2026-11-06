// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { chainAt, cutRows } from "../shared/asof.js";
import { csvFilename, toCsv } from "../shared/csv.js";
import { chainStatus } from "../shared/display.js";
import { applyFilters, EMPTY_FILTERS, isFiltering } from "../shared/filters.js";
import type { LedgerRow } from "../shared/rows.js";
import { MAX_SEARCH_LENGTH, type ViewId } from "../shared/url-state.js";
import { AuditTable, type BeforeWindow } from "./audit-table.js";
import { FilterBar } from "./filter-bar.js";
import { InspectorHint, RowPanel } from "./row-panel.js";
import { useLedger } from "./store.js";
import { SummaryStrip } from "./summary-strip.js";
import { Timeline } from "./timeline.js";
import { Trends } from "./trends.js";
import { useAt } from "./use-at.js";
import { useMediaQuery } from "./use-media-query.js";
import { useUrlState } from "./use-url-state.js";

export type View = ViewId;

const VIEWS: Array<{ id: View; label: string }> = [
	{ id: "audit", label: "Audit" },
	{ id: "trends", label: "Trends" },
];

/** At this width the inspector docks beside the list; below it, it opens over the list. */
const DOCK_QUERY = "(min-width: 1100px)";

export function App(): React.JSX.Element {
	const { rows, summary, phase, live, liveIds } = useLedger();
	// The view, filters and open record live in the page address (`location.hash`): a reload keeps them, a link shares them.
	const { view, setView, filters, setFilters, openHash, setOpenHash, at, setAt, addressNote } =
		useUrlState();
	// The past position shown (`#at=N`, or a drag's preview before it is written there), from /api/at. Until its first
	// answer lands, or when it fails with nothing loaded, the screen stays live and the timeline says so: a past view is
	// only ever drawn from its own answer.
	const { view: atView, preview } = useAt(at, summary, live);
	const shownAt = atView.at;
	const head = summary === null ? -1 : summary.chain.events - 1;
	// The rows as recorded at the position: cut there, with the status each had there. Before the filters, so the
	// filters, the list, Trends and Export all see the vault then.
	const shownRows = useMemo(
		() => (shownAt === null ? rows : cutRows(rows, shownAt)),
		[rows, shownAt],
	);
	// The selected row's event HASH (unique on the chain, where an id can repeat), resolved from the rows shown: a
	// `status` correction replaces the row object, and a panel holding the old one kept showing the old status.
	const open = useMemo(
		() => (openHash === null ? null : (shownRows.find((r) => r.hash === openHash) ?? null)),
		[shownRows, openHash],
	);
	const filtered = useMemo(() => applyFilters(shownRows, filters), [shownRows, filters]);
	// What the list and Trends draw, as one value so they never mix two positions: deferred, so a scrub that lands a
	// new answer keeps the thumb and the header responsive while the list and the charts catch up. At a position the
	// list's chain is the position's (`chainAt`), never the live verdict, and a position before the first row held says
	// so instead of reading as a vault with no rows.
	const drawn = useDeferredValue(
		useMemo(
			() => ({
				filtered,
				total: shownRows.length,
				at: shownAt,
				chain:
					shownAt !== null
						? chainAt(shownAt)
						: summary === null
							? null
							: chainStatus(summary.chain),
				beforeWindow:
					shownAt !== null && shownAt.pos < shownAt.windowStartPos
						? ({ firstHeld: shownAt.windowStartPos, upTo: shownAt.pos } satisfies BeforeWindow)
						: null,
			}),
			[filtered, shownRows, shownAt, summary],
		),
	);
	const docked = useMediaQuery(DOCK_QUERY);
	// Enter or Space on a row asks the docked inspector to take focus; a click clears the request. The restore request
	// sends focus back to the row when the inspector closes. Each carries a counter so a repeat of the same row counts.
	const [kbOpen, setKbOpen] = useState<number | undefined>(undefined);
	const [restoreFocus, setRestoreFocus] = useState<{ hash: string; n: number } | null>(null);
	const requests = useRef(0);
	const close = useCallback(
		(returnFocus: boolean) => {
			if (returnFocus && openHash !== null)
				setRestoreFocus({ hash: openHash, n: ++requests.current });
			setOpenHash(null);
			setKbOpen(undefined);
		},
		[openHash, setOpenHash],
	);
	const newestOf = summary?.truncated ? summary.rowCount : undefined;

	// Export what the operator is looking at — the filtered set, not the vault, and within the server's window: the
	// filename says both. BOM first: Excel reads UTF-8 CSV as latin-1 without it.
	function exportCsv(): void {
		const blob = new Blob([`\uFEFF${toCsv(filtered)}`], { type: "text/csv;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = csvFilename(new Date(), isFiltering(filters), newestOf, shownAt);
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
		filtered.length === shownRows.length
			? `${shownRows.length.toLocaleString()} ${shownRows.length === 1 ? "record" : "records"}`
			: `${filtered.length.toLocaleString()} of ${shownRows.length.toLocaleString()} records`;
	// An empty vault has nothing to select: the list takes the width.
	const dock = docked && view === "audit" && shownRows.length > 0;

	return (
		<div className="ut-app">
			<SummaryStrip summary={summary} live={live} at={shownAt} />
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
					{/* A live region: a filter that changes how many rows are in view says so to a screen reader. */}
					<span className="ut-label" role="status">
						{count}
					</span>
					<span className="ut-grow" />
					<input
						type="search"
						className="ut-search"
						placeholder="Search id, actor, model, error…"
						aria-label="search the ledger"
						maxLength={MAX_SEARCH_LENGTH}
						value={filters.search}
						onChange={(e) => setFilters({ ...filters, search: e.currentTarget.value })}
					/>
					<button
						type="button"
						className="ut-btn"
						onClick={exportCsv}
						disabled={filtered.length === 0}
						title={
							shownAt !== null
								? `Download the records in view as CSV, as recorded at record ${(shownAt.pos + 1).toLocaleString()}`
								: newestOf === undefined
									? "Download the records in view as CSV"
									: `Download the records in view as CSV: these are within the newest ${newestOf.toLocaleString()} events only`
						}
					>
						Export {filtered.length.toLocaleString()} {filtered.length === 1 ? "row" : "rows"}
					</button>
				</div>
				<FilterBar rows={shownRows} filters={filters} onChange={setFilters} />
				{/* Never a link that opens something else: when the address does not describe this view, we say so. */}
				{addressNote === "cannot-hold" && (
					<div className="ut-notice ut-address-note" role="status">
						<b>Not kept in the address</b>
						This view is too long for a link, or its text has characters a link cannot carry. A
						reload or a copied link opens a clean page.
					</div>
				)}
				{addressNote === "behind" && (
					<div className="ut-notice ut-address-note" role="status">
						<b>Address not updated yet</b>
						The browser refused to update the address, so a reload or a copied link would still open
						the previous view. Trying again.
					</div>
				)}
				<div className="ut-body" data-docked={dock}>
					<section
						className="ut-pane"
						role="tabpanel"
						id={`panel-${view}`}
						aria-labelledby={`tab-${view}`}
					>
						{view === "audit" ? (
							<AuditTable
								rows={drawn.filtered}
								total={drawn.total}
								phase={phase}
								chain={drawn.chain}
								beforeWindow={drawn.beforeWindow}
								liveIds={liveIds}
								selected={openHash}
								restoreFocus={restoreFocus}
								onOpen={(r: LedgerRow, viaKeyboard: boolean) => {
									setOpenHash(r.hash);
									setKbOpen(viaKeyboard ? ++requests.current : undefined);
								}}
								onClearFilters={() => setFilters(EMPTY_FILTERS)}
							/>
						) : (
							<Trends rows={drawn.filtered} newestOf={newestOf} at={drawn.at} />
						)}
					</section>
					{dock &&
						(open ? (
							// Keyed by the row: another row's inspector starts clean.
							<RowPanel
								key={open.hash}
								row={open}
								docked
								onClose={close}
								focusNonce={kbOpen}
								onFocusHandled={() => setKbOpen(undefined)}
							/>
						) : (
							<InspectorHint />
						))}
				</div>
			</main>
			{/* Shown once the vault has records, and whenever a position is asked for (so Live is always reachable). */}
			{(head >= 0 || at !== null || atView.wanted !== null) && (
				<Timeline
					at={shownAt}
					wanted={atView.wanted}
					head={head}
					loading={atView.loading}
					error={atView.error}
					reloaded={atView.reloaded}
					onPreview={preview}
					onCommit={setAt}
					onLive={() => {
						preview(null);
						setAt(null);
					}}
				/>
			)}
			{!dock && view === "audit" && open && (
				<RowPanel key={open.hash} row={open} docked={false} onClose={close} />
			)}
		</div>
	);
}
