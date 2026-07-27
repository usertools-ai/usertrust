// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useRef, useState } from "react";
import { type LedgerRow, statusOf } from "../shared/rows.js";

interface VerifyResponse {
	found: boolean;
	valid: boolean;
	receipt: string;
	errors: string[];
}

/**
 * Local styles for the drill-in panel: scrim, slide-in, dotted leaders,
 * thermal receipt frame, delayed verdict reveal. Tokens only — no raw colors
 * (P3). Keyframes are file-local; `.receipt-line` comes from styles.css.
 */
const PANEL_CSS = `
@keyframes rp-scrim-in {
	from { opacity: 0; }
}
@keyframes rp-panel-in {
	from { transform: translateX(24px); opacity: 0; }
}
@keyframes rp-verdict-in {
	from { opacity: 0; }
	to { opacity: 1; }
}
.rp-scrim {
	position: fixed;
	inset: 0;
	z-index: 40;
	border: 0;
	margin: 0;
	padding: 0;
	background: var(--scrim);
	backdrop-filter: blur(2px);
	-webkit-backdrop-filter: blur(2px);
	animation: rp-scrim-in 240ms ease-out both;
	cursor: default;
}
.rp-panel {
	position: fixed;
	top: 0;
	right: 0;
	bottom: 0;
	z-index: 50;
	display: flex;
	flex-direction: column;
	gap: 14px;
	width: 440px;
	max-width: calc(100vw - 24px);
	overflow-y: auto;
	background: var(--panel);
	border-left: 1px solid var(--border);
	box-shadow: var(--shadow);
	padding: 16px;
	animation: rp-panel-in 240ms cubic-bezier(0.32, 0.72, 0, 1) both;
}
.rp-field {
	display: flex;
	align-items: baseline;
}
.rp-label {
	flex: none;
	white-space: nowrap;
	font-family: var(--font-sans);
	font-size: 10px;
	font-weight: 500;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: var(--muted);
}
.rp-leader {
	flex: 1;
	min-width: 16px;
	border-bottom: 1px dotted var(--faint);
	margin: 0 6px 4px;
}
.rp-value {
	max-width: 62%;
	font-size: 12px;
	text-align: right;
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}
.rp-value--hash {
	font-size: 11px;
	word-break: break-all;
}
.rp-receipt {
	overflow-x: auto;
	border-radius: 2px;
	background: var(--bg);
	box-shadow: 0 0 0 1px var(--border), var(--shadow);
	padding: 10px 12px;
	font-family: var(--font-mono);
	font-size: 10px;
	line-height: 1.45;
}
.rp-verdict {
	font-size: 13px;
	font-weight: 700;
	letter-spacing: 0.06em;
	opacity: 0;
	animation: rp-verdict-in 240ms ease-out forwards;
}
@media (prefers-reduced-motion: reduce) {
	.rp-verdict {
		opacity: 1;
	}
}
`;

function Field(props: {
	label: string;
	value: React.ReactNode;
	hash?: boolean;
	tone?: string;
}): React.JSX.Element {
	return (
		<div className="rp-field">
			<dt className="rp-label">{props.label}</dt>
			<span className="rp-leader" aria-hidden="true" />
			<dd
				className={`rp-value${props.hash ? " rp-value--hash" : ""}${props.tone ? ` ${props.tone}` : ""}`}
			>
				{props.value}
			</dd>
		</div>
	);
}

function CopyHash(props: { label: string; hash: string }): React.JSX.Element {
	const [copied, setCopied] = useState(false);
	return (
		<Field
			label={props.label}
			hash
			value={
				<button
					type="button"
					title="copy to clipboard"
					className="cursor-pointer text-right underline decoration-[var(--faint)] decoration-dotted underline-offset-2 hover:decoration-[var(--muted)]"
					onClick={() => {
						navigator.clipboard.writeText(props.hash).catch(() => {});
						setCopied(true);
						setTimeout(() => setCopied(false), 1200);
					}}
				>
					{props.hash}
					{copied && <span className="text-[var(--muted)]"> ✓ copied</span>}
				</button>
			}
		/>
	);
}

