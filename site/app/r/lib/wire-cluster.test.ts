/**
 * Tests for the wire module's CLUSTER receipt path (receipt-spec v0.10 §15):
 * the closed `scope: "cluster"` schema, the cluster half of the §4.1
 * predecessor algebra, and the `scope` discriminant on a verified state.
 *
 * The contract is two-sided, as in `wire.test.ts`:
 *   - every conforming cluster fixture (CL1-CL4), and every BOUNDARY control
 *     in `fixtures/cluster-vectors.ts`, must reach a verified CLUSTER state;
 *   - every rejection vector there must fail CLOSED into exactly its named
 *     state — the protocol-error shell or an integrity failure on a named
 *     obligation — refused by its own rule rather than an earlier one.
 *
 * `fixtures/conformance.test.ts` walks the same fixtures and vectors with its
 * OWN implementation of the cluster contract. This file proves the PAGE's
 * implementation agrees with it; neither imports the other, because two
 * implementations landing on the same verdicts is the point.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fixtureState,
	loadFixture,
	verifiedClusterFixtureState,
	verifiedFixtureState,
} from "../fixture-harness";
import {
	applyClusterVector,
	CONTRACT_SKIP_REASONS,
	clusterVectors,
} from "../fixtures/cluster-vectors";
import { clusterConformingFixtures, conformingFixtures } from "../fixtures/index";
import type { ClusterSuccessEnvelope as FixtureClusterSuccessEnvelope } from "../fixtures/types";
import {
	type ClusterProjection,
	type ClusterSuccessEnvelope,
	checkClusterPredecessorLinkage,
	type PageState,
	parseResolverResponse,
	SKIP_REASONS,
	type StepResult,
	type Verification,
	validateAccountHandle,
	validateReceiptId,
	verifyBilledUnfinalizedLinkage,
} from "./wire";

/**
 * The fixture transcription of §15 and this module's are separate files that
 * are NOT allowed to drift: a fixture cluster envelope must be consumable as a
 * wire cluster envelope, or this stops compiling.
 */
const _fixtureClusterEnvelopeIsWireEnvelope: (
	e: FixtureClusterSuccessEnvelope,
) => ClusterSuccessEnvelope = (e) => e;
void _fixtureClusterEnvelopeIsWireEnvelope;

type Bag = Record<string, unknown>;

/**
 * A fixture whose SIGNED receipt is mutated, with `receiptBytes` re-encoded so
 * R4 still agrees — otherwise the byte check would catch the mutation first
 * and the schema path would never be exercised.
 */
function mutateSigned(file: string, mutate: (receipt: Bag) => void): PageState {
	const fixture = loadFixture(file);
	const body = structuredClone(fixture.wire.body) as Bag;
	mutate(body.receipt as Bag);
	body.receiptBytes = Buffer.from(JSON.stringify(body.receipt), "utf8").toString("base64");
	return fixtureState({ ...fixture, wire: { ...fixture.wire, body } });
}

function describe(state: PageState): string {
	if (state.kind === "protocolError") return `protocolError/${state.reason}: ${state.detail}`;
	if (state.kind === "integrityFailure") {
		return state.cause.source === "page"
			? `integrityFailure/${state.cause.obligation}: ${state.cause.detail}`
			: "integrityFailure/resolver";
	}
	return state.kind === "verified" ? `verified/${state.scope}` : state.kind;
}

// ===========================================================================
// The four conforming cluster fixtures
// ===========================================================================

for (const entry of clusterConformingFixtures) {
	test(`${entry.id} (${entry.files.join(", ")}): verifies as a CLUSTER receipt`, () => {
		for (const file of entry.files) {
			const fixture = loadFixture(file);
			const state = fixtureState(fixture);
			assert.equal(state.kind, "verified", `${file}: ${describe(state)}`);
			if (state.kind !== "verified") continue;
			assert.equal(state.scope, "cluster", `${file}: the renderer's dispatch key`);
			if (state.scope !== "cluster") continue;
			assert.equal(state.rung, "verified_checkpoint");
			assert.equal(state.receiptId, fixture.routeParamId);
			assert.equal(state.envelope.receipt.receiptId, fixture.routeParamId);
			assert.ok(state.receiptBytesText.length > 0, `${file}: decoded bytes must be carried`);
			const served = fixture.wire.body as FixtureClusterSuccessEnvelope;
			assert.equal(state.envelope.receipt.event.data.account, served.receipt.event.data.account);
			// The test harness hands renderers the very same state.
			assert.deepEqual(verifiedClusterFixtureState(file), state);
		}
	});
}

test('every verified SESSION conforming fixture carries scope "session"', () => {
	let verified = 0;
	for (const entry of conformingFixtures) {
		for (const file of entry.files) {
			const state = fixtureState(loadFixture(file));
			if (state.kind !== "verified") continue;
			verified += 1;
			assert.equal(state.scope, "session", `${entry.id} (${file})`);
		}
	}
	// C1-C18 and C28/C29: every session 200 in the corpus, none skipped.
	assert.equal(verified, 20);
});

