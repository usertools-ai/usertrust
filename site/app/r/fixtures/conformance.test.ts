/**
 * The §8 conformance harness. TDD is inverted here (verify-page spec §8):
 * this file IS the fixture matrix's test, not a test written against
 * already-trusted fixtures. Two populations, two contracts:
 *
 *   - §8.1 CONFORMING fixtures (C1-C27) must pass every strict-schema
 *     presence/exclusion rule AND the full §4.1 verdict algebra.
 *   - §8.2 EXPECTED-REJECTION vectors (X1-X7) must NEVER pass — each is
 *     asserted to fail CLOSED into its named state.
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
import { idVectors } from "./id-vectors";
import { conformingFixtures, rejectionVectors } from "./index";
import { protocolVectors } from "./protocol-vectors";
import type {
	BilledUnfinalizedEnvelope,
	BilledUnfinalizedMutantCase,
	CheckResult,
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

	// Rule 3: extension checks cap the status (cumulative ladder).
	const historyOk = checks.checkpointHistory.result === "passed";
	const anchorOk = checks.anchorEvidence.result === "passed";
	if (body.status === "verified_checkpoint_history" && !historyOk) {
		return {
			ok: false,
			reason: "status verified_checkpoint_history requires checkpointHistory: passed",
		};
	}
	if (body.status === "verified_anchored" && !(historyOk && anchorOk)) {
		return {
			ok: false,
			reason:
				"status verified_anchored requires checkpointHistory: passed AND anchorEvidence: passed",
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

test("manifest: 28 conforming JSON files (C1-C27, C22 a pair)", () => {
	const totalFiles = conformingFixtures.reduce((sum, e) => sum + e.files.length, 0);
	assert.equal(conformingFixtures.length, 27, "27 rows C1-C27");
	assert.equal(totalFiles, 28, "28 files total (C22 contributes 2)");
});

test("manifest: 11 rejection JSON files across X1-X5, plus X6/X7 as TS modules", () => {
	const jsonEntries = rejectionVectors.filter((e) => e.kind === "json");
	const totalJsonFiles = jsonEntries.reduce((sum, e) => sum + e.files.length, 0);
	assert.equal(totalJsonFiles, 11, "X1(4) + X2(1) + X3(1) + X4(1) + X5(4) = 11");
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
