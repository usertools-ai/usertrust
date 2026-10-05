/**
 * Cluster-receipt vectors (receipt-spec v0.10 §15) — one mutation of one of
 * the four conforming fixtures under `cluster/`, each aimed at ONE contract
 * rule.
 *
 * Two populations share the list. A REJECTION vector breaks exactly one rule
 * and names where it must fail closed: the protocol-error shell
 * (`schemaInvalid` for a document or shape rule, `verdictAlgebra` for the
 * predecessor-linkage rule) or an integrity failure on a named obligation
 * (R1, R4, R39). A BOUNDARY control (`expect: { kind: "verified" }`) sits
 * exactly ON a limit and must still verify: a validator tightened past the
 * contract is broken, not strict, and only an accepted just-inside value
 * proves that the just-outside refusal is the limit rather than the field.
 *
 * Every receipt mutation goes through `applyClusterVector`, which re-encodes
 * `receiptBytes` from the mutated receipt so R4 still AGREES — otherwise every
 * one would stop at the byte check and no schema rule would ever be reached.
 * `conformance.test.ts` (the independent harness) and `lib/wire-cluster.test.ts`
 * (the page) both walk this list, and neither imports the other.
 */
import chainedFixture from "./cluster/chained.json";
import firstFixture from "./cluster/first.json";
import skippedFixture from "./cluster/skipped.json";
import skippedOverflowFixture from "./cluster/skipped-overflow.json";
import type { SkipReason } from "./types";

export type ClusterVectorExpect =
	| { kind: "protocolError"; reason: "schemaInvalid" | "verdictAlgebra" }
	| { kind: "integrityFailure"; obligation: "R1" | "R4" | "R39" }
	| { kind: "verified" }; // a BOUNDARY control that must still verify

export interface ClusterVector {
	label: string;
	/** Which conforming fixture it starts from (relative to fixtures/). */
	base:
		| "cluster/first.json"
		| "cluster/chained.json"
		| "cluster/skipped.json"
		| "cluster/skipped-overflow.json";
	/** Mutates the SIGNED receipt; the harness re-encodes receiptBytes so R4 still agrees. */
	receipt?: (receipt: Record<string, unknown>) => void;
	/** Mutates the unsigned envelope (verification, receiptBytes, ...). */
	envelope?: (body: Record<string, unknown>) => void;
	/** Overrides the route the page asked about (R1 vectors). */
	routeParamId?: string;
	expect: ClusterVectorExpect;
	/** The contract rule, in words — the assertion message. */
	rule: string;
	/**
	 * What the PAGE's refusal detail must match. A vector refused by some
	 * earlier rule it trips by accident still lands in the right state, and
	 * would then pass while testing nothing; naming the path the refusal must
	 * cite is what proves it was refused by ITS rule. Page-side only — the
	 * independent harness words its refusals its own way.
	 */
	detail?: RegExp;
}

/**
 * The 23 skip reasons in the contract's order — this module's own spelling,
 * typed against the fixture `SkipReason` so a member outside the union cannot
 * be written here. The page and the harness each keep their own copy; the
 * tests compare all three.
 */
export const CONTRACT_SKIP_REASONS: readonly SkipReason[] = [
	"cluster-void",
	"snapshot-missing",
	"snapshot-not-on-chain",
	"snapshot-unverifiable",
	"unknown-provider",
	"posted-amount-mismatch",
	"empty-cluster",
	"bad-account",
	"bad-window",
	"bad-repo-id",
	"estimated-transfer",
	"non-exact-rate",
	"posted-assessed-mismatch",
	"duplicate-transfer",
	"bad-transfer-id",
	"bad-amount",
	"rounding-out-of-bounds",
	"duplicate-mint-event",
	"mint-event-mismatch",
	"anchor-mismatch",
	"evidence-inconsistent",
	"consumed-by-another-receipt",
	"unarmed-hold",
];

/** The seventeen projection members a cluster receipt may never omit (§15.6). */
export const CLUSTER_PROJECTION_REQUIRED: readonly string[] = [
	"spec",
	"scope",
	"account",
	"windowStart",
	"windowEnd",
	"idleThresholdNs",
	"windowTransfersRoot",
	"windowTransferCount",
	"work",
	"models",
	"providers",
	"startedAt",
	"endedAt",
	"spend",
	"delegationPosture",
	"pricing",
	"transferSetRoot",
];

type Bag = Record<string, unknown>;

interface ClusterFixture {
	routeParamId: string;
	wire: { httpStatus: number; headers: Record<string, string>; body: unknown };
}

