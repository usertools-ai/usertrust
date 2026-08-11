import type { PageState } from "../lib/wire";
import BilledUnfinalizedStateView from "./billed-unfinalized-state";
import IntegrityFailureStateView from "./integrity-failure-state";
import InvalidIdStateView from "./invalid-id-state";
import PendingStateView from "./pending-state";
import ProtocolErrorStateView from "./protocol-error-state";
import RateLimitedStateView from "./rate-limited-state";
import TerminalNoReceiptStateView from "./terminal-no-receipt-state";
import UnknownReceiptStateView from "./unknown-receipt-state";
import VerificationUnavailableStateView from "./verification-unavailable-state";
import VerifiedReceipt from "./verified-receipt";

/**
 * §7's full state matrix, dispatched by `PageState.kind` — the ONE place
 * `/r/<receiptId>` decides which of the ten renderers a resolved state gets.
 * `verified` renders through Task 4's `§6` anatomy (`VerifiedReceipt`); every
 * other kind renders through this task's own component, matching §7's
 * per-state copy and register. The switch is exhaustive over `PageState["kind"]`
 * — a new kind added to `wire.ts` without a case here fails the BUILD
 * (`never` narrowing), not a silent blank render.
 */
export default function StateView({ state }: { state: PageState }) {
	switch (state.kind) {
		case "verified":
			return <VerifiedReceipt state={state} />;
		case "pending":
			return <PendingStateView state={state} />;
		case "terminalNoReceipt":
			return <TerminalNoReceiptStateView state={state} />;
		case "billedUnfinalized":
			return <BilledUnfinalizedStateView state={state} />;
		case "unknownReceipt":
			return <UnknownReceiptStateView state={state} />;
		case "integrityFailure":
			return <IntegrityFailureStateView state={state} />;
		case "invalidId":
			return <InvalidIdStateView state={state} />;
		case "verificationUnavailable":
			return <VerificationUnavailableStateView state={state} />;
		case "rateLimited":
			return <RateLimitedStateView state={state} />;
		case "protocolError":
			return <ProtocolErrorStateView state={state} />;
		default: {
			const exhaustive: never = state;
			throw new Error(`unhandled PageState kind: ${JSON.stringify(exhaustive)}`);
		}
	}
}
