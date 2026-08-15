/**
 * Per-component tests for the §6 anatomy.
 *
 * `rendering.test.tsx` drives whole fixtures through the composed page and
 * asserts each §8.1 row's obligation. This file does the complementary job: it
 * exercises each component ALONE, across input combinations the fixture matrix
 * does not (and should not) carry — an empty advisory array, an unknown
 * advisory kind, all four result values in one ledger, a `display` member with
 * nothing in it, an `anchorEvidence` container whose shapes are unrecognizable.
 * Those are the states a resolver can legally produce within `apiVersion: "1"`
 * and that no conforming fixture is going to spend a row on.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import AdvisoryBands from "./components/advisory-bands";
import AnchorEvidencePanels from "./components/anchor-evidence";
import CheckLedger from "./components/check-ledger";
import DisplayAnnex from "./components/display-annex";
import HashValue from "./components/hash-value";
import PostureChips, { AmountScope } from "./components/posture-chips";
import ReceiptArtifact from "./components/receipt-artifact";
import VerdictMasthead from "./components/verdict-masthead";
import WorkClaims from "./components/work-claims";
import { verifiedFixtureState } from "./fixture-harness";
import {
	ADVISORY_NEVER_ALTERS_VERDICT,
	ANCHOR_BINDING_RESOLVER_ASSERTED,
	DELEGATION_POSTURE_SCOPE,
	EQUIVOCATION_CAVEAT,
	EQUIVOCATION_NON_GOAL,
	EXTENSION_FAILURE_MEANING,
	HISTORY_WALK_PROVED,
	INCLUDES_ALL_DELEGATED_UNEVIDENCED,
	LADDER,
	NOT_APPLICABLE_MEANING,
	POSTURES_ARE_ATTESTED_ENUMS,
	type ReceiptClaims,
	RUNG_EARNED_BY,
	RUNG_VERDICT_WORD,
	receiptClaims,
	rungDisclaimers,
	trustSnapshotLine,
	UNAVAILABLE_MEANING,
} from "./lib/claims";
import type { CheckEntry, DelegationPosture, Verification } from "./lib/wire";

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

const PASSED: CheckEntry = { result: "passed" };

function verification(overrides: Partial<Verification["checks"]> = {}): Verification {
	return {
		trustSnapshotId: "snapshot-under-test",
		steps: {
			schema: PASSED,
			event: PASSED,
			registry: PASSED,
			signature: PASSED,
			inclusion: PASSED,
			checkpoint: PASSED,
			semantics: PASSED,
			derivations: PASSED,
			extensions: PASSED,
		},
		checks: {
			registryBinding: PASSED,
			predecessorLinkage: { result: "notApplicable" },
			checkpointHistory: { result: "unavailable" },
			anchorEvidence: { result: "failed", failure: "ANCHOR_INVALID" },
			...overrides,
		},
	};
}

// ---------------------------------------------------------------------------
// VerdictMasthead (§6.1, R5-R8)
// ---------------------------------------------------------------------------

test("VerdictMasthead: each rung lights itself, clears the rungs below, and names what earns those above", () => {
	for (const [index, rung] of LADDER.entries()) {
		const markup = html(<VerdictMasthead rung={rung} />);
		const text = textOf(markup);
		assert.ok(text.includes(RUNG_VERDICT_WORD[rung]), `${rung}: the verdict word`);

		for (const [otherIndex, other] of LADDER.entries()) {
			const expected = otherIndex === index ? "reached" : otherIndex < index ? "cleared" : "above";
			assert.ok(
				markup.includes(`data-rung="${other}" data-rung-state="${expected}"`),
				`${rung}: expected ${other} to be "${expected}"`,
			);
			// R5 — an unreached rung is labeled with what WOULD earn it; a reached
			// one is not (there is nothing left to earn).
			assert.equal(
				text.includes(RUNG_EARNED_BY[other]),
				expected === "above",
				`${rung}: earned-by text for ${other}`,
			);
		}
	}
});

test("VerdictMasthead: the ladder is never color-only — every rung carries a status WORD", () => {
	const text = textOf(html(<VerdictMasthead rung="verified_checkpoint" />));
	assert.ok(text.includes("REACHED"));
	assert.ok(text.includes("NOT REACHED"));
	const anchored = textOf(html(<VerdictMasthead rung="verified_anchored" />));
	assert.ok(anchored.includes("CLEARED"), "the rungs below a reached rung say so in words");
});

test("VerdictMasthead: the disclaimers render in full, never behind a disclosure widget", () => {
	for (const rung of LADDER) {
		const markup = html(<VerdictMasthead rung={rung} />);
		const text = textOf(markup);
		for (const line of rungDisclaimers(rung)) {
			assert.ok(text.includes(line), `${rung} dropped a mandated caveat`);
		}
		assert.ok(!markup.includes("<details"), "§7: not hidden behind interaction");
		assert.ok(!markup.includes("<summary"), "§7: not hidden behind interaction");
	}
});

// ---------------------------------------------------------------------------
// AdvisoryBands (§6.4, R16/R33/R34)
// ---------------------------------------------------------------------------

test("AdvisoryBands: an empty array renders nothing at all", () => {
	assert.equal(html(<AdvisoryBands advisories={[]} />), "");
});

test("AdvisoryBands: an UNKNOWN kind renders generically and is never dropped (§4.1)", () => {
	const markup = html(<AdvisoryBands advisories={[{ kind: "somethingFromV1_2" }]} />);
	assert.ok(markup.includes('data-advisory="somethingFromV1_2"'));
	assert.ok(textOf(markup).includes("somethingFromV1_2"), "the kind is NAMED");
	assert.ok(textOf(markup).includes(ADVISORY_NEVER_ALTERS_VERDICT));
});

test("AdvisoryBands: every band is amber — never red, never green (§6.4)", () => {
	const markup = html(
		<AdvisoryBands
			advisories={[
				{ kind: "receiptSuperseded", supersededByReceiptId: "ut1_x", eventHash: "aa" },
				{ kind: "generationAddendum", generation: 2, receiptId: "ut1_y" },
				{ kind: "revisionSuperseded", observedRevision: "r1", currentRevision: "r2" },
				{ kind: "unknownKind" },
			]}
		/>,
	);
	assert.equal(
		markup.match(/border-warning\/40/g)?.length,
		4,
		"all four bands take the amber voice",
	);
	assert.ok(!markup.includes("text-danger"), "never red");
	assert.ok(!markup.includes("text-ut"), "never green");
});

test("AdvisoryBands: an advisory whose members are unreadable still renders, and LINKS to nothing", () => {
	// Advisories are unsigned too (§4.1 validates only `kind`), so the same R10
	// rule applies: never dropped, never thrown, and never a link to an
	// invented receipt — a link is a claim.
	const markup = html(
		<AdvisoryBands
			advisories={
				[
					{ kind: "receiptSuperseded", supersededByReceiptId: { id: "x" }, eventHash: 7 },
					{ kind: "generationAddendum", generation: [], receiptId: null },
					{ kind: "revisionSuperseded", observedRevision: {}, currentRevision: "r2" },
				] as never
			}
		/>,
	);
	const text = textOf(markup);
	assert.ok(!markup.includes("[object Object]"));
	assert.ok(!markup.includes('href="/r/'), "an unreadable receipt id is not a link");
	// Five unreadable members across the three bands, each named as not served
	// rather than silently blank: supersededByReceiptId, eventHash, generation,
	// receiptId, observedRevision.
	assert.equal(text.match(/\(not served\)/g)?.length, 5, "each unreadable member says so");
	assert.equal(markup.match(/data-advisory=/g)?.length, 3, "and none of them is dropped");
});

test("AdvisoryBands: repeated kinds both render (an addendum list is not a set)", () => {
	const markup = html(
		<AdvisoryBands
			advisories={[
				{ kind: "generationAddendum", generation: 2, receiptId: "ut1_a" },
				{ kind: "generationAddendum", generation: 3, receiptId: "ut1_b" },
			]}
		/>,
	);
	assert.equal(markup.match(/data-advisory="generationAddendum"/g)?.length, 2);
	assert.ok(textOf(markup).includes("ut1_a"));
	assert.ok(textOf(markup).includes("ut1_b"));
});

// ---------------------------------------------------------------------------
// CheckLedger (§6.3, R9-R12)
// ---------------------------------------------------------------------------

test("CheckLedger: all four result values render by NAME, with the failure code named", () => {
	const markup = html(<CheckLedger verification={verification()} />);
	const text = textOf(markup);
	for (const word of ["PASSED", "FAILED", "N/A", "UNAVAILABLE"]) {
		assert.ok(text.includes(word), `the ${word} result renders as a word`);
	}
	assert.ok(markup.includes('data-failure="ANCHOR_INVALID"'));
	assert.ok(text.includes(NOT_APPLICABLE_MEANING), "R12's sentence rides with an n/a row");
	assert.ok(text.includes(UNAVAILABLE_MEANING), "R11's sentence rides with an unavailable row");
	assert.ok(
		text.includes(EXTENSION_FAILURE_MEANING),
		"R10's sentence rides with a failed extension",
	);
});

test("CheckLedger: n/a uses an em dash, never a tick (R12)", () => {
	const markup = html(<CheckLedger verification={verification()} />);
	const naRow = markup.match(/data-check="predecessorLinkage"[\s\S]*?<\/tr>/)?.[0] ?? "";
	assert.ok(naRow.includes('data-result="notApplicable"'));
	assert.ok(!naRow.includes("✓"), "n/a is never drawn as a green tick");
	assert.ok(naRow.includes("—"));
});

test("CheckLedger: failed rows use danger-INK, the sanctioned red for 12-14px text (H2)", () => {
	const markup = html(<CheckLedger verification={verification()} />);
	const failedRow = markup.match(/data-check="anchorEvidence"[\s\S]*?<\/tr>/)?.[0] ?? "";
	assert.ok(failedRow.includes("text-danger-ink"));
	assert.ok(
		!/text-danger(?!-ink)/.test(failedRow),
		"full --color-danger measures 3.5:1 at this size and is forbidden as small text",
	);
});

test("CheckLedger: the footer names the trust snapshot, and the membership note is optional", () => {
	const bare = html(<CheckLedger verification={verification()} />);
	assert.ok(textOf(bare).includes(trustSnapshotLine("snapshot-under-test")));
	assert.ok(!bare.includes('data-testid="membership-note"'));

	const withNote = html(
		<CheckLedger
			verification={verification()}
			membershipNote="the minter's committed observation"
		/>,
	);
	assert.ok(withNote.includes('data-testid="membership-note"'));
	assert.ok(textOf(withNote).includes("the minter's committed observation"));
});

test("CheckLedger: an all-passed verification still renders every row (R9 shows the INPUTS)", () => {
	const allPassed = verification({
		predecessorLinkage: PASSED,
		checkpointHistory: PASSED,
		anchorEvidence: PASSED,
	});
	const markup = html(<CheckLedger verification={allPassed} />);
	assert.equal(markup.match(/data-check="/g)?.length, 13, "nine steps plus four checks, always");
});

// ---------------------------------------------------------------------------
// PostureChips (§6.2, R20-R22)
// ---------------------------------------------------------------------------

test("PostureChips: the epistemic frame sits above the later chips, not in a tooltip", () => {
	const claims = receiptClaims(verifiedFixtureState("commit-checkpoint.json").envelope.receipt);
	const markup = html(<PostureChips claims={claims} />);
	assert.ok(textOf(markup).includes(POSTURES_ARE_ATTESTED_ENUMS));
	assert.ok(!markup.includes("title="), "no hover-only disclosure of the frame");
	assert.ok(
		markup.indexOf(POSTURES_ARE_ATTESTED_ENUMS) <
			markup.indexOf('data-posture-role="session association"'),
		"the frame precedes the session/usage/pricing chips",
	);
});

test("PostureChips: attested is FILLED and asserted is OUTLINED — three channels of difference", () => {
	const attested = receiptClaims(
		verifiedFixtureState("session-workflow-attested.json").envelope.receipt,
	);
	const asserted = receiptClaims(
		verifiedFixtureState("session-owner-estimated.json").envelope.receipt,
	);
	const a = html(<PostureChips claims={attested} />);
	const b = html(<PostureChips claims={asserted} />);
	assert.ok(a.includes("bg-paper-emerald") && a.includes("font-bold"), "attested is a filled chip");
	assert.ok(!b.includes("bg-paper-emerald"), "asserted is never the filled treatment");
	assert.ok(textOf(a).includes("WORKFLOW-ATTESTED"));
	assert.ok(textOf(b).includes("OWNER-ASSERTED"));
});

test("PostureChips: only paper-safe ink is used — the dark-ground accents are forbidden here", () => {
	for (const file of [
		"commit-checkpoint.json",
		"commit-large-mixed.json",
		"session-owner-estimated.json",
	]) {
		const claims = receiptClaims(verifiedFixtureState(file).envelope.receipt);
		const markup = html(<PostureChips claims={claims} />);
		for (const forbidden of ["text-ut", "text-warning", "text-danger", "text-tim-ink"]) {
			assert.ok(!markup.includes(forbidden), `${file}: ${forbidden} is not legible on paper`);
		}
	}
});

// ---------------------------------------------------------------------------
// AmountScope (§6.2, R38-R40)
//
// `rendering.test.tsx` drives this through whole fixtures; these are the
// combinations the fixture matrix cannot carry — chiefly the posture that
// `wire.ts` refuses before a render ever happens.
// ---------------------------------------------------------------------------

/** A fixture's claims with one posture swapped, to reach branches the wire blocks. */
function claimsWithPosture(file: string, posture: DelegationPosture): ReceiptClaims {
	const receipt = verifiedFixtureState(file).envelope.receipt;
	return receiptClaims({
		...receipt,
		event: {
			...receipt.event,
			data: { ...receipt.event.data, delegationPosture: posture },
		},
	});
}

