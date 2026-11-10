// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useVirtualizer, useWindowVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MUTED, PROVIDER_COLOR } from "../shared/colors.js";
import {
	type ChainStatus,
	costView,
	ESTIMATED_TITLE,
	type LoadPhase,
	listState,
	transferView,
	usageView,
} from "../shared/display.js";
import { type SortKey, sortRows } from "../shared/filters.js";
import { compactActor, formatUtc, UT_KEY } from "../shared/format.js";
import { hourSpanOf } from "../shared/hit.js";
import { PHONE_QUERY } from "../shared/layout.js";
import { DENSE_ROW_PX, pageSizeForRows, pinAction } from "../shared/list-chunk.js";
import { type BeforeWindow, pastHeldNote } from "../shared/list-view.js";
import { rowInSpan, stepRecord } from "../shared/peek.js";
import { providerOf } from "../shared/provider.js";
import { nextRowIndex, resolveActiveIndex, rowAccessibleName } from "../shared/row-nav.js";
import { type LedgerRow, type RowStatus, statusOf } from "../shared/rows.js";
import { statusWord, UNRESOLVED_TIP } from "../shared/status-word.js";
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

/** What a cell with nothing to show prints. */
const NONE = "—";

/**
 * One record on one line, in columns: time, model (with a short dash in its provider's colour), actor, kind, how its
 * usage was measured, status, and its cost in dollars.
 */
