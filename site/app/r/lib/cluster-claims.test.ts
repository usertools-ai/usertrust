/**
 * The cluster receipt's CLAIMS SURFACE (receipt-spec v0.10 §15), pinned
 * character for character — the same house rule `claims.test.ts` applies to
 * the session kind: a redesign may move a sentence, never drop or soften it.
 *
 * The time helpers are pinned on their integer behaviour, because ledger
 * nanoseconds exceed 2^53: a float anywhere in the path rounds a real instant
 * to a neighbouring one, and the window bounds feed the receipt's ID.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { verifiedClusterFixtureState } from "../fixture-harness";
import {
	AMOUNT_SCOPE_CAPTION,
	CUSTOM_MODEL_MEANING,
	LEDGER_ROWS,
	POSTURES_ARE_ATTESTED_ENUMS,
	SESSION_PROMOTION_GATE,
	UNDISCLOSED_PRIVATE_REPO,
	usagePostureClaim,
} from "./claims";
import {
	ACCOUNT_HANDLE_MEANING,
	CLUSTER_AMOUNT_SCOPE_CAPTION,
	CLUSTER_COMPLETENESS_TRUST,
	CLUSTER_LEDGER_ROWS,
	CLUSTER_NON_ARTIFACT,
	CLUSTER_OFFLINE_VERIFIER_PENDING,
	CLUSTER_PROVIDER_SCOPED_CLAIM,
	CLUSTER_REPO_NOTE,
	CLUSTER_SIGNED_BYTES_LABEL,
	clusterComparison,
	clusterHeadlineClaim,
	clusterReceiptClaims,
	clusterUsagePostureClaim,
	coversLine,
	durationLabel,
	idleThresholdLabel,
	LEDGER_TIME_LABEL,
	LEDGER_TIME_NOTE,
	ledgerNsToUtc,
	ledgerWindowSpan,
	modelsLine,
	NS_PER_MS,
	PREVIOUS_RECEIPT_LABEL,
	PREVIOUS_RECEIPT_NOTE,
	SETTLEMENT_TIMES_NOTE,
	SKIPPED_NOTE,
	skippedHeadline,
	skippedWindowSpan,
	WINDOW_TRANSFERS_ROOT_MEANING,
} from "./cluster-claims";
import type { ClusterReceiptDocument, SkippedSincePrevious } from "./wire";

/** Ledger nanoseconds for an RFC 3339 instant, plus a sub-millisecond remainder. */
function nsAt(iso: string, extraNs = 0): string {
	return (BigInt(Date.parse(iso)) * BigInt(1_000_000) + BigInt(extraNs)).toString();
}

/** `base` + `deltaNs`, as the decimal string the wire carries. */
function plus(base: string, deltaNs: number): string {
	return (BigInt(base) + BigInt(deltaNs)).toString();
}

function skipped(count: number, listed: number): SkippedSincePrevious {
	return {
		count,
		windows: Array.from({ length: listed }, (_, index) => ({
			windowStart: String(1_000_000_000 * (2 * index + 1)),
			windowEnd: String(1_000_000_000 * (2 * index + 2)),
			reason: "cluster-void" as const,
		})),
		windowsRoot: "0".repeat(64),
	};
}

// ---------------------------------------------------------------------------
// Every sentence, verbatim
// ---------------------------------------------------------------------------

test("§15.14: the cluster headline claim is the spec's verbatim form", () => {
	assert.equal(
		clusterHeadlineClaim("2026-10-05T21:09:27.890Z", "2026-10-05T21:14:19.000Z", "4.8224"),
		"charged to this agent key between 2026-10-05T21:09:27.890Z and 2026-10-05T21:14:19.000Z — $4.8224",
	);
});

