// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import markUrl from "../../brand/usertrust-mark.svg?inline";
import type { AtPayload, SummaryPayload } from "../shared/api.js";
import { windowNote } from "../shared/asof.js";
import {
	budgetAsOf,
	budgetDisplay,
	budgetSourceWord,
	isControllerRecord,
} from "../shared/budget-display.js";
import {
	ANCHOR_VERIFY_COMMAND,
	anchorView,
	CHAINED_PAST_TITLE,
	CHAINED_TITLE,
	chainStatus,
	NOT_ANCHORED_NOTE,
	verifiedAsOf,
} from "../shared/display.js";
import {
	formatUsd,
	formatUsdTotal,
	formatUt,
	formatUtc,
	formatUtcMinute,
	middleTruncate,
	UT_KEY,
} from "../shared/format.js";
import { KIT_MARK_URL, KIT_TIMEOUT_MS } from "../shared/kit.js";
import { NOW_COPY } from "../shared/now-copy.js";
import {
	type Box,
	intersect,
	measure,
	outside,
	paddingBox,
	placePopAt,
	popStyle,
	readableHeight,
	whenMoved,
} from "../shared/pop-place.js";
import { shownLabel } from "../shared/timeline-view.js";
import { useWindowDimmed } from "./desk/window.js";
import type { LiveState } from "./store.js";
import { TickingFigure } from "./ticking-figure.js";
import { useNow } from "./use-now.js";

const LIVE_LABEL: Record<LiveState, string> = {
	connecting: "connecting",
	live: "live",
	reconnecting: "reconnecting",
	offline: "offline",
};

/**
 * The usertrust mark from usertrust.ai, rendered only when the vault config opts in (`remote.kit`). The slot is a
 * fixed size whatever happens, so a mark that loads, fails or times out never moves the header; on a failure or a
 * timeout the slot stays empty, with no error. Decorative: the wordmark beside it names the product.
 */
function KitMark(): React.JSX.Element {
	const [state, setState] = useState<"loading" | "shown" | "gone">("loading");
	useEffect(() => {
		if (state !== "loading") return;
		// Removing the <img> on timeout also stops a hung request.
		const timer = setTimeout(() => setState((s) => (s === "loading" ? "gone" : s)), KIT_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [state]);
	return (
		<span className="ut-kitmark" aria-hidden="true">
			{state !== "gone" && (
				<img
					src={KIT_MARK_URL}
					alt=""
					width={22}
					height={22}
					decoding="async"
					// No cookies (a CORS request without credentials) and no referrer: the kit learns nothing but the fetch.
					crossOrigin="anonymous"
					referrerPolicy="no-referrer"
					data-st={state}
					onLoad={() => setState("shown")}
					onError={() => setState("gone")}
				/>
			)}
		</span>
	);
}

function TopBar(props: {
	vaultPath: string | null;
	live: LiveState;
	kit: boolean;
	/** A past point is shown: the stream may be up, but the screen is not live. */
	past: boolean;
}): React.JSX.Element {
	const [copied, setCopied] = useState(false);
	const path = props.vaultPath;
	return (
		<header className="ut-top">
			{props.kit && <KitMark />}
			{/* Bundled into the page as a data URL (`?inline`): it shows offline and costs no request. */}
			<img className="ut-logo" src={markUrl} alt="usertrust" height={24} decoding="async" />
			<span className="ut-title">ledger</span>
			{path !== null && (
				<button
					type="button"
					className="ut-asof"
					title={`${path} (click to copy)`}
					aria-label={`vault ${path}, copy path`}
					onClick={() => {
						navigator.clipboard.writeText(path).catch(() => {});
						setCopied(true);
						setTimeout(() => setCopied(false), 1200);
					}}
				>
					{copied ? "path copied" : middleTruncate(path, 72)}
				</button>
			)}
			<span className="ut-grow" />
			{/* "live" means the screen shows now AND the stream is up; at a past point an up stream is only "connected". */}
			<span
				className="ut-live"
				data-st={props.live}
				data-past={props.past ? "true" : undefined}
				role="status"
			>
				<i aria-hidden="true" />
				{props.past && props.live === "live" ? "connected" : LIVE_LABEL[props.live]}
			</span>
		</header>
	);
}

/** Open state for a small popover: closed by a press outside it or by Escape. */
function usePopover(): {
	open: boolean;
	toggle(): void;
	close(): void;
	rootRef: React.RefObject<HTMLDivElement | null>;
} {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const away = (e: PointerEvent): void => {
			if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
		};
		const esc = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				// Handled: the desk's Escape peel leaves a marked press alone.
				e.preventDefault();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", away);
		document.addEventListener("keydown", esc);
		return () => {
			document.removeEventListener("pointerdown", away);
			document.removeEventListener("keydown", esc);
		};
	}, [open]);
	const close = useCallback(() => setOpen(false), []);
	return { open, toggle: () => setOpen((o) => !o), close, rootRef };
}