function DenseRowBody(props: { row: LedgerRow }): React.JSX.Element {
	const { row } = props;
	const status = statusOf(row);
	const cost = costView(row);
	const provider = providerOf(row);
	return (
		<>
			<span className="ut-lg-t" title={row.ts}>
				{formatUtc(row.ts)}
			</span>
			<span
				className="ut-lg-m"
				title={
					row.model === undefined
						? "no model"
						: provider === "Other"
							? row.model
							: `${row.model}, ${provider}`
				}
			>
				<i
					className="ut-lg-dash"
					style={{ background: provider === "Other" ? MUTED : PROVIDER_COLOR[provider] }}
					aria-hidden="true"
				/>
				{/* A record with no model is named by its kind. The kind has a cell of its own; a narrow list drops it, and
				    the sheet shows this in place of the dash exactly there. */}
				{row.model === undefined && <span className="ut-lg-kin">{row.kind}</span>}
				<span className="ut-lg-name">{row.model ?? NONE}</span>
			</span>
			<span className="ut-lg-a" title={`actor ${row.actor}`}>
				{compactActor(row.actor)}
			</span>
			<span className="ut-lg-k" title={row.kind}>
				{row.kind}
			</span>
			<span
				className="ut-lg-u"
				title={
					row.usageSource === "estimated"
						? ESTIMATED_TITLE
						: row.usageSource === "provider"
							? "usage as the provider reported it"
							: usageView(row).text
				}
			>
				{row.usageSource === "estimated"
					? "est."
					: row.usageSource === "provider"
						? "reported"
						: NONE}
			</span>
			<span className="ut-lg-s">
				<span
					className="ut-badge"
					data-tone={STATUS_TONE[status]}
					title={status === "ambiguous" ? UNRESOLVED_TIP : undefined}
				>
					<i aria-hidden="true" />
					{statusWord(status)}
				</span>
				{/* The badge may be cut short in a narrow cell; this mark after it never is. */}
				{row.integrity === "after-break" && (
					<span className="bad" title="after a break in the chain">
						{String.fromCharCode(0x26a0)}
					</span>
				)}
			</span>
			<span className="ut-lg-c">
				{/* A record with no cost shows the dash: an unknown cost is not $0. */}
				{/* The usage cell says a cost rests on estimated usage; a narrow list drops that cell, and the sheet shows
				    this mark exactly there. A figure that is an estimate never reads as an exact one. */}
				{cost?.estimated === true && (
					<span className="ut-lg-est" title={ESTIMATED_TITLE}>
						est.
					</span>
				)}
				<span className="ut-amt">{cost === null ? NONE : cost.usd}</span>
			</span>
		</>
	);
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
						{statusWord(status)}
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
 * One row of the list. Not a tab stop and not focused itself: the list holds focus and names the active row. A
 * listbox option, so its name (what a screen reader says as the arrows move) is set whole, not read off the cells
 * inside it. It takes no handler of its own: the list reads the mouse once for all its rows, and finds the row by
 * its id and its time by `data-ms`. Memoized: a list of thousands re-renders only the rows whose props changed.
 */
export const AuditRow = memo(function AuditRow(props: {
	row: LedgerRow;
	/** Position in the sorted list, 0-based. */
	index: number;
	/** How many rows the list holds (it draws only those near the screen). */
	setSize: number;
	/** The row the arrow keys are on. */
	active: boolean;
	/** The row open in the inspector. */
	selected: boolean;
	fresh: boolean;
	/** In the hour a chart points at. */
	hour?: boolean;
	/** The record a chart has pinned. */
	pinned?: boolean;
	/** How far down the list's one block this row stands, in px. */
	top: number;
}): React.JSX.Element {
	const { row } = props;
	const ms = Date.parse(row.ts);
	return (
		// biome-ignore lint/a11y/useFocusableInteractive: an option of a listbox that holds focus and names it (aria-activedescendant)
		<div
			role="option"
			id={rowDomId(row.hash)}
			data-ms={Number.isFinite(ms) ? ms : undefined}
			data-hour={props.hour === true ? "true" : undefined}
			data-pinned={props.pinned === true ? "true" : undefined}
			aria-selected={props.selected}
			aria-posinset={props.index + 1}
			aria-setsize={props.setSize}
			aria-label={rowAccessibleName(row)}
			className={`ut-row ut-lg-row${props.selected ? " sel" : ""}${props.active ? " act" : ""}${props.fresh ? " fresh" : ""}`}
			style={{ transform: `translateY(${props.top}px)` }}
		>
			<DenseRowBody row={row} />
		</div>
	);
});

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

/** Rows drawn past each edge of the screen: a list 1,400px tall draws 47 rows and these on either side. */
const OVERSCAN = 6;
/** The screen assumed until the list is measured (as it mounts): twenty rows. */
const FIRST_RECT = { width: 0, height: 20 * DENSE_ROW_PX };

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
	/** The hour a chart points at, as `[from, until)` in ms: its records are marked, in place of the pinned record's hour. */
	hourSpan?: readonly [number, number] | null;
	/** The position of the record a chart has pinned: it is marked with the records of its hour, and scrolled to the middle once. */
	pinnedPos?: number | null;
	/** What the rows are a list of (the filters, as one string). A new key starts again at the top; with none passed, a new set of filters does not. */
	resetKey?: string;
	/** The time (ms) of the record under the pointer, or null when the pointer is on none. Called only on a change. */
	onHover?(ms: number | null): void;
	/** Set, while the list is mounted, to a function that opens the record before (-1) or after (1) the open one. */
	stepRef?: React.RefObject<((dir: -1 | 1) => void) | null>;
}): React.JSX.Element {
	const [sortKey, setSortKey] = useState<SortKey>("seq");
	const [desc, setDesc] = useState(true);
	const sorted = useMemo(() => sortRows(props.rows, sortKey, desc), [props.rows, sortKey, desc]);
	const count = sorted.length;

	const parentRef = useRef<HTMLDivElement>(null);
	// Stable while the rows are: the virtualizer's cache is keyed on this callback's identity, and a new one each
	// render (a scroll re-renders) re-scanned every row of a large vault.
	const getItemKey = useCallback((i: number) => (sorted[i] as LedgerRow).hash, [sorted]);
	// On a phone the list has no scroller of its own: it flows in the page, so a swipe on it scrolls the page, and the
	// window is what the virtualizer follows. It then needs the list's distance from the top of the page, which moves
	// when anything above it changes height, so it is re-measured as the page resizes.
	const phone = useMediaQuery(PHONE_QUERY);
	const [scrollMargin, setScrollMargin] = useState(0);
	// The sort bar sticks to the top of the window on a phone, over the rows that scroll under it: a row brought into
	// view is placed below it (scrollPaddingStart), and a screenful counts only the rows below it.
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

	// Every row is one height, so none is measured: the rows stand in one block of that height times the row count,
	// and only those near the screen are drawn.
	const shared = {
		count,
		estimateSize: () => DENSE_ROW_PX,
		getItemKey,
		overscan: OVERSCAN,
		initialRect: FIRST_RECT,
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
	const items = virtualizer.getVirtualItems();

	const pinnedPos = props.pinnedPos ?? null;
	const pinnedIndex = useMemo(
		() => (pinnedPos === null ? -1 : sorted.findIndex((r) => r.pos === pinnedPos)),
		[sorted, pinnedPos],
	);
	const pinnedRow = sorted[pinnedIndex];
	const pinnedHash = pinnedRow?.hash ?? null;
	// The hour marked: the one a chart points at, else the pinned record's own.
	const pinnedMs = pinnedRow === undefined ? Number.NaN : Date.parse(pinnedRow.ts);
	const hour = useMemo(
		() => props.hourSpan ?? (Number.isFinite(pinnedMs) ? hourSpanOf(pinnedMs) : null),
		[props.hourSpan, pinnedMs],
	);

	// A new sort is a new list, from its top; so is a new set of filters, when the caller passes a new resetKey for it
	// (the list cannot tell otherwise). Not on the first draw, and not when a record arrives (the key is the same).
	const key = `${props.resetKey ?? ""}|${sortKey}|${desc ? "desc" : "asc"}`;
	const drawnKey = useRef(key);
	useEffect(() => {
		if (drawnKey.current === key) return;
		drawnKey.current = key;
		if (parentRef.current === null) return;
		parentRef.current.scrollTop = 0;
		// On a phone the page is the scroller: when the list's top is above the sort bar's bottom edge (the bar is
		// stuck over the rows), the page moves so the top sits just under it. Elsewhere the bar ends where the list
		// starts, and nothing moves.
		const under = capRef.current?.getBoundingClientRect().bottom ?? 0;
		const at = parentRef.current.getBoundingClientRect().top;
		if (at < under) window.scrollBy(0, at - under);
	}, [key]);

	// The row the arrow keys are on, by hash (an index would slide to another row when a live record arrives at the top).
	// Until a key or a click sets one: the open row, else the first.
	const [activeHash, setActiveHash] = useState<string | null>(null);
	const activeIndex = useMemo(
		() => resolveActiveIndex(sorted, activeHash, props.selected),
		[sorted, activeHash, props.selected],
	);
	const activeRow = sorted[activeIndex];
	// The active row follows the open record, so the keys of the inspector and of the list are on the same row.
	useEffect(() => {
		if (props.selected !== null) setActiveHash(props.selected);
	}, [props.selected]);

	// Bringing a row into view: the list scrolls to it, and the rows there are drawn.
	const showRow = (index: number, align: "auto" | "center"): void =>
		virtualizer.scrollToIndex(index, { align });

	// The active row must be DRAWN to be named (aria-activedescendant) and shown. While the list holds focus, a sort,
	// filter or live insert that moves it brings it back into view.
	const listFocused = (): boolean =>
		parentRef.current !== null && document.activeElement === parentRef.current;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the active row's index or the rows change
	useEffect(() => {
		if (activeRow !== undefined && listFocused()) showRow(activeIndex, "auto");
	}, [activeIndex, sorted]);
	// And when focus comes back by keyboard (Tab), the active row is scrolled in first. Only keyboard focus: a mouse
	// click also focuses the list, and scrolling under the pointer before its click lands would open another row.
	const onFocus = (e: React.FocusEvent<HTMLDivElement>): void => {
		if (e.target !== e.currentTarget || activeRow === undefined) return;
		if (e.currentTarget.matches(":focus-visible")) showRow(activeIndex, "auto");
	};

	const moveTo = (index: number): void => {
		const target = sorted[index];
		if (target === undefined) return;
		setActiveHash(target.hash);
		showRow(index, "auto");
	};

	// One click handler on the list, not one a row: the row clicked is found by its id, among the rows drawn.
	const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
		const id = (e.target as Element).closest('[role="option"]')?.id;
		if (id === undefined) return;
		const at = items.find((v) => rowDomId((sorted[v.index] as LedgerRow).hash) === id);
		const target = at === undefined ? undefined : sorted[at.index];
		if (target === undefined) return;
		setActiveHash(target.hash);
		props.onOpen(target, false);
	};

	// The pointer, read once on the list: the caller hears the time of the record under it, and only when it changes.
	const hovered = useRef<number | null>(null);
	const hoverTo = (ms: number | null): void => {
		if (ms === hovered.current) return;
		hovered.current = ms;
		props.onHover?.(ms);
	};
	const onPointerOver = (e: React.PointerEvent<HTMLDivElement>): void => {
		const at = (e.target as Element).closest<HTMLElement>("[data-ms]")?.dataset.ms;
		hoverTo(at === undefined ? null : Number(at));
	};
	const onPointerLeave = (): void => hoverTo(null);

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
		// A screenful is the rows that fit, every row being one height. On a phone the page is the scroller (the list
		// flows in it), so the screenful is the window's, below the sticky sort bar.
		const el = parentRef.current;
		const page = pageSizeForRows(phone ? window.innerHeight - capH : (el?.clientHeight ?? 0));
		const next = nextRowIndex(activeIndex, e.key, count, page);
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

	// The pinned record is made the active row and scrolled to the middle, once per pin: the reader may scroll away
	// from it afterwards and is left where they are.
	const pinDone = useRef<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: decided when the pin or the rows change, not per render
	useEffect(() => {
		const act = pinAction(pinDone.current, pinnedHash, sorted);
		pinDone.current = act.done;
		if (act.target === null) return;
		setActiveHash(act.target.hash);
		showRow(act.target.index, "center");
	}, [pinnedHash, sorted]);

	// The record before or after the open one, in the order drawn: what the inspector's own keys ask for. With no
	// record open it steps from the active row.
	const step = (dir: -1 | 1): void => {
		const from = props.selected ?? activeRow?.hash;
		if (from === undefined) return;
		const next = stepRecord(sorted, from, dir);
		if (next === null) return;
		const index = sorted.findIndex((r) => r.hash === next);
		const target = sorted[index];
		if (target === undefined) return;
		moveTo(index);
		props.onOpen(target, true);
	};
	const ref = props.stepRef;
	// Every render, so the caller always holds the step over the rows as they are now.
	useEffect(() => {
		if (ref === undefined) return;
		ref.current = step;
		return () => {
			ref.current = null;
		};
	});

	const sortBy = (key: SortKey): void => {
		if (key === sortKey) setDesc(!desc);
		else {
			setSortKey(key);
			setDesc(true);
		}
	};

	const state = listState({
		phase: props.phase,
		chain: props.chain,
		total: props.total,
		shown: count,
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
				// names with aria-activedescendant; a row that is not drawn cannot be named, so none is.
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
							onClick,
							onPointerOver,
							onPointerLeave,
						}
					: {})}
			>
				{state !== "rows" ? (
					<Empty
						state={state}
						hidden={props.total - count}
						before={props.beforeWindow ?? null}
						reloadingNote={props.reloadingNote ?? pastHeldNote(false)}
						onClearFilters={props.onClearFilters}
					/>
				) : (
					<div className="ut-lg-rows" style={{ height: virtualizer.getTotalSize() }}>
						{items.map((item) => {
							const row = sorted[item.index] as LedgerRow;
							return (
								<AuditRow
									// The event hash, unique on the chain: an id can repeat, and duplicate keys drop or duplicate rows.
									key={row.hash}
									row={row}
									index={item.index}
									setSize={count}
									active={item.index === activeIndex}
									selected={props.selected === row.hash}
									fresh={props.liveIds?.has(row.hash) === true}
									hour={rowInSpan(row.ts, hour)}
									pinned={item.index === pinnedIndex}
									top={item.start - virtualizer.options.scrollMargin}
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