test("AmountScope: the epistemic frame is the first line, before the floor or the posture", () => {
	const claims = claimsWithPosture("commit-checkpoint.json", "selfDebitsOnly");
	const markup = html(<AmountScope claims={claims} />);
	const frame = markup.indexOf('data-testid="epistemic-frame"');
	const floor = markup.indexOf('data-testid="amount-floor"');
	const posture = markup.indexOf('data-posture="selfDebitsOnly"');
	assert.ok(frame !== -1, "the frame renders in the scope block");
	assert.ok(textOf(markup).includes(POSTURES_ARE_ATTESTED_ENUMS));
	assert.ok(!markup.includes("title="), "no hover-only disclosure of the frame");
	assert.ok(frame < floor, "the frame precedes the floor claim");
	assert.ok(frame < posture, "the frame precedes the amount posture");
});

test("AmountScope: the includesAllDelegated fallback renders UNEVIDENCED, never a total", () => {
	// DEFENCE IN DEPTH, and the reason it is tested at the component: `wire.ts`
	// fails this posture closed before the page renders, so the render layer's
	// refusal is unreachable through a fixture — and an unreachable refusal that
	// nobody exercises is a refusal nobody knows still works. If the parse-layer
	// guard is ever moved, relaxed, or reordered, this is what still holds.
	const claims = claimsWithPosture("commit-checkpoint.json", "includesAllDelegated");
	const markup = html(<AmountScope claims={claims} />);
	const text = textOf(markup);
	assert.ok(text.includes(INCLUDES_ALL_DELEGATED_UNEVIDENCED), "the unevidenced framing renders");
	assert.ok(!markup.includes('data-amount-bound="floor"'), "an unbacked claim earns no bound");
	assert.ok(!text.includes("at least $"), "and no floor wording");
	assert.equal(claims.amountFloor, undefined, "the claims surface granted no bound");
});

