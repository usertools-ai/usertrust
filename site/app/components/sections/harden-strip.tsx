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
				<p className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">the discipline</p>
				<h2 className="font-display mt-4 lowercase leading-none text-white text-[clamp(2rem,5vw,4rem)]">
					the harden doctrine.
				</h2>

				{/* stat wall — every numeral from facts.json, never a literal.
				    gap-px over a faint white ground draws the hairline grid. */}
				<dl className="mt-10 grid grid-cols-2 gap-px border border-white/10 bg-white/10 md:grid-cols-5">
					{stats.map(({ label, stat }) => (
						<div key={label} className="flex flex-col gap-2 bg-brand-bg p-5">
							<dt className="font-mono text-[0.65rem] uppercase tracking-widest text-white/40">
								{label}
							</dt>
							<dd className={statValueClassName(label)} title={stat.source}>
								{stat.value}
							</dd>
						</div>
					))}
				</dl>
				{/* provenance stub — counts derive from source at capture time */}
				<p className="mt-3 font-mono text-[0.65rem] text-white/30">
					counted at capture · {facts.commit} · v{facts.usertrustVersion}
				</p>

				{/* the parity rule, verbatim, bordered mono — linked to its source */}
				<figure className="mt-12 max-w-3xl">
					<blockquote
						cite={AGENTS_URL}
						className="rounded-md border border-white/15 bg-[#0d0d1f] p-6 font-mono text-sm leading-relaxed text-white/80"
					>
						<p>{PARITY_QUOTE_CONTEXT}</p>
						<p className="mt-4 text-white">{PARITY_QUOTE_RULE}</p>
					</blockquote>
					<figcaption className="mt-3 font-mono text-xs text-white/40">
						<a
							href={AGENTS_URL}
							target="_blank"
							rel="noreferrer"
							className="focus-ring underline decoration-white/30 underline-offset-4 transition-colors hover:text-white"
						>
							AGENTS.md · the packages/verify parity contract
						</a>
					</figcaption>
				</figure>
			</div>
		</section>
	);
}
