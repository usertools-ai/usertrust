// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type ChainStatus,
	costView,
	ESTIMATED_TITLE,
	type LoadPhase,
	listState,
	transferView,
} from "../shared/display.js";
import { type SortKey, sortRows } from "../shared/filters.js";
import { compactActor, formatUtc } from "../shared/format.js";
import { nextRowIndex, resolveActiveIndex, rowAccessibleName } from "../shared/row-nav.js";
import { type LedgerRow, type RowStatus, statusOf } from "../shared/rows.js";

const SORTS: Array<{ key: SortKey; label: string }> = [
	{ key: "seq", label: "Position" },
	{ key: "ts", label: "Time" },
	{ key: "costUt", label: "Cost" },
	{ key: "model", label: "Model" },
	{ key: "actor", label: "Actor" },
	{ key: "kind", label: "Kind" },
];

/**
 * Each status's badge tone. Settling is normal, not a celebration: neutral. Green is earned by verification only
 * (the integrity mark). A Record, so a new status cannot fall into another's colour unnoticed. An ungoverned call is
 * amber: it ran unmetered, which an operator should see.
 */
export const STATUS_TONE: Record<RowStatus, string | undefined> = {
	settled: undefined,
	released: "faint",
	failed: "stakes",
	denied: "stakes",
	ambiguous: "info",
	ungoverned: "info",
	// Ran and recorded, NOT charged: a money state of its own colour.
	unrecoverable: "alert",
	info: "faint",
	// Never settled's look: an unknown outcome must not read as a settled one.
	unknown: "unknown",
};

function Sep(): React.JSX.Element {
	return (
		<span className="d" aria-hidden="true">
			·
		</span>
	);
}

/** The DOM id of a row's element: what the list's `aria-activedescendant` names. */
export function rowDomId(hash: string): string {
	return `ut-row-${hash}`;
}

/** Rows a screenful holds, by the list's height: what PageUp and PageDown move by (one row of overlap is kept). */
const ROW_HEIGHT = 64;

function RowBody(props: { row: LedgerRow }): React.JSX.Element {
	const { row } = props;
	const status = statusOf(row);
	const cost = costView(row);
	const tx = transferView(row);
	return (
		<>
			<span className="ut-l">
				<span className="ut-line">
					<span className="ut-badge" data-tone={STATUS_TONE[status]}>
						<i aria-hidden="true" />
						{status}
					</span>
					<span className="ut-rtitle">{row.model ?? row.kind}</span>
				</span>
				<span className="ut-meta">
					{/* The description may be cut; the integrity mark after it never is (the banner says rows are marked). */}
					<span className="txt">
						<span className="m" title={row.ts}>
							{formatUtc(row.ts)}
						</span>
						<Sep />
						<span title={`actor ${row.actor}`}>{compactActor(row.actor)}</span>
						{row.model !== undefined && (
							<>
								<Sep />
								<span className="m">{row.kind}</span>
							</>
						)}
						<Sep />
						{tx.kind === "transfer" ? (
							<span className="m" title={`transfer ${tx.id}`}>
								tx {tx.id}
							</span>
						) : (
							<span className="none">no transfer</span>
						)}
					</span>
					<Sep />
					{row.integrity === "verified" ? (
						<span className="ok">✓ verified</span>
					) : (
						<span className="bad">⚠ after break</span>
					)}
				</span>
			</span>
			<span className="ut-fig">
				{cost === null ? (
					<span className="ut-amt na">no cost recorded</span>
				) : (
					<>
						<span className="ut-amt">{cost.ut}</span>
						<span className="ut-recd">
							{cost.estimated && (
								<span className="ut-est" title={ESTIMATED_TITLE}>
									est.
								</span>
							)}
							{cost.usd}
						</span>
					</>
				)}
			</span>
		</>
	);
}

/**
 * One row of the list. Not a tab stop and not focused itself: the list holds focus and names the active row, so the
 * virtualiser can unmount a row that scrolls away without dropping the keyboard's place. A listbox option, so its
 * name (what a screen reader says as the arrows move) is set whole, not read off the cells inside it.
 */
