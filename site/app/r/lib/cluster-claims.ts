/**
 * The CLUSTER receipt's claims surface (receipt-spec v0.10 §15): every sentence
 * the page asserts about a `scope: "cluster"` receipt, and the time arithmetic
 * it performs on the ledger's nanosecond window bounds.
 *
 * Same house rule as `claims.ts`, whose header explains it: the page's honesty
 * is made of strings, so each one is an exported constant a test pins
 * character for character. A sentence the session kind already owns is
 * imported from there, never re-spelled — two spellings of one rule drift.
 *
 * A separate module because a cluster receipt makes DIFFERENT claims: it
 * attests every charge to one agent key inside one ledger window. It has no
 * governed session, no association posture and no generation, so the session
 * sentences that name those (the provider posture's scope, the amount caption,
 * four check-ledger meanings) are re-scoped here rather than reused, and the
 * page never prints a session claim the receipt never made.
 */

import type { InvoiceLine } from "./card-model";
import {
	AMOUNT_SCOPE_CAPTION,
	amountUsdFromUsertokens,
	type CatalogRendering,
	type ComparisonStep,
	CUSTOM_MODEL_MEANING,
	catalogRendering,
	delegationScopeClaim,
	LEDGER_ROWS,
	type LedgerRow,
	POSTURES_ARE_ATTESTED_ENUMS,
	type PostureClaim,
	pricingPostureClaim,
	SESSION_PROMOTION_GATE,
	type TransferSetRendering,
	transferSetRendering,
	UNDISCLOSED_PRIVATE_REPO,
	usagePostureClaim,
} from "./claims";
import type {
	ClusterProjection,
	ClusterReceiptDocument,
	ClusterWork,
	DelegationPosture,
	SkippedSincePrevious,
	SkipReason,
	Spend,
	StepResult,
} from "./wire";

// ===========================================================================
// §15.14 — the claim and the amount's scope
// ===========================================================================

/** §15.14, verbatim form — the standalone page's claim, with the window in ledger time. */
export function clusterHeadlineClaim(
	windowStartUtc: string,
	windowEndUtc: string,
	amountUsd: string,
): string {
	return `charged to this agent key between ${windowStartUtc} and ${windowEndUtc} — $${amountUsd}`;
}

/**
 * R40 for a cluster receipt. Only `selfDebitsOnly` names the subject, so only
 * it is re-scoped: "charged to this session" on a cluster receipt would name a
 * session that does not exist. The other three captions name no subject and
 * are the session table's own.
 */
export const CLUSTER_AMOUNT_SCOPE_CAPTION: Record<DelegationPosture, string> = {
	...AMOUNT_SCOPE_CAPTION,
	selfDebitsOnly: "Charged to this agent key · delegated work bills to the delegate",
};

/** R21 / §10.5's scoped never-understates claim, re-scoped to the agent key and the window. */
export const CLUSTER_PROVIDER_SCOPED_CLAIM =
	"never understates the ledger-POSTed charges to this agent key in this window";

/**
 * `usagePostureClaim` with the provider claim re-scoped. The session wording
 * ("of this governed session") would scope the bound to a session this receipt
 * does not have; `estimated`/`mixed` name no subject and stay identical.
 */
export function clusterUsagePostureClaim(usagePosture: Spend["usagePosture"]): PostureClaim {
	const claim = usagePostureClaim(usagePosture);
	if (usagePosture !== "provider") return claim;
	return {
		...claim,
		claim: `EVERY constituent was priced from provider-reported usage — ${CLUSTER_PROVIDER_SCOPED_CLAIM}.`,
	};
}

// ===========================================================================
// Ledger time — nanoseconds as decimal strings, integer math only
// ===========================================================================

/**
 * Ledger nanoseconds exceed 2^53, so every conversion is BigInt and INTEGER:
 * `Number("1791234567890999999") / 1e6` rounds to the next millisecond, which
 * would print an instant the ledger never recorded. `BigInt(…)` and not a
 * literal: the site targets ES2017, where TypeScript rejects `1_000_000n`.
 */
export const NS_PER_MS = BigInt(1_000_000);
const NS_PER_S = BigInt(1_000_000_000);
const SECONDS_PER_MINUTE = BigInt(60);
const SECONDS_PER_HOUR = BigInt(3_600);
const ZERO = BigInt(0);

/**
 * A ledger nanosecond bound as RFC 3339 UTC, truncated to the millisecond.
 * The u64 maximum is year 2554, well inside `Date`'s range, so no value the
 * wire accepts can throw here.
 */
