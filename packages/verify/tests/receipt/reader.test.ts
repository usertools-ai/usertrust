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

import { createHash, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decodeCanonicalBase64,
	decodeUtf8Strict,
	findNonFrozenNumber,
	findUnknownReceiptField,
	isCanonicalBase64,
	type JsonObject,
	loadTrustSnapshot,
	readReceiptDocument,
	scanJsonForDuplicateKeys,
} from "../../src/receipt-verify.js";
import { ALL_VECTORS, SNAPSHOT_VECTORS, type Vector, vector } from "./fixtures.js";
import {
	CHECKPOINT_KEY,
	MINT_KEY,
	MINT_KEY_SUCCESSOR,
	mint,
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
	"schema/unknown-top-level-field",
	"schema/unknown-projection-field",
	"schema/duplicate-projection-copy",
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

	it("tolerates unknown members — a v1 strict reader would brick every pinned CLI (§4)", () => {
		const load = loadTrustSnapshot(
			patched((s) => {
				s.snapshotSignature = { alg: "ed25519", sig: "AAAA" };
			}),
		);
		expect(load.ok).toBe(true);
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