export function RowPanel(props: { row: LedgerRow; onClose(): void }): React.JSX.Element {
	const { row, onClose } = props;
	const [verify, setVerify] = useState<VerifyResponse | "loading" | "error" | null>(null);
	const closeRef = useRef<HTMLButtonElement>(null);

	// Initial focus moves into the panel; on close it returns to the invoking row.
	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		closeRef.current?.focus();
		return () => {
			if (opener?.isConnected) opener.focus();
		};
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const runVerify = async (): Promise<void> => {
		if (!row.transferId) return;
		setVerify("loading");
		try {
			const res = await fetch(`/api/verify/${encodeURIComponent(row.transferId)}`);
			setVerify((await res.json()) as VerifyResponse);
		} catch {
			setVerify("error");
		}
	};

	const status = statusOf(row);
	const statusTone =
		status === "failed"
			? "text-[var(--danger)]"
			: status === "pending"
				? "text-[var(--amber)]"
				: undefined;
	const result = verify !== null && verify !== "loading" && verify !== "error" ? verify : null;
	const lines = result ? result.receipt.split("\n") : [];

	return (
		<>
			<style>{PANEL_CSS}</style>
			<button
				type="button"
				className="rp-scrim"
				aria-hidden="true"
				tabIndex={-1}
				onClick={onClose}
			/>
			<aside
				className="rp-panel"
				role="dialog"
				aria-modal="true"
				aria-label={`event detail — ${row.kind} seq ${row.seq ?? "?"}`}
			>
				<header className="flex items-start justify-between gap-2">
					<h2 className="text-[13px] font-semibold tracking-wide">
						{row.kind} · seq {row.seq ?? "?"}
					</h2>
					<button
						ref={closeRef}
						type="button"
						onClick={onClose}
						aria-label="close detail panel"
						className="-m-1 cursor-pointer p-1 text-[var(--muted)] hover:text-[var(--text)]"
					>
						✕
					</button>
				</header>
				<dl className="flex flex-col gap-2">
					<Field label="Timestamp" value={row.ts} />
					<Field label="Actor" value={row.actor} />
					{row.model && <Field label="Model" value={`${row.model} (${row.provider})`} />}
					{row.costUt !== undefined && (
						<Field label="Cost" value={`${row.costUt} UT · $${(row.costUsd ?? 0).toFixed(4)}`} />
					)}
					<Field label="Status" value={status} tone={statusTone} />
					<Field
						label="Integrity"
						value={row.integrity}
						tone={row.integrity === "verified" ? "text-[var(--verify)]" : "text-[var(--danger)]"}
					/>
					{row.transferId && <Field label="Transfer" value={row.transferId} hash />}
					{row.error && <Field label="Error" value={row.error} tone="text-[var(--danger)]" />}
					<CopyHash label="Hash" hash={row.hash} />
					<CopyHash label="Previous hash" hash={row.previousHash} />
					<Field label="Event id" value={row.id} hash />
				</dl>
				{row.transferId ? (
					<button
						type="button"
						onClick={runVerify}
						disabled={verify === "loading"}
						aria-busy={verify === "loading"}
						className="cursor-pointer rounded border border-[var(--verify)] px-3 py-1.5 text-xs text-[var(--verify)] hover:bg-[var(--panel-2)] disabled:cursor-default disabled:opacity-40"
					>
						{verify === "loading" ? "verifying…" : "verify this transaction"}
					</button>
				) : (
					<span className="text-[11px] text-[var(--faint)] italic">
						no transfer id — nothing to verify
					</span>
				)}
				{result && (
					<pre className="rp-receipt">
						{lines.map((line, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: receipt lines are static per response and never reorder
							<span key={i} className="receipt-line" style={{ animationDelay: `${i * 26}ms` }}>
								{`${line}\n`}
							</span>
						))}
					</pre>
				)}
				<div aria-live="polite">
					{verify === "error" && (
						<span className="rp-verdict text-[var(--danger)]">verification request failed</span>
					)}
					{result && (
						<span
							className={`rp-verdict ${result.valid ? "text-[var(--verify)]" : "text-[var(--danger)]"}`}
							style={{ animationDelay: `${lines.length * 26 + 150}ms` }}
						>
							{result.valid
								? "VERIFIED"
								: `FAILED${result.errors.length ? `: ${result.errors[0]}` : ""}`}
						</span>
					)}
				</div>
			</aside>
		</>
	);
}