export function ledgerNsToUtc(ns: string): string {
	return ledgerDate(ns).toISOString();
}

function ledgerDate(ns: string): Date {
	return new Date(Number(BigInt(ns) / NS_PER_MS));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (value: number) => String(value).padStart(2, "0");
const utcDay = (date: Date) => `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
const utcMinute = (date: Date) => `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
const utcSecond = (date: Date) => `${utcMinute(date)}:${pad2(date.getUTCSeconds())}`;

/**
 * The glance card's window, in the session card's time-span style: "Oct 5 ·
 * 14:02–14:19 UTC" within one UTC day, "Oct 5 23:58 → Oct 6 00:03 UTC" across
 * midnight. UTC, never the reader's zone: the page renders on the server, and
 * a zone it guessed would be a claim nobody made.
 */
export function ledgerWindowSpan(windowStart: string, windowEnd: string): string {
	const start = ledgerDate(windowStart);
	const end = ledgerDate(windowEnd);
	return start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10)
		? `${utcDay(start)} · ${utcMinute(start)}–${utcMinute(end)} UTC`
		: `${utcDay(start)} ${utcMinute(start)} → ${utcDay(end)} ${utcMinute(end)} UTC`;
}

/**
 * One refused window's bounds WITH its UTC day: a skipped window can precede
 * this receipt by hours or days, and a bare clock time would leave the reader
 * to guess which day it was. "Oct 5 · 22:06:26 → 22:08:26 UTC" within a day,
 * "Oct 5 23:58:01 → Oct 6 00:02:10 UTC" across midnight. A window from another
 * UTC year than `referenceYear` (the receipt window's) states its year too —
 * "Oct 5 2025 · …" — or a refusal a year old would read as the same day.
 */
export function skippedWindowSpan(
	windowStart: string,
	windowEnd: string,
	referenceYear?: number,
): string {
	const start = ledgerDate(windowStart);
	const end = ledgerDate(windowEnd);
	const day = (date: Date) =>
		referenceYear === undefined || date.getUTCFullYear() === referenceYear
			? utcDay(date)
			: `${utcDay(date)} ${date.getUTCFullYear()}`;
	return start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10)
		? `${day(start)} · ${utcSecond(start)} → ${utcSecond(end)} UTC`
		: `${day(start)} ${utcSecond(start)} → ${day(end)} ${utcSecond(end)} UTC`;
}

/**
 * A window's length — "17 min 36 s", "48 s", "2 h 4 min", "under 1 s" — from
 * the nanosecond bounds by integer division, whole seconds floored. An
 * instant-long window is legal (`windowEnd === windowStart`) and reads as
 * "under 1 s", never "0 s", which would look like an empty window.
 */
