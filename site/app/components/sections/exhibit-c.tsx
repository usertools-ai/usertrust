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
import ExhibitCRace from "./exhibit-c-race";
import { routedTracePath, TRACE } from "./lib/trace-style";
import { FORK_HEIGHT, FORK_NODES, FORK_ROUTES, FORK_WIDTH } from "./lib/two-phase-fork";

const facts = factsJson as EvidenceFacts;
const BUDGET = facts.facts.usertokensPerFiveDollars.value;
const defaults = raceDefaults(BUDGET);

/**
 * THE TWO-PHASE FORK — hold, then settle XOR void, drawn in the page's one
 * circuit grammar (Addendum K): routed segments, filleted corners, a via-dot at
 * the branch and pads at the terminals. Geometry lives in lib/two-phase-fork.
 *
 * XOR is the load-bearing word, and the reason the fork has exactly two exits
 * with nothing between them and nothing after: a hold settles or it voids.
 */
function TwoPhaseFork() {
	return (
		<svg
			viewBox={`0 0 ${FORK_WIDTH} ${FORK_HEIGHT}`}
			role="img"
			aria-label="a pending hold forks into exactly two outcomes: settled, or voided"
			className="trace-layer h-auto w-full max-w-lg"
		>
			{FORK_ROUTES.map((r) => (
				<path
					key={r.key}
					d={routedTracePath(r.x1, r.y1, r.x2, r.y2, { lead: "h" })}
					className={TRACE.baseClass}
					strokeWidth={TRACE.baseWidth}
				/>
			))}
			{FORK_ROUTES.map((r) => (
				<path
					key={`${r.key}-core`}
					d={routedTracePath(r.x1, r.y1, r.x2, r.y2, { lead: "h" })}
					className={TRACE.coreClass}
					strokeWidth={TRACE.coreWidth}
				/>
			))}
			{FORK_NODES.map((n) => (
				<g key={n.label}>
					<circle
						cx={n.x}
						cy={n.y}
						r={n.branch ? TRACE.viaRadius : TRACE.padRadius}
						className={n.branch ? TRACE.viaClass : TRACE.padClass}
					/>
					<text
						x={n.x}
						y={n.labelY}
						textAnchor={n.anchor}
						className="fork-label"
						fontFamily="var(--font-jetbrains), monospace"
					>
						{n.label}
					</text>
				</g>
			))}
		</svg>
	);
}

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
			className="section-anchor ground-zone relative py-24 sm:py-32 safe-x"
		>
			<div className="mx-auto max-w-6xl">
				<p className="section-eyebrow">exhibit c</p>
				<div className="mt-3 flex items-center gap-1.5">
					<StageTag stage="ENFORCE" />
				</div>
				<h2 className="mt-4 font-display font-bold lowercase leading-[0.95] tracking-tight text-white text-[clamp(2.5rem,6vw,4.5rem)]">
					hold. settle. or void.
				</h2>
				<p className="mt-6 max-w-xl font-mono text-sm leading-6 text-white/70">
					the banking pattern: held, then settled or voided. never lost.
				</p>
				<div className="mt-8">
					<TwoPhaseFork />
				</div>
				<p className="mt-8 max-w-2xl text-base leading-relaxed text-white/70">
					every governed call opens a two-phase hold against the budget before a token moves —{" "}
					<span className="font-mono text-white/90">available = budget − Σ(holds)</span>. without
					holds, concurrent agents each see the full budget and settle past it. with holds, the
					first hold that would exceed what is actually available throws. the budget here is{" "}
					<span className="font-mono">{formatUsertokens(BUDGET)}</span> ={" "}
					<span className="font-mono">{usdFromUsertokens(BUDGET)}</span> — the starter default. run
					the race yourself:
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

				{/* THE BUDGET RACE — client island. Its server render IS the static
				    fallback: the two-phase state at the defaults, one BLOCKED row.
				    Hydration enhances in place; no swap, no entrance animation. */}
				<div className="mt-10">
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

				{/* CASE FILE 001 — the ungoverned original. Dark incident log; no paper. */}
				<div className="mt-32 md:mt-44">
					<CaseFile />
				</div>

				{/* Counterfactual replay — desktop-only ambient video, now given the
				    full column and cropped to its active terminal rows so the BLOCK
				    line is readable without leaning in (Addendum I). The recording is a
				    wide terminal capture with roughly a sixth of its height empty below
				    the last prompt; the wrapper pins a taller aspect and object-top
				    cover crops that dead band away instead of scaling it down with the
				    text (the ratio itself lives in the className, not this comment).
				    ONLY the video is desktop-only — the denial evidence below it is
				    content and renders at every viewport. */}
				<div className="mt-32 md:mt-44">
					<figure className="hidden md:block">
						<div className="aspect-[26/9] w-full overflow-hidden rounded-xl border border-white/10">
							<AmbientVideo
								src={REPLAY_VIDEO.src}
								poster={REPLAY_VIDEO.poster}
								className="h-full w-full object-cover object-top"
							/>
						</div>
						<figcaption className="mt-3 font-mono text-xs leading-5 text-white/70">
							counterfactual replay — the same loop, governed: usertrust throws at the cap.
						</figcaption>
					</figure>

					{/* min-w-0: the thrown error's longest unbreakable token would
					    otherwise set this column's min-content wider than a phone. */}
					<div className="relative mt-14 min-w-0">
						<Stamp word="BLOCKED" className="absolute -right-4 -top-6 z-10" />
						<h3 className="font-display lowercase leading-none text-white text-[clamp(1.75rem,4vw,3rem)]">
							the denial, on the chain.
						</h3>
						<p className="mt-3 max-w-2xl font-mono text-sm leading-6 text-white/70">
							denials don&rsquo;t get receipts. they get chain events.
						</p>
						<div className="mt-8">
							<DenialEvidence />
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
