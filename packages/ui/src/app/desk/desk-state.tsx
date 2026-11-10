// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's state, published in two contexts: the data (per batch of records) and the view (per user action).
 * Windows read them through the hooks below; pointer movement never goes through either (it uses the hover bus).
 *
 * `DeskProvider` is what the page's root component used to be, moved and not rewritten: the one ledger, the one
 * address state, the one past position and the drawn list. The shapes are in desk-types.ts.
 */

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";
import { createCutter, pastRows } from "../../shared/asof.js";
import { AT_TIMEOUT_MS, pointLoading } from "../../shared/at-follow.js";
import type { Dimension } from "../../shared/breakdown.js";
import type { ColorMap } from "../../shared/colors.js";
import {
	deskWindow,
	orderFilters,
	removeFilterToken,
	selectedKeys,
} from "../../shared/desk-filters.js";
import { COMPACT_QUERY, isDimmed, type WindowId } from "../../shared/desk-layout.js";
import { EMPTY_FILTERS, isFiltering } from "../../shared/filters.js";
import { headerView } from "../../shared/header-view.js";
import { effectiveLevel } from "../../shared/level.js";
import {
	type HoldAnnouncement,
	heldNote,
	holdAnnouncement,
	type ListInput,
	levelRows,
	listView,
	pastHeldNote,
} from "../../shared/list-view.js";
import type { LedgerRow } from "../../shared/rows.js";
import { litState } from "../../shared/selection.js";
import type { RangeId } from "../../shared/spend-series.js";
import { useLedger } from "../store.js";
import { useAt } from "../use-at.js";
import { useNow } from "../use-now.js";
import { useUrlState } from "../use-url-state.js";
import type { DeskData, DeskView, ShellBinding } from "./desk-types.js";
import type { Peel, PeelState } from "./escape-peel.js";
import { loadTotals } from "./load-totals.js";
import { useMedia } from "./use-box-size.js";
import { computeBreakdown, memoOnce } from "./use-breakdown.js";
import { ColorBook, type TotalsOutcome } from "./use-colors.js";
import { useDeskMemory } from "./use-desk-memory.js";
import { useHoverCategory } from "./use-hover.js";

export type { DeskData, DeskView, ShellBinding } from "./desk-types.js";
export {
	setHoverCategory,
	setHoverMoment,
	useHoverCategory,
	useHoverMoment,
} from "./use-hover.js";

export const DeskDataContext = createContext<DeskData | null>(null);
export const DeskViewContext = createContext<DeskView | null>(null);
export const DeskShellContext = createContext<ShellBinding | null>(null);

/** The desk's data. Throws outside a provider, so a window rendered bare fails loudly, not with `undefined`. */
export function useDeskData(): DeskData {
	const v = useContext(DeskDataContext);
	if (v === null) throw new Error("useDeskData outside DeskProvider");
	return v;
}

function useDeskView(): DeskView {
	const v = useContext(DeskViewContext);
	if (v === null) throw new Error("useDeskView outside DeskProvider");
	return v;
}

/** What only the shell reads. Later windows do not use it. */
export function useShellBinding(): ShellBinding {
	const v = useContext(DeskShellContext);
	if (v === null) throw new Error("useShellBinding outside DeskProvider");
	return v;
}

/** The window that fills the desk, and the one way to change it: `toggle` fills a window, or restores it. */
export function useFill(): {
	fill: WindowId | null;
	setFill(id: WindowId | null): void;
	toggle(id: WindowId): void;
} {
	const { fill, setFill } = useDeskView();
	return useMemo(
		() => ({ fill, setFill, toggle: (id: WindowId) => setFill(fill === id ? null : id) }),
		[fill, setFill],
	);
}

/** The filters, and the ways to change them. `clear` writes the empty filter. */
export function useFilters(): {
	filters: DeskView["filters"];
	setFilters(f: DeskView["filters"]): void;
	clear(): void;
} {
	const { filters, setFilters } = useDeskView();
	return useMemo(
		() => ({ filters, setFilters, clear: () => setFilters(EMPTY_FILTERS) }),
		[filters, setFilters],
	);
}

/** The spend range the reader chose, and the window it makes. */
export function useRange(): {
	range: RangeId;
	setRange(r: RangeId): void;
	window: DeskData["window"];
} {
	const { range, setRange } = useDeskView();
	const { window } = useDeskData();
	return useMemo(() => ({ range, setRange, window }), [range, setRange, window]);
}

