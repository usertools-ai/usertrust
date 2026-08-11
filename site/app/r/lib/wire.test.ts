/**
 * Tests for the verify page's wire module, driven by the §8 fixture matrix.
 *
 * The contract is two-sided and the tests are written that way:
 *   - every §8.1 CONFORMING fixture (C1-C27) must reach its EXACT PageState;
 *   - every §8.2 REJECTION vector (X1-X7) must fail CLOSED into its NAMED
 *     state — integrity failure or the protocol-error shell — never green,
 *     never silently tolerated.
 *
 * `conformance.test.ts` (Task 1) proves the fixtures are internally
 * consistent using its OWN local implementation of the ID rule, the R4
 * pipeline and the verdict algebra. This file proves the PAGE's
 * implementation agrees with it. Two independent implementations landing on
 * the same verdicts over the same corpus is the point; importing one into
 * the other would throw that away.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { idVectors } from "../fixtures/id-vectors";
import { conformingFixtures, rejectionVectors } from "../fixtures/index";
import { protocolVectors } from "../fixtures/protocol-vectors";
import type {
	BilledUnfinalizedMutantCase,
	FixtureCase,
	SuccessEnvelope as FixtureSuccessEnvelope,
	Verification as FixtureVerification,
} from "../fixtures/types";
import {
	type BilledUnfinalizedState,
	type CheckEntry,
	checkFailureCodePlacement,
	checkReceiptBytesAgreement,
	checkVerdictAlgebra,
	decodeReceiptBytes,
	type LadderStatus,
	type PageState,
	parseResolverResponse,
	type ResolverHeaders,
	type SuccessEnvelope,
	strictParseJson,
	structurallyEqual,
	transportFailureState,
	type Verification,
	validateReceiptId,
	verifyBilledUnfinalizedLinkage,
	warrantedRung,
} from "./wire";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture<T = FixtureCase>(relPath: string): T {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, relPath), "utf-8")) as T;
}

/**
 * Fixtures store the body as structured JSON; the wire hands the page RAW
 * BYTES. Re-serializing here is what keeps `parseResolverResponse`'s only
 * input a string, so the malformed-body and duplicate-key paths are reachable
 * at all.
 */
function toInput(fixture: FixtureCase) {
	const { wire, routeParamId } = fixture;
	const raw =
		wire.body === null
			? null
			: typeof wire.body === "string"
				? wire.body
				: JSON.stringify(wire.body);
	return {
		routeParamId,
		httpStatus: wire.httpStatus,
		headers: wire.headers as ResolverHeaders,
		raw,
	};
}

function parseFixture(relPath: string): PageState {
	return parseResolverResponse(toInput(loadFixture(relPath)));
}

// ---------------------------------------------------------------------------
// Compile-time agreement between the two §4 transcriptions
// ---------------------------------------------------------------------------

/**
 * `app/r/fixtures/types.ts` (Task 1) and this module both transcribe §4. They
 * are allowed to be separate files; they are NOT allowed to drift. A fixture
 * envelope must be consumable as a wire envelope, and a fixture verification
 * as a wire verification — if either transcription moves, this stops
 * compiling.
 */
const _fixtureEnvelopeIsWireEnvelope: (e: FixtureSuccessEnvelope) => SuccessEnvelope = (e) => e;
const _fixtureVerificationIsWireVerification: (v: FixtureVerification) => Verification = (v) => v;
void _fixtureEnvelopeIsWireEnvelope;
void _fixtureVerificationIsWireVerification;

// ===========================================================================
// R2 / §12 — the canonical ID rule
// ===========================================================================

test("R2/§12: every X7 vector's expected outcome matches validateReceiptId", () => {
	assert.ok(idVectors.length > 0);
	for (const vector of idVectors) {
		const result = validateReceiptId(vector.id);
		assert.equal(
			result.valid,
			vector.expected === "valid",
			`${vector.label}: expected ${vector.expected} — ${vector.reason}${
				result.valid ? "" : ` (module says: ${result.reason})`
			}`,
		);
	}
});

test("R2/§12: the character-count rule is NOT the ID rule", () => {
	// A 22-char, in-alphabet string that decodes to 17 bytes: grammar-legal,
	// ID-illegal. This is the whole point of §12's two-step rule.
	const overlong = validateReceiptId("ut1_111ZNfp3ndcZGxiLV6r6TS");
	assert.equal(overlong.valid, false);
	assert.match((overlong as { reason: string }).reason, /not exactly 16/);

	// Leading '1's are leading ZERO BYTES counted exactly — one '1' on a
	// 16-byte canonical form makes 17 bytes, not a re-padding of the same ID.
	const redundantPad = validateReceiptId("ut1_1Ly6eTFZPxTsdg1JgGyiY9b");
	assert.equal(redundantPad.valid, false);

	// ...and the un-padded original is valid, so the two are NOT aliases.
	assert.equal(validateReceiptId("ut1_Ly6eTFZPxTsdg1JgGyiY9b").valid, true);
});

test("R2/D4: a malformed route param never reaches the resolver body at all", () => {
	// Even handed a perfectly conforming 200 body, an invalid route is the
	// local invalid-ID state — the resolver is never asked (D4), so nothing
	// about the body can rescue it.
	const c1 = loadFixture<FixtureCase>("commit-checkpoint.json");
	const state = parseResolverResponse({ ...toInput(c1), routeParamId: "ut1_notavalidid0000" });
	assert.equal(state.kind, "invalidId");
});

test("R2: every conforming fixture's route param is itself a canonical ut1 ID", () => {
	for (const entry of conformingFixtures) {
		for (const file of entry.files) {
			const fixture = loadFixture<FixtureCase>(file);
			assert.equal(
				validateReceiptId(fixture.routeParamId).valid,
				true,
				`${entry.id} (${file}): routeParamId must be canonical`,
			);
		}
	}
});