test("AmountScope: every posture renders its own framing, and only one earns a bound", () => {
	const bounded: string[] = [];
	for (const posture of [
		"selfDebitsOnly",
		"includesSomeDelegated",
		"includesAllDelegated",
		"indeterminate",
	] as const) {
		const claims = claimsWithPosture("commit-checkpoint.json", posture);
		const markup = html(<AmountScope claims={claims} />);
		assert.ok(
			markup.includes(`data-posture="${posture}"`),
			`${posture}: the scope block names the posture`,
		);
		assert.ok(
			textOf(markup).includes(DELEGATION_POSTURE_SCOPE[posture]),
			`${posture}: its own framing renders`,
		);
		if (markup.includes('data-amount-bound="floor"')) bounded.push(posture);
	}
	assert.deepEqual(bounded, ["selfDebitsOnly"], "the bound is the exception, never the default");
});

test("AmountScope: nothing in it is behind interaction — no details, summary, or title", () => {
	for (const posture of ["selfDebitsOnly", "indeterminate"] as const) {
		const markup = html(
			<AmountScope claims={claimsWithPosture("commit-checkpoint.json", posture)} />,
		);
		assert.ok(
			!markup.includes("<details"),
			`${posture}: a disclosure requiring a click is a defence`,
		);
		assert.ok(!markup.includes("<summary"), `${posture}: no summary`);
		assert.ok(!markup.includes("title="), `${posture}: no hover-only disclosure`);
		assert.ok(!markup.includes("aria-expanded"), `${posture}: not a disclosure widget`);
	}
});

