import chain from "../../evidence/chain-slice.json";
import facts from "../../evidence/facts.json";
import { barcodeBars, chainHeadHash, chainHeadPrefix, isoDate } from "../../lib/barcode";
import CopyChip from "../copy-chip";
import ReceiptPaper from "../receipt/receipt-paper";
import TearOff from "./tear-off";

/*
 * Waitlist capture for the one tier that does not ship yet. Built with
 * encodeURIComponent rather than a pre-escaped literal: percent-escapes in a
 * hand-written mailto are digit tokens to the line-based check-facts scan, and
 * the old literal only ever passed because its escape happened to match a
 * sanctioned token in the models fact. Growing the pricing table changed that
 * fact and the line started failing — a gate passing by coincidence is a gate
 * that fails on an unrelated change, which is precisely what happened.
 */
const WAITLIST_HREF = `mailto:hello@usertools.ai?subject=${encodeURIComponent(
	"usertrust managed proxy access",
)}`;

const FOOTER_LINKS: { label: string; href: string; external: boolean }[] = [
	{ label: "Docs", href: "/docs", external: false },
	{ label: "GitHub", href: "https://github.com/usertools-ai/usertrust", external: true },
	{ label: "npm", href: "https://www.npmjs.com/package/usertrust", external: true },
	{
		label: "License",
		href: "https://github.com/usertools-ai/usertrust/blob/master/LICENSE",
		external: true,
	},
	{ label: "Usertools", href: "https://usertools.ai", external: true },
];

function DottedLeader({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-baseline gap-2 font-mono text-sm text-ink/80">
			<span>{label}</span>
			<span aria-hidden="true" className="flex-1 border-b border-dotted border-ink/40" />
			<span>{value}</span>
		</div>
	);
}

/*
 * Open Ledger — the receipt tail: install chips, ownership creed, dry-run
 * honesty line, dotted leaders, chain-head barcode, tear-off stub CTA, then
 * the deploy ladder and the dark footer strip. Replaces the old cta.tsx +
 * footer.tsx.
 */
