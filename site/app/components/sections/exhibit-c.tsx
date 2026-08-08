import AmbientVideo from "@/components/ambient-video";
import { formatUsertokens, usdFromUsertokens } from "@/components/receipt/format";
import Stamp from "@/components/stamp";
import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts } from "@/evidence/types";
import { raceDefaults } from "@/lib/budget-race";
import { REPLAY_VIDEO, THROWN_DENIAL } from "@/lib/exhibit-c-data";
import CaseFile from "./case-file";
import ExhibitCRace from "./exhibit-c-race";

const facts = factsJson as EvidenceFacts;
const BUDGET = facts.facts.usertokensPerFiveDollars.value;
const defaults = raceDefaults(BUDGET);

/**
 * The artifact of a denial is the THROW — verbatim, in the register a
 * developer meets it in. Not paper, not a "blocked receipt", and not an audit
 * event: a denied call writes nothing to the chain (verified; the product gap
 * is filed separately). The strings come from lib/exhibit-c-data, captured
 * from a real overshoot against a real dry-run client.
 */
function ThrownDenialCard() {
	return (
		<div className="border border-danger/40 bg-black/30 font-mono text-xs leading-6">
			{/* Header keeps its right side clear — the BLOCKED stamp lands there. */}
			<div className="border-b border-danger/30 px-4 py-2">
				<span className="uppercase tracking-widest text-danger">uncaught</span>
			</div>
			<pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-4 text-white/75">
				<span className="font-bold text-danger">{THROWN_DENIAL.name}</span>
				{`: ${THROWN_DENIAL.message}`}
			</pre>
			<p className="border-t border-dashed border-white/15 px-4 py-2 text-[10px] leading-5 text-white/35">
				captured on {THROWN_DENIAL.capturedWith} — {THROWN_DENIAL.capturedFrom}
			</p>
		</div>
	);
}

export default function ExhibitC() {
	return (
		<section id="exhibit-c" className="relative py-24 sm:py-32 safe-x">
			<div className="mx-auto max-w-6xl">
				<p className="font-mono text-xs uppercase tracking-widest text-white/40">exhibit c</p>
				<h2 className="mt-4 font-display font-bold lowercase leading-[0.95] tracking-tight text-white text-[clamp(2.5rem,6vw,4.5rem)]">
					hold. settle. or void.
				</h2>
				<p className="mt-6 max-w-xl font-mono text-sm leading-6 text-white/60">
					the banking pattern: held, then settled or voided. never lost.
				</p>
				<p className="mt-4 max-w-2xl text-base leading-relaxed text-white/70">
					every governed call opens a two-phase hold against the budget before a token moves —{" "}
					<span className="font-mono text-white/90">available = budget − Σ(holds)</span>. without
					holds, concurrent agents each see the full budget and settle past it. with holds, the
					first hold that would exceed what is actually available throws. the budget here is{" "}
					<span className="font-mono">{formatUsertokens(BUDGET)}</span> ={" "}
					<span className="font-mono">{usdFromUsertokens(BUDGET)}</span> — the starter default. run
					the race yourself:
				</p>

				{/* THE BUDGET RACE — client island. Its server render IS the static
				    fallback: the two-phase state at the defaults, one BLOCKED row.
				    Hydration enhances in place; no swap, no entrance animation. */}
				<div className="mt-10">
					<ExhibitCRace budget={BUDGET} />
					<noscript>
						<p className="mt-3 font-mono text-xs text-white/50">
							the sliders need JavaScript — shown: two-phase holds with {defaults.agents} agents at{" "}
							{formatUsertokens(defaults.costPerCall)} per call. the retry is denied.
						</p>
					</noscript>
					<p className="mt-3 font-mono text-[11px] leading-5 text-white/40">
						arithmetic, not a screenshot: the same gate the block-budget-overshoot default rule
						enforces before every governed call. the error it throws is captured below, verbatim.
					</p>
				</div>

				{/* CASE FILE 001 — the ungoverned original. Dark incident log; no paper. */}
				<div className="mt-32 md:mt-44">
					<CaseFile />
				</div>

				{/* Counterfactual replay — desktop-only ambient video beside the real
				    thrown error, stamped by the one set-piece in this section. */}
				<div className="mt-32 hidden gap-10 md:mt-44 md:grid md:grid-cols-2 md:items-center">
					<figure>
						<AmbientVideo
							src={REPLAY_VIDEO.src}
							poster={REPLAY_VIDEO.poster}
							className="aspect-[39/16] w-full border border-white/10"
						/>
						<figcaption className="mt-3 font-mono text-xs leading-5 text-white/40">
							counterfactual replay — the same loop, governed: usertrust throws at the cap.
						</figcaption>
					</figure>
					<div className="relative">
						<Stamp word="BLOCKED" className="absolute -right-4 -top-6 z-10" />
						<ThrownDenialCard />
						<p className="mt-4 font-mono text-sm text-white/60">
							the request throws. the ledger never moves.
						</p>
					</div>
				</div>
			</div>
		</section>
	);
}
