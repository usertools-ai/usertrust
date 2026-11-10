// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's shell: the page around the four windows. The top bar (glass: it is a control), the status under it, the
 * filters and the count, and the desk itself. Everything it shows comes from the desk's state; it keeps no state of its
 * own except what a screen needs: to hand focus back after a window fills the desk or is restored, and to fit the
 * desk's rows to the Now window.
 */

import { useEffect, useRef } from "react";
import { csvFilename, toCsv } from "../../shared/csv.js";
import { HOME_ROWS, type WindowId, windowOrder } from "../../shared/desk-layout.js";
import { PHONE_QUERY } from "../../shared/layout.js";
import { MAX_SEARCH_LENGTH } from "../../shared/url-state.js";
import { AtStatus } from "../at-status.js";
import { ExportButton } from "../export-button.js";
import { FilterBar } from "../filter-bar.js";
import { SummaryStrip } from "../summary-strip.js";
import { Backdrop } from "./backdrop.js";
import { useDeskData, useFill, useFilters, useShellBinding } from "./desk-state.js";
import { useEscapePeel } from "./escape-peel.js";
import { installGlass } from "./glass.js";
import { useMedia } from "./use-box-size.js";
import { useRowFit } from "./use-row-fit.js";
import { WINDOWS } from "./windows.js";

/** Each window's component by its id, for the order the screen shows them in (`windowOrder`). */
const WINDOW_BY_ID = new Map(WINDOWS.map((w) => [w.id, w.Component]));

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
	const { list, summary, live, headAt, held, holdNote, pastHeld } = useDeskData();
	const { filters, setFilters } = useFilters();
	const { fill } = useFill();
	const { status, filtering, newestOf, count, addressNote, peel, act } = useShellBinding();
	const { shownRows, filtered } = list;
	// On a phone the facts come before the list, which flows in the page to its end (`windowOrder`).
	const phone = useMedia(PHONE_QUERY, false);
	// The rows fit the Now window, so it never scrolls. They are measured before the first paint and kept while a
	// window fills the desk; where nothing can be measured the desk has the rows it is first painted with.
	const deskRef = useRef<HTMLElement>(null);
	const fit = useRowFit(deskRef, fill !== null);

	useEscapePeel(peel, act);
	useFocusAfterFill(fill);
	useEffect(() => {
		installGlass();
	}, []);

	// Export what the operator is looking at — the filtered set, not the vault, and within the server's window: the
	// filename says both. BOM first: Excel reads UTF-8 CSV as latin-1 without it.
	function exportCsv(): void {
		// Never a mix: while the records of the point's own vault are not held, nothing is written.
		if (pastHeld) return;
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
				<SummaryStrip part="bar" summary={summary} live={live} at={headAt} />
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
			<AtStatus
				error={status.error}
				loading={status.loading}
				reloaded={status.reloaded}
				holdNote={holdNote}
				announce={status.announce}
			/>
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
				{/* The bar draws the count between itself and the active chips, so the chips take a row of their own
				    below the bar and the count. A live region: a filter that changes how many rows are in view says so
				    to a screen reader. Every prop is a name, so the memoized bar is drawn again only when one changes. */}
				<FilterBar
					rows={shownRows}
					filters={filters}
					onChange={setFilters}
					held={held}
					count={count}
				/>
			</div>
			<main
				ref={deskRef}
				className="ut-dk-desk"
				data-filled={fill !== null}
				style={{ gridTemplateRows: fit ?? HOME_ROWS }}
			>
				{windowOrder(phone).map((id) => {
					const Component = WINDOW_BY_ID.get(id);
					return Component === undefined ? null : <Component key={id} />;
				})}
			</main>
		</div>
	);
}
