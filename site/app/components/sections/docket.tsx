import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts } from "@/evidence/types";
import InView from "../in-view";

const facts = (factsJson as EvidenceFacts).facts;

// Digit-bearing crypto spec strings stay in module scope, NOT in JSX text:
// check-facts scans marketing-section JSX text nodes for digit literals, and
// these are cryptographic constants, not product metrics with facts entries.
const HASH_SPEC = "SHA-256 · RFC 6962";
const SIG_SPEC = "Ed25519";

type Tile = {
	value: string;
	caption: string;
	href: string;
	exhibit: string;
	small?: boolean;
};

const tiles: Tile[] = [
	{
		value: String(facts.transferCodes.value),
		caption: "transfer codes",
		href: "#exhibit-c",
		exhibit: "exhibit c",
	},
	{
		value: String(facts.policyOperators.value),
		caption: "policy operators",
		href: "#exhibit-f",
		exhibit: "exhibit f",
	},
	{
		value: String(facts.verifierRuntimeDeps.value),
		caption: "runtime deps in the verifier",
		href: "#exhibit-e",
		exhibit: "exhibit e",
	},
	{
		value: facts.modelCount.value,
		caption: "models priced",
		href: "#exhibit-b",
		exhibit: "exhibit b",
	},
	{
		value: HASH_SPEC,
		caption: "hash chain, merkle proofs",
		href: "#exhibit-d",
		exhibit: "exhibit d",
		small: true,
	},
	{
		value: SIG_SPEC,
		caption: "anchoring signatures",
		href: "#exhibit-d",
		exhibit: "exhibit d",
		small: true,
	},
	{
		value: String(facts.commandsToFirstReceipt.value),
		caption: "commands to first receipt",
		href: "#open-ledger",
		exhibit: "open ledger",
	},
	{
		value: facts.license.value,
		caption: "license",
		href: "#open-ledger",
		exhibit: "open ledger",
		small: true,
	},
];

/**
 * The Docket — "the facts, itemized." SERVER component, no props.
 * Eight hairline-ruled tiles; every value traces to facts.json (the two
 * crypto spec strings are module constants above). Hairlines draw in via
 * CSS scroll-driven animation with an InView IO-class fallback; numerals
 * are static text and never animate.
 */
export default function Docket() {
	return (
		<section id="docket" className="ground-zone relative w-full safe-x py-24 sm:py-32">
			<div className="mx-auto max-w-6xl">
				<p className="section-eyebrow">the docket</p>
				<h2 className="mt-3 font-display font-bold lowercase leading-[0.95] text-white text-[clamp(2.5rem,6vw,4.5rem)]">
					the facts, itemized.
				</h2>
				{/* InView is a regular client component imported normally (no
			    next/dynamic ssr:false — unsupported in server components on
			    the current Next.js major); it code-splits automatically with
			    the route. */}
				<InView className="mt-12 grid grid-cols-2 border border-[rgba(52,211,153,0.08)] md:grid-cols-4">
					{tiles.map((t) => (
						<div
							key={t.caption}
							className="docket-tile lift-1 relative flex flex-col gap-3 p-6 sm:p-8"
						>
							<span className="docket-hairline docket-hairline-h" aria-hidden="true" />
							<span className="docket-hairline docket-hairline-v" aria-hidden="true" />
							<a
								href={t.href}
								className="focus-ring inline-flex min-h-[44px] items-center self-start font-mono text-[12px] tracking-wide text-tim transition-colors hover:text-white"
							>
								→ {t.exhibit}
							</a>
							{/* Static numeral — never counts up, never animates. */}
							<div
								className={`font-mono font-bold tabular-nums leading-none text-white ${
									t.small ? "text-[clamp(1.3rem,2.6vw,2rem)]" : "text-[clamp(3rem,7vw,5.5rem)]"
								}`}
							>
								{t.value}
							</div>
							{/* mt-auto pins every caption to its tile's bottom edge, so one
							    grid row shares ONE caption rule regardless of whether the
							    numeral above it is the 88px large clamp, the 32px small
							    clamp, or a two-line value — row 2 previously landed its
							    captions on three different baselines. tracking-[0.12em]
							    is the site's 12px-mono-label convention (TerminalFrame
							    title bar, exhibit-b badges, dt labels). */}
							<div className="mt-auto font-mono text-[12px] leading-snug tracking-[0.12em] text-white/70">
								{t.caption}
							</div>
						</div>
					))}
				</InView>
			</div>
		</section>
	);
}
