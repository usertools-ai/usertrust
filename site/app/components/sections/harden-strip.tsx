import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts } from "@/evidence/types";
import { statValueClassName } from "./lib/harden-strip-style";

const facts = factsJson as unknown as EvidenceFacts;

const AGENTS_URL =
	"https://github.com/usertools-ai/usertrust/blob/master/AGENTS.md#the-packagesverify-parity-contract";

/**
 * The packages/verify parity rule, quoted VERBATIM from AGENTS.md
 * ("The packages/verify parity contract" section). Markdown emphasis
 * markers are stripped; every word and punctuation mark is exact.
 * Do not paraphrase, do not re-punctuate — the manual check diffs
 * these strings against the source file.
 */
const PARITY_QUOTE_CONTEXT =
	"Core produces the hashes in a vault; verify recomputes them without importing core. If the two share code, the verifier verifies nothing.";
const PARITY_QUOTE_RULE =
	'Never "DRY up" this duplication. Mirror every change into both packages.';

export default function HardenStrip() {
	const f = facts.facts;
	const stats = [
		{ label: "harden suites", stat: f.hardenSuiteCount },
		{ label: "test cases", stat: f.testCaseCount },
		// expect() counts are labeled TEST assertions — a suite metric,
		// never presented as a security claim.
		{ label: "test assertions", stat: f.expectAssertionCount },
		{ label: "AGENTS.md invariants", stat: f.invariantCount },
		{ label: "shared verifier lines", stat: f.verifierSharedLines },
	];
	return (
		<section id="harden-doctrine" className="border-y border-white/10 bg-white/[0.02]">
			<div className="safe-x mx-auto max-w-6xl py-20 md:py-24">
				<p className="section-eyebrow">the discipline</p>
				<h2 className="font-display mt-4 lowercase leading-none text-white text-[clamp(2rem,5vw,4rem)]">
					the harden doctrine.
				</h2>

				{/* stat wall — every numeral from facts.json, never a literal.
				    gap-px over a faint white ground draws the hairline grid. */}
				<dl className="mt-10 grid grid-cols-2 gap-px border border-white/10 bg-white/10 md:grid-cols-5">
					{stats.map(({ label, stat }) => (
						/* last:col-span-2 fills the odd fifth cell across the mobile
						   two-column row. Without it the empty half-cell exposed the
						   dl's own bg-white/10 hairline ground as a ~170x120px light
						   panel — a ghost tile, not a hairline. */
						<div
							key={label}
							className="flex flex-col gap-2 bg-brand-bg p-5 last:col-span-2 md:last:col-span-1"
						>
							<dt className="font-mono text-[12px] uppercase tracking-widest text-white/70">
								{label}
							</dt>
							<dd className={statValueClassName(label)} title={stat.source}>
								{stat.value}
							</dd>
						</div>
					))}
				</dl>
				{/* provenance stub — counts derive from source at capture time */}
				<p className="mt-3 font-mono text-[12px] text-white/70">
					counted at capture · {facts.commit} · v{facts.usertrustVersion}
				</p>

				{/* the parity rule, verbatim, bordered mono — linked to its source.
				    Adopts TerminalFrame's contract classes directly: the `cite`
				    attribute requires a native <blockquote>, which TerminalFrame
				    (a <div>) can't provide, so the shared chrome is applied inline
				    rather than through the component. */}
				<figure className="mt-12 max-w-3xl">
					<blockquote
						cite={AGENTS_URL}
						className="lift-1 overflow-hidden rounded-xl border border-white/10 bg-terminal p-4 font-mono text-[14px] leading-relaxed text-white/80 md:p-5"
					>
						<p>{PARITY_QUOTE_CONTEXT}</p>
						<p className="mt-4 text-white">{PARITY_QUOTE_RULE}</p>
					</blockquote>
					<figcaption className="mt-3 font-mono text-xs text-white/70">
						<a
							href={AGENTS_URL}
							target="_blank"
							rel="noreferrer"
							className="focus-ring underline decoration-white/50 underline-offset-4 transition-colors hover:text-white"
						>
							AGENTS.md · the packages/verify parity contract
						</a>
					</figcaption>
				</figure>
			</div>
		</section>
	);
}
