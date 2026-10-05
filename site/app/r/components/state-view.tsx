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
			if (state.scope === "session") return <VerifiedReceipt state={state} />;
			// A cluster receipt (receipt-spec v0.10 §15) now PARSES, but there is no
			// cluster card yet, and the session card would print claims the receipt
			// never made (a governed session, an association posture). Until the
			// cluster renderer lands it fails closed into the protocol-error shell —
			// where the page put every cluster receipt before it could parse one —
			// never green, and never a thrown render.
			return (
				<ProtocolErrorStateView
					state={{
						kind: "protocolError",
						routeParamId: state.routeParamId,
						reason: "schemaInvalid",
						detail: "this page cannot render a cluster receipt (receipt-spec v0.10 §15) yet",
						httpStatus: 200,
					}}
				/>
			);
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
