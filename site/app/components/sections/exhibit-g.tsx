import attackCorpusJson from "@/evidence/attack-corpus.json";
import CopyChip from "../copy-chip";
import InView from "../in-view";
import TerminalFrame from "../terminal-frame";
import { ROW_STAGGER_MS } from "./lib/exhibit-g-corpus";

/**
 * Exhibit G — the attack corpus (the redesign's adversarial-coverage addendum).
 *
 * Every row is a real test name plus the real AnchorState verdict string
 * (ANCHOR_MISMATCH, ANCHOR_INVALID, ...) derived at capture time by the
 * evidence pipeline from packages/core/tests/harden/anchoring/
 * anchor-corpus.test.ts. Nothing here is authored copy: the fixture is
 * the section.
 *
 * The corpus row shape is typed locally against the JSON contract
 * ({ attacks: [{ name, verdict }] }) so this file depends on the
 * fixture's shape, not on any type-export naming.
 *
 * The reproduction block is TerminalFrame, no title — the "reproduce it
 * yourself" caption sits above the frame as its own row, exactly as
 * exhibit-e.tsx's CopyChip caption does, since its full 44px touch target
 * can't fit a h-9 title-bar row without clipping against the frame's
 * rounded, clipped edge.
 *
 * The corpus table keeps the shared TerminalFrame contract's exact classes
 * inline instead: its title bar is two pieces (filename + row count,
 * `justify-between`), which is a ReactNode, not the single string
 * TerminalFrame's `title` prop accepts — so the container/title-bar/body
 * classes are hand-applied here rather than composed through the component
 * (documented in the retrofit report; this file's classes are the reference
 * the shared component (site/app/components/terminal-frame.tsx) was built
 * to match verbatim: container `overflow-hidden rounded-xl border
 * border-white/10 bg-terminal`, title bar `flex h-9 items-center border-b
 * border-white/[0.06] px-4 font-mono text-[11px] uppercase
 * tracking-[0.12em] text-white/50`, body `p-4 md:p-5 font-mono text-[13px]
 * leading-relaxed overflow-x-auto`).
 */
interface AttackRow {
	name: string;
	verdict: string;
}

const corpus = attackCorpusJson as { attacks: AttackRow[] };

const CORPUS_TEST_URL =
	"https://github.com/usertools-ai/usertrust/blob/master/packages/core/tests/harden/anchoring/anchor-corpus.test.ts";

const REPRO_LINES = [
	"git clone https://github.com/usertools-ai/usertrust.git",
	"cd usertrust",
	"npm ci",
	"npm test -- anchor-corpus",
];

const REPRO_COMMAND = REPRO_LINES.join(" && ");

/**
 * Semantic rationing: red is for failure verdicts only; emerald is the
 * mark of verification only. The corpus's happy-path control rows return
 * ANCHORED_VERIFIED (possibly with a warning suffix) and earn emerald —
 * every forgery row is red.
 */
function verdictClass(verdict: string): string {
	return verdict.startsWith("ANCHORED_VERIFIED") ? "text-ut" : "text-danger";
}

export default function ExhibitG() {
	return (
		<section id="exhibit-g" className="safe-x relative mx-auto max-w-6xl py-24 md:py-32">
			<p className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">exhibit g</p>
			<h2 className="font-display mt-4 lowercase leading-none text-white text-[clamp(2.5rem,7vw,5.5rem)]">
				every way we know to forge a ledger.
			</h2>
			<p className="font-display mt-2 lowercase leading-none text-white/50 text-[clamp(1.5rem,3.5vw,2.75rem)]">
				verified to fail, every one.
			</p>
			{/* the count numeral derives from the fixture — the headline word
			    carries no digit (check-facts stays clean by construction) */}
			<p className="mt-4 font-mono text-xs text-white/40">
				<span className="text-2xl leading-none text-white/90">{corpus.attacks.length}</span>{" "}
				scenarios · every verdict below is the string the verifier really returns
			</p>

			{/* terminal-styled corpus table — every row links to the real test file */}
			<div className="mt-10 overflow-hidden rounded-xl border border-white/10 bg-terminal">
				<div className="flex h-9 items-center justify-between gap-4 border-b border-white/[0.06] px-4 font-mono text-[11px] uppercase tracking-[0.12em] text-white/50">
					<span className="min-w-0 truncate">
						packages/core/tests/harden/anchoring/anchor-corpus.test.ts
					</span>
					<span className="shrink-0">{corpus.attacks.length} rows</span>
				</div>
				<InView>
					<ol className="list-none overflow-x-auto p-4 font-mono text-[13px] leading-relaxed md:p-5">
						{corpus.attacks.map((attack, i) => (
							<li
								key={attack.name}
								className="attack-row"
								style={{ animationDelay: `${i * ROW_STAGGER_MS}ms` }}
							>
								<a
									href={CORPUS_TEST_URL}
									target="_blank"
									rel="noreferrer"
									title={attack.name}
									className="focus-ring flex items-baseline justify-between gap-6 rounded-sm px-2 py-1.5 transition-colors hover:bg-white/[0.04]"
								>
									<span className="min-w-0 flex-1 truncate text-white/85">{attack.name}</span>
									<span
										className={`shrink-0 uppercase tracking-wide ${verdictClass(attack.verdict)}`}
									>
										{attack.verdict}
									</span>
								</a>
							</li>
						))}
					</ol>
				</InView>
			</div>

			{/* reproduction block — the corpus is one command sequence away */}
			<div className="mt-8 max-w-2xl">
				<div className="mb-3 flex items-center justify-between gap-4">
					<span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/50">
						reproduce it yourself
					</span>
					<CopyChip text={REPRO_COMMAND} label="copy reproduction commands" />
				</div>
				<TerminalFrame>
					<pre>
						{REPRO_LINES.map((line) => (
							<div key={line}>
								<span className="select-none text-white/35">$ </span>
								{line}
							</div>
						))}
					</pre>
				</TerminalFrame>
			</div>
			<p className="mt-3 font-mono text-xs text-white/40">don&rsquo;t trust us — recompute us.</p>
		</section>
	);
}