test("R40: only selfDebitsOnly re-scopes its caption to the agent key; the other three are the session table's own", () => {
	assert.equal(
		CLUSTER_AMOUNT_SCOPE_CAPTION.selfDebitsOnly,
		"Charged to this agent key · delegated work bills to the delegate",
	);
	assert.deepEqual(CLUSTER_AMOUNT_SCOPE_CAPTION, {
		...AMOUNT_SCOPE_CAPTION,
		selfDebitsOnly: "Charged to this agent key · delegated work bills to the delegate",
	});
});

test("R21: the provider posture's never-understates claim is scoped to the agent key and the window", () => {
	assert.equal(
		CLUSTER_PROVIDER_SCOPED_CLAIM,
		"never understates the ledger-POSTed charges to this agent key in this window",
	);
	const provider = clusterUsagePostureClaim("provider");
	assert.equal(
		provider.claim,
		"EVERY constituent was priced from provider-reported usage — never understates the ledger-POSTed charges to this agent key in this window.",
	);
	assert.equal(provider.value, "provider");
	assert.equal(provider.label, usagePostureClaim("provider").label);
	for (const posture of ["estimated", "mixed"] as const) {
		assert.deepEqual(clusterUsagePostureClaim(posture), usagePostureClaim(posture));
	}
});

test("every cluster sentence, pinned character for character", () => {
	const pins: Array<[string, string]> = [
		[LEDGER_TIME_LABEL, "LEDGER TIME"],
		[
			LEDGER_TIME_NOTE,
			"the ledger's own timestamps bounding this window, to the millisecond (integer division). They define the window; windowStart also feeds this receipt's ID.",
		],
		[
			SETTLEMENT_TIMES_NOTE,
			"chain timestamps of the first and last settlement in this window — clock CLAIMS on the audit chain's clock, not the ledger's. They are not the window, and no order between the two clocks is checked.",
		],
		[
			ACCOUNT_HANDLE_MEANING,
			"an opaque handle for the ledger account this agent key spends from. It is not the agent key and not a ledger ID, and nothing on this page can turn it into either.",
		],
		[PREVIOUS_RECEIPT_LABEL, "Previous receipt"],
		[
			PREVIOUS_RECEIPT_NOTE,
			"this agent key's previous minted receipt. The resolver checked the link: exactly one earlier receipt of this key, closed at least one idle threshold before this window began, with no receipt of the key in between.",
		],
		[
			SKIPPED_NOTE,
			"each is earlier activity on this agent key that the minter refused to mint; the reason codes are its own. A skipped window is never a receipt and never an amount.",
		],
		[
			WINDOW_TRANSFERS_ROOT_MEANING,
			"commits every ledger transfer of this agent key's account inside the window — charges, voided holds and credits alike — in ledger order. It is a COMMITMENT: checkable by someone with ledger access, never recomputed from this receipt, so this page never marks it passed.",
		],
		[
			CLUSTER_COMPLETENESS_TRUST,
			"this receipt is the operator's SIGNED claim that it covers every charge to this agent key in the window. Without ledger access no one — this page included — can check that nothing is missing; what the signature buys is that the claim cannot later be changed or denied.",
		],
		[
			CLUSTER_NON_ARTIFACT,
			"a cluster receipt attests one agent key's charges over one ledger window, and nothing about any commit, PR, or issue that happens to cite it.",
		],
		[
			CLUSTER_REPO_NOTE,
			"the repository this agent key is configured for — a property of the key, not a claim about any commit, PR, or issue.",
		],
		[CLUSTER_SIGNED_BYTES_LABEL, "Download the signed receipt (its exact bytes)"],
		[
			CLUSTER_OFFLINE_VERIFIER_PENDING,
			"usertrust-verify does not read cluster receipts yet, so there is no offline command to run for this one: the check ledger below is the resolver's verification, and these bytes are exactly what an offline verifier will check.",
		],
	];
	for (const [actual, expected] of pins) assert.equal(actual, expected);
});

