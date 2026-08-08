import type { ChainSlice } from "@/evidence/types";
import { STATIC_STUB_GAP, STATIC_STUB_WIDTH, staticStubLayout } from "@/lib/exhibit-d";

/**
 * Server-rendered fallback shown instead of the canvas ribbon on narrow
 * viewports and under prefers-reduced-motion (visibility is CSS-gated by the
 * wrapper in exhibit-d.tsx). Four stubs, each prevHash arrow pointing BACK
 * at the hash of the entry before it. Layout math lives in
 * app/lib/exhibit-d.ts — see that file's header for why.
 */
export default function ExhibitDStatic({ entries }: { entries: ChainSlice["entries"] }) {
	const stubs = staticStubLayout(entries);
	return (
		<svg
			viewBox="0 0 640 120"
			role="img"
			aria-label="four audit-chain receipt stubs; each entry's prevHash points at the hash of the entry before it"
			className="w-full max-w-2xl"
		>
			{stubs.map((stub) => (
				<g key={stub.entry.hash}>
					<rect
						x={stub.x}
						y={18}
						width={STATIC_STUB_WIDTH}
						height={84}
						rx={2}
						fill="#ffffff0d"
						stroke="#ffffff26"
					/>
					<line
						x1={stub.x}
						y1={18}
						x2={stub.x + STATIC_STUB_WIDTH}
						y2={18}
						stroke="#0a0a1a"
						strokeWidth="3"
						strokeDasharray="4 5"
					/>
					<line
						x1={stub.x}
						y1={102}
						x2={stub.x + STATIC_STUB_WIDTH}
						y2={102}
						stroke="#0a0a1a"
						strokeWidth="3"
						strokeDasharray="4 5"
					/>
					<text
						x={stub.x + 10}
						y={42}
						fill="#ffffffcc"
						className="text-[11px]"
						fontFamily="var(--font-jetbrains), monospace"
					>
						{stub.typeLabel}
					</text>
					<text
						x={stub.x + 10}
						y={62}
						fill="#ffffff8c"
						className="text-[10px]"
						fontFamily="var(--font-jetbrains), monospace"
					>
						{stub.hashLabel}
					</text>
					<text
						x={stub.x + 10}
						y={80}
						fill="#6ca0c0e6"
						className="text-[10px]"
						fontFamily="var(--font-jetbrains), monospace"
					>
						{stub.prevLabel}
					</text>
					{stub.hasNext && (
						<g>
							<line
								x1={stub.x + STATIC_STUB_WIDTH}
								y1={60}
								x2={stub.x + STATIC_STUB_WIDTH + STATIC_STUB_GAP}
								y2={60}
								stroke="#34d399"
								strokeWidth="1.5"
							/>
							{/* arrowhead on the LEFT end — prevHash points backward */}
							<path
								d={`M ${stub.x + STATIC_STUB_WIDTH + 6} 55 L ${stub.x + STATIC_STUB_WIDTH} 60 L ${stub.x + STATIC_STUB_WIDTH + 6} 65`}
								fill="none"
								stroke="#34d399"
								strokeWidth="1.5"
							/>
						</g>
					)}
				</g>
			))}
		</svg>
	);
}