test("AmountScope: only paper-safe ink is used — the dark-ground accents are forbidden here", () => {
	const markup = html(
		<AmountScope claims={claimsWithPosture("commit-checkpoint.json", "selfDebitsOnly")} />,
	);
	for (const forbidden of ["text-ut", "text-warning", "text-danger", "text-tim-ink"]) {
		assert.ok(!markup.includes(forbidden), `${forbidden} is not legible on paper`);
	}
});

// ---------------------------------------------------------------------------
// HashValue (R17)
// ---------------------------------------------------------------------------

test("HashValue: a truncated value keeps the FULL value in the accessible name and the copy chip", () => {
	const full = "12283b89ad55b584c7959394a527e24da0ec1f5e";
	const markup = html(<HashValue value={full} label="commit oid" />);
	assert.ok(markup.includes(`title="${full}"`), "hover reveals the projection's real value");
	assert.ok(markup.includes(`commit oid, in full: ${full}`), "so does a screen reader");
	assert.ok(markup.includes(`aria-label="Copy commit oid"`), "and the copy affordance carries it");
	assert.ok(!textOf(markup).includes(`${full} ${full}`), "the truncated head is what is SHOWN");
});

test("HashValue: a short value renders whole, with no ellipsis and no sr-only duplicate", () => {
	const markup = html(<HashValue value="seg-0042" label="segment" copy={false} />);
	assert.ok(textOf(markup).includes("seg-0042"));
	assert.ok(!markup.includes("…"));
	assert.ok(!markup.includes("in full:"));
});

