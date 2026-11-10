// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend chart: the static marks, a cursor that snaps to the real records under the pointer, and a headline read
 * from exact records.
 *
 * The cursor is a small store, not React state: the model, the scale, the drawn line and the layers' context are built
 * once per rows, window, bucket, width and layers, and a cursor move re-renders only the headline, the crosshair and
 * whatever reads the store, never the marks. Every figure is read from exact records (`cum`, the model's buckets),
 * never from the drawn curve.
 */

import {
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
import { inWindow, type SpendRecords } from "../../../shared/cumulative.js";
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
	geometry,
} from "../../../shared/spend-scale.js";
import { setHoverMoment } from "../../desk/desk-state.js";
import { useBoxSize } from "../../desk/use-box-size.js";
import { ChartFrame } from "./chart-frame.js";
import {
	bucketOf as bucketAt,
	frameKey,
	isLiveCursor,
	reconcileCursor,
	stepBucket,
} from "./chart-keys.js";
import { headLabel, stamp, subLine, whenLine } from "./chart-text.js";
import { buildCtx, resolveScale } from "./ctx.js";
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
	/** The line's bucket for the range: the model's bucket and the words' unit. */
	bucket: LineBucket;
	/** The filters the rows were drawn with, as one string: a change fades the marks in again. */
	filterKey: string;
	/** Drawn at the right of the headline row. */
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
 * is filled in here, so the frame reads one answer.
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
	layers: readonly SpendLayer[];
	onPreview(pos: number | null): void;
}

export const SpendChart = memo(function SpendChart(p: SpendChartProps): React.JSX.Element {
	const { rows, win, totalUt, filtered, truncated, ink, settling, bucket } = p;
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
	/** The header back to the vault as it is now, at once: a pending preview must not land after it. */
	const unpreview = (): void => {
		if (previewRaf.current !== 0 && typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(previewRaf.current);
		}
		previewRaf.current = 0;
		previewing.current = false;
		latest.current?.onPreview(null);
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
	/** Drop the live cursor. */
	const clearLive = (): void => {
		if (!isLiveCursor(store.get())) return;
		store.set(null);
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

	latest.current = { model, win, w, layers, onPreview: p.onPreview };

	// What is drawn: a live cursor still inside this model's records.
	const stored = useSyncExternalStore(store.subscribe, store.get, () => null);
	const live: CursorValue | null = isLiveCursor(stored) && inSpan(stored.i, span) ? stored : null;

	// A new model (a live append, a filter, a later window): keep the live cursor on its record, in that record's bucket
	// on the new line, or drop it, and the header's preview with it, when the record is gone.
	const prevModel = useRef(model);
	useLayoutEffect(() => {
		const was = prevModel.current;
		prevModel.current = model;
		if (was === model) return;
		const v = store.get();
		if (!isLiveCursor(v)) return;
		const next = reconcileCursor(v, was.records.pos[v.i], {
			records: model.records,
			span: model.span,
			bucketOf: (t) => bucketOf(t, win, model),
		});
		if (next !== null) {
			store.set(next);
			return;
		}
		store.set(null);
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
	/** A pointer is done with the line: drop its cursor. */
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
		// A mouse's release does nothing.
		if (e.pointerType !== "mouse") release();
	};
	const onPointerLeave = (): void => {
		release();
	};

	// ---- What is shown ----
	const headI = live !== null ? live.i : null;
	const cum = headI === null ? restSpend(records) : (records.cum[headI] as number);
	const shown =
		headI === null
			? null
			: { t: records.t[headI] as number, pos: records.pos[headI] as number, pinned: false };
	// The words say no spend only when the range holds none: the span can be empty while out-of-order times still
	// put spend in its buckets.
	const empty = !(model.rangeUt > 0);
	const label = headLabel({ shown: headI !== null, filtered });
	const sub = subLine({
		empty,
		rangeUt: model.rangeUt,
		peakRate: model.peakRate,
		bucket,
		shownUt: live !== null ? (model.values[live.k] ?? null) : null,
		filtered,
		truncated,
	});
	const when = whenLine({
		shown,
		pinnedNoRecord: false,
		lastT: records.n > 0 ? (records.t[records.n - 1] as number) : null,
	});

	const plotStyle = useMemo(
		() =>
			ink === null ? undefined : ({ "--sp-ink": ink, "--sp-glow": ink } as React.CSSProperties),
		[ink],
	);

	// The crosshair: snapped to a device pixel at the record's x; the dot sits on the drawn line.
	const liveX = live === null ? null : msToX(records.t[live.i] as number, win, geo.w);
	const glideX = useGlide(liveX);
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
	}

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
					<span className="ut-sp-sub">{sub}</span>
					<span className="ut-sp-when" data-past={headI !== null ? "true" : "false"}>
						{when}
					</span>
				</div>
				<span className="ut-sp-grow" />
				{p.controls}
			</div>
			<div
				ref={plotRef}
				className="ut-sp-plot"
				data-pinned="false"
				style={plotStyle}
				onPointerEnter={onPointerEnter}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={release}
				onPointerLeave={onPointerLeave}
			>
				<div className="ut-sp-frame" key={frameKey(p.filterKey, rows.length === 0)}>
					<ChartFrame
						ctx={ctx}
						geo={geo}
						series={series}
						ticks={scale.ticks}
						layers={layers}
						live
						hover={live !== null}
						pin={null}
						mark={null}
						brk={null}
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
