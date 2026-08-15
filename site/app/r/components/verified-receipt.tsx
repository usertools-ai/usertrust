import { receiptCardModel } from "../lib/card-model";
import { receiptClaims } from "../lib/claims";
import type { VerifiedState } from "../lib/wire";
import AdvisoryBands from "./advisory-bands";
import AnchorEvidencePanels from "./anchor-evidence";
import CheckLedger from "./check-ledger";
import DisplayAnnex from "./display-annex";
import ReceiptArtifact from "./receipt-artifact";
import ReceiptCard from "./receipt-card";
import VerdictMasthead from "./verdict-masthead";
import WorkClaims from "./work-claims";

/**
 * The visitor card is first: action → proven → invoice → verify command,
 * matching `docs/specs/receipt-page/`. Advisories stay above it so a
 * superseded receipt says so before the reader starts the audit motion.
 *
 * The §6 verify exhibit (masthead, paper, ledger, annex) stays below. Those
 * surfaces still carry the honesty-critical copy the rendering tests pin
 * (fork disclaimer, check ledger, R13 comparison). Cutting them is a spec
 * amendment, not a silent restyle.
 *
 * The verify command on the card is now licensed: `usertrust-verify receipt`
 * shipped in #106. §11's gate on that command has been met.
 */
export default function VerifiedReceipt({ state }: { state: VerifiedState }) {
	const { envelope } = state;
	const claims = receiptClaims(envelope.receipt);
	const card = receiptCardModel(state, claims);

	return (
		<article
			className="mx-auto flex max-w-[680px] flex-col gap-8 px-4 py-7 sm:px-6"
			data-state="verified"
		>
			<AdvisoryBands advisories={envelope.advisories} />
			<ReceiptCard model={card} />
			<VerdictMasthead rung={state.rung} />
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
