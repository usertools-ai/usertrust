// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useRef, useState } from "react";
import type { SummaryPayload } from "../shared/api.js";
import { budgetDisplay, budgetSourceWord } from "../shared/budget-display.js";
import { anchorView, chainStatus, windowNotice } from "../shared/display.js";
import { formatUsd, formatUt, formatUtc, middleTruncate } from "../shared/format.js";
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
			<span className="ut-bword">usertrust</span>
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

/** The explainer a bare "absent" never had: a small popover, toggled by click or keyboard, closed by Escape. */
function AnchorFact(props: { anchorFile: SummaryPayload["anchorFile"] }): React.JSX.Element {
	const shown = anchorView(props.anchorFile);
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
	const [before, after] = shown.explainer.split("usertrust verify --anchors <file>");
	return (
		<div className="ut-fact">
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
					onClick={() => setOpen((o) => !o)}
				>
					i
				</button>
				{open && (
					<div className="ut-pop text" role="note">
						{before}
						<code>usertrust verify --anchors &lt;file&gt;</code>
						{after}
					</div>
				)}
			</div>
		</div>
	);
}

function BudgetFact(props: { s: SummaryPayload }): React.JSX.Element {
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
						{budget.pct.toFixed(1)}% <small>left</small>
					</span>
					{/* Decorative: the figure above it is the value. */}
					<div className="ut-meter" aria-hidden="true">
						<i style={{ width: `${budget.pct}%`, background: `var(--${budget.fill})` }} />
					</div>
					{s.remainingUt < 0 ? (
						<span className="ut-why red">
							overspent by {formatUt(-s.remainingUt)} of {formatUt(s.budget)}
						</span>
					) : (
						<span className="ut-sub mono">
							{formatUt(s.remainingUt)} of {formatUt(s.budget)}
						</span>
					)}
					<span className="ut-why">
						{s.budgetSource === "governor" && s.budgetWrittenAt !== null
							? `published by the governor, as of ${formatUtc(s.budgetWrittenAt)}`
							: s.budgetProvenance}
					</span>
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
	if (!s)
		return (
			<>
				<TopBar vaultPath={null} live={props.live} kit={false} />
				<section className="ut-facts" aria-busy="true" aria-label="vault summary loading">
					{["Spend", "Budget", "Chain", "Integrity", "Anchor file"].map((label) => (
						<div key={label} className="ut-fact">
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
			<section className="ut-facts" aria-label="vault summary">
				<div className="ut-fact" title="The cost of every llm_call record in the vault">
					<b>Spend</b>
					<span className="v">{formatUt(s.spentUt)}</span>
					<span className="ut-sub mono">{formatUsd(s.spentUt)}</span>
					<span className="ut-sub">llm calls · whole vault</span>
				</div>
				<BudgetFact s={s} />
				<div className="ut-fact">
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
				</div>
				<AnchorFact anchorFile={s.anchorFile} />
			</section>
		</>
	);
}