test("R14/R15: the cluster comparison is a non-artifact, the promotion gate, and the completeness trust", () => {
	assert.deepEqual(clusterComparison(), [
		{ axis: "NO ARTIFACT TO COMPARE", body: CLUSTER_NON_ARTIFACT },
		{ axis: "PROMOTION", body: SESSION_PROMOTION_GATE },
		{ axis: "COMPLETENESS", body: CLUSTER_COMPLETENESS_TRUST },
	]);
});

// ---------------------------------------------------------------------------
// Ledger time: integer division, never a float
// ---------------------------------------------------------------------------

test("ledgerNsToUtc: integer division to the millisecond, RFC 3339 UTC", () => {
	assert.equal(NS_PER_MS, BigInt(1_000_000));
	assert.equal(ledgerNsToUtc("1791234567890123456"), "2026-10-05T21:09:27.890Z");
	assert.equal(ledgerNsToUtc("1791234567890123456"), new Date(1791234567890).toISOString());
	// A float path rounds this one UP to .891 (Number() lands on ...891000000);
	// integer division truncates, which is what "to the millisecond" means.
	assert.equal(ledgerNsToUtc("1791234567890999999"), "2026-10-05T21:09:27.890Z");
	assert.equal(ledgerNsToUtc("0"), "1970-01-01T00:00:00.000Z");
});

test("ledgerNsToUtc: the u64 maximum formats without throwing", () => {
	assert.doesNotThrow(() => ledgerNsToUtc("18446744073709551615"));
	assert.equal(ledgerNsToUtc("18446744073709551615"), "2554-07-21T23:34:33.709Z");
});

test("ledgerWindowSpan: #199's time-span style, in UTC — one day, or a midnight crossing", () => {
	const cases: Array<[string, string, string]> = [
		["1791234567890123456", "1791234859000000000", "Oct 5 · 21:09–21:14 UTC"],
		[
			nsAt("2026-10-05T14:02:11.000Z", 7),
			nsAt("2026-10-05T14:19:47.000Z"),
			"Oct 5 · 14:02–14:19 UTC",
		],
		[
			nsAt("2026-10-05T23:58:30.000Z", 123_456),
			nsAt("2026-10-06T00:03:05.000Z"),
			"Oct 5 23:58 → Oct 6 00:03 UTC",
		],
		[nsAt("2026-10-05T09:00:00.000Z"), nsAt("2026-10-05T09:00:00.000Z"), "Oct 5 · 09:00–09:00 UTC"],
	];
	for (const [start, end, expected] of cases) {
		assert.equal(ledgerWindowSpan(start, end), expected, `${start} → ${end}`);
	}
});

test("durationLabel: integer nanosecond math, whole seconds floored", () => {
	const base = "1791234567890123456";
	const cases: Array<[number, string]> = [
		[0, "under 1 s"],
		[999_999_999, "under 1 s"],
		[1_000_000_000, "1 s"],
		[48_000_000_000, "48 s"],
		[48_999_999_999, "48 s"],
		[60_000_000_000, "1 min"],
		[120_000_000_000, "2 min"],
		[1_056_000_000_000, "17 min 36 s"],
		[1_056_999_999_999, "17 min 36 s"],
		[3_600_000_000_000, "1 h"],
		[7_440_000_000_000, "2 h 4 min"],
		[7_445_000_000_000, "2 h 4 min"],
	];
	for (const [delta, expected] of cases) {
		assert.equal(durationLabel(base, plus(base, delta)), expected, `${delta} ns`);
	}
	assert.equal(durationLabel("0", "18446744073709551615"), "5124095 h 34 min");
});

test("idleThresholdLabel: whole hours → h, whole minutes → min, whole seconds → s, else ns", () => {
	const cases: Array<[string, string]> = [
		["600000000000", "10 min"],
		["3600000000000", "1 h"],
		["86400000000000", "24 h"],
		["60000000000", "1 min"],
		["61000000000", "61 s"],
		["5400000000000", "90 min"],
		["60000000001", "60000000001 ns"],
	];
	for (const [ns, expected] of cases) assert.equal(idleThresholdLabel(ns), expected, ns);
});

