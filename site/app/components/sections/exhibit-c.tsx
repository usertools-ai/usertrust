import AmbientVideo from "@/components/ambient-video";
import { formatUsertokens, usdFromUsertokens } from "@/components/receipt/format";
import Stamp from "@/components/stamp";
import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts } from "@/evidence/types";
import { raceDefaults } from "@/lib/budget-race";
import { DENIAL_EVENT, denialEventRows, REPLAY_VIDEO, THROWN_DENIAL } from "@/lib/exhibit-c-data";
import StageTag from "../stage-tag";
import TerminalFrame from "../terminal-frame";
import CaseFile from "./case-file";
import ExhibitCFork from "./exhibit-c-fork";
import ExhibitCRace from "./exhibit-c-race";

const facts = factsJson as EvidenceFacts;
const BUDGET = facts.facts.usertokensPerFiveDollars.value;
const defaults = raceDefaults(BUDGET);

/**
 * THE DENIAL, ON THE CHAIN.
 *
 * This card used to say the opposite, and said it honestly: a denied call wrote
 * nothing to the audit chain, so the only artifact was the throw. The product
 * changed, not the standard — a denial now appends a real `policy_denied`
 * event, and both halves below come from the same capture run as every other
 * fixture on this page.
 *
 * Note what the event does NOT carry: the prompt. Only a hash of it, with the
 * algorithm named beside it. That is the design — a denial leaves enough to
 * audit and nothing to leak.
 */
function DenialEvidence() {
	return (
		<div className="grid gap-6 lg:grid-cols-2">
			<TerminalFrame className="min-w-0 self-start" title="what the caller gets" tone="error">
				<pre className="whitespace-pre-wrap break-words text-white/75">
					<span className="font-bold text-danger">{THROWN_DENIAL.name}</span>
					{`: ${THROWN_DENIAL.message}`}
				</pre>
			</TerminalFrame>

			<TerminalFrame
				className="min-w-0 self-start"
				title={`what the chain gets · ${DENIAL_EVENT.kind}`}
				footer={
					<div className="border-t border-white/10 px-5 py-2.5 font-mono text-[12px] leading-5 text-white/70">
						the prompt is hashed, never stored · captured on {THROWN_DENIAL.capturedWith} ·{" "}
						{THROWN_DENIAL.capturedFrom}
					</div>
				}
			>
				<dl className="grid gap-1">
					{denialEventRows().map((row) => (
						<div key={row.label} className="flex gap-3">
							<dt className="w-36 shrink-0 text-tim">{row.label}</dt>
							<dd className="min-w-0 break-all text-white">{row.value}</dd>
						</div>
					))}
				</dl>
			</TerminalFrame>
		</div>
	);
}

