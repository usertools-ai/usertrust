// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Task 2 — the strict byte reader and the §8 trust-snapshot loader.
 *
 * Graded against the Task 1 corpus, which was written from the spec text before
 * this module existed. Two directions matter equally and the file asserts both:
 *
 *  - every vector the specs say the reader must REFUSE is refused, with the
 *    right REFUSAL CLASS (unparseable ⇒ UNVERIFIABLE / missing receiptBytes;
 *    schema ⇒ FAILED / SCHEMA_INVALID — CLI spec §5's table makes that line
 *    load-bearing on the exit code); and
 *  - every OTHER vector in the corpus is ACCEPTED. Over-rejection is the
 *    quieter defect: a reader that pre-empts step 2 or step 7 reports the wrong
 *    step, the wrong code and the wrong exit for a receipt whose real defect is
 *    somewhere else, and no "reject the bad ones" suite can see it.
 */

import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
// `verifySignatureRaw` is the helper the verifier itself calls. The
// algorithm-confusion premise below is asserted against THAT function rather
// than a local re-implementation of it: a premise proved about a copy proves
// nothing about the code under test.
import { verifySignatureRaw } from "../../src/anchor-verify.js";
import {
	decodeCanonicalBase64,
	decodeUtf8Strict,
	findNonFrozenNumber,
	findUnknownReceiptField,
	isCanonicalBase64,
	type JsonObject,
	loadTrustSnapshot,
	RECEIPT_NUMERIC_POLICY,
	readReceiptDocument,
	scanJsonForDuplicateKeys,
	verifyReceiptBase,
} from "../../src/receipt-verify.js";
import { ALL_VECTORS, SNAPSHOT_VECTORS, type Vector, vector } from "./fixtures.js";
import {
	ALL_KEYS,
	CHECKPOINT_KEY,
	CHECKPOINT_KEY_SUCCESSOR,
	checkpointPreimage,
	FOREIGN_KEY,
	type HarnessKey,
	MINT_KEY,
	MINT_KEY_SUCCESSOR,
	mint,
	replaceOnce,
	type SegmentCheckpoint,
	type TrustSnapshot,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// The reader's expected outcome, per corpus vector.
//
// This table is the spec reading, written out rather than derived from the
// vector's own verdict: a vector expecting FAILED/SCHEMA_INVALID is not
// necessarily step 1's READER — `schema/signature-alg-not-ed25519` is a §5
// LITERAL, checked by Task 3 over a document the reader must hand it intact.
// ─────────────────────────────────────────────────────────────────────────────

/** UNVERIFIABLE, `missing: receiptBytes` — the bytes never became a document. */
const REFUSED_UNPARSEABLE: readonly string[] = [
	"parse/bom",
	"parse/invalid-utf8",
	"parse/duplicate-key",
	"parse/duplicate-key-nested",
	"parse/truncated",
	"parse/nan-literal",
];

/** FAILED / `SCHEMA_INVALID` — a document that parsed and then broke §3/§5. */
const REFUSED_SCHEMA: readonly string[] = [
	"schema/infinity-value",
	"schema/non-integer",
	"schema/negative-zero",
	"schema/unsafe-integer",
	"schema/fractional-token-rounds-to-integer",
	"schema/unknown-top-level-field",
	"schema/unknown-projection-field",
	"schema/duplicate-projection-copy",
	// An extra member on the embedded checkpoint is an unknown field like any
	// other: §4a's member list is closed, so `proof.checkpoint.publishedTo` never
	// reaches step 6 from inside a receipt.
	"checkpoint/extra-signed-member",
];

const REFUSED = new Set<string>([...REFUSED_UNPARSEABLE, ...REFUSED_SCHEMA]);

/**
 * Vectors the reader must NOT touch even though their verdict is
 * FAILED/SCHEMA_INVALID: each is a §5 LITERAL or a §12 decode, owned by Task 3.
 * Named here so the "everything else is accepted" sweep below is a deliberate
 * claim about them rather than an accident of set arithmetic.
 */
const SCHEMA_VERDICT_BUT_NOT_THE_READER: readonly string[] = [
	"schema/spec-literal-not-ut1",
	"schema/scope-literal-not-session",
	"schema/signature-alg-not-ed25519",
	"schema/signature-wrong-length",
	"schema/signature-key-id-differs-from-minter",
	"schema/receipt-id-decodes-short",
	"schema/receipt-id-decodes-long",
	// The FORMAT vectors land here for the same reason: §2/§5 formats are step
	// 1's, but they are validated beside the §12 decode and the §5 literals
	// rather than inside the byte reader, whose scope stays bytes → document.
	"schema/sibling-hash-non-hex",
	"schema/started-at-not-a-timestamp",
	"schema/source-reservation-not-a-receipt-id",
];

function receiptBytesOf(v: Vector): Buffer {
	return v.build().receiptBytes;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("canonical base64 (§3, §4)", () => {
	it("accepts the exact encoding of the bytes it decodes to", () => {
		const raw = Buffer.from("usertrust/receipt", "utf8");
		const b64 = raw.toString("base64");
		expect(isCanonicalBase64(b64)).toBe(true);
		expect(decodeCanonicalBase64(b64)?.equals(raw)).toBe(true);
	});

	it("accepts the empty string as the encoding of zero bytes", () => {
		expect(isCanonicalBase64("")).toBe(true);
		expect(decodeCanonicalBase64("")?.length).toBe(0);
	});

	it("rejects appended junk that Buffer.from tolerates", () => {
		// The whole reason the check exists: `Buffer.from(x, "base64")` throws
		// nothing and returns the SAME bytes, so a permissive decoder cannot tell
		// the two encodings apart — and one of them was not what was signed.
		const b64 = Buffer.from("usertrust", "utf8").toString("base64");
		for (const junk of [`${b64} `, `${b64}=`, `${b64}\n`, `${b64}!!`, ` ${b64}`]) {
			expect(Buffer.from(junk, "base64").equals(Buffer.from(b64, "base64"))).toBe(true);
			expect(isCanonicalBase64(junk)).toBe(false);
			expect(decodeCanonicalBase64(junk)).toBeNull();
		}
	});

	it("rejects base64url and non-canonical trailing bits", () => {
		expect(isCanonicalBase64("a-b_")).toBe(false);
		// "QUJD" is "ABC"; "QUJE" differs in the final sextet's unused bits only
		// for some inputs — the round-trip is what settles it, not a regex.
		const nonCanonical = "QQ==".replace("QQ", "QR"); // decodes to 0x41, re-encodes as "QQ=="
		expect(Buffer.from(nonCanonical, "base64").equals(Buffer.from("QQ==", "base64"))).toBe(true);
		expect(isCanonicalBase64(nonCanonical)).toBe(false);
	});

	it("rejects misplaced padding and bad lengths", () => {
		for (const bad of ["=", "A", "AB=", "A===", "AB=C"]) {
			expect(isCanonicalBase64(bad)).toBe(false);
		}
	});
});

describe("fatal UTF-8 with ignoreBOM (§3 step 2)", () => {
	it("RETAINS a BOM rather than silently dropping three signed bytes (PR #92)", () => {
		const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}", "utf8")]);
		expect(decodeUtf8Strict(bytes)).toBe("﻿{}");
	});

	it("refuses invalid UTF-8 instead of substituting U+FFFD", () => {
		expect(decodeUtf8Strict(Buffer.from([0x7b, 0xff, 0x7d]))).toBeNull();
		expect(decodeUtf8Strict(Buffer.from([0xc3]))).toBeNull();
	});

	it("decodes ordinary multi-byte text", () => {
		expect(decodeUtf8Strict(Buffer.from('{"s":"é"}', "utf8"))).toBe('{"s":"é"}');
	});
});

describe("pre-parse duplicate-key scan (§4a, §11)", () => {
	const ok = (text: string) => scanJsonForDuplicateKeys(text).ok;

	it("accepts well-formed documents, including repeated keys in SIBLING objects", () => {
		expect(ok('{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}')).toBe(true);
		expect(ok("[]")).toBe(true);
		expect(ok('  {\n  "a" : [1, 2, {"b": null}]\n}\n')).toBe(true);
		expect(ok('{"a":"x\\"y","b":"\\u0041"}')).toBe(true);
	});

	it("rejects a duplicate at depth 0", () => {
		const scan = scanJsonForDuplicateKeys('{"a":1,"a":2}');
		expect(scan.ok).toBe(false);
		expect(scan.ok === false && scan.detail).toContain("duplicate");
	});

	it("rejects a duplicate THREE levels down — depth-0 dedupe is not the rule", () => {
		expect(ok('{"e":{"d":{"s":{"p":1,"p":1}}}}')).toBe(false);
	});

	it("rejects a duplicate inside an array element", () => {
		expect(ok('{"k":[{"state":"revoked","state":"active"}]}')).toBe(false);
	});

	it("is not fooled by braces or colons inside strings", () => {
		expect(ok('{"a":"{\\"a\\":1}","b":2}')).toBe(true);
		expect(ok('{"a{":1,"a{":2}')).toBe(false);
	});

	it("accepts every terminal the JSON grammar has", () => {
		expect(ok('{"o":{},"a":[],"t":true,"f":false,"n":null,"e":1e-3,"z":-0.5,"u":"\\u00e9"}')).toBe(
			true,
		);
	});

	it("refuses malformed JSON rather than reporting clean", () => {
		const malformed = [
			"",
			"{",
			'{"a":1,}',
			"{'a':1}",
			"[1,]",
			"[1 2]",
			"NaN",
			"01",
			"-",
			"1.",
			"1e",
			'{"a":1}x',
			"tru",
			'{"a":"\\q"}',
			'{"a":"\\u00zz"}',
			'{"a":"\\',
			'{"a" 1}',
			'{"a":1 "b":2}',
		];
		for (const bad of malformed) {
			expect(ok(bad), bad).toBe(false);
		}
	});

	it("refuses raw control characters inside strings", () => {
		expect(ok('{"a":"x\ty"}')).toBe(false);
	});

	it("caps nesting depth rather than overflowing the stack", () => {
		const deep = `${"[".repeat(5000)}1${"]".repeat(5000)}`;
		const scan = scanJsonForDuplicateKeys(deep);
		expect(scan.ok).toBe(false);
		expect(scan.ok === false && scan.detail).toContain("nesting");
	});
});

describe("the frozen numeric rules (§3 step 4)", () => {
	it("accepts safe integers, including 0 and negatives", () => {
		expect(findNonFrozenNumber({ a: 0, b: -1, c: 9007199254740991, d: [1, 2] })).toBeNull();
	});

	it("rejects non-integers", () => {
		expect(findNonFrozenNumber({ event: { sequence: 14.5 } })).toEqual({
			path: "event.sequence",
			value: 14.5,
		});
	});

	it("rejects -0, which compares equal to 0 but canonicalizes differently", () => {
		expect(Object.is(JSON.parse('{"n":-0}').n, -0)).toBe(true);
		const found = findNonFrozenNumber(JSON.parse('{"n":-0}'));
		expect(found?.path).toBe("n");
		expect(Object.is(found?.value, -0)).toBe(true);
	});

	it("rejects integers past the safe range — they already lost bits", () => {
		expect(findNonFrozenNumber(JSON.parse('{"n":9007199254740993}'))?.path).toBe("n");
	});

	it("rejects Infinity as a VALUE, so canonicalize never throws (§7)", () => {
		const parsed = JSON.parse('{"a":[{"n":1e999}]}');
		expect(parsed.a[0].n).toBe(Number.POSITIVE_INFINITY);
		expect(findNonFrozenNumber(parsed)).toEqual({
			path: "a.0.n",
			value: Number.POSITIVE_INFINITY,
		});
	});

	it("rejects a fractional TOKEN the parser rounds to a legal integer — before it is rounded", () => {
		// The reason the pre-parse scan exists: information the parser destroys
		// has to be checked before it is destroyed. `1.00000000000000001` has no
		// double representation, so `JSON.parse` hands back exactly 1 and every
		// value-level frozen check answers about a number the bytes never carried.
		const rounded = JSON.parse('{"n":1.00000000000000001}') as { n: number };
		expect(rounded.n).toBe(1);
		expect(Number.isSafeInteger(rounded.n)).toBe(true);
		// The value-level scan is blind to it by construction — not a defect of
		// that function, a statement of what it can and cannot be asked.
		expect(findNonFrozenNumber(rounded)).toBeNull();
		// The scan over the TEXT is not.
		const scan = scanJsonForDuplicateKeys('{"n":1.00000000000000001}', {
			policy: RECEIPT_NUMERIC_POLICY,
		});
		expect(scan.ok).toBe(false);
		expect(scan.ok === false && scan.kind).toBe("numeric");
	});

	it("refuses the rounding receipt end to end, and still accepts the clean one", () => {
		const attack = readReceiptDocument(
			receiptBytesOf(vector("schema/fractional-token-rounds-to-integer")),
		);
		expect(attack.ok).toBe(false);
		// FAILED / SCHEMA_INVALID (exit 1), not UNVERIFIABLE: the bytes parsed,
		// and what they said is illegal.
		expect(attack.ok === false && attack.refusal.kind).toBe("schema");
		expect(attack.ok === false && attack.refusal.detail).toMatch(/non-integer/);
		// No false positive: the same reader still accepts the untouched receipt.
		expect(readReceiptDocument(mint().receiptBytes).ok).toBe(true);
	});

	it("leaves fractional literals ALONE where the frozen rules do not govern (§4)", () => {
		// The §8 snapshot tolerates unknown members precisely so the open
		// signing scheme can add them, and one may legitimately carry a
		// fraction. Turning the frozen rules on for every document would brick
		// it; they are the RECEIPT's rules.
		expect(scanJsonForDuplicateKeys('{"n":1.5}').ok).toBe(true);
		expect(scanJsonForDuplicateKeys('{"n":-0}').ok).toBe(true);
	});

	it("names the RULE it broke, not just the path — the refusal has to be actionable", () => {
		const detailFor = (json: string): string => {
			const result = readReceiptDocument(Buffer.from(json, "utf8"));
			return result.ok ? "" : result.refusal.detail;
		};
		expect(detailFor('{"spec":1e999}')).toMatch(/non-finite/);
		expect(detailFor('{"spec":-0}')).toMatch(/negative zero/);
		expect(detailFor('{"spec":1.5}')).toMatch(/non-integer/);
		expect(detailFor('{"spec":9007199254740993}')).toMatch(/safe range/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// WHICH refusal a numeric violation is — and it is not always the same one.
//
// §5's table splits on a single question: did these bytes become a document?
// FAILED/exit 1 says "we read what it says and it is illegal"; UNVERIFIABLE/
// exit 2 says "there was nothing to read". The scanner answers a DIFFERENT
// question, in ONE left-to-right pass, and stops at the first violation it
// meets — so on `{"spec":1.5,` it refuses at the literal and never learns the
// document does not close. Classifying straight off that verdict reported
// FAILED for bytes that are not a document at all.
//
// The rule itself is untouched, and the tests below are written to fail if it
// is ever weakened to "fix" this: a WELL-FORMED document carrying the same
// illegal literal is still FAILED, at the same detail. Only the classification
// of truncated bytes moves.
// ─────────────────────────────────────────────────────────────────────────────

describe("a numeric refusal is classified only once the bytes are known to be a document", () => {
	const refusalFor = (json: string): { kind: string; detail: string } => {
		const result = readReceiptDocument(Buffer.from(json, "utf8"));
		expect(result.ok, json).toBe(false);
		return result.ok ? { kind: "", detail: "" } : result.refusal;
	};

	it('proves the premise: the scanner really does refuse `{"spec":1.5,` as NUMERIC', () => {
		// Without this the vector could pass for an unrelated reason — a syntax
		// refusal that never reached the numeric branch scores identically.
		const scan = scanJsonForDuplicateKeys('{"spec":1.5,', { policy: RECEIPT_NUMERIC_POLICY });
		expect(scan.ok).toBe(false);
		expect(scan.ok === false && scan.kind).toBe("numeric");
	});

	it("truncated bytes whose FIRST defect is an illegal literal are UNVERIFIABLE, not FAILED", () => {
		expect(refusalFor('{"spec":1.5,').kind).toBe("unparseable");
	});

	it("POSITIVE CONTROL: a WELL-FORMED document with the same literal is still FAILED", () => {
		// The rule is a policy about documents, and this is the half a weakened
		// fix would break. Same literal, same declared position, closing brace —
		// schema refusal, naming the rule, exactly as before.
		const refusal = refusalFor('{"spec":1.5}');
		expect(refusal.kind).toBe("schema");
		expect(refusal.detail).toMatch(/non-integer/);
	});

	it("holds for every frozen numeric rule, not just the fractional one", () => {
		for (const literal of ["1e999", "-0", "9007199254740993", "1.00000000000000001"]) {
			expect(refusalFor(`{"spec":${literal},`).kind, literal).toBe("unparseable");
			expect(refusalFor(`{"spec":${literal}}`).kind, literal).toBe("schema");
		}
	});

	it("leaves the refusals that never went through the numeric branch alone", () => {
		// Truncation with no declared literal in front of it was ALREADY
		// unparseable, and a duplicate key in a document that closes was already
		// unparseable too — the second is the one a "parse it and see" fix could
		// have flipped, since `JSON.parse` accepts duplicate keys happily.
		expect(refusalFor('{"spec":"ut1",').kind).toBe("unparseable");
		expect(refusalFor('{"spec":"ut1","spec":"ut1"}').kind).toBe("unparseable");
	});

	it("does not touch the accepting path — a clean receipt still reads", () => {
		expect(readReceiptDocument(mint().receiptBytes).ok).toBe(true);
	});

	// ── The ORACLE, and why it is the scanner rather than `JSON.parse` ─────────
	//
	// "Did these bytes become a document?" has to be answered by THIS verifier's
	// grammar, and `JSON.parse` is a weaker one: it accepts duplicate keys and
	// unbounded nesting, both of which the strict scanner refuses as SYNTAX. A
	// proxy that accepts more than the thing it stands in for disagrees with it
	// somewhere, and here the disagreement is reachable by ordering: put the
	// illegal literal FIRST and the one-pass scanner stops before it ever sees
	// the scanner-invalid construct behind it.
	//
	// The fix re-runs the same scanner with the numeric axis switched off. The
	// tests below therefore assert the CLASS — two different scanner-only
	// constructs, each reached both alone and from behind a bad literal, landing
	// on the same verdict either way.

	/** `{"deep": [[[…]]]}` — `depth` nested arrays under one member. */
	const nested = (depth: number, prefix = ""): string =>
		`{${prefix}"deep":${"[".repeat(depth)}1${"]".repeat(depth)}}`;

	it("proves the premise: `JSON.parse` really does accept what the scanner refuses", () => {
		// Without this the vectors prove nothing — a construct the old oracle
		// already rejected would be classified correctly for the wrong reason.
		expect(() => JSON.parse('{"x":1.5,"a":1,"a":2}')).not.toThrow();
		expect(() => JSON.parse(nested(400))).not.toThrow();
		// And the strict scanner — with NO numeric policy, so only the grammar is
		// speaking — refuses both. That is the disagreement, measured.
		for (const text of ['{"a":1,"a":2}', nested(400)]) {
			const scan = scanJsonForDuplicateKeys(text);
			expect(scan.ok, text.slice(0, 24)).toBe(false);
			expect(scan.ok === false && scan.kind, text.slice(0, 24)).toBe("syntax");
		}
	});

	it("ATTACK: a duplicate key BEHIND an illegal literal is syntax, not schema", () => {
		// Codex's vector. `1.5` is met first, so the numeric branch fires; the
		// duplicate keys behind it are what actually decide the class.
		const refusal = refusalFor('{"x":1.5,"a":1,"a":2}');
		expect(refusal.kind).toBe("unparseable");
		expect(refusal.detail).toMatch(/duplicate JSON key/);
	});

	it("ATTACK: excessive nesting BEHIND an illegal literal lands on the nesting refusal", () => {
		// The second construct, and the one that shows this is a class rather than
		// a duplicate-key special case. Not merely the same CLASS as nesting alone
		// — the same DETAIL, because it is literally the same scanner saying it.
		const behind = refusalFor(nested(400, '"x":1.5,'));
		const alone = refusalFor(nested(400));
		expect(alone.kind).toBe("unparseable");
		expect(behind.kind).toBe("unparseable");
		expect(behind.detail).toMatch(/nesting deeper than/);
		expect(behind.detail).toBe(alone.detail);
	});

	it("the same holds for the duplicate-key pair — identical detail, literal or no literal", () => {
		expect(refusalFor('{"x":1.5,"a":1,"a":2}').detail).toBe(refusalFor('{"a":1,"a":2}').detail);
	});

	it("POSITIVE CONTROL: a well-formed document with an illegal literal is STILL schema", () => {
		// Load-bearing, and the assertion that stops this being "fixed" by
		// weakening the numeric rule. Remove the duplicate and nothing else: the
		// literal is still illegal, the bytes are still a document, and §5's table
		// still says FAILED.
		const refusal = refusalFor('{"x":1.5,"a":1}');
		expect(refusal.kind).toBe("schema");
		expect(refusal.detail).toMatch(/non-integer/);
		expect(refusal.detail).toMatch(/\$\.x/);
		// And with legal nesting behind it, which the scanner permits.
		expect(refusalFor(nested(8, '"x":1.5,')).kind).toBe("schema");
	});

	it("POSITIVE CONTROL: legal nesting and unique keys still read on the ACCEPTING path", () => {
		// The oracle runs on the refusal path only, so this is the direction that
		// proves the added scan cannot reject a document the reader must accept.
		expect(scanJsonForDuplicateKeys(nested(8)).ok).toBe(true);
		// It got PAST the grammar and died at the field walk — named, so this
		// cannot pass by refusing for the very reason it is meant to rule out.
		const legal = refusalFor(nested(8));
		expect(legal.kind).toBe("schema");
		expect(legal.detail).toMatch(/unknown field/);
		expect(readReceiptDocument(mint().receiptBytes).ok).toBe(true);
	});
});

describe("unknown-field rejection in the signed receipt (§5, §2)", () => {
	const base = (): JsonObject => JSON.parse(mint().receiptBytes.toString("utf8")) as JsonObject;

	it("accepts a clean minted receipt", () => {
		expect(findUnknownReceiptField(base())).toBeNull();
	});

	it("rejects an unknown field at every level of the signed document", () => {
		const cases: ReadonlyArray<readonly [string, (r: JsonObject) => void]> = [
			["note", (r) => ((r as Record<string, unknown>).note = 1)],
			["minter.extra", (r) => ((r.minter as JsonObject as Record<string, unknown>).extra = 1)],
			["signature.extra", (r) => ((r.signature as Record<string, unknown>).extra = 1)],
			["event.extra", (r) => ((r.event as Record<string, unknown>).extra = 1)],
			[
				"proof.inclusion.extra",
				(r) => (((r.proof as JsonObject).inclusion as Record<string, unknown>).extra = 1),
			],
			[
				"proof.checkpoint.extra",
				(r) => (((r.proof as JsonObject).checkpoint as Record<string, unknown>).extra = 1),
			],
			[
				"proof.inclusion.siblings.0.extra",
				(r) => {
					const siblings = (r.proof as JsonObject).inclusion as JsonObject;
					((siblings.siblings as JsonObject[])[0] as Record<string, unknown>).extra = 1;
				},
			],
			["work.extra", (r) => ((r.work as Record<string, unknown>).extra = 1)],
			[
				"work.repositoryMembership.extra",
				(r) => (((r.work as JsonObject).repositoryMembership as Record<string, unknown>).extra = 1),
			],
			[
				"event.data.extra",
				(r) => (((r.event as JsonObject).data as Record<string, unknown>).extra = 1),
			],
			[
				"event.data.spend.extra",
				(r) => {
					const data = (r.event as JsonObject).data as JsonObject;
					(data.spend as Record<string, unknown>).extra = 1;
				},
			],
			[
				"event.data.pricing.extra",
				(r) => {
					const data = (r.event as JsonObject).data as JsonObject;
					(data.pricing as Record<string, unknown>).extra = 1;
				},
			],
			[
				"event.data.transferSet.0.extra",
				(r) => {
					const data = (r.event as JsonObject).data as JsonObject;
					((data.transferSet as JsonObject[])[0] as Record<string, unknown>).extra = 1;
				},
			],
		];
		for (const [path, mutate] of cases) {
			const receipt = base();
			mutate(receipt);
			expect(findUnknownReceiptField(receipt)).toBe(path);
		}
	});

	it("does NOT descend into event.actor — equality 2 owns the actor (CLI spec §5 precedence)", () => {
		// `eq2/actor-extra-field` expects EVENT_MISMATCH. Step 1's schema
		// validation must not pre-empt a condition a normative equality names.
		const bytes = receiptBytesOf(vector("eq2/actor-extra-field"));
		const receipt = JSON.parse(bytes.toString("utf8")) as JsonObject;
		expect(((receipt.event as JsonObject).actor as JsonObject).tenant).toBe("acme");
		expect(findUnknownReceiptField(receipt)).toBeNull();
	});

	it("accepts every optional field being absent", () => {
		const receipt = base();
		const data = (r: JsonObject) => (r.event as JsonObject).data as JsonObject;
		delete (data(receipt) as Record<string, unknown>).workloadId;
		delete (data(receipt) as Record<string, unknown>).transferSet;
		delete (receipt.work as JsonObject as Record<string, unknown>).repo;
		delete (data(receipt).work as JsonObject as Record<string, unknown>).repo;
		expect(findUnknownReceiptField(receipt)).toBeNull();
	});

	it("accepts the pr / issue / session work variants and their unions", () => {
		const variants: readonly JsonObject[] = [
			{
				kind: "pr",
				repoId: "github.com:R_kgDOK1x2Yw",
				number: 92,
				providerArtifactId: "PR_kwDO",
				observedRevision: "rev_1",
				contentBinding: { kind: "publicSha256", sha256: "a".repeat(64) },
				repositoryMembership: { status: "providerVerified", proofId: "pv_1" },
			},
			{
				kind: "issue",
				repoId: "github.com:R_kgDOK1x2Yw",
				repo: "github.com/usertools-ai/usertrust",
				number: 7,
				providerArtifactId: "I_kwDO",
				observedRevision: "rev_2",
				contentBinding: { kind: "privateHmacSha256V1", commitment: "c1_abc" },
				repositoryMembership: { status: "providerVerified", proofId: "pv_2" },
			},
			{ kind: "session", repoId: "github.com:R_kgDOK1x2Yw" },
			{
				kind: "session",
				repoId: "github.com:R_kgDOK1x2Yw",
				origin: { kind: "billedUnfinalized", sourceReservationReceiptId: "ut1_x" },
			},
		];
		for (const work of variants) {
			const receipt = base();
			receipt.work = work;
			((receipt.event as JsonObject).data as JsonObject).work = work;
			expect(findUnknownReceiptField(receipt)).toBeNull();
		}
	});

	it("rejects a field belonging to a DIFFERENT work variant", () => {
		const receipt = base();
		const work = { kind: "session", repoId: "r", oid: "deadbeef" };
		receipt.work = work;
		((receipt.event as JsonObject).data as JsonObject).work = work;
		expect(findUnknownReceiptField(receipt)).toBe("work.oid");
	});

	it("leaves an UNRECOGNIZED work.kind to step 7's union rule", () => {
		const receipt = base();
		const work = { kind: "release", repoId: "r", tag: "v1" };
		receipt.work = work;
		((receipt.event as JsonObject).data as JsonObject).work = work;
		expect(findUnknownReceiptField(receipt)).toBeNull();
	});

	// ── The regression the field table introduced ────────────────────────────
	//
	// The table closed the FORMAT class by making the key set and the declared
	// format one declaration, walked once. It closed it with `table[key] !==
	// undefined`, and a plain object resolves INHERITED properties: every name
	// on `Object.prototype` — `__proto__`, `constructor`, `toString`, `valueOf`,
	// `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`,
	// `toLocaleString`, `__defineGetter__` … — answers "declared" for a table
	// that declares none of them. The member is then invisible to BOTH halves of
	// the walk: the unknown-field pass skips it, and the declared pass iterates
	// `Object.keys(table)`, which never yields an inherited name either.
	//
	// `JSON.parse` creates `__proto__` as an OWN data property (it never invokes
	// the setter), so the vector survives the wire, and `Object.keys` reports it,
	// so `canonicalize` covers it and both signatures verify over it. The rule
	// this defeats is §2's: "any unknown field anywhere in a `ut1` document is
	// FAIL".
	//
	// Assignment cannot express the `__proto__` case — `r.__proto__ = 1` runs
	// the accessor and creates no own property — which is exactly why a test
	// written with `=` alone would report the class closed while it was open.
	const defineOwn = (object: JsonObject, key: string, value: unknown): void => {
		Object.defineProperty(object, key, {
			value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	};

	const PROTOTYPE_NAMES: readonly string[] = [
		"__proto__",
		"constructor",
		"toString",
		"valueOf",
		"hasOwnProperty",
		"isPrototypeOf",
		"propertyIsEnumerable",
		"toLocaleString",
	];

	it("rejects an unknown field NAMED AFTER an Object.prototype member", () => {
		for (const name of PROTOTYPE_NAMES) {
			const receipt = base();
			defineOwn(receipt, name, 1);
			expect(findUnknownReceiptField(receipt), name).toBe(name);
		}
	});

	it("rejects a prototype-named member at every nested level too", () => {
		const nested: ReadonlyArray<readonly [string, (r: JsonObject) => JsonObject]> = [
			["minter", (r) => r.minter as JsonObject],
			["signature", (r) => r.signature as JsonObject],
			["event", (r) => r.event as JsonObject],
			["event.data", (r) => (r.event as JsonObject).data as JsonObject],
			["event.data.spend", (r) => ((r.event as JsonObject).data as JsonObject).spend as JsonObject],
			["proof", (r) => r.proof as JsonObject],
			["proof.inclusion", (r) => (r.proof as JsonObject).inclusion as JsonObject],
			["proof.checkpoint", (r) => (r.proof as JsonObject).checkpoint as JsonObject],
			["work", (r) => r.work as JsonObject],
			[
				"proof.inclusion.siblings.0",
				(r) =>
					(
						((r.proof as JsonObject).inclusion as JsonObject).siblings as JsonObject[]
					)[0] as JsonObject,
			],
		];
		for (const [path, select] of nested) {
			for (const name of PROTOTYPE_NAMES) {
				const receipt = base();
				defineOwn(select(receipt), name, 1);
				expect(findUnknownReceiptField(receipt), `${path}.${name}`).toBe(`${path}.${name}`);
			}
		}
	});

	it("still accepts the clean receipt — the table declares no prototype name", () => {
		// The no-false-positive half. `Object.hasOwn` must not start refusing a
		// member the table really does declare, and a null-prototype table must
		// still enumerate every one of them.
		expect(findUnknownReceiptField(base())).toBeNull();
	});
});

describe("readReceiptDocument over the conformance corpus", () => {
	it.each(REFUSED_UNPARSEABLE)("%s is UNPARSEABLE (→ UNVERIFIABLE)", (name) => {
		const result = readReceiptDocument(receiptBytesOf(vector(name)));
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.refusal.kind).toBe("unparseable");
	});

	it.each(REFUSED_SCHEMA)("%s is a SCHEMA refusal (→ FAILED / SCHEMA_INVALID)", (name) => {
		const result = readReceiptDocument(receiptBytesOf(vector(name)));
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.refusal.kind).toBe("schema");
	});

	it("accepts every OTHER vector's bytes — the reader must not pre-empt a later step", () => {
		const wronglyRefused: string[] = [];
		for (const v of ALL_VECTORS) {
			if (REFUSED.has(v.name)) continue;
			const result = readReceiptDocument(receiptBytesOf(v));
			if (!result.ok) wronglyRefused.push(`${v.name}: ${result.refusal.detail}`);
		}
		expect(wronglyRefused).toEqual([]);
	});

	it("hands Task 3 the §5-literal vectors intact rather than owning them", () => {
		for (const name of SCHEMA_VERDICT_BUT_NOT_THE_READER) {
			expect(readReceiptDocument(receiptBytesOf(vector(name))).ok).toBe(true);
		}
	});

	it("refuses a top-level JSON value that is not an object", () => {
		for (const text of ["[]", '"ut1"', "null", "7"]) {
			const result = readReceiptDocument(Buffer.from(text, "utf8"));
			expect(result.ok).toBe(false);
			expect(result.ok === false && result.refusal.kind).toBe("schema");
		}
	});

	it("returns the parsed document when it accepts", () => {
		const result = readReceiptDocument(mint().receiptBytes);
		expect(result.ok).toBe(true);
		expect(result.ok === true && result.value.spec).toBe("ut1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The §8 trust snapshot (CLI spec §4).
// ─────────────────────────────────────────────────────────────────────────────

describe("loadTrustSnapshot — structural rules (§4/§8)", () => {
	/**
	 * `snapshot/chain-not-registered` is the one SNAPSHOT_VECTOR that is NOT a
	 * structural violation: the document is perfectly well formed, it simply
	 * does not register the receipt's chain. The corpus says so — it expects
	 * `missing: trustKey`, not `trustSnapshot` — and the loader must agree, or
	 * the CLI reports the wrong missing material.
	 */
	const NOT_STRUCTURAL = new Set(["snapshot/chain-not-registered"]);

	it("rejects every §4 structural vector", () => {
		const accepted: string[] = [];
		for (const v of SNAPSHOT_VECTORS) {
			if (NOT_STRUCTURAL.has(v.name)) continue;
			if (loadTrustSnapshot(v.build().snapshotBytes).ok) accepted.push(v.name);
		}
		expect(accepted).toEqual([]);
	});

	it("accepts every OTHER vector's snapshot — over-rejection blesses nothing", () => {
		const wronglyRejected: string[] = [];
		for (const v of ALL_VECTORS) {
			if (SNAPSHOT_VECTORS.includes(v) && !NOT_STRUCTURAL.has(v.name)) continue;
			const load = loadTrustSnapshot(v.build().snapshotBytes);
			if (!load.ok) wronglyRejected.push(`${v.name}: ${load.detail}`);
		}
		expect(wronglyRejected).toEqual([]);
	});

	it("names each violation it found", () => {
		const detailOf = (name: string): string => {
			const load = loadTrustSnapshot(vector(name).build().snapshotBytes);
			expect(load.ok).toBe(false);
			return load.ok === false ? load.detail : "";
		};
		expect(detailOf("snapshot/duplicate-vault-id")).toMatch(/vaultId/);
		expect(detailOf("snapshot/duplicate-key-id")).toMatch(/keyId/);
		expect(detailOf("snapshot/cyclic-lineage")).toMatch(/cycl/i);
		expect(detailOf("snapshot/one-lineage-two-vaults")).toMatch(/lineage/i);
		expect(detailOf("snapshot/public-key-unparseable")).toMatch(/publicKey/);
		expect(detailOf("snapshot/duplicate-json-key-nested")).toMatch(/duplicate/i);
	});
});

describe("loadTrustSnapshot — parsing and identity", () => {
	const patched = (fn: (s: TrustSnapshot) => void): Buffer =>
		mint({
			snapshot: (s) => {
				fn(s);
				return s;
			},
		}).snapshotBytes;

	it("ALWAYS reports sha256(file bytes), including when it refuses (R-OUT-1)", () => {
		const bytes = Buffer.from("not json at all\n", "utf8");
		const load = loadTrustSnapshot(bytes);
		expect(load.ok).toBe(false);
		expect(load.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
	});

	it("surfaces the document's own version and predecessor when present (§8)", () => {
		const load = loadTrustSnapshot(
			patched((s) => {
				s.version = "2026-08-12.1";
				s.predecessorHash = "b".repeat(64);
			}),
		);
		expect(load.ok).toBe(true);
		if (!load.ok) return;
		expect(load.snapshot.identity.version).toBe("2026-08-12.1");
		expect(load.snapshot.identity.predecessor).toBe("b".repeat(64));
	});

	it("carries the DECLARED version and predecessor through a structural REFUSAL too (R-OUT-1)", () => {
		// The refusal is when an operator most needs to know WHICH snapshot: the
		// two facts are readable the moment the document parses, long before any
		// structural rule runs, so reporting the file as anonymous afterwards
		// throws away identity the loader was already holding.
		const load = loadTrustSnapshot(
			patched((s) => {
				s.version = "2026-08-12.1";
				s.predecessorHash = "b".repeat(64);
				s.chains.push(structuredClone(s.chains[0] as (typeof s.chains)[number]));
			}),
		);
		expect(load.ok).toBe(false);
		if (load.ok) return;
		expect(load.detail).toMatch(/vaultId/);
		expect(load.identity.sha256).toBe(load.sha256);
		expect(load.identity.version).toBe("2026-08-12.1");
		expect(load.identity.predecessor).toBe("b".repeat(64));
	});

	it("reports a null version and predecessor when the bytes never became a document", () => {
		// The other side of the same rule: nothing was declared, so nothing is
		// invented. `sha256` is the only identity such a file has.
		const bytes = Buffer.from("not json at all\n", "utf8");
		const load = loadTrustSnapshot(bytes);
		expect(load.ok).toBe(false);
		if (load.ok) return;
		expect(load.identity).toEqual({
			sha256: createHash("sha256").update(bytes).digest("hex"),
			version: null,
			predecessor: null,
		});
	});

	it("tolerates unknown members — a v1 strict reader would brick every pinned CLI (§4)", () => {
		const load = loadTrustSnapshot(
			patched((s) => {
				s.snapshotSignature = { alg: "ed25519", sig: "AAAA" };
			}),
		);
		expect(load.ok).toBe(true);
	});

	/**
	 * The receipt-side defect (`schema/fractional-token-rounds-to-integer`), on
	 * the SNAPSHOT side.
	 *
	 * `JSON.parse` ROUNDS: `18.000000000000001` has no double representation and
	 * comes back as exactly `18`, so `safeNonNegativeInteger` — and every other
	 * value-level check — is asking about a number the document never carried. A
	 * malformed literal then authorizes a rounded key window, silently, and the
	 * only place the distinction still exists is the TEXT.
	 *
	 * The frozen numeric rules were deliberately scoped to receipt bytes and NOT
	 * to the snapshot, because §4 tolerates unknown snapshot members so the open
	 * signing scheme can add them — and one of them may legitimately carry a
	 * fraction. That scoping is right for the members nobody has declared yet and
	 * wrong for the two this loader READS as integers, which is exactly how far
	 * the rule below reaches.
	 */
	describe("the DECLARED integer members are checked on the literal, not on the rounded value", () => {
		const INTEGER_MEMBERS = ["activationSequence", "headSegmentFirstSequence"] as const;

		/** The clean snapshot, with `member`'s literal rewritten in the BYTES.
		 * Both members are placed at 18 first so one needle serves both. */
		const withLiteral = (member: string, literal: string): Buffer =>
			mint({
				snapshot: (s) => {
					const key = s.keys.find((k) => k.keyId === CHECKPOINT_KEY.keyId);
					if (key !== undefined) {
						// A boundary needs a successor, or the per-entry rule refuses the
						// entry before the literal is ever reached.
						key.state = "retired";
						key.activationSequence = 18;
						s.keys.push({
							keyId: CHECKPOINT_KEY_SUCCESSOR.keyId,
							alg: "ed25519",
							publicKey: CHECKPOINT_KEY_SUCCESSOR.publicKeyPem,
							role: "checkpoint",
							predecessorKeyId: CHECKPOINT_KEY.keyId,
							state: "active",
						});
					}
					const chain = s.chains[0];
					if (chain !== undefined) chain.headSegmentFirstSequence = 18;
					return s;
				},
				snapshotBytes: (b) => replaceOnce(b, `"${member}": 18`, `"${member}": ${literal}`),
			}).snapshotBytes;

		it("loads the conformant integer literal — the rule refuses a spelling, not a member", () => {
			for (const member of INTEGER_MEMBERS) {
				const load = loadTrustSnapshot(withLiteral(member, "18"));
				expect(load.ok === true || load.detail, member).toBe(true);
			}
		});

		for (const member of INTEGER_MEMBERS) {
			it(`refuses a fractional ${member} that JSON.parse rounds back to a legal integer`, () => {
				const load = loadTrustSnapshot(withLiteral(member, "18.000000000000001"));
				expect(load.ok, member).toBe(false);
				expect(load.ok === false && load.detail, member).toContain(member);
				expect(load.ok === false && load.detail, member).toContain("non-integer number");
				// The LITERAL, not the rounded value — an operator has to be able to
				// find the byte that was wrong.
				expect(load.ok === false && load.detail, member).toContain("18.000000000000001");
			});

			it(`refuses an exponent-form ${member}: §13's canonical integer never carries one`, () => {
				const load = loadTrustSnapshot(withLiteral(member, "1.8e1"));
				expect(load.ok, member).toBe(false);
			});
		}

		it("leaves fractions LEGAL in unknown snapshot members — §4's forward-compat rule survives", () => {
			// The scoping decision, asserted rather than assumed: the signing scheme
			// is a live ship-gate item, and a rule that swept the whole document
			// would brick every pinned CLI the day it lands carrying a float.
			const load = loadTrustSnapshot(
				patched((s) => {
					s.snapshotSignature = { alg: "ed25519", sig: "AAAA", confidence: 0.5 };
					s.rotationPolicy = { maxAgeDays: 90.5, activationSequence: 1.5 };
				}),
			);
			expect(load.ok === true || load.detail).toBe(true);
		});

		it("still refuses a NON-FINITE literal anywhere, declared or not — canonicalize throws on it", () => {
			// The one clause that binds over the whole document regardless of
			// scoping, and it must not have been narrowed by the rule above.
			const load = loadTrustSnapshot(
				Buffer.from(
					mint()
						.snapshotBytes.toString("utf8")
						.replace('"mintActor": {', '"huge": 1e999,\n  "mintActor": {'),
					"utf8",
				),
			);
			expect(load.ok).toBe(false);
			expect(load.ok === false && load.detail).toContain("non-finite");
		});
	});

	it("rejects duplicate JSON keys even though unknown MEMBERS are tolerated", () => {
		const bytes = mint().snapshotBytes;
		const dup = Buffer.from(bytes.toString("utf8").replace("{", '{\n  "keys": [],'), "utf8");
		expect(loadTrustSnapshot(dup).ok).toBe(false);
	});

	it("accepts a base64 SPKI publicKey as well as PEM, and rejects non-canonical base64", () => {
		const spki = loadTrustSnapshot(
			patched((s) => {
				const key = s.keys.find((k) => k.keyId === MINT_KEY.keyId);
				if (key) key.publicKey = MINT_KEY.publicKeySpkiBase64;
			}),
		);
		expect(spki.ok).toBe(true);

		const junked = loadTrustSnapshot(
			patched((s) => {
				const key = s.keys.find((k) => k.keyId === MINT_KEY.keyId);
				if (key) key.publicKey = `${MINT_KEY.publicKeySpkiBase64}\n`;
			}),
		);
		expect(junked.ok).toBe(false);
	});

	it("hands Task 3 a usable KeyObject and the pinned checkpoint lineage", () => {
		const load = loadTrustSnapshot(mint().snapshotBytes);
		expect(load.ok).toBe(true);
		if (!load.ok) return;
		const key = load.snapshot.keys.get(MINT_KEY.keyId);
		expect(key?.role).toBe("mint");
		expect(key?.state).toBe("active");
		expect(key?.minterKind).toBe("proxy");
		expect(key?.publicKey.export({ type: "spki", format: "der" })).toEqual(
			createPublicKey(MINT_KEY.publicKeyPem).export({ type: "spki", format: "der" }),
		);
		const chain = load.snapshot.chains.get("vlt_ut_proxy_prod_1");
		expect(chain?.checkpointRootKeyId).toBe(CHECKPOINT_KEY.keyId);
		expect([...(chain?.checkpointLineage ?? [])]).toEqual([CHECKPOINT_KEY.keyId]);
		expect(chain?.mintKeyIds).toEqual([MINT_KEY.keyId]);
	});

	it("pins a rotation lineage in BOTH directions from the pinned member", () => {
		const load = loadTrustSnapshot(
			patched((s) => {
				// A CONFORMANT rotation: the predecessor is retired at the boundary
				// its successor activates on. §8 gives an `active` key no upper
				// bound because it "has no successor yet", so leaving the pinned key
				// active while declaring a successor is the contradiction
				// `validateLineages` now refuses — see the dedicated test below.
				const predecessor = s.keys.find((k) => k.keyId === CHECKPOINT_KEY.keyId);
				if (predecessor !== undefined) {
					predecessor.state = "retired";
					predecessor.activationSequence = 18;
				}
				s.keys.push({
					keyId: "utk_ckpt_2026_10",
					alg: "ed25519",
					publicKey: MINT_KEY_SUCCESSOR.publicKeyPem,
					role: "checkpoint",
					predecessorKeyId: CHECKPOINT_KEY.keyId,
					state: "active",
				});
			}),
		);
		expect(load.ok).toBe(true);
		if (!load.ok) return;
		const lineage = load.snapshot.chains.get("vlt_ut_proxy_prod_1")?.checkpointLineage;
		expect([...(lineage ?? [])].sort()).toEqual([CHECKPOINT_KEY.keyId, "utk_ckpt_2026_10"]);
	});

	/**
	 * §8 RULES `genesisChoice: "newVault"` for ut1 (Cam, 2026-08-12), against
	 * evidence: segment rotation has never run in production, there are zero
	 * finalized segments, and `"backfill"` would have re-issued v2 statements
	 * over nothing. So on a `proxy-v1` chain the member is not a two-valued
	 * union — it has exactly one admissible value, and absent is not it.
	 *
	 * Nothing downstream can catch this. `genesisChoice` is a SNAPSHOT-ONLY fact:
	 * no receipt field disagrees with it, so no §7 equality reaches it, and §7's
	 * history walk happily roots at the registered `genesisSegmentId` whatever
	 * the snapshot says produced it. The loader is the only place the rule can
	 * live, and §8's own resolution for a document it does not admit is
	 * UNVERIFIABLE, never a pass.
	 *
	 * Conditioned on the profile because the RULING is: a future ut-chain profile
	 * ships under a different literal (§4a) and its genesis story is not this
	 * one's. There is no evasion in that: a receipt can only reach the history
	 * walk through equality 8, which pins `chain.profile === proof.profile ===
	 * "proxy-v1"`.
	 */
	it("refuses a proxy-v1 chain whose genesisChoice is not §8's RULED newVault", () => {
		for (const value of ["backfill", undefined]) {
			const load = loadTrustSnapshot(
				patched((s) => {
					const chain = s.chains[0] as Record<string, unknown>;
					if (value === undefined) delete chain.genesisChoice;
					else chain.genesisChoice = value;
				}),
			);
			expect(load.ok, String(value)).toBe(false);
			expect(load.ok === false && load.detail).toMatch(/genesisChoice/);
		}
		// The conformant value loads — the rule refuses one snapshot, not the
		// member.
		expect(loadTrustSnapshot(mint().snapshotBytes).ok).toBe(true);
	});

	/**
	 * §8 defines the boundary as "set at the moment its successor activates, and
	 * equals the successor's first sealed segment's `segmentFirstSequence`", and
	 * §4a makes `segmentFirstSequence` strictly increasing over sealed segments.
	 * Together those fix the ORDER of the boundaries along a lineage: an older
	 * key's boundary can never sit past a newer key's.
	 *
	 * A snapshot that inverts them is not a rounding error — it is the retirement
	 * bound running backwards, which hands the OLDEST key in the lineage the
	 * WIDEST window. `keyStatePermits` reads one entry, so it cannot see it, and
	 * the checkpoint then verifies under a key that was rotated away long before
	 * it was signed. Like `genesisChoice`, no receipt field disagrees with it, so
	 * the loader is the only place it can be caught.
	 */
	it("refuses an activationSequence that runs BACKWARD along a rotation lineage", () => {
		const rotated = (predecessorBoundary: number, successorBoundary: number): Buffer =>
			patched((s) => {
				const predecessor = s.keys.find((k) => k.keyId === CHECKPOINT_KEY.keyId);
				if (predecessor !== undefined) {
					predecessor.state = "retired";
					predecessor.activationSequence = predecessorBoundary;
				}
				s.keys.push({
					keyId: "utk_ckpt_2026_10",
					alg: "ed25519",
					publicKey: MINT_KEY_SUCCESSOR.publicKeyPem,
					role: "checkpoint",
					predecessorKeyId: CHECKPOINT_KEY.keyId,
					state: "retired",
					activationSequence: successorBoundary,
				});
				s.keys.push({
					keyId: "utk_ckpt_2026_11",
					alg: "ed25519",
					publicKey: FOREIGN_KEY.publicKeyPem,
					role: "checkpoint",
					predecessorKeyId: "utk_ckpt_2026_10",
					state: "active",
				});
			});

		const inverted = loadTrustSnapshot(rotated(40, 18));
		expect(inverted.ok).toBe(false);
		expect(inverted.ok === false && inverted.detail).toMatch(/activationSequence/);

		// Increasing is the conformant shape, and EQUAL is the honest encoding of
		// a rotation whose successor sealed no segment before rotating again —
		// only the inversion is refused.
		expect(loadTrustSnapshot(rotated(18, 40)).ok).toBe(true);
		expect(loadTrustSnapshot(rotated(18, 18)).ok).toBe(true);
	});

	it("refuses a snapshot missing the members every check consumes", () => {
		for (const drop of ["keys", "chains"] as const) {
			const bytes = patched((s) => {
				delete (s as Record<string, unknown>)[drop];
			});
			expect(loadTrustSnapshot(bytes).ok).toBe(false);
		}
	});

	it("rejects the OTHER half of §8's role separation: a MINT key pinned as checkpoint root", () => {
		// `snapshot/role-kind-violation` covers "a mint keyId with role
		// `checkpoint`". §8 says "or vice versa", and the vice-versa direction is
		// the one that would let a mint key sign checkpoints for the chain.
		const load = loadTrustSnapshot(
			patched((s) => {
				const chain = s.chains[0] as { checkpointRootKeyId: string };
				chain.checkpointRootKeyId = MINT_KEY.keyId;
			}),
		);
		expect(load.ok).toBe(false);
		expect(load.ok === false && load.detail).toMatch(/role is mint/);
	});

	it("refuses malformed key and chain entries rather than resolving them by luck", () => {
		const bad: ReadonlyArray<(s: TrustSnapshot) => void> = [
			(s) => {
				const key = s.keys[0] as Record<string, unknown>;
				key.role = "signer";
			},
			(s) => {
				const key = s.keys[0] as Record<string, unknown>;
				key.minterKind = 7;
			},
			(s) => {
				const key = s.keys[0] as Record<string, unknown>;
				key.predecessorKeyId = "";
			},
			(s) => {
				const key = s.keys[0] as Record<string, unknown>;
				key.alg = "";
			},
			(s) => {
				const key = s.keys[0] as Record<string, unknown>;
				delete key.keyId;
			},
			(s) => {
				(s.keys as unknown[])[0] = "utk_mint_2026_08";
			},
			(s) => {
				(s.chains as unknown[])[0] = "vlt_ut_proxy_prod_1";
			},
			(s) => {
				const chain = s.chains[0] as Record<string, unknown>;
				delete chain.vaultId;
			},
			(s) => {
				const chain = s.chains[0] as Record<string, unknown>;
				delete chain.profile;
			},
			(s) => {
				const chain = s.chains[0] as Record<string, unknown>;
				delete chain.genesisSegmentId;
			},
			(s) => {
				const chain = s.chains[0] as Record<string, unknown>;
				chain.headSegmentId = 4;
			},
			(s) => {
				const chain = s.chains[0] as Record<string, unknown>;
				chain.headSegmentFirstSequence = -1;
			},
			(s) => {
				const chain = s.chains[0] as Record<string, unknown>;
				(chain.mintKeyIds as unknown[])[0] = 7;
			},
			(s) => {
				const key = s.keys[0] as Record<string, unknown>;
				key.state = "probationary";
			},
			(s) => {
				const key = s.keys[0] as Record<string, unknown>;
				delete key.publicKey;
			},
			(s) => {
				const key = s.keys[0] as Record<string, unknown>;
				key.activationSequence = 1.5;
				key.state = "retired";
			},
			(s) => {
				const chain = s.chains[0] as Record<string, unknown>;
				delete chain.checkpointRootKeyId;
			},
			(s) => {
				const chain = s.chains[0] as Record<string, unknown>;
				delete chain.mintActor;
			},
			(s) => {
				const chain = s.chains[0] as Record<string, unknown>;
				chain.mintKeyIds = "utk_mint_2026_08";
			},
			(s) => {
				const chain = s.chains[0] as Record<string, unknown>;
				chain.genesisChoice = "somethingElse";
			},
		];
		for (const mutate of bad) {
			expect(loadTrustSnapshot(patched(mutate)).ok).toBe(false);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — key material is Ed25519 BY TYPE, never by the label next to it.
//
// ALGORITHM CONFUSION. `verifyEd25519` reaches `crypto.verify(null, …)`, and
// `null` there means "infer the algorithm from the key" — so the key material
// decides which algorithm runs, and the snapshot's `alg` decides nothing at
// all. A snapshot that labels an RSA key `alg: "ed25519"` therefore had its RSA
// signatures verified, under a profile that permits Ed25519 only, and an
// RSA-signed checkpoint could reach VERIFIED_CHECKPOINT.
//
// The constraint is bound at the LOADER, which is the one place every key
// passes through, rather than at each verify site — and the type it returns is
// what carries it, so a verify site added tomorrow inherits the check instead
// of having to remember it. These tests grade the door, not the two rooms
// behind it.
// ─────────────────────────────────────────────────────────────────────────────

describe("§8 — a snapshot key is refused on its MATERIAL, whatever its alg says", () => {
	const patched = (fn: (s: TrustSnapshot) => void): Buffer =>
		mint({
			snapshot: (s) => {
				fn(s);
				return s;
			},
		}).snapshotBytes;

	/**
	 * A `HarnessKey` over material that is NOT Ed25519. Every one of these signs
	 * through `crypto.sign(null, …)` exactly as the harness's Ed25519 keys do,
	 * which is the whole problem: nothing about the CALL distinguishes them.
	 */
	function foreignMaterial(keyId: string, type: "rsa" | "ec" | "ed448"): HarnessKey {
		const pair =
			type === "rsa"
				? generateKeyPairSync("rsa", { modulusLength: 2048 })
				: type === "ec"
					? generateKeyPairSync("ec", { namedCurve: "P-256" })
					: generateKeyPairSync("ed448");
		return {
			keyId,
			privateKey: pair.privateKey,
			publicKey: pair.publicKey,
			publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
			publicKeySpkiBase64: (
				pair.publicKey.export({ type: "spki", format: "der" }) as Buffer
			).toString("base64"),
		};
	}

	const RSA = foreignMaterial(CHECKPOINT_KEY.keyId, "rsa");

	it("proves the premise: an RSA signature VERIFIES through the Ed25519 helper", () => {
		// The finding, reproduced against the real helper rather than argued. If
		// this ever stops being true the vectors below become tautologies, and a
		// tautology scores the same as a catch.
		const preimage = "usertrust/algorithm-confusion-premise";
		const signature = sign(null, Buffer.from(preimage, "utf8"), RSA.privateKey).toString("base64");
		expect(verifySignatureRaw("ed25519", preimage, RSA.publicKey, signature)).toBe(true);
		// And it is not RSA-specific: `null` infers from whatever key it is given.
		const ed448 = foreignMaterial("utk_ed448", "ed448");
		const sig448 = sign(null, Buffer.from(preimage, "utf8"), ed448.privateKey).toString("base64");
		expect(verifySignatureRaw("ed25519", preimage, ed448.publicKey, sig448)).toBe(true);
	});

	it("refuses every non-Ed25519 key type at LOAD, naming the material it found", () => {
		// Not "reject RSA": the door is the same width for every type that can
		// sign, and a check written against the instance that revealed it would
		// leave ECDSA and Ed448 through.
		for (const type of ["rsa", "ec", "ed448"] as const) {
			const key = foreignMaterial(MINT_KEY.keyId, type);
			for (const encoding of ["pem", "spki"] as const) {
				const load = loadTrustSnapshot(
					patched((s) => {
						const entry = s.keys.find((k) => k.keyId === MINT_KEY.keyId);
						// The label stays `ed25519` — that is the attack.
						if (entry) {
							entry.publicKey = encoding === "pem" ? key.publicKeyPem : key.publicKeySpkiBase64;
						}
					}),
				);
				const where = `${type}/${encoding}`;
				expect(load.ok, where).toBe(false);
				expect(load.ok === false && load.detail, where).toContain(MINT_KEY.keyId);
				expect(load.ok === false && load.detail, where).toContain("ut1 verifies Ed25519 only");
				expect(load.ok === false && load.detail, where).toContain(
					type === "ec" ? "ec material" : `${type} material`,
				);
			}
		}
	});

	it("stops an RSA-signed CHECKPOINT end to end — the verdict is never reached", () => {
		// The whole attack, minted: the checkpoint is signed with RSA and the
		// snapshot registers the RSA public key under the checkpoint keyId, still
		// labelled `ed25519`. The run cannot start, because the snapshot cannot
		// load — §4 makes a key type the profile does not permit a structurally
		// invalid SNAPSHOT (UNVERIFIABLE), not a failed verification of a good one.
		const bundle = mint({
			checkpointSigner: () => RSA,
			snapshot: (s) => {
				const entry = s.keys.find((k) => k.keyId === CHECKPOINT_KEY.keyId);
				if (entry) entry.publicKey = RSA.publicKeyPem;
				return s;
			},
		});
		const load = loadTrustSnapshot(bundle.snapshotBytes);
		expect(load.ok).toBe(false);
		expect(load.ok === false && load.detail).toContain("rsa material");

		// And the RSA signature it carries really would have satisfied step 6 —
		// so the load-time refusal is what stands between it and the rung.
		const checkpoint = (bundle.receipt.proof as { checkpoint: SegmentCheckpoint }).checkpoint;
		const { sig, ...unsigned } = checkpoint;
		expect(verifySignatureRaw("ed25519", checkpointPreimage(unsigned), RSA.publicKey, sig)).toBe(
			true,
		);
	});

	it("POSITIVE CONTROL: the real Ed25519 snapshot loads and its receipt verifies", () => {
		// The direction a refusal-only suite cannot see. Both encodings, because
		// the constraint sits after both arms of the parser.
		for (const encoding of ["pem", "spki"] as const) {
			const bundle = mint({
				snapshot: (s) => {
					for (const entry of s.keys) {
						const key = ALL_KEYS.find((k) => k.keyId === entry.keyId);
						if (key) {
							entry.publicKey = encoding === "pem" ? key.publicKeyPem : key.publicKeySpkiBase64;
						}
					}
					return s;
				},
			});
			const load = loadTrustSnapshot(bundle.snapshotBytes);
			expect(load.ok === true || (load.ok === false && load.detail), encoding).toBe(true);
			if (!load.ok) continue;
			const run = verifyReceiptBase({
				receiptBytes: bundle.receiptBytes,
				snapshot: load.snapshot,
			});
			expect(run.verdict, encoding).toBe("VERIFIED_CHECKPOINT");
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — the pinned bytes are the KEY, and one key has one encoding.
//
// `createPublicKey` reads the leading SPKI value out of a DER buffer and
// ignores everything after it, so `valid-SPKI-DER ‖ junk` loads as the same key
// the clean bytes do. Two distinct byte strings then name one key: this
// verifier accepts a snapshot that a strict DER verifier refuses outright, and
// the two disagree about the same pinned material — which is exactly the
// independent-verifiability property §8 exists to provide.
// ─────────────────────────────────────────────────────────────────────────────

describe("§8 — a publicKey must SPAN the bytes it was decoded from", () => {
	const patched = (fn: (s: TrustSnapshot) => void): Buffer =>
		mint({
			snapshot: (s) => {
				fn(s);
				return s;
			},
		}).snapshotBytes;

	const CLEAN = MINT_KEY.publicKeySpkiBase64;
	/** Canonical base64 of `SPKI DER ‖ n junk bytes`. */
	const withSuffix = (n: number): string =>
		Buffer.concat([Buffer.from(CLEAN, "base64"), Buffer.alloc(n, 0x2a)]).toString("base64");

	const loadWith = (publicKey: string): ReturnType<typeof loadTrustSnapshot> =>
		loadTrustSnapshot(
			patched((s) => {
				const entry = s.keys.find((k) => k.keyId === MINT_KEY.keyId);
				if (entry) entry.publicKey = publicKey;
			}),
		);

	it("proves the premise: Node loads the suffixed bytes AS THE CLEAN KEY", () => {
		// Without this the vector proves nothing — a suffix Node already rejected
		// would be refused here for a reason that has nothing to do with the fix.
		const suffixed = createPublicKey({
			key: Buffer.from(withSuffix(4), "base64"),
			format: "der",
			type: "spki",
		});
		expect(suffixed.export({ type: "spki", format: "der" })).toEqual(
			createPublicKey(MINT_KEY.publicKeyPem).export({ type: "spki", format: "der" }),
		);
		// The two encodings really are different bytes — the ONLY thing that makes
		// this an interop split rather than a re-spelling.
		expect(withSuffix(4)).not.toBe(CLEAN);
	});

	it("refuses trailing bytes, and says how many ran past the value", () => {
		for (const n of [1, 4, 64]) {
			const load = loadWith(withSuffix(n));
			expect(load.ok, `+${n}`).toBe(false);
			expect(load.ok === false && load.detail, `+${n}`).toContain(
				`carries ${n} byte(s) past the end of its SPKI DER value`,
			);
		}
	});

	it("the two byte strings do NOT both load — exactly one is the key", () => {
		expect(loadWith(CLEAN).ok).toBe(true);
		expect(loadWith(withSuffix(4)).ok).toBe(false);
	});

	it("POSITIVE CONTROL: the same key WITHOUT the suffix still verifies its receipt", () => {
		const bundle = mint({
			snapshot: (s) => {
				const entry = s.keys.find((k) => k.keyId === MINT_KEY.keyId);
				if (entry) entry.publicKey = CLEAN;
				return s;
			},
		});
		const load = loadTrustSnapshot(bundle.snapshotBytes);
		expect(load.ok === true || (load.ok === false && load.detail)).toBe(true);
		if (!load.ok) return;
		expect(
			verifyReceiptBase({ receiptBytes: bundle.receiptBytes, snapshot: load.snapshot }).verdict,
		).toBe("VERIFIED_CHECKPOINT");
	});

	it("refuses the non-minimal DER spellings that would be a SECOND encoding", () => {
		// A long-form length carrying what the short form could have said, and a
		// leading zero length byte, are both a second way to write one key —
		// the same defect as a suffix, wearing a hat.
		const der = Buffer.from(CLEAN, "base64");
		const body = der.subarray(2);
		const longForm = Buffer.concat([Buffer.from([0x30, 0x81, body.length]), body]);
		const leadingZero = Buffer.concat([Buffer.from([0x30, 0x82, 0x00, body.length]), body]);
		for (const [name, bytes] of [
			["long form for a short length", longForm],
			["leading zero in the length", leadingZero],
		] as const) {
			const load = loadWith(bytes.toString("base64"));
			expect(load.ok, name).toBe(false);
			expect(load.ok === false && load.detail, name).toContain("does not decode to one DER value");
		}
	});

	it("refuses every malformed DER HEADER, rather than trusting the length it reads", () => {
		// The fail-closed arms of the length reader, each with a vector: a reader
		// that trusted the header would compute a span from bytes that do not
		// describe one, and a span computed from junk compares equal to the
		// buffer length as easily as not.
		const body = Buffer.from(CLEAN, "base64").subarray(2);
		for (const [name, bytes] of [
			["shorter than a header", Buffer.from([0x30])],
			["not a SEQUENCE", Buffer.from([0x02, 0x01, 0x00])],
			["BER's indefinite length", Buffer.concat([Buffer.from([0x30, 0x80]), body])],
			["a length longer than any key", Buffer.concat([Buffer.from([0x30, 0x85]), body])],
			["a length field truncated away", Buffer.from([0x30, 0x84, 0x00])],
		] as const) {
			const load = loadWith(bytes.toString("base64"));
			expect(load.ok, name).toBe(false);
			expect(load.ok === false && load.detail, name).toContain("does not decode to one DER value");
		}
		// And a well-formed SEQUENCE that spans its buffer but is not a key still
		// reaches the parser and is refused there — the length gate is not a
		// substitute for parsing.
		const notAKey = loadWith(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]).toString("base64"));
		expect(notAKey.ok).toBe(false);
		expect(notAKey.ok === false && notAKey.detail).toContain("does not parse");
	});

	it("refuses a PEM block that is not a PUBLIC KEY block", () => {
		const load = loadWith(`-----BEGIN CERTIFICATE-----\n${CLEAN}\n-----END CERTIFICATE-----\n`);
		expect(load.ok).toBe(false);
		expect(load.ok === false && load.detail).toContain("is not a PEM SPKI block");
	});

	it("refuses the SAME suffix inside a PEM block — both arms, one rule", () => {
		// This arm was nearly shipped unchecked on the strength of a probe that
		// said Node refused it. Node does not: it accepts the suffix wrapped and
		// unwrapped alike, and returns the clean key. Both spellings are asserted
		// here because a rule that holds for one line-wrapping is not a rule.
		const wrapped = (withSuffix(4).match(/.{1,64}/g) ?? []).join("\n");
		for (const [name, body] of [
			["one line", withSuffix(4)],
			["wrapped at 64", wrapped],
		] as const) {
			const pem = `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
			// The premise, per spelling: Node really does take these bytes.
			expect(createPublicKey(pem).export({ type: "spki", format: "der" }), name).toEqual(
				createPublicKey(MINT_KEY.publicKeyPem).export({ type: "spki", format: "der" }),
			);
			const load = loadWith(pem);
			expect(load.ok, name).toBe(false);
			expect(load.ok === false && load.detail, name).toContain(
				"carries 4 byte(s) past the end of its SPKI DER value",
			);
		}
	});

	it("POSITIVE CONTROL: the ordinary PEM every snapshot carries still loads", () => {
		// The default corpus snapshot is PEM-encoded, so this is also asserted by
		// every other test in the package — stated here because the PEM arm just
		// gained a parser of its own, and a too-strict envelope regex would refuse
		// every conformant snapshot in existence.
		expect(loadWith(MINT_KEY.publicKeyPem).ok).toBe(true);
		expect(loadTrustSnapshot(mint().snapshotBytes).ok).toBe(true);
		// Line endings are the encoding's business, not the value's.
		expect(loadWith(MINT_KEY.publicKeyPem.replace(/\n/g, "\r\n")).ok).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — and the encoding must be THE canonical DER, AT EVERY DEPTH.
//
// The span check above reads the OUTER TLV. An SPKI is four nested TLVs, and a
// length spelled in DER's long form where the short form would do is a second
// encoding of one key at whichever of them it appears:
//
//   30 2a | 30 05 | 06 03 2b 65 70 | 03 21 00 ‖ 32 bytes     ← canonical
//   30 2b | 30 81 05 | …                                     ← depth 2
//   30 2b | 30 06 | 06 81 03 2b 65 70 | …                    ← depth 3
//   30 2b | 30 05 | … | 03 81 21 00 ‖ 32 bytes               ← depth 2, sibling
//
// All three keep the outer length honest, so the outer span check waves them
// through — and Node loads every one of them as the clean key. Adding an
// inner-length check would have closed depth 2 and left depth 3; there is no
// depth at which such an enumeration ends.
//
// So the rule is a ROUND TRIP. Node normalizes on parse, so exporting the
// parsed key back to SPKI DER and demanding byte equality with the input
// refuses every non-canonical spelling at once, including ones nobody here has
// thought of. These tests grade that claim as a CLASS: the vector Codex named,
// plus the same defect at a different depth, refused by the same check with the
// same reason.
// ─────────────────────────────────────────────────────────────────────────────

describe("§8 — a publicKey must be the CANONICAL DER of the key it decodes to", () => {
	const CLEAN_DER = Buffer.from(MINT_KEY.publicKeySpkiBase64, "base64");
	/** The 32-byte Ed25519 point, taken from the end rather than by a fixed offset. */
	const RAW = CLEAN_DER.subarray(CLEAN_DER.length - 32);

	type Depth = "canonical" | "outer" | "algorithm" | "oid" | "bitString";

	/**
	 * An Ed25519 SPKI assembled from its four TLVs, with exactly one of them
	 * spelling its length in the long form. Assembled rather than hand-written
	 * so the ENCLOSING lengths adapt: a long-form OID makes the
	 * AlgorithmIdentifier one byte longer, and the mutant stays well-formed
	 * everywhere except at the depth under test. A hand-written buffer would
	 * have to be re-counted per depth, and a mis-count reads as a pass.
	 */
	const spki = (nonMinimalAt: Depth): Buffer => {
		const len = (n: number, here: Depth): number[] => (nonMinimalAt === here ? [0x81, n] : [n]);
		const oid = [0x06, ...len(3, "oid"), 0x2b, 0x65, 0x70];
		const algorithm = [0x30, ...len(oid.length, "algorithm"), ...oid];
		const bits = [0x00, ...RAW];
		const bitString = [0x03, ...len(bits.length, "bitString"), ...bits];
		const body = [...algorithm, ...bitString];
		return Buffer.from([0x30, ...len(body.length, "outer"), ...body]);
	};

	const patched = (fn: (s: TrustSnapshot) => void): Buffer =>
		mint({
			snapshot: (s) => {
				fn(s);
				return s;
			},
		}).snapshotBytes;

	const loadWith = (publicKey: string): ReturnType<typeof loadTrustSnapshot> =>
		loadTrustSnapshot(
			patched((s) => {
				const entry = s.keys.find((k) => k.keyId === MINT_KEY.keyId);
				if (entry) entry.publicKey = publicKey;
			}),
		);

	const asPem = (der: Buffer): string =>
		`-----BEGIN PUBLIC KEY-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END PUBLIC KEY-----\n`;

	/** The three that the OUTER span check cannot see. `outer` is listed apart. */
	const INNER: readonly Depth[] = ["algorithm", "oid", "bitString"];

	it("the builder is honest: `canonical` reproduces the real key byte for byte", () => {
		// Everything below rests on the assembler, so it is checked against the
		// key the harness actually minted before any mutant is trusted.
		expect(spki("canonical")).toEqual(CLEAN_DER);
		// And the named vector really is the one Codex named.
		expect(spki("algorithm").subarray(0, 5).toString("hex")).toBe("302b308105");
	});

	it("proves the premise: the OUTER span check waves each of them through", () => {
		// This is what makes them a different defect from the trailing-suffix one.
		// The outer length is short-form and spans the buffer exactly, so the
		// check that catches a suffix has nothing to say about any of these.
		for (const depth of INNER) {
			const der = spki(depth);
			expect(der[0], depth).toBe(0x30);
			expect(der[1], depth).toBeLessThan(0x80);
			expect((der[1] as number) + 2, depth).toBe(der.length);
			// One byte longer than the canonical encoding of the same key — so
			// these ARE two byte strings, not a re-spelling of one.
			expect(der.length, depth).toBe(CLEAN_DER.length + 1);
			expect(der.equals(CLEAN_DER), depth).toBe(false);
		}
	});

	it("proves the premise: Node loads every one of them AS THE CLEAN KEY", () => {
		// Both arms, because a rule that holds for one encoding is not a rule.
		for (const depth of INNER) {
			const der = spki(depth);
			for (const [arm, loaded] of [
				["der", createPublicKey({ key: der, format: "der", type: "spki" })],
				["pem", createPublicKey(asPem(der))],
			] as const) {
				expect(loaded.asymmetricKeyType, `${depth}/${arm}`).toBe("ed25519");
				expect(loaded.export({ type: "spki", format: "der" }), `${depth}/${arm}`).toEqual(
					CLEAN_DER,
				);
			}
		}
	});

	it("REFUSES the non-minimal INNER length Codex named — and at TWO more depths", () => {
		// Depth 2 (the AlgorithmIdentifier SEQUENCE) is the reported instance;
		// depth 3 (inside the OID) and depth 2's sibling (the BIT STRING) are the
		// proof that what was fixed is the class. One check, one reason, every
		// depth — which is what a per-instance fix could not have produced.
		for (const depth of INNER) {
			for (const [arm, encoded] of [
				["base64", spki(depth).toString("base64")],
				["pem", asPem(spki(depth))],
			] as const) {
				const load = loadWith(encoded);
				const where = `${depth}/${arm}`;
				expect(load.ok, where).toBe(false);
				expect(load.ok === false && load.detail, where).toContain(MINT_KEY.keyId);
				expect(load.ok === false && load.detail, where).toContain(
					"is not the canonical DER encoding of the key it decodes to",
				);
				// The byte counts, so the refusal is actionable rather than a shrug.
				expect(load.ok === false && load.detail, where).toContain("45 byte(s) in");
				expect(load.ok === false && load.detail, where).toContain("44 byte(s) back out");
			}
		}
	});

	it("the outer depth is refused too — by the span check, which keeps its wording", () => {
		// Depth 1 is the one the earlier fix already covered. It is asserted here
		// so the depth sweep is complete, and asserted at its OWN message so the
		// two checks stay distinguishable: if this ever starts reporting the
		// round-trip's reason, the span check has silently stopped running.
		for (const [arm, encoded] of [
			["base64", spki("outer").toString("base64")],
			["pem", asPem(spki("outer"))],
		] as const) {
			const load = loadWith(encoded);
			expect(load.ok, arm).toBe(false);
			expect(load.ok === false && load.detail, arm).toContain("does not decode to one DER value");
		}
	});

	it("POSITIVE CONTROL: ordinary SPKI base64 and ordinary PEM still load AND verify", () => {
		// The direction a refusal-only suite cannot see, end to end on both arms:
		// the round-trip must accept every conformant key in existence, and a
		// comparison that were subtly wrong (a Buffer/Uint8Array identity check,
		// say) would refuse all of them.
		for (const encoding of ["pem", "spki"] as const) {
			const bundle = mint({
				snapshot: (s) => {
					for (const entry of s.keys) {
						const key = ALL_KEYS.find((k) => k.keyId === entry.keyId);
						if (key) {
							entry.publicKey = encoding === "pem" ? key.publicKeyPem : key.publicKeySpkiBase64;
						}
					}
					return s;
				},
			});
			const load = loadTrustSnapshot(bundle.snapshotBytes);
			expect(load.ok === true || (load.ok === false && load.detail), encoding).toBe(true);
			if (!load.ok) continue;
			expect(
				verifyReceiptBase({ receiptBytes: bundle.receiptBytes, snapshot: load.snapshot }).verdict,
				encoding,
			).toBe("VERIFIED_CHECKPOINT");
		}
		// And the assembler's own canonical output, through the loader, on both
		// arms — the exact bytes the mutants were built from.
		expect(loadWith(spki("canonical").toString("base64")).ok).toBe(true);
		expect(loadWith(asPem(spki("canonical"))).ok).toBe(true);
	});
});
