import chainSliceJson from "@/evidence/chain-slice.json";
import type { ChainSlice } from "@/evidence/types";
import { computeMerkleGeometry } from "@/lib/exhibit-d";
import StageTag from "../stage-tag";
import ExhibitDDom from "./exhibit-d-dom";
import ExhibitDRibbon from "./exhibit-d-ribbon";
import ExhibitDStatic from "./exhibit-d-static";
import { routedTracePath, TRACE, traceVias } from "./lib/trace-style";

const slice = chainSliceJson as unknown as ChainSlice;

// Digit-bearing strings live here (never as JSX text) so check-facts passes.
const MERKLE_CAPTION = "sha-256 · rfc 6962 leaf and node prefixes";
// COPY REVIEW (Cam): descriptive, not declarative — flagged in the spec for
// Cam's wording review before launch. Do not edit without his sign-off.
const EU_FOOTNOTE = "built for the record-keeping era — EU AI Act Art. 12 traceability";
const ANCHOR_BADGES: { label: string; experimental?: boolean }[] = [
	{ label: "S3 Object Lock" },
	{ label: "git" },
	{ label: "SIEM" },
	{ label: "Rekor", experimental: true },
];
// Provenance must match the committed fixture: chain-slice.json is read from
// the LEDGER vault when the capture runs with TigerBeetle (scripts/
// capture-evidence.mts, `sliceVault = ledgerVault ?? dryVault`), and the
// current capture did. A dry-run-only capture would need this flipped back.
const CAPTURE_LABEL =
	"entries captured in ledger mode — TigerBeetle enforcing; dry-run writes the same audit chain without the ledger";
// The DOM demo's break arithmetic hashes each card's visible fields; the
// printed stubs are the vault's captured hashes over the full event record.
// Said on-page so the post-tamper "was …" digest differing from the printed
// stub reads as scope, not sleight of hand.
const DEMO_SCOPE =
	"live demo recomputes sha-256 over each card's visible fields — printed stubs are the vault's captured hashes over the full event record";
const SMALL_PRINT = "tamper-evident, not tamper-proof — detection, not recovery.";

function MerkleTree({ entries }: { entries: ChainSlice["entries"] }) {
	const geometry = computeMerkleGeometry(entries);
	// Every edge routed in the page's one circuit grammar (Addendum K) — the
	// bare diagonals these were are the only line-work on the page that spoke a
	// third dialect. `lead: "v"` because a merkle edge climbs: it runs straight
	// up out of its child, then closes the horizontal offset diagonally.
	const edges = [...geometry.leafLines, ...geometry.midLinesLow, ...geometry.midLinesHigh].map(
		(ln) => ({ key: ln.key, d: routedTracePath(ln.x1, ln.y1, ln.x2, ln.y2, { lead: "v" }) }),
	);
	// Vias mark the BRANCH points — every internal node two edges meet at.
	const vias = traceVias([
		...geometry.midNodesLow.map((n) => ({ x: n.x, y: geometry.midNodeCy })),
		...geometry.midNodesHigh.map((n) => ({ x: n.x, y: geometry.midNodeHighCy })),
	]);
	return (
		<svg
			viewBox={`0 0 ${geometry.viewBoxWidth} ${geometry.viewBoxHeight}`}
			role="img"
			aria-label="sparse merkle tree over the captured audit entries, reducing to a single root hash"
			className="trace-layer w-full"
		>
			{edges.map((e) => (
				<path key={e.key} d={e.d} className={TRACE.baseClass} strokeWidth={TRACE.baseWidth} />
			))}
			{edges.map((e) => (
				<path
					key={`${e.key}-core`}
					d={e.d}
					className={TRACE.coreClass}
					strokeWidth={TRACE.coreWidth}
				/>
			))}
			{geometry.leaves.map((leaf) => (
				<g key={leaf.key}>
					<rect
						x={leaf.rectX}
						y={geometry.leafRectY}
						width={geometry.leafRectWidth}
						height={geometry.leafRectHeight}
						rx={2}
						fill="#ffffff0f"
						stroke="#ffffff33"
					/>
					<text
						x={leaf.x}
						y={leaf.textY}
						textAnchor="middle"
						fill="#ffffff99"
						className="text-[12px]"
						fontFamily="var(--font-jetbrains), monospace"
					>
						{leaf.label}
					</text>
				</g>
			))}
			{vias.map((v) => (
				<circle key={v.key} cx={v.x} cy={v.y} r={TRACE.viaRadius} className={TRACE.viaClass} />
			))}
			<circle
				cx={geometry.root.x}
				cy={geometry.root.y}
				r={geometry.root.radius}
				className={TRACE.padClass}
			/>
			<text
				x={geometry.root.labelX}
				y={geometry.root.labelY}
				fill="#34d399"
				className="text-[12px]"
				fontFamily="var(--font-jetbrains), monospace"
			>
				root
			</text>
		</svg>
	);
}

