import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts } from "@/evidence/types";
import ExhibitBDie from "./exhibit-b-die";
import ExhibitBTabs from "./exhibit-b-tabs";

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
					<p className="text-white/40">{g.provider}</p>
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
				<p className="font-mono text-xs uppercase tracking-widest text-white/40">exhibit b</p>
				<h2 className="mt-4 font-display text-[clamp(2.5rem,6vw,4.5rem)] leading-[0.95] tracking-tight text-white">
					your SDK. one line.
				</h2>

				{/* Tabs left, THE GOVERNANCE DIE opposite. Stacks on mobile. */}
				<div className="mt-12 grid items-center gap-12 lg:grid-cols-2">
					<ExhibitBTabs />
					<ExhibitBDie />
				</div>

				{/* BYOK creed */}
				<p className="mt-8 font-mono text-sm tracking-wide text-white/60">
					{"your keys. your billing. your evidence."}
				</p>

				{/* GOVERNED SURFACES — the boundary, stated precisely. A two-column
				    manifest with its own header/footer bars exceeds TerminalFrame's
				    {title, children} shape (the header alone would need to be a
				    ReactNode, not a string), so the contract's exact classes are
				    kept inline rather than importing the component (documented in
				    the retrofit report). Outer overflow-hidden clips the rounded
				    corners; the inner overflow-x-auto scrolls the manifest on
				    narrow viewports without breaking that clip. */}
				<div className="mt-16 overflow-hidden rounded-xl border border-white/10 bg-terminal">
					<div className="overflow-x-auto">
						<div className="min-w-[40rem] font-mono text-[13px] leading-relaxed">
							<p className="flex h-9 items-center border-b border-white/[0.06] px-4 text-[11px] uppercase tracking-[0.12em] text-white/50">
								governed surfaces
							</p>
							<div className="grid grid-cols-2">
								<div className="border-r border-white/[0.06]">
									<SurfaceColumn title="governed" titleClass="text-ut" groups={GOVERNED} />
								</div>
								<SurfaceColumn
									title="passthrough — not governed"
									titleClass="text-white opacity-50"
									groups={PASSTHROUGH}
								/>
							</div>
							<p className="border-t border-white/[0.06] px-4 py-3 text-white/40">
								passthrough surfaces bypass governance, audit, and budget enforcement — route spend
								through the governed entry points. {facts.modelCount.value} models priced across
								anthropic, openai, and google.
							</p>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