const BASES: Record<ClusterVector["base"], ClusterFixture> = {
	"cluster/first.json": firstFixture,
	"cluster/chained.json": chainedFixture,
	"cluster/skipped.json": skippedFixture,
	"cluster/skipped-overflow.json": skippedOverflowFixture,
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/**
 * The route, status, headers and body the page receives for `vector`.
 * `receiptBytes` is re-encoded from the (mutated) receipt — canonical bytes are
 * not required: R4 is key-order-agnostic. The envelope mutation runs AFTER the
 * re-encode, so an R4 vector can still corrupt the bytes it receives.
 */
export function applyClusterVector(vector: ClusterVector): {
	routeParamId: string;
	httpStatus: number;
	headers: Record<string, string>;
	body: Record<string, unknown>;
} {
	const fixture = BASES[vector.base];
	const body = clone(fixture.wire.body) as Bag;
	if (vector.receipt) {
		vector.receipt(body.receipt as Bag);
		body.receiptBytes = base64(JSON.stringify(body.receipt));
	}
	vector.envelope?.(body);
	return {
		routeParamId: vector.routeParamId ?? fixture.routeParamId,
		httpStatus: fixture.wire.httpStatus,
		headers: { ...fixture.wire.headers },
		body,
	};
}

const dataOf = (receipt: Bag): Bag => (receipt.event as Bag).data as Bag;
const spendOf = (receipt: Bag): Bag => dataOf(receipt).spend as Bag;
const skippedOf = (receipt: Bag): Bag => dataOf(receipt).skippedSincePrevious as Bag;
const windowsOf = (receipt: Bag): Bag[] => skippedOf(receipt).windows as Bag[];
const pairsOf = (receipt: Bag): Bag[] => dataOf(receipt).transferSet as Bag[];
const checksOf = (body: Bag): Bag => (body.verification as Bag).checks as Bag;

/**
 * Sets `work` on the document AND the projection, so equality 9 still holds
 * and the vector breaks the work rule alone.
 */
function setWork(receipt: Bag, work: unknown): void {
	receipt.work = clone(work);
	dataOf(receipt).work = clone(work);
}

/** Ledger-nanosecond arithmetic on canonical u64 strings, exact past 2^53. */
const ns = (value: unknown, delta: number): string =>
	(BigInt(value as string) + BigInt(delta)).toString();

const U64_MAX = "18446744073709551615";
const REPO_ID = "github.com:R_kgDOK1x2Yw";
const MINUTE_NS = 60_000_000_000;

/** A canonical 16-byte handle with a 21-character body, so one more leading '1' stays grammar-legal. */
const HANDLE_WITH_21_CHAR_BODY = "a1_8AQGAut7N92awznwCnjuR";
/** A canonical 16-byte handle whose first byte is zero — its body legitimately starts with '1'. */
const HANDLE_WITH_LEADING_ZERO_BYTE = "a1_15N8qDPFqHWMuQYbLSJuSR";

/** The receipt-document path a page refusal names, as a pattern. */
const at = (path: string): RegExp =>
	new RegExp(`body\\.receipt\\.${path.replace(/[.[\]]/g, (ch) => `\\${ch}`)}\\b`);

/** The page's refusal of a `repoId` outside §15.8's two forms. */
const REPO_ID_REFUSAL =
	/body\.receipt\.work\.repoId, when present, must be "<provider>:<opaqueId>" or a keyed "r1_<id>"/;

/** One rejection per way a `repoId` can leave §15.8's two forms. */
const REPO_ID_REFUSALS: [string, string][] = [
	["as a URL", "https://github.com/org/repo"],
	["carrying a query string", `${REPO_ID}?token=x`],
	['in the r1_ form with a "."', "r1_8fJ2kQ.x_Z9"],
	["with nothing after the colon", "github.com:"],
	["with a 201-character opaque ID", `github.com:${"A".repeat(201)}`],
];

const schemaInvalid: ClusterVectorExpect = { kind: "protocolError", reason: "schemaInvalid" };
const verdictAlgebra: ClusterVectorExpect = { kind: "protocolError", reason: "verdictAlgebra" };
const verified: ClusterVectorExpect = { kind: "verified" };

// ---------------------------------------------------------------------------
// The document — closed root, closed `work`, scope agreement, equality 9
// ---------------------------------------------------------------------------

const documentVectors: ClusterVector[] = [
	{
		label: 'document: event.kind = "receipt_voided"',
		base: "cluster/chained.json",
		receipt: (r) => {
			(r.event as Bag).kind = "receipt_voided";
		},
		expect: schemaInvalid,
		rule: 'a cluster receipt\'s mint event is kind "receipt_settled" (§15.10)',
		detail: /body\.receipt\.event\.kind must be "receipt_settled"/,
	},
	{
		label: "document: an unknown root member",
		base: "cluster/first.json",
		receipt: (r) => {
			r.note = "carried along";
		},
		expect: schemaInvalid,
		rule: "the cluster document is CLOSED: spec, receiptId, scope, mintedAt, minter, work, event, proof, signature",
		detail: /body\.receipt\.note is not a member of this closed object/,
	},
	{
		label: "document: work.repo added (on both copies)",
		base: "cluster/chained.json",
		receipt: (r) => setWork(r, { kind: "cluster", repoId: REPO_ID, repo: "octo/widgets" }),
		expect: schemaInvalid,
		rule: "work is CLOSED to {kind, repoId} — a cluster receipt names no repository path (§15.8)",
		detail: /body\.receipt\.work\.repo is not a member of this closed object/,
	},
	{
		label: 'document: work.kind = "session" (on both copies)',
		base: "cluster/first.json",
		receipt: (r) => setWork(r, { kind: "session" }),
		expect: schemaInvalid,
		rule: 'a cluster document\'s work.kind is "cluster"',
		detail: /body\.receipt\.work\.kind must be "cluster"/,
	},
	{
		label: 'document: work.repoId = "" (on both copies)',
		base: "cluster/first.json",
		receipt: (r) => setWork(r, { kind: "cluster", repoId: "" }),
		expect: schemaInvalid,
		rule: "repoId, when the key is present, is one of §15.8's two forms — absent means key-absent",
		detail: REPO_ID_REFUSAL,
	},
	{
		label: "document: work.repoId = null (on both copies)",
		base: "cluster/first.json",
		receipt: (r) => setWork(r, { kind: "cluster", repoId: null }),
		expect: schemaInvalid,
		rule: "absent is not null: an unbound key OMITS repoId",
		detail: REPO_ID_REFUSAL,
	},
	...REPO_ID_REFUSALS.map(
		([why, repoId]): ClusterVector => ({
			label: `document: work.repoId ${why} (on both copies)`,
			base: "cluster/first.json",
			receipt: (r) => setWork(r, { kind: "cluster", repoId }),
			expect: schemaInvalid,
			rule: 'repoId is "<provider>:<opaqueId>" or "r1_<id>" — no URL syntax, at most 200 ID characters',
			detail: REPO_ID_REFUSAL,
		}),
	),
	{
		label: "document: work differs from event.data.work (repoId)",
		base: "cluster/chained.json",
		receipt: (r) => {
			r.work = { kind: "cluster", repoId: "github.com:R_kgDOK1x2Yz" };
		},
		expect: schemaInvalid,
		rule: "equality 9: the document's work mirrors the projection's",
		detail: /body\.receipt\.work must equal body\.receipt\.event\.data\.work \(equality 9\)/,
	},
	{
		label: 'document: event.data.scope = "session" under a cluster document',
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).scope = "session";
		},
		expect: schemaInvalid,
		rule: "the document's scope and the projection's agree",
		detail: /body\.receipt\.event\.data\.scope must be "cluster"/,
	},
	{
		label: "document: a SESSION document carrying the cluster projection",
		base: "cluster/chained.json",
		receipt: (r) => {
			r.scope = "session";
			r.work = { kind: "session", repoId: REPO_ID };
		},
		expect: schemaInvalid,
		rule: "a session document takes the session rules, and a cluster projection fails them",
		detail: /body\.receipt\.event\.data\.scope must be "session"/,
	},
	{
		label: 'document: a SESSION document whose work is {kind: "cluster", repoId}',
		base: "cluster/chained.json",
		receipt: (r) => {
			r.scope = "session";
		},
		expect: schemaInvalid,
		rule: "cluster work is not a session work kind",
		detail: /body\.receipt\.work\.kind must be commit\|pr\|issue\|session/,
	},
];

