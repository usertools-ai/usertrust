/**
 * The copy pin for §7's non-receipt state matrix (the states pass, Task 5).
 * Every `assert.equal` against a string literal here is a VERBATIM
 * transcription of `docs/specs/2026-08-11-verify-page-design.md` §7 — a
 * redesign that silently rewords one of these fails this file, not a
 * reviewer's memory of the spec.
 *
 * `transport.test.ts` already pins the three Task-3 constants
 * (`INVALID_ID_HEADLINE`/`PROTOCOL_ERROR_HEADLINE`/
 * `VERIFICATION_UNAVAILABLE_HEADLINE`) and their D1 "never share copy"
 * property; this file does not repeat those, only the ones this task adds.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	BILLED_UNFINALIZED_HEADLINE,
	BILLED_UNFINALIZED_REGISTER_NOTE,
	CANCELLED_EXPIRED_HEADLINE,
	integrityCauseHeadline,
	NOT_MINTED_DISTINCT_NOTE,
	NOT_MINTED_HEADLINE,
	ogCardRegister,
	ogCardWord,
	PAGE_SIDE_R1_HEADLINE,
	PAGE_SIDE_R3_HEADLINE,
	PAGE_SIDE_R4_HEADLINE,
	RATE_LIMITED_HEADLINE,
	RECONCILING_HEADLINE,
	RECONCILING_NO_CACHEABLE_TERMINAL,
	RESERVATION_ASYMMETRY_NOTE,
	RESERVED_HEADLINE,
	RESERVED_NEVER_AN_ERROR,
	retryAfterLine,
	shellHeadline,
	stepOrCheckLabel,
	UNKNOWN_HEADLINE,
	UNKNOWN_RED_FLAG_NOTE,
	UNVERIFIABLE_HEADLINE,
} from "./shell-copy";
import type { IntegrityCause, PageState } from "./wire";

// ===========================================================================
// §7 verbatim pins
// ===========================================================================

test("§7 pending: reserved/reconciling headlines and their quoted resolver lines, verbatim", () => {
	assert.equal(RESERVED_HEADLINE, "receipt pending…");
	assert.equal(
		RESERVED_NEVER_AN_ERROR,
		"never an error — a fresh commit legitimately sits here for minutes.",
	);
	assert.equal(RECONCILING_HEADLINE, "reconciling…");
	assert.equal(
		RECONCILING_NO_CACHEABLE_TERMINAL,
		"no cacheable terminal until every condition resolves.",
	);
});

test("§7 terminal-without-a-receipt headlines and asymmetry notes, verbatim", () => {
	assert.equal(CANCELLED_EXPIRED_HEADLINE, "reservation ended without a receipt");
	assert.equal(RESERVATION_ASYMMETRY_NOTE, "loud on a commit, expected on abandoned work.");
	assert.equal(NOT_MINTED_HEADLINE, "no billable work settled under this receipt ID");
	assert.equal(NOT_MINTED_DISTINCT_NOTE, "distinct from both an error and a green check.");
	assert.equal(BILLED_UNFINALIZED_HEADLINE, "the trailer's claim was never proven");
	assert.equal(BILLED_UNFINALIZED_REGISTER_NOTE, "this is a failed promise, not a forgery signal.");
});

test("§7 loud failures: unknown/unverifiable headlines, verbatim", () => {
	assert.equal(UNKNOWN_HEADLINE, "This receipt ID was never allocated.");
	assert.equal(UNKNOWN_RED_FLAG_NOTE, "an unknown receipt on a commit is an integrity red flag.");
	assert.equal(
		UNVERIFIABLE_HEADLINE,
		"proof recomputation failed against the chain — this should be impossible",
	);
});

test("R36/D1: unverifiable (409) and verificationUnavailable (503) never share copy", async () => {
	const { VERIFICATION_UNAVAILABLE_HEADLINE } = await import("./shell-copy");
	assert.notEqual(UNVERIFIABLE_HEADLINE, VERIFICATION_UNAVAILABLE_HEADLINE);
});

// ===========================================================================
// integrityCauseHeadline — resolver vs. the three page-side obligations
// ===========================================================================

test("integrityCauseHeadline: resolver-sourced always renders the §7 409 headline", () => {
	const cause: IntegrityCause = {
		source: "resolver",
		verification: {
			trustSnapshotId: "x",
			steps: {} as never,
			checks: {} as never,
		},
		failed: [],
	};
	assert.equal(integrityCauseHeadline(cause), UNVERIFIABLE_HEADLINE);
});

test("integrityCauseHeadline: each page-side obligation gets its OWN honest headline, never the resolver's", () => {
	const r1: IntegrityCause = { source: "page", obligation: "R1", detail: "d" };
	const r3: IntegrityCause = {
		source: "page",
		obligation: "R3",
		brokenEquality: "linkedReceiptId",
		detail: "d",
	};
	const r4: IntegrityCause = { source: "page", obligation: "R4", stage: "comparison", detail: "d" };

	assert.equal(integrityCauseHeadline(r1), PAGE_SIDE_R1_HEADLINE);
	assert.equal(integrityCauseHeadline(r3), PAGE_SIDE_R3_HEADLINE);
	assert.equal(integrityCauseHeadline(r4), PAGE_SIDE_R4_HEADLINE);

	const headlines = new Set([
		integrityCauseHeadline(r1),
		integrityCauseHeadline(r3),
		integrityCauseHeadline(r4),
		UNVERIFIABLE_HEADLINE,
	]);
	assert.equal(headlines.size, 4, "all four integrity headlines are textually distinct");
});

// ===========================================================================
// stepOrCheckLabel — reuses the SAME label the check ledger renders
// ===========================================================================

test("stepOrCheckLabel: matches the check ledger's own row label", () => {
	assert.equal(stepOrCheckLabel("signature"), "SIGNATURE");
	assert.equal(stepOrCheckLabel("anchorEvidence"), "ANCHOR EVIDENCE");
});

// ===========================================================================
// retryAfterLine
// ===========================================================================

test("retryAfterLine: seconds form, raw-only form, and absent", () => {
	assert.equal(
		retryAfterLine({ raw: "30", seconds: 30 }),
		"the resolver asked for a retry in 30s.",
	);
	assert.equal(
		retryAfterLine({ raw: "Wed, 21 Oct 2026 07:28:00 GMT" }),
		"the resolver asked for a retry after Wed, 21 Oct 2026 07:28:00 GMT.",
	);
	assert.equal(retryAfterLine(undefined), null);
});

// ===========================================================================
// shellHeadline — every non-verified PageState kind
// ===========================================================================

test("shellHeadline dispatches every non-verified kind to its pinned constant", () => {
	assert.equal(
		shellHeadline({ kind: "pending", routeParamId: "x", receiptId: "x", status: "reserved" }),
		RESERVED_HEADLINE,
	);
	assert.equal(
		shellHeadline({ kind: "pending", routeParamId: "x", receiptId: "x", status: "reconciling" }),
		RECONCILING_HEADLINE,
	);
	assert.equal(
		shellHeadline({
			kind: "terminalNoReceipt",
			routeParamId: "x",
			receiptId: "x",
			status: "cancelled",
		}),
		CANCELLED_EXPIRED_HEADLINE,
	);
	assert.equal(
		shellHeadline({
			kind: "terminalNoReceipt",
			routeParamId: "x",
			receiptId: "x",
			status: "notMinted",
		}),
		NOT_MINTED_HEADLINE,
	);
	assert.equal(
		shellHeadline({ kind: "unknownReceipt", routeParamId: "x", receiptId: "x" }),
		UNKNOWN_HEADLINE,
	);
	assert.equal(
		shellHeadline({ kind: "rateLimited", routeParamId: "x" } as PageState),
		RATE_LIMITED_HEADLINE,
	);
});

// ===========================================================================
// The OG card (§12 open question 1, default (b)): verdict-only, one string,
// same source as the page's own headline — never a dollar amount.
// ===========================================================================

test("ogCardWord IS shellHeadline — one source, never a second re-spelling", () => {
	const state: PageState = { kind: "unknownReceipt", routeParamId: "x", receiptId: "x" };
	assert.equal(ogCardWord(state), shellHeadline(state));
});

test("ogCardWord for a verified receipt is the artifact type, not a rung word", () => {
	const state = {
		kind: "verified",
		rung: "verified_anchored",
	} as unknown as PageState;
	assert.equal(ogCardWord(state), "Receipt");
	assert.equal(ogCardWord(state), shellHeadline(state));
});

test("ogCardWord never contains a dollar figure — no fixture-derived amount ever reaches it", () => {
	const states: PageState[] = [
		{ kind: "pending", routeParamId: "x", receiptId: "x", status: "reserved" },
		{ kind: "unknownReceipt", routeParamId: "x", receiptId: "x" },
		{ kind: "rateLimited", routeParamId: "x" },
	];
	for (const state of states) {
		assert.doesNotMatch(ogCardWord(state), /\$/, JSON.stringify(state));
	}
});

test("ogCardRegister: green ONLY for verified; every other kind is neutral/warning/danger", () => {
	const verified = { kind: "verified", rung: "verified_checkpoint" } as unknown as PageState;
	assert.equal(ogCardRegister(verified), "green");

	const nonGreenKinds: { kind: PageState["kind"]; expect: "neutral" | "warning" | "danger" }[] = [
		{ kind: "pending", expect: "neutral" },
		{ kind: "terminalNoReceipt", expect: "neutral" },
		{ kind: "invalidId", expect: "neutral" },
		{ kind: "rateLimited", expect: "neutral" },
		{ kind: "verificationUnavailable", expect: "warning" },
		{ kind: "billedUnfinalized", expect: "danger" },
		{ kind: "unknownReceipt", expect: "danger" },
		{ kind: "integrityFailure", expect: "danger" },
		{ kind: "protocolError", expect: "danger" },
	];
	for (const { kind, expect } of nonGreenKinds) {
		const register = ogCardRegister({ kind } as unknown as PageState);
		assert.notEqual(register, "green", kind);
		assert.equal(register, expect, kind);
	}
});