test("skippedWindowSpan: HH:MM:SS → HH:MM:SS UTC from ledger nanoseconds", () => {
	assert.equal(
		skippedWindowSpan("1791237986123456789", "1791238106123456789"),
		"22:06:26 → 22:08:26 UTC",
	);
});

// ---------------------------------------------------------------------------
// Glance lines
// ---------------------------------------------------------------------------

test("coversLine: governed calls, en-US grouping, singular at one", () => {
	assert.equal(coversLine(1), "1 governed call");
	assert.equal(coversLine(23), "23 governed calls");
	assert.equal(coversLine(1234), "1,234 governed calls");
});

test("modelsLine (R24): catalog names, and custom EXPLAINED, never shown as a model name", () => {
	assert.equal(modelsLine(["claude-sonnet-4-5"]), "claude-sonnet-4-5");
	assert.equal(modelsLine(["claude-sonnet-4-5", "gpt-5"]), "claude-sonnet-4-5 · gpt-5");
	assert.equal(
		modelsLine(["claude-opus-4-1", "custom", "gpt-5"]),
		`claude-opus-4-1 · gpt-5 · ${CUSTOM_MODEL_MEANING}`,
	);
	assert.equal(modelsLine(["custom"]), CUSTOM_MODEL_MEANING);
	assert.equal(modelsLine([]), "");
});

test("skippedHeadline: count, singular at one, and the truncation named past 16", () => {
	assert.equal(skippedHeadline(skipped(1, 1)), "1 earlier window wasn’t receipted");
	assert.equal(skippedHeadline(skipped(3, 3)), "3 earlier windows weren’t receipted");
	assert.equal(skippedHeadline(skipped(16, 16)), "16 earlier windows weren’t receipted");
	assert.equal(
		skippedHeadline(skipped(17, 16)),
		"17 earlier windows weren’t receipted — the first 16 are listed; windowsRoot commits all 17",
	);
	const cl3 = verifiedClusterFixtureState("cluster/skipped.json").envelope.receipt.event.data;
	const cl4 = verifiedClusterFixtureState("cluster/skipped-overflow.json").envelope.receipt.event
		.data;
	assert.ok(cl3.skippedSincePrevious && cl4.skippedSincePrevious);
	assert.equal(skippedHeadline(cl3.skippedSincePrevious), "3 earlier windows weren’t receipted");
	assert.equal(
		skippedHeadline(cl4.skippedSincePrevious),
		"20 earlier windows weren’t receipted — the first 16 are listed; windowsRoot commits all 20",
	);
});

// ---------------------------------------------------------------------------
// The check ledger
// ---------------------------------------------------------------------------

const CLUSTER_MEANINGS: Record<string, string> = {
	registry:
		"step 3: the signed document's receiptId equals the ID it ARRIVED under — this URL — and RECOMPUTES from the chain, the account handle and the window start. A cluster receipt's ID is derived from what it signs, never issued in advance.",
	semantics: `the cluster rules (account handle, window bounds, idle threshold, skipped-window list), §2's presence/exclusion rules, the spend bounds, and POSTURE ENUM VALIDITY — ${POSTURES_ARE_ATTESTED_ENUMS}`,
	derivations:
		"transferSetRoot recomputed over the ≤ 32-pair transferSet, and windowsRoot over a complete (≤ 16) skipped-window list. Nothing to recompute → notApplicable, and each root stays a commitment; windowTransfersRoot is always one. amountUsd is never stored and never compared.",
	predecessorLinkage:
		"previousReceiptId names this agent key's previous minted receipt: exactly one, closed at least one idle threshold before this window began, with no receipt of the key in between. notApplicable when none is named and the key has no earlier receipt.",
};

