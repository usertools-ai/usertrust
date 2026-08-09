import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts } from "@/evidence/types";
import CopyChip from "../copy-chip";
import HeroIntro from "./hero-intro";

const facts = (factsJson as EvidenceFacts).facts;

/**
 * Hero — the suit is the hero (Addendum C). SERVER component, no props.
 * The intro film plays full-bleed behind the content and settles on the
 * mascot, who owns the right of frame; the Addendum B category stack owns
 * the left column. No receipt pane, no print sweep — the hero's only client
 * code is CopyChip and the idle-gated HeroIntro backdrop.
 */
export default function Hero() {
	return (
		<section data-theme="emerald" className="relative isolate overflow-hidden">
			<HeroIntro />
			<div className="relative z-[1] mx-auto flex min-h-[100dvh] w-full max-w-6xl items-center safe-x pt-28 pb-16 lg:pt-20">
				{/* Single left column — the max-w cap keeps the right of frame
				    clear so the suit settles unobscured on desktop. */}
				<div className="max-w-2xl">
					<h1 className="font-display lowercase leading-[0.95] tracking-[-0.02em]">
						<span className="block text-white text-[clamp(3rem,9vw,8rem)]">
							financial governance
						</span>
						<span className="block text-white text-[clamp(3rem,9vw,8rem)]">for AI agents.</span>
						<span className="mt-3 block text-ut text-[clamp(1.75rem,4.5vw,3.5rem)]">
							keep the receipts.
						</span>
					</h1>
					<p className="mt-6 max-w-md text-base leading-relaxed text-white/70 sm:text-lg">
						one line wraps your LLM client. every governed call becomes a ledger transaction — with
						a receipt anyone can verify.
					</p>
					<div className="glow-emerald mt-8 flex flex-wrap items-center gap-4">
						<CopyChip text="npm install usertrust" />
						<a
							href="#exhibit-e"
							className="focus-ring inline-flex min-h-[44px] items-center font-mono text-sm text-tim transition-colors hover:text-white"
						>
							verify a ledger →
						</a>
					</div>
					<p className="mt-10 flex flex-wrap items-center gap-3 font-mono text-[12px] tracking-wide text-white/70">
						<span>
							{facts.license.value} · {facts.verifierRuntimeDeps.value} runtime deps in the verifier
							· {facts.commandsToFirstReceipt.value} commands to first receipt
						</span>
						<span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
							runs on TigerBeetle {(factsJson as EvidenceFacts).tigerbeetleVersion}
						</span>
					</p>
				</div>
			</div>
		</section>
	);
}
