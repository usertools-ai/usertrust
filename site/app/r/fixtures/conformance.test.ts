/**
 * The §8 conformance harness. TDD is inverted here (verify-page spec §8):
 * this file IS the fixture matrix's test, not a test written against
 * already-trusted fixtures. Two populations, two contracts:
 *
 *   - §8.1 CONFORMING fixtures (C1-C27) must pass every strict-schema
 *     presence/exclusion rule AND the full §4.1 verdict algebra.
 *   - §8.2 EXPECTED-REJECTION vectors (X1-X11) must NEVER pass — each is
 *     asserted to fail CLOSED into its named state, for its NAMED CONSUMER
 *     (X10's clause is invisible to the page by design — see `index.ts`).
 *
 * A third population, appended at the end: CLUSTER receipts (receipt-spec
 * v0.10 §15) — the four conforming fixtures CL1-CL4 and the cluster vectors,
 * checked against this file's own re-implementation of the cluster contract.
 *
 * The R4 strict pipeline, the base58 ID-decode rule, and the §4.1 verdict
 * algebra are re-implemented LOCALLY below, deliberately not imported from
 * (a not-yet-existing) `app/r/lib/wire.ts` — that module is Task 2's
 * deliverable and owns the page's real runtime parser. This harness exists
 * to prove the fixtures themselves are internally consistent BEFORE any
 * page code exists to consume them; Task 2 re-derives its own
 * implementation and re-validates it against these same fixtures.
 */
import assert, { deepStrictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	applyClusterVector,
	type ClusterVector,
	CONTRACT_SKIP_REASONS,
	clusterVectors,
} from "./cluster-vectors";
import { idVectors } from "./id-vectors";
import { clusterConformingFixtures, conformingFixtures, rejectionVectors } from "./index";
import { protocolVectors } from "./protocol-vectors";
import type {
	BilledUnfinalizedEnvelope,
	BilledUnfinalizedMutantCase,
	CheckResult,
	ClusterSuccessEnvelope,
	FixtureCase,
	SuccessEnvelope,
	Verification,
} from "./types";

const DIR = dirname(fileURLToPath(import.meta.url));

function loadJson<T>(relPath: string): T {
	return JSON.parse(readFileSync(join(DIR, relPath), "utf-8")) as T;
}

// ---------------------------------------------------------------------------
// R2 — base58 canonical decode (receipt-spec §12)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Buffer): string {
	let zeros = 0;
	while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
	const digits: number[] = [0];
	for (let idx = zeros; idx < bytes.length; idx++) {
		let carry = bytes[idx];
		for (let j = 0; j < digits.length; j++) {
			carry += digits[j] << 8;
			digits[j] = carry % 58;
			carry = Math.floor(carry / 58);
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = Math.floor(carry / 58);
		}
	}
	let result = "1".repeat(zeros);
	for (let idx = digits.length - 1; idx >= 0; idx--) result += BASE58_ALPHABET[digits[idx]];
	return result;
}

function base58Decode(str: string): Buffer | null {
	if (str.length === 0) return null;
	const bytes: number[] = [0];
	for (const ch of str) {
		const value = BASE58_ALPHABET.indexOf(ch);
		if (value === -1) return null;
		let carry = value;
		for (let j = 0; j < bytes.length; j++) {
			carry += bytes[j] * 58;
			bytes[j] = carry & 0xff;
			carry >>= 8;
		}
		while (carry > 0) {
			bytes.push(carry & 0xff);
			carry >>= 8;
		}
	}
	let zeros = 0;
	while (zeros < str.length && str[zeros] === "1") zeros++;
	const body = Buffer.from(bytes.reverse());
	return Buffer.concat([Buffer.alloc(zeros, 0), body]);
}

/** §12's two-step decode rule: exact 16-byte decode, THEN byte-identical re-encode. */
function isCanonicalUt1Id(id: string): { valid: boolean; reason: string } {
	const grammarMatch = /^ut1_([1-9A-HJ-NP-Za-km-z]{16,22})$/.exec(id);
	if (!grammarMatch) {
		return { valid: false, reason: "fails the ut1_ + 16*22base58char grammar" };
	}
	const b58 = grammarMatch[1];
	const decoded = base58Decode(b58);
	if (!decoded) return { valid: false, reason: "contains a character outside the base58 alphabet" };
	if (decoded.length !== 16) {
		return { valid: false, reason: `decodes to ${decoded.length} bytes, not exactly 16` };
	}
	const reencoded = base58Encode(decoded);
	if (reencoded !== b58) {
		return { valid: false, reason: "does not re-encode byte-identically (non-canonical encoding)" };
	}
	return { valid: true, reason: "canonical" };
}

// ---------------------------------------------------------------------------
// R4 — the strict receiptBytes pipeline (verify-page spec §5 R4)
// ---------------------------------------------------------------------------

interface StrictBase64Result {
	ok: boolean;
	reason?: string;
	text?: string;
}

/** Stage 1+2: canonical base64 decode, then fatal UTF-8 decode. */
function strictBase64ToUtf8(b64: string): StrictBase64Result {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
		return { ok: false, reason: "contains characters outside the standard base64 alphabet" };
	}
	if (b64.length % 4 !== 0) {
		return { ok: false, reason: "length is not a multiple of 4 (invalid padding)" };
	}
	const eqIndex = b64.indexOf("=");
	if (eqIndex !== -1 && eqIndex < b64.length - 2) {
		return { ok: false, reason: "padding character appears before the final quantum" };
	}
	const bytes = Buffer.from(b64, "base64");
	// Node's base64 decoder is itself lenient (it silently skips invalid
	// characters rather than throwing), so canonical-ness is enforced by
	// re-encoding the decoded bytes and requiring byte-identical output —
	// exactly R4's own "reject non-canonical padding or out-of-alphabet
	// characters" rule, applied to the codec's actual behavior rather than
	// trusted blindly.
	if (bytes.toString("base64") !== b64) {
		return { ok: false, reason: "non-canonical base64 (does not re-encode identically)" };
	}
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { ok: true, text };
	} catch {
		return { ok: false, reason: "invalid (non-fatal-safe) UTF-8 sequence" };
	}
}

class StrictJsonError extends Error {}

interface StrictParseResult {
	ok: boolean;
	reason?: string;
	value?: unknown;
}

/**
 * Stage 3+4: a hand-rolled JSON parser (never `JSON.parse`) that rejects
 * raw-JSON duplicate keys BEFORE object construction (a post-parse check
 * cannot see the duplicate at all — receipt-spec §11) and enforces the
 * frozen numeric rules (safe-integer-only, no `-0`; `NaN`/`±Infinity` are
 * already inexpressible in JSON grammar, so rejecting anything outside the
 * standard number production covers them for free).
 */
function strictParseJson(text: string): StrictParseResult {
	let i = 0;
	const n = text.length;

	function fail(reason: string): never {
		throw new StrictJsonError(`${reason} (position ${i})`);
	}
	function skipWs() {
		while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r"))
			i++;
	}
	function expectLiteral(lit: string) {
		if (text.slice(i, i + lit.length) !== lit) fail(`expected '${lit}'`);
		i += lit.length;
	}
	function parseString(): string {
		i++; // opening quote
		let out = "";
		while (true) {
			if (i >= n) fail("unterminated string");
			const c = text[i];
			if (c === '"') {
				i++;
				break;
			}
			if (c === "\\") {
				i++;
				const esc = text[i];
				switch (esc) {
					case '"':
						out += '"';
						break;
					case "\\":
						out += "\\";
						break;
					case "/":
						out += "/";
						break;
					case "b":
						out += "\b";
						break;
					case "f":
						out += "\f";
						break;
					case "n":
						out += "\n";
						break;
					case "r":
						out += "\r";
						break;
					case "t":
						out += "\t";
						break;
					case "u": {
						const hex = text.slice(i + 1, i + 5);
						if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid unicode escape");
						out += String.fromCharCode(Number.parseInt(hex, 16));
						i += 4;
						break;
					}
					default:
						fail(`invalid escape '\\${esc}'`);
				}
				i++;
			} else {
				out += c;
				i++;
			}
		}
		return out;
	}
	function parseNumber(): number {
		const start = i;
		if (text[i] === "-") i++;
		if (text[i] === "0") {
			i++;
		} else if (text[i] >= "1" && text[i] <= "9") {
			while (text[i] >= "0" && text[i] <= "9") i++;
		} else {
			fail("invalid number");
		}
		let isFloatOrExp = false;
		if (text[i] === ".") {
			isFloatOrExp = true;
			i++;
			if (!(text[i] >= "0" && text[i] <= "9"))
				fail("invalid number: no digits after decimal point");
			while (text[i] >= "0" && text[i] <= "9") i++;
		}
		if (text[i] === "e" || text[i] === "E") {
			isFloatOrExp = true;
			i++;
			if (text[i] === "+" || text[i] === "-") i++;
			if (!(text[i] >= "0" && text[i] <= "9")) fail("invalid number: no digits in exponent");
			while (text[i] >= "0" && text[i] <= "9") i++;
		}
		const literal = text.slice(start, i);
		if (literal === "-0") fail("negative zero is not a permitted numeric literal");
		const asNumber = Number(literal);
		if (!isFloatOrExp && !Number.isSafeInteger(asNumber)) {
			fail(`unsafe integer literal "${literal}" (outside +/-(2^53-1))`);
		}
		if (!Number.isFinite(asNumber)) fail(`non-finite numeric literal "${literal}"`);
		return asNumber;
	}
	function parseArray(): unknown[] {
		i++; // [
		const arr: unknown[] = [];
		skipWs();
		if (text[i] === "]") {
			i++;
			return arr;
		}
		while (true) {
			arr.push(parseValue());
			skipWs();
			if (text[i] === ",") {
				i++;
				continue;
			}
			if (text[i] === "]") {
				i++;
				break;
			}
			fail("expected ',' or ']'");
		}
		return arr;
	}
	function parseObject(): Record<string, unknown> {
		i++; // {
		const obj: Record<string, unknown> = {};
		const seenKeys = new Set<string>();
		skipWs();
		if (text[i] === "}") {
			i++;
			return obj;
		}
		while (true) {
			skipWs();
			if (text[i] !== '"') fail("expected string key");
			const key = parseString();
			if (seenKeys.has(key)) fail(`duplicate key "${key}"`);
			seenKeys.add(key);
			skipWs();
			if (text[i] !== ":") fail("expected ':'");
			i++;
			const value = parseValue();
			obj[key] = value;
			skipWs();
			if (text[i] === ",") {
				i++;
				continue;
			}
			if (text[i] === "}") {
				i++;
				break;
			}
			fail("expected ',' or '}'");
		}
		return obj;
	}
	function parseValue(): unknown {
		skipWs();
		const c = text[i];
		if (c === "{") return parseObject();
		if (c === "[") return parseArray();
		if (c === '"') return parseString();
		if (c === "t") {
			expectLiteral("true");
			return true;
		}
		if (c === "f") {
			expectLiteral("false");
			return false;
		}
		if (c === "n") {
			expectLiteral("null");
			return null;
		}
		if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
		fail(`unexpected character '${c}'`);
	}

	try {
		const value = parseValue();
		skipWs();
		if (i !== n) fail("trailing data after top-level value");
		return { ok: true, value };
	} catch (e) {
		return { ok: false, reason: e instanceof StrictJsonError ? e.message : String(e) };
	}
}