export default function ExhibitC() {
	return (
		<section
			id="exhibit-c"
			data-theme="amber"
			className="section-anchor ground-zone relative py-14 sm:py-20 safe-x"
		>
			<div className="mx-auto max-w-6xl">
				<p className="section-eyebrow">exhibit c</p>
				<div className="mt-2 flex items-center gap-1.5">
					<StageTag stage="ENFORCE" />
				</div>
				<h2 className="mt-3 font-display font-bold lowercase leading-[0.95] tracking-tight text-white text-[clamp(2.5rem,6vw,4.5rem)]">
					hold. settle. or void.
				</h2>
				<p className="mt-4 max-w-xl font-mono text-sm leading-6 text-white/70">
					the banking pattern: held, then settled or voided. never lost.
				</p>
				{/* The fork and its explainer share one row (N2). The fork is capped at
				    max-w-lg and both paragraphs at max-w-2xl, so stacked they left the
				    right half of the section dead for ~450px. Side by side the fork
				    fills the narrow track and the prose the wide one; below lg they
				    stack in source order (diagram, then the prose that reads it). */}
				<div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:gap-10">
					<ExhibitCFork />
					<div>
						<p className="max-w-2xl text-base leading-relaxed text-white/70">
							every governed call opens a two-phase hold against the budget before a token moves —{" "}
							<span className="font-mono text-white/90">available = budget − Σ(holds)</span>.
							without holds, concurrent agents each see the full budget and settle past it. with
							holds, the first hold that would exceed what is actually available throws. the budget
							here is <span className="font-mono">{formatUsertokens(BUDGET)}</span> ={" "}
							<span className="font-mono">{usdFromUsertokens(BUDGET)}</span> — the starter default.
							run the race yourself:
						</p>
						{/* Scope, stated where the claim is made. An in-process mutex is what
						    serialises the budget read and the hold for ONE governor; across
						    processes the guarantee is the ledger's own
						    debits_must_not_exceed_credits, which rejects an overshoot
						    atomically — the same limitation govern.ts states about itself. */}
						<p className="mt-4 max-w-2xl text-base leading-relaxed text-white/70">
							the gate is per-governor: one process serialises its own budget read and hold behind a
							mutex. across processes the guarantee is the ledger&rsquo;s — TigerBeetle atomically
							rejects a hold that would overshoot, whoever asked for it.
						</p>
					</div>
				</div>

				{/* THE BUDGET RACE — client island. Its server render IS the static
				    fallback: the two-phase state at the defaults, one BLOCKED row.
				    Hydration enhances in place; no swap, no entrance animation. */}
				<div className="mt-8">
					<ExhibitCRace budget={BUDGET} />
					<noscript>
						<p className="mt-3 font-mono text-xs text-white/70">
							the sliders need JavaScript — shown: two-phase holds with {defaults.agents} agents at{" "}
							{formatUsertokens(defaults.costPerCall)} per call. the retry is denied.
						</p>
					</noscript>
					<p className="mt-3 font-mono text-[12px] leading-5 text-white/70">
						arithmetic, not a screenshot: the same gate the block-budget-overshoot default rule
						enforces before every governed call. the error it throws is captured below, verbatim.
					</p>
				</div>

				{/* CASE FILE 001 and the counterfactual replay are the narrative pair —
				    the ungoverned incident log, and the same loop governed — so they
				    share ONE row (N3) instead of sitting in two full-width rows
				    separated by ~176px oceans. The case file keeps its own
				    `mx-auto w-full max-w-md`: it fills the narrow track at lg and
				    re-centres when the row stacks. The replay takes the WIDER
				    track deliberately — the widest column the composition allows, per
				    the Addendum I legibility target for the BLOCK line.

				    Counterfactual replay — desktop-only ambient video, shown WHOLE.
				    There is no crop any more, and that is a fix at the source rather
				    than at the display. The recording used to be an ultra-wide frame,
				    sized so the long BLOCK line would not wrap, with roughly a sixth of
				    its height empty below the last prompt; the wrapper pinned a taller
				    aspect and cover-cropped the dead band away. Type that small over a
				    column this size rendered well under the page's rendered-glyph floor
				    — in the one artifact on the page that has to be READ. Wrapping is
				    now blessed, so the tape records a narrow frame in large type, the
				    BLOCK line breaks at a word boundary, and the content fills the
				    frame. The aspect below is the recorded frame's own; it is derived
				    in packages/openclaw/demo/runaway-agent.tape, which carries the
				    column/row arithmetic, and it moves only when that tape does. ONLY
				    the video is desktop-only — the denial evidence below is content and
				    renders at every viewport. */}
				<div className="mt-16 grid gap-8 md:mt-20 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:items-center lg:gap-10">
					<CaseFile />
					<figure className="hidden md:block">
						<div className="aspect-[1488/1036] w-full overflow-hidden rounded-xl border border-white/10">
							<AmbientVideo
								src={REPLAY_VIDEO.src}
								poster={REPLAY_VIDEO.poster}
								className="h-full w-full object-cover"
							/>
						</div>
						<figcaption className="mt-3 font-mono text-xs leading-5 text-white/70">
							counterfactual replay — the same loop, governed: usertrust throws at the cap.
						</figcaption>
					</figure>
				</div>

				{/* The denial is its own instrument now, on the page-wide
				    "next instrument, same exhibit" token (G3) rather than tucked
				    inside the replay's wrapper.
				    min-w-0: the thrown error's longest unbreakable token would
				    otherwise set this column's min-content wider than a phone. */}
				<div className="relative mt-16 min-w-0 md:mt-20">
					<Stamp word="BLOCKED" className="absolute -right-4 -top-6 z-10" />
					<h3 className="font-display lowercase leading-none text-white text-[clamp(1.75rem,4vw,3rem)]">
						the denial, on the chain.
					</h3>
					<p className="mt-3 max-w-2xl font-mono text-sm leading-6 text-white/70">
						denials don&rsquo;t get receipts. they get chain events.
					</p>
					<div className="mt-6">
						<DenialEvidence />
					</div>
				</div>
			</div>
		</section>
	);
}
