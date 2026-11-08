// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's shell: the page around the four windows. The top bar (glass: it is a control), the filters and the count,
 * the desk itself, and the timeline along the bottom. Everything it shows comes from the desk's state; it keeps no
 * state of its own except what a screen needs to hand focus back after a window fills the desk or is restored.
 */

import { useEffect, useRef } from "react";
import { csvFilename, toCsv } from "../../shared/csv.js";
import { HOME_ROWS, type WindowId } from "../../shared/desk-layout.js";
import { MAX_SEARCH_LENGTH } from "../../shared/url-state.js";
import { ExportButton } from "../export-button.js";
import { FilterBar } from "../filter-bar.js";
import { SummaryStrip } from "../summary-strip.js";
import { Timeline } from "../timeline.js";
import { Backdrop } from "./backdrop.js";
import { useDeskData, useFill, useFilters, useShellBinding } from "./desk-state.js";
import { useEscapePeel } from "./escape-peel.js";
import { installGlass } from "./glass.js";
import { WINDOWS } from "./windows.js";

/**
 * After a window fills the desk, or is restored, a reader who pressed a key to do it must not be left on the page:
 * when focus is on the body, or inside a window that has just turned inert, it moves to the fill button of the window
 * that took the desk (or, on restore, of the one that gave it back). The button stays mounted, so there is always one.
 */
function useFocusAfterFill(fill: WindowId | null): void {
	const last = useRef(fill);
	useEffect(() => {
		const from = last.current;
		last.current = fill;
		const id = fill ?? from;
		if (from === fill || id === null) return;
		const active = document.activeElement;
		const lost = active === null || active === document.body || active.closest("[inert]") !== null;
		if (!lost) return;
		document
			.querySelector<HTMLElement>(`[data-win="${id}"] .ut-win-fill`)
			?.focus({ preventScroll: true });
	}, [fill]);
}

export function DeskShell(): React.JSX.Element {
	const { list, summary, live, at: shownAt, head, held, holdNote } = useDeskData();
	const { filters, setFilters } = useFilters();
	const { fill } = useFill();
	const { timeline, goLive, filtering, newestOf, count, addressNote, peel, act } =
		useShellBinding();
	const {
		wanted,
		resolved,
		committed,
		navigation,
		error,
		reloaded,
		announce,
		onPreview,
		onHold,
		onCommit,
	} = timeline;
	const { shownRows, filtered } = list;

	useEscapePeel(peel, act);
	useFocusAfterFill(fill);
	useEffect(() => {
		installGlass();
	}, []);

	// Export what the operator is looking at — the filtered set, not the vault, and within the server's window: the
	// filename says both. BOM first: Excel reads UTF-8 CSV as latin-1 without it.
	function exportCsv(): void {
		const blob = new Blob([`\uFEFF${toCsv(filtered)}`], { type: "text/csv;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = csvFilename(new Date(), filtering, newestOf, list.at);
		a.click();
		URL.revokeObjectURL(url);
	}

	return (
		<div className="ut-dk">
			<Backdrop />
			<header className="ut-dk-top ut-glass">
				<SummaryStrip part="bar" summary={summary} live={live} at={shownAt} />
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
			</header>
			{/* Never a link that opens something else: when the address does not describe this view, we say so. */}
			{addressNote === "cannot-hold" && (
				<div className="ut-notice ut-address-note" role="status">
					<b>Not kept in the address</b>
					This view is too long for a link, or its text has characters a link cannot carry. A reload
					or a copied link opens a clean page.
				</div>
			)}
			{addressNote === "behind" && (
				<div className="ut-notice ut-address-note" role="status">
					<b>Address not updated yet</b>
					The browser refused to update the address, so a reload or a copied link would still open
					the previous view. Trying again.
				</div>
			)}
			<div className="ut-dk-filters">
				<FilterBar rows={shownRows} filters={filters} onChange={setFilters} held={held} />
				{/* A live region: a filter that changes how many rows are in view says so to a screen reader. */}
				<span className="ut-label" role="status" data-held={held}>
					{count}
				</span>
			</div>
			<main className="ut-dk-desk" style={{ gridTemplateRows: HOME_ROWS }}>
				{WINDOWS.map(({ id, Component }) => (
					<Component key={id} />
				))}
			</main>
			<Timeline
				at={shownAt}
				wanted={wanted}
				resolved={resolved}
				committed={committed}
				navigation={navigation}
				head={head}
				error={error}
				reloaded={reloaded}
				holdNote={holdNote}
				announce={announce}
				onPreview={onPreview}
				onHold={onHold}
				onCommit={onCommit}
				onLive={goLive}
			/>
		</div>
	);
}
