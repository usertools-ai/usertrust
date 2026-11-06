// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { csvFilename, toCsv } from "../shared/csv.js";
import { EMPTY_FILTERS, isFiltering } from "../shared/filters.js";
import {
	type HoldAnnouncement,
	heldInput,
	heldNote,
	holdAnnouncement,
	type ListInput,
	listView,
} from "../shared/list-view.js";
import type { LedgerRow } from "../shared/rows.js";
import { MAX_SEARCH_LENGTH, type ViewId } from "../shared/url-state.js";
import { AuditTable } from "./audit-table.js";
import { ExportButton } from "./export-button.js";
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
	// What the list, the facets, Trends and Export draw: ONE input, deferred, so a timeline drag paints the thumb, its
	// label and the header first and the rest follows when there is time, never mixing one position's rows with
	// another moment's phase or chain (`listView`). The rows are cut at the position before the filters, so all of them
	// see the vault then.
	const listInput = useMemo<ListInput>(
		() => ({ rows, at: shownAt, filters, phase, summary }),
		[rows, shownAt, filters, phase, summary],
	);
	// While a timeline drag is on, the list keeps the input it had when the drag began (`heldInput`): only the thumb,
	// its label and the header follow the drag, and the list renders once on release or after the drag sits still. The
	// input is frozen in the drag's own event (state, never a ref written while rendering), from the last committed one.
	const [frozen, setFrozen] = useState<ListInput | null>(null);
	const committed = useRef(listInput);
	useEffect(() => {
		committed.current = listInput;
	}, [listInput]);
	const onHold = useCallback((on: boolean) => setFrozen(on ? committed.current : null), []);
	const drawn = useDeferredValue(heldInput(frozen, listInput));
	const list = useMemo(() => listView(drawn), [drawn]);
	const { shownRows, filtered } = list;
	// Whether what the list's input draws (the list, the facets, Trends, the inspector, the count and Export) shows
	// another position than the header: during a drag, and after it until the deferred render lands (or after Live,
	// Back, Forward or a link). Those views are dimmed and busy meanwhile, and the timeline says what is coming.
	const holdNote = heldNote(list.at, shownAt);
	const held = holdNote !== null;
	// What a screen reader hears about it: once when the views start to lag, once when they catch up, never per answer.
	const [announce, setAnnounce] = useState<HoldAnnouncement>({ held: false, text: "" });
	useEffect(() => {
		setAnnounce((prev) => holdAnnouncement(prev, holdNote, shownAt));
	}, [holdNote, shownAt]);
	// The selected row's event HASH (unique on the chain, where an id can repeat), resolved from the rows shown: a
	// `status` correction replaces the row object, and a panel holding the old one kept showing the old status.
	const open = useMemo(
		() => (openHash === null ? null : (shownRows.find((r) => r.hash === openHash) ?? null)),
		[shownRows, openHash],
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
	// Stable, so the memoized list does not re-render for a new callback on every timeline answer.
	const openRow = useCallback(
		(r: LedgerRow, viaKeyboard: boolean) => {
			setOpenHash(r.hash);
			setKbOpen(viaKeyboard ? ++requests.current : undefined);
		},
		[setOpenHash],
	);
	const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), [setFilters]);
	const newestOf = summary?.truncated ? summary.rowCount : undefined;

	// Export what the operator is looking at — the filtered set, not the vault, and within the server's window: the
	// filename says both. BOM first: Excel reads UTF-8 CSV as latin-1 without it.
	function exportCsv(): void {
		const blob = new Blob([`\uFEFF${toCsv(filtered)}`], { type: "text/csv;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = csvFilename(new Date(), isFiltering(drawn.filters), newestOf, list.at);
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
					<span className="ut-label" role="status" data-held={held}>
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
					<ExportButton
						count={filtered.length}
						at={list.at}
						newestOf={newestOf}
						held={held}
						onExport={exportCsv}
					/>
				</div>
				<FilterBar rows={shownRows} filters={filters} onChange={setFilters} held={held} />
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
						data-held={held}
						aria-busy={held}
					>
						{view === "audit" ? (
							<AuditTable
								rows={list.filtered}
								total={list.total}
								phase={list.phase}
								chain={list.chain}
								beforeWindow={list.beforeWindow}
								liveIds={liveIds}
								selected={openHash}
								restoreFocus={restoreFocus}
								onOpen={openRow}
								onClearFilters={clearFilters}
							/>
						) : (
							<Trends rows={list.filtered} newestOf={newestOf} at={list.at} />
						)}
					</section>
					{dock &&
						(open ? (
							// Keyed by the row: another row's inspector starts clean.
							<RowPanel
								key={open.hash}
								row={open}
								docked
								held={held}
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
					committed={at}
					head={head}
					error={atView.error}
					reloaded={atView.reloaded}
					holdNote={holdNote}
					announce={announce.text}
					onPreview={preview}
					onHold={onHold}
					onCommit={setAt}
					onLive={() => {
						preview(null);
						setAt(null);
					}}
				/>
			)}
			{!dock && view === "audit" && open && (
				<RowPanel key={open.hash} row={open} docked={false} held={held} onClose={close} />
			)}
		</div>
	);
}
