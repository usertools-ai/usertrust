/**
 * Task 6 — the FULL-MATRIX integration pass (plan Task 6 / spec §8): every
 * conforming (C*) and rejection (X*) fixture/vector driven through the REAL pipeline — parse
 * (`parseResolverResponse` / `resolveVerifyPageState`'s transport mapping /
 * `validateReceiptId`) THEN render, through the production dispatcher
 * (`components/state-view.tsx`'s `StateView`, the one switch the page itself
 * uses) — with the pinned copy for the resolved state asserted to actually
 * reach the DOM.
 *
 * Every per-task test file already covers its own slice deeply
 * (`rendering.test.tsx`: C1-C18 through `VerifiedReceipt` with the FULL R5-R34
 * obligation text per row; `states.test.tsx`: the §7 non-receipt states with
 * their per-state copy and loudness). This file's job is different: it is the
 * single place that walks EVERY manifest entry in `fixtures/index.ts` plus
 * EVERY X6/X7 vector and proves each one reaches SOME render without
 * throwing, dispatched to the CORRECT component (`data-state` agrees with the
 * parsed `PageState.kind`), with that state's headline actually in the text —
 * using `shellHeadline` (`lib/shell-copy.ts`) as the oracle, since it is
 * itself pinned against the spec by `shell-copy.test.ts` and is the same
 * state -> string mapping the OG card (`ogCardWord`) relies on being correct.
 *
 * It also closes five specific holes left by the per-task files, each
 * verified absent by grep before this file was written:
 *   - X2 (`unsupported-apiversion.json`) and X3 (`unknown-status.json`) were
 *     asserted at the fixture-shape level (`conformance.test.ts`) and the
 *     parse level (`wire.test.ts`) but never rendered.
 *   - X4's SECOND file, `id-mismatch-receipt-document.json` — the dangerous
 *     "signed receipt names another ID" half of R1 that the envelope check
 *     alone cannot see — was parsed (`wire.test.ts`) but never rendered.
 *   - Three of X5's four `receiptBytes` mutants (non-canonical base64,
 *     duplicate key, unsafe integer) were parsed but never rendered; only
 *     `value-mismatch.json` reached a component (`states.test.tsx`).
 *   - X6's two `transportFailure` vectors (timeout, network failure) were
 *     asserted at the transport-state level (`transport.test.ts`) but never
 *     rendered — `states.test.tsx`'s X6 loop explicitly skips them
 *     (`if (!vector.wire) continue`).
 *   - X7's full `idVectors` corpus was exercised for its decode VERDICT
 *     (`wire.test.ts`, `transport.test.ts`) but only one hand-picked ID
 *     (`"ut1_tooshort"`) ever reached `InvalidIdStateView`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import StateView from "./components/state-view";
import { FIXTURE_DIR, fixtureState, loadFixture } from "./fixture-harness";
import { idVectors } from "./fixtures/id-vectors";
import { conformingFixtures, rejectionVectors } from "./fixtures/index";
import { protocolVectors } from "./fixtures/protocol-vectors";
import type { BilledUnfinalizedMutantCase } from "./fixtures/types";
import { shellHeadline } from "./lib/shell-copy";
import {
	type PageState,
	parseResolverResponse,
	transportFailureState,
	validateReceiptId,
	verifyBilledUnfinalizedLinkage,
} from "./lib/wire";

/** Fixtures whose TS shape needs extra fields beyond `fixture-harness.ts`'s `WireFixture` (e.g. X1's `linkedReceipt`/`brokenEquality`). */
function loadTyped<T>(relPath: string): T {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, relPath), "utf-8")) as T;
}

function render(state: PageState): string {
	return renderToStaticMarkup(<StateView state={state} />);
}

function textOf(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ");
}

/**
 * Parse + render + the two universal assertions every matrix member owes:
 * the dispatcher wired it to the RIGHT component (`data-state` agrees with
 * the parsed kind), and that component actually printed the state's pinned
 * headline. Returns the state for callers that assert further.
 */