// ===========================================================================
// §8.1 — every conforming fixture reaches its exact PageState
// ===========================================================================

/** §3's table, restated as the expectation for each conforming fixture. */
const EXPECTED_STATE: Record<string, { kind: PageState["kind"]; detail?: string }> = {
	"commit-checkpoint.json": { kind: "verified", detail: "verified_checkpoint" },
	"commit-history.json": { kind: "verified", detail: "verified_checkpoint_history" },
	"commit-anchored.json": { kind: "verified", detail: "verified_anchored" },
	"commit-s3-only.json": { kind: "verified", detail: "verified_checkpoint" },
	"commit-anchor-failed.json": { kind: "verified", detail: "verified_checkpoint" },
	"commit-history-failed.json": { kind: "verified", detail: "verified_checkpoint" },
	"commit-checks-unavailable.json": { kind: "verified", detail: "verified_checkpoint" },
	"commit-large-mixed.json": { kind: "verified", detail: "verified_checkpoint" },
	"commit-owner-asserted.json": { kind: "verified", detail: "verified_checkpoint" },
	"commit-gen1-addenda-advisory.json": { kind: "verified", detail: "verified_checkpoint" },
	"commit-gen2-addendum.json": { kind: "verified", detail: "verified_checkpoint" },
	"commit-superseded-advisory.json": { kind: "verified", detail: "verified_checkpoint" },
	"pr-private.json": { kind: "verified", detail: "verified_checkpoint" },
	"pr-revision-superseded.json": { kind: "verified", detail: "verified_checkpoint" },
	"issue-public.json": { kind: "verified", detail: "verified_checkpoint" },
	"session-owner-estimated.json": { kind: "verified", detail: "verified_checkpoint" },
	"session-workflow-attested.json": { kind: "verified", detail: "verified_checkpoint" },
	"session-fallback.json": { kind: "verified", detail: "verified_checkpoint" },
	"reserved.json": { kind: "pending", detail: "reserved" },
	"reconciling.json": { kind: "pending", detail: "reconciling" },
	"billed-unfinalized.json": { kind: "billedUnfinalized" },
	"cancelled.json": { kind: "terminalNoReceipt", detail: "cancelled" },
	"expired.json": { kind: "terminalNoReceipt", detail: "expired" },
	"not-minted.json": { kind: "terminalNoReceipt", detail: "notMinted" },
	"unknown.json": { kind: "unknownReceipt" },
	"unverifiable.json": { kind: "integrityFailure" },
	"verification-unavailable.json": { kind: "verificationUnavailable" },
	"rate-limited.json": { kind: "rateLimited" },
};

for (const entry of conformingFixtures) {
	test(`${entry.id} (${entry.files.join(", ")}): parses into its §3 page state`, () => {
		for (const file of entry.files) {
			const expected = EXPECTED_STATE[file];
			assert.ok(expected, `${file}: no expected state declared`);
			const state = parseFixture(file);
			assert.equal(state.kind, expected.kind, `${file}: expected ${expected.kind}`);
			if (state.kind === "verified") {
				assert.equal(state.rung, expected.detail, `${file}: wrong ladder rung`);
				assert.equal(state.receiptId, state.routeParamId);
				assert.equal(state.envelope.receipt.receiptId, state.routeParamId);
				assert.ok(state.receiptBytesText.length > 0, `${file}: decoded bytes must be carried`);
				// R9 — the trust snapshot the verification ran under is always present.
				assert.ok(
					state.envelope.verification.trustSnapshotId.length > 0,
					`${file}: trustSnapshotId must be rendered`,
				);
				// §4.1 — `advisories` is REQUIRED on a 200 (may be empty).
				assert.ok(Array.isArray(state.envelope.advisories), `${file}: advisories required on 200`);
				// R5 — the served rung never exceeds what the extensions warrant.
				const ladder: LadderStatus[] = [
					"verified_checkpoint",
					"verified_checkpoint_history",
					"verified_anchored",
				];
				assert.ok(
					ladder.indexOf(state.rung) <= ladder.indexOf(warrantedRung(state.envelope.verification)),
					`${file}: rung above its extension cap`,
				);
			}
			if (state.kind === "pending" || state.kind === "terminalNoReceipt") {
				assert.equal(state.status, expected.detail);
			}
		}
	});
}

test("C5/C6/C7 (R10/R11): a failed or unavailable EXTENSION never demotes the base verdict", () => {
	for (const [file, extension] of [
		["commit-anchor-failed.json", "anchorEvidence"],
		["commit-history-failed.json", "checkpointHistory"],
		["commit-checks-unavailable.json", "checkpointHistory"],
	] as const) {
		const state = parseFixture(file);
		assert.equal(state.kind, "verified", `${file}: must stay green at the base rung`);
		if (state.kind !== "verified") continue;
		assert.equal(state.rung, "verified_checkpoint");
		const result = state.envelope.verification.checks[extension].result;
		assert.notEqual(result, "passed", `${file}: the ${extension} extension must be non-passing`);
	}
});

test("C25 (409): the integrity failure names the resolver's failed step and its code", () => {
	const state = parseFixture("unverifiable.json");
	assert.equal(state.kind, "integrityFailure");
	if (state.kind !== "integrityFailure") return;
	assert.equal(state.cause.source, "resolver");
	if (state.cause.source !== "resolver") return;
	assert.deepEqual(state.cause.failed, [{ name: "signature", failure: "SIG_INVALID" }]);
});