// ---------------------------------------------------------------------------
// The projection's key set — session members refused, required members present
// ---------------------------------------------------------------------------

const FORBIDDEN_SESSION_MEMBERS: [string, unknown][] = [
	["sessionId", "sess_01J9ZK3M6Q"],
	["generation", 1],
	["sessionAssociation", "ownerAsserted"],
	["workloadId", "repo:octo/widgets:workflow:ci"],
	["prevGenerationEventHash", "a".repeat(64)],
	// The superseded draft's names for the account and the window.
	["accountId", "a1_LaVASNboDGARWVkgiqzrkF"],
	["window", { start: "1791234567890123456", end: "1791234859000000000" }],
	["windowTransfers", [{ id: "0".repeat(32), timestamp: "1791234567890123456" }]],
];

const keySetVectors: ClusterVector[] = [
	...FORBIDDEN_SESSION_MEMBERS.map(
		([member, value]): ClusterVector => ({
			label: `projection: the session-or-draft member "${member}" present`,
			base: "cluster/first.json",
			receipt: (r) => {
				dataOf(r)[member] = value;
			},
			expect: schemaInvalid,
			rule: `event.data is CLOSED: "${member}" is not a cluster member`,
			detail: new RegExp(`body\\.receipt\\.event\\.data\\.${member} is not a member`),
		}),
	),
	...CLUSTER_PROJECTION_REQUIRED.map(
		(member): ClusterVector => ({
			label: `projection: required member "${member}" deleted`,
			base: "cluster/first.json",
			receipt: (r) => {
				delete dataOf(r)[member];
			},
			expect: schemaInvalid,
			rule: `"${member}" is a REQUIRED cluster projection member`,
			detail: at(`event.data.${member}`),
		}),
	),
];

// ---------------------------------------------------------------------------
// account, the window, the idle threshold, the completeness commitment
// ---------------------------------------------------------------------------

const ACCOUNT_REFUSALS: [string, string][] = [
	["a raw ledger account ID", "0000000000000000000000000000002a"],
	["a receipt ID (ut1_, not a1_)", "ut1_6UxMu41H9LYXJYXV2CEfoK"],
	["a grammar-legal body that decodes to 17 bytes", "a1_111ZNfp3ndcZGxiLV6r6TS"],
	[
		"a non-canonical encoding: a leading '1' added to a canonical body",
		`a1_1${HANDLE_WITH_21_CHAR_BODY.slice("a1_".length)}`,
	],
	["a character outside base58 ('0')", "a1_LaVASNboDGARWVkgiqzrk0"],
];

const WINDOW_START_REFUSALS: [string, (receipt: Bag) => unknown][] = [
	["a leading zero", () => "01791234567890123456"],
	["2^64 — one past u64", () => "18446744073709551616"],
	["a JSON number", (r) => Number(dataOf(r).windowStart)],
	["a sign", () => "-1"],
	["a fraction", () => "1.5"],
	["leading whitespace", () => " 1791234567890123456"],
	["the empty string", () => ""],
];