// ---------------------------------------------------------------------------
// DisplayAnnex (§6.5, R28-R31)
// ---------------------------------------------------------------------------

test("DisplayAnnex: an absent or empty display member renders nothing", () => {
	assert.equal(html(<DisplayAnnex />), "");
	assert.equal(html(<DisplayAnnex display={{}} />), "");
});

test("DisplayAnnex: every served member is labeled, and the annex never borrows the paper voice", () => {
	const markup = html(
		<DisplayAnnex
			display={{
				spendBreakdown: [
					{ provider: "anthropic", model: "claude-sonnet-4-6", tier: "input", usertokens: 10 },
				],
				recomputedTotal: { a: 9, roundingAdjustment: 1, total: 10 },
				pricingTables: { hashes: ["ab".repeat(32)], pricingDeployment: "pricing-x" },
				execution: { agent: true, interactive: false },
			}}
		/>,
	);
	const text = textOf(markup);
	assert.ok(text.includes("DISPLAY DATA — NOT CHAIN-COMMITTED"));
	for (const id of [
		"spend-breakdown",
		"recomputed-total",
		"pricing-tables",
		"execution-metadata",
	]) {
		assert.ok(markup.includes(`data-testid="${id}"`), `${id} renders`);
	}
	assert.ok(!markup.includes("paper-surface"), "unsigned material never renders as the receipt");
	// The annex's OWN chrome carries no verdict green. `CopyChip`'s `$` sigil is
	// emerald in its dark tone — that is the site-wide copy AFFORDANCE, shared
	// with every other surface on the page and not a claim about this data — so
	// the chip's subtree is excluded rather than the assertion being dropped.
	const withoutCopyChips = markup.replace(/<button[\s\S]*?<\/button>/g, "");
	assert.ok(!withoutCopyChips.includes("text-ut"), "and never in the verdict's green");
});