test("C26 (503) and C27 (429) carry their Retry-After, and never share a state", () => {
	const unavailable = parseFixture("verification-unavailable.json");
	assert.equal(unavailable.kind, "verificationUnavailable");
	if (unavailable.kind === "verificationUnavailable") {
		assert.ok(unavailable.retryAfter, "503 must surface Retry-After (R36)");
	}
	const limited = parseFixture("rate-limited.json");
	assert.equal(limited.kind, "rateLimited");
	if (limited.kind === "rateLimited") {
		assert.ok(limited.retryAfter, "429 must surface Retry-After");
		assert.equal(typeof limited.retryAfter?.seconds, "number");
	}
});

test("C27 (§4.2's exemption): a 429 body is NEVER parsed, whatever it contains", () => {
	// "Exactly one outcome: the rate-limited state — never the protocol-error
	// shell." Not even an unparseable body, an absent apiVersion, or a
	// future-version body can move it.
	const routeParamId = loadFixture<FixtureCase>("rate-limited.json").routeParamId;
	for (const raw of [
		null,
		"",
		"<html>429 Too Many Requests</html>",
		'{"apiVersion":"2","status":"verified_anchored"}',
		'{"status":',
	]) {
		const state = parseResolverResponse({
			routeParamId,
			httpStatus: 429,
			headers: { "retry-after": "30" },
			raw,
		});
		assert.equal(state.kind, "rateLimited", `429 with body ${JSON.stringify(raw)}`);
	}
});

test("C21 <-> C18: R3's four equalities all pass, and only then is the link renderable", () => {
	const bundle = parseFixture("billed-unfinalized.json");
	assert.equal(bundle.kind, "billedUnfinalized");
	if (bundle.kind !== "billedUnfinalized") return;
	// The link is NOT renderable until the cross-checks have actually run.
	assert.equal(bundle.linkage, "unchecked");

	const linked = parseFixture("session-fallback.json");
	const checked = verifyBilledUnfinalizedLinkage(bundle, linked);
	assert.equal(checked.kind, "billedUnfinalized");
	if (checked.kind !== "billedUnfinalized") return;
	assert.equal(checked.linkage, "verified");
	assert.equal(checked.linkedReceiptId, (linked as { receiptId: string }).receiptId);
});

// ===========================================================================
// §8.2 — every rejection vector fails CLOSED into its named state
// ===========================================================================

test("X1: each billed-unfinalized mutant lands in integrity failure on its named equality", () => {
	const x1 = rejectionVectors.find((entry) => entry.id === "X1");
	assert.ok(x1);
	for (const file of x1?.files ?? []) {
		const mutant = loadFixture<BilledUnfinalizedMutantCase>(file);
		const parsed = parseResolverResponse(toInput(mutant as unknown as FixtureCase));

		if (mutant.brokenEquality === "routeBodyId") {
			// Decidable from the 410 alone — R1's 410-side application (§10.15).
			assert.equal(parsed.kind, "integrityFailure", file);
			if (parsed.kind !== "integrityFailure") continue;
			assert.equal(parsed.cause.source, "page");
			if (parsed.cause.source !== "page" || parsed.cause.obligation !== "R3") {
				assert.fail(`${file}: expected an R3 cause`);
			}
			assert.equal(parsed.cause.brokenEquality, "routeBodyId");
			continue;
		}

		// The other three need the linked receipt.
		assert.equal(parsed.kind, "billedUnfinalized", file);
		if (parsed.kind !== "billedUnfinalized") continue;
		const linkedState = parseResolverResponse({
			routeParamId: mutant.linkedReceipt.receiptId,
			httpStatus: 200,
			headers: {},
			raw: JSON.stringify(mutant.linkedReceipt),
		});
		const checked = verifyBilledUnfinalizedLinkage(parsed, linkedState);
		assert.equal(checked.kind, "integrityFailure", `${file}: must fail the R3 cross-check`);
		if (checked.kind !== "integrityFailure") continue;
		assert.ok(checked.cause.source === "page" && checked.cause.obligation === "R3");
		if (checked.cause.source === "page" && checked.cause.obligation === "R3") {
			assert.equal(
				checked.cause.brokenEquality,
				mutant.brokenEquality,
				`${file}: must name the equality the mutant actually breaks`,
			);
		}
	}
});

test("X1: a mutant bundle NEVER reaches a renderable link", () => {
	const x1 = rejectionVectors.find((entry) => entry.id === "X1");
	for (const file of x1?.files ?? []) {
		const mutant = loadFixture<BilledUnfinalizedMutantCase>(file);
		const parsed = parseResolverResponse(toInput(mutant as unknown as FixtureCase));
		if (parsed.kind !== "billedUnfinalized") continue;
		assert.notEqual(parsed.linkage, "verified", `${file}: linkage must never start verified`);
	}
});

test("X2: an unsupported apiVersion never receives green v1 treatment", () => {
	const state = parseFixture("unsupported-apiversion.json");
	assert.equal(state.kind, "protocolError");
	if (state.kind !== "protocolError") return;
	assert.equal(state.reason, "unsupportedApiVersion");
});

test("X3: an unrecognized status under apiVersion 1 fails closed", () => {
	const state = parseFixture("unknown-status.json");
	assert.equal(state.kind, "protocolError");
	if (state.kind !== "protocolError") return;
	assert.equal(state.reason, "unknownStatus");
});

test("X4 (R1): an otherwise-valid 200 answering about another ID is an integrity failure", () => {
	const state = parseFixture("id-mismatch.json");
	assert.equal(state.kind, "integrityFailure");
	if (state.kind !== "integrityFailure") return;
	assert.equal(state.cause.source, "page");
	if (state.cause.source !== "page") return;
	assert.equal(state.cause.obligation, "R1");
});