/** The dimension the reader chose, and the level the breakdown is taken at (which may differ). */
export function useDimension(): { dim: Dimension; setDim(d: Dimension): void; level: Dimension } {
	const { dim, setDim } = useDeskView();
	const { level } = useDeskData();
	return useMemo(() => ({ dim, setDim, level }), [dim, setDim, level]);
}

/** The open record, resolved from the rows shown by its event hash. */
export function useOpenRecord(): {
	openHash: string | null;
	setOpenHash(h: string | null): void;
	open: LedgerRow | null;
} {
	const { openHash, setOpenHash } = useDeskView();
	const { list } = useDeskData();
	// Resolved by hash, not held as a row: a `status` correction replaces the row object, and a panel holding the old
	// one kept showing the old status.
	const open = useMemo(
		() => (openHash === null ? null : (list.shownRows.find((r) => r.hash === openHash) ?? null)),
		[list.shownRows, openHash],
	);
	return useMemo(() => ({ openHash, setOpenHash, open }), [openHash, setOpenHash, open]);
}

/**
 * The position in the vault's history: the address's `#at`, and the Spend chart's pin. `shown` is the header's answer.
 * `preview` moves only the header, never the address. No window calls it now (the Spend chart's hover no longer
 * moves the header); it stays, with the header's own follower below, until a later desk part removes them.
 */
export function usePosition(): {
	at: number | null;
	setAt(p: number | null): void;
	preview(p: number | null): void;
	shown: DeskData["at"];
} {
	const { at, setAt, preview } = useDeskView();
	const { headAt: shown } = useDeskData();
	return useMemo(() => ({ at, setAt, preview, shown }), [at, setAt, preview, shown]);
}

/** The breakdown at the current level. Computed on the first read after a change, never for a tree that does not ask. */
export function useBreakdown(): ReturnType<DeskData["breakdown"]> {
	return useDeskData().breakdown();
}

/** The colours at the current level, fixed for the session. */
export function useColors(): ReturnType<DeskData["colors"]> {
	return useDeskData().colors();
}

/** The categories the filter holds at the current level: the selection is the filter, not a second store. */
export function useSelection(): { dim: Dimension; keys: ReadonlySet<string> } {
	const { filters } = useDeskView();
	const { level } = useDeskData();
	return useMemo(() => ({ dim: level, keys: selectedKeys(filters, level) }), [filters, level]);
}

/** How one category is lit: selected, hovered, dimmed because another is selected, or at rest. */
export function useLit(key: string): "selected" | "hover" | "dim" | "rest" {
	const selection = useSelection();
	const hover = useHoverCategory();
	return litState(selection, hover, key);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The colours of any dimension, read from the session's book: each map is built on its first read (observe the rows,
 * then `mapFor`) and the same instance comes back for the life of the lookup. The book already keeps one map per
 * dimension once the vault has loaded; the lookup keeps one before that too, so `colors()` and `colorsFor(level)`
 * are the same object even while the book still hands out throwaway maps.
 */
export function colorLookup(
	book: ColorBook,
	rows: readonly LedgerRow[],
	loaded: boolean,
	totals: TotalsOutcome,
): (dim: Dimension) => ColorMap {
	const read = new Map<Dimension, ColorMap>();
	return (dim) => {
		const have = read.get(dim);
		if (have !== undefined) return have;
		book.observe(dim, rows);
		const map = book.mapFor(dim, rows, loaded, totals);
		read.set(dim, map);
		return map;
	};
}

/**
 * Everything the page's root computed, moved here: the ledger, the address state, the past position and the list the
 * windows draw, published in the three contexts.
 */
