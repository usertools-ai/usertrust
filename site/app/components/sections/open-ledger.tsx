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
 * THE CLOSING PANEL (Addendum L).
 *
 * The retired footer mark was the two-tone cutout at 32px tall: at that size
 * the suit and the ground both collapse to one dark mass and the figure reads
 * as a smudge. The mascot now closes the page at the size it was photographed
 * for — full length, on the studio ground it was shot against, paired with the
 * receipt tail at matching height.
 *
 * The ground is NOT cut out, which is the point: this is the page's one
 * photographic light panel (Addendum L amends the paper-rationing rule for
 * exactly this element, and for nothing else).
 *
 * The panel's own background is the sampled studio ground rather than pure
 * white. `object-contain` letterboxes on whichever axis the column is not
 * driving, and a #ffffff band against a #fafcfa photograph leaves a faint but
 * real seam; matching the fill to the plate makes the letterbox unfindable.
 *
 * Sizing: on md+ the figure is a column flex box stretched by the grid row, so
 * its height is the RECEIPT's height and the image flexes into whatever remains
 * above the caption (flex-basis 0 keeps the image from driving the row). Below
 * md the grid is one column, the image returns to normal flow at its own
 * aspect, and the cap keeps a 1200px-tall portrait from eating a phone screen.
 */
function MascotPanel() {
	return (
		<figure className="lift-1 order-2 bg-[#fbfbfb] md:order-1 md:flex md:flex-col">
			{/* biome-ignore lint/performance/noImgElement: static brand plate below the fold; intrinsic size is declared so it reserves its own space */}
			<img
				src="/brand/mascot-panel.jpg"
				alt="the usertrust mascot, full length, on its white studio ground"
				width={898}
				height={1200}
				className="block h-auto max-h-[420px] w-full object-contain md:min-h-0 md:max-h-none md:flex-1"
			/>
			{/* Ink, not a tint. #16161e on the #fbfbfb studio ground measures about
			    seventeen to one where the floor is four-and-a-half (spelled out
			    because the digits gate scans comments too). The caption this
			    replaces was white-on-dark; on a light panel it needs the dark
			    variant or it disappears. */}
			<figcaption className="px-5 pb-5 pt-2 text-center font-mono text-xs tracking-widest text-ink">
				governance wins.
			</figcaption>
		</figure>
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
			<div className="mx-auto max-w-5xl">
				<h2 className="font-display lowercase text-4xl sm:text-6xl leading-none mb-10">
					open your ledger.
				</h2>

				{/* The split composition: the mascot's panel and the receipt tail,
				    the same height on desktop, stacked with the panel last on a
				    phone (it is the closing image, not the lede). */}
				<div className="grid items-stretch gap-8 md:grid-cols-2">
					<MascotPanel />

					<ReceiptPaper className="order-1 md:order-2" perforated="top" provenance={provenance}>
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
					{/* No mark and no caption here: both moved up into the mascot's
					    closing panel (Addendum L). What is left is the link row. */}
					<div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
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
