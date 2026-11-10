// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import {
	type ChunkState,
	chunkGrow,
	chunkInit,
	chunkReveal,
	chunkSync,
	pageSizeForRows,
	pinAction,
	shownCount,
} from "../shared/list-chunk.js";
import { type BeforeWindow, pastHeldNote } from "../shared/list-view.js";
import { rowInSpan, stepRecord } from "../shared/peek.js";
import { providerOf } from "../shared/provider.js";
import { nextRowIndex, resolveActiveIndex, rowAccessibleName } from "../shared/row-nav.js";
import { type LedgerRow, type RowStatus, statusOf } from "../shared/rows.js";
import { statusWord, UNRESOLVED_TIP } from "../shared/status-word.js";

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
 * usage was measured, status, and its cost in dollars over a bar in proportion to the costliest record of the list.
 */
function DenseRowBody(props: { row: LedgerRow; maxCost: number | undefined }): React.JSX.Element {
	const { row } = props;
	const status = statusOf(row);
	const cost = costView(row);
	const provider = providerOf(row);
	const max = props.maxCost ?? 0;
	const share =
		row.costUt !== undefined && max > 0 ? Math.min(1, Math.max(0, row.costUt / max)) : 0;
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
				<span className="ut-lg-name">{row.model ?? NONE}</span>
			</span>
			<span className="ut-lg-a" title={`actor ${row.actor}`}>
				{compactActor(row.actor)}
			</span>
			<span className="ut-lg-k">{row.kind}</span>
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
				{share > 0 && (
					<i
						className="ut-lg-bar"
						style={{ width: `${(share * 100).toFixed(1)}%` }}
						aria-hidden="true"
					/>
				)}
				{/* A record with no cost shows the dash: an unknown cost is not $0. */}
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
	/** How many rows the list holds (it draws the first of them, and more as the reader scrolls). */
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
	/** The costliest record's cost, which this row's bar is drawn against. */
	maxCost?: number;
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
		>
			<DenseRowBody row={row} maxCost={props.maxCost} />
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

/** What the list has drawn: how many rows, and the open and pinned records it has already drawn down to. */
interface Drawn {
	chunk: ChunkState;
	selected: string | null;
	pinned: string | null;
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
	/** The hour a chart points at, as `[from, until)` in ms: its records are marked. */
	hourSpan?: readonly [number, number] | null;
	/** The position of the record a chart has pinned: it is marked, drawn, and scrolled to the middle once. */
	pinnedPos?: number | null;
	/** What the rows are a list of (the filters, as one string). A new key starts again at the first rows, at the top. */
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

	// Each bar is drawn against the costliest record of the whole list, drawn or not, so a bar never changes length
	// as more rows are drawn.
	const maxCost = useMemo(
		() => sorted.reduce((max, r) => Math.max(max, r.costUt ?? 0), 0),
		[sorted],
	);
	const selectedIndex = useMemo(
		() => (props.selected === null ? -1 : sorted.findIndex((r) => r.hash === props.selected)),
		[sorted, props.selected],
	);
	const pinnedPos = props.pinnedPos ?? null;
	const pinnedIndex = useMemo(
		() => (pinnedPos === null ? -1 : sorted.findIndex((r) => r.pos === pinnedPos)),
		[sorted, pinnedPos],
	);
	const pinnedHash = sorted[pinnedIndex]?.hash ?? null;

	// The list draws its first rows and more as the reader scrolls: every row is one height, so the rows not yet
	// drawn need no measuring. A new sort or a new set of filters is a new list, from its first rows.
	const key = `${props.resetKey ?? ""}|${sortKey}|${desc ? "desc" : "asc"}`;
	// The open record and the pinned one are drawn however deep they are. Each is brought in once, when it is first
	// in the list: a later sort starts again at the first rows and does not draw down to it again.
	const settle = (w: Drawn): Drawn => {
		let chunk = chunkSync(w.chunk, key, count);
		const mark = (done: string | null, hash: string | null, index: number): string | null => {
			if (hash === null || index < 0) return null;
			if (hash !== done) chunk = chunkReveal(chunk, index, count);
			return hash;
		};
		const selected = mark(w.selected, props.selected, selectedIndex);
		const pinned = mark(w.pinned, pinnedHash, pinnedIndex);
		return chunk === w.chunk && selected === w.selected && pinned === w.pinned
			? w
			: { chunk, selected, pinned };
	};
	const [held, setHeld] = useState<Drawn>(() =>
		settle({ chunk: chunkInit(key, count), selected: null, pinned: null }),
	);
	// Settled as it renders, not in an effect: the rows of a new list are never drawn at the old list's depth.
	const drawn = settle(held);
	if (drawn !== held) setHeld(drawn);
	const shown = shownCount(drawn.chunk, count);

	// A new list starts at the top. Not on the first draw, and not when a record arrives (the key is the same).
	const drawnKey = useRef(key);
	useEffect(() => {
		if (drawnKey.current === key) return;
		drawnKey.current = key;
		if (parentRef.current !== null) parentRef.current.scrollTop = 0;
	}, [key]);

	// One more set of rows when the mark after the last row comes near the screen. The observer is made again after
	// each growth, so a mark still in view asks again until the screen is full.
	const grow = (): void =>
		setHeld((w) => {
			const chunk = chunkGrow(w.chunk, count);
			return chunk === w.chunk ? w : { ...w, chunk };
		});
	const more = shown < count;
	const moreRef = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: made again when the rows drawn or held change
	useEffect(() => {
		const el = moreRef.current;
		if (!more || el === null || typeof IntersectionObserver === "undefined") return;
		const watch = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) grow();
			},
			{ root: null, rootMargin: "400px" },
		);
		watch.observe(el);
		return () => watch.disconnect();
	}, [more, shown, count]);
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

	// Bringing a row into view: its rows are drawn first (it may be past the rows drawn), and it is scrolled to once
	// they are in the page, after the commit.
	const [scrollTo, setScrollTo] = useState<{ hash: string; block: ScrollLogicalPosition } | null>(
		null,
	);
	const showRow = (index: number, block: ScrollLogicalPosition): void => {
		const target = sorted[index];
		if (target === undefined) return;
		setHeld((w) => {
			const chunk = chunkReveal(w.chunk, index, count);
			return chunk === w.chunk ? w : { ...w, chunk };
		});
		setScrollTo({ hash: target.hash, block });
	};
	useEffect(() => {
		if (scrollTo === null) return;
		document.getElementById(rowDomId(scrollTo.hash))?.scrollIntoView({ block: scrollTo.block });
	}, [scrollTo]);

	// The active row must be DRAWN to be named (aria-activedescendant) and shown. While the list holds focus, a sort,
	// filter or live insert that moves it brings it back into view.
	const listFocused = (): boolean =>
		parentRef.current !== null && document.activeElement === parentRef.current;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the active row's index or the rows change
	useEffect(() => {
		if (activeRow !== undefined && listFocused()) showRow(activeIndex, "nearest");
	}, [activeIndex, sorted]);
	// And when focus comes back by keyboard (Tab), the active row is scrolled in first. Only keyboard focus: a mouse
	// click also focuses the list, and scrolling under the pointer before its click lands would open another row.
	const onFocus = (e: React.FocusEvent<HTMLDivElement>): void => {
		if (e.target !== e.currentTarget || activeRow === undefined) return;
		if (e.currentTarget.matches(":focus-visible")) showRow(activeIndex, "nearest");
	};

	const moveTo = (index: number): void => {
		const target = sorted[index];
		if (target === undefined) return;
		setActiveHash(target.hash);
		showRow(index, "nearest");
	};

	// One click handler on the list, not one a row: the row clicked is found by its id.
	const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
		const id = (e.target as Element).closest('[role="option"]')?.id;
		if (id === undefined) return;
		const target = sorted.find((r) => rowDomId(r.hash) === id);
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
		// flows in it and is as tall as its rows), so a screenful is never more than the window's.
		const el = parentRef.current;
		const page = el ? pageSizeForRows(Math.min(el.clientHeight, window.innerHeight)) : 1;
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
				// names with aria-activedescendant; a row that is not drawn cannot be named, so none is.
				{...(state === "rows"
					? {
							role: "listbox",
							tabIndex: 0,
							"aria-label": "Audit records",
							"aria-activedescendant":
								activeRow !== undefined && activeIndex >= 0 && activeIndex < shown
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
					<div className="ut-lg-rows">
						{sorted.slice(0, shown).map((row, index) => (
							<AuditRow
								// The event hash, unique on the chain: an id can repeat, and duplicate keys drop or duplicate rows.
								key={row.hash}
								row={row}
								index={index}
								setSize={count}
								active={index === activeIndex}
								selected={props.selected === row.hash}
								fresh={props.liveIds?.has(row.hash) === true}
								hour={rowInSpan(row.ts, props.hourSpan ?? null)}
								pinned={index === pinnedIndex}
								maxCost={maxCost}
							/>
						))}
						{/* The mark the list watches: when it nears the screen, more rows are drawn. */}
						{shown < count && <div ref={moreRef} className="ut-lg-more" />}
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