const windowVectors: ClusterVector[] = [
	...ACCOUNT_REFUSALS.map(
		([why, account]): ClusterVector => ({
			label: `account: ${why}`,
			base: "cluster/first.json",
			receipt: (r) => {
				dataOf(r).account = account;
			},
			expect: schemaInvalid,
			rule: 'account is "a1_" + a base58 body of EXACTLY 16 bytes that re-encodes identically (§12)',
			detail: /body\.receipt\.event\.data\.account (does not match|decodes to 17 bytes)/,
		}),
	),
	...WINDOW_START_REFUSALS.map(
		([why, value]): ClusterVector => ({
			label: `windowStart: ${why}`,
			base: "cluster/first.json",
			receipt: (r) => {
				dataOf(r).windowStart = value(r);
			},
			expect: schemaInvalid,
			rule: "windowStart is a canonical u64 decimal STRING",
			detail: /body\.receipt\.event\.data\.windowStart must be a canonical u64 decimal string/,
		}),
	),
	{
		label: "windowEnd: one nanosecond before windowStart",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).windowEnd = ns(dataOf(r).windowStart, -1);
		},
		expect: schemaInvalid,
		rule: "windowEnd >= windowStart, compared as integers",
		detail: /body\.receipt\.event\.data\.windowEnd must be >= /,
	},
	{
		label: "idleThresholdNs: 59999999999 (1 ns under 60 s)",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).idleThresholdNs = "59999999999";
		},
		expect: schemaInvalid,
		rule: "idleThresholdNs >= 60000000000",
		detail: /idleThresholdNs must be between 60000000000 \(60 s\) and 86400000000000 \(24 h\)/,
	},
	{
		label: "idleThresholdNs: 86400000000001 (1 ns over 24 h)",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).idleThresholdNs = "86400000000001";
		},
		expect: schemaInvalid,
		rule: "idleThresholdNs <= 86400000000000",
		detail: /idleThresholdNs must be between 60000000000 \(60 s\) and 86400000000000 \(24 h\)/,
	},
	{
		label: 'idleThresholdNs: "600000000000.0"',
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).idleThresholdNs = "600000000000.0";
		},
		expect: schemaInvalid,
		rule: "idleThresholdNs is a canonical u64 decimal string",
		detail: /idleThresholdNs must be a canonical u64 decimal string/,
	},
	{
		label: "idleThresholdNs: the number 600000000000",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).idleThresholdNs = 600_000_000_000;
		},
		expect: schemaInvalid,
		rule: "idleThresholdNs travels as a string, like the bounds it shares an encoding with",
		detail: /idleThresholdNs must be a canonical u64 decimal string/,
	},
	{
		label: "windowTransfersRoot: uppercase hex",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).windowTransfersRoot = String(dataOf(r).windowTransfersRoot).toUpperCase();
		},
		expect: schemaInvalid,
		rule: "windowTransfersRoot is 64 LOWERCASE hex characters",
		detail: /windowTransfersRoot must be 64 lowercase hex characters/,
	},
	{
		label: "windowTransfersRoot: 63 hex characters",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).windowTransfersRoot = String(dataOf(r).windowTransfersRoot).slice(1);
		},
		expect: schemaInvalid,
		rule: "windowTransfersRoot is exactly 64 hex characters",
		detail: /windowTransfersRoot must be 64 lowercase hex characters/,
	},
	{
		label: "windowTransferCount: 2 × transferCount − 1",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).windowTransferCount = 2 * (spendOf(r).transferCount as number) - 1;
		},
		expect: schemaInvalid,
		rule: "windowTransferCount >= 2 × spend.transferCount (a hold and a post per posted pair)",
		detail: /windowTransferCount must be >= 2 × spend\.transferCount/,
	},
	{
		label: 'windowTransferCount: the string "6"',
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).windowTransferCount = "6";
		},
		expect: schemaInvalid,
		rule: "windowTransferCount is an integer",
		detail: /windowTransferCount must be an integer/,
	},
	{
		label: "windowTransferCount: 6.5",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).windowTransferCount = 6.5;
		},
		expect: schemaInvalid,
		rule: "windowTransferCount is an integer",
		detail: /windowTransferCount must be an integer/,
	},
];

// ---------------------------------------------------------------------------
// The receipt chain — previousReceiptId and skippedSincePrevious
// ---------------------------------------------------------------------------

