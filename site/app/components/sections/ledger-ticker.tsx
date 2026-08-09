import chainSliceJson from "@/evidence/chain-slice.json";
import receiptLedgerJson from "@/evidence/receipt-ledger.json";
import type { ChainSlice, LedgerCaptures } from "@/evidence/types";
import LedgerTickerStrip from "./ledger-ticker-strip";
import { tickerFragments } from "./lib/ledger-ticker";

const slice = chainSliceJson as ChainSlice;
const ledger = receiptLedgerJson as LedgerCaptures;

/**
 * THE LEDGER TICKER (Addendum O) — a perforated receipt strip running the
 * published chain between the harden doctrine and the closing panel.
 *
 * SERVER component. It reads both fixtures, joins them on auditHash, and
 * hands the finished fragments to the client island, which owns nothing but
 * the IntersectionObserver that pauses the marquee off screen. Neither
 * fixture reaches the browser as a fixture.
 *
 * Every token on the strip is evidence: the event kind is the chain entry's
 * own type, the hash is the head of its real chain hash, and the reference is
 * the real TigerBeetle transfer id of the receipt that wrote that entry where
 * one was captured, or the entry's chain link index where none was. See
 * lib/ledger-ticker.ts for why the second case exists and why nothing is
 * invented to fill it.
 *
 * Not a `section[id]`: the nav's active-section observer walks `section[id]`
 * and the anchor system is calibrated per anchored section, and this strip is
 * neither a destination nor an exhibit. It is the page taking a breath with
 * the ledger still running underneath.
 */
export default function LedgerTicker() {
	const fragments = tickerFragments(
		slice.entries,
		ledger.captures.map((c) => ({
			transferId: c.receipt.transferId,
			auditHash: c.receipt.auditHash,
		})),
	);
	return (
		<div className="relative">
			{/* One line for assistive tech instead of the marquee's two passes of
			    hash prefixes. The chain itself is presented properly in exhibit D,
			    which is where a reader who wants the entries should be sent. */}
			<p className="sr-only">
				a scrolling strip of entries from the published audit chain — the same entries exhibit d
				lists in full.
			</p>
			<LedgerTickerStrip fragments={fragments} />
		</div>
	);
}