function parseRenderAssert(state: PageState, label: string): PageState {
	let html: string;
	try {
		html = render(state);
	} catch (error) {
		throw new Error(
			`${label}: StateView threw for kind "${state.kind}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	assert.match(
		html,
		new RegExp(`data-state="${state.kind}"`),
		`${label}: wrong component dispatched`,
	);
	assert.ok(
		textOf(html).includes(shellHeadline(state)),
		`${label}: pinned headline "${shellHeadline(state)}" missing from render`,
	);
	return state;
}

// ===========================================================================
// §8.1 — every conforming fixture (C1-C29, 30 files), parsed AND rendered
// through the real production dispatcher.
// ===========================================================================

test("C1-C29: every conforming fixture file parses and renders through StateView with its pinned headline", () => {
	let checked = 0;
	for (const entry of conformingFixtures) {
		for (const file of entry.files) {
			const state = fixtureState(loadFixture(file));
			parseRenderAssert(state, `${entry.id} (${file})`);
			checked++;
		}
	}
	assert.equal(checked, 30, "30 conforming fixture files (C1-C29, C22 a pair)");
});

// ===========================================================================
// X1 — billedUnfinalized bundle mutants (route/linked-receipt/reservation/
// transfer-set-root equality breaks), each rendered as an integrity failure.
// ===========================================================================

test("X1: every broken-equality mutant renders as integrityFailure with the page-side R3 headline", () => {
	const x1 = rejectionVectors.find((entry) => entry.id === "X1");
	assert.ok(x1 && x1.files.length === 4, "X1 must carry all 4 mutant files");
	for (const file of x1?.files ?? []) {
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
		parseRenderAssert(state, `X1 (${file})`);
	}
});

// ===========================================================================
// X2 / X3 — apiVersion / status rejected into the protocol-error shell.
// GAP CLOSED: previously asserted only at the fixture-shape and parse
// layers, never rendered.
// ===========================================================================

test("X2 (unsupported-apiversion.json): renders through ProtocolErrorStateView with the R37 headline", () => {
	const state = fixtureState(loadFixture("unsupported-apiversion.json"));
	assert.equal(state.kind, "protocolError");
	if (state.kind !== "protocolError") return;
	assert.equal(state.reason, "unsupportedApiVersion");
	parseRenderAssert(state, "X2 (unsupported-apiversion.json)");
});

test("X3 (unknown-status.json): renders through ProtocolErrorStateView with the R37 headline", () => {
	const state = fixtureState(loadFixture("unknown-status.json"));
	assert.equal(state.kind, "protocolError");
	if (state.kind !== "protocolError") return;
	assert.equal(state.reason, "unknownStatus");
	parseRenderAssert(state, "X3 (unknown-status.json)");
});

// ===========================================================================
// X4 — R1's identity chain, BOTH halves rendered. GAP CLOSED: the
// receipt-document half (`id-mismatch-receipt-document.json`) — the answer-B-
// under-receipt-A forgery the envelope check alone cannot see — was parsed
// but never rendered before this file.
// ===========================================================================

test("X4: both R1 identity-chain halves render as integrityFailure with the page-side R1 headline", () => {
	const x4 = rejectionVectors.find((entry) => entry.id === "X4");
	assert.ok(x4 && x4.files.length === 2, "X4 must carry both identity-chain files");
	for (const file of x4?.files ?? []) {
		const state = fixtureState(loadFixture(file));
		assert.equal(state.kind, "integrityFailure", file);
		if (state.kind === "integrityFailure") {
			assert.ok(state.cause.source === "page" && state.cause.obligation === "R1", file);
		}
		parseRenderAssert(state, `X4 (${file})`);
	}
});

// ===========================================================================
// X5 — the R4 strict pipeline, ALL FOUR mutants rendered. GAP CLOSED: only
// `value-mismatch.json` had ever reached a component before this file; the
// other three (non-canonical base64, duplicate key inside receiptBytes,
// unsafe integer) were parse-only.
// ===========================================================================

test("X5: every receiptBytes mutant renders as integrityFailure with the page-side R4 headline", () => {
	const x5 = rejectionVectors.find((entry) => entry.id === "X5");
	assert.ok(x5 && x5.files.length === 4, "X5 must carry all 4 receiptBytes mutants");
	for (const file of x5?.files ?? []) {
		const state = fixtureState(loadFixture(file));
		assert.equal(state.kind, "integrityFailure", file);
		if (state.kind === "integrityFailure") {
			assert.ok(state.cause.source === "page" && state.cause.obligation === "R4", file);
		}
		parseRenderAssert(state, `X5 (${file})`);
	}
});

// ===========================================================================
// X6 — protocol vectors. The body-based/malformed-body kinds already render
// in `states.test.tsx`; the two `transportFailure` vectors (timeout, network
// failure) do not go through `parseResolverResponse` at all (there is no
// body to parse) and were previously asserted only as far as the transport
// STATE (`transport.test.ts`), never rendered. GAP CLOSED here.
// ===========================================================================

test("X6: every transportFailure vector renders through ProtocolErrorStateView with the R37 headline", () => {
	const transportVectors = protocolVectors.filter((vector) => vector.kind === "transportFailure");
	assert.equal(
		transportVectors.length,
		2,
		"X6 must carry both transport-failure vectors (timeout, networkFailure)",
	);
	for (const vector of transportVectors) {
		assert.ok(vector.simulate, vector.label);
		if (!vector.simulate) continue;
		const state = transportFailureState(
			vector.routeParamId ?? "ut1_WskkNFGvdE3dwzwzFyxcNC",
			vector.simulate,
		);
		assert.equal(state.kind, "protocolError", vector.label);
		assert.equal(
			state.reason,
			vector.simulate === "timeout" ? "transportTimeout" : "networkFailure",
			vector.label,
		);
		parseRenderAssert(state, `X6 (${vector.label})`);
	}
});

test("X6: every remaining protocol vector (malformed body / HTTP mismatch / verdict algebra) also renders", () => {
	let checked = 0;
	for (const vector of protocolVectors) {
		if (vector.kind === "transportFailure") continue; // covered above — no body to parse
		const state =
			vector.rawBody !== undefined
				? parseResolverResponse({
						routeParamId: vector.routeParamId ?? "ut1_WskkNFGvdE3dwzwzFyxcNC",
						httpStatus: 200,
						headers: {},
						raw: vector.rawBody,
					})
				: parseResolverResponse({
						routeParamId: vector.routeParamId ?? "ut1_WskkNFGvdE3dwzwzFyxcNC",
						httpStatus: vector.wire?.httpStatus ?? 200,
						headers: (vector.wire?.headers ?? {}) as Record<string, string>,
						raw:
							vector.wire?.body === null || vector.wire === undefined
								? ""
								: JSON.stringify(vector.wire.body),
					});
		assert.equal(state.kind, "protocolError", vector.label);
		parseRenderAssert(state, `X6 (${vector.label})`);
		checked++;
	}
	assert.equal(
		checked,
		protocolVectors.length - 2,
		"every non-transport protocol vector was exercised",
	);
});

// ===========================================================================
// X7 — the FULL id-decode corpus. GAP CLOSED: previously only one hand-picked
// invalid ID ("ut1_tooshort") ever reached `InvalidIdStateView`; every other
// vector's outcome was asserted at the `validateReceiptId` boolean alone.
// ===========================================================================

test("X7: every invalid id vector renders through InvalidIdStateView with its own decode-rule reason", () => {
	const invalidVectors = idVectors.filter((vector) => vector.expected === "invalid");
	assert.ok(invalidVectors.length > 0, "the corpus must include invalid vectors");
	for (const vector of invalidVectors) {
		const check = validateReceiptId(vector.id);
		assert.equal(check.valid, false, vector.label);
		if (check.valid) continue;
		const state: PageState = { kind: "invalidId", routeParamId: vector.id, reason: check.reason };
		parseRenderAssert(state, `X7 (${vector.label})`);
		assert.ok(
			textOf(render(state)).includes(check.reason),
			`X7 (${vector.label}): the specific decode-rule reason must reach the DOM, not just the generic headline`,
		);
	}
});

test("X7: every valid id vector is accepted by validateReceiptId (the passing controls)", () => {
	const validVectors = idVectors.filter((vector) => vector.expected === "valid");
	assert.ok(
		validVectors.length > 0,
		"the corpus must include passing controls (R2 is meaningless without them)",
	);
	for (const vector of validVectors) {
		assert.equal(validateReceiptId(vector.id).valid, true, vector.label);
	}
});

// ===========================================================================
// X8 / X9 — delegationPosture, missing and unrecognized. Both render the
// protocol-error shell (R38): the page may not render an amount without its
// posture label, because a reader supplies the missing scope from assumption
// and the assumption is always "this is what the work cost".
// ===========================================================================

test("X8/X9: a missing or unrecognized delegationPosture renders the protocol-error shell", () => {
	for (const id of ["X8", "X9"] as const) {
		const entry = rejectionVectors.find((vector) => vector.id === id);
		assert.ok(entry, `${id} must exist in the manifest`);
		for (const file of entry.files) {
			const state = fixtureState(loadFixture(file));
			assert.equal(
				state.kind,
				"protocolError",
				`${id} (${file}) must fail closed rather than render a total`,
			);
			parseRenderAssert(state, `${id} (${file})`);
			// R38's whole point is that the amount never reaches the DOM. A page
			// that failed closed but still painted the figure would satisfy the
			// state check and defeat the obligation.
			assert.equal(
				/\$\s?\d/.test(textOf(render(state))),
				false,
				`${id} (${file}): no amount may render when the posture is unusable`,
			);
		}
	}
});

// ===========================================================================
// X10 — §7's contiguity clause, isolated. NOT a page state: this page renders
// the resolver's verdict and never walks the served history (D2), so the
// vector is aimed at `usertrust-verify` and the resolver. Asserted here only
// to pin that the page's behaviour is the DECLARED one, so the exemption in
// `wire.test.ts` cannot quietly widen.
// ===========================================================================

test("X10: the contiguity vector is invisible to this page, by design and by declaration", () => {
	const entry = rejectionVectors.find((vector) => vector.id === "X10");
	assert.ok(entry, "X10 must exist in the manifest");
	assert.equal(entry.consumer, "historyWalk", "X10 must declare the consumer it targets");
	for (const file of entry.files) {
		const state = fixtureState(loadFixture(file));
		assert.equal(
			state.kind,
			"verified",
			`X10 (${file}) renders green here — the page does not walk`,
		);
		parseRenderAssert(state, `X10 (${file})`);
	}
});

// ===========================================================================
// Manifest-completeness cross-check — this file's coverage against the §8
// manifest itself, so a fixture added to `fixtures/index.ts` without a
// corresponding entry here is a visible, named gap rather than a silent one.
// ===========================================================================

test("manifest cross-check: this file's X-vector coverage accounts for every rejectionVectors entry", () => {
	const ids = rejectionVectors.map((entry) => entry.id);
	assert.deepEqual(
		ids,
		["X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10"],
		"every X-id has a dedicated block above",
	);
});