test("X5 (R4): each receiptBytes mutant fails at its own pipeline stage", () => {
	const expectedStage: Record<string, string> = {
		"receipt-bytes-mutants/value-mismatch.json": "comparison",
		"receipt-bytes-mutants/non-canonical-base64.json": "base64",
		"receipt-bytes-mutants/duplicate-key.json": "duplicateKey",
		"receipt-bytes-mutants/unsafe-integer.json": "numeric",
	};
	const x5 = rejectionVectors.find((entry) => entry.id === "X5");
	assert.ok(x5);
	for (const file of x5?.files ?? []) {
		const state = parseFixture(file);
		assert.equal(state.kind, "integrityFailure", file);
		if (state.kind !== "integrityFailure") continue;
		assert.ok(state.cause.source === "page" && state.cause.obligation === "R4", file);
		if (state.cause.source === "page" && state.cause.obligation === "R4") {
			assert.equal(state.cause.stage, expectedStage[file], `${file}: wrong R4 stage`);
		}
	}
});

test("X5: the strict pipeline rejects exactly where a lenient JSON.parse would accept", () => {
	// R4's reason for existing, demonstrated rather than asserted: the naive
	// shortcut it forbids is concretely wrong on these two mutants.
	for (const file of [
		"receipt-bytes-mutants/duplicate-key.json",
		"receipt-bytes-mutants/unsafe-integer.json",
	]) {
		const fixture = loadFixture<FixtureCase>(file);
		const body = fixture.wire.body as unknown as SuccessEnvelope;

		const lenient = (() => {
			try {
				const text = Buffer.from(body.receiptBytes, "base64").toString("utf-8");
				return structurallyEqual(JSON.parse(text), body.receipt);
			} catch {
				return false;
			}
		})();
		assert.equal(lenient, true, `${file}: a lenient pipeline must (wrongly) accept this`);

		const strict = checkReceiptBytesAgreement(body.receiptBytes, body.receipt);
		assert.equal(strict.ok, false, `${file}: the strict pipeline must reject it`);
	}
});

/** Which protocol-error reason each X6 vector kind must produce. */
const X6_REASON: Record<string, string[]> = {
	malformedBody: ["malformedBody"],
	outOfTableHttpStatus: ["outOfTableHttpStatus"],
	httpStatusBodyMismatch: ["httpStatusBodyMismatch"],
	missingApiVersion: ["missingApiVersion"],
	verdictAlgebraViolation: ["verdictAlgebra", "failureCodeInvalid"],
	transportFailure: ["transportTimeout", "networkFailure"],
};

test("X6: every protocol vector lands in the protocol-error shell, with the right reason", () => {
	assert.ok(protocolVectors.length > 0);
	for (const vector of protocolVectors) {
		const routeParamId = vector.routeParamId ?? "";
		let state: PageState;
		if (vector.kind === "transportFailure") {
			state = transportFailureState(
				routeParamId,
				vector.simulate === "timeout" ? "timeout" : "networkFailure",
			);
		} else if (vector.kind === "malformedBody") {
			state = parseResolverResponse({
				routeParamId,
				httpStatus: 200,
				headers: {},
				raw: vector.rawBody ?? "",
			});
		} else {
			const wire = vector.wire;
			assert.ok(wire, `${vector.label}: expected a wire response`);
			state = parseResolverResponse({
				routeParamId,
				httpStatus: wire?.httpStatus ?? 0,
				headers: (wire?.headers ?? {}) as ResolverHeaders,
				raw: wire?.body == null ? null : JSON.stringify(wire.body),
			});
		}
		assert.equal(state.kind, "protocolError", `${vector.label}: ${vector.reason}`);
		if (state.kind !== "protocolError") continue;
		assert.ok(
			X6_REASON[vector.kind].includes(state.reason),
			`${vector.label}: reason "${state.reason}" is not one of ${X6_REASON[vector.kind].join("|")}`,
		);
	}
});

test("X6: the misplaced-failure-code vector is caught BY the placement rule", () => {
	// §4.1: "An unknown or misplaced code is a schema failure (R37)." The rule
	// must be reachable on its own, not merely shadowed by rule 1.
	const vector = protocolVectors.find((v) => v.label.includes("misplaced failure code"));
	assert.ok(vector?.wire, "the misplaced-code vector must exist");
	const state = parseResolverResponse({
		routeParamId: vector?.routeParamId ?? "",
		httpStatus: 200,
		headers: {},
		raw: JSON.stringify(vector?.wire?.body),
	});
	assert.equal(state.kind, "protocolError");
	if (state.kind !== "protocolError") return;
	assert.equal(state.reason, "failureCodeInvalid");
});

test("X7: every ID vector reaches the local invalid-ID state, or is a passing control", () => {
	for (const vector of idVectors) {
		const state = parseResolverResponse({
			routeParamId: vector.id,
			httpStatus: 503,
			headers: {},
			raw: '{"apiVersion":"1","status":"verificationUnavailable"}',
		});
		if (vector.expected === "invalid") {
			assert.equal(state.kind, "invalidId", `${vector.label}: ${vector.reason}`);
		} else {
			assert.notEqual(state.kind, "invalidId", `${vector.label}: must be accepted`);
		}
	}
});

// ===========================================================================
// §4.1 — the verdict algebra, rule by rule
// ===========================================================================

function baseVerification(): Verification {
	const passed: CheckEntry = { result: "passed" };
	return {
		trustSnapshotId: "usertrust-verify@2026-08-10T00:00:00Z",
		steps: {
			schema: { ...passed },
			event: { ...passed },
			registry: { ...passed },
			signature: { ...passed },
			inclusion: { ...passed },
			checkpoint: { ...passed },
			semantics: { ...passed },
			derivations: { ...passed },
			extensions: { ...passed },
		},
		checks: {
			registryBinding: { ...passed },
			predecessorLinkage: { result: "notApplicable" },
			checkpointHistory: { result: "notApplicable" },
			anchorEvidence: { result: "notApplicable" },
		},
	};
}

