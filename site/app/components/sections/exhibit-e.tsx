import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts, VerifyTranscript } from "@/evidence/types";
import verifyTranscriptJson from "@/evidence/verify-transcript.json";
import CopyChip from "../copy-chip";
import ExhibitETranscript from "./exhibit-e-transcript";

const facts = factsJson as unknown as EvidenceFacts;
const transcript = verifyTranscriptJson as unknown as VerifyTranscript;

/**
 * Exhibit E — the giant zero renders from facts.verifierRuntimeDeps.value,
 * never a literal (check-facts enforces this).
 *
 * The terminal frame below hardcodes the shared TerminalFrame contract
 * (see the constraints doc's Addendum on code-surface consistency) verbatim:
 * its container and body classes match what the forthcoming shared component
 * will render, so that retrofit becomes a pure wrapper swap. The contract's
 * optional title bar is skipped here on purpose: its fixed-height row can't
 * host CopyChip's full touch target without clipping it against the frame's
 * rounded, clipped edge, so the "usertrust-verify" label and its copy chip
 * sit as a caption directly above the frame instead — visually adjacent, as
 * the exhibit calls for, without fighting the shared contract's row height.
 */
export default function ExhibitE() {
	const deps = facts.facts.verifierRuntimeDeps;
	return (
		<section id="exhibit-e" className="safe-x relative mx-auto max-w-6xl py-24 md:py-32">
			<p className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">exhibit e</p>
			<h2 className="font-display mt-4 lowercase leading-none text-white text-[clamp(2.5rem,7vw,5.5rem)]">
				don&rsquo;t take our word for it.
			</h2>

			<div className="mt-12 grid items-center gap-12 md:grid-cols-2">
				{/* set-piece: the outlined zero over halftone */}
				<figure className="relative flex flex-col items-center justify-center py-8">
					<div aria-hidden="true" className="halftone absolute inset-0" />
					<span
						className="font-display relative select-none leading-none text-transparent"
						style={{
							WebkitTextStroke: "2px var(--color-ut)",
							fontSize: "clamp(12rem,30vw,24rem)",
						}}
					>
						{deps.value}
					</span>
					<figcaption className="relative mt-2 text-center">
						<p className="text-lg text-white/80">runtime dependencies in the verifier.</p>
						<p className="mt-2 font-mono text-xs text-white/40">the verifier owes us nothing.</p>
						{/* provenance stub — provenance as a design element */}
						<p className="mt-1 font-mono text-[0.65rem] text-white/30">{deps.source}</p>
					</figcaption>
				</figure>

				{/* terminal: the captured workspace-verifier transcript */}
				<div>
					<div className="mb-3 flex items-center justify-between gap-4">
						<span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/50">
							usertrust-verify
						</span>
						<CopyChip text={transcript.command} label="copy verify command" />
					</div>
					<div className="overflow-hidden rounded-xl border border-white/10 bg-[#0d0d20]">
						<ExhibitETranscript lines={transcript.lines} />
					</div>
				</div>
			</div>
		</section>
	);
}