const chainVectors: ClusterVector[] = [
	{
		label: "previousReceiptId: null",
		base: "cluster/chained.json",
		receipt: (r) => {
			dataOf(r).previousReceiptId = null;
		},
		expect: schemaInvalid,
		rule: "absent is not null: a first receipt OMITS previousReceiptId",
		detail: /previousReceiptId, when present, must be a canonical ut1 receipt ID/,
	},
	{
		label: 'previousReceiptId: "ut1_0000"',
		base: "cluster/chained.json",
		receipt: (r) => {
			dataOf(r).previousReceiptId = "ut1_0000";
		},
		expect: schemaInvalid,
		rule: "previousReceiptId is a canonical ut1 receipt ID",
		detail: /previousReceiptId, when present, must be a canonical ut1 receipt ID/,
	},
	{
		label: "previousReceiptId: a leading '1' added to CL1's ID",
		base: "cluster/chained.json",
		receipt: (r) => {
			dataOf(r).previousReceiptId = `ut1_1${firstFixture.routeParamId.slice("ut1_".length)}`;
		},
		expect: schemaInvalid,
		rule: "previousReceiptId passes §12's decode rule, not just a prefix",
		detail: /previousReceiptId, when present, must be a canonical ut1 receipt ID/,
	},
	{
		label: "previousReceiptId: the document's own receiptId",
		base: "cluster/chained.json",
		receipt: (r) => {
			dataOf(r).previousReceiptId = r.receiptId;
		},
		expect: schemaInvalid,
		rule: "a receipt never names itself as its predecessor",
		detail: /previousReceiptId must not name this receipt itself/,
	},
	{
		label: "skippedSincePrevious: null",
		base: "cluster/skipped.json",
		receipt: (r) => {
			dataOf(r).skippedSincePrevious = null;
		},
		expect: schemaInvalid,
		rule: "absent is not null: nothing skipped OMITS skippedSincePrevious",
		detail: /skippedSincePrevious must be an object/,
	},
	{
		label: "skippedSincePrevious: an unknown member",
		base: "cluster/skipped.json",
		receipt: (r) => {
			skippedOf(r).note = "carried along";
		},
		expect: schemaInvalid,
		rule: "skippedSincePrevious is CLOSED: count, windows, windowsRoot",
		detail: /skippedSincePrevious\.note is not a member of this closed object/,
	},
	{
		label: "skippedSincePrevious: count 0",
		base: "cluster/skipped.json",
		receipt: (r) => {
			skippedOf(r).count = 0;
		},
		expect: schemaInvalid,
		rule: "count >= 1 — nothing skipped is key-absent, never a zero",
		detail: /skippedSincePrevious\.count must be >= 1/,
	},
	{
		label: "skippedSincePrevious: one window short of min(count, 16)",
		base: "cluster/skipped.json",
		receipt: (r) => {
			windowsOf(r).pop();
		},
		expect: schemaInvalid,
		rule: "windows lists EXACTLY min(count, 16) entries",
		detail: /skippedSincePrevious\.windows must list exactly min\(count, 16\) = 3 windows, not 2/,
	},
	{
		label: "skippedSincePrevious: CL4 (count 20) listing 17 windows",
		base: "cluster/skipped-overflow.json",
		receipt: (r) => {
			// The generator's own 17th window: ascending, disjoint, and earlier —
			// valid in every respect except that the list may stop at 16.
			windowsOf(r).push({
				windowStart: "1791291200000000000",
				windowEnd: "1791291380000000000",
				reason: "cluster-void",
			});
		},
		expect: schemaInvalid,
		rule: "windows lists at most 16 — windowsRoot commits the rest",
		detail: /skippedSincePrevious\.windows must list exactly min\(count, 16\) = 16 windows, not 17/,
	},
	{
		label: "skippedSincePrevious: a window with an extra member",
		base: "cluster/skipped.json",
		receipt: (r) => {
			windowsOf(r)[1].note = "carried along";
		},
		expect: schemaInvalid,
		rule: "each skipped window is CLOSED: windowStart, windowEnd, reason",
		detail: /skippedSincePrevious\.windows\[1\]\.note is not a member of this closed object/,
	},
	{
		label: 'skippedSincePrevious: reason "session-void"',
		base: "cluster/skipped.json",
		receipt: (r) => {
			windowsOf(r)[1].reason = "session-void";
		},
		expect: schemaInvalid,
		rule: "reason is one of the CLOSED 23",
		detail: /skippedSincePrevious\.windows\[1\]\.reason must be one of the 23 skip reasons/,
	},
	{
		label: 'skippedSincePrevious: reason "Cluster-void" (case matters)',
		base: "cluster/skipped.json",
		receipt: (r) => {
			windowsOf(r)[1].reason = "Cluster-void";
		},
		expect: schemaInvalid,
		rule: "reason matches a closed-list member exactly",
		detail: /skippedSincePrevious\.windows\[1\]\.reason must be one of the 23 skip reasons/,
	},
	{
		label: "skippedSincePrevious: a window ending before it starts",
		base: "cluster/skipped.json",
		receipt: (r) => {
			const window = windowsOf(r)[1];
			window.windowEnd = ns(window.windowStart, -1);
		},
		expect: schemaInvalid,
		rule: "each skipped window has windowStart <= windowEnd",
		detail: /skippedSincePrevious\.windows\[1\]\.windowEnd must be >= /,
	},
	{
		label: "skippedSincePrevious: two windows overlapping (next.windowStart === prev.windowEnd)",
		base: "cluster/skipped.json",
		receipt: (r) => {
			const windows = windowsOf(r);
			windows[1].windowStart = windows[0].windowEnd;
		},
		expect: schemaInvalid,
		rule: "the windows are ascending and DISJOINT: prev.windowEnd < next.windowStart",
		detail:
			/skippedSincePrevious\.windows\[1\]\.windowStart must be after the previous window's windowEnd/,
	},
	{
		label: "skippedSincePrevious: the last window ending AT the receipt's windowStart",
		base: "cluster/skipped.json",
		receipt: (r) => {
			windowsOf(r)[2].windowEnd = dataOf(r).windowStart;
		},
		expect: schemaInvalid,
		rule: "every listed window ends strictly before event.data.windowStart",
		detail:
			/skippedSincePrevious\.windows\[2\]\.windowEnd must be before the receipt's own windowStart/,
	},
	{
		label: "skippedSincePrevious: CL4 (count 20 > 16) listing a window that ends AT windowStart",
		base: "cluster/skipped-overflow.json",
		receipt: (r) => {
			windowsOf(r)[15].windowEnd = dataOf(r).windowStart;
		},
		expect: schemaInvalid,
		rule: "every listed window ends before windowStart REGARDLESS of count — a truncated list is bounded in time too",
		detail:
			/skippedSincePrevious\.windows\[15\]\.windowEnd must be before the receipt's own windowStart/,
	},
	{
		label: "skippedSincePrevious: windowsRoot not 64 lowercase hex",
		base: "cluster/skipped.json",
		receipt: (r) => {
			skippedOf(r).windowsRoot = "not-a-root";
		},
		expect: schemaInvalid,
		rule: "windowsRoot is 64 lowercase hex characters",
		detail: /skippedSincePrevious\.windowsRoot must be 64 lowercase hex characters/,
	},
	{
		label: 'skippedSincePrevious: count as the string "3"',
		base: "cluster/skipped.json",
		receipt: (r) => {
			skippedOf(r).count = "3";
		},
		expect: schemaInvalid,
		rule: "count is an integer",
		detail: /skippedSincePrevious\.count must be an integer/,
	},
];