test("§4.1 rule 1: every mandatory step is disqualified by failed AND by not-run", () => {
	for (const step of [
		"schema",
		"event",
		"registry",
		"signature",
		"inclusion",
		"checkpoint",
		"semantics",
	] as const) {
		for (const result of ["failed", "unavailable", "notApplicable"] as const) {
			const verification = baseVerification();
			verification.steps[step] =
				result === "failed" ? { result, failure: "SCHEMA_INVALID" } : { result };
			// The failure code is only legal on `schema`; use the right one per step
			// so this test isolates rule 1 rather than the placement rule.
			if (result === "failed") {
				verification.steps[step] = {
					result,
					failure: (
						{
							schema: "SCHEMA_INVALID",
							event: "EVENT_MISMATCH",
							registry: "ID_MISMATCH",
							signature: "SIG_INVALID",
							inclusion: "PROOF_INVALID",
							checkpoint: "CHECKPOINT_INVALID",
							semantics: "SEMANTIC_INVALID",
						} as const
					)[step],
				};
			}
			const algebra = checkVerdictAlgebra("verified_checkpoint", verification);
			assert.equal(algebra.ok, false, `${step} = ${result} must disqualify a 200`);
		}
	}
});

test("§4.1 rule 2: derivations, registryBinding, predecessorLinkage, extensions", () => {
	// derivations: passed or notApplicable only.
	for (const result of ["passed", "notApplicable"] as const) {
		const verification = baseVerification();
		verification.steps.derivations = { result };
		assert.equal(checkVerdictAlgebra("verified_checkpoint", verification).ok, true, result);
	}
	for (const result of ["unavailable"] as const) {
		const verification = baseVerification();
		verification.steps.derivations = { result };
		assert.equal(checkVerdictAlgebra("verified_checkpoint", verification).ok, false, result);
	}

	// extensions (the step-9 summary) is upgrade-only — anything goes.
	for (const result of ["passed", "notApplicable", "unavailable"] as const) {
		const verification = baseVerification();
		verification.steps.extensions = { result };
		assert.equal(checkVerdictAlgebra("verified_checkpoint", verification).ok, true, result);
	}

	// registryBinding: `passed` REQUIRED on a resolver-issued 200 (v0.4).
	for (const result of ["failed", "unavailable", "notApplicable"] as const) {
		const verification = baseVerification();
		verification.checks.registryBinding =
			result === "failed" ? { result, failure: "ID_MISMATCH" } : { result };
		assert.equal(
			checkVerdictAlgebra("verified_checkpoint", verification).ok,
			false,
			`registryBinding = ${result} must be a protocol error on a 200`,
		);
	}

	// predecessorLinkage: passed / notApplicable / unavailable are all legal;
	// `failed` is a positive contradiction and is not.
	for (const result of ["passed", "notApplicable", "unavailable"] as const) {
		const verification = baseVerification();
		verification.checks.predecessorLinkage = { result };
		assert.equal(checkVerdictAlgebra("verified_checkpoint", verification).ok, true, result);
	}
	const contradicted = baseVerification();
	contradicted.checks.predecessorLinkage = { result: "failed", failure: "PREDECESSOR_MISMATCH" };
	assert.equal(checkVerdictAlgebra("verified_checkpoint", contradicted).ok, false);
});

test("§4.1 rule 3: the ladder is cumulative and each rung is capped by its extension", () => {
	const cases: [
		LadderStatus,
		"passed" | "failed" | "unavailable" | "notApplicable",
		"passed" | "failed" | "unavailable" | "notApplicable",
		boolean,
	][] = [
		["verified_checkpoint", "notApplicable", "notApplicable", true],
		["verified_checkpoint", "failed", "failed", true], // R10: extensions never demote
		["verified_checkpoint_history", "passed", "notApplicable", true],
		["verified_checkpoint_history", "unavailable", "notApplicable", false],
		["verified_checkpoint_history", "failed", "passed", false],
		["verified_anchored", "passed", "passed", true],
		["verified_anchored", "passed", "notApplicable", false],
		["verified_anchored", "notApplicable", "passed", false], // cumulative: history required too
	];
	for (const [status, history, anchor, expected] of cases) {
		const verification = baseVerification();
		verification.checks.checkpointHistory =
			history === "failed" ? { result: history, failure: "HISTORY_INVALID" } : { result: history };
		verification.checks.anchorEvidence =
			anchor === "failed" ? { result: anchor, failure: "ANCHOR_INVALID" } : { result: anchor };
		assert.equal(
			checkVerdictAlgebra(status, verification).ok,
			expected,
			`${status} with history=${history} anchor=${anchor}`,
		);
	}
});

