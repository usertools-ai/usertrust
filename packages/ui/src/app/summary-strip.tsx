// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { SummaryPayload } from "../shared/api.js";

function Stat(props: {
	label: string;
	value: React.ReactNode;
	tone?: "ok" | "bad";
}): React.JSX.Element {
	const tone =
		props.tone === "ok"
			? "text-[var(--accent)]"
			: props.tone === "bad"
				? "text-[var(--danger)]"
				: "";
	return (
		<div className="flex flex-col">
			<span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{props.label}</span>
			<span className={`text-sm font-semibold ${tone}`}>{props.value}</span>
		</div>
	);
}

export function SummaryStrip(props: {
	summary: SummaryPayload | null;
	live: boolean;
}): React.JSX.Element {
	const s = props.summary;
	if (!s) return <div className="h-14 rounded border border-[var(--border)] bg-[var(--panel)]" />;
	const pct = s.budget > 0 ? Math.max(0, Math.min(100, (s.remainingUt / s.budget) * 100)) : 0;

	return (
		<div className="flex flex-col gap-2">
			{!s.chain.valid && (
				<div className="flex flex-col gap-1 rounded border border-[var(--danger)] bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger)]">
					<span>
						⚠ CHAIN INTEGRITY FAILURE — tampering or corruption detected
						{s.chain.breakIndex !== null && ` (break at chain position ${s.chain.breakIndex + 1})`}
					</span>
					{s.chain.errors.slice(0, 3).map((err) => (
						<span key={err} className="font-mono text-xs opacity-90">
							{err}
						</span>
					))}
					{s.chain.errors.length > 3 && (
						<span className="text-xs opacity-75">…and {s.chain.errors.length - 3} more</span>
					)}
				</div>
			)}
			{s.truncated && (
				<div className="rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-xs text-[var(--muted)]">
					Showing the most recent {s.rowCount.toLocaleString()} of {s.chain.events.toLocaleString()}{" "}
					events.
				</div>
			)}
			<div className="flex items-center gap-6 rounded border border-[var(--border)] bg-[var(--panel)] px-4 py-2">
				<Stat
					label="Spend"
					value={`${s.spentUt.toLocaleString()} UT · $${(s.spentUt * 0.0001).toFixed(2)}`}
				/>
				<div className="flex w-48 flex-col gap-1">
					<span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
						Budget remaining {s.budget > 0 ? `${pct.toFixed(1)}%` : "—"}
					</span>
					<div className="h-1.5 rounded bg-[var(--bg)]">
						<div className="h-1.5 rounded bg-[var(--accent)]" style={{ width: `${pct}%` }} />
					</div>
				</div>
				<Stat label="Chain" value={`${s.chain.events.toLocaleString()} events`} />
				<Stat
					label="Integrity"
					value={s.chain.valid ? "verified" : "BROKEN"}
					tone={s.chain.valid ? "ok" : "bad"}
				/>
				<Stat label="Anchor" value={s.anchorState} />
				<div className="ml-auto flex items-center gap-1 text-xs text-[var(--muted)]">
					<span
						className={`inline-block h-2 w-2 rounded-full ${props.live ? "bg-[var(--accent)]" : "bg-[var(--muted)]"}`}
					/>
					{props.live ? "live" : "offline"}
				</div>
			</div>
		</div>
	);
}