export function DeskProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const { rows, summary, phase, live, liveIds, resyncs, rowsVault } = useLedger();
	// The view, filters, open record and position live in the page address (`location.hash`): a reload keeps them, a
	// link shares them.
	const { filters, setFilters, openHash, setOpenHash, at, setAt, navigation, addressNote } =
		useUrlState();
	// The layout (the window that fills the desk, the spend range, the split) lives in memory: a link does not carry it
	// and Back does not undo it.
	const { fill, setFill, range, setRange, dim, setDim } = useDeskMemory();
	// The past position shown (`#at=N`), from /api/at. Until its first answer lands, or when it fails with nothing loaded,
	// the screen stays live and the status under the header says so: a past view is only ever drawn from its own answer.
	const { view: atView } = useAt(at, summary, live, rows, resyncs, rowsVault, navigation);
	const shownAt = atView.at;
	// A preview moves the HEADER only (A6): its own follower asks for the previewed position, and the list, the rows
	// and every window keep reading `atView`, the committed position. A navigation drops a preview. Nothing asks for
	// one now.
	const [previewPos, setPreviewPos] = useState<number | null>(null);
	const preview = setPreviewPos;
	const { view: previewView } = useAt(
		previewPos,
		summary,
		live,
		rows,
		resyncs,
		rowsVault,
		navigation,
	);
	const header = useMemo(
		() => headerView(previewPos, atView, previewView),
		[previewPos, atView, previewView],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `navigation` is a trigger, not a value the effect reads
	useEffect(() => setPreviewPos(null), [navigation]);
	// The past view reads each row's status against the rows the page held when the answer's request was SENT
	// (`atView.rows`), not the rows held when the answer renders: a live `status` frame for a record after the
	// position, one the server had not seen when it answered, can arrive in between, and `statusAt` cannot correct it
	// (`rowsAsAnswered`). The rows are paired with the answer by the vault they come from (`pastRows`), whichever of a
	// reload's rows and answer lands first; while none of the answer's own vault is held, nothing is drawn and the
	// windows wait.
	const past = useMemo(
		() => pastRows(rows, rowsVault, atView, shownAt),
		[rows, rowsVault, atView, shownAt],
	);
	const pastHeld = past.kind === "held";
	const head = summary === null ? -1 : summary.chain.events - 1;
	// What the windows draw: ONE input, deferred, so a new position paints the header first and the rest follows when
	// there is time, never mixing one position's rows with another moment's phase or chain (`listView`). The rows are
	// cut at the position before the filters, so all of them see the vault then.
	const listInput = useMemo<ListInput>(
		() => ({ rows: past.rows, at: shownAt, filters, phase, summary, reloading: pastHeld }),
		[past.rows, shownAt, filters, phase, summary, pastHeld],
	);
	const drawn = useDeferredValue(listInput);
	// The list's own cut (`createCutter`): a past row keeps its identity from one draw to the next while its record and
	// its status there are unchanged, so a check's result held for it in the inspector survives an unrelated record.
	const [cutter] = useState(createCutter);
	const list = useMemo(() => listView(drawn, cutter), [drawn, cutter]);
	// The cut is made in a render React may throw away, so the cutter only stages it there: the draw on screen is kept
	// once React has committed it.
	useLayoutEffect(() => cutter.commit(list.shownRows), [cutter, list.shownRows]);
	const { shownRows, filtered } = list;
	// Whether what the windows draw shows another position than the header: until the deferred render lands (after
	// Back, Forward or a link). Those views are dimmed and busy meanwhile, and the status under the header says what is
	// coming. A past view whose vault's records are not held yet lags too.
	const pastNote = pastHeldNote(atView.reloaded);
	const holdNote = pastHeld ? pastNote : heldNote(list.at, shownAt);
	const held = holdNote !== null || pastHeld;
	// What a screen reader hears about it: once when the views start to lag, once when they catch up, never per answer.
	const [announce, setAnnounce] = useState<HoldAnnouncement>({ held: false, text: "" });
	useEffect(() => {
		setAnnounce((prev) => holdAnnouncement(prev, holdNote, shownAt));
	}, [holdNote, shownAt]);

	const nowMs = useNow();
	// The window comes from the DRAWN answer, so the rows and the window never come from two moments while a new
	// position lands.
	// It changes with the minute, not with every clock tick, so the breakdown below is not rebuilt for nothing.
	const minute = Math.floor(nowMs / 60_000);
	// biome-ignore lint/correctness/useExhaustiveDependencies: nowMs matters only through its minute
	const window = useMemo(() => deskWindow(range, list.at, nowMs), [range, list.at, minute]);
	// The level and the breakdown read the list as drawn: its rows under the filters it was drawn with, never the filters
	// just typed. Those reach the windows with the deferred render; read here, they cost a pass over every row inside
	// the render each keystroke makes, which nothing can split. The level's rows exclude the models filter
	// (`levelRows`), and the window lets the share window adapt a quiet range with one provider.
	const level = useMemo(
		() => effectiveLevel(dim, levelRows(list), window).dim,
		[dim, list, window],
	);
	const breakdown = useMemo(
		() => memoOnce(() => computeBreakdown(list.shownRows, list.filters, window, level)),
		[list, window, level],
	);
	const book = useState(() => new ColorBook())[0];
	// The whole-vault totals the colours rank by, asked for once when the desk mounts, alongside the ledger load. It
	// settles to the payload or to null (failed or timed out); the book is built when both it and the rows are in.
	const [totals, setTotals] = useState<TotalsOutcome>("pending");
	useEffect(() => {
		let cancelled = false;
		void loadTotals(globalThis.fetch, AT_TIMEOUT_MS).then((outcome) => {
			if (!cancelled) setTotals(outcome);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	// Any dimension's colours, each built on its first read; the level's are the same map, so a window that reads
	// `colors()` and one that reads `colorsFor(level)` paint a category alike.
	const colorsFor = useMemo(
		() => colorLookup(book, rows, phase === "loaded", totals),
		[book, rows, phase, totals],
	);
	const colors = useMemo(() => () => colorsFor(level), [colorsFor, level]);

	// The filters in the order they were added, so Escape can take the newest off first. Kept with the "set state while
	// rendering when it changed" pattern: the order is derived from the filters and what it was.
	const [order, setOrder] = useState<string[]>(() => orderFilters([], filters));
	const nextOrder = orderFilters(order, filters);
	if (!sameList(order, nextOrder)) setOrder(nextOrder);
	const newest = nextOrder.length === 0 ? null : (nextOrder[nextOrder.length - 1] as string);

	const data = useMemo<DeskData>(
		() => ({
			rows,
			list,
			summary,
			live,
			liveIds,
			at: shownAt,
			headAt: header.at,
			head,
			held,
			holdNote,
			pastHeld,
			pastNote,
			nowMs,
			window,
			level,
			breakdown,
			colors,
			colorsFor,
			filterOrder: order,
		}),
		[
			rows,
			list,
			summary,
			live,
			liveIds,
			shownAt,
			header.at,
			head,
			held,
			holdNote,
			pastHeld,
			pastNote,
			nowMs,
			window,
			level,
			breakdown,
			colors,
			colorsFor,
			order,
		],
	);
	const view = useMemo<DeskView>(
		() => ({
			filters,
			setFilters,
			range,
			setRange,
			dim,
			setDim,
			fill,
			setFill,
			openHash,
			setOpenHash,
			at,
			setAt,
			preview,
		}),
		[
			filters,
			setFilters,
			range,
			setRange,
			dim,
			setDim,
			fill,
			setFill,
			openHash,
			setOpenHash,
			at,
			setAt,
		],
	);

	const open = useMemo(
		() => (openHash === null ? null : (shownRows.find((r) => r.hash === openHash) ?? null)),
		[shownRows, openHash],
	);
	const goLive = useCallback(() => {
		setPreviewPos(null);
		setAt(null);
	}, [setAt]);
	// The record layer counts only while its panel is on screen. While another window fills the desk the Ledger is
	// hidden (`isDimmed`): Escape restores the fill first and the record's panel then opens, rather than closing a
	// record no one can see and leaving the fill.
	const compact = useMedia(COMPACT_QUERY, false);
	const peel = useMemo<PeelState>(
		() => ({
			recordOpen: open !== null && !isDimmed(fill, "ledger", compact),
			fill,
			pinned: at !== null,
			newestFilter: newest,
		}),
		[open, fill, compact, at, newest],
	);
	const act = useMemo<Record<Peel, () => void>>(
		() => ({
			record: () => setOpenHash(null),
			fill: () => setFill(null),
			pin: goLive,
			filter: () => {
				if (newest !== null) setFilters(removeFilterToken(filters, newest));
			},
		}),
		[setOpenHash, setFill, goLive, newest, filters, setFilters],
	);
	const newestOf = summary?.truncated ? summary.rowCount : undefined;
	const count =
		filtered.length === shownRows.length
			? `${shownRows.length.toLocaleString()} ${shownRows.length === 1 ? "record" : "records"}`
			: `${filtered.length.toLocaleString()} of ${shownRows.length.toLocaleString()} records`;
	const shell = useMemo<ShellBinding>(
		() => ({
			status: {
				error: header.error,
				loading: pointLoading(header),
				reloaded: header.reloaded,
				announce: announce.text,
			},
			goLive,
			filtering: isFiltering(drawn.filters),
			newestOf,
			count,
			addressNote,
			peel,
			act,
		}),
		[header, announce.text, goLive, drawn.filters, newestOf, count, addressNote, peel, act],
	);

	return (
		<DeskDataContext.Provider value={data}>
			<DeskViewContext.Provider value={view}>
				<DeskShellContext.Provider value={shell}>{children}</DeskShellContext.Provider>
			</DeskViewContext.Provider>
		</DeskDataContext.Provider>
	);
}
