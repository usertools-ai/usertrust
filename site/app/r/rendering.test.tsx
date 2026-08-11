/**
 * §8's rendering contract: EVERY conforming fixture renders, and each one is
 * asserted against the DISTINCT obligation its §8.1 row names.
 *
 * The fixtures are driven through the real parser (`fixture-harness.ts` →
 * `parseResolverResponse`), never through hand-built props, so a fixture that
 * would fail R1/R4/the §4.1 verdict algebra can never reach a component here.
 * What each test then asserts is the row's own text from `fixtures/index.ts`,
 * turned into an assertion — "copy that the spec mandates is test-pinned so a
 * redesign cannot silently drop a disclaimer" (§8).
 *
 * Scope: the VERIFIED rungs (§8.1 C1-C18). C19-C27 are the non-green states,
 * which belong to the states pass — this file asserts only that they never
 * reach the verified renderer, which is the fail-closed half of the contract
 * this task owns.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import VerifiedReceipt from "./components/verified-receipt";
import {
	conformingVerifiedRows,
	fixtureState,
	loadFixture,
	verifiedFixtureState,
} from "./fixture-harness";
import {
	ANCHOR_EXTERNAL_VISIBILITY,
	CUSTOM_MODEL_MEANING,
	DISPLAY_ANNEX_LABEL,
	EQUIVOCATION_CAVEAT,
	ESTIMATES_NOT_UPPER_BOUND,
	EXECUTION_METADATA_NOTE,
	FORK_DISCLAIMER,
	MEMBERSHIP_EPISTEMIC_SCOPE,
	MINTED_AT_LABEL,
	NEVER_ARTIFACT_VERIFIED,
	NOT_APPLICABLE_MEANING,
	POSTURES_ARE_ATTESTED_ENUMS,
	PRICING_TABLES_NOTE,
	RECOMPUTE_IS_RESOLVER_ONLINE_CHECK,
	S3_OPERATOR_ASSERTED,
	SESSION_NON_ARTIFACT,
	SESSION_PROMOTION_GATE,
	TRANSFER_SET_ROOT_COMMITMENT,
	trustSnapshotLine,
	UNAVAILABLE_MEANING,
	UNDISCLOSED_PRIVATE_REPO,
} from "./lib/claims";
import type { VerifiedState } from "./lib/wire";

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function render(state: VerifiedState): string {
	return renderToStaticMarkup(<VerifiedReceipt state={state} />);
}

/**
 * The rendered TEXT, entities decoded and tags removed. Assertions run against
 * this rather than the raw markup so a mandated sentence containing an
 * apostrophe or a quote (`&#x27;`, `&quot;`) is matched as the reader sees it,
 * not as React escaped it.
 */
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

function renderFixture(file: string): { html: string; text: string; state: VerifiedState } {
	const state = verifiedFixtureState(file);
	const html = render(state);
	return { html, text: textOf(html), state };
}

function assertContains(text: string, needle: string, why: string): void {
	assert.ok(text.includes(needle), `${why}\n  missing: ${needle}`);
}

function assertOmits(text: string, needle: string, why: string): void {
	assert.ok(!text.includes(needle), `${why}\n  unexpectedly present: ${needle}`);
}

// ---------------------------------------------------------------------------
// Invariants that hold on EVERY verified fixture
// ---------------------------------------------------------------------------

test("§8.1: every conforming 200 fixture renders, and the set is the expected one", () => {
	const rows = conformingVerifiedRows();
	assert.deepEqual(
		rows.map((row) => row.id),
		[
			"C1",
			"C2",
			"C3",
			"C4",
			"C5",
			"C6",
			"C7",
			"C8",
			"C9",
			"C10",
			"C11",
			"C12",
			"C13",
			"C14",
			"C15",
			"C16",
			"C17",
			"C18",
		],
	);
	for (const row of rows) {
		const html = render(verifiedFixtureState(row.file));
		assert.ok(html.length > 0, `${row.id} (${row.file}) rendered nothing`);
	}
});

