/**
 * §7's non-receipt state matrix (Task 5): every kind except `verified`
 * (Task 4's `rendering.test.tsx`/`components.test.tsx` own that one),
 * driven through the REAL parser via `fixture-harness.ts`, asserting the
 * pinned §7 copy actually reaches the DOM, the mandated loudness (404/409
 * full danger, 503 warning, `billedUnfinalized` danger-without-409's-panel,
 * everything else neutral), the 410 `billedUnfinalized` four-way-checked
 * link, and the check-ledger's keyboard/aria additions this task adds.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import BilledUnfinalizedStateView from "./components/billed-unfinalized-state";
import IntegrityFailureStateView from "./components/integrity-failure-state";
import InvalidIdStateView from "./components/invalid-id-state";
import PendingStateView from "./components/pending-state";
import ProtocolErrorStateView from "./components/protocol-error-state";
import RateLimitedStateView from "./components/rate-limited-state";
import StateView from "./components/state-view";
import TerminalNoReceiptStateView from "./components/terminal-no-receipt-state";
import UnknownReceiptStateView from "./components/unknown-receipt-state";
import VerificationUnavailableStateView from "./components/verification-unavailable-state";
import { FIXTURE_DIR, fixtureState, loadFixture } from "./fixture-harness";
import { protocolVectors } from "./fixtures/protocol-vectors";
import type { BilledUnfinalizedMutantCase } from "./fixtures/types";
import {
	BILLED_UNFINALIZED_HEADLINE,
	CANCELLED_EXPIRED_HEADLINE,
	NOT_MINTED_HEADLINE,
	PROTOCOL_ERROR_HEADLINE,
	RATE_LIMITED_HEADLINE,
	UNKNOWN_HEADLINE,
	UNVERIFIABLE_HEADLINE,
	VERIFICATION_UNAVAILABLE_HEADLINE,
} from "./lib/shell-copy";
import {
	type IntegrityFailureState,
	type PageState,
	parseResolverResponse,
	validateReceiptId,
	verifyBilledUnfinalizedLinkage,
} from "./lib/wire";

function html(node: React.ReactElement): string {
	return renderToStaticMarkup(node);
}

function textOf(markup: string): string {
	return markup
		.replace(/<[^>]*>/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ");
}

function loadTyped<T>(relPath: string): T {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, relPath), "utf-8")) as T;
}

// ===========================================================================
// Pending (202)
// ===========================================================================

test("reserved.json: neutral register, the pinned headline, and the reserve→finalize note", () => {
	const state = fixtureState(loadFixture("reserved.json"));
	assert.equal(state.kind, "pending");
	if (state.kind !== "pending") return;
	const text = textOf(html(<PendingStateView state={state} />));
	assert.match(text, /receipt pending/);
	assert.match(text, /never an error/);
	assert.match(text, /reserve|finaliz/i);
});

test("reconciling.json: the pinned headline and the no-cacheable-terminal note", () => {
	const state = fixtureState(loadFixture("reconciling.json"));
	assert.equal(state.kind, "pending");
	if (state.kind !== "pending") return;
	const text = textOf(html(<PendingStateView state={state} />));
	assert.match(text, /reconciling/);
	assert.match(text, /no cacheable terminal until every condition resolves/);
});

// ===========================================================================
// Terminal without a receipt (410)
// ===========================================================================

test("cancelled.json / expired.json: the pinned headline, the asymmetry note, and a VOID stamp", () => {
	for (const file of ["cancelled.json", "expired.json"]) {
		const state = fixtureState(loadFixture(file));
		assert.equal(state.kind, "terminalNoReceipt", file);
		if (state.kind !== "terminalNoReceipt") continue;
		const markup = html(<TerminalNoReceiptStateView state={state} />);
		const text = textOf(markup);
		assert.equal(CANCELLED_EXPIRED_HEADLINE, "reservation ended without a receipt");
		assert.match(text, /reservation ended without a receipt/, file);
		assert.match(text, /loud on a commit, expected on abandoned work/, file);
		assert.match(markup, />VOID</, `${file}: VOID stamp renders`);
	}
});

test("not-minted.json: the pinned headline, the distinct-not-danger note, and NO stamp", () => {
	const state = fixtureState(loadFixture("not-minted.json"));
	assert.equal(state.kind, "terminalNoReceipt");
	if (state.kind !== "terminalNoReceipt") return;
	const markup = html(<TerminalNoReceiptStateView state={state} />);
	const text = textOf(markup);
	assert.equal(NOT_MINTED_HEADLINE, "no billable work settled under this receipt ID");
	assert.match(text, /no billable work settled under this receipt ID/);
	assert.match(text, /distinct from both an error and a green check/);
	assert.doesNotMatch(markup, />VOID</);
	assert.doesNotMatch(markup, />UNPROVEN</);
});

// ===========================================================================
// billedUnfinalized (410) — R3's four-way-checked link
// ===========================================================================

test("C21<->C18: the happy path renders the UNPROVEN stamp, the proof summary, and the verified link", () => {
	const bundleState = fixtureState(loadFixture("billed-unfinalized.json"));
	assert.equal(bundleState.kind, "billedUnfinalized");
	if (bundleState.kind !== "billedUnfinalized") return;
	const linkedState = fixtureState(loadFixture("session-fallback.json"));
	const checked = verifyBilledUnfinalizedLinkage(bundleState, linkedState);
	assert.equal(checked.kind, "billedUnfinalized");
	if (checked.kind !== "billedUnfinalized") return;
	assert.equal(checked.linkage, "verified");

	const markup = html(<BilledUnfinalizedStateView state={checked} />);
	const text = textOf(markup);
	assert.equal(BILLED_UNFINALIZED_HEADLINE, "the trailer's claim was never proven");
	assert.match(text, /the trailer's claim was never proven/);
	assert.match(text, /this is a failed promise, not a forgery signal/);
	assert.match(markup, />UNPROVEN</);
	assert.match(text, /terminal-event proof summary/);
	assert.match(text, new RegExp(checked.envelope.terminalEvent.chain));
	assert.match(text, new RegExp(checked.envelope.terminalEvent.profile));
	assert.match(
		markup,
		new RegExp(`href="/r/${checked.linkedReceiptId}"`),
		"the link is rendered once linkage is verified",
	);
});

test("linkage NOT verified: the component itself refuses to render the link (defensive gate)", () => {
	const bundleState = fixtureState(loadFixture("billed-unfinalized.json"));
	assert.equal(bundleState.kind, "billedUnfinalized");
	if (bundleState.kind !== "billedUnfinalized") return;
	// linkage is still "unchecked" — never hand-set to "verified" by a caller
	// that skipped `verifyBilledUnfinalizedLinkage`.
	assert.equal(bundleState.linkage, "unchecked");
	const markup = html(<BilledUnfinalizedStateView state={bundleState} />);
	assert.doesNotMatch(markup, /fallback-link/);
	assert.doesNotMatch(markup, new RegExp(`href="/r/${bundleState.linkedReceiptId}"`));
});

test("X1: every broken-equality mutant renders as integrityFailure with NO billedUnfinalized/link view reachable", () => {
	const files = [
		"billed-unfinalized-mutants/route-body-id-mismatch.json",
		"billed-unfinalized-mutants/linked-receipt-id-mismatch.json",
		"billed-unfinalized-mutants/source-reservation-id-mismatch.json",
		"billed-unfinalized-mutants/transfer-set-root-mismatch.json",
	];
	for (const file of files) {
		const mutant = loadTyped<BilledUnfinalizedMutantCase>(file);
		let state: PageState = parseResolverResponse({
			routeParamId: mutant.routeParamId,
			httpStatus: mutant.wire.httpStatus,
			headers: mutant.wire.headers as Record<string, string>,
			raw: JSON.stringify(mutant.wire.body),
		});
		if (state.kind === "billedUnfinalized") {
			const linkedState = parseResolverResponse({
				routeParamId: mutant.linkedReceipt.receiptId,
				httpStatus: 200,
				headers: {},
				raw: JSON.stringify(mutant.linkedReceipt),
			});
			state = verifyBilledUnfinalizedLinkage(state, linkedState);
		}
		assert.equal(state.kind, "integrityFailure", file);
	}
});

// ===========================================================================
// Loud failures — unknown (404), unverifiable (409, resolver-sourced)
// ===========================================================================

test("unknown.json: full danger register, the pinned headline, and the red-flag note", () => {
	const state = fixtureState(loadFixture("unknown.json"));
	assert.equal(state.kind, "unknownReceipt");
	if (state.kind !== "unknownReceipt") return;
	const markup = html(<UnknownReceiptStateView state={state} />);
	const text = textOf(markup);
	assert.equal(UNKNOWN_HEADLINE, "This receipt ID was never allocated.");
	assert.match(text, /This receipt ID was never allocated\./);
	assert.match(text, /an unknown receipt on a commit is an integrity red flag/);
	assert.match(markup, /data-register="danger"/);
});

test("unverifiable.json (409, resolver-sourced): full danger, the failed check named, and the ledger with a keyboard-reachable jump link", () => {
	const state = fixtureState(loadFixture("unverifiable.json"));
	assert.equal(state.kind, "integrityFailure");
	if (state.kind !== "integrityFailure") return;
	assert.equal(state.cause.source, "resolver");
	const markup = html(<IntegrityFailureStateView state={state} />);
	const text = textOf(markup);

	assert.equal(
		UNVERIFIABLE_HEADLINE,
		"proof recomputation failed against the chain — this should be impossible",
	);
	assert.match(text, /proof recomputation failed against the chain — this should be impossible/);
	assert.match(text, /the resolver alerts internally/);
	assert.match(markup, /data-register="danger"/);

	// R9: every step + check renders, not just the failed one — the ledger is
	// reused whole, never trimmed to "the interesting row".
	assert.match(markup, /data-testid="check-ledger"/);
	for (const name of [
		"schema",
		"event",
		"registry",
		"signature",
		"inclusion",
		"checkpoint",
		"semantics",
		"derivations",
		"extensions",
		"registryBinding",
		"predecessorLinkage",
		"checkpointHistory",
		"anchorEvidence",
	]) {
		assert.match(markup, new RegExp(`id="check-${name}"`), name);
	}
	assert.match(markup, /aria-labelledby="check-ledger-title"/);
	assert.match(markup, /id="check-ledger-title"/);

	// The named failure — SIG_INVALID on `signature` — is both named in the
	// diagnostic panel AND keyboard-reachable via a real anchor into the ledger.
	assert.match(text, /SIGNATURE/);
	assert.match(text, /SIG_INVALID/);
	assert.match(markup, /href="#check-signature"/);
	assert.match(markup, /href="#check-signature"[^>]*class="focus-ring/);
});

// ===========================================================================
// R1/R3/R4 — page-side integrity failures, distinct headlines, no ledger
// ===========================================================================

test("R1 (id-mismatch.json): page-side headline, no verification member, no check-ledger rendered", () => {
	const state = fixtureState(loadFixture("id-mismatch.json"));
	assert.equal(state.kind, "integrityFailure");
	if (state.kind !== "integrityFailure") return;
	assert.ok(state.cause.source === "page" && state.cause.obligation === "R1");
	const markup = html(<IntegrityFailureStateView state={state as IntegrityFailureState} />);
	assert.doesNotMatch(markup, /data-testid="check-ledger"/);
	assert.match(textOf(markup), /does not name the ID it was asked about/);
});

test("R4 (receiptBytes value-mismatch mutant): page-side headline, byte-authority detail rendered", () => {
	const mutant = loadTyped<{
		routeParamId: string;
		wire: { httpStatus: number; headers: Record<string, string>; body: unknown };
	}>("receipt-bytes-mutants/value-mismatch.json");
	const state = parseResolverResponse({
		routeParamId: mutant.routeParamId,
		httpStatus: mutant.wire.httpStatus,
		headers: mutant.wire.headers,
		raw: JSON.stringify(mutant.wire.body),
	});
	assert.equal(state.kind, "integrityFailure");
	if (state.kind !== "integrityFailure") return;
	assert.ok(state.cause.source === "page" && state.cause.obligation === "R4");
	const markup = html(<IntegrityFailureStateView state={state} />);
	assert.doesNotMatch(markup, /data-testid="check-ledger"/);
	assert.match(textOf(markup), /signed receipt bytes do not agree/);
});

test("every page-side integrity headline is textually distinct from the resolver's own 409 wording", () => {
	const files = [
		["id-mismatch.json", "R1"],
		["billed-unfinalized-mutants/route-body-id-mismatch.json", "R3"],
		["receipt-bytes-mutants/value-mismatch.json", "R4"],
	] as const;
	for (const [file, obligation] of files) {
		const wire = loadTyped<{
			routeParamId: string;
			wire: { httpStatus: number; headers: Record<string, string>; body: unknown };
		}>(file);
		const state = parseResolverResponse({
			routeParamId: wire.routeParamId,
			httpStatus: wire.wire.httpStatus,
			headers: wire.wire.headers,
			raw: JSON.stringify(wire.wire.body),
		});
		assert.equal(state.kind, "integrityFailure", file);
		if (state.kind !== "integrityFailure") continue;
		assert.ok(state.cause.source === "page", file);
		if (state.cause.source === "page") assert.equal(state.cause.obligation, obligation, file);
		const text = textOf(html(<IntegrityFailureStateView state={state} />));
		assert.doesNotMatch(text, /this should be impossible/, file);
	}
});

// ===========================================================================
// Invalid ID (local, R2) — distinct from 404, resolver never asked
// ===========================================================================

test("an invalid ut1 ID renders the §12 rule and the never-asked note", () => {
	const routeParamId = "ut1_tooshort";
	const check = validateReceiptId(routeParamId);
	assert.equal(check.valid, false);
	if (check.valid) return;
	const markup = html(
		<InvalidIdStateView state={{ kind: "invalidId", routeParamId, reason: check.reason }} />,
	);
	const text = textOf(markup);
	assert.match(text, /not a valid receipt ID/);
	assert.match(text, /decodes to exactly 16 bytes/);
	assert.match(text, /never reached the resolver/i);
	assert.match(text, new RegExp(check.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// ===========================================================================
// Operational / protocol — 503, 429, protocol-error
// ===========================================================================

test("verification-unavailable.json: warning register, Retry-After honored, retry link present", () => {
	const state = fixtureState(loadFixture("verification-unavailable.json"));
	assert.equal(state.kind, "verificationUnavailable");
	if (state.kind !== "verificationUnavailable") return;
	const markup = html(<VerificationUnavailableStateView state={state} />);
	const text = textOf(markup);
	assert.equal(
		VERIFICATION_UNAVAILABLE_HEADLINE,
		"verification is temporarily unavailable — an operational condition, not a cryptographic mismatch",
	);
	assert.match(text, /verification is temporarily unavailable/);
	assert.match(text, /30s/);
	assert.match(markup, /data-register="warning"/);
	assert.match(markup, new RegExp(`href="/r/${state.routeParamId}"`));
});

test("rate-limited.json: neutral register, plain notice, retry link present", () => {
	const state = fixtureState(loadFixture("rate-limited.json"));
	assert.equal(state.kind, "rateLimited");
	if (state.kind !== "rateLimited") return;
	const markup = html(<RateLimitedStateView state={state} />);
	const text = textOf(markup);
	assert.equal(RATE_LIMITED_HEADLINE, "rate limited — try again shortly");
	assert.match(text, /rate limited/);
	assert.match(text, /10s/);
	assert.match(markup, new RegExp(`href="/r/${state.routeParamId}"`));
});

test("protocol-error shell: neutral-danger register, reason + retry, wording distinct from 503", () => {
	const routeParamId = "ut1_WskkNFGvdE3dwzwzFyxcNC";
	const state = {
		kind: "protocolError" as const,
		routeParamId,
		reason: "verdictAlgebra" as const,
		detail: 'mandatory step "signature" is "failed", not "passed"',
		httpStatus: 200,
	};
	const markup = html(<ProtocolErrorStateView state={state} />);
	const text = textOf(markup);
	assert.equal(PROTOCOL_ERROR_HEADLINE, "could not obtain a trustworthy answer from the resolver");
	assert.match(text, /could not obtain a trustworthy answer from the resolver/);
	assert.doesNotMatch(text, /operational condition/);
	assert.match(text, /verdictAlgebra/);
	assert.match(text, /HTTP 200/);
	assert.match(markup, new RegExp(`href="/r/${routeParamId}"`));
});

test("X6: every body-based protocol vector renders through ProtocolErrorStateView with its reason named", () => {
	for (const vector of protocolVectors) {
		if (!vector.wire) continue; // transportFailure vectors go through resolve.ts, not the parser
		const state = parseResolverResponse({
			routeParamId: vector.routeParamId ?? "ut1_WskkNFGvdE3dwzwzFyxcNC",
			httpStatus: vector.wire.httpStatus,
			headers: (vector.wire.headers ?? {}) as Record<string, string>,
			raw: vector.wire.body === null ? "" : JSON.stringify(vector.wire.body),
		});
		assert.equal(state.kind, "protocolError", vector.label);
		if (state.kind !== "protocolError") continue;
		const markup = html(<ProtocolErrorStateView state={state} />);
		assert.match(markup, /could not obtain a trustworthy answer from the resolver/, vector.label);
		assert.match(markup, new RegExp(`data-reason="${state.reason}"`), vector.label);
	}
});

test("X6: the malformedBody vectors (raw, non-JSON) also render through ProtocolErrorStateView", () => {
	for (const vector of protocolVectors) {
		if (vector.rawBody === undefined) continue;
		const state = parseResolverResponse({
			routeParamId: vector.routeParamId ?? "ut1_WskkNFGvdE3dwzwzFyxcNC",
			httpStatus: 200,
			headers: {},
			raw: vector.rawBody,
		});
		assert.equal(state.kind, "protocolError", vector.label);
		if (state.kind !== "protocolError") continue;
		const markup = html(<ProtocolErrorStateView state={state} />);
		assert.match(markup, /could not obtain a trustworthy answer from the resolver/, vector.label);
	}
});

// ===========================================================================
// StateView dispatcher — every kind reaches its own component, none silently
// falls through to another's
// ===========================================================================

test("StateView: data-state on the rendered root matches the PageState kind, for every non-verified fixture", () => {
	const cases: [string, string][] = [
		["reserved.json", "pending"],
		["reconciling.json", "pending"],
		["cancelled.json", "terminalNoReceipt"],
		["not-minted.json", "terminalNoReceipt"],
		["unknown.json", "unknownReceipt"],
		["unverifiable.json", "integrityFailure"],
		["verification-unavailable.json", "verificationUnavailable"],
		["rate-limited.json", "rateLimited"],
	];
	for (const [file, expectedKind] of cases) {
		const state = fixtureState(loadFixture(file));
		assert.equal(state.kind, expectedKind, file);
		const markup = html(<StateView state={state} />);
		assert.match(markup, new RegExp(`data-state="${expectedKind}"`), file);
	}
});