// ===========================================================================
// The cluster vectors — each one EXACTLY in its named state
// ===========================================================================

test("every cluster vector lands EXACTLY in its expected state, refused by its own rule", () => {
	for (const vector of clusterVectors) {
		const applied = applyClusterVector(vector);
		const state = parseResolverResponse({
			routeParamId: applied.routeParamId,
			httpStatus: applied.httpStatus,
			headers: applied.headers,
			raw: JSON.stringify(applied.body),
		});
		const { expect } = vector;
		const where = `${vector.label} — ${vector.rule} (got ${describe(state)})`;
		if (expect.kind === "verified") {
			assert.equal(state.kind, "verified", where);
			if (state.kind === "verified") assert.equal(state.scope, "cluster", where);
			continue;
		}
		if (expect.kind === "protocolError") {
			assert.equal(state.kind, "protocolError", where);
			if (state.kind !== "protocolError") continue;
			assert.equal(state.reason, expect.reason, where);
			if (vector.detail) assert.match(state.detail, vector.detail, where);
			continue;
		}
		assert.equal(state.kind, "integrityFailure", where);
		if (state.kind !== "integrityFailure") continue;
		assert.equal(state.cause.source, "page", where);
		if (state.cause.source !== "page") continue;
		assert.equal(state.cause.obligation, expect.obligation, where);
		if (vector.detail) assert.match(state.cause.detail, vector.detail, where);
	}
});

test("every rejection vector names the refusal it must produce", () => {
	// A rejection vector with no `detail` could be refused by ANY earlier rule
	// it trips by accident and still pass the test above.
	const unguarded = clusterVectors
		.filter((vector) => vector.expect.kind !== "verified" && vector.detail === undefined)
		.map((vector) => vector.label);
	assert.deepEqual(unguarded, []);
});

// ===========================================================================
// The pieces, directly
// ===========================================================================

test("validateAccountHandle: an a1_ prefix, then §12's 16-byte canonical decode", () => {
	for (const handle of [
		"a1_LaVASNboDGARWVkgiqzrkF", // receipt-spec v0.10 §15.15, ledger account 42
		"a1_4HsRUMjopC7DXxL78ne2uk", // ...and ledger account 43
		"a1_8AQGAut7N92awznwCnjuR", // a 21-character body
		"a1_15N8qDPFqHWMuQYbLSJuSR", // a leading zero byte, as a canonical leading '1'
	]) {
		assert.deepEqual(validateAccountHandle(handle), { valid: true }, handle);
	}
	const grammar = /^does not match the "a1_" \+ 16-22 base58 \(Bitcoin alphabet\) grammar$/;
	const seventeenBytes = /^decodes to 17 bytes, not exactly 16$/;
	for (const [handle, reason] of [
		["0000000000000000000000000000002a", grammar], // a raw ledger ID
		["ut1_6UxMu41H9LYXJYXV2CEfoK", grammar], // a receipt ID
		["a1_111ZNfp3ndcZGxiLV6r6TS", seventeenBytes],
		["a1_18AQGAut7N92awznwCnjuR", seventeenBytes], // a leading '1' added to a canonical body
		["a1_LaVASNboDGARWVkgiqzrk0", grammar], // '0' is outside base58
	] as const) {
		const result = validateAccountHandle(handle);
		assert.equal(result.valid, false, handle);
		if (!result.valid) assert.match(result.reason, reason, handle);
	}
	// One prefix never passes for the other: a handle is not a receipt ID.
	assert.equal(validateReceiptId("a1_LaVASNboDGARWVkgiqzrkF").valid, false);
});

test("checkClusterPredecessorLinkage: a named predecessor must be passed; none named, passed or notApplicable", () => {
	const chained = verifiedClusterFixtureState("cluster/chained.json").envelope;
	const named: ClusterProjection = chained.receipt.event.data;
	const unnamed: ClusterProjection = structuredClone(named);
	delete unnamed.previousReceiptId;
	const legal = new Set(["named/passed", "unnamed/passed", "unnamed/notApplicable"]);
	for (const [label, projection] of [
		["named", named],
		["unnamed", unnamed],
	] as const) {
		for (const result of ["passed", "failed", "notApplicable", "unavailable"] as StepResult[]) {
			const verification: Verification = structuredClone(chained.verification);
			verification.checks.predecessorLinkage =
				result === "failed" ? { result, failure: "PREDECESSOR_MISMATCH" } : { result };
			// `failed` never reaches this check on a 200 — checkVerdictAlgebra
			// refuses it first — but on its own the function must still say no.
			assert.equal(
				checkClusterPredecessorLinkage(verification, projection).ok,
				legal.has(`${label}/${result}`),
				`${label} × ${result}`,
			);
		}
	}
});

