/**
 * Pinned copy for §7's FULL non-receipt state matrix — the states this task
 * (non-receipt states + OG) owns: `pending` (202), `terminalNoReceipt` and
 * `billedUnfinalized` (410), `unknownReceipt` (404), `integrityFailure` (409,
 * both the resolver's own `unverifiable` answer and the page-side R1/R3/R4
 * checks that catch a bad claim before it renders), `invalidId` (local, R2),
 * `verificationUnavailable` (503), `rateLimited` (429), and `protocolError`
 * (local, R37).
 *
 * Every quoted string in this file is a VERBATIM transcription of
 * `docs/specs/2026-08-11-verify-page-design.md` §7 (or, where §7 itself
 * quotes the resolver's own doc, that quote carried through unchanged) — the
 * source of truth is the spec, this file is the pin, and
 * `lib/shell-copy.test.ts` / `states.test.tsx` are what keep them from
 * drifting apart. Strings the spec does NOT put in quotation marks (§7's own
 * descriptive prose, e.g. "reachable only for reservations with zero
 * admitted intents") are NOT pinned as normative quotes here — they inform
 * the explanatory copy but are not asserted verbatim, exactly as §7 says of
 * itself: "quoted strings are normative; surrounding copy is free."
 *
 * `INVALID_ID_HEADLINE` / `PROTOCOL_ERROR_HEADLINE` /
 * `VERIFICATION_UNAVAILABLE_HEADLINE` and `shellHeadline` predate this pass
 * (Task 3's transport-only scope) and are UNCHANGED in value — `transport.
 * test.ts` asserts them directly, and D1/R37's "the two never share copy"
 * rule is a property of these three exact strings.
 */
import { LEDGER_ROWS, RUNG_VERDICT_WORD } from "./claims";
import type { CheckName, IntegrityCause, PageState, RetryAfter, StepName } from "./wire";

// ===========================================================================
// Invalid ID (local, R2) — unchanged from Task 3
// ===========================================================================

/** §7, "Invalid ID (local, R2)". */
export const INVALID_ID_HEADLINE = "not a valid receipt ID";

/**
 * §7: "the §12 rule stated (decodes to exactly 16 bytes, canonical
 * encoding)" — and "distinct from 404: the resolver was never asked."
 */
export const INVALID_ID_RULE_NOTE =
	"a valid receipt ID decodes to exactly 16 bytes and re-encodes to the same canonical base58 string (§12).";

export const INVALID_ID_NEVER_ASKED =
	"distinct from a 404: this ID never reached the resolver at all.";

// ===========================================================================
// Protocol error (local, R37) — unchanged from Task 3
// ===========================================================================

/**
 * §7, "Protocol error (local, R37)". R37/D1: this wording must NEVER be
 * reused for 503, and 503's wording must never be reused here — "the two
 * never share copy" (D1).
 */
export const PROTOCOL_ERROR_HEADLINE = "could not obtain a trustworthy answer from the resolver";

// ===========================================================================
// `verificationUnavailable` (503) — unchanged from Task 3
// ===========================================================================

/** §7, "`verificationUnavailable` (503)". */
export const VERIFICATION_UNAVAILABLE_HEADLINE =
	"verification is temporarily unavailable — an operational condition, not a cryptographic mismatch";

// ===========================================================================
// Pending (202) — R37's neutral register, "both `no-store`"
// ===========================================================================

/** §7: "`reserved` — "**receipt pending…**"". */
export const RESERVED_HEADLINE = "receipt pending…";

/** §7, quoting the resolver's own Errors table verbatim. */
export const RESERVED_NEVER_AN_ERROR =
	"never an error — a fresh commit legitimately sits here for minutes.";

/** §7: "explains reserve → finalize in one line." */
export const RESERVE_FINALIZE_NOTE =
	"a reservation becomes a receipt once the work it represents finalizes — this ID is still in that window.";

/** §7: "`reconciling` — same register: settlement/reconciliation still draining". */
export const RECONCILING_HEADLINE = "reconciling…";

