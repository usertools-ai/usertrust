// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Ledger window: the dense list, and the open record. Over the list the record floats in glass; when the Ledger
 * fills the desk it docks in a column beside the list instead, so the list is never covered, and the rows show their
 * transaction and hash. The rows of the hour a chart points at are marked, or, with no chart hovering, the hour of
 * the pinned record.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hourSpanOf } from "../../../shared/hit.js";
import { budgetOf } from "../../../shared/peek.js";
import type { LedgerRow } from "../../../shared/rows.js";
import { AuditTable } from "../../audit-table.js";
import {
	setHoverMoment,
	useDeskData,
	useFilters,
	useHoverMoment,
	useOpenRecord,
	usePosition,
	useRange,
} from "../../desk/desk-state.js";
import { Window } from "../../desk/window.js";
import { RowPanel } from "../../row-panel.js";
import { resolvedPin } from "../spend/chart-data.js";
import { PeekActions, PeekExtra } from "./peek-extra.js";

const LedgerBody = memo(function LedgerBody(props: {
	filled: boolean;
	dimmed: boolean;
}): React.JSX.Element {
	const { filled, dimmed } = props;
	const { list, liveIds, held, pastNote, summary, resolvedPos } = useDeskData();
	const { filters, setFilters, clear } = useFilters();
	const { range } = useRange();
	const { openHash, setOpenHash, open } = useOpenRecord();
	const { at, setAt, shown } = usePosition();
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
	// Stable, so the memoized list does not re-render for a new callback on every answer.
	const openRow = useCallback(
		(r: LedgerRow, viaKeyboard: boolean) => {
			setOpenHash(r.hash);
			setKbOpen(viaKeyboard ? ++requests.current : undefined);
		},
		[setOpenHash],
	);
	// The panel's Up and Down: the list holds the order it draws, and steps through it.
	const stepRef = useRef<((dir: -1 | 1) => void) | null>(null);
	const step = useCallback((dir: -1 | 1) => stepRef.current?.(dir), []);

	// The hour to mark: a chart's hover first (the Ledger's own is not one), else the hour of the record shown in the
	// header, which is the pin.
	const hover = useHoverMoment("ledger");
	const pinAt = shown === null ? Number.NaN : Date.parse(shown.ts);
	const pinMs = Number.isFinite(pinAt) ? pinAt : null;
	// Kept while it is the same span, so the memoized list is not drawn again for a new array of the same hour.
	const hourSpan = useMemo(
		() => hover?.span ?? (pinMs === null ? null : hourSpanOf(pinMs)),
		[hover, pinMs],
	);

	// The record under the pointer, published as the Ledger's (the hover bus keeps one write a frame). Nothing is said
	// while the pointer is on no record, nor once the window has gone.
	const published = useRef(false);
	const onHover = useCallback((ms: number | null) => {
		if (ms === null) {
			if (!published.current) return;
			published.current = false;
			setHoverMoment({ ms: null, span: null, from: "ledger" });
			return;
		}
		published.current = true;
		setHoverMoment({ ms, span: hourSpanOf(ms), from: "ledger" });
	}, []);
	useEffect(
		// Unmounted: the other windows stop following a record that is no longer under the pointer.
		() => () => {
			if (published.current) setHoverMoment({ ms: null, span: null, from: "ledger" });
		},
		[],
	);

	// A new set of filters, or another position drawn, is a new list: it starts again at its first rows.
	const resetKey = `${JSON.stringify(filters)}|${list.at?.pos ?? "live"}`;
	// One fade of the data when the filters or the range change; none on the first draw. Two names in turn, so each
	// change starts the animation again.
	const fadeOn = `${JSON.stringify(filters)}|${range}`;
	const [fade, setFade] = useState({ on: fadeOn, n: 0 });
	if (fade.on !== fadeOn) setFade({ on: fadeOn, n: fade.n + 1 });

	// The record's lines read the vault at the position drawn (not the filtered view), and the budget at the header's.
	const extra =
		open === null ? null : (
			<PeekExtra row={open} rows={list.shownRows} budget={budgetOf(summary, shown)} />
		);
	const actions =
		open === null ? null : (
			<PeekActions row={open} filters={filters} onPin={setAt} onFilters={setFilters} />
		);

	return (
		<div
			className="ut-lg-body"
			data-fill={filled ? "ledger" : undefined}
			data-detail={filled ? open !== null : undefined}
			data-gen={fade.n === 0 ? undefined : fade.n % 2 === 1 ? "a" : "b"}
		>
			<div className="ut-lg-list">
				<AuditTable
					rows={list.filtered}
					total={list.total}
					phase={list.phase}
					chain={list.chain}
					beforeWindow={list.beforeWindow}
					reloading={list.reloading}
					reloadingNote={pastNote}
					liveIds={liveIds}
					selected={openHash}
					restoreFocus={restoreFocus}
					onOpen={openRow}
					onClearFilters={clear}
					hourSpan={hourSpan}
					pinnedPos={resolvedPin(at, resolvedPos)}
					resetKey={resetKey}
					onHover={onHover}
					stepRef={stepRef}
					full={filled}
				/>
			</div>
			{/* Keyed by the row: another row's panel starts clean. Filled, it docks in the second column. */}
			{filled && open !== null && (
				<RowPanel
					key={open.hash}
					docked
					past={list.at !== null}
					onStep={step}
					extra={extra}
					actions={actions}
					row={open}
					held={held}
					onClose={close}
					focusNonce={kbOpen}
					onFocusHandled={() => setKbOpen(undefined)}
				/>
			)}
			{/* Over the list. Not while another window fills the desk: this one is inert and hidden then, and a panel in it
			    would still take the keys. The record stays in the address, and its panel opens when the Ledger shows. */}
			{!filled && !dimmed && open !== null && (
				<RowPanel
					key={open.hash}
					docked
					inWindow
					past={list.at !== null}
					onStep={step}
					extra={extra}
					actions={actions}
					row={open}
					held={held}
					onClose={close}
					focusNonce={kbOpen}
					onFocusHandled={() => setKbOpen(undefined)}
				/>
			)}
		</div>
	);
});

export const LedgerWindow = memo(function LedgerWindow(): React.JSX.Element {
	return (
		<Window id="ledger" title="Ledger">
			{(filled, dimmed) => <LedgerBody filled={filled} dimmed={dimmed} />}
		</Window>
	);
});
