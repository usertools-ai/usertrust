// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Proves the corpus before anything is graded against it.
 *
 * A mint harness is only as trustworthy as its independence. This file pins
 * three things, in order:
 *
 * 1. The harness canonicalizer reproduces EVERY row of receipt-spec §13's
 *    golden corpus BYTE FOR BYTE — including `[1, undefined, 2]` → `[1,null,2]`,
 *    the case a programmatic harness can actually reach and the exact case
 *    `src/canonical.ts` gets wrong today; the two SILENT rows §13 bolds
 *    (`[undefined]` → `[null]`, `{a:[undefined]}` → `{"a":[null]}`, both valid
 *    JSON with a different digest and no error anywhere); and the two THROW rows
 *    on which §13 records all three real implementations as defective.
 * 2. A clean minted receipt satisfies all NINE §4 equalities, the event-hash
 *    rule, both signatures, the inclusion fold and the transfer-set derivation
 *    — each computed HERE, from the spec text, never by calling the verifier
 *    (which does not exist yet, and a corpus that agrees only with its own
 *    checker proves nothing).
 * 3. Every mutant breaks EXACTLY the facts it declares — no more, no fewer.
 *    An empty declared set on a failing vector is the strongest assertion in
 *    the file: the bytes are cryptographically perfect and only trust state,
 *    §2 semantics or the §7 history walk separates it from a pass.
 */

import { verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
// The two cross-checks below are DIFFERENTIAL: verifier-side code judging
// harness output. The harness itself imports nothing from `src/`.
import { canonicalize as srcCanonicalize } from "../../src/canonical.js";
import { type MerkleInclusionProof, verifyInclusionProof } from "../../src/verify.js";
import { ALL_VECTORS, type Vector } from "./fixtures.js";
import {
	ALL_KEYS,
	ALT_RECEIPT_ID,
	base58Decode,
	base58Encode,
	canonicalizeNormative,
	checkpointPreimage,
	DEFAULT_AMOUNT_USD,
	DEFAULT_RECEIPT_ID,
	DEFAULT_RECEIPT_ID_BYTES,
	eventHash,
	type FactName,
	type HarnessInclusionProof,
	LEADING_ZERO_RECEIPT_ID,
	LONG_DECODE_RECEIPT_ID,
	MINT_ACTOR,
	MINT_EVENT_KIND,
	type MintedBundle,
	merkleInteriorHash,
	merkleLeafHash,
	mint,
	receiptSignaturePreimage,
	SHORT_DECODE_RECEIPT_ID,
	transferSetRoot,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. receipt-spec §13 — the normative canonicalization appendix.
// ─────────────────────────────────────────────────────────────────────────────

describe("canonicalization — receipt-spec §13 golden corpus", () => {
	// A REAL hole, not an explicit `undefined` element: §13 lists the two
	// separately because they reach the algorithm by different routes, and only
	// the hole is invisible to `Array.prototype.map`.
	const sparse: unknown[] = [1, undefined, 2];
	delete sparse[1];

	const rows: readonly (readonly [string, unknown, string])[] = [
		["null", null, "null"],
		["undefined", undefined, "null"],
		["undefined inside an array", [1, undefined, 2], "[1,null,2]"],
		["a real array HOLE is null too", sparse, "[1,null,2]"],
		["[undefined] — the SILENT case: parses either way", [undefined], "[null]"],
		["{a:[undefined]} — the other SILENT case", { a: [undefined] }, '{"a":[null]}'],
		["empty array", [], "[]"],
		["empty object", {}, "{}"],
		["key sort", { b: 1, a: 2 }, '{"a":2,"b":1}'],
		["undefined-valued key is SKIPPED", { a: undefined, b: 1 }, '{"b":1}'],
		["null-valued key is KEPT", { a: null, b: 1 }, '{"a":null,"b":1}'],
		["code-unit order: uppercase first", { Z: 1, a: 1 }, '{"Z":1,"a":1}'],
		["nested sort", { a: { d: 1, c: 2 } }, '{"a":{"c":2,"d":1}}'],
		["zero", { n: 0 }, '{"n":0}'],
		["negative", { n: -1 }, '{"n":-1}'],
		["non-ASCII is not escaped beyond JSON.stringify's own", { s: "é" }, '{"s":"é"}'],
		["quote escaping", { s: 'a"b' }, '{"s":"a\\"b"}'],
	];

	for (const [label, input, expected] of rows) {
		it(`row: ${label}`, () => {
			expect(canonicalizeNormative(input)).toBe(expected);
		});
	}

	for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		it(`throws on ${String(nonFinite)} — a data-corruption signal, never a verdict`, () => {
			expect(() => canonicalizeNormative(nonFinite)).toThrow();
		});
	}

	// Unreachable from wire data — and precisely therefore the rows a harness
	// written "from the spec" is most likely to have copied from the code it
	// is supposed to be independent of.
	it("throws on a value whose serialization is NOT A STRING, rather than emitting `undefined`", () => {
		// Production canonicalize now throws here too. The harness keeps its own
		// error text so this file stays an independent oracle.
		expect(() => canonicalizeNormative({ f: () => 1 })).toThrow(/no JSON serialization/);
		expect(() => canonicalizeNormative(() => 1)).toThrow(/no JSON serialization/);
		expect(() => canonicalizeNormative({ s: Symbol("x") })).toThrow(/no JSON serialization/);
		const withToJSON = (): { z: number; a: number } => ({ z: 1, a: 2 });
		(withToJSON as { toJSON?: () => { z: number; a: number } }).toJSON = () => ({
			z: 1,
			a: 2,
		});
		expect(() => canonicalizeNormative(withToJSON)).toThrow(/no JSON serialization/);
		expect(() => srcCanonicalize(withToJSON)).toThrow(/functions and symbols/);
	});

	it("throws a DELIBERATE, IDENTIFIABLE error on an invalid Date — never a bare RangeError", () => {
		// §13 pins the error identity: a verifier mapping a throw to MALFORMED has
		// to be able to tell a data defect from a crash.
		expect(() => canonicalizeNormative(new Date("not a date"))).toThrow(
			/invalid Date in audit data/,
		);
		expect(() => canonicalizeNormative({ d: new Date("not a date") })).toThrow(
			/invalid Date in audit data/,
		);
	});

	it("still serializes a VALID Date as its ISO-8601 string", () => {
		expect(canonicalizeNormative({ d: new Date("2026-08-11T18:42:14.006Z") })).toBe(
			'{"d":"2026-08-11T18:42:14.006Z"}',
		);
	});

	it("skips inherited keys — the prototype-pollution guard", () => {
		const parent = { inherited: 1 };
		const child = Object.create(parent) as Record<string, unknown>;
		child.own = 2;
		expect(canonicalizeNormative(child)).toBe('{"own":2}');
	});

	it("DIVERGES from src/canonical.ts on exactly the rows §13 records, and nowhere else", () => {
		// The independence claim, made falsifiable. If the harness had reached its
		// canonical bytes by calling `src/canonical.ts`, this test could not exist:
		// the two paths would agree everywhere, including on the answers §13 calls
		// wrong, and the whole corpus would be self-referential.
		//
		// NOT a defence of remaining defects. The hole/undefined/function rows
		// were deleted when src converged on §13. This table is only what still
		// diverges.
		//
		// ┌─ IF YOU ARE HERE BECAUSE THIS TEST WENT RED ─────────────────────────┐
		// │ THAT IS THE DESIGNED OUTCOME, NOT A BROKEN ORACLE.                   │
		// │                                                                      │
		// │ A red row means the canonicalizer CONVERGED on the normative         │
		// │ algorithm — receipt-spec §13 — and `src/canonical.ts` now gives the  │
		// │ right answer where this table recorded a wrong one. The fix is to    │
		// │ DELETE THAT ROW. Never loosen the harness, never relax an            │
		// │ expectation, never skip the test: the harness is the INDEPENDENT     │
		// │ oracle the whole conformance corpus rests on, and weakening it to    │
		// │ quiet a red test destroys the only thing making the corpus mean      │
		// │ anything. A corpus checked solely by the code it tests proves        │
		// │ nothing.                                                             │
		// │                                                                      │
		// │ Context (2026-08-15): `ship/canonicalize-guard` landed the published │
		// │ cut (canonicalize + write-guard). The six rows that recorded the     │
		// │ hole / undefined / function defects were deleted because src now     │
		// │ matches §13. The remaining row is Date error identity (RangeError    │
		// │ from toISOString vs the harness's named throw) — not this cut.       │
		// └──────────────────────────────────────────────────────────────────────┘
		const recorded: readonly (readonly [string, () => unknown, string | "THROW"])[] = [
			["invalid Date", () => new Date("not a date"), "THROW"],
		];
		/** The harness's answer, with a throw as a first-class outcome. */
		const normativeAnswer = (input: unknown): string =>
			((): string => {
				try {
					return `value:${String(canonicalizeNormative(input))}`;
				} catch (error) {
					return `throw:${(error as Error).message}`;
				}
			})();

		for (const [label, make, wrong] of recorded) {
			const input = make();
			if (wrong === "THROW") {
				// Both throw here — but §13 pins the ERROR IDENTITY, and only the
				// harness's is deliberate. `RangeError` escaping `.toISOString()`
				// cannot be told apart from a crash.
				expect(() => srcCanonicalize(input), label).toThrow(RangeError);
				expect(() => canonicalizeNormative(input), label).toThrow(/invalid Date in audit data/);
				continue;
			}
			expect(String(srcCanonicalize(input)), `${label}: src answer moved`).toBe(wrong);
			// A throw counts as diverging: `{f: () => 1}` is §13's REJECT row, and
			// the harness rejecting where src emits is exactly the divergence.
			expect(normativeAnswer(input), `${label}: harness must be normative`).not.toBe(
				`value:${wrong}`,
			);
		}
	});

	it("agrees with src/canonical.ts on every byte of real wire data", () => {
		// The divergence §13 records is unreachable from parsed wire data. This
		// is the assertion that matters for ut1: the two implementations must
		// produce identical bytes for everything the format can actually carry.
		const bundle = mint();
		const document = JSON.parse(bundle.receiptBytes.toString("utf8")) as Record<string, unknown>;
		expect(srcCanonicalize(document)).toBe(canonicalizeNormative(document));
		expect(srcCanonicalize(bundle.snapshot)).toBe(canonicalizeNormative(bundle.snapshot));
		for (const checkpoint of bundle.history) {
			expect(srcCanonicalize(checkpoint)).toBe(canonicalizeNormative(checkpoint));
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. §3/§12 — the base58 codec the ID rule rests on.
// ─────────────────────────────────────────────────────────────────────────────

describe("base58btc — receipt-spec §3/§12", () => {
	it("round-trips 16 random-looking bytes", () => {
		const encoded = base58Encode(DEFAULT_RECEIPT_ID_BYTES);
		expect(Buffer.from(base58Decode(encoded) as Uint8Array)).toEqual(DEFAULT_RECEIPT_ID_BYTES);
		expect(DEFAULT_RECEIPT_ID).toBe(`ut1_${encoded}`);
	});

	it("encodes leading zero bytes as leading `1`s and decodes them back", () => {
		const body = LEADING_ZERO_RECEIPT_ID.slice("ut1_".length);
		expect(body.startsWith("11")).toBe(true);
		const decoded = base58Decode(body) as Uint8Array;
		expect(decoded.length).toBe(16);
		expect(base58Encode(decoded)).toBe(body);
	});

	it("every corpus ID is 16–22 characters after the prefix (§3's consequence, never the test)", () => {
		const body = DEFAULT_RECEIPT_ID.slice("ut1_".length);
		expect(body.length).toBeGreaterThanOrEqual(16);
		expect(body.length).toBeLessThanOrEqual(22);
	});

	it("rejects characters outside the Bitcoin alphabet", () => {
		expect(base58Decode("0OIl")).toBeNull();
	});

	it("the malformed-ID vectors match the §12 GRAMMAR and fail its rule 1 — the two halves asserted SEPARATELY", () => {
		// "The character-count rule is NOT the ID rule" (§12, round-4 P2-6). A
		// vector that fell outside 16*22base58char would be testing the grammar
		// instead of the two rules that actually matter.
		//
		// The two rules are asserted apart, never as a conjunction: `decodesToN &&
		// reEncodes` is satisfied by rule 1 alone, so a corpus that only checked
		// the AND could claim rule-2 coverage it does not have and stay green
		// against a verifier that implements rule 1 and nothing else.
		for (const [id, expectedLength] of [
			[SHORT_DECODE_RECEIPT_ID, 15],
			[LONG_DECODE_RECEIPT_ID, 17],
		] as const) {
			const body = id.slice("ut1_".length);
			expect(body.length).toBeGreaterThanOrEqual(16);
			expect(body.length).toBeLessThanOrEqual(22);
			const decoded = base58Decode(body) as Uint8Array;
			expect(decoded).not.toBeNull();
			// Rule 1 — the decoded length. This is the rule these vectors break.
			expect(decoded.length).toBe(expectedLength);
			expect(decoded.length).not.toBe(16);
			// Rule 2 — the re-encode. These vectors do NOT break it, and the
			// corpus says so out loud rather than hiding it inside an AND.
			expect(base58Encode(decoded)).toBe(body);
		}
	});

	it("records §12's rule 2 as UNFALSIFIABLE against a conformant codec — no fixture can break it", () => {
		// Recorded rather than papered over, exactly as equality 3 is. §12's rule
		// 2 ("re-encode those 16 bytes and require byte-identical output") rejects
		// non-canonical encodings — leading-`1` padding, alternative
		// representations — so that two strings can never name one ID. Against a
		// conformant bignum codec there is no such string: `encode` emits one
		// leading `1` per leading zero byte and the minimal base58 digits for the
		// remainder, and `decode` inverts exactly that, so `encode ∘ decode` is
		// the identity on EVERY string over the alphabet.
		//
		// The consequence for this corpus, stated so nobody re-derives it as a
		// finding: rule 2 has no fixture, cannot have one, and a verifier that
		// implements rule 1 alone passes every ID vector here. Rule 2 guards
		// against a LENIENT decoder (one that strips leading `1`s, or pads or
		// truncates to 16 bytes) — a property of the implementation, not of any
		// byte string the corpus can hand it. Assert it in the reader's own unit
		// tests, not here.
		const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
		// Exhaustive over every 1- and 2-character string, which is where a
		// leading-zero/minimal-digit bug would surface first.
		for (const a of alphabet) {
			expect(base58Encode(base58Decode(a) as Uint8Array)).toBe(a);
			for (const b of alphabet) {
				const s = a + b;
				expect(base58Encode(base58Decode(s) as Uint8Array)).toBe(s);
			}
		}
		// And at receipt-ID scale, including every padded prefix of a real ID.
		const body = LEADING_ZERO_RECEIPT_ID.slice("ut1_".length);
		for (let pad = 0; pad <= 4; pad += 1) {
			const s = "1".repeat(pad) + body;
			expect(base58Encode(base58Decode(s) as Uint8Array)).toBe(s);
		}
		for (const id of [DEFAULT_RECEIPT_ID, ALT_RECEIPT_ID, SHORT_DECODE_RECEIPT_ID]) {
			const text = id.slice("ut1_".length);
			expect(base58Encode(base58Decode(text) as Uint8Array)).toBe(text);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The independent fact checker.
// ─────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Json)
		: null;
}

/**
 * The strict-reader half of the `parse` fact.
 *
 * The harness emits CANONICAL bytes, which buys an independent check for free:
 * any surviving byte mutation either fails to parse or fails the canonical
 * round-trip. The numeric scan covers what a round-trip cannot see — `14.5`
 * canonicalizes back to itself.
 */
function parses(bytes: Buffer): Json | null {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const document = asObject(parsed);
	if (document === null) return null;
	let round: string;
	try {
		round = canonicalizeNormative(document);
	} catch {
		return null;
	}
	if (round !== text) return null;
	if (!everyNumberIsSafeInteger(document)) return null;
	return document;
}

/** §2's integer domains: every ut1 number is a non-negative-zero safe integer. */
function everyNumberIsSafeInteger(value: unknown): boolean {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && !Object.is(value, -0);
	}
	if (Array.isArray(value)) return value.every(everyNumberIsSafeInteger);
	const object = asObject(value);
	if (object === null) return true;
	return Object.values(object).every(everyNumberIsSafeInteger);
}

function keyFor(keyId: unknown): (typeof ALL_KEYS)[number] | undefined {
	return ALL_KEYS.find((key) => key.keyId === keyId);
}

function verifyEd25519(publicKey: (typeof ALL_KEYS)[number], preimage: string, sig: unknown) {
	if (typeof sig !== "string") return false;
	let raw: Buffer;
	try {
		raw = Buffer.from(sig, "base64");
	} catch {
		return false;
	}
	return cryptoVerify(null, Buffer.from(preimage, "utf8"), publicKey.publicKey, raw);
}

/** The §4a topology derivation, re-derived here rather than imported. */
function foldsToRoot(proof: HarnessInclusionProof): boolean {
	const { leafIndex, treeSize, siblings, leafHash, root } = proof;
	if (!Number.isSafeInteger(leafIndex) || !Number.isSafeInteger(treeSize)) return false;
	if (leafIndex < 0 || leafIndex >= treeSize) return false;
	const orientation: ("left" | "right")[] = [];
	let index = leafIndex;
	let levelSize = treeSize;
	while (levelSize > 1) {
		const promoted = index === levelSize - 1 && levelSize % 2 === 1;
		if (!promoted) orientation.push(index % 2 === 0 ? "right" : "left");
		index = Math.floor(index / 2);
		levelSize = Math.ceil(levelSize / 2);
	}
	if (!Array.isArray(siblings) || siblings.length !== orientation.length) return false;
	let current = merkleLeafHash(leafHash);
	for (const [level, side] of orientation.entries()) {
		const sibling = siblings[level];
		if (sibling === undefined || sibling.position !== side) return false;
		current =
			side === "left"
				? merkleInteriorHash(sibling.hash, current)
				: merkleInteriorHash(current, sibling.hash);
	}
	return current === root;
}

/** Canonical base64: the only encoding of these bytes, re-encode-identical. */
function isCanonicalBase64(value: string): boolean {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
	return Buffer.from(value, "base64").toString("base64") === value;
}

/**
 * Compute the broken facts of a minted bundle, independently of any verifier.
 *
 * Facts are about material that EXISTS being WRONG. Material that is ABSENT is
 * skipped, never "broken" — absence is `UNVERIFIABLE`'s business, and conflating
 * the two would make the corpus assert the opposite of §7's central split.
 *
 * Facts are also RECEIPT-INTERNAL. Snapshot-relative conditions (a revoked key,
 * `mintKeyIds` membership, the registered `mintActor` form) are authority, not
 * cryptography, and vectors exercising them declare an empty set on purpose.
 */
function brokenFacts(vector: Vector, bundle: MintedBundle): FactName[] {
	const broken: FactName[] = [];
	const document = parses(bundle.receiptBytes);
	if (document === null) return ["parse"];

	const event = asObject(document.event);
	const data = event === null ? null : asObject(event.data);
	const proof = asObject(document.proof);
	const inclusion = proof === null ? null : asObject(proof.inclusion);
	const checkpoint = proof === null ? null : asObject(proof.checkpoint);
	const signature = asObject(document.signature);

	// Equality 1 — one event hash, named in three places.
	if (event !== null && proof !== null && inclusion !== null) {
		if (event.hash !== proof.mintEventHash || event.hash !== inclusion.leafHash) broken.push("eq1");
	}

	// Equality 2 — the chain's snake_case kind and the §4a system actor object.
	if (event !== null) {
		const actorMatches = canonicalizeNormative(event.actor) === canonicalizeNormative(MINT_ACTOR);
		if (event.kind !== MINT_EVENT_KIND || !actorMatches) broken.push("eq2");
	}

	// Equality 3 — `event.data` IS the projection in the ut1 wire shape (one
	// copy, §4), so there is no second copy to disagree with it. Kept in the
	// vocabulary so the gap is visible rather than quietly absent; see the
	// dedicated test below.

	// Equality 4 — segment-relative leaf index, in range.
	if (event !== null && inclusion !== null && checkpoint !== null) {
		const expectedIndex =
			Number(event.sequence) - Number(checkpoint.segmentFirstSequence as number);
		const inRange =
			typeof inclusion.leafIndex === "number" &&
			inclusion.leafIndex >= 0 &&
			inclusion.leafIndex < Number(checkpoint.treeSize);
		if (inclusion.leafIndex !== expectedIndex || !inRange) broken.push("eq4");
	}

	// Equalities 5, 6, 8 — the inclusion/checkpoint bindings.
	if (inclusion !== null && checkpoint !== null && proof !== null) {
		if (inclusion.treeSize !== checkpoint.treeSize) broken.push("eq5");
		if (inclusion.root !== checkpoint.root) broken.push("eq6");
		const sequenceOk =
			event === null || Number(event.sequence) >= Number(checkpoint.segmentFirstSequence);
		if (
			inclusion.segmentId !== checkpoint.segmentId ||
			checkpoint.vaultId !== proof.chain ||
			checkpoint.profile !== proof.profile ||
			!sequenceOk
		) {
			broken.push("eq8");
		}
	}

	// Equality 7 — the receipt-internal half (`minter.kind` is step 4's, per the
	// CLI spec's precedence rule: one condition, one code).
	if (data !== null) {
		if (document.spec !== data.spec || document.scope !== data.scope) broken.push("eq7");
	}

	// Equality 9 — `receipt.work` is REQUIRED, so an absent mirror fails HERE.
	if (data !== null) {
		if (!Object.hasOwn(document, "work")) {
			broken.push("eq9");
		} else if (canonicalizeNormative(document.work) !== canonicalizeNormative(data.work)) {
			broken.push("eq9");
		}
	}

	// The event-hash rule itself.
	if (event !== null && eventHash(event) !== event.hash) broken.push("eventHash");

	// Both signatures, under the key each document names.
	if (signature !== null) {
		const key = keyFor(signature.keyId);
		if (
			key !== undefined &&
			!verifyEd25519(key, receiptSignaturePreimage(document), signature.sig)
		) {
			broken.push("receiptSignature");
		}
	}
	if (checkpoint !== null) {
		const key = keyFor(checkpoint.keyId);
		if (key !== undefined && !verifyEd25519(key, checkpointPreimage(checkpoint), checkpoint.sig)) {
			broken.push("checkpointSignature");
		}
	}

	// The inclusion fold, with topology derived from (leafIndex, treeSize).
	if (inclusion !== null) {
		if (!foldsToRoot(inclusion as unknown as HarnessInclusionProof)) broken.push("inclusionProof");
	}

	// The one derivation the receipt can carry.
	if (data !== null && Array.isArray(data.transferSet)) {
		const pairs = data.transferSet as {
			authorizationTransferId: string;
			settlementTransferId: string;
		}[];
		if (transferSetRoot(pairs) !== data.transferSetRoot) broken.push("transferSetRoot");
	}

	// The three envelope equalities — `--envelope` mode only.
	if (vector.mode === "envelope") {
		const encoded = bundle.envelope.receiptBytes;
		if (typeof encoded === "string" && isCanonicalBase64(encoded)) {
			const decoded = parses(Buffer.from(encoded, "base64"));
			const copy = asObject(bundle.envelope.receipt);
			const disagrees =
				decoded === null ||
				copy === null ||
				canonicalizeNormative(decoded) !== canonicalizeNormative(copy) ||
				bundle.envelope.receiptId !== decoded.receiptId;
			if (disagrees) broken.push("envelopeAgreement");
		}
	}

	return broken;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The clean bundle satisfies every fact — computed here, not by a verifier.
// ─────────────────────────────────────────────────────────────────────────────

describe("a minted receipt is real proxy-v1 material", () => {
	const bundle = mint();
	const document = JSON.parse(bundle.receiptBytes.toString("utf8")) as Json;
	const event = document.event as Json;
	const data = event.data as Json;
	const proof = document.proof as Json;
	const inclusion = proof.inclusion as unknown as HarnessInclusionProof;
	const checkpoint = proof.checkpoint as Json;

	it("equality 1 — event.hash === proof.mintEventHash === inclusion.leafHash", () => {
		expect(proof.mintEventHash).toBe(event.hash);
		expect(inclusion.leafHash).toBe(event.hash);
	});

	it("equality 2 — receipt_settled, signed by the §4a system actor object", () => {
		expect(event.kind).toBe("receipt_settled");
		expect(canonicalizeNormative(event.actor)).toBe(canonicalizeNormative(MINT_ACTOR));
		expect(canonicalizeNormative(event.actor)).toBe(
			canonicalizeNormative((bundle.snapshot.chains[0] as { mintActor: unknown }).mintActor),
		);
	});

	it("equality 3 — the projection is `event.data`; the receipt carries no second copy", () => {
		expect(Object.hasOwn(document, "data")).toBe(false);
		expect(data.spec).toBe("ut1");
	});

	it("equality 4 — leafIndex is SEGMENT-relative and in range", () => {
		expect(inclusion.leafIndex).toBe(
			Number(event.sequence) - Number(checkpoint.segmentFirstSequence),
		);
		expect(inclusion.leafIndex).toBeGreaterThanOrEqual(0);
		expect(inclusion.leafIndex).toBeLessThan(Number(checkpoint.treeSize));
	});

	it("equalities 5 and 6 — treeSize and root come from the SIGNED checkpoint", () => {
		expect(inclusion.treeSize).toBe(checkpoint.treeSize);
		expect(inclusion.root).toBe(checkpoint.root);
	});

	it("equality 7 — spec and scope agree with the projection", () => {
		expect(document.spec).toBe(data.spec);
		expect(document.scope).toBe(data.scope);
	});

	it("equality 8 — segment, vault and profile are read out of the checkpoint's SIGNED payload", () => {
		expect(inclusion.segmentId).toBe(checkpoint.segmentId);
		expect(checkpoint.vaultId).toBe(proof.chain);
		expect(checkpoint.profile).toBe(proof.profile);
		expect(Number(event.sequence)).toBeGreaterThanOrEqual(Number(checkpoint.segmentFirstSequence));
	});

	it("equality 9 — the body's `work` is a byte-identical MIRROR of the projection's", () => {
		expect(canonicalizeNormative(document.work)).toBe(canonicalizeNormative(data.work));
	});

	it("the event hash recomputes under §4a's key-absent exclusion rule", () => {
		expect(eventHash(event)).toBe(event.hash);
	});

	it("the mint signature verifies over the §5 preimage", () => {
		const signature = document.signature as Json;
		expect(signature.alg).toBe("ed25519");
		expect(signature.keyId).toBe((document.minter as Json).keyId);
		expect(Buffer.from(String(signature.sig), "base64").length).toBe(64);
		expect(verifyEd25519(bundle.mintKey, receiptSignaturePreimage(document), signature.sig)).toBe(
			true,
		);
	});

	it("the checkpoint signature verifies over canonicalize(unsigned) with NO domain prefix", () => {
		expect(checkpoint.v).toBe(2);
		expect(
			verifyEd25519(bundle.checkpointKey, checkpointPreimage(checkpoint), checkpoint.sig),
		).toBe(true);
	});

	it("the inclusion path folds to the signed root under odd-node promotion", () => {
		// The mint segment has 7 leaves, so this path really does promote.
		expect(checkpoint.treeSize).toBe(7);
		expect(foldsToRoot(inclusion)).toBe(true);
	});

	it("src/verify.ts's verifier accepts the harness's independently built proof", () => {
		// The differential that matters: two Merkle implementations, one written
		// from §4a here and one mirrored from core, must agree.
		expect(
			verifyInclusionProof(
				inclusion as unknown as MerkleInclusionProof,
				String(checkpoint.root),
				Number(checkpoint.treeSize),
			),
		).toBe(true);
	});

	it("transferSetRoot commits the ORDERED PAIR LIST", () => {
		const pairs = data.transferSet as { authorizationTransferId: string }[];
		expect(pairs.length).toBe((data.spend as Json).transferCount);
		expect(transferSetRoot(pairs as never)).toBe(data.transferSetRoot);
	});

	it("amountUsd is COMPUTED by integer quotient/remainder, four decimals", () => {
		const assessed = Number((data.spend as Json).assessedUsertokens);
		const whole = Math.floor(assessed / 10000);
		const fraction = String(assessed % 10000).padStart(4, "0");
		expect(`${whole}.${fraction}`).toBe(DEFAULT_AMOUNT_USD);
	});

	it("mints deterministically — a corpus whose bytes move cannot be diffed or quoted", () => {
		expect(mint().receiptBytes.equals(bundle.receiptBytes)).toBe(true);
	});

	it("emits canonical bytes, so any surviving byte mutation is detectable", () => {
		expect(canonicalizeNormative(document)).toBe(bundle.receiptBytes.toString("utf8"));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Every mutant breaks exactly what it declares.
// ─────────────────────────────────────────────────────────────────────────────

describe("the corpus", () => {
	it("has unique vector names", () => {
		const names = ALL_VECTORS.map((v) => v.name);
		expect(new Set(names).size).toBe(names.length);
	});

	for (const vector of ALL_VECTORS) {
		it(`${vector.name} breaks exactly [${vector.breaks.join(", ")}] — ${vector.what}`, () => {
			const bundle = vector.build();
			expect([...brokenFacts(vector, bundle)].sort()).toEqual([...vector.breaks].sort());
		});
	}

	it("has no no-op mutant: every non-passing vector really differs from the clean bundle", () => {
		// A hook that quietly matched nothing would ship a vector asserting the
		// clean receipt fails — the corpus failure mode that survives review
		// because every test is green.
		const clean = mint();
		// `JSON.stringify`, not the canonicalizer: one vector legitimately puts a
		// non-finite number in the envelope copy, and §13 makes canonicalizing
		// that a throw. A fingerprint must never be able to fail.
		const shape = (b: MintedBundle) =>
			[
				b.receiptBytes.toString("base64"),
				b.snapshotBytes.toString("base64"),
				JSON.stringify(b.history),
				JSON.stringify(b.envelope),
			].join("|");
		const baseline = shape(clean);
		for (const vector of ALL_VECTORS) {
			const isPass =
				vector.expect.verdict === "VERIFIED_CHECKPOINT" ||
				vector.expect.verdict === "VERIFIED_CHECKPOINT_HISTORY";
			// Arrival-context vectors mutate the CLI argument, not the bundle.
			if (isPass || vector.expectId !== undefined) continue;
			expect(shape(vector.build()), `${vector.name} mutated nothing`).not.toBe(baseline);
		}
	});

	it("declares no vector as breaking equality 3 — it is unfalsifiable in a one-copy wire", () => {
		// Recorded rather than papered over: §4's equality 3 compares `event.data`
		// against "the §2 projection the receipt claims", and in the ut1 wire they
		// are the same member. There is no second copy to mutate. The nearest
		// reachable mutant is a duplicate copy, which step 1 rejects as an unknown
		// field — `schema/duplicate-projection-copy` carries it.
		expect(ALL_VECTORS.filter((v) => v.breaks.includes("eq3"))).toEqual([]);
		expect(ALL_VECTORS.some((v) => v.name === "schema/duplicate-projection-copy")).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The corpus floor (CLI spec §7 "Conformance corpus").
// ─────────────────────────────────────────────────────────────────────────────

describe("corpus floor", () => {
	const failingSteps = new Set(
		ALL_VECTORS.filter((v) => v.expect.verdict === "FAILED").map((v) => v.expect.step),
	);

	it("every §7 base step has at least one PASS vector", () => {
		// One clean receipt exercises steps 1–8 in the affirmative; the ladder
		// vectors add the shape variants (absent transferSet, addenda, postures).
		expect(
			ALL_VECTORS.filter((v) => v.expect.verdict === "VERIFIED_CHECKPOINT").length,
		).toBeGreaterThan(5);
		expect(ALL_VECTORS.some((v) => v.expect.verdict === "VERIFIED_CHECKPOINT_HISTORY")).toBe(true);
	});

	for (const step of [
		"schema",
		"event",
		"registry",
		"signature",
		"inclusion",
		"checkpoint",
		"semantics",
		"derivations",
		"envelope",
	] as const) {
		it(`step \`${step}\` has at least one targeted FAIL vector`, () => {
			expect(failingSteps.has(step)).toBe(true);
		});
	}

	it("step 9 is covered by extension-check failures that never demote the base verdict", () => {
		const historyFailures = ALL_VECTORS.filter(
			(v) =>
				v.expect.extension?.check === "checkpointHistory" && v.expect.extension.result === "failed",
		);
		expect(historyFailures.length).toBeGreaterThanOrEqual(11);
		for (const vector of historyFailures) {
			expect(vector.expect.verdict).toBe("VERIFIED_CHECKPOINT");
			expect(vector.expect.exitCode).toBe(0);
		}
	});

	it("VERIFIED_ANCHORED is unreachable in v1, and present evidence is reported out of band", () => {
		expect(ALL_VECTORS.some((v) => v.expect.verdict === "VERIFIED_ANCHORED")).toBe(false);
		const anchored = ALL_VECTORS.filter((v) => v.expect.unimplemented?.includes("anchorEvidence"));
		expect(anchored.length).toBeGreaterThanOrEqual(1);
		for (const vector of anchored) {
			expect(vector.expect.extension?.check).not.toBe("anchorEvidence");
		}
	});

	for (const equality of ["eq1", "eq2", "eq4", "eq5", "eq6", "eq7", "eq8", "eq9"] as const) {
		it(`equality ${equality.slice(2)} has its own mutant`, () => {
			expect(ALL_VECTORS.some((v) => v.breaks.includes(equality))).toBe(true);
		});
	}

	it("covers the full key-state matrix", () => {
		for (const name of [
			"pass/retired-mint-key-in-bounds",
			"pass/retired-checkpoint-key-in-bounds",
			"signature/retired-mint-key-out-of-bounds",
			"checkpoint/retired-key-out-of-bounds",
			// §8's boundary governs TWO keys. The four above are the PREDECESSOR's
			// half; these are the SUCCESSOR's, including the `revoked`-predecessor
			// cell whose absence let a legitimate rotation report SIG_INVALID.
			"pass/rotation-successor-at-activation",
			"pass/rotation-successor-under-revoked-predecessor",
			"signature/rotation-successor-before-activation",
			"snapshot/predecessor-without-activation-boundary",
			"signature/key-revoked",
			"checkpoint/key-revoked",
			"signature/key-wrong-role",
			"signature/minter-kind-mismatch",
			"signature/key-not-in-mint-key-ids",
			"signature/key-absent-from-snapshot",
		]) {
			expect(ALL_VECTORS.some((v) => v.name === name)).toBe(true);
		}
	});

	it("covers the frozen numeric reader and every parse vector", () => {
		for (const name of [
			"parse/bom",
			"parse/duplicate-key",
			"parse/duplicate-key-nested",
			"parse/invalid-utf8",
			"parse/nan-literal",
			"schema/infinity-value",
			"schema/non-integer",
			"schema/negative-zero",
			"schema/unsafe-integer",
			// The one the value-level rules cannot express: the parser rounds it
			// away before any of them run. Twice — the receipt's bytes, and the
			// SNAPSHOT members §8 declares as integers.
			"schema/fractional-token-rounds-to-integer",
			"snapshot/fractional-activation-sequence-rounds-to-integer",
			"schema/unknown-top-level-field",
			"schema/unknown-projection-field",
		]) {
			expect(ALL_VECTORS.some((v) => v.name === name)).toBe(true);
		}
	});

	it("rejects duplicate JSON keys at DEPTH, not only at the top level, in BOTH documents", () => {
		// §4a applies duplicate-key rejection to "receipts AND well-known
		// documents" and §11 requires it "before object parsing" — neither is
		// satisfied by a scanner that walks only depth 0, and a top-level-only
		// corpus would be green on one. Both documents need both depths; the
		// snapshot most of all, because CLI spec §4 says its structural rules are
		// the ONLY remaining defence in v1.
		for (const name of [
			"parse/duplicate-key",
			"parse/duplicate-key-nested",
			"snapshot/duplicate-json-key",
			"snapshot/duplicate-json-key-nested",
		]) {
			expect(
				ALL_VECTORS.some((v) => v.name === name),
				`missing ${name}`,
			).toBe(true);
		}
	});

	it("pins the `spec`/`scope` literals and says which step owns them", () => {
		// Step 1 owns the RECEIPT's literals (CLI spec §5 binds it to "§5 shape",
		// and §5 pins `"spec": "ut1"` / `"scope": "session"`). Step 7 owns the
		// PROJECTION's (§2's enumerated constraints). Equality 7 owns only the
		// agreement between them.
		//
		// Both-sides-illegal is the case that has no other guard: the two copies
		// AGREE, so equality 7 is silent, and without step 1's literal pin a
		// document announcing a different format is verified under ut1 rules.
		for (const name of ["schema/spec-literal-not-ut1", "schema/scope-literal-not-session"]) {
			const vector = ALL_VECTORS.find((v) => v.name === name);
			expect(vector, `missing ${name}`).toBeDefined();
			expect(vector?.expect.step).toBe("schema");
			expect(vector?.breaks).toEqual([]);
		}
		// And every eq7 mutant breaks the PROJECTION's copy, never the receipt's
		// — a receipt-side mutant is pre-empted by the step-1 pin above, so
		// asserting EVENT_MISMATCH on one would force the reader to leave the
		// literal open. This is the same class of honesty as the equality-3 and
		// §12-rule-2 records.
		const eq7 = ALL_VECTORS.filter((v) => v.breaks.includes("eq7"));
		expect(eq7.length).toBeGreaterThanOrEqual(2);
		for (const vector of eq7) {
			expect(vector.name.startsWith("eq7/projection-")).toBe(true);
			const document = JSON.parse(vector.build().receiptBytes.toString("utf8")) as Json;
			expect(document.spec).toBe("ut1");
			expect(document.scope).toBe("session");
		}
	});

	it("covers the four history mutants the upgrade predicate turns on", () => {
		for (const name of [
			"history/embedded-checkpoint-near-match",
			"history/genesis-sentinel-wrong",
			"history/segment-first-sequence-gap",
			"history/member-vault-id-differs",
		]) {
			expect(ALL_VECTORS.some((v) => v.name === name)).toBe(true);
		}
	});

	it("every UNVERIFIABLE vector names what was missing, and no FAILED vector does", () => {
		for (const vector of ALL_VECTORS) {
			if (vector.expect.verdict === "UNVERIFIABLE") {
				expect(vector.expect.missing).toBeDefined();
				expect(vector.expect.step).toBeUndefined();
				expect(vector.expect.code).toBeUndefined();
				expect(vector.expect.exitCode).toBe(2);
			}
			if (vector.expect.verdict === "FAILED") {
				expect(vector.expect.step).toBeDefined();
				expect(vector.expect.missing).toBeUndefined();
				expect(vector.expect.exitCode).toBe(1);
			}
		}
	});
});