test("CLUSTER_LEDGER_ROWS keeps the ledger's rows and order, and differs in EXACTLY four meanings", () => {
	assert.deepEqual(
		CLUSTER_LEDGER_ROWS.map(({ name, label, group }) => ({ name, label, group })),
		LEDGER_ROWS.map(({ name, label, group }) => ({ name, label, group })),
	);
	const changed = CLUSTER_LEDGER_ROWS.filter(
		(row, index) => row.meaning !== LEDGER_ROWS[index]?.meaning,
	).map((row) => row.name);
	assert.deepEqual(changed, ["registry", "semantics", "derivations", "predecessorLinkage"]);
	for (const row of CLUSTER_LEDGER_ROWS) {
		const expected = CLUSTER_MEANINGS[row.name];
		if (expected !== undefined) assert.equal(row.meaning, expected, row.name);
	}
});

// ---------------------------------------------------------------------------
// The derived view model, on the four conforming fixtures
// ---------------------------------------------------------------------------

function claimsOf(file: string) {
	return clusterReceiptClaims(verifiedClusterFixtureState(file).envelope.receipt);
}

test("CL1 first.json: a first receipt — no predecessor, nothing skipped, no repository", () => {
	const claims = claimsOf("cluster/first.json");
	assert.equal(claims.amountUsd, "4.8224");
	assert.equal(claims.windowStartUtc, "2026-10-05T21:09:27.890Z");
	assert.equal(claims.windowEndUtc, "2026-10-05T21:14:19.000Z");
	assert.equal(claims.windowSpan, "Oct 5 · 21:09–21:14 UTC");
	assert.equal(claims.duration, "4 min 51 s");
	assert.equal(claims.idleThreshold, "10 min");
	assert.equal(
		claims.headline,
		"charged to this agent key between 2026-10-05T21:09:27.890Z and 2026-10-05T21:14:19.000Z — $4.8224",
	);
	assert.equal(claims.covers, "2 governed calls");
	assert.equal(claims.models, "claude-sonnet-4-5");
	assert.equal(claims.providers, "anthropic");
	assert.equal(claims.account, "a1_LaVASNboDGARWVkgiqzrkF");
	assert.equal(claims.repo, undefined);
	assert.equal(claims.previousReceiptId, undefined);
	assert.equal(claims.skipped, undefined);
	assert.equal(claims.amountCaption, CLUSTER_AMOUNT_SCOPE_CAPTION.selfDebitsOnly);
	assert.equal(claims.delegation.value, "selfDebitsOnly");
	assert.equal(claims.usage.claim, clusterUsagePostureClaim("provider").claim);
	assert.equal(claims.pricing.value, "exact");
	assert.equal(claims.transfers.rootIsCommitment, false);
	assert.deepEqual(claims.windowTransfers, {
		root: "bf55f86dc161aedacb27e557e3bb8f206a6b01369942671d23dcb4240da31603",
		count: 6,
		meaning: WINDOW_TRANSFERS_ROOT_MEANING,
	});
	assert.deepEqual(claims.comparison, clusterComparison());
	assert.deepEqual(
		claims.lines.map((line) => [line.label, line.value, line.kind]),
		[
			["Transfers", "2", "item"],
			["Pricing", "exact · 2026-10-01", "item"],
			["Total", "48,224 ut", "total"],
		],
	);
});

test("CL2 chained.json: the named predecessor and a disclosed repository", () => {
	const claims = claimsOf("cluster/chained.json");
	assert.equal(claims.amountUsd, "12.0000");
	assert.equal(claims.windowSpan, "Oct 5 · 21:39–21:51 UTC");
	assert.equal(claims.duration, "12 min 7 s");
	assert.equal(claims.covers, "3 governed calls");
	assert.equal(claims.models, "claude-sonnet-4-5 · gpt-5");
	assert.equal(claims.providers, "anthropic · openai");
	assert.equal(claims.previousReceiptId, "ut1_6UxMu41H9LYXJYXV2CEfoK");
	assert.deepEqual(claims.repo, {
		repoId: "github.com:R_kgDOK1x2Yw",
		undisclosed: false,
		label: "github.com:R_kgDOK1x2Yw",
	});
	assert.equal(claims.skipped, undefined);
});