test("§4.1: the failure-code union is closed, and each code is legal only on its own step", () => {
	// Correct placements pass.
	for (const [where, name, code] of [
		["steps", "schema", "SCHEMA_INVALID"],
		["steps", "event", "EVENT_MISMATCH"],
		["steps", "registry", "ID_MISMATCH"],
		["steps", "signature", "SIG_INVALID"],
		["steps", "inclusion", "PROOF_INVALID"],
		["steps", "checkpoint", "CHECKPOINT_INVALID"],
		["steps", "semantics", "SEMANTIC_INVALID"],
		["steps", "derivations", "DERIVATION_MISMATCH"],
		["checks", "registryBinding", "ID_MISMATCH"],
		["checks", "predecessorLinkage", "PREDECESSOR_MISMATCH"],
		["checks", "checkpointHistory", "HISTORY_INVALID"],
		["checks", "anchorEvidence", "ANCHOR_INVALID"],
	] as const) {
		const verification = baseVerification();
		// biome-ignore lint/suspicious/noExplicitAny: exhaustive table walk over two record shapes
		(verification[where] as any)[name] = { result: "failed", failure: code };
		assert.equal(
			checkFailureCodePlacement(verification).ok,
			true,
			`${where}.${name} must accept ${code}`,
		);
	}

	// PREDECESSOR_MISMATCH is legal ONLY on predecessorLinkage (receipt-spec v0.7).
	const misplacedPredecessor = baseVerification();
	misplacedPredecessor.checks.registryBinding = {
		result: "failed",
		failure: "PREDECESSOR_MISMATCH",
	};
	assert.equal(checkFailureCodePlacement(misplacedPredecessor).ok, false);

	// `extensions` is a summary and owns no code.
	const extensionsCode = baseVerification();
	extensionsCode.steps.extensions = { result: "failed", failure: "ANCHOR_INVALID" };
	assert.equal(checkFailureCodePlacement(extensionsCode).ok, false);

	// `failure` is present IFF the result is `failed`.
	const strayCode = baseVerification();
	strayCode.steps.schema = { result: "passed", failure: "SCHEMA_INVALID" };
	assert.equal(checkFailureCodePlacement(strayCode).ok, false);

	const missingCode = baseVerification();
	missingCode.steps.schema = { result: "failed" };
	assert.equal(checkFailureCodePlacement(missingCode).ok, false);
});

test("§4.1: a code outside the closed union is a schema failure, not a tolerated unknown", () => {
	const c1 = loadFixture<FixtureCase>("commit-checkpoint.json");
	const body = JSON.parse(JSON.stringify(c1.wire.body)) as Record<string, unknown>;
	const verification = (body.verification as { steps: Record<string, unknown> }).steps;
	verification.signature = { result: "failed", failure: "TOTALLY_NEW_CODE" };
	const state = parseResolverResponse({ ...toInput(c1), raw: JSON.stringify(body) });
	assert.equal(state.kind, "protocolError");
	if (state.kind !== "protocolError") return;
	assert.equal(state.reason, "schemaInvalid");
});

// ===========================================================================
// R37 — the fail-closed perimeter, beyond the vectors
// ===========================================================================

test("§4.1: an advisory of an UNKNOWN kind is carried through, never dropped, never verdict-affecting", () => {
	const c1 = loadFixture<FixtureCase>("commit-checkpoint.json");
	const body = JSON.parse(JSON.stringify(c1.wire.body)) as Record<string, unknown>;
	body.advisories = [{ kind: "somethingTheResolverLearnedLater", detail: "opaque" }];
	const state = parseResolverResponse({ ...toInput(c1), raw: JSON.stringify(body) });
	assert.equal(state.kind, "verified", "an unknown advisory kind must not alter the verdict");
	if (state.kind !== "verified") return;
	assert.equal(state.envelope.advisories.length, 1);
	assert.equal(state.envelope.advisories[0].kind, "somethingTheResolverLearnedLater");
});

test("D1: a response WITHOUT the opt-in checkpointHistory member still parses, capped at the rung below", () => {
	// `?include=checkpointHistory` is opt-in on the resolver; a response
	// lacking the member must parse, with the §4.1 cap rules treating it as
	// absent — fail-closed to the rung below, never a protocol error.
	const c2 = loadFixture<FixtureCase>("commit-history.json");
	const body = JSON.parse(JSON.stringify(c2.wire.body)) as Record<string, unknown>;
	delete body.checkpointHistory;
	const withMemberGone = parseResolverResponse({ ...toInput(c2), raw: JSON.stringify(body) });
	// The resolver still reported the check as passed, so the rung stands: the
	// member is EVIDENCE for rendering, the check result is what caps.
	assert.equal(withMemberGone.kind, "verified");

	// With the CHECK itself absent-equivalent (unavailable), the history rung
	// is above its cap and fails closed.
	const capped = JSON.parse(JSON.stringify(c2.wire.body)) as Record<string, unknown>;
	delete capped.checkpointHistory;
	(
		(capped.verification as Record<string, unknown>).checks as Record<string, unknown>
	).checkpointHistory = { result: "unavailable" };
	const state = parseResolverResponse({ ...toInput(c2), raw: JSON.stringify(capped) });
	assert.equal(state.kind, "protocolError");
	if (state.kind !== "protocolError") return;
	assert.equal(state.reason, "verdictAlgebra");
});

test("R37: unknown MEMBERS under apiVersion 1 are tolerated; unknown VERSIONS are not", () => {
	const c1 = loadFixture<FixtureCase>("commit-checkpoint.json");
	const grown = JSON.parse(JSON.stringify(c1.wire.body)) as Record<string, unknown>;
	grown.someFutureMember = { anything: [1, 2, 3] };
	(grown.verification as Record<string, unknown>).futureSummary = "tolerated";
	const tolerated = parseResolverResponse({ ...toInput(c1), raw: JSON.stringify(grown) });
	assert.equal(tolerated.kind, "verified", "the envelope may grow WITHIN a version");

	const future = JSON.parse(JSON.stringify(c1.wire.body)) as Record<string, unknown>;
	future.apiVersion = "1.1";
	const rejected = parseResolverResponse({ ...toInput(c1), raw: JSON.stringify(future) });
	assert.equal(rejected.kind, "protocolError");
});