test("R5/R6: every verified render shows its rung word, all three rungs, and the fork disclaimer", () => {
	for (const row of conformingVerifiedRows()) {
		const { html, text, state } = renderFixture(row.file);
		const word =
			state.rung === "verified_anchored"
				? "VERIFIED — ANCHORED"
				: state.rung === "verified_checkpoint_history"
					? "VERIFIED — CHECKPOINT HISTORY"
					: "VERIFIED — CHECKPOINT";
		assertContains(text, word, `${row.id}: the verdict WORD is the verdict (§6.1)`);
		// R5 — which rungs exist ABOVE is part of the verdict.
		for (const rung of [
			"verified_checkpoint",
			"verified_checkpoint_history",
			"verified_anchored",
		]) {
			assert.ok(
				html.includes(`data-rung="${rung}"`),
				`${row.id}: rung ${rung} missing from ladder`,
			);
		}
		assertContains(text, FORK_DISCLAIMER, `${row.id}: R6's disclaimer is carried at every rung`);
	}
});

test("R13: no verified render ever says 'this artifact is verified'", () => {
	for (const row of conformingVerifiedRows()) {
		const { text } = renderFixture(row.file);
		// The ONE licensed occurrence is the disclaimer that QUOTES the forbidden
		// phrase in order to disown it (R13's own sentence). Strip that sentence
		// first, then assert the phrase appears nowhere else — otherwise this test
		// would be satisfied by its own escape hatch.
		assertContains(text, NEVER_ARTIFACT_VERIFIED, `${row.id}: R13's scoping sentence renders`);
		const withoutDisclaimer = text.split(NEVER_ARTIFACT_VERIFIED).join(" ");
		assertOmits(
			withoutDisclaimer,
			"this artifact is verified",
			`${row.id}: the page has no containing artifact`,
		);
	}
});

test("R9: every verified render carries the full ledger and names its trust snapshot", () => {
	const names = [
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
	];
	for (const row of conformingVerifiedRows()) {
		const { html, text, state } = renderFixture(row.file);
		for (const name of names) {
			assert.ok(html.includes(`data-check="${name}"`), `${row.id}: ledger row ${name} missing`);
		}
		assertContains(
			text,
			trustSnapshotLine(state.envelope.verification.trustSnapshotId),
			`${row.id}: R9's trust-snapshot footer`,
		);
	}
});

test("§6: nothing renders below the 12px type floor", () => {
	// The floor is enforced in the class names themselves — there is no browser
	// here to measure, and an arbitrary-value class is the only way a smaller
	// size could enter (Tailwind's own `text-xs` IS 12px).
	for (const row of conformingVerifiedRows()) {
		const { html } = renderFixture(row.file);
		const sizes = [...html.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1]));
		for (const size of sizes) {
			assert.ok(size >= 12, `${row.id}: rendered a ${size}px type size, below the 12px floor`);
		}
		assert.ok(!/\btext-\[?(?:2xs|10px|11px)\]?\b/.test(html), `${row.id}: sub-12px utility class`);
	}
});

test("R20/§6a: the two sessionAssociation postures never render identically", () => {
	// The pairing §8's C9/C17 rows exist to catch, asserted as a SET property
	// rather than one fixture at a time.
	const attested = renderFixture("commit-checkpoint.json").html;
	const asserted = renderFixture("commit-owner-asserted.json").html;
	assert.ok(attested.includes('data-posture="workflowAttested"'));
	assert.ok(asserted.includes('data-posture="ownerAsserted"'));
	assert.notEqual(
		attested.match(/data-posture-role="session association"[\s\S]{0,600}/)?.[0],
		asserted.match(/data-posture-role="session association"[\s\S]{0,600}/)?.[0],
		"identical rendering is forbidden (§6a)",
	);
});

test("R28: the display annex renders IFF the envelope served a display member", () => {
	for (const row of conformingVerifiedRows()) {
		const { html, text, state } = renderFixture(row.file);
		const served = state.envelope.display !== undefined;
		assert.equal(
			html.includes('data-testid="display-annex"'),
			served,
			`${row.id}: display annex presence must track the display member`,
		);
		if (served) assertContains(text, DISPLAY_ANNEX_LABEL, `${row.id}: R28's explicit label`);
	}
});

