import { receiptCardModel } from "../lib/card-model";
import { receiptClaims } from "../lib/claims";
import type { VerifiedState } from "../lib/wire";
import AdvisoryBands from "./advisory-bands";
import AnchorEvidencePanels from "./anchor-evidence";
import CheckLedger from "./check-ledger";
import Details from "./details";
import DisplayAnnex from "./display-annex";
import ReceiptCard, { ReceiptDetails } from "./receipt-card";
import WorkClaims from "./work-claims";

/**
 * The visitor card IS the receipt. Advisories stay above it so a superseded
 * receipt says so before the audit motion starts. Ledger, extension evidence,
 * work-claims and the display annex stay below as the check-it-yourself
 * surfaces — they are not a second receipt.
 *
 * The §6 masthead and thermal-paper artifact are gone from this page. Their
 * honesty-critical copy (R5–R8, R18, R20–R27, R38–R41) moved onto the card.
 */
export default function VerifiedReceipt({ state }: { state: VerifiedState }) {
	const { envelope } = state;
	const claims = receiptClaims(envelope.receipt);
	const card = receiptCardModel(state, claims);

	return (
		<article className="flex flex-col gap-8 py-7" data-state="verified">
			<AdvisoryBands advisories={envelope.advisories} />
			<ReceiptCard model={card} claims={claims} receipt={envelope.receipt} rung={state.rung} />
			<Details>
				<div className="flex flex-col gap-8">
					<ReceiptDetails
						model={card}
						claims={claims}
						receipt={envelope.receipt}
						rung={state.rung}
					/>
					<CheckLedger
						verification={envelope.verification}
						membershipNote={claims.membershipNote}
					/>
					<AnchorEvidencePanels
						anchorEvidence={envelope.anchorEvidence}
						checkpointHistory={envelope.checkpointHistory}
						checks={envelope.verification.checks}
						rung={state.rung}
					/>
					<WorkClaims claims={claims} />
					<DisplayAnnex display={envelope.display} />
				</div>
			</Details>
		</article>
	);
}
