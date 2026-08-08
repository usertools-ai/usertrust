"use client";

import { useId, useState } from "react";
import { formatUsertokens, usdFromUsertokens } from "@/components/receipt/format";
import { computeRace, pct, raceBounds, raceDefaults } from "@/lib/budget-race";
import { THROWN_DENIAL } from "@/lib/exhibit-c-data";

type Mode = "none" | "holds";

const fmt = formatUsertokens;

function Term({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
	const valueColor = tone === "ok" ? "text-ut" : tone === "bad" ? "text-danger" : "text-white";
	return (
		<span className="inline-flex flex-col">
			<span className="font-mono text-[11px] uppercase tracking-widest text-tim/80">{label}</span>
			<span className={`font-mono text-xl tabular-nums ${valueColor}`}>{value}</span>
		</span>
	);
}

/**
 * THE BUDGET RACE — Exhibit C's parametric instrument (Addendum C3).
 * Sliders drive live two-phase math; the equation and the bar re-render
 * synchronously on input. All bounds/defaults derive from the budget prop
 * via lib/budget-race — no digit literals in this file beyond sanctioned
 * zeros in comparisons.
 */
export default function ExhibitCRace({ budget }: { budget: number }) {
	const bounds = raceBounds(budget);
	const defaults = raceDefaults(budget);
	const [agents, setAgents] = useState(defaults.agents);
	const [costPerCall, setCostPerCall] = useState(defaults.costPerCall);
	const [mode, setMode] = useState<Mode>("holds");
	const agentsId = useId();
	const costId = useId();

	// Pure, deterministic math — identical on server and client, so hydration
	// enhances the precomputed markup in place.
	const race = computeRace(budget, agents, costPerCall);
	const scale = Math.max(race.settledTotal, budget);
	const holdsMode = mode === "holds";
	const okHolds = race.holds.filter((h) => !h.blocked);

	return (
		<div className="border border-white/15 bg-white/[0.02] p-6 sm:p-8">
			{/* Controls — native ranges, labeled, keyboard-accessible by construction. */}
			<div className="grid gap-6 sm:grid-cols-2">
				<div>
					<label
						htmlFor={agentsId}
						className="font-mono text-xs uppercase tracking-widest text-white/60"
					>
						concurrent agents
					</label>
					<div className="mt-2 flex items-center gap-4">
						<input
							id={agentsId}
							type="range"
							min={bounds.agentsMin}
							max={bounds.agentsMax}
							step={bounds.agentsStep}
							value={agents}
							onChange={(e) => setAgents(e.currentTarget.valueAsNumber)}
							className="focus-ring w-full accent-ut"
						/>
						<output
							htmlFor={agentsId}
							className="w-10 shrink-0 text-right font-mono text-sm tabular-nums text-white"
						>
							{agents}
						</output>
					</div>
				</div>
				<div>
					<label
						htmlFor={costId}
						className="font-mono text-xs uppercase tracking-widest text-white/60"
					>
						est. cost per call
					</label>
					<div className="mt-2 flex items-center gap-4">
						<input
							id={costId}
							type="range"
							min={bounds.costMin}
							max={bounds.costMax}
							step={bounds.costStep}
							value={costPerCall}
							onChange={(e) => setCostPerCall(e.currentTarget.valueAsNumber)}
							className="focus-ring w-full accent-ut"
						/>
						<output
							htmlFor={costId}
							className="w-24 shrink-0 text-right font-mono text-sm tabular-nums text-white"
						>
							{fmt(costPerCall)}
						</output>
					</div>
				</div>
			</div>

			{/* Mode toggle — aria-pressed drives both semantics and styling. A real
			    <fieldset>/<legend> rather than role="group" on a div: same grouping
			    semantics with no ARIA needed (biome's useSemanticElements rule). */}
			<fieldset className="mt-6 flex gap-2">
				<legend className="sr-only">enforcement mode</legend>
				<button
					type="button"
					aria-pressed={!holdsMode}
					onClick={() => setMode("none")}
					className="focus-ring min-h-[44px] border border-white/15 px-4 py-2 font-mono text-sm text-white/50 transition-colors hover:text-white/80 aria-pressed:border-ut/60 aria-pressed:bg-ut/10 aria-pressed:text-white"
				>
					without holds
				</button>
				<button
					type="button"
					aria-pressed={holdsMode}
					onClick={() => setMode("holds")}
					className="focus-ring min-h-[44px] border border-white/15 px-4 py-2 font-mono text-sm text-white/50 transition-colors hover:text-white/80 aria-pressed:border-ut/60 aria-pressed:bg-ut/10 aria-pressed:text-white"
				>
					two-phase holds
				</button>
			</fieldset>

			{/* The equation — real math, live values. Without holds, Σ(holds) is
			    zero: the ledger never sees the race. That is the indictment. */}
			<div className="mt-8 flex flex-wrap items-end gap-x-4 gap-y-2">
				<Term
					label="available"
					value={fmt(holdsMode ? race.available : budget)}
					tone={holdsMode ? "ok" : undefined}
				/>
				<span aria-hidden="true" className="font-mono text-xl text-white/40">
					=
				</span>
				<Term label="budget" value={fmt(budget)} />
				<span aria-hidden="true" className="font-mono text-xl text-white/40">
					−
				</span>
				<Term label="Σ(holds)" value={fmt(holdsMode ? race.heldTotal : 0)} />
			</div>
			{!holdsMode && (
				<p className="mt-2 font-mono text-xs text-white/50">
					no holds were placed — the equation cannot see the race.
				</p>
			)}

			{/* Bar instrument — hairline quarter grid; segments snap, no tweens. */}
			<div className="mt-6">
				<div className="relative h-9 w-full overflow-hidden border border-white/15 bg-white/[0.03]">
					<div
						aria-hidden="true"
						className="absolute inset-y-0 border-l border-white/10"
						style={{ left: "25%" }}
					/>
					<div
						aria-hidden="true"
						className="absolute inset-y-0 border-l border-white/10"
						style={{ left: "50%" }}
					/>
					<div
						aria-hidden="true"
						className="absolute inset-y-0 border-l border-white/10"
						style={{ left: "75%" }}
					/>
					{holdsMode ? (
						<div className="flex h-full">
							{okHolds.map((h) => (
								<div
									key={h.label}
									style={{ width: pct(costPerCall / budget) }}
									className="h-full border-r border-brand-bg bg-ut/60"
								/>
							))}
						</div>
					) : (
						<div className="flex h-full">
							{race.settles.map((s) => (
								<div
									key={s.label}
									style={{ width: pct(costPerCall / scale) }}
									className={`h-full border-r border-brand-bg ${s.pastCap ? "bg-danger/70" : "bg-tim/50"}`}
								/>
							))}
						</div>
					)}
					{!holdsMode && (
						<div
							aria-hidden="true"
							className="absolute inset-y-0 w-px bg-white"
							style={{ left: pct(budget / scale) }}
						/>
					)}
				</div>
				<p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-white/40">
					{holdsMode
						? "budget bar — holds stack. the cap is the wall."
						: "budget bar — the white line is the cap. red is past it."}
				</p>
			</div>

			{/* Rows — every attempt, in ledger order. */}
			<ul className="mt-5 space-y-1.5">
				{holdsMode ? (
					<>
						{okHolds.map((h) => (
							<li
								key={h.label}
								className="flex items-baseline gap-3 font-mono text-xs text-white/70"
							>
								<span className="w-28 shrink-0 text-white/45">{h.label}</span>
								<span
									aria-hidden="true"
									className="flex-1 border-b border-dashed border-white/10"
								/>
								<span className="tabular-nums">hold {fmt(costPerCall)}</span>
								<span className="text-ut">held</span>
							</li>
						))}
						{race.firstBlocked && (
							<li className="mt-3 border border-danger/40 bg-danger/[0.06] px-3 py-2 font-mono text-xs leading-5">
								<span className="text-white/45">{race.firstBlocked.label}</span>{" "}
								<span className="font-bold text-danger">✗ {THROWN_DENIAL.name}</span>
								<span className="text-white/70">: hold would exceed available budget</span>
								<span className="mt-1 block tabular-nums text-white/50">
									hold {fmt(costPerCall)} &gt; available {fmt(race.available)} — nothing moved,
									nothing owed
								</span>
							</li>
						)}
						{race.extraDenied > 0 && (
							<li className="font-mono text-xs text-white/40">
								+ {race.extraDenied} more denied — the ledger's answer does not change
							</li>
						)}
						{!race.firstBlocked && (
							<li className="font-mono text-xs text-white/50">
								every hold fit — {fmt(race.available)} still available. push the race harder.
							</li>
						)}
					</>
				) : (
					race.settles.map((s) => (
						<li
							key={s.label}
							className={`flex items-baseline gap-3 font-mono text-xs ${s.pastCap ? "text-danger" : "text-white/70"}`}
						>
							<span className={`w-28 shrink-0 ${s.pastCap ? "text-danger/80" : "text-white/45"}`}>
								{s.label}
							</span>
							<span aria-hidden="true" className="flex-1 border-b border-dashed border-white/10" />
							<span className="tabular-nums">settled {fmt(costPerCall)}</span>
							<span className="tabular-nums">total {fmt(s.totalAfter)}</span>
						</li>
					))
				)}
			</ul>

			{/* Total line */}
			{holdsMode ? (
				<p className="mt-4 border-t border-white/15 pt-3 font-mono text-sm tabular-nums text-white/70">
					held {fmt(race.heldTotal)} of {fmt(budget)} — the bar never passes the cap.
				</p>
			) : (
				<p
					className={`mt-4 border-t border-white/15 pt-3 font-mono text-sm tabular-nums ${race.overshoot > 0 ? "text-danger" : "text-white/70"}`}
				>
					{race.overshoot > 0
						? `total settled ${fmt(race.settledTotal)} — ${fmt(race.overshoot)} past the ${usdFromUsertokens(budget)} budget. it surfaces on the invoice.`
						: `total settled ${fmt(race.settledTotal)} — under budget this time. nothing enforced that.`}
				</p>
			)}

			{/* Screen-reader status — values snap; announce the state, not a stream. */}
			<p aria-live="polite" className="sr-only">
				{holdsMode
					? `two-phase holds: ${fmt(race.heldTotal)} held of ${fmt(budget)}, ${fmt(race.available)} available${race.firstBlocked ? `, ${race.firstBlocked.label} blocked` : ""}`
					: `without holds: ${fmt(race.settledTotal)} settled against a ${fmt(budget)} budget${race.overshoot > 0 ? `, ${fmt(race.overshoot)} over` : ""}`}
			</p>
		</div>
	);
}