// ---------------------------------------------------------------------------
// C1-C18 — one test per §8.1 row, asserting THAT row's obligation
// ---------------------------------------------------------------------------

test("C1 commit-checkpoint.json — floor rung, provider posture, attested workload, display annex", () => {
	const { html, text } = renderFixture("commit-checkpoint.json");

	// commit kind + floor rung + R6.
	assertContains(text, "VERIFIED — CHECKPOINT", "C1 is the floor rung");
	assertContains(
		text,
		"attests commit 12283b89ad55b584c7959394a527e24da0ec1f5e in github.com:R_kgDOK1x2Yw",
		"R13's commit headline",
	);
	assertContains(text, FORK_DISCLAIMER, "R6, verbatim");

	// `provider` posture — the SCOPED claim, never the retired unconditional one.
	assert.ok(html.includes('data-posture="provider"'));
	assertContains(
		text,
		"never understates the ledger-POSTed cost of this governed session",
		"R21's scoped provider claim",
	);
	assertOmits(text, ESTIMATES_NOT_UPPER_BOUND, "provider posture carries no estimate caveat");

	// workflowAttested + workloadId.
	assert.ok(html.includes('data-posture="workflowAttested"'));
	assertContains(text, "8997b6e67f96b15ccbc66b6f", "the attested workloadId renders");

	// public repo — the disclosed name renders AND the repoId is still the scope.
	assertContains(text, "github.com/usertrust-ai/usertrust", "R18: disclosed display name");
	assert.ok(html.includes('data-repo-label="disclosed"'));

	// transferSet PRESENT → the root is a recomputable digest, not a commitment.
	assert.ok(html.includes('data-transfer-set="list"'));
	assertOmits(text, TRANSFER_SET_ROOT_COMMITMENT, "R25: a present list is not a commitment");

	// R9 — trustSnapshotId rendered.
	assertContains(
		text,
		trustSnapshotLine("usertrust-verify@2026-08-10T00:00:00Z"),
		"R9's trust snapshot",
	);

	// R12 — predecessorLinkage n/a rendered as n/a, NOT as a tick.
	const predecessorRow = html.match(/data-check="predecessorLinkage"[\s\S]*?<\/tr>/)?.[0] ?? "";
	assert.ok(predecessorRow.includes('data-result="notApplicable"'));
	assert.ok(predecessorRow.includes("N/A"));
	assert.ok(!predecessorRow.includes("✓"), "R12: n/a is never drawn as a green tick");
	assertContains(text, NOT_APPLICABLE_MEANING, "R12's sentence, verbatim");

	// R29-R31 — every display member rendered AND labeled.
	assertContains(text, DISPLAY_ANNEX_LABEL, "R28's label");
	assert.ok(html.includes('data-testid="spend-breakdown"'), "R29's breakdown rows");
	assertContains(text, RECOMPUTE_IS_RESOLVER_ONLINE_CHECK, "R29: the resolver's online check");
	assertContains(text, PRICING_TABLES_NOTE, "R30");
	assertContains(text, "pricing-2026-07-01", "R30: the pricingDeployment reference");
	assertContains(text, EXECUTION_METADATA_NOTE, "R31");
});

test("C2 commit-history.json — history rung, the served history, and R7's caveat", () => {
	const { html, text } = renderFixture("commit-history.json");
	assertContains(text, "VERIFIED — CHECKPOINT HISTORY", "the history rung");
	assert.ok(
		html.includes('data-testid="checkpoint-history"'),
		"the checkpointHistory member renders",
	);
	assert.ok(html.includes('data-history-standing="upheld"'));
	assertContains(text, EQUIVOCATION_CAVEAT, "R7's equivocation caveat, verbatim");
	assertContains(text, "named non-goal for v1", "R7: closing equivocation is a named non-goal");
	assertContains(text, FORK_DISCLAIMER, "R7 keeps the fork disclaimer");
	assertContains(text, "seg-0001", "the walked segments render");
});