export function AuditRow(props: {
	row: LedgerRow;
	/** Position in the sorted list, 0-based. */
	index: number;
	/** How many rows the list holds (the virtualiser renders a window of them). */
	setSize: number;
	/** The row the arrow keys are on. */
	active: boolean;
	/** The row open in the inspector. */
	selected: boolean;
	fresh: boolean;
	style?: React.CSSProperties;
	measure?: (el: HTMLElement | null) => void;
	onClick(): void;
}): React.JSX.Element {
	const { row } = props;
	return (
		// biome-ignore lint/a11y/useFocusableInteractive: an option of a listbox that holds focus and names it (aria-activedescendant)
		// biome-ignore lint/a11y/useKeyWithClickEvents: the list's own onKeyDown opens the active row; the click is the mouse's route
		<div
			role="option"
			id={rowDomId(row.hash)}
			data-index={props.index}
			ref={props.measure}
			onClick={props.onClick}
			aria-selected={props.selected}
			aria-posinset={props.index + 1}
			aria-setsize={props.setSize}
			aria-label={rowAccessibleName(row)}
			className={`ut-row${props.selected ? " sel" : ""}${props.active ? " act" : ""}${props.fresh ? " fresh" : ""}`}
			style={props.style}
		>
			<RowBody row={row} />
		</div>
	);
}

function Empty(props: {
	state: Exclude<ReturnType<typeof listState>, "rows">;
	hidden: number;
	onClearFilters(): void;
}): React.JSX.Element {
	switch (props.state) {
		case "loading":
			return (
				<div className="ut-skel">
					<span className="sr-only">Loading the ledger…</span>
					{[0, 1, 2, 3, 4, 5].map((i) => (
						<span key={i} aria-hidden="true" />
					))}
				</div>
			);
		case "failed":
			return (
				<div className="ut-empty" role="status">
					<b>The ledger could not be loaded</b>
					The server did not answer. This view loads again when the live connection returns.
				</div>
			);
		case "first-run":
			return (
				<div className="ut-empty" role="status">
					<b>No governed calls yet</b>
					This vault has no events, and nothing is wrong with it. The ledger starts at the first
					governed call: wrap a client with <code>trust()</code>, make a call, and it appears here.
				</div>
			);
		case "no-rows":
			return (
				<div className="ut-empty" role="status">
					<b>No events to show</b>
					The vault failed verification: see the integrity failure above.
				</div>
			);
		case "filtered-out":
			return (
				<div className="ut-empty" role="status">
					<b>Nothing matches these filters</b>
					{props.hidden.toLocaleString()} {props.hidden === 1 ? "record is" : "records are"} hidden
					by them.
					<br />
					<button type="button" className="ut-ghost" onClick={props.onClearFilters}>
						Clear filters
					</button>
				</div>
			);
	}
}