test("R37: every out-of-table HTTP code fails closed, whatever the body says", () => {
	const c1 = loadFixture<FixtureCase>("commit-checkpoint.json");
	for (const httpStatus of [201, 301, 400, 401, 403, 418, 500, 502, 504]) {
		const state = parseResolverResponse({ ...toInput(c1), httpStatus });
		assert.equal(state.kind, "protocolError", `HTTP ${httpStatus}`);
		if (state.kind !== "protocolError") continue;
		assert.equal(state.reason, "outOfTableHttpStatus");
	}
});

test("R37: an HTTP code and a body status that disagree never render either one", () => {
	const c1 = loadFixture<FixtureCase>("commit-checkpoint.json");
	for (const httpStatus of [202, 404, 409, 410, 503]) {
		const state = parseResolverResponse({ ...toInput(c1), httpStatus });
		assert.equal(state.kind, "protocolError", `200 body under HTTP ${httpStatus}`);
		if (state.kind !== "protocolError") continue;
		assert.equal(state.reason, "httpStatusBodyMismatch");
	}
});

test("R37: a 200 missing a required §4.1 member is a schema failure, never a partial render", () => {
	const c1 = loadFixture<FixtureCase>("commit-checkpoint.json");
	for (const member of ["receiptBytes", "receipt", "verification", "advisories"]) {
		const body = JSON.parse(JSON.stringify(c1.wire.body)) as Record<string, unknown>;
		delete body[member];
		const state = parseResolverResponse({ ...toInput(c1), raw: JSON.stringify(body) });
		assert.equal(state.kind, "protocolError", `missing ${member}`);
		if (state.kind !== "protocolError") continue;
		assert.equal(state.reason, "schemaInvalid");
	}
});

test("R37: the protocol-error shell and the 503 state are never the same state", () => {
	const timeout = transportFailureState("ut1_Ly6eTFZPxTsdg1JgGyiY9b", "timeout");
	const network = transportFailureState("ut1_Ly6eTFZPxTsdg1JgGyiY9b", "networkFailure");
	assert.equal(timeout.kind, "protocolError");
	assert.equal(network.kind, "protocolError");
	assert.notEqual(timeout.reason, network.reason);
	assert.notEqual(parseFixture("verification-unavailable.json").kind, "protocolError");
});

test("R37: a duplicate key in the ENVELOPE fails closed too", () => {
	const c1 = loadFixture<FixtureCase>("commit-checkpoint.json");
	const raw = JSON.stringify(c1.wire.body);
	const duplicated = `{"status":"verified_anchored",${raw.slice(1)}`;
	const state = parseResolverResponse({ ...toInput(c1), raw: duplicated });
	assert.equal(state.kind, "protocolError");
	if (state.kind !== "protocolError") return;
	assert.equal(state.reason, "malformedBody");
});

// ===========================================================================
// The strict reader and the R4 primitives, directly
// ===========================================================================

test("R4 stage 1: the base64 decoder is canonical, not lenient", () => {
	assert.equal(decodeReceiptBytes("aGk=").ok, true);
	for (const bad of [
		"aGk", // length not a multiple of 4
		"a Gk=", // whitespace is not in the alphabet
		"a_k=", // URL-safe alphabet is not the standard alphabet
		"aGk==", // over-padded
		"a==k", // padding before the final quantum
		"aH==", // trailing bits of the final quantum are non-zero
	]) {
		const result = decodeReceiptBytes(bad);
		assert.equal(result.ok, false, `"${bad}" must be rejected`);
		if (!result.ok) assert.equal(result.stage, "base64");
	}
});

test("R4 stage 2: UTF-8 decoding is FATAL — no replacement characters", () => {
	// 0x80 is a bare continuation byte: invalid UTF-8, silently replaced by
	// U+FFFD under a non-fatal decoder.
	const result = decodeReceiptBytes("gA==");
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.stage, "utf8");
});

test("R4 stage 3: duplicate keys are rejected BEFORE object construction", () => {
	const duplicate = strictParseJson('{"a":1,"a":1}', { frozenNumericRules: true });
	assert.equal(duplicate.ok, false);
	if (!duplicate.ok) assert.equal(duplicate.stage, "duplicateKey");
	// The reason a post-parse check cannot work: the last value silently wins
	// and the parsed object is indistinguishable from the honest one.
	assert.deepEqual(JSON.parse('{"a":1,"a":1}'), { a: 1 });
	// Rejected in BOTH modes — this rule is not about the numeric appendix.
	assert.equal(strictParseJson('{"a":1,"a":2}', { frozenNumericRules: false }).ok, false);
});

test("R4 stage 4: the frozen numeric rules are applied to the LITERAL, not the parsed value", () => {
	// V8 rounds 2^53+1 during parsing, so the literal is GONE by the time any
	// post-parse check could look at it — the bytes the CLI hashes and the
	// number a lenient consumer sees are two different things.
	assert.equal(JSON.parse('{"n":9007199254740993}').n, 9007199254740992);

	for (const literal of ["9007199254740993", "-0", "1e400", "-0.0", "1.5"]) {
		const result = strictParseJson(`{"n":${literal}}`, { frozenNumericRules: true });
		assert.equal(result.ok, false, literal);
		if (!result.ok) assert.equal(result.stage, "numeric", literal);
	}

	// The unsigned envelope is not the signed artifact and is not bound by the
	// canonicalization appendix; only what JSON cannot express is refused.
	assert.equal(strictParseJson('{"n":1.5}', { frozenNumericRules: false }).ok, true);
	assert.equal(strictParseJson('{"n":9007199254740993}', { frozenNumericRules: false }).ok, true);
	assert.equal(strictParseJson('{"n":1e400}', { frozenNumericRules: false }).ok, false);
});