test("C3 commit-anchored.json — anchored rung, Rekor as the basis, S3 as context only", () => {
	const { html, text } = renderFixture("commit-anchored.json");
	assertContains(text, "VERIFIED — ANCHORED", "the anchored rung");
	assert.ok(html.includes('data-testid="rekor-evidence"'));
	assert.ok(html.includes('data-anchor-standing="upheld"'));
	assertContains(text, "https://rekor.usertrust.ai", "the log the evidence names");
	assertContains(text, "1786450800", "integratedTime as evidence about the checkpoint (§10.13)");

	// R8 — the surviving equivocation caveat, verbatim, plus the fork disclaimer.
	assertContains(text, ANCHOR_EXTERNAL_VISIBILITY, "R8's caveat, verbatim");
	assertContains(text, "does not prove the signer never produced another", "R8's limit");
	assertContains(text, FORK_DISCLAIMER, "R8: the fork disclaimer REMAINS at this rung");
	assertContains(text, EQUIVOCATION_CAVEAT, "the ladder is cumulative");

	// S3 present alongside — context only, never a green anchor claim.
	assert.ok(html.includes('data-testid="s3-object-lock"'));
	assertContains(text, S3_OPERATOR_ASSERTED, "R8's S3 label");
});

test("C4 commit-s3-only.json — S3 evidence alone renders NO anchor claim", () => {
	const { html, text, state } = renderFixture("commit-s3-only.json");
	assert.equal(state.rung, "verified_checkpoint", "the status stays at the floor");
	assertContains(text, "VERIFIED — CHECKPOINT", "no anchored word anywhere");
	assertOmits(text, "VERIFIED — ANCHORED", "R8: S3 upgrades no cryptographic verdict");
	assert.ok(!html.includes('data-testid="rekor-evidence"'), "there is no Rekor attachment to show");
	assertOmits(text, ANCHOR_EXTERNAL_VISIBILITY, "no anchor caveat without an anchor claim");
	assert.ok(html.includes('data-testid="s3-object-lock"'), "the probes still render as context");
	assertContains(text, S3_OPERATOR_ASSERTED, "labeled operator-asserted");
	assertContains(text, "DeleteObject denied by bucket policy", "the probe detail renders");
});

test("C5 commit-anchor-failed.json — base verdict preserved, the failed extension NAMED", () => {
	const { html, text, state } = renderFixture("commit-anchor-failed.json");
	assert.equal(state.rung, "verified_checkpoint", "R10: capped below anchored, never demoted");
	assertContains(text, "VERIFIED — CHECKPOINT", "the base verdict survives");
	const anchorRow = html.match(/data-check="anchorEvidence"[\s\S]*?<\/tr>/)?.[0] ?? "";
	assert.ok(anchorRow.includes('data-result="failed"'));
	assert.ok(anchorRow.includes('data-failure="ANCHOR_INVALID"'), "the failure code is named");
	// The served Rekor attachment must NOT read as a green anchor chip.
	assert.ok(html.includes('data-anchor-standing="not-upheld"'), "R10: never a green anchor chip");
	assertOmits(text, ANCHOR_EXTERNAL_VISIBILITY, "a failed anchor has no mitigation to claim");
	assertContains(text, "The base verdict is PRESERVED", "R10's sentence");
});

test("C6 commit-history-failed.json — base verdict preserved, HISTORY_INVALID named", () => {
	const { html, text, state } = renderFixture("commit-history-failed.json");
	assert.equal(state.rung, "verified_checkpoint", "R10: capped at the floor");
	const historyRow = html.match(/data-check="checkpointHistory"[\s\S]*?<\/tr>/)?.[0] ?? "";
	assert.ok(historyRow.includes('data-result="failed"'));
	assert.ok(historyRow.includes('data-failure="HISTORY_INVALID"'));
	assert.ok(html.includes('data-history-standing="not-upheld"'));
	assert.ok(!html.includes('data-testid="history-proved"'), "a failed walk proved nothing");
	assertOmits(text, EQUIVOCATION_CAVEAT, "no history rung claimed, so no history caveat");
});