interface R4Result {
	ok: boolean;
	reason?: string;
}

/** The complete R4 five-stage pipeline. */
function r4StrictPipeline(receiptBytesB64: string, receiptField: unknown): R4Result {
	const decoded = strictBase64ToUtf8(receiptBytesB64);
	if (!decoded.ok) return { ok: false, reason: `base64/utf-8: ${decoded.reason}` };
	const parsed = strictParseJson(decoded.text as string);
	if (!parsed.ok) return { ok: false, reason: `strict json: ${parsed.reason}` };
	try {
		deepStrictEqual(parsed.value, receiptField);
	} catch {
		return { ok: false, reason: "receiptBytes does not structurally match the `receipt` field" };
	}
	return { ok: true };
}

/** What a naive `JSON.parse` + deep-equal pipeline (the non-conformant shortcut R4 forbids) would decide. */
function lenientPipelineWouldAccept(receiptBytesB64: string, receiptField: unknown): boolean {
	try {
		const text = Buffer.from(receiptBytesB64, "base64").toString("utf-8");
		const parsed = JSON.parse(text);
		deepStrictEqual(parsed, receiptField);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// §4.1 — the verdict algebra
// ---------------------------------------------------------------------------

const MANDATORY_STEP_NAMES = [
	"schema",
	"event",
	"registry",
	"signature",
	"inclusion",
	"checkpoint",
	"semantics",
] as const;

interface AlgebraResult {
	ok: boolean;
	reason?: string;
}

/**
 * Verify a `SuccessEnvelope`'s `status` is warranted by its `verification`
 * member, per verify-page spec §4.1's three numbered rules.
 */
function checkVerdictAlgebra(body: SuccessEnvelope): AlgebraResult {
	const { steps, checks } = body.verification;

	// Rule 1: mandatory base steps must all be `passed` — `failed` AND
	// `unavailable`/`notApplicable` are both disqualifying.
	for (const name of MANDATORY_STEP_NAMES) {
		const step = steps[name as keyof typeof steps] as CheckResult;
		if (step.result !== "passed") {
			return { ok: false, reason: `mandatory step "${name}" is "${step.result}", not "passed"` };
		}
	}

	// Rule 2: named non-mandatory results.
	if (steps.derivations.result !== "passed" && steps.derivations.result !== "notApplicable") {
		return {
			ok: false,
			reason: `"derivations" is "${steps.derivations.result}" — must be passed or notApplicable on a 200`,
		};
	}
	// v0.4 actor-conflation correction: registryBinding (step 3(b)) MUST be
	// `passed` on a resolver-issued 200 — the registry IS the resolver's
	// backing store, so a resolver that read the bytes could have read the
	// binding. `unavailable`/`notApplicable` are OFFLINE-verification report
	// values only; on a 200 they are a protocol error, same as `failed`.
	if (checks.registryBinding.result !== "passed") {
		return {
			ok: false,
			reason: `"registryBinding" is "${checks.registryBinding.result}" — must be "passed" on a resolver-issued 200 (v0.4)`,
		};
	}
	if (
		checks.predecessorLinkage.result !== "passed" &&
		checks.predecessorLinkage.result !== "notApplicable" &&
		checks.predecessorLinkage.result !== "unavailable"
	) {
		return {
			ok: false,
			reason: `"predecessorLinkage" is "${checks.predecessorLinkage.result}" — must be passed, notApplicable, or unavailable`,
		};
	}

	// Rule 3: extension checks cap the status (cumulative ladder) — and the cap
	// binds the check result to the MEMBER that justifies it. A `passed` check
	// whose evidence the envelope never served is treated as absent/unavailable
	// (D1: "the history rung cannot render without it ... fail-closed to the
	// rung below"), and S3 Object Lock evidence earns no anchor at all — it is
	// operator-asserted configuration that "upgrades no cryptographic verdict,
	// and must never render as a green anchor claim" (R8).
	const evidence = body as unknown as {
		checkpointHistory?: unknown;
		anchorEvidence?: { rekor?: unknown };
	};
	const historyServed =
		Array.isArray(evidence.checkpointHistory) && evidence.checkpointHistory.length > 0;
	const rekorServed =
		typeof evidence.anchorEvidence?.rekor === "object" && evidence.anchorEvidence?.rekor !== null;
	const historyOk = checks.checkpointHistory.result === "passed" && historyServed;
	const anchorOk = checks.anchorEvidence.result === "passed" && rekorServed;
	if (body.status === "verified_checkpoint_history" && !historyOk) {
		return {
			ok: false,
			reason:
				"status verified_checkpoint_history requires checkpointHistory: passed AND a non-empty checkpointHistory member",
		};
	}
	if (body.status === "verified_anchored" && !(historyOk && anchorOk)) {
		return {
			ok: false,
			reason:
				"status verified_anchored requires checkpointHistory: passed AND anchorEvidence: passed, each with the " +
				"member that justifies it (anchorEvidence.rekor — an S3 probe alone is context, not an anchor)",
		};
	}

	return { ok: true };
}

/** The closed failure-code -> legal-step map (verify-page spec §4.1). */
const LEGAL_FAILURE_CODE_FOR_STEP: Record<string, string> = {
	schema: "SCHEMA_INVALID",
	event: "EVENT_MISMATCH",
	registry: "ID_MISMATCH",
	signature: "SIG_INVALID",
	inclusion: "PROOF_INVALID",
	checkpoint: "CHECKPOINT_INVALID",
	semantics: "SEMANTIC_INVALID",
	derivations: "DERIVATION_MISMATCH",
	checkpointHistory: "HISTORY_INVALID",
	anchorEvidence: "ANCHOR_INVALID",
	registryBinding: "ID_MISMATCH",
	// v0.7 vocabulary fix: `predecessorLinkage: failed` reports
	// PREDECESSOR_MISMATCH, not step 3's ID_MISMATCH — the union previously
	// assigned it no code at all, which made a generation-predecessor
	// contradiction unreportable wherever a `failed` result requires one.
	predecessorLinkage: "PREDECESSOR_MISMATCH",
};

function checkFailureCodesArePlaced(verification: Verification): AlgebraResult {
	const entries: [string, CheckResult][] = [
		...Object.entries(verification.steps),
		...Object.entries(verification.checks),
	];
	for (const [name, entry] of entries) {
		if (entry.result === "failed") {
			if (!entry.failure) return { ok: false, reason: `"${name}" is failed with no failure code` };
			const legal = LEGAL_FAILURE_CODE_FOR_STEP[name];
			if (entry.failure !== legal) {
				return {
					ok: false,
					reason: `"${name}" carries failure code "${entry.failure}", but only "${legal}" is legal there`,
				};
			}
		} else if (entry.failure) {
			return {
				ok: false,
				reason: `"${name}" is "${entry.result}" but carries a failure code (only legal on "failed")`,
			};
		}
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// The §2 key-set gate — this harness's own fail-closed rule
// ---------------------------------------------------------------------------

/**
 * receipt-spec §2 enumerates the projection exhaustively, and its strict schema
 * makes "any unknown field anywhere in a `ut1` document" a FAIL.
 *
 * Until v0.9 this suite enforced that rule field-by-field, by hand — so it
 * could only ever detect drift its own transcription already knew about. When
 * §2 gained `delegationPosture`, `types.ts` did not, and the corpus shipped 29
 * receipts missing a REQUIRED field while this suite reported 42/42 green. A
 * green answer over material the checker did not understand is exactly the
 * defect §7 names — "a system that ACCEPTS WHAT IT CANNOT INTERPRET AND
 * REPORTS SUCCESS" — one layer up, in the checker itself.
 *
 * So the rule is enforced from a declared key set, in BOTH directions:
 * unknown-present AND known-absent. A future spec field that nobody
 * transcribes now fails here instead of passing silently.
 */
const PROJECTION_ALWAYS_REQUIRED = [
	"spec",
	"scope",
	"sessionId",
	"generation",
	"work",
	"sessionAssociation",
	"models",
	"providers",
	"startedAt",
	"endedAt",
	"spend",
	"delegationPosture",
	"pricing",
	"transferSetRoot",
] as const;

/** Presence governed by a §2 rule; each is asserted individually below. */
const PROJECTION_CONDITIONAL = ["prevGenerationEventHash", "workloadId", "transferSet"] as const;

const SPEND_ALWAYS_REQUIRED = [
	"assessedUsertokens",
	"postedUsertokens",
	"roundingAdjustment",
	"transferCount",
	"usagePosture",
	"pricingPosture",
] as const;

/** §2a's four values — the VERIFIER's vocabulary, wider than v1 minting's. */
const DELEGATION_POSTURES: readonly string[] = [
	"selfDebitsOnly",
	"includesSomeDelegated",
	"includesAllDelegated",
	"indeterminate",
];

function checkKeySet(
	obj: Record<string, unknown>,
	required: readonly string[],
	conditional: readonly string[],
	label: string,
): AlgebraResult {
	const known = new Set<string>([...required, ...conditional]);
	const present = Object.keys(obj);
	const missing = required.filter((k) => !(k in obj));
	if (missing.length > 0) {
		return { ok: false, reason: `${label} is missing REQUIRED §2 field(s): ${missing.join(", ")}` };
	}
	const unknown = present.filter((k) => !known.has(k));
	if (unknown.length > 0) {
		return {
			ok: false,
			reason: `${label} carries field(s) §2 does not enumerate: ${unknown.join(", ")} (strict schema)`,
		};
	}
	return { ok: true };
}

function checkProjectionSchema(projection: Record<string, unknown>): AlgebraResult {
	const outer = checkKeySet(
		projection,
		PROJECTION_ALWAYS_REQUIRED,
		PROJECTION_CONDITIONAL,
		"projection",
	);
	if (!outer.ok) return outer;

	const spend = projection.spend as Record<string, unknown>;
	const inner = checkKeySet(spend, SPEND_ALWAYS_REQUIRED, [], "projection.spend");
	if (!inner.ok) return inner;

	// §7: an unrecognized posture is a step-7 SEMANTIC_INVALID, and that is what
	// makes the field forward-safe — a v1 verifier meeting a value a later spec
	// adds FAILS CLOSED rather than rendering a total whose coverage it cannot
	// interpret.
	if (!DELEGATION_POSTURES.includes(projection.delegationPosture as string)) {
		return {
			ok: false,
			reason: `delegationPosture "${String(projection.delegationPosture)}" is not one of §2a's four values`,
		};
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers over loaded fixtures
// ---------------------------------------------------------------------------

function isSuccessEnvelope(body: unknown): body is SuccessEnvelope {
	return (
		typeof body === "object" &&
		body !== null &&
		"status" in body &&
		["verified_checkpoint", "verified_checkpoint_history", "verified_anchored"].includes(
			(body as { status: unknown }).status as string,
		)
	);
}

function loadFixtureCase(file: string): FixtureCase {
	return loadJson<FixtureCase>(file);
}

// ===========================================================================
// Manifest completeness
// ===========================================================================

test("manifest: every conforming fixture's files exist on disk", () => {
	for (const entry of conformingFixtures) {
		for (const file of entry.files) {
			assert.doesNotThrow(() => readFileSync(join(DIR, file)), `${entry.id}: missing file ${file}`);
		}
	}
});

test("manifest: every rejection vector's files exist on disk", () => {
	for (const entry of rejectionVectors) {
		for (const file of entry.files) {
			assert.doesNotThrow(() => readFileSync(join(DIR, file)), `${entry.id}: missing file ${file}`);
		}
	}
});

test("manifest: 30 conforming JSON files (C1-C29, C22 a pair)", () => {
	const totalFiles = conformingFixtures.reduce((sum, e) => sum + e.files.length, 0);
	assert.equal(conformingFixtures.length, 29, "29 rows C1-C29");
	assert.equal(totalFiles, 30, "30 files total (C22 contributes 2)");
});

test("manifest: 16 rejection JSON files across X1-X5 and X8-X11, plus X6/X7 as TS modules", () => {
	const jsonEntries = rejectionVectors.filter((e) => e.kind === "json");
	const totalJsonFiles = jsonEntries.reduce((sum, e) => sum + e.files.length, 0);
	// X4 carries TWO files — one per half of R1's identity chain (the envelope
	// half and the signed-receipt-document half); the §8.2 row names the
	// receipt-document case, and only a file whose `body.receiptId` agrees with
	// the route isolates it.
	assert.equal(
		totalJsonFiles,
		16,
		"X1(4) + X2(1) + X3(1) + X4(2) + X5(4) + X8(1) + X9(1) + X10(1) + X11(1) = 16",
	);
	const tsEntries = rejectionVectors.filter((e) => e.kind === "ts-module");
	assert.deepEqual(
		tsEntries.map((e) => e.id),
		["X6", "X7"],
	);
});

// ===========================================================================
// §8.1 — conforming fixtures
// ===========================================================================

for (const entry of conformingFixtures) {
	test(`${entry.id} (${entry.files.join(", ")}): conforms to §4 schema`, () => {
		for (const file of entry.files) {
			const fixture = loadFixtureCase(file);
			const { wire, routeParamId } = fixture;
			assert.ok(routeParamId.startsWith("ut1_"), `${file}: routeParamId must be a ut1 ID`);

			if (wire.httpStatus === 429) {
				// §4.2's exemption: body is absent/untrusted and never parsed.
				assert.equal(wire.body, null, `${file}: 429 body must be absent`);
				assert.ok(wire.headers["retry-after"], `${file}: 429 must carry Retry-After`);
				continue;
			}

			assert.ok(wire.body && typeof wire.body === "object", `${file}: body must be an object`);
			const body = wire.body as unknown as Record<string, unknown>;
			assert.equal(body.apiVersion, "1", `${file}: apiVersion must be "1"`);

			if (isSuccessEnvelope(body)) {
				const success = body as unknown as SuccessEnvelope;
				assert.equal(wire.httpStatus, 200, `${file}: verified_* statuses only answer 200`);

				// R1 — route/body/receipt-document identity chain.
				assert.equal(
					success.receiptId,
					routeParamId,
					`${file}: envelope.receiptId must equal the route`,
				);
				assert.equal(
					success.receipt.receiptId,
					routeParamId,
					`${file}: receipt.receiptId must equal the route (R1)`,
				);

				// equality 9 — receipt.work mirrors event.data.work.
				deepStrictEqual(
					success.receipt.work,
					success.receipt.event.data.work,
					`${file}: receipt.work must canonically mirror event.data.work (equality 9)`,
				);

				// R4 — the strict receiptBytes<->receipt pipeline.
				const r4 = r4StrictPipeline(success.receiptBytes, success.receipt);
				assert.ok(r4.ok, `${file}: R4 strict pipeline failed: ${r4.reason}`);

				// Presence/exclusion rules (receipt-spec §2).
				const projection = success.receipt.event.data;

				// §2's key set, both directions — see checkProjectionSchema.
				const schema = checkProjectionSchema(projection as unknown as Record<string, unknown>);
				assert.ok(schema.ok, `${file}: ${schema.reason}`);

				if (projection.sessionAssociation === "workflowAttested") {
					assert.ok(projection.workloadId, `${file}: workflowAttested requires workloadId present`);
				} else {
					assert.equal(
						"workloadId" in projection,
						false,
						`${file}: ownerAsserted requires workloadId key-ABSENT`,
					);
				}
				if (projection.generation > 1) {
					assert.ok(
						projection.prevGenerationEventHash,
						`${file}: generation > 1 requires prevGenerationEventHash present`,
					);
				} else {
					assert.equal(
						"prevGenerationEventHash" in projection,
						false,
						`${file}: generation 1 requires prevGenerationEventHash key-ABSENT`,
					);
				}
				if (projection.spend.transferCount <= 32) {
					assert.ok(
						projection.transferSet,
						`${file}: transferCount <= 32 requires transferSet present`,
					);
					assert.equal(
						projection.transferSet.length,
						projection.spend.transferCount,
						`${file}: transferSet.length must equal transferCount`,
					);
				} else {
					assert.equal(
						"transferSet" in projection,
						false,
						`${file}: transferCount > 32 requires transferSet ABSENT`,
					);
				}
				if (
					projection.work.kind === "session" &&
					"origin" in projection.work &&
					projection.work.origin
				) {
					assert.equal(
						projection.work.origin.kind,
						"billedUnfinalized",
						`${file}: session.origin, when present, is the billedUnfinalized fallback variant`,
					);
				}

				// Spend arithmetic (receipt-spec §2).
				assert.equal(
					projection.spend.postedUsertokens,
					projection.spend.assessedUsertokens,
					`${file}: postedUsertokens === assessedUsertokens (P1-4)`,
				);
				assert.ok(
					projection.spend.roundingAdjustment >= 0 &&
						projection.spend.roundingAdjustment <= projection.spend.transferCount,
					`${file}: 0 <= roundingAdjustment <= transferCount`,
				);
				// R23 — amountUsd is a derived display value, integer math, four decimals.
				const cents = projection.spend.assessedUsertokens;
				const dollars = Math.floor(cents / 10000);
				const remainder = cents % 10000;
				const amountUsd = `${dollars}.${String(remainder).padStart(4, "0")}`;
				assert.match(
					amountUsd,
					/^\d+\.\d{4}$/,
					`${file}: amountUsd must derive cleanly to 4 decimals`,
				);

				// Inclusion indices must be structurally possible (AGENTS.md:
				// 0 ≤ leafIndex < treeSize). A conforming fixture that claims
				// inclusion passed with an out-of-range index blesses output a
				// real verifier would reject before the scenario is reached.
				const inclusion = success.receipt.proof.inclusion;
				const checkpoint = success.receipt.proof.checkpoint;
				assert.ok(
					Number.isSafeInteger(inclusion.leafIndex) &&
						Number.isSafeInteger(inclusion.treeSize) &&
						inclusion.leafIndex >= 0 &&
						inclusion.leafIndex < inclusion.treeSize,
					`${file}: 0 ≤ leafIndex (${inclusion.leafIndex}) < treeSize (${inclusion.treeSize})`,
				);
				assert.equal(
					inclusion.treeSize,
					checkpoint.treeSize,
					`${file}: inclusion.treeSize must match the signed checkpoint`,
				);
				assert.equal(
					inclusion.leafIndex,
					success.receipt.event.sequence - checkpoint.segmentFirstSequence,
					`${file}: leafIndex === sequence - segmentFirstSequence (equality 4)`,
				);

				// The full §4.1 verdict algebra.
				const algebra = checkVerdictAlgebra(success);
				assert.ok(algebra.ok, `${file}: verdict algebra violated: ${algebra.reason}`);

				// Closed failure-code union, correctly placed.
				const codes = checkFailureCodesArePlaced(success.verification);
				assert.ok(codes.ok, `${file}: failure-code placement violated: ${codes.reason}`);

				// transferSetRoot recompute (§7 step 8) when the pair list is present.
				if (projection.transferSet) {
					const recomputedRoot = createHash("sha256")
						.update(
							Buffer.concat([
								Buffer.from("usertrust/receipt-transfers/v1\n", "utf-8"),
								Buffer.from(JSON.stringify(projection.transferSet)),
							]),
						)
						.digest("hex");
					assert.equal(
						projection.transferSetRoot,
						recomputedRoot,
						`${file}: transferSetRoot must recompute from the disclosed pair list (step 8)`,
					);
				}
			} else if (body.status === "unverifiable") {
				assert.equal(wire.httpStatus, 409);
				assert.ok(body.verification, `${file}: 409 must carry a verification member`);
				const verification = body.verification as Verification;
				const failedSteps = [
					...Object.entries(verification.steps),
					...Object.entries(verification.checks),
				].filter(([, v]) => (v as CheckResult).result === "failed");
				assert.ok(
					failedSteps.length > 0,
					`${file}: unverifiable must name at least one failed step`,
				);
				const codes = checkFailureCodesArePlaced(verification);
				assert.ok(codes.ok, `${file}: ${codes.reason}`);
			} else if (body.status === "reserved" || body.status === "reconciling") {
				assert.equal(wire.httpStatus, 202);
				assert.equal(wire.headers["cache-control"], "no-store");
			} else if (
				body.status === "cancelled" ||
				body.status === "expired" ||
				body.status === "notMinted"
			) {
				assert.equal(wire.httpStatus, 410);
			} else if (body.status === "unknown") {
				assert.equal(wire.httpStatus, 404);
			} else if (body.status === "verificationUnavailable") {
				assert.equal(wire.httpStatus, 503);
				assert.ok(wire.headers["retry-after"], `${file}: 503 must carry Retry-After`);
			} else if (body.status === "billedUnfinalized") {
				assert.equal(wire.httpStatus, 410);
			} else {
				assert.fail(`${file}: unrecognized status "${body.status}"`);
			}
		}
	});
}

test("C21 <-> C18: the billed-unfinalized bundle's R3 cross-checks all pass", () => {
	const c21 = loadFixtureCase("billed-unfinalized.json");
	const c18 = loadFixtureCase("session-fallback.json");
	const body = c21.wire.body as unknown as BilledUnfinalizedEnvelope;
	const linked = c18.wire.body as unknown as SuccessEnvelope;

	assert.equal(c21.routeParamId, body.receiptId, "routeParamId === body.receiptId");
	assert.equal(
		body.linkedReceiptId,
		linked.receiptId,
		"body.linkedReceiptId === linkedReceipt.receiptId",
	);
	const linkedWork = linked.receipt.work as { origin?: { sourceReservationReceiptId: string } };
	assert.equal(
		linkedWork.origin?.sourceReservationReceiptId,
		body.receiptId,
		"linkedReceipt.work.origin.sourceReservationReceiptId === body.receiptId",
	);
	assert.equal(
		body.transferSetRoot,
		linked.receipt.event.data.transferSetRoot,
		"transferSetRoot equal across the terminal event and the fallback receipt",
	);
});

// ===========================================================================
// §8.2 — expected-rejection vectors
// ===========================================================================

function checkBilledUnfinalizedCrossChecks(mutant: BilledUnfinalizedMutantCase) {
	const body = mutant.wire.body as BilledUnfinalizedEnvelope;
	const linked = mutant.linkedReceipt;
	const linkedWork = linked.receipt.work as { origin?: { sourceReservationReceiptId: string } };
	return {
		routeBodyId: mutant.routeParamId === body.receiptId,
		linkedReceiptId: body.linkedReceiptId === linked.receiptId,
		sourceReservationId: linkedWork.origin?.sourceReservationReceiptId === body.receiptId,
		transferSetRoot: body.transferSetRoot === linked.receipt.event.data.transferSetRoot,
	};
}

test("X1: each billed-unfinalized mutant breaks EXACTLY its named R3 equality", () => {
	const x1 = rejectionVectors.find((e) => e.id === "X1");
	assert.ok(x1);
	for (const file of x1?.files ?? []) {
		const mutant = loadJson<BilledUnfinalizedMutantCase>(file);
		const results = checkBilledUnfinalizedCrossChecks(mutant);
		assert.equal(
			results[mutant.brokenEquality],
			false,
			`${file}: the named equality "${mutant.brokenEquality}" must be broken`,
		);
		for (const [key, ok] of Object.entries(results)) {
			if (key === mutant.brokenEquality) continue;
			assert.equal(
				ok,
				true,
				`${file}: equality "${key}" must still hold (only one equality should break)`,
			);
		}
	}
});

test("X2: unsupported apiVersion never gets green v1 treatment", () => {
	const x2 = rejectionVectors.find((e) => e.id === "X2");
	const fixture = loadFixtureCase(x2?.files[0] ?? "");
	const body = fixture.wire.body as unknown as Record<string, unknown>;
	assert.notEqual(body.apiVersion, "1", "the vector must actually carry a non-'1' apiVersion");
	// The fail-closed rule: ANY apiVersion other than the single supported
	// literal "1" renders the protocol-error shell, regardless of body shape.
	assert.ok(body.apiVersion !== "1", "must fail closed to the protocol-error shell (R37)");
});

test("X3: unrecognized status under apiVersion 1 fails closed", () => {
	const x3 = rejectionVectors.find((e) => e.id === "X3");
	const fixture = loadFixtureCase(x3?.files[0] ?? "");
	const body = fixture.wire.body as unknown as Record<string, unknown>;
	assert.equal(body.apiVersion, "1");
	const knownStatuses = new Set([
		"verified_checkpoint",
		"verified_checkpoint_history",
		"verified_anchored",
		"reserved",
		"reconciling",
		"cancelled",
		"expired",
		"notMinted",
		"billedUnfinalized",
		"unknown",
		"unverifiable",
		"verificationUnavailable",
	]);
	assert.equal(
		knownStatuses.has(body.status as string),
		false,
		"the vector's status must be genuinely unknown",
	);
});

test("X4: id-mismatch — an otherwise-valid 200 whose receipt.receiptId != route", () => {
	const x4 = rejectionVectors.find((e) => e.id === "X4");
	const fixture = loadFixtureCase(x4?.files[0] ?? "");
	const body = fixture.wire.body as unknown as SuccessEnvelope;
	// Everything else about the envelope is conformant...
	const algebra = checkVerdictAlgebra(body);
	assert.ok(
		algebra.ok,
		"the vector must be otherwise algebra-valid, isolating the identity failure",
	);
	const r4 = r4StrictPipeline(body.receiptBytes, body.receipt);
	assert.ok(r4.ok, "the vector must pass R4 byte-authority, isolating the identity failure");
	// ...except R1's identity chain, which must be broken.
	assert.notEqual(
		fixture.routeParamId,
		body.receipt.receiptId,
		"R1 must be violated: route != receipt.receiptId",
	);
});

test("X8/X9: a missing or unrecognized delegationPosture fails the §2 key-set gate", () => {
	for (const id of ["X8", "X9"] as const) {
		const entry = rejectionVectors.find((e) => e.id === id);
		const fixture = loadFixtureCase(entry?.files[0] ?? "");
		const body = fixture.wire.body as unknown as SuccessEnvelope;

		// Everything ELSE about the envelope is conformant — that is what makes
		// these vectors sharp. The resolver served a 200 whose own `semantics`
		// step claims `passed` over a receipt that fails §7 step 7.
		assert.equal(body.apiVersion, "1", `${id}: apiVersion must be conformant`);
		assert.equal(
			body.verification.steps.semantics.result,
			"passed",
			`${id}: semantics claims passed`,
		);
		const algebra = checkVerdictAlgebra(body);
		assert.ok(algebra.ok, `${id}: the envelope-level algebra must be otherwise clean`);

		// ...and the receipt still fails, because the gate reads §2, not the types.
		const schema = checkProjectionSchema(
			body.receipt.event.data as unknown as Record<string, unknown>,
		);
		assert.equal(schema.ok, false, `${id}: must fail the §2 key-set gate`);
	}
});

/**
 * Promotion-aware RFC 6962 sibling orientation. Copied here rather than
 * imported: this harness re-derives the rules the fixtures must satisfy,
 * it does not trust the production copy. A promoted last node has no
 * sibling, so the path is walked, never derived as ceil(log2(treeSize)).
 */
function expectedPathTopology(leafIndex: number, treeSize: number): ("left" | "right")[] | null {
	if (!Number.isSafeInteger(leafIndex) || !Number.isSafeInteger(treeSize)) return null;
	if (leafIndex < 0 || leafIndex >= treeSize) return null;
	const positions: ("left" | "right")[] = [];
	let index = leafIndex;
	let levelSize = treeSize;
	while (levelSize > 1) {
		const promoted = index === levelSize - 1 && levelSize % 2 === 1;
		if (!promoted) positions.push(index % 2 === 0 ? "right" : "left");
		index = Math.floor(index / 2);
		levelSize = Math.ceil(levelSize / 2);
	}
	return positions;
}

test("C28/C29: newly added conforming proofs match the promotion-aware inclusion topology", () => {
	// The rest of the corpus still carries the three-sibling dummy path
	// the original verify-page fixtures shipped with. C28/C29 are new and
	// were registered as inclusion-passed, so they are the ones that must
	// not bless a path a real verifier rejects before the fold.
	for (const file of ["posture-includes-some-delegated.json", "posture-indeterminate.json"]) {
		const fixture = loadFixtureCase(file);
		const body = fixture.wire.body as unknown as SuccessEnvelope;
		const inclusion = body.receipt.proof.inclusion;
		const expected = expectedPathTopology(inclusion.leafIndex, inclusion.treeSize);
		assert.ok(expected, `${file}: (leafIndex, treeSize) must describe a real position`);
		assert.equal(
			inclusion.siblings.length,
			expected.length,
			`${file}: sibling count must match the derived path`,
		);
		assert.deepEqual(
			inclusion.siblings.map((sibling) => sibling.position),
			expected,
			`${file}: every sibling position must match AGENTS.md:525-533`,
		);
	}
});

test("X11: includesAllDelegated is a RECOGNIZED value that the schema gate accepts", () => {
	const entry = rejectionVectors.find((e) => e.id === "X11");
	const fixture = loadFixtureCase(entry?.files[0] ?? "");
	const body = fixture.wire.body as unknown as SuccessEnvelope;
	const projection = body.receipt.event.data as unknown as Record<string, unknown>;

	assert.equal(projection.delegationPosture, "includesAllDelegated");

	// The point of this vector, and the reason it belongs to `wire.test.ts`
	// rather than here: the value is LEGAL §2a vocabulary, so the §2 key-set
	// gate must accept it. Recognizing is not permitting — §2a binds the minter,
	// §7 binds the verifier, and the rejection happens at the verdict, not the
	// schema. A gate that rejected it here would be enforcing the minting rule
	// against a verifier, which is the actor conflation A1 resolved.
	const schema = checkProjectionSchema(projection);
	assert.ok(schema.ok, `X11 must pass the schema gate: ${schema.reason}`);

	// ...and the envelope is otherwise entirely conformant, so nothing ELSE
	// can be the reason it fails downstream.
	const algebra = checkVerdictAlgebra(body);
	assert.ok(algebra.ok, "X11's envelope algebra must be clean");
});

test("X10: the served history breaks §7 contiguity and NOTHING else", () => {
	const entry = rejectionVectors.find((e) => e.id === "X10");
	const fixture = loadFixtureCase(entry?.files[0] ?? "");
	const body = fixture.wire.body as unknown as SuccessEnvelope;
	const history = body.checkpointHistory;
	assert.ok(history && history.length >= 2, "X10 must serve a walkable history");

	const [prev, next] = history;

	// The clause under test, and the only one that may fail.
	assert.notEqual(
		next.segmentFirstSequence,
		prev.segmentFirstSequence + prev.treeSize,
		"X10's whole purpose is a broken contiguity arithmetic",
	);

	// Everything an ID-chain-only walker would look at is INTACT — which is why
	// C6 (seg-9999 with prev=seg-9998) cannot substitute for this vector: it
	// breaks the chain and the arithmetic together, so an implementation that
	// never wrote the contiguity comparison still passes it.
	assert.equal(next.previousSegmentId, prev.segmentId, "X10: the ID chain must stay intact");
	assert.equal(next.previousSegmentRoot, prev.root, "X10: the lineage root edge must stay intact");
	assert.equal(
		new Set(history.map((c) => c.segmentId)).size,
		history.length,
		"X10: no repeated segmentId (that is a different §7 failure)",
	);
	deepStrictEqual(
		body.receipt.proof.checkpoint,
		next,
		"X10: the embedded checkpoint must still appear EXACTLY in the history",
	);
	assert.equal(
		body.receipt.proof.inclusion.leafIndex,
		body.receipt.event.sequence - body.receipt.proof.checkpoint.segmentFirstSequence,
		"X10: equality 4 must survive the reseat",
	);
});

test("X5: each receiptBytes mutant fails the R4 strict pipeline", () => {
	const x5 = rejectionVectors.find((e) => e.id === "X5");
	assert.ok(x5);
	for (const file of x5?.files ?? []) {
		const fixture = loadFixtureCase(file);
		const body = fixture.wire.body as unknown as SuccessEnvelope;
		const r4 = r4StrictPipeline(body.receiptBytes, body.receipt);
		assert.equal(r4.ok, false, `${file}: R4 strict pipeline must reject this mutant`);
	}
});

test("X5: duplicate-key and unsafe-integer mutants would be WRONGLY accepted by a lenient JSON.parse pipeline", () => {
	// This is the whole point of R4's strict pipeline: prove the naive
	// shortcut it forbids is not just theoretically unsound but concretely
	// wrong on these two fixtures.
	for (const file of [
		"receipt-bytes-mutants/duplicate-key.json",
		"receipt-bytes-mutants/unsafe-integer.json",
	]) {
		const fixture = loadFixtureCase(file);
		const body = fixture.wire.body as unknown as SuccessEnvelope;
		assert.equal(
			lenientPipelineWouldAccept(body.receiptBytes, body.receipt),
			true,
			`${file}: a naive JSON.parse + deep-equal pipeline must (wrongly) accept this mutant`,
		);
	}
});

test("X6: every protocol vector fails closed (never conforms to §4's schema)", () => {
	assert.ok(protocolVectors.length > 0);
	for (const vector of protocolVectors) {
		switch (vector.kind) {
			case "malformedBody": {
				assert.ok(typeof vector.rawBody === "string", `${vector.label}: expected rawBody`);
				const strict = strictParseJson(vector.rawBody ?? "");
				assert.equal(
					strict.ok,
					false,
					`${vector.label}: malformed body must fail to parse as strict JSON`,
				);
				break;
			}
			case "outOfTableHttpStatus": {
				assert.ok(vector.wire, `${vector.label}: expected a wire response`);
				const knownCodes = new Set([200, 202, 410, 404, 409, 503, 429]);
				assert.equal(
					knownCodes.has(vector.wire?.httpStatus ?? -1),
					false,
					`${vector.label}: HTTP status must genuinely be outside the §3 table`,
				);
				break;
			}
			case "httpStatusBodyMismatch": {
				assert.ok(vector.wire, `${vector.label}: expected a wire response`);
				const body = vector.wire?.body as { status?: string } | null;
				const statusToCode: Record<string, number> = {
					verified_checkpoint: 200,
					verified_checkpoint_history: 200,
					verified_anchored: 200,
					reserved: 202,
					reconciling: 202,
					cancelled: 410,
					expired: 410,
					notMinted: 410,
					billedUnfinalized: 410,
					unknown: 404,
					unverifiable: 409,
					verificationUnavailable: 503,
				};
				const expectedCode = body?.status ? statusToCode[body.status] : undefined;
				assert.notEqual(
					expectedCode,
					vector.wire?.httpStatus,
					`${vector.label}: the body status's OWN wire code must differ from the HTTP status actually served`,
				);
				break;
			}
			case "missingApiVersion": {
				assert.ok(vector.wire, `${vector.label}: expected a wire response`);
				const body = vector.wire?.body as Record<string, unknown> | null;
				assert.equal(
					body && "apiVersion" in body,
					false,
					`${vector.label}: apiVersion must be genuinely absent`,
				);
				break;
			}
			case "verdictAlgebraViolation": {
				assert.ok(vector.wire, `${vector.label}: expected a wire response`);
				const body = vector.wire?.body as unknown as SuccessEnvelope | Record<string, unknown>;
				if (!("apiVersion" in body)) {
					// covered by the missingApiVersion assertion above for that vector's own kind;
					// nothing further to check on the algebra for a body missing apiVersion.
					break;
				}
				const algebra = checkVerdictAlgebra(body as SuccessEnvelope);
				const codes = checkFailureCodesArePlaced((body as SuccessEnvelope).verification);
				assert.ok(
					algebra.ok === false || codes.ok === false,
					`${vector.label}: must violate the verdict algebra or the failure-code placement rule`,
				);
				break;
			}
			case "transportFailure": {
				assert.equal(
					vector.wire,
					undefined,
					`${vector.label}: a transport failure has no wire response to parse`,
				);
				assert.ok(
					vector.simulate === "timeout" || vector.simulate === "networkFailure",
					`${vector.label}: expected a simulate hook`,
				);
				break;
			}
			default:
				assert.fail(`unhandled protocol vector kind: ${vector.kind}`);
		}
	}
});

test("X6: every protocol-vector kind named in §8 is represented", () => {
	const kinds = new Set(protocolVectors.map((v) => v.kind));
	for (const required of [
		"malformedBody",
		"httpStatusBodyMismatch",
		"verdictAlgebraViolation",
		"transportFailure",
	] as const) {
		assert.ok(kinds.has(required), `missing a protocol vector of kind "${required}"`);
	}
});

test("X7: every ID vector's expected outcome matches the §12 canonical-decode rule", () => {
	assert.ok(idVectors.length > 0);
	let validCount = 0;
	let invalidCount = 0;
	for (const vector of idVectors) {
		const { valid } = isCanonicalUt1Id(vector.id);
		assert.equal(
			valid,
			vector.expected === "valid",
			`${vector.label}: expected "${vector.expected}" but decode rule says ${valid ? "valid" : "invalid"} — ${vector.reason}`,
		);
		if (vector.expected === "valid") validCount++;
		else invalidCount++;
	}
	assert.ok(validCount >= 2, "at least two passing controls (one with a leading zero byte)");
	assert.ok(invalidCount >= 4, "at least four distinct invalid categories");
});

test("X7: the passing controls actually differ in leading-zero-byte shape", () => {
	const validVectors = idVectors.filter((v) => v.expected === "valid");
	const decoded = validVectors.map((v) => {
		const b58 = v.id.slice("ut1_".length);
		return base58Decode(b58);
	});
	assert.ok(
		decoded.some((d) => d && d[0] === 0),
		"at least one valid control must have a leading zero byte (canonical leading '1')",
	);
	assert.ok(
		decoded.some((d) => d && d[0] !== 0),
		"at least one valid control must have no leading zero byte",
	);
});

// ===========================================================================
// receipt-spec v0.10 §15 — CLUSTER receipts: CL1-CL4 and the cluster vectors
// ===========================================================================
//
// The cluster contract, re-implemented here from the contract text and never
// imported from `lib/wire.ts`, for the reason everything above is: two
// implementations agreeing over one corpus is the evidence, and one importing
// the other is not. The scope is split in two on purpose:
//
//   - `checkClusterReceipt` is the CONTRACT the page enforces — shapes,
//     formats, bounds, the skipped-window rules, equality 9, self-predecessor
//     and the cluster predecessor algebra. It runs on every vector, boundary
//     controls included.
//   - The DERIVATIONS — the receipt-ID recompute, the event hash,
//     transferSetRoot, windowsRoot, the sibling topology and equalities
//     1/4/5/6/8 — run ONLY on the four conforming fixtures. A boundary control
//     legitimately moves `windowStart` without re-deriving the ID and must
//     still be accepted, exactly as the page (which never derives) accepts it.

const CL_DOCUMENT_KEYS = [
	"spec",
	"receiptId",
	"scope",
	"mintedAt",
	"minter",
	"work",
	"event",
	"proof",
	"signature",
] as const;

const CL_PROJECTION_REQUIRED = [
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
] as const;

/** Each one's PRESENCE is a claim, governed by its own rule below. */
const CL_PROJECTION_OPTIONAL = [
	"transferSet",
	"previousReceiptId",
	"skippedSincePrevious",
] as const;

const CL_SKIP_REASONS = [
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
] as const;

/**
 * The embedded checkpoint a cluster receipt carries: the twelve signed members
 * (receipt-spec v0.9.6 added `segmentStartPreviousHash` as the twelfth) plus `sig`.
 */
const CL_CHECKPOINT_KEYS = [
	"v",
	"vaultId",
	"profile",
	"root",
	"treeSize",
	"segmentId",
	"segmentFirstSequence",
	"previousSegmentRoot",
	"previousSegmentId",
	"segmentStartPreviousHash",
	"keyId",
	"publishedAt",
	"sig",
] as const;

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isFilledString = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0;
const isStringList = (value: unknown): boolean =>
	Array.isArray(value) && value.every((item) => typeof item === "string");
const HEX_64 = /^[0-9a-f]{64}$/;
const isHex64 = (value: unknown): boolean => typeof value === "string" && HEX_64.test(value);
const refuse = (reason: string): AlgebraResult => ({ ok: false, reason });

/** A canonical u64 decimal string as a BigInt, or null — never a float, never a lexical compare. */
function u64(value: unknown): bigint | null {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
	const n = BigInt(value);
	return n <= BigInt("18446744073709551615") ? n : null;
}

/** §15's handle rule: "a1_", then §12's two decode rules on the body — 16 bytes, canonical re-encode. */
function isCanonicalHandle(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const body = /^a1_([1-9A-HJ-NP-Za-km-z]{16,22})$/.exec(value)?.[1];
	if (body === undefined) return false;
	const decoded = base58Decode(body);
	return decoded !== null && decoded.length === 16 && base58Encode(decoded) === body;
}

/** §15.8: the provider's `provider:opaqueId`, or the keyed `r1_` form — no URL syntax. */
const CL_REPO_ID = /^(?:[a-z0-9.-]+:[A-Za-z0-9_=-]{1,200}|r1_[A-Za-z0-9_-]{1,200})$/;

function checkClusterWork(work: unknown, label: string): AlgebraResult {
	if (!isRec(work)) return refuse(`${label} is not an object`);
	const keys = checkKeySet(work, ["kind"], ["repoId"], label);
	if (!keys.ok) return keys;
	if (work.kind !== "cluster") return refuse(`${label}.kind is not "cluster"`);
	if ("repoId" in work && !(typeof work.repoId === "string" && CL_REPO_ID.test(work.repoId))) {
		return refuse(`${label}.repoId is present but in neither §15.8 form`);
	}
	return { ok: true };
}

function checkSkippedSincePrevious(skipped: unknown, windowStart: bigint): AlgebraResult {
	if (!isRec(skipped)) return refuse("skippedSincePrevious is present but not an object");
	const keys = checkKeySet(
		skipped,
		["count", "windows", "windowsRoot"],
		[],
		"skippedSincePrevious",
	);
	if (!keys.ok) return keys;
	const { count, windows } = skipped;
	if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
		return refuse("skippedSincePrevious.count is not an integer >= 1");
	}
	if (!Array.isArray(windows) || windows.length !== Math.min(count, 16)) {
		return refuse("skippedSincePrevious.windows does not list exactly min(count, 16) windows");
	}
	if (!isHex64(skipped.windowsRoot)) return refuse("skippedSincePrevious.windowsRoot is not hex64");
	let previousEnd: bigint | null = null;
	for (const [index, entry] of windows.entries()) {
		const label = `skippedSincePrevious.windows[${index}]`;
		if (!isRec(entry)) return refuse(`${label} is not an object`);
		const entryKeys = checkKeySet(entry, ["windowStart", "windowEnd", "reason"], [], label);
		if (!entryKeys.ok) return entryKeys;
		const start = u64(entry.windowStart);
		const end = u64(entry.windowEnd);
		if (start === null || end === null) return refuse(`${label} bounds are not canonical u64`);
		if (start > end) return refuse(`${label} ends before it starts`);
		if (!(CL_SKIP_REASONS as readonly unknown[]).includes(entry.reason)) {
			return refuse(`${label}.reason is not one of the 23`);
		}
		if (previousEnd !== null && !(previousEnd < start)) {
			return refuse(`${label} is not after the previous window (ascending and disjoint)`);
		}
		if (!(end < windowStart)) return refuse(`${label} does not end before the receipt's window`);
		previousEnd = end;
	}
	return { ok: true };
}

/** The document and projection rules — the schema half of `checkClusterReceipt`. */
function checkClusterSchema(receipt: unknown): AlgebraResult {
	if (!isRec(receipt)) return refuse("receipt is not an object");
	const documentKeys = checkKeySet(receipt, CL_DOCUMENT_KEYS, [], "cluster receipt");
	if (!documentKeys.ok) return documentKeys;
	if (receipt.spec !== "ut1") return refuse('receipt.spec is not "ut1"');
	if (receipt.scope !== "cluster")
		return refuse(`receipt.scope is ${JSON.stringify(receipt.scope)}`);
	if (!isFilledString(receipt.receiptId) || !isFilledString(receipt.mintedAt)) {
		return refuse("receipt.receiptId and receipt.mintedAt must be non-empty strings");
	}
	for (const member of ["minter", "event", "proof", "signature"]) {
		if (!isRec(receipt[member])) return refuse(`receipt.${member} is not an object`);
	}
	const documentWork = checkClusterWork(receipt.work, "receipt.work");
	if (!documentWork.ok) return documentWork;

	const data = (receipt.event as Rec).data;
	if (!isRec(data)) return refuse("event.data is not an object");
	const dataKeys = checkKeySet(data, CL_PROJECTION_REQUIRED, CL_PROJECTION_OPTIONAL, "event.data");
	if (!dataKeys.ok) return dataKeys;
	if (data.spec !== "ut1" || data.scope !== "cluster") {
		return refuse('event.data.spec/scope are not "ut1"/"cluster"');
	}
	if (!isCanonicalHandle(data.account))
		return refuse("event.data.account is not a canonical a1_ handle");
	const windowStart = u64(data.windowStart);
	const windowEnd = u64(data.windowEnd);
	if (windowStart === null || windowEnd === null)
		return refuse("window bounds are not canonical u64");
	if (windowEnd < windowStart) return refuse("windowEnd < windowStart");
	const idle = u64(data.idleThresholdNs);
	if (idle === null || idle < BigInt("60000000000") || idle > BigInt("86400000000000")) {
		return refuse("idleThresholdNs is not a canonical u64 in [60 s, 24 h]");
	}
	if (!isHex64(data.windowTransfersRoot)) return refuse("windowTransfersRoot is not hex64");
	const projectionWork = checkClusterWork(data.work, "event.data.work");
	if (!projectionWork.ok) return projectionWork;
	if (!isStringList(data.models) || !isStringList(data.providers)) {
		return refuse("models/providers are not string lists");
	}
	if (!isFilledString(data.startedAt) || !isFilledString(data.endedAt)) {
		return refuse("startedAt/endedAt are not non-empty strings");
	}

	// §2's shared rules, as the session section reads them (SPEND_ALWAYS_REQUIRED,
	// DELEGATION_POSTURES), plus the closed key sets §15 adds.
	const spend = data.spend;
	if (!isRec(spend)) return refuse("spend is not an object");
	const spendKeys = checkKeySet(spend, SPEND_ALWAYS_REQUIRED, [], "event.data.spend");
	if (!spendKeys.ok) return spendKeys;
	const integerAtLeast = (value: unknown, min: number): boolean =>
		typeof value === "number" && Number.isInteger(value) && value >= min;
	if (
		!integerAtLeast(spend.assessedUsertokens, 1) ||
		!integerAtLeast(spend.postedUsertokens, 1) ||
		!integerAtLeast(spend.roundingAdjustment, 0) ||
		!integerAtLeast(spend.transferCount, 1)
	) {
		return refuse("a spend integer is outside its §2 range");
	}
	if (!["provider", "mixed", "estimated"].includes(spend.usagePosture as string)) {
		return refuse("spend.usagePosture is outside §2's enum");
	}
	if (!["exact", "conservative"].includes(spend.pricingPosture as string)) {
		return refuse("spend.pricingPosture is outside §2's enum");
	}
	if (!DELEGATION_POSTURES.includes(data.delegationPosture as string)) {
		return refuse("delegationPosture is not one of §2a's four values");
	}
	const pricing = data.pricing;
	if (!isRec(pricing)) return refuse("pricing is not an object");
	const pricingKeys = checkKeySet(pricing, ["tableVersions"], [], "event.data.pricing");
	if (!pricingKeys.ok) return pricingKeys;
	if (!isStringList(pricing.tableVersions))
		return refuse("pricing.tableVersions is not a string list");
	if (!isHex64(data.transferSetRoot)) return refuse("transferSetRoot is not hex64");
	const transferCount = spend.transferCount as number;
	if ("transferSet" in data !== transferCount <= 32) {
		return refuse("transferSet is not present exactly when transferCount <= 32");
	}
	if ("transferSet" in data) {
		if (!Array.isArray(data.transferSet)) return refuse("transferSet is not a list");
		for (const [index, pair] of data.transferSet.entries()) {
			const label = `event.data.transferSet[${index}]`;
			if (!isRec(pair)) return refuse(`${label} is not an object`);
			const pairKeys = checkKeySet(
				pair,
				["authorizationTransferId", "settlementTransferId"],
				[],
				label,
			);
			if (!pairKeys.ok) return pairKeys;
			if (
				!isFilledString(pair.authorizationTransferId) ||
				!isFilledString(pair.settlementTransferId)
			) {
				return refuse(`${label} does not carry two transfer-ID strings`);
			}
		}
	}
	const windowTransferCount = data.windowTransferCount;
	if (typeof windowTransferCount !== "number" || !Number.isInteger(windowTransferCount)) {
		return refuse("windowTransferCount is not an integer");
	}
	if (windowTransferCount < 2 * transferCount)
		return refuse("windowTransferCount < 2 × transferCount");

	if ("previousReceiptId" in data) {
		const previous = data.previousReceiptId;
		if (typeof previous !== "string" || !isCanonicalUt1Id(previous).valid) {
			return refuse("previousReceiptId is present but not a canonical ut1 ID");
		}
		if (previous === receipt.receiptId) return refuse("previousReceiptId names the receipt itself");
	}
	if ("skippedSincePrevious" in data) {
		const skipped = checkSkippedSincePrevious(data.skippedSincePrevious, windowStart);
		if (!skipped.ok) return skipped;
	}
	try {
		deepStrictEqual(receipt.work, data.work);
	} catch {
		return refuse("equality 9: receipt.work does not mirror event.data.work");
	}
	return { ok: true };
}

/**
 * The cluster half of §4.1 rule 2: a named predecessor must be `passed`; with
 * none named, `passed` or `notApplicable`; never `unavailable` on a 200.
 */
function checkClusterPredecessorAlgebra(body: Rec): AlgebraResult {
	const result = (body.verification as Verification).checks.predecessorLinkage.result;
	const data = ((body.receipt as Rec).event as Rec).data as Rec;
	const named = "previousReceiptId" in data;
	const legal = named ? result === "passed" : result === "passed" || result === "notApplicable";
	return legal
		? { ok: true }
		: refuse(`predecessorLinkage "${result}" with previousReceiptId ${named ? "named" : "absent"}`);
}

/** The cluster contract the page enforces — schema, then the cluster predecessor algebra. */
function checkClusterReceipt(body: Rec): AlgebraResult {
	const schema = checkClusterSchema(body.receipt);
	return schema.ok ? checkClusterPredecessorAlgebra(body) : schema;
}

/**
 * The session-section algebra helpers read only `status`, `verification` and
 * the evidence members, which a cluster envelope carries identically — the
 * signed document is the only thing §15 changed.
 */
const asAlgebraInput = (body: unknown): SuccessEnvelope => body as SuccessEnvelope;

type HarnessGate = "accepted" | "schema" | "placement" | "algebra" | "R1" | "R39" | "R4";

/**
 * Which gate of this harness refuses an applied vector, walked in the page's
 * own order — schema, failure-code placement, the §4.1 algebra (session rules,
 * then the cluster half), R1, R39, R4 — so a vector that broke two rules would
 * show up as a disagreement on the gate, not hide behind the first.
 */
function harnessGate(applied: ReturnType<typeof applyClusterVector>): {
	gate: HarnessGate;
	reason: string;
} {
	const { body, routeParamId } = applied;
	const receipt = body.receipt as Rec;
	const schema = checkClusterSchema(receipt);
	if (!schema.ok) return { gate: "schema", reason: schema.reason ?? "" };
	const placement = checkFailureCodesArePlaced(body.verification as Verification);
	if (!placement.ok) return { gate: "placement", reason: placement.reason ?? "" };
	const algebra = checkVerdictAlgebra(asAlgebraInput(body));
	if (!algebra.ok) return { gate: "algebra", reason: algebra.reason ?? "" };
	const clusterAlgebra = checkClusterPredecessorAlgebra(body);
	if (!clusterAlgebra.ok) return { gate: "algebra", reason: clusterAlgebra.reason ?? "" };
	if (body.receiptId !== routeParamId || receipt.receiptId !== routeParamId) {
		return { gate: "R1", reason: "route, envelope and signed document disagree on the ID" };
	}
	if (((receipt.event as Rec).data as Rec).delegationPosture === "includesAllDelegated") {
		return { gate: "R39", reason: "includesAllDelegated cannot be green in v1" };
	}
	const r4 = r4StrictPipeline(body.receiptBytes as string, receipt);
	if (!r4.ok) return { gate: "R4", reason: r4.reason ?? "" };
	return { gate: "accepted", reason: "" };
}

function expectedGate(vector: ClusterVector): HarnessGate {
	const { expect } = vector;
	if (expect.kind === "verified") return "accepted";
	if (expect.kind === "integrityFailure") return expect.obligation;
	return expect.reason === "schemaInvalid" ? "schema" : "algebra";
}

/** §13's shape for these values: sorted keys at every level, `JSON.stringify` leaves. */
function canonicalize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (isRec(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();
const sha256Hex = (text: string): string => sha256(text).toString("hex");

/** receipt-spec v0.10 §15.9 — the cluster receipt ID, from what the receipt itself commits. */
function clusterReceiptId(idInputs: Rec): string {
	const digest = sha256(`usertrust/cluster-receipt-id/v1\n${canonicalize(idInputs)}`);
	return `ut1_${base58Encode(digest.subarray(0, 16))}`;
}

function loadClusterFixture(file: string): { routeParamId: string; httpStatus: number; body: Rec } {
	const fixture = loadJson<FixtureCase<ClusterSuccessEnvelope>>(file);
	return {
		routeParamId: fixture.routeParamId,
		httpStatus: fixture.wire.httpStatus,
		body: fixture.wire.body as unknown as Rec,
	};
}

test("cluster manifest: CL1-CL4 — exactly 4 rows, 4 files on disk, every route a canonical ut1 ID", () => {
	assert.deepEqual(
		clusterConformingFixtures.map((entry) => entry.id),
		["CL1", "CL2", "CL3", "CL4"],
	);
	const files = clusterConformingFixtures.flatMap((entry) => entry.files);
	assert.equal(files.length, 4, "one file per row");
	for (const file of files) {
		assert.doesNotThrow(() => readFileSync(join(DIR, file)), `missing file ${file}`);
		const { routeParamId } = loadClusterFixture(file);
		const id = isCanonicalUt1Id(routeParamId);
		assert.ok(id.valid, `${file}: routeParamId ${routeParamId} ${id.reason}`);
	}
	// The session corpus is a separate population, and its counts do not move.
	assert.equal(conformingFixtures.length, 29);
});

for (const entry of clusterConformingFixtures) {
	const [file] = entry.files;

	test(`${entry.id} (${file}): conforms to the cluster contract and the §4.1 algebra`, () => {
		const { routeParamId, httpStatus, body } = loadClusterFixture(file);
		const receipt = body.receipt as Rec;
		const data = (receipt.event as Rec).data as Rec;
		const spend = data.spend as Rec;

		assert.equal(httpStatus, 200);
		assert.equal(body.apiVersion, "1");
		assert.ok(
			["verified_checkpoint", "verified_checkpoint_history", "verified_anchored"].includes(
				body.status as string,
			),
			`${file}: a 200 carries a ladder status`,
		);
		// R1 — the identity chain.
		assert.equal(body.receiptId, routeParamId, `${file}: envelope.receiptId === route`);
		assert.equal(receipt.receiptId, routeParamId, `${file}: receipt.receiptId === route (R1)`);
		// R4 — the strict receiptBytes pipeline.
		const r4 = r4StrictPipeline(body.receiptBytes as string, receipt);
		assert.ok(r4.ok, `${file}: R4 strict pipeline failed: ${r4.reason}`);
		// The contract, the §4.1 algebra, and the closed failure-code union.
		const contract = checkClusterReceipt(body);
		assert.ok(contract.ok, `${file}: ${contract.reason}`);
		const algebra = checkVerdictAlgebra(asAlgebraInput(body));
		assert.ok(algebra.ok, `${file}: verdict algebra violated: ${algebra.reason}`);
		const codes = checkFailureCodesArePlaced(body.verification as Verification);
		assert.ok(codes.ok, `${file}: failure-code placement violated: ${codes.reason}`);
		// §2's spend relations, as the session section checks them on its corpus.
		assert.equal(spend.postedUsertokens, spend.assessedUsertokens, `${file}: posted === assessed`);
		const transferCount = spend.transferCount as number;
		const rounding = spend.roundingAdjustment as number;
		assert.ok(
			rounding >= 0 && rounding <= transferCount,
			`${file}: 0 <= rounding <= transferCount`,
		);
		if (Array.isArray(data.transferSet)) {
			assert.equal(data.transferSet.length, transferCount, `${file}: transferSet.length`);
		}
	});

	test(`${entry.id} (${file}): its proof and every derivation it carries recompute`, () => {
		const { body } = loadClusterFixture(file);
		const receipt = body.receipt as Rec;
		const event = receipt.event as Rec;
		const data = event.data as Rec;
		const proof = receipt.proof as Rec;
		const inclusion = proof.inclusion as Rec;
		const checkpoint = proof.checkpoint as Rec;
		const leafIndex = inclusion.leafIndex as number;
		const treeSize = inclusion.treeSize as number;
		const sequence = event.sequence as number;
		const segmentFirstSequence = checkpoint.segmentFirstSequence as number;

		// Equality 1.
		assert.equal(proof.mintEventHash, event.hash, `${file}: proof.mintEventHash === event.hash`);
		assert.equal(inclusion.leafHash, event.hash, `${file}: inclusion.leafHash === event.hash`);
		// Equality 4, with receipt-spec v0.9.6's chain-link offset: leaf 0 of every
		// segment after the first is the link to the previous segment, so the
		// event's leaf sits one past its sequence offset.
		const offset = checkpoint.previousSegmentRoot === "genesis" ? 0 : 1;
		assert.equal(
			leafIndex,
			sequence - segmentFirstSequence + offset,
			`${file}: leafIndex === sequence − segmentFirstSequence + ${offset} (equality 4)`,
		);
		assert.ok(
			Number.isSafeInteger(leafIndex) && offset <= leafIndex && leafIndex < treeSize,
			`${file}: ${offset} <= leafIndex (${leafIndex}) < treeSize (${treeSize})`,
		);
		assert.ok(sequence >= segmentFirstSequence, `${file}: sequence >= segmentFirstSequence`);
		// Equalities 5, 6 and 8.
		assert.equal(inclusion.treeSize, checkpoint.treeSize, `${file}: equality 5`);
		assert.equal(inclusion.root, checkpoint.root, `${file}: equality 6`);
		assert.equal(inclusion.segmentId, checkpoint.segmentId, `${file}: equality 8 (segmentId)`);
		assert.equal(checkpoint.vaultId, proof.chain, `${file}: equality 8 (vaultId === proof.chain)`);
		assert.equal(checkpoint.profile, proof.profile, `${file}: equality 8 (profile)`);
		// The 13-member embedded checkpoint, and the genesis tie between its two
		// boundary members: only the first segment links to nothing.
		const checkpointKeys = checkKeySet(checkpoint, CL_CHECKPOINT_KEYS, [], "proof.checkpoint");
		assert.ok(checkpointKeys.ok, `${file}: ${checkpointKeys.reason}`);
		assert.equal(
			checkpoint.previousSegmentRoot === "genesis",
			checkpoint.segmentStartPreviousHash === "0".repeat(64),
			`${file}: previousSegmentRoot is "genesis" exactly when segmentStartPreviousHash is 64 zeros`,
		);
		// The promotion-aware sibling path for (leafIndex, treeSize).
		const expectedPath = expectedPathTopology(leafIndex, treeSize);
		assert.ok(expectedPath, `${file}: (leafIndex, treeSize) must describe a real position`);
		assert.deepEqual(
			(inclusion.siblings as { position: string }[]).map((sibling) => sibling.position),
			expectedPath,
			`${file}: every sibling position must match the derived path`,
		);
		// The event hash: sha256(canonicalize(event − hash)).
		const { hash, ...unhashed } = event;
		assert.equal(sha256Hex(canonicalize(unhashed)), hash, `${file}: event.hash recomputes`);
		// transferSetRoot, when the pairs are listed.
		if ("transferSet" in data) {
			assert.equal(
				sha256Hex(`usertrust/receipt-transfers/v1\n${canonicalize(data.transferSet)}`),
				data.transferSetRoot,
				`${file}: transferSetRoot recomputes over the listed pairs`,
			);
		}
		// windowsRoot, when the list is complete (count <= 16).
		const skipped = data.skippedSincePrevious as Rec | undefined;
		const windowsComplete = skipped !== undefined && (skipped.count as number) <= 16;
		if (skipped !== undefined && windowsComplete) {
			assert.equal(
				sha256Hex(`usertrust/receipt-skipped-windows/v1\n${canonicalize(skipped.windows)}`),
				skipped.windowsRoot,
				`${file}: windowsRoot recomputes over the complete list`,
			);
		}
		// Step 8 is notApplicable exactly when there is nothing to recompute.
		const steps = (body.verification as Verification).steps;
		assert.equal(
			steps.derivations.result,
			"transferSet" in data || windowsComplete ? "passed" : "notApplicable",
			`${file}: derivations is passed iff a root is recomputable`,
		);
		// The receipt ID, from the chain, the handle and the window start.
		assert.equal(
			clusterReceiptId({
				vaultId: proof.chain,
				account: data.account,
				windowStart: data.windowStart,
			}),
			receipt.receiptId,
			`${file}: the receipt ID recomputes (receipt-spec v0.10 §15.9)`,
		);
	});
}

test("CL1 → CL2 → CL3: one account's chain, satisfying the link the resolver checked as passed", () => {
	const [first, chained, skipped, overflow] = clusterConformingFixtures.map(
		(entry) => loadClusterFixture(entry.files[0]).body.receipt as Rec,
	);
	const dataOf = (receipt: Rec): Rec => (receipt.event as Rec).data as Rec;
	const chainOf = (receipt: Rec): unknown => (receipt.proof as Rec).chain;

	for (const [previous, next] of [
		[first, chained],
		[chained, skipped],
	]) {
		assert.equal(dataOf(next).previousReceiptId, previous.receiptId, "next names previous");
		assert.equal(dataOf(next).account, dataOf(previous).account, "the same account");
		assert.equal(chainOf(next), chainOf(previous), "the same vault");
		const previousEnd = BigInt(dataOf(previous).windowEnd as string);
		const previousIdle = BigInt(dataOf(previous).idleThresholdNs as string);
		assert.ok(
			previousEnd + previousIdle <= BigInt(dataOf(next).windowStart as string),
			"prev.windowEnd + prev.idleThresholdNs <= windowStart",
		);
	}
	// The contract's rule for the first skipped window needs the predecessor's
	// row, so only the resolver can check it on a live receipt (the page never
	// does); here it is checked on the fixtures, which carry both rows.
	const firstSkipped = ((dataOf(skipped).skippedSincePrevious as Rec).windows as Rec[])[0];
	assert.ok(
		BigInt(firstSkipped.windowStart as string) >=
			BigInt(dataOf(chained).windowEnd as string) +
				BigInt(dataOf(chained).idleThresholdNs as string),
		"CL3's first skipped window starts at least one idle threshold after CL2's window ends",
	);
	// CL4 is ANOTHER account's first receipt.
	assert.notEqual(dataOf(overflow).account, dataOf(first).account);
	assert.equal("previousReceiptId" in dataOf(first), false);
	assert.equal("previousReceiptId" in dataOf(overflow), false);
});

test("cluster derivations: receipt-spec v0.10 §15.15's known answers, reproduced independently", () => {
	// Positive controls for every derivation the fixture tests above trust: if
	// this harness's canonicalize, SHA-256 framing or base58 drifted, the
	// fixtures could still agree with it — these values come from the spec.
	const account = "a1_LaVASNboDGARWVkgiqzrkF";
	const start = "1791234567890123456";
	assert.equal(
		sha256Hex(
			`usertrust/cluster-receipt-id/v1\n${canonicalize({ vaultId: "vault_example", account, windowStart: start })}`,
		),
		"2c64e45fd890281ef822c32f44025a2e231c469845cb944745e3def0ea55b882",
	);
	const rows: [string, string, string, string][] = [
		["vault_example", account, start, "ut1_6UxMu41H9LYXJYXV2CEfoK"],
		["vault_example", account, "1791234567890123457", "ut1_Hgh1y6opsgk6P9ivuxgDwv"],
		["vault_other", account, start, "ut1_5a64JCujs5reBDEfKV1Riz"],
		["vault_example", "a1_4HsRUMjopC7DXxL78ne2uk", start, "ut1_XapFpVyWfxM8V6vsJT5Hho"],
	];
	for (const [vaultId, handle, windowStart, expected] of rows) {
		assert.equal(clusterReceiptId({ vaultId, account: handle, windowStart }), expected);
	}
	const windowTransfers = [
		{ id: "00000000000000000000000000000101", timestamp: "1791234567890123456" },
		{ id: "00000000000000000000000000000102", timestamp: "1791234599000000000" },
		{ id: "00000000000000000000000000000103", timestamp: "1791234601000000000" },
	];
	assert.equal(
		sha256Hex(`usertrust/receipt-window-transfers/v1\n${canonicalize(windowTransfers)}`),
		"6ebaf8d020840898bac59226eb8f6c06c87f3205dfc18f14eed3ad03572768e1",
	);
	const skippedWindows = [
		{
			windowStart: "1791230000000000000",
			windowEnd: "1791230042000000000",
			reason: "cluster-void",
		},
		{
			windowStart: "1791232000000000000",
			windowEnd: "1791232005000000000",
			reason: "empty-cluster",
		},
	];
	assert.equal(
		sha256Hex(`usertrust/receipt-skipped-windows/v1\n${canonicalize(skippedWindows)}`),
		"463cf739347ff9813d903a1dd0052b6fd765d84e81efca763b784758c9053be4",
	);
	// Both spec handles pass the format rule this harness applies to `account`.
	assert.ok(isCanonicalHandle(account));
	assert.ok(isCanonicalHandle("a1_4HsRUMjopC7DXxL78ne2uk"));
});

test("cluster derivations: negative controls — the same inputs in another shape are NOT the ID", () => {
	// The known answer above could also pass a derivation that ignored its key
	// names; these prove the shape is load-bearing.
	const account = "a1_LaVASNboDGARWVkgiqzrkF";
	const windowStart = "1791234567890123456";
	const id = "ut1_6UxMu41H9LYXJYXV2CEfoK";
	assert.notEqual(clusterReceiptId({ chain: "vault_example", account, windowStart }), id);
	assert.notEqual(clusterReceiptId({ account, windowStart }), id);
});

test("cluster vectors: the harness refuses each rejection vector at its named gate, and accepts every boundary control", () => {
	for (const vector of clusterVectors) {
		const { gate, reason } = harnessGate(applyClusterVector(vector));
		assert.equal(
			gate,
			expectedGate(vector),
			`${vector.label} — ${vector.rule}${reason ? ` (harness: ${reason})` : ""}`,
		);
	}
});

test("cluster vectors: 140 in all, 42 of them boundary controls that must still verify", () => {
	assert.equal(clusterVectors.length, 140);
	assert.equal(clusterVectors.filter((vector) => vector.expect.kind === "verified").length, 42);
	assert.equal(
		new Set(clusterVectors.map((vector) => vector.label)).size,
		140,
		"labels are unique",
	);
});

test("cluster vectors: every vector changes its base fixture — no control is vacuous", () => {
	// A boundary control whose mutation silently failed to apply would verify
	// for free. The one exception is deliberate and pinned: CL3's middle window
	// already carries "estimated-transfer", and the 23-reason sweep includes it.
	// The signed bytes are compared PARSED: the re-encode reorders keys even
	// when nothing changed, and R4 is key-order-agnostic too.
	const fingerprint = (routeParamId: string, body: Rec): string => {
		const { receiptBytes, ...unsigned } = body;
		const signed: unknown = JSON.parse(
			Buffer.from(receiptBytes as string, "base64").toString("utf8"),
		);
		return canonicalize({ routeParamId, unsigned, signed });
	};
	const unchanged = clusterVectors
		.filter((vector) => {
			const applied = applyClusterVector(vector);
			const base = loadClusterFixture(vector.base);
			return (
				fingerprint(applied.routeParamId, applied.body) ===
				fingerprint(base.routeParamId, base.body)
			);
		})
		.map((vector) => vector.label);
	assert.deepEqual(unchanged, [
		'boundary: skip reason "estimated-transfer" on CL3\'s middle window',
	]);
});

test("cluster vectors: the harness's 23 skip reasons are the vectors' 23, in the contract's order", () => {
	assert.deepEqual([...CL_SKIP_REASONS], [...CONTRACT_SKIP_REASONS]);
	assert.equal(new Set(CL_SKIP_REASONS).size, 23);
});