test("CL2 with a keyed r1_ repoId: the repository renders as undisclosed, never as its key", () => {
	const receipt = structuredClone(
		verifiedClusterFixtureState("cluster/chained.json").envelope.receipt,
	) as ClusterReceiptDocument;
	receipt.work = { kind: "cluster", repoId: "r1_9f2a7c31e8b4" };
	receipt.event.data.work = { kind: "cluster", repoId: "r1_9f2a7c31e8b4" };
	assert.deepEqual(clusterReceiptClaims(receipt).repo, {
		repoId: "r1_9f2a7c31e8b4",
		undisclosed: true,
		label: UNDISCLOSED_PRIVATE_REPO,
	});
});

test("CL3 skipped.json: three refused windows, every one listed with its span, duration and reason", () => {
	const claims = claimsOf("cluster/skipped.json");
	assert.equal(claims.amountUsd, "0.3150");
	assert.equal(claims.duration, "48 s");
	assert.equal(claims.covers, "1 governed call");
	assert.equal(claims.previousReceiptId, "ut1_3oMvgmMUkN4TNz2hiVEiRd");
	assert.deepEqual(claims.skipped, {
		headline: "3 earlier windows weren’t receipted",
		windows: [
			{
				startUtc: "2026-10-05T22:06:26.123Z",
				endUtc: "2026-10-05T22:08:26.123Z",
				span: "22:06:26 → 22:08:26 UTC",
				duration: "2 min",
				reason: "cluster-void",
			},
			{
				startUtc: "2026-10-05T22:38:26.123Z",
				endUtc: "2026-10-05T22:39:26.123Z",
				span: "22:38:26 → 22:39:26 UTC",
				duration: "1 min",
				reason: "estimated-transfer",
			},
			{
				startUtc: "2026-10-05T23:19:26.123Z",
				endUtc: "2026-10-05T23:24:26.123Z",
				span: "23:19:26 → 23:24:26 UTC",
				duration: "5 min",
				reason: "cluster-void",
			},
		],
	});
});

test("CL4 skipped-overflow.json: 20 refused, 16 listed; no transfer list; custom explained; 1 h idle", () => {
	const claims = claimsOf("cluster/skipped-overflow.json");
	assert.equal(claims.amountUsd, "245.0000");
	assert.equal(claims.windowSpan, "Oct 6 · 20:53–21:34 UTC");
	assert.equal(claims.duration, "41 min 13 s");
	assert.equal(claims.idleThreshold, "1 h");
	assert.equal(claims.covers, "40 governed calls");
	assert.equal(claims.models, `claude-opus-4-1 · gpt-5 · ${CUSTOM_MODEL_MEANING}`);
	assert.equal(claims.catalog.hasCustom, true);
	assert.equal(claims.account, "a1_4HsRUMjopC7DXxL78ne2uk");
	assert.equal(claims.repo, undefined);
	assert.equal(claims.previousReceiptId, undefined);
	assert.equal(
		claims.skipped?.headline,
		"20 earlier windows weren’t receipted — the first 16 are listed; windowsRoot commits all 20",
	);
	assert.equal(claims.skipped?.windows.length, 16);
	assert.equal(claims.skipped?.windows[0]?.span, "04:53:20 → 04:56:20 UTC");
	assert.equal(claims.skipped?.windows[0]?.duration, "3 min");
	assert.equal(claims.skipped?.windows[15]?.reason, "snapshot-not-on-chain");
	assert.equal(claims.transfers.rootIsCommitment, true);
	assert.equal(claims.pricing.value, "conservative");
	assert.equal(claims.windowTransfers.count, 86);
});
