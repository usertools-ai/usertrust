import { receiptClaims } from "../lib/claims";
import type { VerifiedState } from "../lib/wire";
import AdvisoryBands from "./advisory-bands";
import AnchorEvidencePanels from "./anchor-evidence";
import CheckLedger from "./check-ledger";
import DisplayAnnex from "./display-annex";
import ReceiptArtifact from "./receipt-artifact";
import VerdictMasthead from "./verdict-masthead";
import WorkClaims from "./work-claims";

/**
 * §6 — the verified page, assembled in the anatomy's own order.
 *
 * §6 fixes the ORDER as well as the parts, and the order is an argument:
 *
 *   1. verdict masthead — the rung, the ladder above it, and the fine print;
 *   2. advisory band(s) — "rendered between masthead and artifact" (§6.4), so
 *      a superseded or revision-moved receipt says so BEFORE the reader starts
 *      reading the claims underneath;
 *   3. the receipt artifact — the chain-committed claim set, on paper;
 *   4. the check ledger — the verdict function's inputs;
 *   5. the extension evidence — history and anchor, per format (R32);
 *   6. verify-against-your-artifact — the comparison the page cannot make;
 *   7. the display annex — unsigned material, subordinate and labeled.
 *
 * The display annex is LAST for the same reason it is dashed and muted: §9 puts
 * "everything unsigned below, in the display annex's voice". Moving it up would
 * put unsigned rows between two chain-committed sections, and the reader's rule
 * about what the paper means would stop being true.
 *
 * §6.6's verify-it-yourself panel and §6.7's trailer strip are deliberately NOT
 * here: §11 gates the verify panel's copy on `usertrust-verify receipt <file>`
 * being released, and both surfaces belong to the states pass that follows this
 * one. Their absence is scoped, not forgotten.
 */
export default function VerifiedReceipt({ state }: { state: VerifiedState }) {
	const { envelope } = state;
	const claims = receiptClaims(envelope.receipt);

	return (
		<article
			className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-12 sm:px-6"
			data-state="verified"
		>
			<VerdictMasthead rung={state.rung} />
			<AdvisoryBands advisories={envelope.advisories} />
			<ReceiptArtifact receipt={envelope.receipt} claims={claims} />
			<CheckLedger verification={envelope.verification} membershipNote={claims.membershipNote} />
			<AnchorEvidencePanels
				anchorEvidence={envelope.anchorEvidence}
				checkpointHistory={envelope.checkpointHistory}
				checks={envelope.verification.checks}
				rung={state.rung}
			/>
			<WorkClaims claims={claims} />
			<DisplayAnnex display={envelope.display} />
		</article>
	);
}