test("DisplayAnnex: an unreadable unsigned member is DROPPED, never thrown and never [object Object]", () => {
	// R10's rule, applied to the annex: `wire.ts` validates the `display`
	// container and nothing inside it, because unsigned material must never
	// demote a sound receipt. That leaves the component holding shapes the
	// declared type promised and the wire never checked — and a render-time
	// throw is Next's generic 500, which is not one of §7's named states.
	for (const [why, display] of [
		["spendBreakdown is not an array", { spendBreakdown: "rows" }],
		[
			"a row cell is an object",
			{ spendBreakdown: [{ provider: { id: "x" }, model: "m", tier: "t", usertokens: 1 }] },
		],
		["pricingTables.hashes is not an array", { pricingTables: { hashes: "abc" } }],
		[
			"a recompute leg is not a number",
			{ recomputedTotal: { a: {}, roundingAdjustment: 1, total: 2 } },
		],
		["execution flags are not booleans", { execution: { agent: { name: "x" }, interactive: 1 } }],
		["display itself is not an object", "display"],
	] as const) {
		const markup = html(<DisplayAnnex display={display as never} />);
		assert.ok(!markup.includes("[object Object]"), `${why}: never rendered as [object Object]`);
		assert.ok(!markup.includes("undefined"), `${why}: never rendered as "undefined"`);
	}

	// A readable cell beside an unreadable one still renders: dropping the FIELD
	// is the fail-closed move, dropping the whole row would hide served data.
	const partial = html(
		<DisplayAnnex
			display={{ spendBreakdown: [{ provider: "anthropic", model: 7, tier: "input" }] } as never}
		/>,
	);
	assert.ok(textOf(partial).includes("anthropic"), "the readable cell survives");
	assert.ok(partial.includes('data-testid="spend-breakdown"'));
});

// ---------------------------------------------------------------------------
// AnchorEvidencePanels (R8/R10/R32)
// ---------------------------------------------------------------------------

test("AnchorEvidencePanels: nothing served renders nothing", () => {
	assert.equal(
		html(<AnchorEvidencePanels checks={verification().checks} rung="verified_checkpoint" />),
		"",
	);
});