test("C7 commit-checks-unavailable.json — unavailable never degrades, and says so", () => {
	const { html, text, state } = renderFixture("commit-checks-unavailable.json");
	assert.equal(state.rung, "verified_checkpoint");
	assertContains(text, "VERIFIED — CHECKPOINT", "R11: not an error page, not a paler green");
	const row = html.match(/data-check="checkpointHistory"[\s\S]*?<\/tr>/)?.[0] ?? "";
	assert.ok(row.includes('data-result="unavailable"'));
	assert.ok(row.includes("UNAVAILABLE"));
	assertContains(text, UNAVAILABLE_MEANING, "R11's sentence");
	const binding = html.match(/data-check="registryBinding"[\s\S]*?<\/tr>/)?.[0] ?? "";
	assert.ok(binding.includes('data-result="passed"'), "§4.1 v0.4: passed-required on a 200");
});

test("C8 commit-large-mixed.json — root as COMMITMENT, derivations n/a, mixed + conservative", () => {
	const { html, text } = renderFixture("commit-large-mixed.json");
	// R25 — the absent pair list makes the same field a commitment.
	assert.ok(html.includes('data-transfer-set="commitment"'));
	assertContains(text, TRANSFER_SET_ROOT_COMMITMENT, "R25, verbatim");
	assertOmits(text, "transfer pairs (", "the pair list is ABSENT above 32");

	// R12 — derivations notApplicable.
	const derivations = html.match(/data-check="derivations"[\s\S]*?<\/tr>/)?.[0] ?? "";
	assert.ok(derivations.includes('data-result="notApplicable"'));

	// R21/R22 — mixed carries the caveat; conservative names the round-up.
	assert.ok(html.includes('data-posture="mixed"'));
	assertContains(text, ESTIMATES_NOT_UPPER_BOUND, "R21's caveat on mixed");
	assert.ok(html.includes('data-posture="conservative"'));
	assertContains(text, "a fallback that can only round up", "R22");

	// R23 — the amount is derived by integer math from assessedUsertokens.
	assertContains(text, "$90.3120", "R23: 903120 usertokens at 10,000/dollar");
});

test("C9 commit-owner-asserted.json — the posture that most easily overstates provenance", () => {
	const { html, text } = renderFixture("commit-owner-asserted.json");
	assert.ok(html.includes('data-posture="ownerAsserted"'));
	assertContains(text, "OWNER-ASSERTED", "R20's distinct label");
	assertContains(text, "HUMAN-ASSERTED", "what the posture actually claims");
	assertOmits(text, "WORKFLOW-ATTESTED", "the attested label must not appear here");
	assertOmits(text, "workloadId", "ownerAsserted binds no workload identity");
	assertContains(text, POSTURES_ARE_ATTESTED_ENUMS, "the P2-7 epistemic frame renders with it");
});

test("C10 commit-gen1-addenda-advisory.json — the generation-addendum amber band", () => {
	const { html, text } = renderFixture("commit-gen1-addenda-advisory.json");
	assert.ok(html.includes('data-advisory="generationAddendum"'), "R34's band renders");
	assertContains(text, "GENERATION ADDENDUM", "titled");
	assertContains(text, "trailer cites generation 1 forever", "R34's rule");
	assertContains(text, "never alters this receipt's cryptographic verdict", "advisory-only");
	// Amber, never red, never green (§6.4).
	const band = html.match(/data-advisory="generationAddendum"[\s\S]*?<\/aside>/)?.[0] ?? "";
	assert.ok(band.includes("border-warning/40"), "§6.4: the amber voice");
	assert.ok(!band.includes("text-danger"), "never red");
	assert.ok(!band.includes("text-ut"), "never green");
});