/** §7, verbatim. */
export const RECONCILING_NO_CACHEABLE_TERMINAL =
	"no cacheable terminal until every condition resolves.";

// ===========================================================================
// Terminal without a receipt (410)
// ===========================================================================

/** §7: "`cancelled` / `expired` — "**reservation ended without a receipt**"". */
export const CANCELLED_EXPIRED_HEADLINE = "reservation ended without a receipt";

/** §7, verbatim ("Copy notes the asymmetry"). */
export const RESERVATION_ASYMMETRY_NOTE = "loud on a commit, expected on abandoned work.";

/** §7: "`notMinted` — "**no billable work settled under this receipt ID**"". */
export const NOT_MINTED_HEADLINE = "no billable work settled under this receipt ID";

/** §7, verbatim (resolver's own distinction). */
export const NOT_MINTED_DISTINCT_NOTE = "distinct from both an error and a green check.";

/** §7: "`billedUnfinalized` — ... "the trailer's claim was never proven" (resolver)". */
export const BILLED_UNFINALIZED_HEADLINE = "the trailer's claim was never proven";

/** §7, verbatim. */
export const BILLED_UNFINALIZED_REGISTER_NOTE = "this is a failed promise, not a forgery signal.";

// ===========================================================================
// Loud failures
// ===========================================================================

/** §7: "`unknown` (404) — "This receipt ID was never allocated."". */
export const UNKNOWN_HEADLINE = "This receipt ID was never allocated.";

/** §7, verbatim (resolver's own fail-closed convention). */
export const UNKNOWN_RED_FLAG_NOTE = "an unknown receipt on a commit is an integrity red flag.";

/**
 * §7: "`unverifiable` (409) — integrity failure: "proof recomputation failed
 * against the chain — this should be impossible" (resolver: alerts
 * internally)".
 */
export const UNVERIFIABLE_HEADLINE =
	"proof recomputation failed against the chain — this should be impossible";

export const UNVERIFIABLE_ALERTS_INTERNALLY = "the resolver alerts internally when this happens.";

/**
 * The page-side integrity obligations (R1/R3/R4, and R39's evidence clause)
 * get their OWN honest
 * headline — the resolver never told the page anything failed; the page's
 * own arrival-context / bundle / byte-authority checks caught the problem
 * before anything green (or the billedUnfinalized link) could render. §7:
 * "Also the rendering for R1/R3/R4 identity- and byte-binding failures
 * detected page-side" shares the 409 danger register, but conflating its
 * wording with the resolver's own "should be impossible" line would claim a
 * resolver-side incident that may not exist.
 */
export const PAGE_SIDE_R1_HEADLINE =
	"the receipt this page fetched does not name the ID it was asked about";
export const PAGE_SIDE_R3_HEADLINE = "the billedUnfinalized bundle's own cross-checks do not hold";
export const PAGE_SIDE_R4_HEADLINE =
	"the signed receipt bytes do not agree with the receipt they are supposed to match";
/**
 * R39's evidence clause (§7). The wording deliberately names the CLAIM as the
 * thing that cannot be checked, not the receipt as forged — a receipt reaching
 * this state is well-formed, correctly signed, and honestly labeled; it simply
 * asserts complete delegated-cost coverage, which §2a requires signed evidence
 * to support and specifies no format for. Saying "this receipt is invalid"
 * would overclaim; saying nothing would render the strongest claim in the
 * vocabulary as a plain total.
 */
export const PAGE_SIDE_R39_HEADLINE =
	"this receipt claims to cover all delegated work, and that claim cannot be checked in this version";

/** The headline for an {@link IntegrityCause} — resolver-sourced or page-side. */
export function integrityCauseHeadline(cause: IntegrityCause): string {
	switch (cause.source) {
		case "resolver":
			return UNVERIFIABLE_HEADLINE;
		case "page":
			switch (cause.obligation) {
				case "R1":
					return PAGE_SIDE_R1_HEADLINE;
				case "R3":
					return PAGE_SIDE_R3_HEADLINE;
				case "R4":
					return PAGE_SIDE_R4_HEADLINE;
				case "R39":
					return PAGE_SIDE_R39_HEADLINE;
			}
	}
}

