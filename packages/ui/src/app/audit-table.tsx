// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useVirtualizer, useWindowVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	type ChainStatus,
	costView,
	ESTIMATED_TITLE,
	type LoadPhase,
	listState,
	transferView,
} from "../shared/display.js";
import { type SortKey, sortRows } from "../shared/filters.js";
import { compactActor, formatUtc, UT_KEY } from "../shared/format.js";
import { PHONE_QUERY } from "../shared/layout.js";
import { type BeforeWindow, pastHeldNote } from "../shared/list-view.js";
import {
	nextRowIndex,
	pageSizeFromItems,
	resolveActiveIndex,
	rowAccessibleName,
} from "../shared/row-nav.js";
import { type LedgerRow, type RowStatus, statusOf } from "../shared/rows.js";
import { useMediaQuery } from "./use-media-query.js";

const SORTS: Array<{ key: SortKey; label: string }> = [
	{ key: "seq", label: "Position" },
	{ key: "ts", label: "Time" },
	{ key: "costUt", label: "Cost" },
	{ key: "model", label: "Model" },
	{ key: "actor", label: "Actor" },
	{ key: "kind", label: "Kind" },
];

/**
 * Each status's badge tone. Settling is normal, not a celebration: neutral. Green is kept for the chain's integrity
 * (the integrity pills) and an anchored check. A Record, so a new status cannot fall into another's colour unnoticed.
 * An ungoverned call is amber: it ran unmetered, which an operator should see.
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
					{/* The description may be cut; an after-break mark after it never is (the banner says rows are marked). */}
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
					{/* No mark while the chain is intact: a tick on every row said nothing a reader could act on. */}
					{row.integrity === "after-break" && (
						<>
							<Sep />
							<span className="bad">⚠ after break</span>
						</>
					)}
				</span>
			</span>
			<span className="ut-fig">
				{cost === null ? (
					<span className="ut-amt na">no cost recorded</span>
				) : (
					<>
						<span className="ut-amt">{cost.usd}</span>
						<span className="ut-recd">
							{cost.estimated && (
								<span className="ut-est" title={ESTIMATED_TITLE}>
									est.
								</span>
							)}
							{cost.ut}
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

export type { BeforeWindow };

function Empty(props: {
	state: Exclude<ReturnType<typeof listState>, "rows">;
	/** What a reloading list says (`pastHeldNote`). */
	reloadingNote: string;
	hidden: number;
	before: BeforeWindow | null;
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
		case "before-window": {
			// Counted from 1, as the window note and the integrity texts count.
			const before = props.before;
			const upTo = (before?.upTo ?? 0) + 1;
			const counted = `The ${upTo.toLocaleString()} ${upTo === 1 ? "record" : "records"} up to this point count in the totals above.`;
			// Only a record the list holds is named as where it starts; otherwise (a resync gap, or no rows held yet) the
			// text says the records for this point are not held, and names no position.
			if (before?.kind !== "before")
				return (
					<div className="ut-empty" role="status">
						<b>No records are held for this point yet</b>
						{counted}
					</div>
				);
			return (
				<div className="ut-empty" role="status">
					<b>Before the first record the list holds</b>
					{`The list starts at position ${(before.firstHeld + 1).toLocaleString()}, the first record it holds. `}
					{counted}
				</div>
			);
		}
		case "reloading":
			// Plain text, not a status: the status under the header already announces it.
			return (
				<div className="ut-empty">
					<b>{props.reloadingNote}</b>
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

/** Memoized: the page re-renders on every answer, and the rows it draws (deferred) change only after it. */
export const AuditTable = memo(function AuditTable(props: {
	/** The rows in view, after the filters. */
	rows: LedgerRow[];
	/** Every row held, before the filters. */
	total: number;
	phase: LoadPhase;
	chain: ChainStatus | null;
	/** Set at a past position before the first row held: the list is empty because it starts later. */
	beforeWindow?: BeforeWindow | null;
	/** The records of the point's own vault are on their way: the list says so (`reloadingNote`), never that none are held. */
	reloading?: boolean;
	reloadingNote?: string;
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
	// On a phone the list has no scroller of its own: it flows in the page, so a swipe on it scrolls the page, and the
	// window is what the virtualizer follows. It then needs the list's distance from the top of the page, which moves
	// when anything above it changes height (the details, the filter chips), so it is re-measured as the page resizes.
	const phone = useMediaQuery(PHONE_QUERY);
	const [scrollMargin, setScrollMargin] = useState(0);
	// The sort bar sticks to the top of the window on a phone, over the rows that scroll under it: a row brought into view
	// by the keyboard is placed below it (scrollPaddingStart), and a screenful counts only the rows below it.
	const capRef = useRef<HTMLDivElement>(null);
	const [capH, setCapH] = useState(0);
	useLayoutEffect(() => {
		if (!phone) return;
		const measure = (): void => {
			const top = parentRef.current?.getBoundingClientRect().top;
			if (top !== undefined) setScrollMargin(Math.round(top + window.scrollY));
			setCapH(capRef.current?.offsetHeight ?? 0);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const watch = new ResizeObserver(measure);
		watch.observe(document.body);
		return () => watch.disconnect();
	}, [phone]);

	// Two-line rows; a narrow list stacks the cost under them, so each row is measured.
	const shared = {
		count: sorted.length,
		estimateSize: () => 62,
		getItemKey,
		gap: 2,
		paddingStart: 8,
		paddingEnd: 24,
		overscan: 12,
	};
	// Both hooks always run (hooks cannot be conditional); only the one in use observes anything.
	const inList = useVirtualizer<HTMLDivElement, Element>({
		...shared,
		enabled: !phone,
		getScrollElement: () => parentRef.current,
	});
	const inPage = useWindowVirtualizer<Element>({
		...shared,
		enabled: phone,
		scrollMargin,
		scrollPaddingStart: capH,
	});
	const virtualizer = phone ? inPage : inList;

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
		// A screenful by the rows the virtualiser has MEASURED, not an estimate: under 560px rows stack and wrap and are far
		// taller than a desktop row, so a fixed estimate made PageUp and PageDown skip rows.
		// On a phone the page is the scroller (the list flows in it), so the screenful is the window's, below the sticky
		// sort bar.
		const el = parentRef.current;
		const page = phone
			? pageSizeFromItems(
					virtualizer.getVirtualItems(),
					window.scrollY + capH,
					window.innerHeight - capH,
				)
			: el
				? pageSizeFromItems(virtualizer.getVirtualItems(), el.scrollTop, el.clientHeight)
				: 1;
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
		beforeWindow: (props.beforeWindow ?? null) !== null,
		reloading: props.reloading === true,
	});

	return (
		<>
			<div className="ut-cap" ref={capRef}>
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
						before={props.beforeWindow ?? null}
						reloadingNote={props.reloadingNote ?? pastHeldNote(false)}
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
										transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
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
				<span>{UT_KEY}</span>
				<span>times in UTC</span>
			</div>
		</>
	);
});

/** One ledger row's body as the list draws it, exported so its marks can be rendered in a test. */
export const Row = RowBody;
