// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useRef, useState } from "react";
import { costView, transferView, usageView } from "../shared/display.js";
import { formatUtc, UT_KEY } from "../shared/format.js";
import { JOB_TYPE_CAVEAT, type LedgerRow, statusOf } from "../shared/rows.js";
import { type Held, heldFor, type VerifyOutcome, verifyOutcome } from "../shared/verify-view.js";
import { STATUS_TONE } from "./audit-table.js";

/** The badge tone as a pill tone: the pill colours only the loud states. */
function pillTone(tone: string | undefined): string | undefined {
	return tone === "stakes" || tone === "info" || tone === "alert" ? tone : undefined;
}

function CopyHash(props: { hash: string }): React.JSX.Element {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			title="copy to clipboard"
			className="ut-copy"
			onClick={() => {
				navigator.clipboard.writeText(props.hash).catch(() => {});
				setCopied(true);
				setTimeout(() => setCopied(false), 1200);
			}}
		>
			{props.hash}
			{copied && <span className="done">copied</span>}
		</button>
	);
}

function Verdict(props: { outcome: VerifyOutcome; delayMs: number }): React.JSX.Element {
	const { outcome } = props;
	const style = { animationDelay: `${props.delayMs}ms` };
	switch (outcome.kind) {
		case "verified":
			return (
				<div className="ut-verdict" style={style}>
					<span className="ut-pill" data-tone="approve">
						<i />
						verified
					</span>
				</div>
			);
		case "failed":
			return (
				<div className="ut-verdict" style={style}>
					<span className="ut-pill" data-tone="stakes">
						<i />
						failed
					</span>
					{outcome.reason !== undefined && <span className="ut-why red">{outcome.reason}</span>}
				</div>
			);
		case "not-found":
			return (
				<div className="ut-verdict" style={style}>
					<span className="ut-pill" data-tone="info">
						<i />
						not found
					</span>
					<span className="ut-why">
						This transaction is in none of the vault's audit segments (events.jsonl and any rotated
						segment), the records the verifier reads. Not finding it is not a failed check.
						{outcome.reason !== undefined && ` ${outcome.reason}.`}
					</span>
				</div>
			);
		case "request-failed":
			return (
				<div className="ut-verdict" style={style}>
					<span className="ut-pill" data-tone="info">
						<i />
						not checked
					</span>
					<span className="ut-why info">The verification request failed: {outcome.reason}</span>
				</div>
			);
	}
}

/**
 * The selected row. Docked beside the list on a wide screen (a region, the list stays usable); otherwise a modal
 * drawer, a bottom sheet on a phone, that takes focus and returns it to the row on close.
 */