// ---------------------------------------------------------------------------
// Closed nested objects, and the session rules a cluster receipt inherits
// ---------------------------------------------------------------------------

const inheritedVectors: ClusterVector[] = [
	{
		label: "spend: an extra member",
		base: "cluster/first.json",
		receipt: (r) => {
			spendOf(r).extra = 1;
		},
		expect: schemaInvalid,
		rule: "spend is CLOSED to §2's six members",
		detail: /body\.receipt\.event\.data\.spend\.extra is not a member of this closed object/,
	},
	{
		label: "pricing: an extra member",
		base: "cluster/first.json",
		receipt: (r) => {
			(dataOf(r).pricing as Bag).extra = "2026-10-01";
		},
		expect: schemaInvalid,
		rule: "pricing is CLOSED to tableVersions",
		detail: /body\.receipt\.event\.data\.pricing\.extra is not a member of this closed object/,
	},
	{
		label: "transferSet: a pair with an extra member",
		base: "cluster/first.json",
		receipt: (r) => {
			pairsOf(r)[0].extra = "f".repeat(32);
		},
		expect: schemaInvalid,
		rule: "each transferSet pair is CLOSED to its two transfer IDs",
		detail:
			/body\.receipt\.event\.data\.transferSet\[0\]\.extra is not a member of this closed object/,
	},
	{
		label: "transferSet: deleted while transferCount <= 32",
		base: "cluster/first.json",
		receipt: (r) => {
			delete dataOf(r).transferSet;
		},
		expect: schemaInvalid,
		rule: "inherited from §2: the pair list is present iff transferCount <= 32",
		detail: /transferSet must be present iff spend\.transferCount <= 32/,
	},
	{
		label: "transferSet: listed on CL4 (transferCount 40)",
		base: "cluster/skipped-overflow.json",
		receipt: (r) => {
			dataOf(r).transferSet = [
				{ authorizationTransferId: "a".repeat(32), settlementTransferId: "b".repeat(32) },
			];
		},
		expect: schemaInvalid,
		rule: "inherited from §2: above 32 pairs the root is a commitment and the list is ABSENT",
		detail: /transferSet must be present iff spend\.transferCount <= 32/,
	},
	{
		label: "spend.assessedUsertokens: 0",
		base: "cluster/first.json",
		receipt: (r) => {
			spendOf(r).assessedUsertokens = 0;
		},
		expect: schemaInvalid,
		rule: "inherited from §2: 0 < assessedUsertokens",
		detail: /spend\.assessedUsertokens must be >= 1/,
	},
	{
		label: "pricing.tableVersions: a bare string, not a list",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).pricing = { tableVersions: "2026-10-01" };
		},
		expect: schemaInvalid,
		rule: "inherited from §2: tableVersions is the string list the page renders",
		detail: /pricing\.tableVersions must be an array of strings/,
	},
	{
		label: "models: a number in the list",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).models = ["claude-sonnet-4-5", 7];
		},
		expect: schemaInvalid,
		rule: "inherited from §2: models is a list of strings",
		detail: /body\.receipt\.event\.data\.models must be an array of strings/,
	},
	{
		label: 'delegationPosture: "everything" (outside §2a)',
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).delegationPosture = "everything";
		},
		expect: schemaInvalid,
		rule: "inherited R38: an amount never renders under a posture the page cannot interpret",
		detail: /delegationPosture must be one of §2a's four values/,
	},
	{
		label: 'delegationPosture: "includesAllDelegated"',
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).delegationPosture = "includesAllDelegated";
		},
		expect: { kind: "integrityFailure", obligation: "R39" },
		rule: "inherited R39: recognized vocabulary, but never a green total without evidence v1 cannot carry",
		detail: /claims its amount covers all delegated work/,
	},
];

// ---------------------------------------------------------------------------
// The envelope — the cluster predecessor algebra, R1 and R4
// ---------------------------------------------------------------------------