test("AnchorEvidencePanels: an unrecognizable anchorEvidence container renders as absent, not as a claim", () => {
	const markup = html(
		<AnchorEvidencePanels
			anchorEvidence={{ rekor: "not-an-object", s3ObjectLock: "not-an-array" }}
			checks={verification({ anchorEvidence: PASSED }).checks}
			rung="verified_checkpoint_history"
		/>,
	);
	assert.equal(markup, "", "fail-closed: no shape recognized, no panel rendered");
});

test("AnchorEvidencePanels: an unreadable served HISTORY renders as absent, and never as a throw", () => {
	const checks = verification({ checkpointHistory: PASSED }).checks;
	assert.equal(
		html(
			<AnchorEvidencePanels
				checkpointHistory={["seg-1", 2] as never}
				checks={checks}
				rung="verified_checkpoint_history"
			/>,
		),
		"",
		"no readable entry is an unrecognized member — the ledger still carries the RESULT",
	);

	const partial = html(
		<AnchorEvidencePanels
			checkpointHistory={
				[
					{
						segmentId: "seg-0001",
						segmentFirstSequence: 1,
						treeSize: 4,
						previousSegmentId: "seg-0000",
					},
					{ segmentId: { s: 1 }, treeSize: "four" },
				] as never
			}
			checks={checks}
			rung="verified_checkpoint_history"
		/>,
	);
	const text = textOf(partial);
	assert.ok(text.includes("seg-0001"), "the readable entry renders whole");
	assert.ok(!partial.includes("[object Object]"));
	assert.ok(
		text.includes("(unnamed segment)"),
		"an unreadable ID is named as such, never invented",
	);
	assert.ok(text.includes("segment-checkpoint history (2)"), "the count is what was served");
});

test("R7: the history claim NEVER renders without its equivocation gap, at any rung", () => {
	// §4.1 rule 3 is a ONE-SIDED cap: a resolver may serve
	// `checkpointHistory: passed` while honestly claiming only
	// `verified_checkpoint` (the §7 launch ceiling does exactly this). The
	// masthead carries no caveat at that rung, so the panel must.
	const history = [
		{ segmentId: "seg-0001", segmentFirstSequence: 1, treeSize: 4 },
	] as unknown as Parameters<typeof AnchorEvidencePanels>[0]["checkpointHistory"];
	const checks = verification({ checkpointHistory: PASSED }).checks;

	for (const rung of LADDER) {
		const markup = html(
			<AnchorEvidencePanels checkpointHistory={history} checks={checks} rung={rung} />,
		);
		const text = textOf(markup);
		assert.ok(text.includes(HISTORY_WALK_PROVED), `${rung}: the walk's claim renders`);
		const carried = [...rungDisclaimers(rung), text].join(" ");
		assert.ok(
			carried.includes(EQUIVOCATION_CAVEAT) && carried.includes(EQUIVOCATION_NON_GOAL),
			`${rung}: the claim must never appear without the equivocation gap and its non-goal`,
		);
	}

	// ...and a history that did NOT walk clean claims nothing, so it owes no caveat.
	const failed = html(
		<AnchorEvidencePanels
			checkpointHistory={history}
			checks={
				verification({ checkpointHistory: { result: "failed", failure: "HISTORY_INVALID" } }).checks
			}
			rung="verified_checkpoint"
		/>,
	);
	assert.ok(!textOf(failed).includes(HISTORY_WALK_PROVED));
	assert.ok(!failed.includes('data-testid="history-equivocation-caveat"'));
});