test("R4 stage 5: key order is immaterial, key PRESENCE is not (absent != null)", () => {
	assert.equal(structurallyEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
	assert.equal(structurallyEqual({ a: null }, {}), false);
	assert.equal(structurallyEqual({}, { a: null }), false);
	assert.equal(structurallyEqual([1, 2], [2, 1]), false);
	assert.equal(structurallyEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] }), true);
	assert.equal(structurallyEqual(1, "1"), false);
});

test("R4: reordering the keys of receiptBytes still agrees with `receipt`", () => {
	// The §5 signature preimage is canonical, not lexical — a byte-different
	// but structurally identical payload must still pass stage 5.
	const c1 = loadFixture<FixtureCase>("commit-checkpoint.json");
	const body = c1.wire.body as unknown as SuccessEnvelope;
	const decoded = decodeReceiptBytes(body.receiptBytes);
	assert.ok(decoded.ok);
	if (!decoded.ok) return;
	const parsed = JSON.parse(decoded.text) as Record<string, unknown>;
	const reordered = Object.fromEntries(Object.entries(parsed).reverse());
	const reencoded = Buffer.from(JSON.stringify(reordered), "utf-8").toString("base64");
	assert.equal(checkReceiptBytesAgreement(reencoded, body.receipt).ok, true);
});

test("R4: a single flipped byte inside receiptBytes fails at the comparison stage", () => {
	const c1 = loadFixture<FixtureCase>("commit-checkpoint.json");
	const body = c1.wire.body as unknown as SuccessEnvelope;
	const decoded = decodeReceiptBytes(body.receiptBytes);
	assert.ok(decoded.ok);
	if (!decoded.ok) return;
	const tampered = decoded.text.replace('"scope":"session"', '"scope":"sessioN"');
	assert.notEqual(tampered, decoded.text, "the tamper must actually change the text");
	const result = checkReceiptBytesAgreement(
		Buffer.from(tampered, "utf-8").toString("base64"),
		body.receipt,
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.stage, "comparison");
});

// ===========================================================================
// Headers
// ===========================================================================

test("headers: lookup is case-insensitive and accepts a Headers instance", () => {
	const routeParamId = loadFixture<FixtureCase>("rate-limited.json").routeParamId;
	const fromBag = parseResolverResponse({
		routeParamId,
		httpStatus: 429,
		headers: { "Retry-After": "120" },
		raw: null,
	});
	assert.equal(fromBag.kind, "rateLimited");
	if (fromBag.kind === "rateLimited") assert.equal(fromBag.retryAfter?.seconds, 120);

	const fromHeaders = parseResolverResponse({
		routeParamId,
		httpStatus: 429,
		headers: new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
		raw: null,
	});
	assert.equal(fromHeaders.kind, "rateLimited");
	if (fromHeaders.kind === "rateLimited") {
		// A date form has no delta-seconds — the raw value is still carried.
		assert.equal(fromHeaders.retryAfter?.seconds, undefined);
		assert.match(fromHeaders.retryAfter?.raw ?? "", /GMT$/);
	}
});

// ===========================================================================
// Manifest coverage — the matrix is walked, not sampled
// ===========================================================================

test("coverage: every conforming fixture file has a declared expected state", () => {
	const declared = new Set(Object.keys(EXPECTED_STATE));
	for (const entry of conformingFixtures) {
		for (const file of entry.files) {
			assert.ok(declared.has(file), `${entry.id}: ${file} has no expected state`);
		}
	}
	assert.equal(
		declared.size,
		conformingFixtures.reduce((sum, entry) => sum + entry.files.length, 0),
		"no stale expectations",
	);
});

test("coverage: no conforming fixture reaches a fail-closed state", () => {
	for (const entry of conformingFixtures) {
		for (const file of entry.files) {
			const state = parseFixture(file);
			assert.notEqual(state.kind, "protocolError", `${entry.id} (${file}) must not fail closed`);
			assert.notEqual(state.kind, "invalidId", `${entry.id} (${file}) must have a valid route ID`);
			if (file === "unverifiable.json") continue; // C25 IS the integrity state
			assert.notEqual(
				state.kind,
				"integrityFailure",
				`${entry.id} (${file}) must not read as an integrity failure`,
			);
		}
	}
});

test("coverage: no rejection vector ever reaches a green state", () => {
	const greenKinds = new Set<PageState["kind"]>(["verified"]);
	for (const entry of rejectionVectors) {
		if (entry.kind !== "json") continue;
		for (const file of entry.files) {
			const fixture = loadFixture<FixtureCase>(file);
			const state = parseResolverResponse(toInput(fixture));
			assert.equal(
				greenKinds.has(state.kind),
				false,
				`${entry.id} (${file}) reached ${state.kind}`,
			);
		}
	}
	for (const vector of protocolVectors) {
		if (!vector.wire) continue;
		const state = parseResolverResponse({
			routeParamId: vector.routeParamId ?? "",
			httpStatus: vector.wire.httpStatus,
			headers: vector.wire.headers as ResolverHeaders,
			raw: vector.wire.body == null ? null : JSON.stringify(vector.wire.body),
		});
		assert.equal(greenKinds.has(state.kind), false, `${vector.label} reached ${state.kind}`);
	}
});

test("linkage: a billedUnfinalized bundle whose linked side is not a verified receipt fails", () => {
	const bundle = parseFixture("billed-unfinalized.json") as BilledUnfinalizedState;
	assert.equal(bundle.kind, "billedUnfinalized");
	for (const linkedFile of ["unknown.json", "unverifiable.json", "reserved.json"]) {
		const linked = parseFixture(linkedFile);
		const checked = verifyBilledUnfinalizedLinkage(bundle, linked);
		assert.equal(
			checked.kind,
			"integrityFailure",
			`${linkedFile}: a non-verified linked side can never satisfy R3`,
		);
	}
});