/** The ancestors of `el` that clip its content (a window, its body): what can cut it, besides the viewport. */
function clippers(el: HTMLElement): HTMLElement[] {
	const out: HTMLElement[] = [];
	for (let a = el.parentElement; a !== null; a = a.parentElement) {
		const cs = getComputedStyle(a);
		if (cs.overflowX !== "visible" || cs.overflowY !== "visible") out.push(a);
	}
	return out;
}

/** The box that would cut `el`: every ancestor that clips its content, and the viewport. */
function clipBox(el: HTMLElement): Box {
	let box: Box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
	for (const a of clippers(el)) box = intersect(a.getBoundingClientRect(), box);
	return box;
}

/**
 * Places an open text popover from where its anchor sits on screen (`placePop`), before it paints: toward the side
 * with room inside the box that would cut it, and above its anchor when there is no room below. A side fixed in the
 * stylesheet was cut off whenever the anchor sat in the other half of a narrow window. While it is open it is placed
 * again whenever that box moves or changes size (`whenMoved`): a scroll, the browser's size, its window filling the
 * desk or giving it back. If that leaves its anchor wholly out of view, it calls `close`, once; so it does when its
 * window shows too little of itself to hold it at its floor (`placePop`'s no room), and when another window fills the
 * desk, which leaves this one inert and out of sight (`useWindowDimmed`). It is never drawn below its floor: two of its
 * lines, or all of it.
 */
function usePopPlace(
	open: boolean,
	popRef: RefObject<HTMLElement | null>,
	close: () => void,
	/** The line the popover belongs to, when it is not the whole box it is positioned in: a cut fact line inside its
	 *  fact. The room is measured from it, and the popover is drawn next to it (`placePop`'s `line`). */
	line: HTMLElement | null = null,
): CSSProperties | undefined {
	const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
	// Left open in a dimmed window, an explainer sat inert and out of sight and took the next Esc, so the desk did not
	// restore.
	const dimmed = useWindowDimmed();
	useEffect(() => {
		if (open && dimmed) close();
	}, [open, dimmed, close]);
	useLayoutEffect(() => {
		const pop = popRef.current;
		const anchor = pop?.offsetParent;
		if (!open || pop == null || !(anchor instanceof HTMLElement)) {
			setStyle(undefined);
			return;
		}
		let last = "";
		// Set once it has closed it: nothing this opening heard afterwards places it, or closes it, again.
		let done = false;
		const place = (): void => {
			if (done) return;
			// The box its offsets are measured from: the anchor's padding box, where CSS measures top and bottom from.
			const at = paddingBox(anchor.getBoundingClientRect(), getComputedStyle(anchor));
			// The line it belongs to, when that is not the whole anchor: measured from the whole fact near the bottom of a
			// short window, the room on both sides was a few pixels and a cut line's explainer had no readable height.
			const lineBox = line !== null && line !== anchor ? line.getBoundingClientRect() : null;
			const clip = clipBox(pop);
			// Its line wholly out of view (its window scrolled, or a resize or a restore left it below the fold): no place
			// is both next to the line and inside the window, so it closes, as a click elsewhere would close it.
			if (outside(lineBox ?? at, clip)) {
				done = true;
				close();
				return;
			}
			const r = measure(pop, null);
			const heightAt = (w: number): number => measure(pop, w).height;
			// Its floor: two of its own lines with its padding and border (all of it, if it is shorter).
			const readable = readableHeight(getComputedStyle(pop));
			const p = placePopAt(at, r.width, r.height, clip, heightAt, lineBox, readable);
			// No room to read it anywhere in its window (a sliver of the window is in view): it closes, as above. The next
			// press opens it afresh, placed in whatever room there is then.
			if (p === null) {
				done = true;
				close();
				return;
			}
			const next = popStyle(p);
			const key = JSON.stringify(next);
			if (key === last) return;
			last = key;
			setStyle(next);
		};
		place();
		return whenMoved(
			[...clippers(pop), anchor, ...(line !== null && line !== anchor ? [line] : [])],
			place,
			{
				view: window,
				doc: document,
				frame: (run) => requestAnimationFrame(run),
				cancelFrame: (id) => cancelAnimationFrame(id),
				Observer: typeof ResizeObserver === "undefined" ? null : ResizeObserver,
			},
			(t) => t instanceof Node && pop.contains(t),
		);
	}, [open, popRef, close, line]);
	return style;
}

