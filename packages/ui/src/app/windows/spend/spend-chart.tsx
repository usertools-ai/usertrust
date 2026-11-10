// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend chart: the static marks, a cursor that snaps to real records, the keys, the pin and the headline.
 *
 * The chart always runs to now; a pin is a marker inside it. The cursor is a small store, not React state: the model,
 * the scale, the drawn line and the layers' context are built once per rows, window, bucket, width and layers, and a
 * cursor move re-renders only the headline, the crosshair, the slider's attributes and whatever reads the store, never
 * the marks. Every figure is read from exact records (`cum`, the model's buckets), never from the drawn curve.
 */

import {
	type KeyboardEvent,
	memo,
	type PointerEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import type { AtPayload } from "../../../shared/api.js";
import type { SpendWindow } from "../../../shared/breakdown.js";
import {
	breakRecord,
	indexAtPos,
	inWindow,
	lastAtOrBefore,
	type SpendRecords,
	totalAtPos,
} from "../../../shared/cumulative.js";
import {
	type CursorStore,
	type CursorValue,
	createCursorStore,
} from "../../../shared/cursor-store.js";
import { formatUsd, formatUsdTotal } from "../../../shared/format.js";
import {
	hourSpanOf,
	msToX,
	nearestIndex,
	shouldCapture,
	shouldTrack,
	snapPx,
	xToMs,
} from "../../../shared/hit.js";
import type { LedgerRow } from "../../../shared/rows.js";
import { buildSpendModel, type LineBucket, type SpendModel } from "../../../shared/spend-model.js";
import {
	bucketCenterMs,
	type DrawnSeries,
	drawSeries,
	type Geometry,
	geometry,
} from "../../../shared/spend-scale.js";
import type { RangeId } from "../../../shared/spend-series.js";
import { newSince } from "../../../shared/timeline-view.js";
import { setHoverMoment, useHoverMoment } from "../../desk/desk-state.js";
import { useBoxSize } from "../../desk/use-box-size.js";
import { ChartFrame } from "./chart-frame.js";
import {
	bucketOf as bucketAt,
	cursorResetKey,
	drawnCursor,
	escapeTarget,
	frameKey,
	isLiveCursor,
	keyAction,
	keyMove,
	movedTime,
	reconcileCursor,
	stepBucket,
	toggleTarget,
} from "./chart-keys.js";
import {
	brokenFrom,
	headLabel,
	newText,
	plotLabel,
	stamp,
	subLine,
	valueText,
	whenLine,
} from "./chart-text.js";
import { buildCtx, dispatchKey, resolveScale } from "./ctx.js";
import { type ChartCtx, LAYERS, RING_SELECTOR, type SpendLayer } from "./layers.js";

export interface SpendChartProps {
	/** Fully filtered, in position order. */
	rows: readonly LedgerRow[];
	win: SpendWindow;
	/** Whole-vault spend at the rows' end; null when any spend record was filtered away. */
	totalUt: number | null;
	/** Some record was filtered away. */
	filtered: boolean;
	/** The server holds older records than the page does. */
	truncated: boolean;
	/** The pinned position, or null for live. */
	pinnedPos: number | null;
	/** The answer for the pinned position, for the count of records added since it was chosen. */
	at: AtPayload | null;
	/** The vault's last position; -1 before a summary. */
	head: number;
	/** The category tint, else null (the sheet's default). */
	ink: string | null;
	/** The unfiltered rows under a filter, else null: the scale and the faint all-spend line. */
	allRows: readonly LedgerRow[] | null;
	/** The words that say what the faint line is, under a filter. */
	filterNote: string | null;
	/** The moment of the record open in the Ledger's panel, ms, for its ring. */
	markMs: number | null;
	/** The vault position of the first record that breaks the chain, for the dashed line and its ring. */
	breakPos: number | null;
	/** The window is animating its size: keep the last settled width. */
	settling: boolean;
	layers?: readonly SpendLayer[];
	/** The range drawn: a change of it clears a live cursor, since two ranges can share a bucket size. */
	range: RangeId;
	/** The line's bucket for the range: the model's bucket and the words' unit. */
	bucket: LineBucket;
	/** The filters the rows were drawn with, as one string: a change fades the marks in again. */
	filterKey: string;
	/** Drawn at the right of the headline row, after the Now button. */
	controls?: ReactNode;
	onPin(pos: number | null): void;
	/** Moves the page header to a position while the line is read, without moving the list. */
	onPreview(pos: number | null): void;
}

const SELF = "spend";
const NO_BOX = { w: 0, h: 0 };
const DOT_HALF = 4.5;

type Span = { i0: number; i1: number };

const inSpan = (i: number, s: Span): boolean => i >= 0 && i >= s.i0 && i <= s.i1;
const finiteOr = (v: number, d: number): number => (Number.isFinite(v) ? v : d);

/** The point on the drawn line at plot x; the base when the line has no point there. */
function onLine(series: DrawnSeries, geo: Geometry, x: number): { x: number; y: number } {
	return { x, y: finiteOr(series.curve.at(x), geo.baseY) };
}

/** Bucket of a time on this model's line. */
function bucketOf(t: number, win: SpendWindow, m: SpendModel): number {
	return bucketAt(t, win.startMs, m.bucketMs, m.values.length);
}

/** The last spend record in bucket `k`, or the record nearest its centre when it has none; -1 with no record. */
function recordInBucket(k: number, win: SpendWindow, m: SpendModel): number {
	const { span, records } = m;
	if (span.i1 < span.i0) return -1;
	const a = win.startMs + k * m.bucketMs;
	const b = Math.min(win.endMs, a + m.bucketMs);
	const own = inWindow(records, { startMs: a, endMs: b });
	if (own.i1 >= own.i0) return own.i1;
	const centre = bucketCenterMs(k, win, m.bucketMs);
	return span.i0 + nearestIndex(records.t.subarray(span.i0, span.i1 + 1), centre);
}

/** Spend at rest: what was spent before the rows held plus every spend row, whether its time reads or not. */
function restSpend(records: SpendRecords): number {
	return records.total;
}

/**
 * The crosshair's x as drawn. It is the target x for now; the glide toward a far point is filled in here, so the
 * render reads one value whichever way it moves.
 */
function useGlide(x: number | null): number | null {
	return x;
}

/**
 * The path a range switch tweens between. For now the new line is drawn at once and nothing is morphing; the tween
 * is filled in here, so the frame and the peak label read one answer.
 */
function useRangeMorph(series: DrawnSeries): { series: DrawnSeries; morphing: boolean } {
	return { series, morphing: false };
}

/**
 * The headline's figure. A visually hidden span holds exactly the final value, which is what assistive tech and the
 * tests read; the visible figure beside it is hidden from them. For now the figure is written straight in; counting
 * up while live is filled in here.
 */
function HeadlineFigure(props: { ut: number; live: boolean }): React.JSX.Element {
	const text = formatUsdTotal(props.ut);
	return (
		<>
			<span
				className="ut-tick"
				aria-hidden="true"
				style={{ minWidth: `min(${text.length}ch, 100%)` }}
			>
				{text}
			</span>
			<span className="sr-only">{text}</span>
		</>
	);
}

interface Latest {
	model: SpendModel;
	win: SpendWindow;
	w: number;
	fallback: CursorValue | null;
	pinnedPos: number | null;
	layers: readonly SpendLayer[];
	ctx: ChartCtx;
	onPin(pos: number | null): void;
	onPreview(pos: number | null): void;
}

export const SpendChart = memo(function SpendChart(p: SpendChartProps): React.JSX.Element {
	const { rows, win, totalUt, filtered, truncated, pinnedPos, ink, settling, bucket } = p;
	const layers = p.layers ?? LAYERS;

	const storeRef = useRef<CursorStore | null>(null);
	if (storeRef.current === null) storeRef.current = createCursorStore();
	const store = storeRef.current;

	// Size: the plot's own box; while the window animates, the last settled one, so a fill does not redraw per frame.
	const plotRef = useRef<HTMLDivElement | null>(null);
	const box = useBoxSize(plotRef);
	const settled = useRef(NO_BOX);
	if (!settling) settled.current = box;
	const { w, h } = settled.current;

	const { startMs, endMs } = win;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the window's ends, not its object identity
	const model = useMemo(
		() => buildSpendModel(rows, win, bucket, totalUt),
		[rows, startMs, endMs, bucket, totalUt],
	);
	// Under a filter the scale is all spend's, so a filtered line is never drawn on a scale that flatters it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the window's ends, not its object identity
	const allModel = useMemo(
		() => (p.allRows === null ? null : buildSpendModel(p.allRows, win, bucket, null)),
		[p.allRows, startMs, endMs, bucket],
	);
	const scaleOf = allModel ?? model;
	const scale = useMemo(
		() => resolveScale(layers, scaleOf.rates, scaleOf.drawnPeak),
		[layers, scaleOf],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the window's ends, not its object identity
	const geo = useMemo(
		() =>
			geometry({
				w,
				h,
				win,
				bucketMs: model.bucketMs,
				peakRate: scaleOf.drawnPeak,
				knee: scale.knee,
			}),
		[w, h, startMs, endMs, model.bucketMs, scaleOf, scale],
	);
	const drawn = useMemo(() => drawSeries(geo, model.drawn), [geo, model]);
	const { series } = useRangeMorph(drawn);
	const ghost = useMemo(
		() => (allModel === null ? null : drawSeries(geo, allModel.drawn).d),
		[geo, allModel],
	);

	// Handlers and the stable `moveTo` read the newest values from here.
	const latest = useRef<Latest | null>(null);
	const published = useRef(false);
	const raf = useRef(0);
	const previewRaf = useRef(0);
	const previewing = useRef(false);
	const point = useRef<{ x: number; y: number } | null>(null);
	const rect = useRef<DOMRect | null>(null);
	const dpr = useRef(1);
	const touchDown = useRef(false);

	/** Publish the moment under the cursor, or that there is none any more (only when this chart published one). */
	const publish = (ms: number | null): void => {
		if (ms === null) {
			if (!published.current) return;
			published.current = false;
			setHoverMoment({ ms: null, span: null, from: SELF });
			return;
		}
		published.current = true;
		setHoverMoment({ ms, span: hourSpanOf(ms), from: SELF });
	};
	const publishRef = useRef(publish);
	publishRef.current = publish;

	/** The header follows the record read, at most once a frame; the newest position wins. */
	const pendingPreview = useRef<number | null>(null);
	const preview = (pos: number | null): void => {
		pendingPreview.current = pos;
		previewing.current = true;
		if (previewRaf.current !== 0) return;
		if (typeof requestAnimationFrame !== "function") {
			latest.current?.onPreview(pos);
			return;
		}
		previewRaf.current = requestAnimationFrame(() => {
			previewRaf.current = 0;
			latest.current?.onPreview(pendingPreview.current);
		});
	};
	/** The header back to what is pinned (or live), at once: a pending preview must not land after it. */
	const unpreview = (): void => {
		if (previewRaf.current !== 0 && typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(previewRaf.current);
		}
		previewRaf.current = 0;
		previewing.current = false;
		const L = latest.current;
		L?.onPreview(L.pinnedPos);
	};
	const previewRef = useRef({ preview, unpreview });
	previewRef.current = { preview, unpreview };

	/** Put the live cursor on record `i`, in bucket `k` (the record's own unless a bucket step chose another). */
	const setLive = (i: number, via: "pointer" | "key", k?: number): void => {
		const L = latest.current;
		if (L === null || !inSpan(i, L.model.span)) return;
		const t = L.model.records.t[i] as number;
		const prev = store.get();
		store.set({ k: k ?? bucketOf(t, L.win, L.model), via, i });
		if (!(isLiveCursor(prev) && prev.i === i)) {
			publishRef.current(t);
			previewRef.current.preview(L.model.records.pos[i] as number);
		}
	};
	/** Drop the live cursor: what is drawn falls back to another window's moment or the pin. */
	const clearLive = (): void => {
		if (!isLiveCursor(store.get())) return;
		store.set(latest.current?.fallback ?? null);
		publishRef.current(null);
		previewRef.current.unpreview();
	};
	const setLiveRef = useRef(setLive);
	setLiveRef.current = setLive;

	const moveTo = useMemo(
		() =>
			(k: number): void => {
				const L = latest.current;
				if (L === null) return;
				const kk = stepBucket(k, 0, L.model.values.length);
				if (kk < 0) return;
				const i = recordInBucket(kk, L.win, L.model);
				if (i >= 0) setLiveRef.current(i, "key", kk);
			},
		[],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the window's ends, not its object identity
	const ctx = useMemo(
		() => buildCtx({ geo, series, model, rows, win, cursor: store, moveTo }),
		[geo, series, model, rows, startMs, endMs, store, moveTo],
	);

	const { records, span } = model;
	const M = span.i1 >= span.i0 ? span.i1 - span.i0 + 1 : 0;
	const pinned = pinnedPos !== null;
	const pinIdx = pinnedPos === null ? -1 : indexAtPos(records, pinnedPos);
	const pinInRange = pinned && inSpan(pinIdx, span);

	// Another window's moment, inside this window: a synced crosshair only.
	const other = useHoverMoment(SELF);
	const sync = useMemo((): CursorValue | null => {
		if (other === null || !(other.ms >= win.startMs && other.ms < win.endMs)) return null;
		const at = lastAtOrBefore(records, other.ms);
		const i = inSpan(at, span) ? at : -1;
		return {
			k: bucketOf(i >= 0 ? (records.t[i] as number) : other.ms, win, model),
			via: "sync",
			i,
		};
	}, [other, win, records, span, model]);
	const pin = useMemo(
		(): CursorValue | null =>
			pinInRange
				? { k: bucketOf(records.t[pinIdx] as number, win, model), via: "pin", i: pinIdx }
				: null,
		[pinInRange, pinIdx, records, win, model],
	);
	const fallback = drawnCursor(null, sync, pin);

	latest.current = {
		model,
		win,
		w,
		fallback,
		pinnedPos,
		layers,
		ctx,
		onPin: p.onPin,
		onPreview: p.onPreview,
	};

	// What is drawn: a live cursor still inside this model's records, else the fallback.
	const stored = useSyncExternalStore(store.subscribe, store.get, () => null);
	const live = isLiveCursor(stored) && inSpan(stored.i, span) ? stored : null;

	// The store holds what is drawn, for the layers: the fallback whenever there is no live cursor.
	useLayoutEffect(() => {
		store.set(drawnCursor(store.get(), sync, pin));
	}, [store, sync, pin]);

	// A range or filter change: no live cursor survives it, and no window keeps following this one.
	const resetKey = cursorResetKey(p.range, bucket.ms, p.filterKey);
	const firstReset = useRef(resetKey);
	useEffect(() => {
		if (firstReset.current === resetKey) return;
		firstReset.current = resetKey;
		if (isLiveCursor(store.get())) {
			store.set(latest.current?.fallback ?? null);
			previewRef.current.unpreview();
		}
		publishRef.current(null);
	}, [resetKey, store]);

	// A new model (a live append, a filter, a later window): keep the live cursor on its record, in that record's bucket
	// on the new line, or drop it, and the header's preview with it, when the record is gone.
	const prevModel = useRef(model);
	const prevWin = useRef(win);
	useLayoutEffect(() => {
		const was = prevModel.current;
		const wasWin = prevWin.current;
		prevModel.current = model;
		prevWin.current = win;
		if (was === model) return;
		const v = store.get();
		if (!isLiveCursor(v)) return;
		const next = reconcileCursor(v, was.records.pos[v.i], {
			records: model.records,
			span: model.span,
			bucketOf: (t) => bucketOf(t, win, model),
			key: {
				prevStartMs: wasWin.startMs + v.k * was.bucketMs,
				startMs: win.startMs,
				bucketMs: model.bucketMs,
				recordIn: (k) => recordInBucket(k, win, model),
			},
		});
		if (next !== null) {
			store.set(next);
			// A running maximum can move a surviving record's time when a filter drops an earlier row: say so.
			const moved = movedTime(was.records.t[v.i], model.records.t[next.i]);
			if (moved !== null) publishRef.current(moved);
			return;
		}
		store.set(latest.current?.fallback ?? null);
		publishRef.current(null);
		previewRef.current.unpreview();
	}, [store, model, win]);

	// The plot's place on the page, read when it can have moved, never inside the pointer frame.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-read on a box-size change and when settling ends
	useEffect(() => {
		if (typeof window === "undefined") return;
		const read = (): void => {
			const el = plotRef.current;
			if (el !== null) rect.current = el.getBoundingClientRect();
		};
		read();
		window.addEventListener("resize", read);
		window.addEventListener("scroll", read, true);
		return () => {
			window.removeEventListener("resize", read);
			window.removeEventListener("scroll", read, true);
		};
	}, [box.w, box.h, settling]);

	// Unmount: no frame left to run, and no window keeps following a chart that is gone.
	useEffect(
		() => () => {
			if (typeof cancelAnimationFrame === "function") {
				if (raf.current !== 0) cancelAnimationFrame(raf.current);
				if (previewRaf.current !== 0) cancelAnimationFrame(previewRaf.current);
			}
			raf.current = 0;
			previewRaf.current = 0;
			publishRef.current(null);
			// The page header leaves a position this chart moved it to.
			if (previewing.current) {
				previewing.current = false;
				latest.current?.onPreview(null);
			}
		},
		[],
	);

	/** The record under plot x, or -1 with none. */
	const recordAt = (x: number): number => {
		const L = latest.current;
		if (L === null) return -1;
		const s = L.model.span;
		if (s.i1 < s.i0) return -1;
		const j = nearestIndex(L.model.records.t.subarray(s.i0, s.i1 + 1), xToMs(x, L.win, L.w));
		return j < 0 ? -1 : s.i0 + j;
	};

	/** One animation frame: map the newest pointer point to a record. */
	const frame = (): void => {
		raf.current = 0;
		const at = point.current;
		const r = rect.current;
		if (at === null || r === null) return;
		if (at.x < 0 || at.y < 0 || at.x > r.width || at.y > r.height) {
			clearLive();
			return;
		}
		if (typeof window !== "undefined") dpr.current = window.devicePixelRatio || 1;
		const i = recordAt(at.x);
		if (i >= 0) setLive(i, "pointer");
	};
	const frameRef = useRef(frame);
	frameRef.current = frame;

	const track = (e: PointerEvent<HTMLDivElement>): void => {
		if (rect.current === null) rect.current = e.currentTarget.getBoundingClientRect();
		const r = rect.current;
		point.current = { x: e.clientX - r.left, y: e.clientY - r.top };
		if (raf.current !== 0) return;
		if (typeof requestAnimationFrame === "function") {
			raf.current = requestAnimationFrame(() => frameRef.current());
		} else frameRef.current();
	};
	/** A pointer is done with the line: drop its cursor (a key cursor stays). */
	const release = (): void => {
		touchDown.current = false;
		point.current = null;
		if (raf.current !== 0 && typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(raf.current);
		}
		raf.current = 0;
		if (store.get()?.via === "pointer") clearLive();
	};

	const onPointerEnter = (e: PointerEvent<HTMLDivElement>): void => {
		rect.current = e.currentTarget.getBoundingClientRect();
	};
	const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
		if (e.pointerType === "mouse") return;
		// A finger reads the line only while pressed; a press on a ring stays the ring's.
		const target = e.target as Element | null;
		const onRing = target?.closest?.(RING_SELECTOR) != null;
		touchDown.current = true;
		if (shouldCapture(e.pointerType, onRing)) e.currentTarget.setPointerCapture(e.pointerId);
		track(e);
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
		if (!shouldTrack(e.pointerType, touchDown.current)) return;
		track(e);
	};
	const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
		// A mouse's release does nothing: its click lands where it is.
		if (e.pointerType !== "mouse") release();
	};
	const onPointerLeave = (): void => {
		release();
	};

	/** A click: back to live when pinned, else pin the record under the pointer. */
	const press = (e: React.MouseEvent<HTMLDivElement>): void => {
		const L = latest.current;
		if (L === null) return;
		const target = e.target as Element | null;
		if (target?.closest?.(RING_SELECTOR) != null) return;
		if (L.pinnedPos !== null) {
			L.onPin(null);
			return;
		}
		const r = rect.current ?? e.currentTarget.getBoundingClientRect();
		const i = recordAt(e.clientX - r.left);
		if (i >= 0) L.onPin(L.model.records.pos[i] as number);
	};

	const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
		const L = latest.current;
		if (L === null || e.defaultPrevented) return;
		if (dispatchKey(L.layers, { key: e.key }, L.ctx)) {
			e.preventDefault();
			return;
		}
		const act = keyAction(e);
		if (act === null) return;
		const s = L.model.span;
		const cur = store.get();
		const liveI = isLiveCursor(cur) && inSpan(cur.i, s) ? cur.i : -1;
		const pinI = L.pinnedPos === null ? -1 : indexAtPos(L.model.records, L.pinnedPos);
		if (act.type === "escape") {
			const to = escapeTarget(L.pinnedPos !== null, cur?.via ?? null);
			if (to === "none") return;
			e.preventDefault();
			if (to === "live") {
				// Escape belongs to the line here: the desk's own Escape must not also close what is open.
				e.stopPropagation();
				clearLive();
				L.onPin(null);
				// The header leaves any preview too: it shows the vault as it is now.
				L.onPreview(null);
				return;
			}
			clearLive();
			return;
		}
		if (act.type === "toggle") {
			if (s.i1 < s.i0) return;
			e.preventDefault();
			const to = toggleTarget(liveI, L.model.records.pos[liveI] as number, L.pinnedPos);
			if (to === "live") L.onPin(null);
			else if (to === "pin") L.onPin(L.model.records.pos[liveI] as number);
			return;
		}
		const move = keyMove(act, {
			liveI,
			liveK: isLiveCursor(cur) && liveI >= 0 ? cur.k : null,
			pinI,
			span: s,
			buckets: L.model.values.length,
		});
		if (move === null) return;
		e.preventDefault();
		if (typeof window !== "undefined") dpr.current = window.devicePixelRatio || 1;
		if (move.to === "record") setLive(move.i, "key");
		else moveTo(move.k);
	};
	const onBlur = (): void => {
		if (store.get()?.via === "key") clearLive();
	};

	// ---- What is shown ----
	const headI = live !== null ? live.i : pinned ? pinIdx : null;
	// A live record's own cumulative; a pin's total is worked out by position, so undated spend at or before it counts.
	const cum =
		headI === null
			? restSpend(records)
			: live === null && pinnedPos !== null
				? totalAtPos(records, pinnedPos)
				: headI >= 0
					? (records.cum[headI] as number)
					: records.before;
	const shown =
		headI !== null && headI >= 0
			? {
					t: records.t[headI] as number,
					pos: records.pos[headI] as number,
					pinned: live === null || headI === pinIdx,
				}
			: null;
	const pinnedNoRecord = live === null && pinned && pinIdx < 0;
	const shownK = live !== null ? live.k : pin !== null ? pin.k : -1;
	// The words say no spend only when the range holds none: the span can be empty while out-of-order times still
	// put spend in its buckets. The slider and the keys read the span itself.
	const empty = !(model.rangeUt > 0);
	const noSpan = M === 0;
	const label = headLabel({ shown: headI !== null, filtered });
	const sub = subLine({
		empty,
		rangeUt: model.rangeUt,
		peakRate: model.peakRate,
		bucket,
		shownUt: shownK >= 0 ? (model.values[shownK] ?? null) : null,
		filtered,
		truncated,
	});
	const whenShown = shown === null ? null : { ...shown, pinned: live === null };
	const when = whenLine({
		shown: whenShown,
		pinnedNoRecord,
		lastT: records.n > 0 && !records.lastUndated ? (records.t[records.n - 1] as number) : null,
		spent: records.rows > 0 || records.total > 0,
	});
	const broke = brokenFrom(shown?.pos ?? null, p.breakPos);
	const vText = valueText({ empty: noSpan, shown, pinnedNoRecord, head: p.head, cumUt: cum });
	const fresh = pinned ? newSince(p.at, p.head) : 0;

	// The marks on the line: each read from the model, never from the cursor.
	const pinMark = useMemo(
		() => (pinInRange ? onLine(series, geo, msToX(records.t[pinIdx] as number, win, geo.w)) : null),
		[pinInRange, pinIdx, records, win, geo, series],
	);
	const { breakPos } = p;
	const brkMark = useMemo(() => {
		const i = breakRecord(records, breakPos, win);
		return i < 0
			? null
			: onLine(series, geo, geo.centerX(bucketOf(records.t[i] as number, win, model)));
	}, [records, breakPos, win, geo, series, model]);

	const plotStyle = useMemo(
		() =>
			ink === null ? undefined : ({ "--sp-ink": ink, "--sp-glow": ink } as React.CSSProperties),
		[ink],
	);

	// The crosshair: snapped to a device pixel at the record's x; the dot sits on the drawn line.
	const liveX = live === null ? null : msToX(records.t[live.i] as number, win, geo.w);
	const syncX =
		live === null && sync !== null && other !== null
			? msToX(sync.i >= 0 ? (records.t[sync.i] as number) : other.ms, win, geo.w)
			: null;
	const glideX = useGlide(liveX ?? syncX);
	let cross: ReactNode = null;
	if (live !== null && liveX !== null && glideX !== null) {
		const y = finiteOr(series.curve.at(liveX), geo.baseY);
		cross = (
			<>
				<div
					className="ut-sp-xh"
					style={{ transform: `translateX(${snapPx(glideX - 0.5, dpr.current)}px)` }}
				/>
				<div
					className="ut-sp-dot"
					style={{ transform: `translate(${liveX - DOT_HALF}px, ${y - DOT_HALF}px)` }}
				/>
				<div className="ut-sp-time" style={{ transform: `translateX(${liveX}px)` }}>
					{stamp(records.t[live.i] as number)}
				</div>
			</>
		);
	} else if (glideX !== null) {
		// Another window's moment: a 1px line only; it moves no headline and no dot.
		cross = (
			<div
				className="ut-sp-xh ut-sp-sync"
				style={{ transform: `translateX(${snapPx(glideX - 0.5, dpr.current)}px)` }}
			/>
		);
	}

	const notes = layers.filter((l) => l.Note !== undefined);

	return (
		<div className="ut-sp-chart">
			<div className="ut-sp-head">
				<div className="ut-sp-hl">
					<span className="ut-sp-lbl">{label}</span>
					<span className="ut-sp-fig" title={formatUsd(cum)}>
						<span data-fig="spend.headline">
							<HeadlineFigure ut={cum} live={headI === null} />
						</span>
					</span>
				</div>
				<div className="ut-sp-subs">
					<span className="ut-sp-sub">
						{sub}
						{notes.length > 0 && (
							<span className="ut-sp-note">
								{notes.map((l) => (l.Note === undefined ? null : <l.Note key={l.id} ctx={ctx} />))}
							</span>
						)}
					</span>
					<span className="ut-sp-when" data-past={headI !== null ? "true" : "false"}>
						{when}
						{broke && <span className="ut-sp-broke"> · links broken from here</span>}
					</span>
				</div>
				<span className="ut-sp-grow" />
				{pinned && (
					<button
						type="button"
						className="ut-sp-now"
						title="Back to the vault as it is now (Escape)"
						onClick={() => {
							p.onPin(null);
							p.onPreview(null);
							plotRef.current?.focus();
						}}
					>
						Now
						{fresh > 0 && <span className="ut-sp-new">{newText(fresh)}</span>}
					</button>
				)}
				{p.controls}
			</div>
			<div
				ref={plotRef}
				className="ut-sp-plot"
				role="slider"
				tabIndex={0}
				aria-label={plotLabel(bucket.per)}
				aria-valuemin={1}
				aria-valuemax={Math.max(1, p.head + 1)}
				aria-valuenow={shown !== null ? shown.pos + 1 : Math.max(1, p.head + 1)}
				aria-valuetext={vText}
				aria-disabled={noSpan ? true : undefined}
				data-pinned={pinned ? "true" : "false"}
				style={plotStyle}
				onPointerEnter={onPointerEnter}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={release}
				onPointerLeave={onPointerLeave}
				onClick={press}
				onKeyDown={onKey}
				onBlur={onBlur}
			>
				<div className="ut-sp-frame" key={frameKey(p.filterKey, rows.length === 0)}>
					<ChartFrame
						ctx={ctx}
						geo={geo}
						series={series}
						ticks={scale.ticks}
						layers={layers}
						live={!pinned}
						hover={live !== null}
						pin={pinMark}
						mark={null}
						brk={brkMark}
						ghost={ghost}
						note={ghost === null ? null : p.filterNote}
						idPrefix="sp"
					/>
				</div>
				{cross}
				{layers.map((l) => (
					<SlotFor key={l.id} layer={l} ctx={ctx} />
				))}
			</div>
			<div className="ut-sp-axis" aria-hidden="true">
				<span>{stamp(win.startMs)}</span>
				<span>{stamp(win.endMs)}</span>
			</div>
		</div>
	);
});

/** A layer's HTML in the overlay slot: its `Layer` when it is an overlay layer, then its `Overlay`. */
function SlotFor(props: { layer: SpendLayer; ctx: ChartCtx }): React.JSX.Element {
	const { layer: l, ctx } = props;
	return (
		<>
			{l.z === "overlay" && <l.Layer ctx={ctx} />}
			{l.Overlay !== undefined && <l.Overlay ctx={ctx} />}
		</>
	);
}
