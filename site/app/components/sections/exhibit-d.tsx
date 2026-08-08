import chainSliceJson from "@/evidence/chain-slice.json";
import type { ChainSlice } from "@/evidence/types";
import { computeMerkleGeometry } from "@/lib/exhibit-d";
import StageTag from "../stage-tag";
import ExhibitDDom from "./exhibit-d-dom";
import ExhibitDRibbon from "./exhibit-d-ribbon";
import ExhibitDStatic from "./exhibit-d-static";

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
const DRY_RUN_LABEL =
	"entries captured in dry-run — audit + policy only; ledger enforcement requires TigerBeetle";
const SMALL_PRINT = "tamper-evident, not tamper-proof — detection, not recovery.";

function MerkleTree({ entries }: { entries: ChainSlice["entries"] }) {
	const geometry = computeMerkleGeometry(entries);
	return (
		<svg
			viewBox={`0 0 ${geometry.viewBoxWidth} ${geometry.viewBoxHeight}`}
			role="img"
			aria-label="sparse merkle tree over the captured audit entries, reducing to a single root hash"
			className="w-full"
		>
			{geometry.leafLines.map((ln) => (
				<line
					key={ln.key}
					x1={ln.x1}
					y1={ln.y1}
					x2={ln.x2}
					y2={ln.y2}
					stroke="#ffffff40"
					strokeWidth="1"
				/>
			))}
			{geometry.midLinesLow.map((ln) => (
				<line
					key={ln.key}
					x1={ln.x1}
					y1={ln.y1}
					x2={ln.x2}
					y2={ln.y2}
					stroke="#ffffff40"
					strokeWidth="1"
				/>
			))}
			{geometry.midLinesHigh.map((ln) => (
				<line
					key={ln.key}
					x1={ln.x1}
					y1={ln.y1}
					x2={ln.x2}
					y2={ln.y2}
					stroke="#ffffff40"
					strokeWidth="1"
				/>
			))}
			{geometry.leaves.map((leaf) => (
				<g key={leaf.key}>
					<rect
						x={leaf.rectX}
						y={geometry.leafRectY}
						width={geometry.leafRectWidth}
						height={geometry.leafRectHeight}
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
			{geometry.midNodesLow.map((node) => (
				<circle
					key={node.key}
					cx={node.x}
					cy={geometry.midNodeCy}
					r={geometry.nodeRadius}
					fill="#6ca0c0cc"
				/>
			))}
			{geometry.midNodesHigh.map((node) => (
				<circle
					key={node.key}
					cx={node.x}
					cy={geometry.midNodeHighCy}
					r={geometry.nodeRadius}
					fill="#6ca0c0cc"
				/>
			))}
			<circle cx={geometry.root.x} cy={geometry.root.y} r={geometry.root.radius} fill="#34d399" />
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
		<section id="exhibit-d" className="safe-x relative mx-auto max-w-6xl py-24 md:py-32">
			<p className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">exhibit d</p>
			<div className="mt-3 flex items-center gap-1.5">
				<StageTag stage="RECORD" />
				<StageTag stage="ANCHOR" />
			</div>
			<h2 className="font-display mt-4 lowercase leading-none text-white text-[clamp(2.5rem,7vw,5.5rem)]">
				tamper with one byte. break the whole chain.
			</h2>

			<div className="mt-12 overflow-x-auto">
				<div className="min-w-[40rem] max-w-2xl">
					<MerkleTree entries={slice.entries} />
				</div>
			</div>

			<div className="mt-8 grid gap-3">
				<div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t border-brand-border pt-3">
					<h3 className="font-display text-xl lowercase text-white">the chain verifies itself</h3>
					<p className="font-mono text-xs text-white/70">{MERKLE_CAPTION}</p>
				</div>
				<div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-brand-border pt-3">
					<h3 className="font-display text-xl lowercase text-white">
						and can be anchored beyond your infra
					</h3>
					<ul className="flex flex-wrap gap-2">
						{ANCHOR_BADGES.map((b) => (
							<li
								key={b.label}
								className="rounded-sm border border-brand-border px-2 py-1 font-mono text-xs text-white/70"
							>
								{b.label}
								{b.experimental && (
									<sup className="ml-1 font-mono text-[12px] tracking-widest text-white/70">
										EXPERIMENTAL
									</sup>
								)}
							</li>
						))}
					</ul>
					<p className="w-full font-mono text-[12px] text-white/70">{DRY_RUN_LABEL}</p>
				</div>
			</div>

			{/* Canvas ribbon: desktop + motion-safe only. The DOM demo below is THE
			    interactive path and is always present. */}
			<div aria-hidden="true" className="mt-12 hidden motion-safe:md:block">
				<ExhibitDRibbon entries={slice.entries} />
			</div>
			<div className="mt-12 motion-safe:md:hidden">
				<ExhibitDStatic entries={slice.entries} />
			</div>

			<div className="mt-8">
				<ExhibitDDom entries={slice.entries} />
			</div>

			<a
				href="/evidence/chain.jsonl"
				className="focus-ring mt-6 inline-block font-mono text-xs text-tim hover:text-white"
			>
				view raw JSONL →
			</a>
			<p className="mt-6 font-mono text-xs text-white/40">{EU_FOOTNOTE}</p>
			<p className="mt-2 font-mono text-[12px] text-white/70">{SMALL_PRINT}</p>
		</section>
	);
}