test("C11 commit-gen2-addendum.json — the predecessor linkage rendered, both places", () => {
	const { html, text } = renderFixture("commit-gen2-addendum.json");
	assert.ok(html.includes('data-testid="predecessor-linkage"'), "R34: the linkage on the artifact");
	assertContains(text, "generation 2", "the generation renders");
	assertContains(text, "trailer cites generation 1 forever", "R34's rule on an addendum page");
	const row = html.match(/data-check="predecessorLinkage"[\s\S]*?<\/tr>/)?.[0] ?? "";
	assert.ok(row.includes('data-result="passed"'), "R9: the check RESULT renders too");
});

test("C12 commit-superseded-advisory.json — supersession is advisory, the verdict untouched", () => {
	const { html, text, state } = renderFixture("commit-superseded-advisory.json");
	assert.ok(html.includes('data-advisory="receiptSuperseded"'), "R33's band");
	assertContains(text, "RECEIPT SUPERSEDED", "titled");
	assertContains(text, "never alters this receipt's cryptographic verdict", "R33's rule");
	assert.equal(state.rung, "verified_checkpoint", "the verdict treatment is unchanged");
	assertContains(text, "VERIFIED — CHECKPOINT", "still a clean green");
});

test("C13 pr-private.json — keyed repoId, SERVER-ASSISTED confirmation, the pr headline", () => {
	const { html, text } = renderFixture("pr-private.json");
	assertContains(
		text,
		"attests r1_9f2a7c31e8b4 PR #412 at revision 4a7459a0ca3e4a9882985df4baa1079fc40ada00",
		"R13's pr headline",
	);
	// R18 — the keyed form, with the opaque ID still shown.
	assert.ok(html.includes('data-repo-label="undisclosed"'));
	assertContains(text, UNDISCLOSED_PRIVATE_REPO, "R18's wording");
	assertContains(text, "r1_9f2a7c31e8b4", "R18: never dropped");
	// R15 — the server-assisted half of the teaching.
	assertContains(text, "privateHmacSha256V1", "the binding variant is named");
	assertContains(text, "SERVER-ASSISTED", "R15's pr/issue teaching");
	assertContains(text, "the HMAC key is server-side and never exposed", "R15, verbatim");
	assertContains(text, "number and URL are both reusable", "R15's transplant rule");
});

test("C14 pr-revision-superseded.json — R16's line verbatim, the verdict untouched", () => {
	const { html, text, state } = renderFixture("pr-revision-superseded.json");
	assert.ok(html.includes('data-advisory="revisionSuperseded"'));
	assertContains(
		text,
		"attests revision 6e5a66a7ddeab4ac0a3adaaa11dc50e0b08bf406; the artifact has since changed",
		"R16, verbatim",
	);
	assertContains(
		text,
		"not a failure, not a downgrade, and never silently a plain green check",
		"R16's three prohibitions",
	);
	assert.equal(state.rung, "verified_checkpoint", "the verdict rendering underneath is untouched");
});

test("C15 issue-public.json — the issue headline and DIRECT recomputation", () => {
	const { text } = renderFixture("issue-public.json");
	assertContains(
		text,
		"attests github.com:R_kgDOK1x2Yw issue #231 at revision e4689855dad05ef1b6ee459c7e354ad1f41d65dc",
		"R13's issue headline",
	);
	assertContains(text, "publicSha256", "the binding variant is named");
	assertContains(text, "recomputed DIRECTLY by the consumer", "R15's public teaching");
});

test("C16 session-owner-estimated.json — non-artifact, estimate caveat, the custom literal", () => {
	const { html, text } = renderFixture("session-owner-estimated.json");
	// R13/R14 — a session headline makes NO artifact claim.
	assertContains(text, "produced under this governed session — $0.7700", "R13's session form");
	assertOmits(text, "attests commit", "R14: no artifact claim");
	assertContains(text, SESSION_NON_ARTIFACT, "R14, verbatim");
	assertContains(text, SESSION_PROMOTION_GATE, "R14's promotion-gate rule");

	// R21 — the estimate caveat.
	assert.ok(html.includes('data-posture="estimated"'));
	assertContains(text, ESTIMATES_NOT_UPPER_BOUND, "R21's caveat, verbatim");

	// R24 — the "custom" literal, named and explained, never expanded.
	assert.ok(html.includes("data-custom-literal"));
	assertContains(text, CUSTOM_MODEL_MEANING, "R24, verbatim");
});

