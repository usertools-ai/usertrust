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
			className="section-anchor ground-zone safe-x relative py-14 sm:py-20"
		>
			<div className="mx-auto max-w-6xl">
				<p className="section-eyebrow">exhibit e</p>
				<div className="mt-2 flex items-center gap-1.5">
					<StageTag stage="VERIFY" />
				</div>
				<h2 className="font-display mt-3 lowercase leading-none text-white text-[clamp(2.5rem,7vw,5.5rem)]">
					don&rsquo;t take our word for it.
				</h2>

				{/* min-w-0 on both tracks: a grid item's default minimum is its
				    CONTENT's min-content, and `overflow-x-auto` inside the frame does
				    not lower that — so the transcript's full-length merkle root (one
				    unbreakable hex token, ~538px wide at the 14px body size) blew the
				    single column out to 572px at a 390px viewport. Body is overflow-x-hidden,
				    so the overflow was CLIPPED rather than scrollable: the right third
				    of the terminal, root hash included, was unreachable on a phone.
				    With the minimum pinned, the line scrolls inside TerminalFrame's own
				    overflow-x-auto, which is what the frame is for. Same defect and
				    same fix as the Exhibit A grid documents. */}
				{/* Two-fifths · three-fifths at lg, not an even split: the transcript
				    is the dense artifact and at ~640px inner its full-length merkle
				    root fits without the wrap the even row forced, while the airy zero
				    cedes width it was not using. */}
				<div className="mt-8 grid grid-cols-[minmax(0,1fr)] items-center gap-8 md:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
					{/* set-piece: the outlined zero over halftone. The caption folds
					    beside the glyph at lg so the figure stops towering ~90px past
					    the terminal beside it. */}
					<figure className="glow-emerald relative flex min-w-0 flex-col items-center justify-center gap-x-8 py-4 lg:flex-row">
						<div aria-hidden="true" className="halftone absolute inset-0" />
						<span
							className="font-display relative select-none leading-none text-transparent"
							style={{
								WebkitTextStroke: "2px var(--color-ut)",
								fontSize: "clamp(9rem,16vw,15rem)",
							}}
						>
							{deps.value}
						</span>
						<figcaption className="relative mt-2 text-center lg:mt-0 lg:max-w-56 lg:text-left">
							<p className="text-lg text-white/80">runtime dependencies in the verifier.</p>
							<p className="mt-2 font-mono text-xs text-white/70">the verifier owes us nothing.</p>
							{/* provenance stub — provenance as a design element */}
							<p className="mt-1 font-mono text-[12px] text-white/70">{deps.source}</p>
						</figcaption>
					</figure>

					{/* terminal: the captured workspace-verifier transcript */}
					<div className="min-w-0">
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
