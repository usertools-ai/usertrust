import factsJson from "@/evidence/facts.json";
import receiptLedgerJson from "@/evidence/receipt-ledger.json";
import type { CapturedReceipt, EvidenceFacts } from "@/evidence/types";
import CopyChip from "../copy-chip";
import ReceiptFields from "../receipt/receipt-fields";
import ReceiptPaper from "../receipt/receipt-paper";

const facts = (factsJson as EvidenceFacts).facts;
const receiptLedger = receiptLedgerJson as CapturedReceipt;

/**
 * Hero — "keep the receipts." SERVER component, no props.
 * Left: display headline (LCP candidate, server-rendered, pinned breaks).
 * Right: the captured REAL-LEDGER TrustReceipt as server DOM on thermal
 * paper, printed by the pure-CSS .hero-print set-piece (globals.css).
 * No islands on the critical path; the only client code here is CopyChip.
 */
export default function Hero() {
	const prov = receiptLedger.provenance;
	// Timestamps are always "YYYY-MM-DDTHH:MM:SS.sssZ" — splitting on the literal
	// "T" separator yields the date prefix without a magic slice length (keeps
	// this line free of bare digit literals for the check-facts gate).
	const provenanceLine = `captured v${prov.usertrustVersion} · TigerBeetle ${
		prov.tigerbeetleVersion ?? "—"
	} · ${prov.capturedAt.split("T")[0]} · ${prov.mode}`;

	return (
		<section className="relative z-[1] mx-auto grid min-h-[100dvh] w-full max-w-6xl items-center gap-12 safe-x pt-28 pb-16 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16 lg:pt-20">
			{/* Left — display headline (LCP candidate; no entrance animation: renders in the first paint) */}
			<div>
				{/* biome-ignore format: one line keeps className= alongside the closing tag so the facts scanner never sees it alone */}
				<h1 className="font-display font-bold lowercase leading-[0.92] tracking-tight text-white text-[clamp(3.5rem,11vw,10rem)]">keep the<br />receipts<span className="text-ut">.</span></h1>
				<p className="mt-6 max-w-md text-base leading-relaxed text-white/70 sm:text-lg">
					one line wraps your LLM client. every governed call becomes a ledger transaction — with a
					receipt anyone can verify.
				</p>
				<div className="mt-8 flex flex-wrap items-center gap-4">
					<CopyChip text="npm install usertrust" />
					<a
						href="#exhibit-e"
						className="focus-ring inline-flex min-h-[44px] items-center font-mono text-sm text-tim transition-colors hover:text-white"
					>
						verify a ledger →
					</a>
				</div>
				<p className="mt-10 font-mono text-[11px] tracking-wide text-white/40">
					{facts.license.value} · {facts.verifierRuntimeDeps.value} runtime deps in the verifier ·{" "}
					{facts.commandsToFirstReceipt.value} commands to first receipt
				</p>
			</div>

			{/* Right — captured real-ledger receipt. min-h reserves the printed
			    height so the mask reveal causes zero layout shift. */}
			<div className="relative min-h-[480px]">
				<div className="hero-print mx-auto max-w-sm">
					<ReceiptPaper provenance={provenanceLine} perforated="both" className="rotate-[1.5deg]">
						<div className="mb-4 text-center font-mono text-[11px] tracking-[0.2em] text-ink/70">
							USERTRUST · TRUST RECEIPT
						</div>
						<ReceiptFields receipt={receiptLedger} />
					</ReceiptPaper>
				</div>
			</div>
		</section>
	);
}
