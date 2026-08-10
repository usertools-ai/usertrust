import attackCorpusJson from "@/evidence/attack-corpus.json";
import CopyChip from "../copy-chip";
import InView from "../in-view";
import StageTag from "../stage-tag";
import TerminalFrame from "../terminal-frame";
import {
	displayTitle,
	ROW_STAGGER_MS,
	rowIndexLabel,
	titleCarriesSpecNumber,
} from "./lib/exhibit-g-corpus";

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
 * The corpus table renders through the same shared TerminalFrame: its
 * title bar is two pieces (filename + row count, `justify-between`), passed
 * as a ReactNode `title` — TerminalFrame's title accepts any ReactNode, not
 * just a string, precisely so a bar like this one composes through the
 * component instead of duplicating its classes beside it.
 */
interface AttackRow {
	name: string;
	verdict: string;
}

const corpus = attackCorpusJson as { attacks: AttackRow[] };

/* Whether any title still opens with its own spec-row number — which decides
   whether the table needs the "indexed by row" footnote at all. Derived, so
   the footnote disappears on its own if the corpus titles ever change. */
const TITLES_CARRY_SPEC_NUMBERS = corpus.attacks.some((a) => titleCarriesSpecNumber(a.name));

/**
 * The table's footnote. It states both true things at once: the gutter is the
 * only numbering on the page, and the titles are still the source titles —
 * linked, verbatim, prefix and all, at the other end of every row's href.
 *
 * IT LIVES HERE, in the scanned surface, with the rest of the section's copy.
 * It spent one revision in `lib/exhibit-g-corpus.ts` for the sole reason that
 * check-facts does not walk that directory, and the two digits below (an
 * upstream spec row, and the scenario it was folded into) have no facts.json
 * entry because they are facts about packages/core/tests/harden, not about the
 * product. That made the exemption a matter of ADDRESS rather than of review —
 * a precedent under which any sentence could be exempted by moving it one
 * directory sideways. The parenthetical is now sanctioned BY NAME in
 * scripts/check-facts.mts (SANCTIONED_PROSE), where a reviewer sees it and
 * where a near-miss still fails the build.
 */
const CORPUS_FOOTNOTE =
	"indexed by row · source test titles linked verbatim; their original spec-row prefixes are omitted (row 17 was folded into scenario 5 upstream).";

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
		<section
			id="exhibit-g"
			data-theme="purple"
			className="section-anchor ground-zone safe-x relative py-14 sm:py-20"
		>
			<div className="mx-auto max-w-6xl">
				<p className="section-eyebrow">exhibit g</p>
				<div className="mt-2 flex items-center gap-1.5">
					<StageTag stage="VERIFY" />
				</div>
				<h2 className="font-display mt-3 lowercase leading-none text-white text-[clamp(2.5rem,7vw,5.5rem)]">
					every way we know to forge a ledger.
				</h2>
				<p className="font-display mt-2 lowercase leading-none text-white/50 text-[clamp(1.5rem,3.5vw,2.75rem)]">
					every forgery fails. every legitimate operation verifies.
				</p>
				{/* the count numeral derives from the fixture — the headline word
			    carries no digit (check-facts stays clean by construction) */}
				<p className="mt-3 font-mono text-xs text-white/70">
					<span className="text-2xl leading-none text-white/90">{corpus.attacks.length}</span>{" "}
					scenarios · every verdict below is the string the verifier really returns
				</p>
				{/* The legend the subhead now requires. Not every row is an attack: the
				    corpus includes CONTROL cases — a benign duplicate, a clean rotation,
				    the happy paths — whose correct answer is ANCHORED_VERIFIED. Without
				    this line an emerald row sitting under "every forgery fails" reads as
				    a forgery that got through. */}
				<p className="mt-2 font-mono text-[12px] leading-5 text-white/70">
					<span className="text-ut">emerald</span> rows are control cases — legitimate operations
					that must verify. <span className="text-danger-ink">red</span> rows are forgeries the
					verifier must refuse.
				</p>

				{/* terminal-styled corpus table — every row links to the real test file */}
				<TerminalFrame
					className="mt-8"
					title={
						<div className="flex w-full items-center justify-between gap-4">
							<span className="min-w-0 truncate">
								packages/core/tests/harden/anchoring/anchor-corpus.test.ts
							</span>
							<span className="shrink-0">{corpus.attacks.length} rows</span>
						</div>
					}
				>
					<InView>
						{/* min-w-max below sm: the rows keep their intrinsic width and
						    scroll inside TerminalFrame's own overflow-x-auto, which is
						    what the frame is for. truncate shrink-to-fit meant the
						    container never overflowed and so never scrolled, collapsing
						    every scenario to a dozen characters with no way to read the
						    rest — the title attribute does not exist on touch. */}
						<ol className="list-none min-w-max sm:min-w-0">
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
										data-cursor-hover
										// The hover ground is the nav's own token; the previous
										// value shifted the ground barely past the threshold
										// of perception. Paired with a text lift so the row
										// answers the pointer the way every other interactive
										// row on the page does. corpus-row-link (globals.css,
										// Addendum M3) intensifies that ground and tints it with
										// the section accent instead of a plain white wash.
										className="focus-ring group corpus-row-link flex items-baseline gap-4 rounded-sm px-2 py-1.5 transition-colors"
									>
										<span aria-hidden="true" className="shrink-0 tabular-nums text-white/50">
											{rowIndexLabel(i, corpus.attacks.length)}
										</span>
										{/* The SOURCE title, minus its spec-row prefix — a render
										    transform only (displayTitle); the fixture and the link
										    above it stay verbatim. `title` keeps the full attribute
										    text for the tooltip, prefix and all. */}
										<span className="min-w-0 flex-1 whitespace-nowrap text-white/85 transition-colors group-hover:text-white sm:truncate sm:whitespace-normal">
											{displayTitle(attack.name)}
										</span>
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
				</TerminalFrame>
				{TITLES_CARRY_SPEC_NUMBERS && (
					<p className="mt-3 font-mono text-[12px] leading-5 text-white/70">{CORPUS_FOOTNOTE}</p>
				)}

				{/* reproduction block — the corpus is one command sequence away. The
				    terminal used to be capped at 672px against an 1152px column with
				    a ~480px dead right half, and the section's best line was buried
				    under it as a footnote in the smallest register on the page (N3).
				    The wider terminal track (~640px, every command well inside the
				    measure cap) now pairs with that line promoted into the section's
				    own white/50 display register — the same one the subhead above
				    uses. Text unchanged. */}
				<div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-center lg:gap-10">
					<div className="min-w-0">
						<div className="mb-3 flex items-center justify-between gap-4">
							<span className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
								reproduce it yourself
							</span>
							<CopyChip text={REPRO_COMMAND} label="copy reproduction commands" />
						</div>
						<TerminalFrame>
							<pre>
								{REPRO_LINES.map((line) => (
									<div key={line}>
										<span className="select-none text-white/50">$ </span>
										{line}
									</div>
								))}
							</pre>
						</TerminalFrame>
					</div>
					<p className="font-display lowercase leading-tight text-white/50 text-[clamp(1.75rem,2.5vw,2.5rem)]">
						don&rsquo;t trust us — recompute us.
					</p>
				</div>
			</div>
		</section>
	);
}