export default function OpenLedger() {
	const f = facts.facts;
	const head = chainHeadHash(chain.entries);
	const prefix = chainHeadPrefix(head);
	const { bars, total } = barcodeBars(prefix);
	const provenance = `captured v${facts.usertrustVersion} · ${isoDate(facts.generatedAt)}`;

	return (
		<section
			id="open-ledger"
			data-theme="emerald"
			className="section-anchor relative pt-24 sm:pt-32 safe-x"
		>
			<div className="mx-auto max-w-xl">
				<h2 className="font-display lowercase text-4xl sm:text-6xl leading-none mb-10">
					open your ledger.
				</h2>

				<ReceiptPaper perforated="top" provenance={provenance}>
					<div className="flex flex-col gap-5 p-6">
						<div className="flex flex-col gap-3">
							<CopyChip text="npm install usertrust" tone="paper" />
							<CopyChip text="npx usertrust init" tone="paper" />
						</div>

						<p className="font-mono text-sm font-bold text-ink">
							your keys. your billing. your evidence.
						</p>

						<p className="font-mono text-xs text-ink/70">
							start in dry-run — no TigerBeetle required; receipts marked accordingly
						</p>

						<div className="flex flex-col gap-1.5 border-t border-ink/15 pt-4">
							<DottedLeader label="setup" value={`${f.quickstartMinutes.value} min`} />
							<DottedLeader
								label="runtime deps (verifier)"
								value={String(f.verifierRuntimeDeps.value)}
							/>
							<DottedLeader label="license" value={f.license.value} />
							<p className="mt-1 font-mono text-sm font-bold uppercase text-ink">
								TOTAL SURPRISES ··· 0
							</p>
						</div>

						<div className="border-t border-ink/15 pt-4">
							<svg
								viewBox={`0 0 ${total} 40`}
								preserveAspectRatio="none"
								className="h-10 w-full text-ink"
								role="img"
								aria-label={`barcode motif encoding chain head ${prefix}`}
							>
								{bars.map((b) => (
									<rect key={b.x} x={b.x} y={0} width={b.width} height={40} fill="currentColor" />
								))}
							</svg>
							<p className="mt-1 font-mono text-[12px] tracking-wider text-ink/70">
								chain head {prefix}
							</p>
						</div>
					</div>
					<TearOff />
				</ReceiptPaper>
			</div>

			{/* deploy ladder — the redesign's deploy-ladder addendum. Two tiers
			    ship today with real commands; the managed proxy is a mailto
			    capture, never a fake service claim. Dark ground: emerald is
			    the status ink only. */}
			<div className="mx-auto mt-24 max-w-5xl">
				<h3 className="font-display lowercase text-2xl text-white">run it where you need it.</h3>
				<ul className="mt-6 grid gap-4 sm:grid-cols-3">
					<li className="flex flex-col gap-3 rounded-sm border border-white/[0.06] bg-white/[0.02] p-5">
						<p className="font-mono text-xs uppercase tracking-widest text-white/70">local SDK</p>
						<p className="font-mono text-[12px] uppercase tracking-widest text-ut">
							shipping today
						</p>
						<div className="mt-auto">
							<CopyChip text="npm install usertrust" />
						</div>
					</li>
					<li className="flex flex-col gap-3 rounded-sm border border-white/[0.06] bg-white/[0.02] p-5">
						<p className="font-mono text-xs uppercase tracking-widest text-white/70">
							self-hosted control plane
						</p>
						<p className="font-mono text-[12px] uppercase tracking-widest text-ut">
							shipping today
						</p>
						<div className="mt-auto">
							<CopyChip text="npx usertrust-server" />
						</div>
					</li>
					<li className="flex flex-col gap-3 rounded-sm border border-white/[0.06] bg-white/[0.02] p-5">
						<p className="font-mono text-xs uppercase tracking-widest text-white/70">
							managed proxy
						</p>
						<a
							href={WAITLIST_HREF}
							className="focus-ring mt-auto inline-flex min-h-[44px] items-center font-mono text-sm text-white/70 hover:text-ut transition-colors duration-200"
						>
							request access →
						</a>
					</li>
				</ul>
			</div>

			{/* dark footer strip */}
			<footer className="mt-24 border-t border-white/[0.06]">
				<div className="mx-auto max-w-5xl py-10">
					{/* mascot mark — clean two-tone cutout (white face/gloves/shirt,
					    dark suit), renders at 32px tall (h-8) with no rounded corners,
					    centered above the usertools attribution line. */}
					<div className="flex flex-col items-center gap-2 text-center">
						{/* biome-ignore lint/performance/noImgElement: tiny static footer mark, not an LCP candidate */}
						<img src="/brand/mascot-mark.png" alt="the usertrust mascot" className="h-8 w-auto" />
						<p className="font-mono text-xs text-white/70">governance wins.</p>
					</div>

					<div className="mt-8 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
						<nav aria-label="footer" className="flex flex-wrap items-center gap-x-6 gap-y-2">
							{FOOTER_LINKS.map((l) => (
								<a
									key={l.label}
									href={l.href}
									{...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
									className="focus-ring inline-flex min-h-[44px] items-center font-mono text-sm text-white/70 hover:text-white transition-colors duration-200"
								>
									{l.label}
								</a>
							))}
						</nav>
						<p className="font-mono text-xs text-white/70">
							usertrust · part of{" "}
							<a
								href="https://usertools.ai"
								target="_blank"
								rel="noopener noreferrer"
								className="focus-ring underline decoration-white/50 underline-offset-4 text-white/90 hover:text-ut transition-colors duration-200"
							>
								usertools.ai
							</a>
						</p>
					</div>
				</div>
			</footer>
		</section>
	);
}