test("C17 session-workflow-attested.json — an attested posture is still not artifact attestation", () => {
	const { html, text } = renderFixture("session-workflow-attested.json");
	assert.ok(html.includes('data-posture="workflowAttested"'), "R20: the true posture renders");
	assertContains(text, "WORKFLOW-ATTESTED", "the attested label");
	// R14's copy is UNCHANGED by the stronger posture — that is the whole row.
	assertContains(text, SESSION_NON_ARTIFACT, "R14 is untouched by workflowAttested");
	assertContains(text, SESSION_PROMOTION_GATE, "a promotion gate still refuses it");
	assertOmits(text, "attests commit", "no artifact claim appears");
	assertOmits(text, " PR #", "no artifact claim appears");
});

test("C18 session-fallback.json — the billedUnfinalized origin linkage renders (R19)", () => {
	const { html, text } = renderFixture("session-fallback.json");
	assertContains(
		text,
		"the spend-only record of a reservation that billed but was never finalized",
		"R19's wording",
	);
	const state = verifiedFixtureState("session-fallback.json");
	const work = state.envelope.receipt.work;
	assert.equal(work.kind, "session");
	const source = work.kind === "session" ? work.origin?.sourceReservationReceiptId : undefined;
	assert.ok(source, "the fixture carries the fallback origin");
	assert.ok(html.includes(`href="/r/${source}"`), "R19: it links back to the reservation");
});

// ---------------------------------------------------------------------------
// R26 — the membership epistemic scope, on the kinds that carry membership
// ---------------------------------------------------------------------------

test("R26: artifact receipts render membership as the minter's COMMITTED OBSERVATION", () => {
	for (const file of ["commit-checkpoint.json", "pr-private.json", "issue-public.json"]) {
		const { text } = renderFixture(file);
		assertContains(text, "providerVerified", `${file}: the status renders`);
		assertContains(text, MEMBERSHIP_EPISTEMIC_SCOPE, `${file}: R26, verbatim`);
	}
	// A session has no artifact to observe, so it carries no membership claim.
	const session = renderFixture("session-workflow-attested.json");
	assertOmits(session.text, MEMBERSHIP_EPISTEMIC_SCOPE, "session receipts assert no membership");
});

// ---------------------------------------------------------------------------
// R27 — the attested-vs-asserted clock split
// ---------------------------------------------------------------------------

test("R27: mintedAt is labeled minter-asserted and set apart from the chain clock claims", () => {
	const { html, text } = renderFixture("commit-checkpoint.json");
	assert.ok(html.includes('data-clock-claim="minter-asserted"'));
	assert.ok(html.includes('data-clock-claim="chain-committed"'));
	assertContains(text, MINTED_AT_LABEL, "R27's label");
	assertContains(text, "the only minter-asserted clock claim", "R27, verbatim");
	assertContains(text, "2026-08-10T14:15:01.000Z", "the mintedAt value renders");
	assertContains(text, "2026-08-10T14:00:00.000Z", "startedAt renders in the chain-clock block");
});

// ---------------------------------------------------------------------------
// C19-C27 — the non-green rows never reach this renderer
// ---------------------------------------------------------------------------

test("C19-C27: no non-green fixture ever resolves to the verified renderer", () => {
	const nonGreen = [
		"reserved.json",
		"reconciling.json",
		"billed-unfinalized.json",
		"cancelled.json",
		"expired.json",
		"not-minted.json",
		"unknown.json",
		"unverifiable.json",
		"verification-unavailable.json",
		"rate-limited.json",
	];
	for (const file of nonGreen) {
		const state = fixtureState(loadFixture(file));
		assert.notEqual(state.kind, "verified", `${file} must never render as a verified receipt`);
	}
});