const envelopeVectors: ClusterVector[] = [
	{
		label: "algebra: CL2 names a predecessor, predecessorLinkage notApplicable",
		base: "cluster/chained.json",
		envelope: (b) => {
			checksOf(b).predecessorLinkage = { result: "notApplicable" };
		},
		expect: verdictAlgebra,
		rule: "a named previousReceiptId must be passed — notApplicable says no predecessor exists",
		detail: /"predecessorLinkage" is "notApplicable", but the receipt names a previousReceiptId/,
	},
	{
		label: "algebra: CL3 names a predecessor, predecessorLinkage notApplicable",
		base: "cluster/skipped.json",
		envelope: (b) => {
			checksOf(b).predecessorLinkage = { result: "notApplicable" };
		},
		expect: verdictAlgebra,
		rule: "a named previousReceiptId must be passed — notApplicable says no predecessor exists",
		detail: /"predecessorLinkage" is "notApplicable", but the receipt names a previousReceiptId/,
	},
	{
		label: "algebra: CL2 names a predecessor, predecessorLinkage unavailable",
		base: "cluster/chained.json",
		envelope: (b) => {
			checksOf(b).predecessorLinkage = { result: "unavailable" };
		},
		expect: verdictAlgebra,
		rule: "the account's chain is the resolver's own registry: never unavailable on a cluster 200",
		detail: /"predecessorLinkage" is "unavailable", but the receipt names a previousReceiptId/,
	},
	{
		label: "algebra: CL3 names a predecessor, predecessorLinkage unavailable",
		base: "cluster/skipped.json",
		envelope: (b) => {
			checksOf(b).predecessorLinkage = { result: "unavailable" };
		},
		expect: verdictAlgebra,
		rule: "the account's chain is the resolver's own registry: never unavailable on a cluster 200",
		detail: /"predecessorLinkage" is "unavailable", but the receipt names a previousReceiptId/,
	},
	{
		label: "algebra: CL1 names no predecessor, predecessorLinkage unavailable",
		base: "cluster/first.json",
		envelope: (b) => {
			checksOf(b).predecessorLinkage = { result: "unavailable" };
		},
		expect: verdictAlgebra,
		rule: "with no predecessor named, a cluster 200 says passed or notApplicable — never unavailable",
		detail: /"predecessorLinkage" is "unavailable" on a cluster 200/,
	},
	{
		label: "algebra: CL1 predecessorLinkage failed",
		base: "cluster/first.json",
		envelope: (b) => {
			checksOf(b).predecessorLinkage = { result: "failed", failure: "PREDECESSOR_MISMATCH" };
		},
		expect: verdictAlgebra,
		rule: "§4.1 rule 2, unchanged: a failed predecessor check is a contradiction on any 200",
		detail: /"predecessorLinkage" is "failed"/,
	},
	{
		label: "R1: the page asked about CL2's ID and got CL1's answer",
		base: "cluster/first.json",
		routeParamId: chainedFixture.routeParamId,
		expect: { kind: "integrityFailure", obligation: "R1" },
		rule: "R1: route === envelope.receiptId (the envelope half)",
		detail: /^the resolver answered about "/,
	},
	{
		label: "R1: the signed document names CL4's ID under CL1's route and envelope",
		base: "cluster/first.json",
		receipt: (r) => {
			r.receiptId = skippedOverflowFixture.routeParamId;
		},
		expect: { kind: "integrityFailure", obligation: "R1" },
		rule: "R1: route === receipt.receiptId (the signed-document half)",
		detail: /^the receipt document names "/,
	},
	{
		label: "R4: receiptBytes re-encoded from a receipt whose windowEnd differs",
		base: "cluster/first.json",
		envelope: (b) => {
			const signed = clone(b.receipt) as Bag;
			dataOf(signed).windowEnd = ns(dataOf(signed).windowEnd, 1);
			b.receiptBytes = base64(JSON.stringify(signed));
		},
		expect: { kind: "integrityFailure", obligation: "R4" },
		rule: "R4: the signed bytes are the authority, and they disagree with the convenience copy",
		detail: /the decoded receiptBytes do not structurally match the `receipt` member/,
	},
];

// ---------------------------------------------------------------------------
// BOUNDARY controls — exactly on a limit, and still verified
// ---------------------------------------------------------------------------

/** 16 one-minute windows five minutes apart, all inside CL2's end and CL3's start. */
function sixteenEarlierWindows(receipt: Bag): Bag[] {
	const first = windowsOf(receipt)[0].windowStart;
	return CONTRACT_SKIP_REASONS.slice(0, 16).map((reason, index) => {
		const windowStart = ns(first, index * 5 * MINUTE_NS);
		return { windowStart, windowEnd: ns(windowStart, MINUTE_NS), reason };
	});
}

