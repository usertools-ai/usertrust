import chainSliceJson from "@/evidence/chain-slice.json";
import factsJson from "@/evidence/facts.json";
import receiptLedgerJson from "@/evidence/receipt-ledger.json";
import type { CapturedReceipt, ChainSlice, EvidenceFacts } from "@/evidence/types";
import { chainSeqFor, receiptJsonLines, tokenClass } from "../../lib/receipt-json";
import { usdFromUsertokens } from "../receipt/format";
import ExhibitAAnnotations, { type Annotation } from "./exhibit-a-annotations";

const facts = factsJson as EvidenceFacts;
const chainSlice = chainSliceJson as ChainSlice;
const receiptLedger = receiptLedgerJson as CapturedReceipt;

const ut = facts.facts.usertokensPerFiveDollars.value;
const chainSeq = chainSeqFor(chainSlice, receiptLedger.receipt.auditHash);

const ANNOTATIONS: Annotation[] = [
	{ field: "transferId", text: "a TigerBeetle transfer — this one" },
	{ field: "cost", text: `usertokens: ${ut.toLocaleString("en-US")} = ${usdFromUsertokens(ut)}` },
	{ field: "auditHash", text: `link ${chainSeq} of the chain` },
	{ field: "settled", text: "two-phase state: held, then settled" },
];

const receiptLines = receiptJsonLines(receiptLedger.receipt);

const prov = receiptLedger.provenance;
// "T"-split keeps the date prefix without a digit-literal slice length (facts gate).
const provenanceLine = `captured v${prov.usertrustVersion} · TigerBeetle ${
	prov.tigerbeetleVersion ?? "—"
} · ${prov.mode} · ${prov.commit} · ${prov.capturedAt.split("T")[0]}`;

export default function ExhibitA() {
	return (
		<section id="exhibit-a" className="relative py-24 sm:py-32 safe-x">
			<div className="mx-auto max-w-6xl">
				<p className="font-mono text-xs uppercase tracking-widest text-white/40">exhibit a</p>
				<h2 className="mt-4 max-w-3xl font-display text-[clamp(2.5rem,6vw,4.5rem)] leading-[0.95] tracking-tight text-white">
					every governed call returns evidence.
				</h2>

				<div className="mt-14 grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
					{/* The call — static mono, emerald keyword accents (dark ground). */}
					<pre
						data-code-sample
						className="self-start overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-6 font-mono text-[13px] leading-7 text-white/80"
					>
						<code>
							<span className="text-ut">import</span> {"{ trust }"}{" "}
							<span className="text-ut">from</span>{" "}
							<span className="text-white/60">"usertrust"</span>;{"\n\n"}
							<span className="text-ut">const</span> client = <span className="text-ut">await</span>{" "}
							trust(
							<span className="text-ut">new</span> Anthropic());{"\n\n"}
							<span className="text-ut">const</span> {"{ response, "}
							<span className="text-ut">receipt</span>
							{" }"} = <span className="text-ut">await</span> client.messages.create({"{"}
							{"\n"}
							{"  model: "}
							<span className="text-white/60">"{receiptLedger.receipt.model}"</span>,{"\n"}
							<span data-code-sample>{"  max_tokens: 1024,"}</span>
							{"\n"}
							{"  messages: [...],"}
							{"\n"}
							{"}"});
						</code>
					</pre>

					{/* The evidence — the SDK's actual return value, annotated. */}
					<ExhibitAAnnotations annotations={ANNOTATIONS}>
						<div className="receipt-terminal overflow-hidden rounded-xl border border-white/10 bg-[#0d0d22] shadow-[0_14px_40px_rgba(0,0,0,0.5)]">
							{/* Title bar */}
							<div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
								<span aria-hidden="true" className="h-2 w-2 rounded-full bg-white/15" />
								<span aria-hidden="true" className="h-2 w-2 rounded-full bg-white/15" />
								<span aria-hidden="true" className="h-2 w-2 rounded-full bg-white/15" />
								<span className="ml-2 font-mono text-[11px] tracking-wide text-white/50">
									receipt · returned from every governed call
								</span>
							</div>
							{/* The receipt JSON — line-keyed spans the island targets. */}
							<pre className="overflow-x-auto px-5 py-4 font-mono text-[12.5px] leading-6">
								<code>
									{receiptLines.map((line) => (
										<span key={line.key} data-line={line.key} className="block rounded-sm px-1">
											{"  ".repeat(line.indent)}
											{line.tokens.map((tok) => (
												<span
													key={tok.key}
													className={tokenClass(
														tok.role,
														line.key === "settled" && receiptLedger.receipt.settled,
													)}
												>
													{tok.text}
												</span>
											))}
										</span>
									))}
								</code>
							</pre>
							{/* Provenance footer — from the fixture's provenance object. */}
							<div className="border-t border-white/10 px-5 py-2.5 font-mono text-[10px] tracking-wide text-white/40">
								{provenanceLine}
							</div>
						</div>
					</ExhibitAAnnotations>
				</div>
			</div>
		</section>
	);
}