export default function ExhibitD() {
	return (
		<section
			id="exhibit-d"
			data-theme="emerald"
			className="section-anchor safe-x relative mx-auto max-w-6xl py-14 sm:py-20"
		>
			<p className="section-eyebrow">exhibit d</p>
			<div className="mt-2 flex items-center gap-1.5">
				<StageTag stage="RECORD" />
				<StageTag stage="ANCHOR" />
			</div>
			<h2 className="font-display mt-3 lowercase leading-none text-white text-[clamp(2.5rem,7vw,5.5rem)]">
				tamper with one byte. break the whole chain.
			</h2>

			{/* The tree ended at ~860px while the content column ran to ~1310px, and
			    the two caption rows then repeated that dead width full-bleed below
			    it (N3). Side by side, the wider column renders the same viewBox at
			    roughly its current size — no label rescale — and the block loses
			    ~140px. */}
			<div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-center lg:gap-10">
				<div className="min-w-0 overflow-x-auto">
					<div className="min-w-[40rem]">
						<MerkleTree entries={slice.entries} />
					</div>
				</div>

				<div className="grid min-w-0 gap-3">
					<div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t border-brand-border pt-3">
						<h3 className="font-display text-xl lowercase text-white">the chain verifies itself</h3>
						<p className="font-mono text-xs text-white/70">{MERKLE_CAPTION}</p>
					</div>
					<div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-brand-border pt-3">
						<h3 className="font-display text-xl lowercase text-white">
							and can be anchored beyond your infra
						</h3>
						{/* EXPERIMENTAL is a baseline-aligned mini-tag, not a <sup>. A
					    <sup> keeps its superscript raise while `text-[12px]` cancels
					    the browser's compensating size reduction, so the raised
					    full-size line box grew the Rekor chip well past its siblings
					    and pushed the glyph caps through the chip's top hairline at
					    390px. The 12px floor (Addendum H) is kept; only the raise is dropped. */}
						<ul className="flex flex-wrap gap-2">
							{ANCHOR_BADGES.map((b) => (
								<li
									key={b.label}
									className="inline-flex items-center gap-1 rounded-sm border border-brand-border px-2 py-1 font-mono text-xs text-white/70"
								>
									{b.label}
									{b.experimental && (
										<span className="font-mono text-[12px] tracking-widest text-white/70">
											EXPERIMENTAL
										</span>
									)}
								</li>
							))}
						</ul>
						<p className="w-full font-mono text-[12px] text-white/70">{CAPTURE_LABEL}</p>
					</div>
				</div>
			</div>

			{/* Canvas ribbon: desktop + motion-safe only. The DOM demo below is THE
			    interactive path and is always present. */}
			<div aria-hidden="true" className="mt-8 hidden motion-safe:md:block">
				<ExhibitDRibbon entries={slice.entries} />
			</div>
			<div className="mt-8 motion-safe:md:hidden">
				<ExhibitDStatic entries={slice.entries} />
			</div>

			<div className="mt-6">
				<ExhibitDDom entries={slice.entries} />
				<p className="mt-2 font-mono text-[12px] text-white/70">{DEMO_SCOPE}</p>
			</div>

			{/* Three left-aligned mono lines, each owning a full 1120px row for
			    ~930px of combined text. They fit one flex rail at desktop width and
			    wrap cleanly below it. */}
			<div className="mt-6 flex flex-wrap items-baseline gap-x-8 gap-y-2">
				<a
					href="/evidence/chain.jsonl"
					className="focus-ring inline-block font-mono text-xs text-tim hover:text-white"
				>
					view raw JSONL →
				</a>
				<p className="font-mono text-xs text-white/70">{EU_FOOTNOTE}</p>
				<p className="font-mono text-[12px] text-white/70">{SMALL_PRINT}</p>
			</div>
		</section>
	);
}