const boundaryVectors: ClusterVector[] = [
	{
		label: "boundary: windowEnd === windowStart (an instant-long window)",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).windowEnd = dataOf(r).windowStart;
		},
		expect: verified,
		rule: "windowEnd >= windowStart admits equality",
	},
	{
		label: 'boundary: windowStart = "0"',
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).windowStart = "0";
		},
		expect: verified,
		rule: "0 is the canonical u64 floor (the one value that may start with a zero)",
	},
	{
		label: "boundary: windowStart === windowEnd === 2^64 − 1",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).windowStart = U64_MAX;
			dataOf(r).windowEnd = U64_MAX;
		},
		expect: verified,
		rule: "u64 max is a legal bound — the range is inclusive",
	},
	{
		label: "boundary: idleThresholdNs exactly 60000000000 (60 s)",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).idleThresholdNs = "60000000000";
		},
		expect: verified,
		rule: "the idle threshold's lower bound is inclusive",
	},
	{
		label: "boundary: idleThresholdNs exactly 86400000000000 (24 h)",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).idleThresholdNs = "86400000000000";
		},
		expect: verified,
		rule: "the idle threshold's upper bound is inclusive",
	},
	{
		label: "boundary: windowTransferCount exactly 2 × transferCount",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).windowTransferCount = 2 * (spendOf(r).transferCount as number);
		},
		expect: verified,
		rule: "windowTransferCount >= 2 × transferCount admits equality",
	},
	{
		label: "boundary: repoId in the provider form (github.com:R_kgDOK1x2Yw)",
		base: "cluster/first.json",
		receipt: (r) => setWork(r, { kind: "cluster", repoId: REPO_ID }),
		expect: verified,
		rule: '"<provider>:<opaqueId>" is one of §15.8\'s two repoId forms',
	},
	{
		label: "boundary: repoId in the keyed r1_ form (r1_8fJ2kQ-x_Z9)",
		base: "cluster/first.json",
		receipt: (r) => setWork(r, { kind: "cluster", repoId: "r1_8fJ2kQ-x_Z9" }),
		expect: verified,
		rule: 'the keyed "r1_<id>" is the other repoId form (an undisclosed private repository)',
	},
	{
		label: "boundary: repoId with a 200-character opaque ID",
		base: "cluster/first.json",
		receipt: (r) => setWork(r, { kind: "cluster", repoId: `github.com:${"A".repeat(200)}` }),
		expect: verified,
		rule: "the opaque ID's 200-character limit is inclusive",
	},
	{
		label: "boundary: an account handle with a 21-character body",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).account = HANDLE_WITH_21_CHAR_BODY;
		},
		expect: verified,
		rule: "the handle rule counts decoded BYTES (16), not characters — 16 to 22 of them",
	},
	{
		label: "boundary: an account handle with a leading zero byte (a canonical leading '1')",
		base: "cluster/first.json",
		receipt: (r) => {
			dataOf(r).account = HANDLE_WITH_LEADING_ZERO_BYTE;
		},
		expect: verified,
		rule: "a leading '1' IS a zero byte, counted exactly — legal when the total is 16",
	},
	{
		label: "boundary: CL1 (no predecessor named) with predecessorLinkage passed",
		base: "cluster/first.json",
		envelope: (b) => {
			checksOf(b).predecessorLinkage = { result: "passed" };
		},
		expect: verified,
		rule: "with no predecessor named, passed is as legal as notApplicable",
	},
	{
		label: "boundary: skippedSincePrevious count 16 with all 16 windows listed",
		base: "cluster/skipped.json",
		receipt: (r) => {
			const skipped = skippedOf(r);
			skipped.count = 16;
			skipped.windows = sixteenEarlierWindows(r);
		},
		expect: verified,
		rule: "count <= 16 lists every window",
	},
	{
		label: "boundary: CL4 with count 17 (16 listed)",
		base: "cluster/skipped-overflow.json",
		receipt: (r) => {
			skippedOf(r).count = 17;
		},
		expect: verified,
		rule: "above 16, exactly 16 are listed and windowsRoot commits the rest",
	},
	{
		label: "boundary: CL4 with count 2^53 − 1 (16 listed)",
		base: "cluster/skipped-overflow.json",
		receipt: (r) => {
			skippedOf(r).count = Number.MAX_SAFE_INTEGER;
		},
		expect: verified,
		rule: "a huge count is still a count — only min(count, 16) are listed",
	},
	{
		label: "boundary: a skipped window with windowStart === windowEnd",
		base: "cluster/skipped.json",
		receipt: (r) => {
			const window = windowsOf(r)[1];
			window.windowEnd = window.windowStart;
		},
		expect: verified,
		rule: "a skipped window has windowStart <= windowEnd — equality admitted",
	},
	{
		label: "boundary: two skipped windows 1 ns apart",
		base: "cluster/skipped.json",
		receipt: (r) => {
			const windows = windowsOf(r);
			windows[1].windowStart = ns(windows[0].windowEnd, 1);
		},
		expect: verified,
		rule: "disjoint means prev.windowEnd < next.windowStart — adjacent is disjoint",
	},
	{
		label: "boundary: the last skipped window ending 1 ns before windowStart",
		base: "cluster/skipped.json",
		receipt: (r) => {
			windowsOf(r)[2].windowEnd = ns(dataOf(r).windowStart, -1);
		},
		expect: verified,
		rule: "strictly before windowStart admits the nanosecond before it",
	},
	{
		label:
			"boundary: the resolver-as-built shape (repoId bound, an unlisted model beside custom, a 35-minute idle threshold, windowTransferCount 2 × transferCount, checkpointHistory notApplicable)",
		base: "cluster/first.json",
		receipt: (r) => {
			setWork(r, { kind: "cluster", repoId: REPO_ID });
			dataOf(r).models = ["alpha", "custom"];
			dataOf(r).idleThresholdNs = "2100000000000";
			dataOf(r).windowTransferCount = 4;
		},
		envelope: (b) => {
			checksOf(b).checkpointHistory = { result: "notApplicable" };
		},
		expect: verified,
		rule: "nothing in the contract is stricter than what the resolver serves",
	},
	...CONTRACT_SKIP_REASONS.map(
		(reason): ClusterVector => ({
			label: `boundary: skip reason "${reason}" on CL3's middle window`,
			base: "cluster/skipped.json",
			receipt: (r) => {
				windowsOf(r)[1].reason = reason;
			},
			expect: verified,
			rule: `"${reason}" is one of the 23`,
		}),
	),
];

export const clusterVectors: ClusterVector[] = [
	...documentVectors,
	...keySetVectors,
	...windowVectors,
	...chainVectors,
	...inheritedVectors,
	...envelopeVectors,
	...boundaryVectors,
];
