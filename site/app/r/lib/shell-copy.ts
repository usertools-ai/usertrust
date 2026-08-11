/**
 * Pinned copy for the transport-layer states this task (route + transport)
 * is responsible for rendering honestly. Every string here is a VERBATIM
 * transcription of `docs/specs/2026-08-11-verify-page-design.md` §7 — the
 * source of truth is the spec, this file is the pin, and `transport.test.ts`
 * is the test that keeps them from drifting apart.
 *
 * Scope note: this module does NOT attempt the full §7 state matrix (the
 * verified rungs are Task 4's; the remaining non-receipt states — 202/410/
 * 404/409/429 — are Task 5's, which owns "All §7 states with their mandated
 * loudness"). It pins only what THIS task's brief names explicitly: the
 * invalid-ID local state (D4) and the protocol-error shell kept textually
 * distinct from 503's own wording (D1/R37). `shellHeadline` still returns
 * SOMETHING for every remaining `PageState` kind, so `page.tsx` always
 * renders — that fallback text is an interim placeholder, not spec-pinned,
 * and is expected to be replaced wholesale when Task 5 lands.
 */
import type { PageState } from "./wire";

/** §7, "Invalid ID (local, R2)". */
export const INVALID_ID_HEADLINE = "not a valid receipt ID";

/**
 * §7, "Protocol error (local, R37)". R37/D1: this wording must NEVER be
 * reused for 503, and 503's wording must never be reused here — "the two
 * never share copy" (D1).
 */
export const PROTOCOL_ERROR_HEADLINE = "could not obtain a trustworthy answer from the resolver";

/** §7, "`verificationUnavailable` (503)". */
export const VERIFICATION_UNAVAILABLE_HEADLINE =
	"verification is temporarily unavailable — an operational condition, not a cryptographic mismatch";

/**
 * The headline this task renders for a given {@link PageState}. Only the
 * three constants above are spec-pinned (asserted verbatim in
 * `transport.test.ts`); every other branch is an interim label for a state
 * this task must not leave unrendered but does not own the final copy for.
 */
export function shellHeadline(state: PageState): string {
	switch (state.kind) {
		case "invalidId":
			return INVALID_ID_HEADLINE;
		case "protocolError":
			return PROTOCOL_ERROR_HEADLINE;
		case "verificationUnavailable":
			return VERIFICATION_UNAVAILABLE_HEADLINE;
		case "verified":
			return `VERIFIED — ${state.rung.replace("verified_", "").replace("_", " ").toUpperCase()}`;
		case "pending":
			return state.status === "reserved" ? "receipt pending…" : "reconciling…";
		case "terminalNoReceipt":
			return state.status === "notMinted"
				? "no billable work settled under this receipt ID"
				: "reservation ended without a receipt";
		case "billedUnfinalized":
			return "the trailer's claim was never proven";
		case "unknownReceipt":
			return "This receipt ID was never allocated.";
		case "integrityFailure":
			return "proof recomputation failed against the chain — this should be impossible";
		case "rateLimited":
			return "rate limited — try again shortly";
	}
}
