// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useRef, useState } from "react";
import markUrl from "../../brand/usertrust-mark.svg?inline";
import type { SummaryPayload } from "../shared/api.js";
import { budgetAsOf, budgetDisplay, budgetSourceWord } from "../shared/budget-display.js";
import {
	ANCHOR_VERIFY_COMMAND,
	anchorView,
	chainStatus,
	verifiedAsOf,
	windowNotice,
} from "../shared/display.js";
import { formatUsd, formatUsdTotal, formatUt, middleTruncate, UT_KEY } from "../shared/format.js";
import { KIT_MARK_URL, KIT_TIMEOUT_MS } from "../shared/kit.js";
import type { LiveState } from "./store.js";

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
			<span className="ut-live" data-st={props.live} role="status">
				<i aria-hidden="true" />
				{LIVE_LABEL[props.live]}
			</span>
		</header>
	);
}

/** Open state for a small popover: closed by a press outside it or by Escape. */
function usePopover(): {
	open: boolean;
	toggle(): void;
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
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", away);
		document.addEventListener("keydown", esc);
		return () => {
			document.removeEventListener("pointerdown", away);
			document.removeEventListener("keydown", esc);
		};
	}, [open]);
	return { open, toggle: () => setOpen((o) => !o), rootRef };
}

/** The explainer a bare "absent" never had: a small popover, toggled by click or keyboard, closed by Escape. */
function AnchorFact(props: { anchorFile: SummaryPayload["anchorFile"] }): React.JSX.Element {
	const shown = anchorView(props.anchorFile);
	const { open, toggle, rootRef } = usePopover();
	const [before, after] = shown.explainer.split(ANCHOR_VERIFY_COMMAND);
	return (
		<div className="ut-fact detail" id="ut-fact-anchor">
			<b>Anchor file</b>
			<div className="ut-info" ref={rootRef}>
				<span className="ut-tag" title={shown.explainer}>
					{shown.label}
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
					<div className="ut-pop text" role="note">
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
 * The vault's spend: dollars lead (2 dp, the exact 4 dp figure on hover) and the ledger's own unit, usertokens,
 * follows on the line below, with an info button that gives the key to the unit.
 */
function SpendFact(props: { spentUt: number }): React.JSX.Element {
	const { open, toggle, rootRef } = usePopover();
	return (
		<div className="ut-fact" title="The cost of every llm_call record in the vault">
			<b>Spend</b>
			<span className="v" title={formatUsd(props.spentUt)}>
				{formatUsdTotal(props.spentUt)}
			</span>
			<div className="ut-info" ref={rootRef}>
				<span className="ut-sub mono">{formatUt(props.spentUt)}</span>
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
					<div className="ut-pop text start" role="note">
						{UT_KEY}
					</div>
				)}
			</div>
			<span className="ut-sub">llm calls · whole vault</span>
		</div>
	);
}

export function BudgetFact(props: { s: SummaryPayload }): React.JSX.Element {
	const { s } = props;
	const budget = budgetDisplay(s);
	const word = budgetSourceWord(s.budgetSource);
	return (
		<div className="ut-fact budget" title={s.budgetProvenance}>
			<b>
				Budget
				<span className="ut-mark" data-tone={word.tone}>
					{word.word}
				</span>
			</b>
			{budget.kind === "known" && s.budget !== null && s.remainingUt !== null ? (
				<>
					<span className="v">
						{budget.leftPct.toFixed(1)}% <small>left</small>
					</span>
					{/* Decorative: the figure above it carries the number. The fill is what is LEFT, the same figure, so it drains as money is spent. */}
					<div className="ut-meter" aria-hidden="true">
						<i style={{ width: `${budget.leftPct}%`, background: `var(--${budget.fill})` }} />
					</div>
					{s.remainingUt < 0 ? (
						<>
							<span
								className="ut-why red"
								title={`overspent by ${formatUsd(-s.remainingUt)} of ${formatUsd(s.budget)}`}
							>
								overspent by {formatUsdTotal(-s.remainingUt)} of {formatUsdTotal(s.budget)}
							</span>
							<span className="ut-sub mono">
								{formatUt(-s.remainingUt)} of {formatUt(s.budget)}
							</span>
						</>
					) : (
						<>
							<span
								className="ut-amts"
								title={`${formatUsd(s.remainingUt)} of ${formatUsd(s.budget)}`}
							>
								{formatUsdTotal(s.remainingUt)} of {formatUsdTotal(s.budget)}
							</span>
							<span className="ut-sub mono">
								{formatUt(s.remainingUt)} of {formatUt(s.budget)}
							</span>
						</>
					)}
					<span className="ut-why">{budgetAsOf(s)}</span>
				</>
			) : (
				<>
					<span className="v na">no remaining figure</span>
					<span className={`ut-why${s.budgetSource === "unreadable" ? " info" : ""}`}>
						{s.budgetProvenance.replace(/^unknown: /, "")}
					</span>
				</>
			)}
		</div>
	);
}

export function SummaryStrip(props: {
	summary: SummaryPayload | null;
	live: LiveState;
}): React.JSX.Element {
	const s = props.summary;
	// Phone only: the Chain and Anchor facts sit behind a button. Elsewhere every fact shows and the button does not.
	const [detailsOpen, setDetailsOpen] = useState(false);
	const detailsRef = useRef<HTMLButtonElement>(null);
	// Escape closes the disclosure from the button or from inside it, unless the anchor explainer is open (it takes the
	// first Escape), and puts focus back on the button.
	const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
		if (e.key !== "Escape" || !detailsOpen) return;
		if (e.target !== detailsRef.current && e.currentTarget.querySelector(".ut-pop") !== null)
			return;
		setDetailsOpen(false);
		detailsRef.current?.focus();
	};
	if (!s)
		return (
			<>
				<TopBar vaultPath={null} live={props.live} kit={false} />
				<section className="ut-facts" aria-busy="true" aria-label="vault summary loading">
					{["Spend", "Budget", "Chain", "Integrity", "Anchor file"].map((label) => (
						<div
							key={label}
							className={
								label === "Chain" || label === "Anchor file" ? "ut-fact detail" : "ut-fact"
							}
						>
							<b>{label}</b>
							<span className="v na">…</span>
						</div>
					))}
				</section>
			</>
		);
	const status = chainStatus(s.chain);
	const notice = windowNotice(s);

	return (
		<>
			<TopBar vaultPath={s.vaultPath} live={props.live} kit={s.remote.kit} />
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
			{notice !== null && (
				<div className="ut-notice" role="status">
					<b>Window</b>
					{notice}
				</div>
			)}
			<section
				className="ut-facts"
				aria-label="vault summary"
				data-details={detailsOpen}
				onKeyDown={onKeyDown}
			>
				<SpendFact spentUt={s.spentUt} />
				<BudgetFact s={s} />
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
						{s.chain.events.toLocaleString()}{" "}
						<small>{s.chain.events === 1 ? "event" : "events"}</small>
					</span>
				</div>
				<div className="ut-fact">
					<b>Integrity</b>
					{status === "verified" && (
						<span className="ut-pill" data-tone="approve">
							<i />
							verified
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
					<span
						className="ut-why"
						title="The dashboard is a monitor: usertrust verify is the authoritative check of a vault"
					>
						{verifiedAsOf(s.verifiedAt)}
					</span>
				</div>
				<AnchorFact anchorFile={s.anchorFile} />
			</section>
		</>
	);
}
