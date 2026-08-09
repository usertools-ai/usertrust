import chainSliceJson from "@/evidence/chain-slice.json";
import factsJson from "@/evidence/facts.json";
import receiptLedgerJson from "@/evidence/receipt-ledger.json";
import type { ChainSlice, EvidenceFacts, LedgerCaptures } from "@/evidence/types";
import { chainSeqFor, receiptJsonLines } from "../../lib/receipt-json";
import { usdFromUsertokens } from "../receipt/format";
import StageTag from "../stage-tag";
import ExhibitAReceipts, { type ReceiptPanel } from "./exhibit-a-receipts";
import { LAB_VIEWBOX, labFor } from "./lib/receipt-labs";

const facts = factsJson as EvidenceFacts;
const chainSlice = chainSliceJson as ChainSlice;
const ledger = receiptLedgerJson as LedgerCaptures;

const ut = facts.facts.usertokensPerFiveDollars.value;
const prov = ledger.provenance;
// "T"-split keeps the date prefix without a digit-literal slice length (facts gate).
const provenanceLine = `captured v${prov.usertrustVersion} · TigerBeetle ${
	prov.tigerbeetleVersion ?? "—"
} · ${prov.mode} · ${prov.commit} · ${prov.capturedAt.split("T")[0]}`;

/**
 * One panel per captured model — built on the SERVER from the fixture, so the
 * client island ships data, not a fixture parser.
 *
 * Every annotation is derived, never authored at a value:
 *  - the estimate comes from `capture.estimatedCost`, the wrapper sidecar, and
 *    is described as what it is (a pre-call input to the hold) rather than
 *    smuggled into the receipt as a `cost.estimated` field;
 *  - "link N" comes from matching this receipt's auditHash against the
 *    published slice, and renders as ABSENCE when there is no match — the
 *    capture asserts there always is, and a plausible fallback number is
 *    exactly the defect that made the old annotation dishonest;
 *  - budgetRemaining is worded as an observation, per the honesty constraint in
 *    Addendum D. It is a reading taken after this call settled, not a promise
 *    about the next one.
 */
const PANELS: ReceiptPanel[] = ledger.captures.map(({ receipt, capture }) => {
	const seq = chainSeqFor(chainSlice, receipt.auditHash);
	const lab = labFor(receipt.model);
	return {
		id: receipt.model,
		label: lab.label,
		lab: lab.lab,
		mark: lab.mark,
		markViewBox: LAB_VIEWBOX,
		model: receipt.model,
		// The sample matches the client this receipt was actually captured
		// through. Kimi rides the OpenAI-compatible surface, which is exactly
		// why its receipt below reads provider: "openai".
		ctor: capture.clientShape === "anthropic" ? "Anthropic" : "OpenAI",
		surface:
			capture.clientShape === "anthropic"
				? "client.messages.create"
				: "client.chat.completions.create",
		settled: receipt.settled,
		lines: receiptJsonLines(receipt),
		annotations: [
			{ field: "transferId", text: "a TigerBeetle transfer — this one" },
			{
				field: "cost",
				text: `what it settled at · estimated ${capture.estimatedCost} before the call`,
			},
			{
				field: "budgetRemaining",
				text: "read after this call settled — an observation, not a promise",
			},
			{
				field: "auditHash",
				text: seq === null ? "not in the published slice" : `link ${seq} of the chain`,
			},
			{
				field: "pricing",
				text: "the rates this cost was metered with — recompute it yourself",
			},
		],
	};
});

export default function ExhibitA() {
	return (
		<section
			id="exhibit-a"
			data-theme="steel"
			className="section-anchor relative py-24 sm:py-32 safe-x"
		>
			<div className="mx-auto max-w-6xl">
				<p className="section-eyebrow">exhibit a</p>
				<div className="mt-3 flex items-center gap-1.5">
					<StageTag stage="RECORD" />
				</div>
				<h2 className="mt-4 max-w-3xl font-display text-[clamp(2.5rem,6vw,4.5rem)] leading-[0.95] tracking-tight text-white">
					every governed call returns evidence.
				</h2>
				<p className="mt-6 max-w-2xl text-base leading-relaxed text-white/70">
					three frontier models, three real receipts, one ledger. every field below is the object
					the SDK handed back — {facts.facts.usertokensPerFiveDollars.value.toLocaleString("en-US")}{" "}
					usertokens = {usdFromUsertokens(ut)}.
				</p>

				<ExhibitAReceipts panels={PANELS} provenanceLine={provenanceLine} />
			</div>
		</section>
	);
}
