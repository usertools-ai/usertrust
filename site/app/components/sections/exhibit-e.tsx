import factsJson from "@/evidence/facts.json";
import type { EvidenceFacts, VerifyTranscript } from "@/evidence/types";
import verifyTranscriptJson from "@/evidence/verify-transcript.json";
import CopyChip from "../copy-chip";
import StageTag from "../stage-tag";
import TerminalFrame from "../terminal-frame";
import ExhibitETranscript from "./exhibit-e-transcript";

const facts = factsJson as unknown as EvidenceFacts;
const transcript = verifyTranscriptJson as unknown as VerifyTranscript;

/**
 * Exhibit E — the giant zero renders from facts.verifierRuntimeDeps.value,
 * never a literal (check-facts enforces this).
 *
 * The terminal below is TerminalFrame, no title: this server component
 * passes the client transcript island through as children, so the shared
 * chrome and the typewriter island compose across the server/client
 * boundary without either side needing to know about the other. The
 * contract's optional title bar is skipped on purpose: its fixed-height row
 * can't host CopyChip's full touch target without clipping it against the
 * frame's rounded, clipped edge, so the "usertrust-verify" label and its
 * copy chip sit as a caption directly above the frame instead — visually
 * adjacent, as the exhibit calls for, without fighting the shared
 * contract's row height.
 */
export default function ExhibitE() {
	const deps = facts.facts.verifierRuntimeDeps;
	return (
		<section
			id="exhibit-e"
			data-theme="gold"
			className="section-anchor ground-zone safe-x relative py-24 sm:py-32"
		>
			<div className="mx-auto max-w-6xl">
				<p className="section-eyebrow">exhibit e</p>
				<div className="mt-3 flex items-center gap-1.5">
					<StageTag stage="VERIFY" />
				</div>
				<h2 className="font-display mt-4 lowercase leading-none text-white text-[clamp(2.5rem,7vw,5.5rem)]">
					don&rsquo;t take our word for it.
				</h2>

				<div className="mt-12 grid items-center gap-12 md:grid-cols-2">
					{/* set-piece: the outlined zero over halftone */}
					<figure className="glow-emerald relative flex flex-col items-center justify-center py-8">
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
							<p className="mt-2 font-mono text-xs text-white/70">the verifier owes us nothing.</p>
							{/* provenance stub — provenance as a design element */}
							<p className="mt-1 font-mono text-[12px] text-white/70">{deps.source}</p>
						</figcaption>
					</figure>

					{/* terminal: the captured workspace-verifier transcript */}
					<div>
						{/* Stacked below sm: on a phone the narrow label column forced
						    the tracked label onto two lines beside a two-line chip. */}
						<div className="mb-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
							<span className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
								usertrust-verify
							</span>
							<CopyChip text={transcript.command} label="copy verify command" />
						</div>
						<TerminalFrame>
							<ExhibitETranscript lines={transcript.lines} />
						</TerminalFrame>
					</div>
				</div>
			</div>
		</section>
	);
}