/** §6.3's row label for a failed step/check name, reused so the 409 state names it the same way the ledger does. */
export function stepOrCheckLabel(name: StepName | CheckName): string {
	return LEDGER_ROWS.find((row) => row.name === name)?.label ?? name;
}

// ===========================================================================
// Rate limited (429) — "plain rate-limit notice" (§7); not itself quoted
// ===========================================================================

export const RATE_LIMITED_HEADLINE = "rate limited — try again shortly";

// ===========================================================================
// Retry-After — shared by 503, 429, and the protocol-error shell ("retry
// affordance" per §7)
// ===========================================================================

export function retryAfterLine(retryAfter: RetryAfter | undefined): string | null {
	if (!retryAfter) return null;
	return retryAfter.seconds !== undefined
		? `the resolver asked for a retry in ${retryAfter.seconds}s.`
		: `the resolver asked for a retry after ${retryAfter.raw}.`;
}

// ===========================================================================
// The headline this task renders for a given {@link PageState}.
// ===========================================================================

/**
 * Only the pinned constants above (asserted verbatim in `shell-copy.test.ts`
 * / `transport.test.ts`) are spec-mandated; every branch here dispatches to
 * one of them by NAME rather than re-deriving the string, so there is only
 * ever one place a given state's headline is spelled.
 */
export function shellHeadline(state: PageState): string {
	switch (state.kind) {
		case "invalidId":
			return INVALID_ID_HEADLINE;
		case "protocolError":
			return PROTOCOL_ERROR_HEADLINE;
		case "verificationUnavailable":
			return VERIFICATION_UNAVAILABLE_HEADLINE;
		// The §6 anatomy renders the verified rungs (`components/verified-receipt`),
		// so this branch is only a fallback for a caller that wants a headline
		// string. It DELEGATES to `claims.ts` rather than rebuilding the word from
		// the status enum: two independent ways of spelling the verdict is exactly
		// the drift the §8 copy pins exist to prevent.
		case "verified":
			return RUNG_VERDICT_WORD[state.rung];
		case "pending":
			return state.status === "reserved" ? RESERVED_HEADLINE : RECONCILING_HEADLINE;
		case "terminalNoReceipt":
			return state.status === "notMinted" ? NOT_MINTED_HEADLINE : CANCELLED_EXPIRED_HEADLINE;
		case "billedUnfinalized":
			return BILLED_UNFINALIZED_HEADLINE;
		case "unknownReceipt":
			return UNKNOWN_HEADLINE;
		case "integrityFailure":
			return integrityCauseHeadline(state.cause);
		case "rateLimited":
			return RATE_LIMITED_HEADLINE;
	}
}

// ===========================================================================
// The OG/share card (§12 open question 1, default (b): "verdict-only card,
// amount on the page" — NO dollar amount, ever, on the card).
// ===========================================================================

/**
 * The share card's one line of text — deliberately `shellHeadline` itself,
 * not a second, shorter re-spelling. Open question 1's default is
 * "verdict-only": no kind, no `$` amount, no work claim, just the same word
 * (or §7 headline) the page itself renders as the verdict — one string, one
 * source, so the card can never say something the page underneath does not.
 */
export function ogCardWord(state: PageState): string {
	return shellHeadline(state);
}

/** The card's register, mirroring the page's own (never green for a non-`verified` state). */
export function ogCardRegister(state: PageState): "green" | "neutral" | "warning" | "danger" {
	switch (state.kind) {
		case "verified":
			return "green";
		case "verificationUnavailable":
			return "warning";
		case "billedUnfinalized":
		case "unknownReceipt":
		case "integrityFailure":
		case "protocolError":
			return "danger";
		default:
			return "neutral";
	}
}