export function AuditTable(props: {
	/** The rows in view, after the filters. */
	rows: LedgerRow[];
	/** Every row held, before the filters. */
	total: number;
	phase: LoadPhase;
	chain: ChainStatus | null;
	liveIds?: Set<string>;
	selected: string | null;
	/** `viaKeyboard`: opened with Enter or Space, so the inspector should take focus. A click leaves focus alone. */
	onOpen(row: LedgerRow, viaKeyboard: boolean): void;
	onClearFilters(): void;
	/** Set when the inspector closes and focus should go back to the row it showed; `n` makes a repeat count. */
	restoreFocus?: { hash: string; n: number } | null;
}): React.JSX.Element {
	const [sortKey, setSortKey] = useState<SortKey>("seq");
	const [desc, setDesc] = useState(true);
	const sorted = useMemo(() => sortRows(props.rows, sortKey, desc), [props.rows, sortKey, desc]);

	const parentRef = useRef<HTMLDivElement>(null);
	// Stable while the rows are: the virtualizer's measurement cache is keyed on this callback's identity, and a new one
	// each render (a scroll re-renders) re-scanned every row of a large vault.
	const getItemKey = useCallback((i: number) => (sorted[i] as LedgerRow).hash, [sorted]);
	const virtualizer = useVirtualizer({
		count: sorted.length,
		getScrollElement: () => parentRef.current,
		// Two-line rows; a narrow list stacks the cost under them, so each row is measured.
		estimateSize: () => 62,
		getItemKey,
		gap: 2,
		paddingStart: 8,
		paddingEnd: 24,
		overscan: 12,
	});

	// The row the arrow keys are on, by hash (an index would slide to another row when a live record arrives at the top).
	// Until a key or a click sets one: the open row, else the first.
	const [activeHash, setActiveHash] = useState<string | null>(null);
	const activeIndex = useMemo(
		() => resolveActiveIndex(sorted, activeHash, props.selected),
		[sorted, activeHash, props.selected],
	);
	const activeRow = sorted[activeIndex];

	// The active row must be RENDERED to be named (aria-activedescendant) and shown. While the list holds focus, a sort,
	// filter or live insert that moves it scrolls it back into the virtualiser's window.
	const listFocused = (): boolean =>
		parentRef.current !== null && document.activeElement === parentRef.current;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the active row's index or the rows change
	useEffect(() => {
		if (activeRow !== undefined && listFocused()) virtualizer.scrollToIndex(activeIndex);
	}, [activeIndex, sorted]);
	// And when focus comes back by keyboard (Tab), the active row is scrolled in first. Only keyboard focus: a mouse
	// click also focuses the list, and scrolling under the pointer before its click lands would open another row.
	const onFocus = (e: React.FocusEvent<HTMLDivElement>): void => {
		if (e.target !== e.currentTarget || activeRow === undefined) return;
		if (e.currentTarget.matches(":focus-visible")) virtualizer.scrollToIndex(activeIndex);
	};

	const moveTo = (index: number): void => {
		const row = sorted[index];
		if (row === undefined) return;
		setActiveHash(row.hash);
		virtualizer.scrollToIndex(index);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
		// Leave the browser's and the system's chords alone (Cmd+Home, Alt+Arrow).
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === "Enter" || e.key === " ") {
			// Opens the row the arrows are on: moving never opens it, so arrowing does not fire the inspector per key.
			if (activeRow === undefined) return;
			e.preventDefault();
			props.onOpen(activeRow, true);
			return;
		}
		const page = Math.max(1, Math.floor((parentRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
		const next = nextRowIndex(activeIndex, e.key, sorted.length, page);
		if (next === null) return;
		e.preventDefault();
		moveTo(next);
	};

	// Focus returns to the list, on the row the inspector showed, when the inspector closes.
	const restore = props.restoreFocus ?? null;
	// A request already held when this list mounted (the view was switched away and back) is old: not acted on.
	const handled = useRef(restore?.n);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per restore request (n), not per render
	useEffect(() => {
		if (restore === null || restore.n === handled.current) return;
		handled.current = restore.n;
		const i = sorted.findIndex((r) => r.hash === restore.hash);
		if (i >= 0) moveTo(i);
		parentRef.current?.focus({ preventScroll: true });
	}, [restore?.n]);

	const sortBy = (key: SortKey): void => {
		if (key === sortKey) setDesc(!desc);
		else {
			setSortKey(key);
			setDesc(true);
		}
	};

	const items = virtualizer.getVirtualItems();
	const state = listState({
		phase: props.phase,
		chain: props.chain,
		total: props.total,
		shown: sorted.length,
	});

	return (
		<>
			<div className="ut-cap">
				<span className="lead">Sort</span>
				{SORTS.map((s) => (
					<button
						key={s.key}
						type="button"
						aria-pressed={s.key === sortKey}
						onClick={() => sortBy(s.key)}
						title={
							s.key === sortKey
								? `sorted by ${s.label.toLowerCase()}, ${desc ? "descending" : "ascending"}`
								: `sort by ${s.label.toLowerCase()}`
						}
					>
						{s.label}
						{s.key === sortKey && <span aria-hidden="true">{desc ? " ↓" : " ↑"}</span>}
					</button>
				))}
			</div>
			<div
				ref={parentRef}
				className="ut-list"
				// The one tab stop of the list, and only when there are rows to move over. The rows are options the list
				// names with aria-activedescendant; a row the virtualiser has not rendered cannot be named, so none is.
				{...(state === "rows"
					? {
							role: "listbox",
							tabIndex: 0,
							"aria-label": "Audit records",
							"aria-activedescendant":
								activeRow !== undefined && items.some((v) => v.index === activeIndex)
									? rowDomId(activeRow.hash)
									: undefined,
							onKeyDown,
							onFocus,
						}
					: {})}
			>
				{state !== "rows" ? (
					<Empty
						state={state}
						hidden={props.total - sorted.length}
						onClearFilters={props.onClearFilters}
					/>
				) : (
					<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
						{items.map((item) => {
							const row = sorted[item.index] as LedgerRow;
							return (
								<AuditRow
									// The event hash, unique on the chain: an id can repeat, and duplicate keys drop or duplicate rows.
									key={row.hash}
									row={row}
									index={item.index}
									setSize={sorted.length}
									active={item.index === activeIndex}
									selected={props.selected === row.hash}
									fresh={props.liveIds?.has(row.hash) === true}
									measure={virtualizer.measureElement}
									onClick={() => {
										setActiveHash(row.hash);
										props.onOpen(row, false);
									}}
									style={{
										position: "absolute",
										top: 0,
										left: 8,
										right: 8,
										transform: `translateY(${item.start}px)`,
									}}
								/>
							);
						})}
					</div>
				)}
			</div>
			<div className="ut-foot">
				<span>
					{sorted.length === props.total
						? `${props.total.toLocaleString()} ${props.total === 1 ? "record" : "records"}`
						: `${sorted.length.toLocaleString()} of ${props.total.toLocaleString()} records`}
				</span>
				<span>times in UTC</span>
			</div>
		</>
	);
}
