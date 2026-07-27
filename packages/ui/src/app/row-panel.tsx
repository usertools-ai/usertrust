// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useState } from "react";
import { type LedgerRow, statusOf } from "../shared/rows.js";

interface VerifyResponse {
	found: boolean;
	valid: boolean;
	receipt: string;
	errors: string[];
}

function Field(props: {
	label: string;
	value: React.ReactNode;
	mono?: boolean;
}): React.JSX.Element {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{props.label}</dt>
			<dd className={`break-all text-xs ${props.mono ? "font-mono" : ""}`}>{props.value}</dd>
		</div>
	);
}

function CopyHash(props: { label: string; hash: string }): React.JSX.Element {
	const [copied, setCopied] = useState(false);
	return (
		<Field
			label={props.label}
			mono
			value={
				<button
					type="button"
					className="text-left hover:text-[var(--accent)]"
					onClick={() => {
						navigator.clipboard.writeText(props.hash).catch(() => {});
						setCopied(true);
						setTimeout(() => setCopied(false), 1200);
					}}
				>
					{props.hash} {copied ? "✓ copied" : ""}
				</button>
			}
		/>
	);
}

export function RowPanel(props: { row: LedgerRow; onClose(): void }): React.JSX.Element {
	const { row } = props;
	const [verify, setVerify] = useState<VerifyResponse | "loading" | "error" | null>(null);

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

	return (
		<aside className="fixed inset-y-0 right-0 z-10 flex w-[420px] flex-col gap-3 overflow-y-auto border-l border-[var(--border)] bg-[var(--panel)] p-4">
			<div className="flex items-center justify-between">
				<h2 className="text-sm font-semibold">
					{row.kind} · seq {row.seq ?? "?"}
				</h2>
				<button
					type="button"
					onClick={props.onClose}
					className="text-[var(--muted)] hover:text-[var(--text)]"
				>
					✕
				</button>
			</div>
			<dl className="flex flex-col gap-2">
				<Field label="Timestamp" value={row.ts} mono />
				<Field label="Actor" value={row.actor} />
				{row.model && <Field label="Model" value={`${row.model} (${row.provider})`} />}
				{row.costUt !== undefined && (
					<Field label="Cost" value={`${row.costUt} UT · $${(row.costUsd ?? 0).toFixed(4)}`} />
				)}
				<Field label="Status" value={statusOf(row)} />
				<Field label="Integrity" value={row.integrity} />
				{row.transferId && <Field label="Transfer" value={row.transferId} mono />}
				{row.error && <Field label="Error" value={row.error} />}
				<CopyHash label="Hash" hash={row.hash} />
				<CopyHash label="Previous hash" hash={row.previousHash} />
				<Field label="Event id" value={row.id} mono />
			</dl>
			<button
				type="button"
				onClick={runVerify}
				disabled={!row.transferId || verify === "loading"}
				className="rounded border border-[var(--accent)] px-3 py-1.5 text-sm text-[var(--accent)] disabled:opacity-40"
			>
				{verify === "loading" ? "Verifying…" : "Verify this transaction"}
			</button>
			{verify === "error" && (
				<span className="text-sm font-semibold text-[var(--danger)]">
					verification request failed
				</span>
			)}
			{verify !== null && verify !== "loading" && verify !== "error" && (
				<div className="flex flex-col gap-2">
					<span
						className={`text-sm font-semibold ${verify.valid ? "text-[var(--accent)]" : "text-[var(--danger)]"}`}
					>
						{verify.valid
							? "VERIFIED"
							: `FAILED${verify.errors.length ? `: ${verify.errors[0]}` : ""}`}
					</span>
					<pre className="overflow-x-auto rounded bg-[var(--bg)] p-2 font-mono text-[10px] leading-tight">
						{verify.receipt}
					</pre>
				</div>
			)}
		</aside>
	);
}
