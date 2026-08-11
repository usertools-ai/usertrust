import ReceiptPaper from "../../components/receipt/receipt-paper";
import Stamp from "../../components/stamp";
import HashValue from "./hash-value";

/**
 * §6.2: "Terminal non-green states stamp the paper (`Stamp`, extended
 * beyond `BLOCKED | VOID` as needed — e.g. `VOID` for cancelled/expired,
 * `UNPROVEN` for `billedUnfinalized`)." — the empty stub shared by every 410
 * state: there is no receipt to print, so the paper prints only the ID it
 * was asked about and the status word, with the stamp (if any) as the one
 * graphic that carries the verdict at a glance.
 *
 * On-paper accents use the paper-ink variants only (§6.2) — the stamp's
 * color is passed in per caller rather than defaulting to the dark-ground
 * `--color-danger`.
 */
export default function TerminalPaperStub({
	receiptId,
	statusWord,
	stamp,
}: {
	receiptId: string;
	statusWord: string;
	stamp?: { word: "VOID" | "UNPROVEN"; colorClassName: string };
}) {
	return (
		<div className="relative">
			{stamp ? (
				<Stamp
					word={stamp.word}
					colorClassName={stamp.colorClassName}
					className="absolute -top-3 -right-2 z-10"
				/>
			) : null}
			<ReceiptPaper provenance="unstamped ticket stub">
				<div className="flex flex-col gap-3">
					<span className="font-mono text-[12px] uppercase tracking-[0.12em] text-ink/70">
						receipt id
					</span>
					<HashValue value={receiptId} label="receipt ID" tone="paper" />
					<span className="font-display text-xl uppercase tracking-[0.06em] text-ink">
						{statusWord}
					</span>
				</div>
			</ReceiptPaper>
		</div>
	);
}