/** The explainer a bare "absent" never had: a small popover, toggled by click or keyboard, closed by Escape. */
function AnchorFact(props: {
	anchorFile: SummaryPayload["anchorFile"];
	/** At a past position: the file is today's, and the tag says so. */
	past?: boolean;
}): React.JSX.Element {
	const shown = anchorView(props.anchorFile);
	const { open, toggle, close, rootRef } = usePopover();
	const popRef = useRef<HTMLDivElement>(null);
	const placed = usePopPlace(open, popRef, close);
	const [before, after] = shown.explainer.split(ANCHOR_VERIFY_COMMAND);
	return (
		<div className="ut-fact detail" id="ut-fact-anchor">
			<b>Anchor file</b>
			<div className="ut-info" ref={rootRef}>
				<span className="ut-tag" title={shown.explainer}>
					{props.past === true ? `today: ${shown.label}` : shown.label}
				</span>
				<button
					type="button"
					className="ut-info-btn"
					aria-label="what the anchor file is"
					aria-expanded={open}
					onClick={toggle}
				>
					i
				</button>
				{open && (
					<div ref={popRef} className="ut-pop text" role="note" style={placed}>
						{before}
						<code>{ANCHOR_VERIFY_COMMAND}</code>
						{after}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * The vault's spend: dollars lead (2 dp, the exact 4 dp figure on hover, counting to a new total as records arrive) and
 * the ledger's own unit, usertokens, follows on the line below, with an info button that gives the key to the unit.
 * At a past position (`past`) it is the spend up to there, and it jumps from value to value instead of counting; the
 * figure is remounted when the view switches between live and past, so that switch jumps too. Given a `scope`, the
 * figure is some other sum (the filtered records'), and the line under it reads that scope instead.
 */
export function SpendFact(props: {
	spentUt: number;
	past: boolean;
	/** The figure's scope when it is not the vault's own (a filtered sum): it replaces the line under the figure. */
	scope?: string;
}): React.JSX.Element {
	const { open, toggle, close, rootRef } = usePopover();
	const popRef = useRef<HTMLDivElement>(null);
	const placed = usePopPlace(open, popRef, close);
	return (
		<div
			className="ut-fact"
			// A figure of another scope is not every record's cost: its own line says what it is.
			title={
				props.scope !== undefined
					? undefined
					: props.past
						? "The cost of every llm_call record up to this point"
						: "The cost of every llm_call record in the vault"
			}
		>
			<b>Spend</b>
			<span className="v" title={formatUsd(props.spentUt)}>
				<Fit text={formatUsdTotal(props.spentUt)}>
					<TickingFigure key={props.past ? "past" : "live"} ut={props.spentUt} jump={props.past} />
				</Fit>
			</span>
			<div className="ut-info" ref={rootRef}>
				<FactLine className="ut-sub mono" text={formatUt(props.spentUt)} />
				<button
					type="button"
					className="ut-info-btn"
					title={UT_KEY}
					aria-label={`what a UT is: ${UT_KEY}`}
					aria-expanded={open}
					onClick={toggle}
				>
					i
				</button>
				{open && (
					<div ref={popRef} className="ut-pop text" role="note" style={placed}>
						{UT_KEY}
					</div>
				)}
			</div>
			<FactLine
				className="ut-sub"
				text={
					props.scope ?? (props.past ? "llm calls · up to this point" : "llm calls · whole vault")
				}
			/>
		</div>
	);
}

/**
 * The past view's own line. Its slot is always there: live it is empty and hidden (`visibility: hidden`, out of the
 * accessibility tree), so entering or leaving the past view moves nothing below it. Only the past line reads the
 * clock (for the year), so the live header never re-renders on its tick.
 */
function AsAtLine(props: { at: AtPayload | null; head: number }): React.JSX.Element {
	if (props.at === null)
		return (
			<p className="ut-asat" data-live="true" aria-hidden="true">
				{"\u00a0"}
			</p>
		);
	return <PastAsAtLine at={props.at} head={props.head} />;
}

/** `head`: the live vault's last position, so a clamped answer stops saying "latest record" once records follow it. */
function PastAsAtLine(props: { at: AtPayload; head: number }): React.JSX.Element {
	const now = useNow();
	return (
		<p className="ut-asat" data-live="false">
			{shownLabel(props.at, props.head, new Date(now).toISOString())}
		</p>
	);
}

/**
 * A fact's line held empty and unseen, so a fact has the same lines in every state, live or past, and the facts row
 * never changes height when the view or the data does (the stylesheet gives each line a fixed height).
 */
function Reserve(props: { line: "meter" | "amts" | "sub" | "why" }): React.JSX.Element {
	if (props.line === "meter")
		return <div className="ut-meter" aria-hidden="true" data-reserve="true" />;
	return (
		<span className={`ut-${props.line}`} aria-hidden="true" data-reserve="true">
			{"\u00a0"}
		</span>
	);
}

/**
 * A one-line figure that shrinks to fit its column instead of being cut: the font size is the line's own, or less,
 * so that `n` characters fit in the container's width (`.ut-fit` in the stylesheet; the figures are monospace, and
 * the factor there is a little wider than any monospace advance). `n` is the text's length.
 */
function Fit(props: { text: string; children?: ReactNode }): React.JSX.Element {
	return (
		<span className="ut-fit" style={{ "--n": Math.max(props.text.length, 1) } as CSSProperties}>
			{props.children ?? props.text}
		</span>
	);
}

/** Amounts as at most two units, each shrunk to fit a line: the line wraps between them, never inside one. */
function Units(props: { units: string[] }): React.JSX.Element {
	return (
		<>
			{props.units.map((u, i) => (
				<span key={u}>
					{i > 0 && " "}
					<Fit text={u} />
				</span>
			))}
		</>
	);
}

/**
 * A header fact's line with a fixed height (`ut-amts`, `ut-sub` and `ut-why` hold two lines). Its whole text is in its
 * title for a pointer. If the box still cuts it (a long server note in a narrow column), the line becomes a button
 * that opens the whole text, so a keyboard or a touch reaches it too; a screen reader reads the whole text either way.
 */
function FactLine(props: {
	className: string;
	text: string;
	title?: string | undefined;
	children?: ReactNode;
}): React.JSX.Element {
	const [el, setEl] = useState<HTMLSpanElement | null>(null);
	const [cut, setCut] = useState(false);
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	const popRef = useRef<HTMLSpanElement>(null);
	// Placed from its line, not from the whole fact it is positioned in.
	const placed = usePopPlace(cut && open, popRef, close, el);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the line is measured again when its text changes
	useEffect(() => {
		if (el === null || typeof ResizeObserver === "undefined") return;
		const measure = (): void =>
			setCut(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [el, props.text]);
	useEffect(() => {
		if (!cut) setOpen(false);
	}, [cut]);
	useEffect(() => {
		if (!open) return;
		const away = (e: PointerEvent): void => {
			const t = e.target as Node;
			if (el?.contains(t) !== true && popRef.current?.contains(t) !== true) setOpen(false);
		};
		const esc = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				// Handled: the desk's Escape peel leaves a marked press alone.
				e.preventDefault();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", away);
		document.addEventListener("keydown", esc);
		return () => {
			document.removeEventListener("pointerdown", away);
			document.removeEventListener("keydown", esc);
		};
	}, [open, el]);
	const toggle = (): void => setOpen((o) => !o);
	const opener = cut
		? {
				role: "button",
				tabIndex: 0,
				"aria-expanded": open,
				"data-cut": "true",
				onClick: toggle,
				onKeyDown: (e: React.KeyboardEvent): void => {
					if (e.key !== "Enter" && e.key !== " ") return;
					e.preventDefault();
					toggle();
				},
			}
		: {};
	return (
		<>
			<span ref={setEl} className={props.className} title={props.title ?? props.text} {...opener}>
				{props.children ?? props.text}
			</span>
			{cut && open && (
				<span ref={popRef} className="ut-pop text" role="note" style={placed}>
					{props.text}
				</span>
			)}
		</>
	);
}

/**
 * The Budget fact at a past position. There is no budget history yet, so there is no budget then to show: today's
 * budget is named as today's, never shown as the budget at that point. Where it came from is shown as it is live: the
 * source word (a controller's record reads `enforced` only while it is fresh) and, for a controller's record, the time
 * it was written; any other source has the provenance sentence in the line's tooltip. A budget that is unknown
 * (`several`, `unreadable`, `unpublished`) shows its reason and no figure.
 */
export function PastBudgetFact(props: { at: AtPayload }): React.JSX.Element {
	const { budget } = props.at;
	const now = useNow();
	const controller = isControllerRecord(budget.source);
	const word = budgetSourceWord(budget.source, budget.writtenAt, now).word;
	// Any other source says where the figure came from in the sentence the live fact shows.
	const from = !controller
		? budget.provenance.replace(/^unknown: /, "")
		: budget.writtenAt !== null
			? `${word}, as of ${formatUtcMinute(budget.writtenAt)}`
			: word;
	const line = budget.ut !== null ? `${from}. ${budget.note}` : budget.note;
	return (
		<div className="ut-fact budget" title={budget.note}>
			<b>Budget</b>
			<span className="v na" title="not recorded then">
				<Fit text="not recorded then" />
			</span>
			{/* The live fact's lines (the meter's row held empty and unseen), so the header keeps its height when the view
			    changes. Today's figures are named as today's. */}
			<Reserve line="meter" />
			{budget.ut !== null ? (
				<>
					<FactLine
						className="ut-amts"
						text={`today: ${formatUsdTotal(budget.ut)}`}
						title={formatUsd(budget.ut)}
					>
						<Units units={[`today: ${formatUsdTotal(budget.ut)}`]} />
					</FactLine>
					<FactLine className="ut-sub mono" text={`today: ${formatUt(budget.ut)}`} />
					<FactLine className="ut-sub" text={NOW_COPY.scopeVault} />
				</>
			) : (
				<>
					<Reserve line="amts" />
					{/* The reason in place of a figure, in the line a figure would have used. */}
					<FactLine
						className="ut-sub"
						text={budget.provenance.replace(/^unknown: /, "")}
						title={budget.provenance}
					/>
					{/* No figure, so nothing to scope: the scope's line is held. */}
					<Reserve line="sub" />
				</>
			)}
			{/* Two lines (clamped): where the figure came from, then the whole note. The whole line is in its title, and a
			    cut line opens in full. The provenance sentence calls a controller's budget "enforced", so as live, a
			    controller's record never shows it: its words are the source word and the time. A budget with no figure
			    has its reason in the line above, and in this line's title. */}
			<FactLine
				className="ut-why"
				text={line}
				title={controller || budget.ut !== null ? line : `${budget.provenance}. ${line}`}
			/>
		</div>
	);
}

/**
 * The Integrity fact at a past position, read from `at.chain` only: the server never reads a position as intact when
 * the vault fails for a reason no record marks. "chained", never "verified", as live.
 */
function PastIntegrityFact(props: {
	at: AtPayload;
	anchorFile: SummaryPayload["anchorFile"];
}): React.JSX.Element {
	const { chain, pos } = props.at;
	const why = chain.valid
		? "the links up to this point are intact"
		: chain.breakIndex !== null && pos >= chain.breakIndex
			? `broken from chain position ${chain.breakIndex + 1}`
			: "the vault reads broken at every point";
	return (
		<div className="ut-fact">
			<b>Integrity</b>
			{chain.valid ? (
				<>
					<span className="ut-pill" data-tone="approve" title={CHAINED_PAST_TITLE}>
						<i />
						chained
					</span>
					{/* As live: "chained" is the hash links only, and the vault has no anchor file (today). */}
					{props.anchorFile !== "present" ? (
						<FactLine className="ut-sub" text={NOT_ANCHORED_NOTE} />
					) : (
						<Reserve line="sub" />
					)}
				</>
			) : (
				<>
					<span className="ut-pill" data-tone="stakes">
						<i />
						broken
					</span>
					<Reserve line="sub" />
				</>
			)}
			<FactLine className="ut-why" text={why} />
		</div>
	);
}

/** Under the chained pill when the vault has an anchor file, where the caller asks for the line. */
const ANCHOR_RECORDED = "an anchor file is recorded";

/**
 * The Integrity fact: live, the hash links as the dashboard re-checked them; at a past position, the position's own
 * chain. With `anchorLine`, a chained vault that has an anchor file says so under the pill (the file is recorded; the
 * dashboard does not check it, so it is never called verified); without it that line is held empty.
 */
export function IntegrityFact(props: {
	s: SummaryPayload;
	at: AtPayload | null;
	anchorLine?: boolean;
}): React.JSX.Element {
	const { s } = props;
	if (props.at !== null) return <PastIntegrityFact at={props.at} anchorFile={s.anchorFile} />;
	const status = chainStatus(s.chain);
	// In UTC, as every time on the page is: never the reader's own clock or date order.
	const checked = verifiedAsOf(s.verifiedAt, (d) => formatUtc(d.toISOString()));
	return (
		<div className="ut-fact">
			<b>Integrity</b>
			{/* "chained", never "verified": this is the hash links re-checked by the dashboard, not an explicit,
			    anchored check. Without an anchor file it says so under the pill. */}
			{status === "verified" && (
				<span className="ut-pill" data-tone="approve" title={CHAINED_TITLE}>
					<i />
					chained
				</span>
			)}
			{status === "broken" && (
				<span className="ut-pill" data-tone="stakes">
					<i />
					broken
				</span>
			)}
			{status === "empty" && (
				<span className="ut-pill" title="No events yet: nothing to verify, nothing wrong">
					<i />
					no events
				</span>
			)}
			{/* The pill's line under it, in every state (held empty when it has nothing to say), so the fact keeps its
			    height. */}
			{status === "verified" && s.anchorFile !== "present" ? (
				<FactLine className="ut-sub" text={NOT_ANCHORED_NOTE} />
			) : status === "verified" && props.anchorLine === true ? (
				<FactLine className="ut-sub" text={ANCHOR_RECORDED} />
			) : (
				<Reserve line="sub" />
			)}
			<FactLine
				className="ut-why"
				text={checked}
				title={`${checked}. The dashboard is a monitor: usertrust verify is the authoritative check of a vault`}
			/>
		</div>
	);
}

/**
 * The Budget fact. A controller's record is a file written at one moment, so its age is shown against the clock (which
 * ticks while the page is open), and past the freshness bound the source word is `recorded`, never `enforced`. The
 * provenance sentence calls such a budget "enforced", so for a controller's record the tooltip is the exact time
 * instead of that sentence.
 */
export function BudgetFact(props: { s: SummaryPayload }): React.JSX.Element {
	const { s } = props;
	const now = useNow();
	const budget = budgetDisplay(s);
	const word = budgetSourceWord(s.budgetSource, s.budgetWrittenAt, now);
	const asOf = budgetAsOf(s, now);
	const title = asOf.isRecord ? (asOf.title ?? undefined) : s.budgetProvenance;
	return (
		<div className="ut-fact budget" title={title}>
			<b>
				Budget
				<span className="ut-mark" data-tone={word.tone}>
					{word.word}
				</span>
			</b>
			{budget.kind === "known" && s.budget !== null && s.remainingUt !== null ? (
				<>
					<span className="v">
						<Fit text={`${budget.leftPct.toFixed(1)}% left`}>
							{budget.leftPct.toFixed(1)}% <small>left</small>
						</Fit>
					</span>
					{/* Decorative: the figure above it carries the number. The fill is what is LEFT, the same figure, so it drains as money is spent. */}
					<div className="ut-meter" aria-hidden="true">
						<i style={{ width: `${budget.leftPct}%`, background: `var(--${budget.fill})` }} />
					</div>
					{s.remainingUt < 0 ? (
						<>
							<FactLine
								className="ut-amts red"
								text={`overspent by ${formatUsdTotal(-s.remainingUt)} of ${formatUsdTotal(s.budget)}`}
								title={`overspent by ${formatUsd(-s.remainingUt)} of ${formatUsd(s.budget)}`}
							>
								<Units
									units={[
										`overspent by ${formatUsdTotal(-s.remainingUt)}`,
										`of ${formatUsdTotal(s.budget)}`,
									]}
								/>
							</FactLine>
							<FactLine
								className="ut-sub mono"
								text={`${formatUt(-s.remainingUt)} of ${formatUt(s.budget)}`}
							>
								<Units units={[formatUt(-s.remainingUt), `of ${formatUt(s.budget)}`]} />
							</FactLine>
						</>
					) : (
						<>
							<FactLine
								className="ut-amts"
								text={`${formatUsdTotal(s.remainingUt)} of ${formatUsdTotal(s.budget)}`}
								title={`${formatUsd(s.remainingUt)} of ${formatUsd(s.budget)}`}
							>
								<Units units={[formatUsdTotal(s.remainingUt), `of ${formatUsdTotal(s.budget)}`]} />
							</FactLine>
							<FactLine
								className="ut-sub mono"
								text={`${formatUt(s.remainingUt)} of ${formatUt(s.budget)}`}
							>
								<Units units={[formatUt(s.remainingUt), `of ${formatUt(s.budget)}`]} />
							</FactLine>
						</>
					)}
					{/* The budget is the vault's, whatever is filtered and whatever range is shown. */}
					<FactLine className="ut-sub" text={NOW_COPY.scopeVault} />
					<FactLine className="ut-why" text={asOf.text} title={asOf.title ?? asOf.text} />
				</>
			) : (
				<>
					<span className="v na" title="no remaining figure">
						<Fit text="no remaining figure" />
					</span>
					<Reserve line="meter" />
					<Reserve line="amts" />
					<Reserve line="sub" />
					<Reserve line="sub" />
					{/* A controller's record with no usable figure still must not call itself "enforced" once stale. */}
					<FactLine
						className={`ut-why${s.budgetSource === "unreadable" ? " info" : ""}`}
						text={asOf.isRecord ? asOf.text : s.budgetProvenance.replace(/^unknown: /, "")}
						title={asOf.isRecord ? asOf.text : s.budgetProvenance}
					/>
				</>
			)}
		</div>
	);
}

/**
 * The facts before the first summary, in the order they are drawn once loaded: each fact with the lines it will have,
 * held empty and unseen (and the Details toggle held too), so the first load moves nothing. Only a "…" shows.
 */
function LoadingFacts(props: { budgetNote?: ReactNode }): React.JSX.Element {
	return (
		<section className="ut-facts" aria-busy="true" aria-label="vault summary loading">
			<div className="ut-fact">
				<b>Spend</b>
				<span className="v na">…</span>
				<div className="ut-info" aria-hidden="true">
					<Reserve line="sub" />
				</div>
				<Reserve line="sub" />
			</div>
			<div className="ut-fact budget">
				<b>Budget</b>
				<span className="v na">…</span>
				<Reserve line="meter" />
				<Reserve line="amts" />
				<Reserve line="sub" />
				<Reserve line="sub" />
				<Reserve line="why" />
			</div>
			{props.budgetNote}
			<div className="ut-fact">
				<b>Integrity</b>
				<span className="ut-pill">
					<i />…
				</span>
				<Reserve line="sub" />
				<Reserve line="why" />
			</div>
			<span className="ut-more" aria-hidden="true" data-reserve="true">
				Details
			</span>
			<div className="ut-fact detail">
				<b>Chain</b>
				<span className="v na">…</span>
			</div>
			<div className="ut-fact detail">
				<b>Anchor file</b>
				<div className="ut-info">
					<span className="ut-tag">…</span>
					<span className="ut-info-btn" aria-hidden="true" data-reserve="true" />
				</div>
			</div>
		</section>
	);
}

/**
 * Which part of the strip to draw: the page bar (the header and the chain alarm), the head (the as-at line and the
 * Window notice), the facts grid, or all three in that order. The alarm is the bar's: a broken chain shows wherever
 * the head and the facts are put.
 */
export type SummaryStripPart = "bar" | "head" | "facts" | "all";

/** A count with its thousands grouped the one way the page writes them, whatever the reader's locale. */
const COUNT = new Intl.NumberFormat("en-US");

export function SummaryStrip(props: {
	summary: SummaryPayload | null;
	live: LiveState;
	/** The vault as recorded at a past position, or null (or absent) for live. */
	at?: AtPayload | null;
	/** One part, or all of them (the default). The desk puts them in different places. */
	part?: SummaryStripPart;
	/** Drawn in the facts grid after the Budget fact, before the Integrity fact. */
	budgetNote?: ReactNode;
	/** A Spend figure of another scope (the filtered records' sum) and the label that says so; Budget never swaps. */
	spentOverride?: { ut: number; label: string };
}): React.JSX.Element {
	const part = props.part ?? "all";
	const showBar = part === "bar" || part === "all";
	const showHead = part === "head" || part === "all";
	const showFacts = part === "facts" || part === "all";
	const s = props.summary;
	const at = props.at ?? null;
	// The Chain and Anchor facts sit behind a button where the stylesheet shows it. The button follows the facts that
	// are always shown and comes before the two it opens, so the order on screen is the markup's, which Tab follows.
	const [detailsOpen, setDetailsOpen] = useState(false);
	const detailsRef = useRef<HTMLButtonElement>(null);
	// Escape closes the disclosure from the button or from inside it, unless the anchor explainer is open (it takes the
	// first Escape), and puts focus back on the button.
	const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
		if (e.key !== "Escape" || !detailsOpen) return;
		if (e.target !== detailsRef.current && e.currentTarget.querySelector(".ut-pop") !== null)
			return;
		// Handled: React runs this before the desk's Escape peel, which would otherwise take a layer (the record, the
		// fill, the pin or the newest filter) with the same press.
		e.preventDefault();
		setDetailsOpen(false);
		detailsRef.current?.focus();
	};
	if (!s)
		return (
			<>
				{showBar && <TopBar vaultPath={null} live={props.live} kit={false} past={at !== null} />}
				{showHead && <AsAtLine at={null} head={-1} />}
				{showFacts && <LoadingFacts budgetNote={props.budgetNote} />}
			</>
		);
	const status = chainStatus(s.chain);
	// One note about the list's window: the position's own when it is before the rows held, else the live one.
	const notice = windowNote(s, at);
	const events = at === null ? s.chain.events : at.pos + 1;

	return (
		<>
			{showBar && (
				<>
					<TopBar vaultPath={s.vaultPath} live={props.live} kit={s.remote.kit} past={at !== null} />
					{status === "broken" && (
						<div className="ut-alarm" role="alert">
							<b>Chain integrity failure</b>
							<p>
								{s.chain.breakIndex !== null
									? `Tampering or corruption detected at chain position ${s.chain.breakIndex + 1}. Rows from there on are marked after break.`
									: "The vault failed verification: tampering, corruption or deletion."}
							</p>
							{s.chain.errors.length > 0 && (
								<ul>
									{s.chain.errors.slice(0, 3).map((err) => (
										<li key={err}>{err}</li>
									))}
									{s.chain.errors.length > 3 && <li>…and {s.chain.errors.length - 3} more</li>}
								</ul>
							)}
						</div>
					)}
				</>
			)}
			{showHead && (
				<>
					{/* The live alarm above stays: it is the vault now. Everything below this line is the vault then. */}
					<AsAtLine at={at} head={s.chain.events - 1} />
					{notice !== null && (
						<div className="ut-notice" role="status">
							<b>Window</b>
							{notice}
						</div>
					)}
				</>
			)}
			{showFacts && (
				<section
					className="ut-facts"
					aria-label="vault summary"
					data-details={detailsOpen}
					onKeyDown={onKeyDown}
				>
					{props.spentOverride === undefined ? (
						<SpendFact spentUt={at === null ? s.spentUt : at.spentUt} past={at !== null} />
					) : (
						<SpendFact
							spentUt={props.spentOverride.ut}
							past={at !== null}
							scope={props.spentOverride.label}
						/>
					)}
					{at === null ? <BudgetFact s={s} /> : <PastBudgetFact at={at} />}
					{props.budgetNote}
					<IntegrityFact s={s} at={at} />
					<button
						ref={detailsRef}
						type="button"
						className="ut-more"
						aria-expanded={detailsOpen}
						aria-controls="ut-fact-chain ut-fact-anchor"
						onClick={() => setDetailsOpen((o) => !o)}
					>
						<span>{detailsOpen ? "Hide details" : "Details"}</span>
						<span className="chev" aria-hidden="true">
							▾
						</span>
					</button>
					<div className="ut-fact detail" id="ut-fact-chain">
						<b>Chain</b>
						<span className="v">
							<Fit text={`${COUNT.format(events)} ${events === 1 ? "event" : "events"}`}>
								{COUNT.format(events)} <small>{events === 1 ? "event" : "events"}</small>
							</Fit>
						</span>
					</div>
					<AnchorFact anchorFile={s.anchorFile} past={at !== null} />
				</section>
			)}
		</>
	);
}