export function durationLabel(windowStart: string, windowEnd: string): string {
	const seconds = (BigInt(windowEnd) - BigInt(windowStart)) / NS_PER_S;
	if (seconds === ZERO) return "under 1 s";
	const hours = seconds / SECONDS_PER_HOUR;
	const minutes = (seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE;
	const rest = seconds % SECONDS_PER_MINUTE;
	if (hours > ZERO) return minutes > ZERO ? `${hours} h ${minutes} min` : `${hours} h`;
	if (minutes > ZERO) return rest > ZERO ? `${minutes} min ${rest} s` : `${minutes} min`;
	return `${rest} s`;
}

/**
 * The signed idle threshold, in the largest unit that states it EXACTLY: a
 * threshold of 61 s is not "1 min", and one that is not whole seconds is
 * printed in nanoseconds rather than rounded into a rule the minter never used.
 */
export function idleThresholdLabel(ns: string): string {
	const value = BigInt(ns);
	if (value % NS_PER_S !== ZERO) return `${ns} ns`;
	const seconds = value / NS_PER_S;
	if (seconds % SECONDS_PER_HOUR === ZERO) return `${seconds / SECONDS_PER_HOUR} h`;
	if (seconds % SECONDS_PER_MINUTE === ZERO) return `${seconds / SECONDS_PER_MINUTE} min`;
	return `${seconds} s`;
}

export const LEDGER_TIME_LABEL = "LEDGER TIME";

export const LEDGER_TIME_NOTE =
	"the ledger's own timestamps bounding this window, to the millisecond (integer division). They define the window; windowStart also feeds this receipt's ID.";

/**
 * R27's split, extended to a second clock: `startedAt`/`endedAt` are the audit
 * chain's clock, the window is the ledger's, and the page never orders one
 * against the other.
 */
export const SETTLEMENT_TIMES_NOTE =
	"chain timestamps of the first and last settlement in this window — clock CLAIMS on the audit chain's clock, not the ledger's. They are not the window, and no order between the two clocks is checked.";

// ===========================================================================
// The agent key, the chain of receipts, and the windows that got none
// ===========================================================================

/** §15.7 — what the `a1_` handle is, and the two things it is NOT. */
export const ACCOUNT_HANDLE_MEANING =
	"an opaque handle for the ledger account this agent key spends from. It is not the agent key and not a ledger ID, and nothing on this page can turn it into either.";

/** "23 governed calls" — one per settled transfer pair. */
export function coversLine(transferCount: number): string {
	return `${transferCount.toLocaleString("en-US")} governed call${transferCount === 1 ? "" : "s"}`;
}

/**
 * R24 — catalog names as themselves; the `"custom"` literal EXPLAINED, never
 * shown as a model name (it stands for N models). Empty when there are none,
 * so the page can omit the row instead of printing a blank.
 */
export function modelsLine(models: string[]): string {
	const { catalog, hasCustom } = catalogRendering(models);
	return (hasCustom ? [...catalog, CUSTOM_MODEL_MEANING] : catalog).join(" · ");
}

export const PREVIOUS_RECEIPT_LABEL = "Previous receipt";

/** What the predecessor link means — and that the RESOLVER checked it (a 200 requires `passed`). */
export const PREVIOUS_RECEIPT_NOTE =
	"this agent key's previous minted receipt. The resolver checked the link: exactly one earlier receipt of this key, closed at least one idle threshold before this window began, with no receipt of the key in between.";

/**
 * §15.6 — the refused windows' headline. Past 16 the list is truncated, and
 * the line says so: a reader counting 16 rows under "20 windows" must be told
 * where the other 4 are, or the list reads as the whole story.
 */
export function skippedHeadline(skipped: SkippedSincePrevious): string {
	const { count, windows } = skipped;
	const total = count.toLocaleString("en-US");
	const headline =
		count === 1
			? "1 earlier window wasn’t receipted"
			: `${total} earlier windows weren’t receipted`;
	return count > windows.length
		? `${headline} — the first ${windows.length} are listed; windowsRoot commits all ${total}`
		: headline;
}

/** Why the windows are there, and the two things a refused window never is. */
export const SKIPPED_NOTE =
	"each is earlier activity on this agent key that the minter refused to mint; the reason codes are its own. A skipped window is never a receipt and never an amount.";

/**
 * `windowTransfersRoot` is a COMMITMENT in every case: no receipt carries the
 * window's full transfer list, so nothing here can recompute it, and a pass
 * mark beside it would claim a check that never ran.
 */
export const WINDOW_TRANSFERS_ROOT_MEANING =
	"commits every ledger transfer of this agent key's account inside the window — charges, voided holds and credits alike — in ledger order. It is a COMMITMENT: checkable by someone with ledger access, never recomputed from this receipt, so this page never marks it passed.";

/**
 * R25's recomputable case, worded for a cluster receipt: the shared sentence
 * credits the OFFLINE verifier, which does not read cluster receipts yet. The
 * resolver's step 8 is what recomputed this root (the DERIVATIONS row).
 */
export const CLUSTER_TRANSFER_SET_ROOT_LISTED =
	"the digest of the pair list this receipt lists — recomputable from it by verification step 8; the check ledger's DERIVATIONS row shows what the resolver's own run found.";

export const CLUSTER_TRANSFER_SET_ROOT_RECOMPUTABLE =
	"the recomputable digest of the pair list — recomputed by verification step 8 (the check ledger's DERIVATIONS row), from the pairs this receipt lists.";

/** The trust a cluster receipt asks for, named: completeness is SIGNED, not checkable here. */
export const CLUSTER_COMPLETENESS_TRUST =
	"this receipt is the operator's SIGNED claim that it covers every charge to this agent key in the window. Without ledger access no one — this page included — can check that nothing is missing; what the signature buys is that the claim cannot later be changed or denied.";

/** R14 for the cluster kind — a defined NON-artifact, exactly as a session receipt is. */
export const CLUSTER_NON_ARTIFACT =
	"a cluster receipt attests one agent key's charges over one ledger window, and nothing about any commit, PR, or issue that happens to cite it.";

/** §15.8 — `repoId` is a property of the key's account, never of one receipt. */
export const CLUSTER_REPO_NOTE =
	"the repository this agent key is configured for — a property of the key, not a claim about any commit, PR, or issue.";

/** R15 — the comparison a reader must make, for a receipt that has no artifact to compare. */
export function clusterComparison(): ComparisonStep[] {
	return [
		{ axis: "NO ARTIFACT TO COMPARE", body: CLUSTER_NON_ARTIFACT },
		{ axis: "PROMOTION", body: SESSION_PROMOTION_GATE },
		{ axis: "COMPLETENESS", body: CLUSTER_COMPLETENESS_TRUST },
	];
}

// ===========================================================================
// Offline verification — the signed bytes, and no command yet
// ===========================================================================

/**
 * `usertrust-verify receipt` refuses `scope: "cluster"` today, so the page
 * offers the exact signed bytes instead of a command that would fail in the
 * reader's terminal.
 */
export const CLUSTER_SIGNED_BYTES_LABEL = "Download the signed receipt (its exact bytes)";

export const CLUSTER_OFFLINE_VERIFIER_PENDING =
	"usertrust-verify does not read cluster receipts yet, so there is no offline command to run for this one: the check ledger below is the resolver's verification, and these bytes are exactly what an offline verifier will check.";

// ===========================================================================
// §6.3 — the check ledger, cluster meanings
// ===========================================================================

/**
 * The four rows whose session meaning would explain a check the resolver did
 * not run on a cluster receipt: its ID is derived from what it signs (not
 * issued at reservation), its semantics add the cluster rules, it can carry a
 * second recomputable root, and its predecessor is the key's previous receipt
 * (not a generation). Every other row's meaning is the same check.
 */
const CLUSTER_LEDGER_MEANINGS: Partial<Record<LedgerRow["name"], string>> = {
	registry:
		"step 3: the signed document's receiptId equals the ID it ARRIVED under — this URL — and RECOMPUTES from the chain, the account handle and the window start. A cluster receipt's ID is derived from what it signs, never issued in advance.",
	semantics: `the cluster rules (account handle, window bounds, idle threshold, skipped-window list), §2's presence/exclusion rules, the spend bounds, and POSTURE ENUM VALIDITY — ${POSTURES_ARE_ATTESTED_ENUMS}`,
	derivations:
		"transferSetRoot recomputed over the ≤ 32-pair transferSet, and windowsRoot over a complete (≤ 16) skipped-window list. Nothing to recompute → notApplicable, and each root stays a commitment; windowTransfersRoot is always one. amountUsd is never stored and never compared.",
	predecessorLinkage:
		"previousReceiptId names this agent key's previous minted receipt: exactly one, closed at least one idle threshold before this window began, with no receipt of the key in between. notApplicable when none is named and the key has no earlier receipt.",
};

/** `LEDGER_ROWS` — same rows, labels, groups and order — with the four cluster meanings. */
export const CLUSTER_LEDGER_ROWS: readonly LedgerRow[] = LEDGER_ROWS.map((row) => {
	const meaning = CLUSTER_LEDGER_MEANINGS[row.name];
	return meaning === undefined ? row : { ...row, meaning };
});

// ===========================================================================
// Derived view model — one pass over a verified cluster receipt
// ===========================================================================

/** R18's split for the cluster kind: the keyed `r1_` form never renders as its key. */
export interface ClusterRepo {
	repoId: string;
	undisclosed: boolean;
	label: string;
}

/** One listed refused window, ready to render. Never an amount: the wire carries none. */
export interface SkippedWindowView {
	startUtc: string;
	endUtc: string;
	span: string;
	duration: string;
	reason: SkipReason;
}

/** Everything the cluster view needs, derived once (the `receiptClaims` precedent). */
export interface ClusterReceiptClaims {
	projection: ClusterProjection;
	work: ClusterWork;
	amountUsd: string;
	windowStartUtc: string;
	windowEndUtc: string;
	windowSpan: string;
	duration: string;
	idleThreshold: string;
	headline: string;
	covers: string;
	/** `modelsLine` — "" when the receipt names none. */
	models: string;
	providers: string;
	account: string;
	/** Present iff the account is bound to a repository (`repoId` key-present). */
	repo?: ClusterRepo;
	/** Present iff the receipt names its predecessor; the wire requires `predecessorLinkage: passed` then. */
	previousReceiptId?: string;
	/** Present iff `skippedSincePrevious` is: the listed windows only, never the unlisted rest. */
	skipped?: { headline: string; windows: SkippedWindowView[] };
	usage: PostureClaim;
	pricing: PostureClaim;
	/** R38/R39 — what the amount COVERS. */
	delegation: PostureClaim;
	/** R40 — the cluster caption under the unqualified amount. */
	amountCaption: string;
	/** The models' R24 rendering, for the custom-literal line. */
	catalog: CatalogRendering;
	transfers: TransferSetRendering;
	windowTransfers: { root: string; count: number; meaning: string };
	comparison: ComparisonStep[];
	/**
	 * The invoice's Transfers / Pricing / Total. `invoiceLines` builds the same
	 * three for a session receipt but is typed to the session claims; these come
	 * from the cluster projection's identical `spend` and `pricing` members.
	 */
	lines: InvoiceLine[];
}

/**
 * `derivations` is the resolver's step-8 result for THIS receipt: the
 * transfer-set sentence says the root WAS recomputed only when that row says
 * so, never because the pairs happen to be listed.
 */
export function clusterReceiptClaims(
	receipt: ClusterReceiptDocument,
	derivations: StepResult,
): ClusterReceiptClaims {
	const projection = receipt.event.data;
	const { spend } = projection;
	const amountUsd = amountUsdFromUsertokens(spend.assessedUsertokens);
	const windowStartUtc = ledgerNsToUtc(projection.windowStart);
	const windowEndUtc = ledgerNsToUtc(projection.windowEnd);
	const repoId = projection.work.repoId;
	const skipped = projection.skippedSincePrevious;
	const pricing = pricingPostureClaim(spend.pricingPosture);
	const versions = projection.pricing.tableVersions.join(" · ");
	return {
		projection,
		work: projection.work,
		amountUsd,
		windowStartUtc,
		windowEndUtc,
		windowSpan: ledgerWindowSpan(projection.windowStart, projection.windowEnd),
		duration: durationLabel(projection.windowStart, projection.windowEnd),
		idleThreshold: idleThresholdLabel(projection.idleThresholdNs),
		headline: clusterHeadlineClaim(windowStartUtc, windowEndUtc, amountUsd),
		covers: coversLine(spend.transferCount),
		models: modelsLine(projection.models),
		providers: projection.providers.join(" · "),
		account: projection.account,
		repo:
			repoId === undefined
				? undefined
				: {
						repoId,
						undisclosed: repoId.startsWith("r1_"),
						label: repoId.startsWith("r1_") ? UNDISCLOSED_PRIVATE_REPO : repoId,
					},
		previousReceiptId: projection.previousReceiptId,
		skipped:
			skipped === undefined
				? undefined
				: {
						headline: skippedHeadline(skipped),
						windows: skipped.windows.map((window) => ({
							startUtc: ledgerNsToUtc(window.windowStart),
							endUtc: ledgerNsToUtc(window.windowEnd),
							span: skippedWindowSpan(
								window.windowStart,
								window.windowEnd,
								ledgerDate(projection.windowStart).getUTCFullYear(),
							),
							duration: durationLabel(window.windowStart, window.windowEnd),
							reason: window.reason,
						})),
					},
		usage: clusterUsagePostureClaim(spend.usagePosture),
		pricing,
		delegation: delegationScopeClaim(projection.delegationPosture),
		amountCaption: CLUSTER_AMOUNT_SCOPE_CAPTION[projection.delegationPosture],
		catalog: catalogRendering(projection.models),
		transfers: clusterTransferSetRendering(projection, derivations),
		windowTransfers: {
			root: projection.windowTransfersRoot,
			count: projection.windowTransferCount,
			meaning: WINDOW_TRANSFERS_ROOT_MEANING,
		},
		comparison: clusterComparison(),
		lines: [
			{ label: "Transfers", value: String(spend.transferCount), kind: "item" },
			{
				label: "Pricing",
				value: versions.length > 0 ? `${pricing.value} · ${versions}` : pricing.value,
				kind: "item",
			},
			{
				label: "Total",
				value: `${spend.assessedUsertokens.toLocaleString("en-US")} ut`,
				kind: "total",
			},
		],
	};
}

/**
 * R25's split, with cluster wording for the listed case: "recomputed" only
 * when the resolver's DERIVATIONS row passed; otherwise only "recomputable",
 * because a sentence must not claim a check its own ledger row does not show.
 */
function clusterTransferSetRendering(
	projection: ClusterProjection,
	derivations: StepResult,
): TransferSetRendering {
	const rendering = transferSetRendering(projection);
	if (rendering.rootIsCommitment) return rendering;
	return {
		...rendering,
		rootMeaning:
			derivations === "passed"
				? CLUSTER_TRANSFER_SET_ROOT_RECOMPUTABLE
				: CLUSTER_TRANSFER_SET_ROOT_LISTED,
	};
}
