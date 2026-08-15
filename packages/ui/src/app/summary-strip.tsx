// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { SummaryPayload } from "../shared/api.js";

// Local motion: live-connectivity pulse only. Disabled globally by the
// prefers-reduced-motion override in styles.css (stylesheet !important wins).
const stripCss = `
@keyframes strip-pulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.4; }
}
.live-pulse { animation: strip-pulse 2s ease-in-out infinite; }
`;

function Stat(props: {
	label: string;
	value: React.ReactNode;
	tone?: "ok" | "bad";
}): React.JSX.Element {
	// Green is EARNED by verification — "ok" is used only by the Integrity stat.
	const tone =
		props.tone === "ok"
			? "text-[var(--verify)]"
			: props.tone === "bad"
				? "text-[var(--danger)]"
				: "";
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[10px] uppercase tracking-wide text-[var(--muted)] [font-family:var(--font-sans)]">
				{props.label}
			</span>
			<span className={`text-[15px] font-medium tabular-nums ${tone}`}>{props.value}</span>
		</div>
	);
}

export function SummaryStrip(props: {
	summary: SummaryPayload | null;
	live: boolean;
}): React.JSX.Element {
	const s = props.summary;
	if (!s)
		return (
			<div className="reveal reveal-1">
				<div className="h-16 rounded-t-md border border-b-0 border-[var(--border)] bg-[var(--panel)]" />
				<div className="perforation" />
			</div>
		);
	const pct = s.budget > 0 ? Math.max(0, Math.min(100, (s.remainingUt / s.budget) * 100)) : 0;
	// Healthy budget is --chart (connectivity-neutral), never green: amber under
	// 20% remaining, danger under 5%.
	const frac = s.budget > 0 ? s.remainingUt / s.budget : 0;
	const budgetFill = frac > 0.2 ? "var(--chart)" : frac >= 0.05 ? "var(--amber)" : "var(--danger)";

	return (
		<div className="reveal reveal-1 flex flex-col gap-2">
			<style>{stripCss}</style>
			{!s.chain.valid && (
				<div className="flex flex-col gap-1 rounded border border-[var(--danger)] bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger)]">
					<span>
						⚠ CHAIN INTEGRITY FAILURE — tampering or corruption detected
						{s.chain.breakIndex !== null && ` (break at chain position ${s.chain.breakIndex + 1})`}
					</span>
					{s.chain.errors.slice(0, 3).map((err) => (
						<span key={err} className="text-[11px] opacity-90">
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
			<div>
				<div className="rounded-t-md border border-b-0 border-[var(--border)] bg-[var(--panel)] px-4 pt-2.5 pb-3">
					<span className="text-[10px] tracking-[0.3em] text-[var(--faint)]">
						USERTRUST · LEDGER
					</span>
					<div className="mt-2 flex items-center gap-6">
						<Stat
							label="Spend"
							value={`${s.spentUt.toLocaleString()} UT · $${(s.spentUt * 0.0001).toFixed(2)}`}
						/>
						<div className="flex w-48 flex-col gap-1">
							<span className="text-[10px] uppercase tracking-wide text-[var(--muted)] [font-family:var(--font-sans)]">
								Budget remaining{s.budget > 0 ? ` ${pct.toFixed(1)}%` : ""}
							</span>
							{s.budget > 0 ? (
								<div className="h-1.5 rounded bg-[var(--bg)]">
									<div
										className="h-1.5 rounded"
										style={{ width: `${pct}%`, background: budgetFill }}
									/>
								</div>
							) : (
								<span className="text-xs italic text-[var(--faint)]">no budget set</span>
							)}
						</div>
						<Stat label="Chain" value={`${s.chain.events.toLocaleString()} events`} />
						<Stat
							label="Integrity"
							value={s.chain.valid ? "verified" : "BROKEN"}
							tone={s.chain.valid ? "ok" : "bad"}
						/>
						<Stat
							label="Anchor file"
							value={
								<span className="rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] font-normal text-[var(--muted)]">
									{s.anchorFile}
								</span>
							}
						/>
						<div className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
							<span
								className={`inline-block h-2 w-2 rounded-full ${
									props.live ? "live-pulse bg-[var(--chart)]" : "bg-[var(--faint)]"
								}`}
							/>
							{props.live ? "live" : "offline"}
						</div>
					</div>
				</div>
				<div className="perforation" />
			</div>
		</div>
	);
}