test("AnchorEvidencePanels: a PASSED Rekor attachment carries R8's caveat; a FAILED one does not", () => {
	const rekor = {
		rekor: { artifactHash: "ab".repeat(32), log: { url: "https://log", logIndex: 1 } },
	};
	const passed = html(
		<AnchorEvidencePanels
			anchorEvidence={rekor}
			checks={verification({ anchorEvidence: PASSED }).checks}
			rung="verified_checkpoint_history"
		/>,
	);
	assert.ok(passed.includes('data-anchor-standing="upheld"'));
	assert.ok(passed.includes('data-testid="anchor-caveat"'));
	assert.ok(
		textOf(passed).includes(ANCHOR_BINDING_RESOLVER_ASSERTED),
		"an upheld Rekor card carries R41 locally, not only on the masthead",
	);

	const failed = html(
		<AnchorEvidencePanels
			anchorEvidence={rekor}
			checks={verification().checks}
			rung="verified_checkpoint"
		/>,
	);
	assert.ok(failed.includes('data-anchor-standing="not-upheld"'));
	assert.ok(
		!failed.includes('data-testid="anchor-caveat"'),
		"no anchor claim, so nothing to caveat",
	);
	assert.ok(textOf(failed).includes("ANCHOR_INVALID"), "R10: the failed extension is NAMED");
});

// ---------------------------------------------------------------------------
// WorkClaims (R13/R14/R15) and ReceiptArtifact (§6.2)
// ---------------------------------------------------------------------------

test("WorkClaims: a session restatement of $X carries R39 and no floor", () => {
	const claims = receiptClaims(
		verifiedFixtureState("session-owner-estimated.json").envelope.receipt,
	);
	const markup = html(<WorkClaims claims={claims} />);
	assert.ok(markup.includes('data-testid="work-amount-scope"'));
	assert.ok(textOf(markup).includes(claims.delegation.claim), "R39 sits beside the restated $X");
	assert.ok(!markup.includes('data-amount-bound="floor"'), "R40 stays on the paper SpendBlock");
});

test("WorkClaims: every axis of the per-kind comparison renders, in order", () => {
	for (const [file, axes] of [
		["commit-checkpoint.json", ["IDENTITY", "BYTES", "BYTES, OUTSIDE PROMOTION"]],
		[
			"pr-private.json",
			["IDENTITY, FAIL ON MISMATCH", "REVISION + CONTENT", "A NEWER REVISION IS NOT A MISMATCH"],
		],
		["session-owner-estimated.json", ["NO ARTIFACT TO COMPARE", "PROMOTION"]],
	] as const) {
		const claims = receiptClaims(verifiedFixtureState(file).envelope.receipt);
		const markup = html(<WorkClaims claims={claims} />);
		const rendered = [...markup.matchAll(/data-comparison-axis="([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(rendered, [...axes], `${file}: the whole teaching, not a subset`);
	}
});

test("ReceiptArtifact: the paper carries a barcode footer and a chain provenance stub", () => {
	const state = verifiedFixtureState("commit-checkpoint.json");
	const claims = receiptClaims(state.envelope.receipt);
	const markup = html(<ReceiptArtifact receipt={state.envelope.receipt} claims={claims} />);
	assert.ok(markup.includes("paper-surface"), "it renders as the printed receipt it is");
	assert.ok(markup.includes('data-testid="barcode-footer"'));
	assert.ok(markup.includes("<rect"), "the bars are drawn from the mint event hash");
	const text = textOf(markup);
	assert.ok(text.includes("vault-usertrust-prod-1"), "the provenance stub names the chain");
	assert.ok(text.includes("seg-0042"), "and the segment");
});

test("ReceiptArtifact: no bright dark-ground accent is used as text on paper", () => {
	for (const file of ["commit-checkpoint.json", "pr-private.json", "session-fallback.json"]) {
		const state = verifiedFixtureState(file);
		const markup = html(
			<ReceiptArtifact
				receipt={state.envelope.receipt}
				claims={receiptClaims(state.envelope.receipt)}
			/>,
		);
		for (const forbidden of ['text-ut"', "text-warning", "text-danger", "text-white"]) {
			assert.ok(
				!markup.includes(forbidden),
				`${file}: ${forbidden} is unreadable on --color-paper`,
			);
		}
	}
});