test("SKIP_REASONS: exactly the contract's 23, unique, in the contract's order", () => {
	assert.equal(SKIP_REASONS.length, 23);
	assert.equal(new Set(SKIP_REASONS).size, 23);
	assert.deepEqual([...SKIP_REASONS], [...CONTRACT_SKIP_REASONS]);
});

test("R3: a cluster receipt is never the billedUnfinalized fallback variant", () => {
	const bundle = fixtureState(loadFixture("billed-unfinalized.json"));
	assert.equal(bundle.kind, "billedUnfinalized");
	if (bundle.kind !== "billedUnfinalized") return;
	for (const entry of clusterConformingFixtures) {
		for (const file of entry.files) {
			const linked = verifiedClusterFixtureState(file);
			// As served, the bundle names a different receipt...
			const asServed = verifyBilledUnfinalizedLinkage(bundle, linked);
			assert.equal(asServed.kind, "integrityFailure", file);
			// ...and re-pointed at this one, the cluster work still has no origin:
			// the linkage fails on the fallback-variant equality itself.
			const repointed = verifyBilledUnfinalizedLinkage(
				{ ...bundle, linkedReceiptId: linked.receiptId },
				linked,
			);
			assert.equal(repointed.kind, "integrityFailure", file);
			if (repointed.kind !== "integrityFailure") continue;
			assert.ok(repointed.cause.source === "page" && repointed.cause.obligation === "R3", file);
			if (repointed.cause.source === "page" && repointed.cause.obligation === "R3") {
				assert.equal(repointed.cause.brokenEquality, "sourceReservationId", file);
				assert.match(repointed.cause.detail, /not the fallback variant/, file);
			}
		}
	}
});

// ===========================================================================
// The session path, unchanged
// ===========================================================================

test("session unchanged: an unknown document scope is refused, naming both scopes", () => {
	const state = mutateSigned("session-owner-estimated.json", (receipt) => {
		receipt.scope = "cluster-ish";
	});
	assert.equal(state.kind, "protocolError");
	if (state.kind !== "protocolError") return;
	assert.equal(state.reason, "schemaInvalid");
	assert.match(state.detail, /^body\.receipt\.scope must be "session" or "cluster"$/);
});

test("cross-scope: a real SESSION receipt carrying cluster work, or a cluster projection scope, is refused", () => {
	const clusterWork = { kind: "cluster", repoId: "github.com:R_kgDOK1x2Yw" };
	const withClusterWork = mutateSigned("session-owner-estimated.json", (receipt) => {
		receipt.work = structuredClone(clusterWork);
		((receipt.event as Bag).data as Bag).work = structuredClone(clusterWork);
	});
	assert.equal(withClusterWork.kind, "protocolError");
	if (withClusterWork.kind === "protocolError") {
		assert.equal(withClusterWork.reason, "schemaInvalid");
		assert.match(
			withClusterWork.detail,
			/^body\.receipt\.work\.kind must be commit\|pr\|issue\|session$/,
		);
	}
	const withClusterScope = mutateSigned("session-owner-estimated.json", (receipt) => {
		((receipt.event as Bag).data as Bag).scope = "cluster";
	});
	assert.equal(withClusterScope.kind, "protocolError");
	if (withClusterScope.kind === "protocolError") {
		assert.equal(withClusterScope.reason, "schemaInvalid");
		assert.match(withClusterScope.detail, /^body\.receipt\.event\.data\.scope must be "session"$/);
	}
});

test("session unchanged: predecessorLinkage unavailable still verifies a SESSION 200", () => {
	// The cluster half of rule 2 binds cluster receipts only. A session receipt
	// keeps §4.1's own rule, where `unavailable` is legal.
	const fixture = loadFixture("commit-checkpoint.json");
	const body = structuredClone(fixture.wire.body) as Bag;
	((body.verification as Bag).checks as Bag).predecessorLinkage = { result: "unavailable" };
	const state = fixtureState({ ...fixture, wire: { ...fixture.wire, body } });
	assert.equal(state.kind, "verified", describe(state));
	if (state.kind === "verified") assert.equal(state.scope, "session");
});

test("fixture-harness: each verified-state helper refuses the other scope", () => {
	assert.throws(
		() => verifiedFixtureState("cluster/first.json"),
		/did not resolve to a verified session receipt \(got a verified cluster receipt\)/,
	);
	assert.throws(
		() => verifiedClusterFixtureState("session-owner-estimated.json"),
		/did not resolve to a verified cluster receipt \(got a verified session receipt\)/,
	);
	assert.throws(
		() => verifiedClusterFixtureState("unknown.json"),
		/did not resolve to a verified cluster receipt \(got "unknownReceipt"\)/,
	);
});
