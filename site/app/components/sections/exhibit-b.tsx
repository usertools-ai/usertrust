import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts } from "@/evidence/types";
import TerminalFrame from "../terminal-frame";
import ExhibitBDie from "./exhibit-b-die";
import ExhibitBTabs from "./exhibit-b-tabs";
import { PROVIDER_BADGES, PROVIDER_LOGOS, PROVIDER_VIEWBOX } from "./lib/provider-logos";

const facts = (factsJson as EvidenceFacts).facts;

// Verbatim from the governance boundary documented in
// packages/core/src/detect.ts — precision as flex. Do not paraphrase.
const GOVERNED: { provider: string; surfaces: string[] }[] = [
	{
		provider: "anthropic",
		surfaces: [
			"messages.create",
			"messages.stream",
			"messages.parse",
			"beta.messages.create",
			"beta.messages.stream",
			"beta.messages.parse",
		],
	},
	{
		provider: "openai",
		surfaces: ["chat.completions.create", "responses.create — incl. stream: true"],
	},
	{ provider: "google", surfaces: ["models.generateContent"] },
];

// Anthropic + OpenAI: documented in packages/core/src/detect.ts
// Google: documented in packages/core/src/govern.ts buildGoogleProxy (traps generateContent only)
const PASSTHROUGH: { provider: string; surfaces: string[] }[] = [
	{
		provider: "anthropic",
		surfaces: ["messages.batches", "beta.messages.batches", "beta.models", "beta.files"],
	},
	{
		provider: "openai",
		surfaces: [
			"responses.stream() helper",
			"responses.parse()",
			"responses.retrieve / cancel / delete",
			"legacy completions.create",
			"beta.* (assistants / threads / realtime)",
		],
	},
	{ provider: "google", surfaces: ["models.generateContentStream", "models.countTokens"] },
];

function SurfaceColumn({
	title,
	titleClass,
	groups,
}: {
	title: string;
	titleClass: string;
	groups: { provider: string; surfaces: string[] }[];
}) {
	return (
		<div className="p-4 md:p-5">
			<p className={`uppercase tracking-widest ${titleClass}`}>{title}</p>
			{groups.map((g) => (
				<div key={g.provider} className="mt-4">
					<p className="text-white/70">{g.provider}</p>
					<ul className="mt-1 space-y-0.5 text-white/80">
						{g.surfaces.map((s) => (
							<li key={s}>{s}</li>
						))}
					</ul>
				</div>
			))}
		</div>
	);
}

export default function ExhibitB() {
	return (
		<section id="exhibit-b" className="relative py-24 sm:py-32 safe-x">
			<div className="mx-auto max-w-6xl">
				<p className="section-eyebrow">exhibit b</p>
				<h2 className="mt-4 font-display text-[clamp(2.5rem,6vw,4.5rem)] leading-[0.95] tracking-tight text-white">
					your SDK. one line.
				</h2>

				{/* Tabs left, THE GOVERNANCE DIE opposite. Stacks on mobile. */}
				<div className="mt-12 grid items-center gap-12 lg:grid-cols-2">
					<ExhibitBTabs />
					<ExhibitBDie />
				</div>

				{/* BYOK creed */}
				<p className="mt-8 font-mono text-sm tracking-wide text-white/70">
					{"your keys. your billing. your evidence."}
				</p>

				{/* works with — model-provider marks, monochrome ghosted (the
				    provider-logo addendum). Graphics register: white at 45%
				    resting clears the graphics-only contrast floor (a lower bar
				    than body text, validated); hover lifts to white at 85%.
				    Nominative use only — no color, no endorsement. No uppercase
				    class on the badges: casing is the brand. */}
				<div className="mt-10">
					<p className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
						works with
					</p>
					<ul aria-label="model providers" className="mt-4 flex flex-wrap items-center gap-8">
						{PROVIDER_LOGOS.map((logo) => (
							<li key={logo.name} className="text-white/45 transition-colors hover:text-white/85">
								<svg
									viewBox={PROVIDER_VIEWBOX}
									role="img"
									aria-label={logo.name}
									fill="currentColor"
									className="h-5 w-auto"
								>
									<path d={logo.path} />
								</svg>
							</li>
						))}
						{PROVIDER_BADGES.map((badge) => (
							<li
								key={badge}
								className="font-mono text-[12px] tracking-[0.12em] text-white/50 transition-colors hover:text-white/85"
							>
								{badge}
							</li>
						))}
					</ul>
				</div>

				{/* GOVERNED SURFACES — the boundary, stated precisely. Renders through
				    the shared TerminalFrame with a plain string title ("governed
				    surfaces"). The frame always pads its body (p-4 md:p-5); this
				    surface wants that padding on nothing but the 2-col grid's own
				    column padding and the footer's px-4, so the outer child cancels
				    the frame's body padding with a matching negative margin
				    (-m-4/md:-m-5) — same technique as bleeding a full-width divider
				    out of a padded card. min-w-[40rem] and the negative margin are
				    kept on two DIFFERENT boxes (min-width on the inner box, un-
				    negated) rather than one: a negative margin and a min-width on
				    the SAME box over-constrain the layout, and browsers resolve
				    that by honoring the margin and letting content wrap instead of
				    forcing the intended horizontal scroll (verified in-browser at
				    390px). The outer box owns the bleed and the fresh
				    overflow-x-auto scroll context; the inner box owns min-w-[40rem]
				    with zero margin, so oversized content overflows it cleanly. */}
				<TerminalFrame className="mt-16" title="governed surfaces">
					<div className="-m-4 overflow-x-auto md:-m-5">
						<div className="min-w-[40rem]">
							<div className="grid grid-cols-2">
								<div className="border-r border-white/[0.06]">
									<SurfaceColumn title="governed" titleClass="text-ut" groups={GOVERNED} />
								</div>
								<SurfaceColumn
									title="passthrough — not governed"
									titleClass="text-white opacity-70"
									groups={PASSTHROUGH}
								/>
							</div>
							<p className="border-t border-white/[0.06] px-4 py-3 text-white/70">
								passthrough surfaces bypass governance, audit, and budget enforcement — route spend
								through the governed entry points. {facts.modelCount.value} models priced across
								anthropic, openai, and google.
							</p>
						</div>
					</div>
				</TerminalFrame>
			</div>
		</section>
	);
}