export function RowPanel(props: {
	row: LedgerRow;
	docked: boolean;
	/** `returnFocus`: focus was in the inspector (or nowhere), so it goes back to the row the inspector showed. */
	onClose(returnFocus: boolean): void;
	/**
	 * Set (to a number that changes on each request) when the row was opened with the keyboard: a docked inspector then
	 * takes focus on its heading. Unset for a click, which leaves focus where it is.
	 */
	focusNonce?: number;
	/** Called once the heading has taken focus for a request, so the request is cleared and a later remount (another
	 * view and back) does not replay it and take focus from wherever the reader is. */
	onFocusHandled?: () => void;
}): React.JSX.Element {
	const { row, docked, onClose, focusNonce, onFocusHandled } = props;
	// A verify response is held for the row VERSION it was requested for (the row object: a status correction replaces
	// it) and shown only while the row is still that version. Clearing the panel when the status changed ran BEFORE an
	// in-flight response landed, so the earlier status's receipt was then shown beside the corrected status.
	const [verify, setVerify] = useState<Held<LedgerRow, VerifyOutcome | "loading"> | null>(null);
	const shown = heldFor(verify, row);
	const closeRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLElement>(null);
	const verdictRef = useRef<HTMLElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);

	// Enter or Space on a row opens it here: focus goes to the heading (a tabindex of -1: reachable by script, not a tab
	// stop), so the next Tab lands on the inspector's own controls, not 20 rows away.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per request (the nonce), not when docking changes
	useEffect(() => {
		if (!docked || focusNonce === undefined) return;
		headingRef.current?.focus();
		onFocusHandled?.();
	}, [focusNonce]);

	// A modal panel takes focus, and returns it to the invoking row on close. A docked one leaves it on the row.
	useEffect(() => {
		if (docked) return;
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		closeRef.current?.focus();
		return () => {
			if (opener?.isConnected) opener.focus();
		};
	}, [docked]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				// An open popover (a filter's choices, the anchor explainer) owns this Escape: it closes, the inspector stays.
				if (document.querySelector('button[aria-expanded="true"]') !== null) return;
				const active = document.activeElement;
				const inside =
					active === null ||
					active === document.body ||
					panelRef.current?.contains(active) === true;
				// A modal panel returns focus on its own (below); a docked one hands it back to its row. Focus in the search box
				// or elsewhere stays there: closing must not take it.
				onClose(docked && inside);
				return;
			}
			// aria-modal promises modality: keep Tab cycling inside the panel.
			if (!docked && e.key === "Tab" && panelRef.current) {
				const focusables = panelRef.current.querySelectorAll<HTMLElement>(
					"button, [href], input, [tabindex]:not([tabindex='-1'])",
				);
				if (focusables.length === 0) return;
				const first = focusables[0] as HTMLElement;
				const last = focusables[focusables.length - 1] as HTMLElement;
				const active = document.activeElement;
				if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		// Capture: this sees Escape before a popover's own listener closes it, whichever of them was registered first.
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [onClose, docked]);

	const runVerify = async (): Promise<void> => {
		const forRow = row;
		if (forRow.transferId === undefined) return;
		setVerify({ row: forRow, value: "loading" });
		let outcome: VerifyOutcome;
		try {
			const res = await fetch(`/api/verify/${encodeURIComponent(forRow.transferId)}`);
			// A 500 (an audit segment that cannot be read) carries `{ error }`, not a receipt, and a proxy's page is not JSON:
			// verifyOutcome makes either a failed request ("not checked"), never a receipt read off the wrong body.
			const body: unknown = await res.json().catch(() => null);
			outcome = verifyOutcome(res.status, body);
		} catch (err) {
			outcome = {
				kind: "request-failed",
				reason: err instanceof Error ? err.message : String(err),
			};
		}
		// Kept for the version it was requested for; a newer request (a newer version) is never overwritten.
		setVerify((held) => (held?.row === forRow ? { row: forRow, value: outcome } : held));
	};

	const status = statusOf(row);
	const cost = costView(row);
	const usage = usageView(row);
	const tx = transferView(row);
	const result = shown !== null && shown !== "loading" ? shown : null;

	// The receipt and verdict land below the button, often below the panel's fold: bring them into view.
	useEffect(() => {
		if (result === null) return;
		const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		verdictRef.current?.scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" });
	}, [result]);
	const lines =
		result !== null && result.kind !== "request-failed" ? result.receipt.split("\n") : [];

	const body = (
		<div className="ut-insp-in">
			<div className="ut-dhead">
				<div>
					<h2 ref={headingRef} tabIndex={-1}>
						{row.model ?? row.kind}
					</h2>
					<div className="ut-dkind">
						{row.kind} · seq {row.seq ?? "?"} · {formatUtc(row.ts)}
					</div>
				</div>
				<button
					ref={closeRef}
					type="button"
					className="ut-x"
					onClick={() => onClose(true)}
					aria-label="close the inspector"
				>
					✕
				</button>
			</div>
			<div className="ut-pills">
				<span className="ut-pill" data-tone={pillTone(STATUS_TONE[status])}>
					<i />
					{status}
				</span>
				{row.integrity === "verified" ? (
					<span
						className="ut-pill"
						data-tone="approve"
						title="hash chain verified up to this record"
					>
						<i />
						chain verified
					</span>
				) : (
					<span className="ut-pill" data-tone="stakes">
						<i />
						after break
					</span>
				)}
			</div>
			<section className="ut-sec">
				<div className="ut-lbl">Call</div>
				<dl className="ut-dl">
					<dt>Time</dt>
					<dd className="m">{row.ts}</dd>
					<dt>Actor</dt>
					<dd className="m">{row.actor}</dd>
					{row.model !== undefined && (
						<>
							<dt>Model</dt>
							<dd>
								{row.model} <span className="ut-sub mono">{row.provider}</span>
							</dd>
						</>
					)}
					<dt>Kind</dt>
					<dd className="m">{row.kind}</dd>
					{row.source !== undefined && (
						<>
							<dt>Source</dt>
							<dd>{row.source}</dd>
						</>
					)}
					{row.job !== undefined && (
						<>
							<dt>Job</dt>
							<dd className="m">{row.job}</dd>
						</>
					)}
					{row.jobType !== undefined && (
						<>
							<dt>Job type</dt>
							<dd>
								{row.jobType}{" "}
								<span className="ut-sub mono">
									({JOB_TYPE_CAVEAT}
									{row.typeSource !== undefined && `; declared by ${row.typeSource}`})
								</span>
							</dd>
						</>
					)}
					{row.error !== undefined && (
						<>
							<dt>Error</dt>
							<dd className="red">{row.error}</dd>
						</>
					)}
				</dl>
			</section>
			<section className="ut-sec">
				<div className="ut-lbl">Cost</div>
				{cost === null ? (
					<div className="ut-rcpt">
						<span>Cost</span>
						<span className="dots" />
						<span className="v na">not recorded</span>
					</div>
				) : (
					<>
						<div className="ut-rcpt">
							<span>Dollars</span>
							<span className="dots" />
							<span className="v">{cost.usd}</span>
						</div>
						<div className="ut-rcpt">
							<span>Usertokens</span>
							<span className="dots" />
							<span className="v">{cost.ut}</span>
						</div>
						<div className="ut-key">{UT_KEY}</div>
						<div className="ut-rcpt">
							<span>Usage</span>
							<span className="dots" />
							<span className={`v${usage.tone === "ink" ? "" : ` ${usage.tone}`}`}>
								{usage.text}
							</span>
						</div>
					</>
				)}
			</section>
			<section className="ut-sec">
				<div className="ut-lbl">Chain</div>
				<dl className="ut-dl">
					<dt>Transfer</dt>
					{tx.kind === "transfer" ? <dd className="m">{tx.id}</dd> : <dd className="na">none</dd>}
					<dt>Event id</dt>
					<dd className="m">{row.id}</dd>
					<dt>Hash</dt>
					<dd>
						<CopyHash hash={row.hash} />
					</dd>
					<dt>Previous</dt>
					<dd>
						<CopyHash hash={row.previousHash} />
					</dd>
				</dl>
			</section>
			<section className="ut-sec" ref={verdictRef}>
				<div className="ut-lbl">Independent verification</div>
				{tx.kind === "transfer" ? (
					<>
						<span className="ut-why">
							Runs the usertrust-verify check for this transfer and prints its receipt.
						</span>
						<button
							type="button"
							className="ut-verify"
							onClick={runVerify}
							disabled={shown === "loading"}
							aria-busy={shown === "loading"}
						>
							{shown === "loading" ? "verifying…" : "verify this transaction"}
						</button>
					</>
				) : (
					<span className="ut-why">No transfer id: there is no transaction to verify.</span>
				)}
				{lines.length > 0 && (
					<pre className="ut-receipt">
						{lines.map((line, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: receipt lines are static per response and never reorder
							<span key={i} className="ut-receipt-line" style={{ animationDelay: `${i * 26}ms` }}>
								{`${line}\n`}
							</span>
						))}
					</pre>
				)}
				<div aria-live="polite">
					{result !== null && <Verdict outcome={result} delayMs={lines.length * 26 + 150} />}
				</div>
			</section>
		</div>
	);

	if (docked)
		return (
			<aside
				ref={panelRef}
				className="ut-insp"
				aria-label={`transaction ${row.kind} seq ${row.seq ?? "?"}`}
			>
				{body}
			</aside>
		);
	return (
		<>
			<button
				type="button"
				className="ut-scrim"
				aria-hidden="true"
				tabIndex={-1}
				onClick={() => onClose(false)}
			/>
			<aside
				ref={panelRef}
				className="ut-drawer"
				role="dialog"
				aria-modal="true"
				aria-label={`transaction ${row.kind} seq ${row.seq ?? "?"}`}
			>
				{body}
			</aside>
		</>
	);
}

/** The docked inspector before a row is selected: what it will hold. */
export function InspectorHint(): React.JSX.Element {
	return (
		<aside className="ut-insp" aria-label="transaction inspector">
			<div className="ut-hint">
				<b>Select a record</b>
				Its call, its cost and its place on the chain show here, with an independent verification of
				its receipt.
			</div>
		</aside>
	);
}
