// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The frozen-numeric POLICY — the defect CLASS, closed once and asserted
 * exhaustively rather than instance by instance.
 *
 * THE CLASS. A fractional numeric literal that `JSON.parse` rounds to a legal
 * integer slips past every downstream check, because the check inspects the
 * ROUNDED value the parser invented rather than the LITERAL that was signed.
 * `canonicalize` then re-serializes the rounded value, so the hash recomputes,
 * the signature verifies, and the verdict is awarded over bytes the document
 * never carried.
 *
 * THE PROPERTY. Any declared-integer field whose value is covered by a
 * signature, or which feeds a comparison against signed material, is validated
 * on the LITERAL before parsing — whichever document it arrived in.
 *
 * WHY THIS FILE EXISTS. The class was found three times, in three documents,
 * across three review rounds, and fixed three times at the surface that
 * revealed it. What was missing each time was not the rule but the
 * ENUMERATION: nothing mechanical said "here is every structure this verifier
 * parses, and here is what each one does about numbers." A table in a report
 * cannot be that thing — it is correct the day it is written and stale the
 * first time a field is added. So the enumeration lives here and FAILS THE
 * BUILD three different ways:
 *
 *   1. `tsc` refuses a `number`-typed member of `TrustKey`/`TrustChain` with no
 *      policy entry (`DeclaredIntegers<T>` in `receipt-verify.ts`).
 *   2. POLICY COVERAGE derives every declared numeric position from the FIELD
 *      TABLES — the same tables that declare the schema — and asserts the live
 *      policy reaches each one. A new `at(owner, "integer")` fails here.
 *   3. THE REGISTRY counts the JSON parse sites in `packages/verify/src` and
 *      asserts every one has a written disposition. A new parse site fails here
 *      whether or not anyone remembered this file existed.
 *
 * "No declared integers" is a legitimate disposition and several structures
 * have it. That is what makes this an enumeration rather than a list of hits.
 *
 * EVERY REFUSAL IS ASSERTED BY ITS REASON, not merely by its occurrence. A
 * fixture that fails for an unrelated defect scores identically to one caught
 * by the rule under test, so each case pins the rule name AND the path the
 * refusal reports. A positive control validates the INSTRUMENT; naming the
 * reason is what validates the DIAGNOSIS.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ReceiptCliIo, resolveEnvelope, runReceiptCli } from "../../src/receipt-cli.js";
import {
	CHECKPOINT_DECLARED_NUMERIC_POSITIONS,
	CHECKPOINT_NUMERIC_POLICY,
	ELEMENT,
	ENVELOPE_NUMERIC_POLICY,
	loadTrustSnapshot,
	numericPolicyCovers,
	RECEIPT_DECLARED_NUMERIC_POSITIONS,
	RECEIPT_NUMERIC_POLICY,
	readReceiptDocument,
	SNAPSHOT_NUMERIC_POLICY,
	scanJsonForDuplicateKeys,
} from "../../src/receipt-verify.js";
import { type MintedBundle, mint, type ResolverEnvelope } from "./harness.js";

const VERIFY_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/**
 * The literal that started all of this: no double represents it, so
 * `JSON.parse` hands back exactly the integer and every value-level check
 * afterwards answers about a number that was never in the document.
 */
const roundsTo = (n: number): string => `${n}.0000000000000001`;

/**
 * A position, rendered for a failure MESSAGE. `Array.join` throws on a symbol,
 * so the obvious spelling would replace a real assertion failure with a
 * TypeError — a diagnosis destroyed by the code that was meant to report it.
 */
const show = (position: readonly (string | symbol)[]): string =>
	position.map((step) => (typeof step === "symbol" ? "[]" : step)).join(".");

/**
 * A string sentinel placed where a number belongs, then swapped for a raw
 * fractional literal in the serialized TEXT.
 *
 * Text surgery is unavoidable — `JSON.stringify(1.0000000000000001)` is `"1"`,
 * so the attack cannot be expressed through an object at all — but blind
 * find-and-replace on a real value is not: `"treeSize":4` occurs in several
 * places and hitting the wrong one silently tests a different surface. The
 * sentinel is unique by construction, so each mutation lands where it says.
 */
const SENTINEL = "@@FRACTIONAL_LITERAL@@";
const asNumber = SENTINEL as unknown as number;

function injectLiteral(text: string, literal: string): string {
	expect(text, "the sentinel must be present exactly once").toContain(`"${SENTINEL}"`);
	expect(text.indexOf(`"${SENTINEL}"`)).toBe(text.lastIndexOf(`"${SENTINEL}"`));
	return text.replace(`"${SENTINEL}"`, literal);
}

function memoryIo(files: Readonly<Record<string, Buffer>>): ReceiptCliIo {
	return {
		readFile: (path: string) => {
			const buf = files[path];
			if (buf === undefined) throw new Error(`ENOENT: ${path}`);
			return buf;
		},
		readStdin: () => {
			throw new Error("no stdin");
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. POLICY COVERAGE — derived from the field tables, not from memory.
// ─────────────────────────────────────────────────────────────────────────────

describe("policy coverage is derived from the field tables", () => {
	/**
	 * The positive control for the ORACLE. A coverage assertion that has never
	 * refused anything is not evidence of coverage — it may simply be unable to
	 * fail.
	 */
	it("the oracle can FAIL: an undeclared position is reported uncovered", () => {
		expect(numericPolicyCovers(SNAPSHOT_NUMERIC_POLICY, ["keys"])).toBe(false);
		expect(numericPolicyCovers(SNAPSHOT_NUMERIC_POLICY, ["version"])).toBe(false);
		expect(numericPolicyCovers(SNAPSHOT_NUMERIC_POLICY, ["nobodyDeclaredThis"])).toBe(false);
		expect(numericPolicyCovers(undefined, ["anything"])).toBe(false);
		// …and it can pass, on a position that IS declared.
		expect(
			numericPolicyCovers(SNAPSHOT_NUMERIC_POLICY, ["keys", ELEMENT, "activationSequence"]),
		).toBe(true);
		expect(numericPolicyCovers(CHECKPOINT_NUMERIC_POLICY, ["treeSize"])).toBe(true);
	});

	it("the derivation finds real positions — it is not vacuously empty", () => {
		// If the walker returned nothing, every coverage assertion below would pass
		// while checking nothing at all.
		expect(RECEIPT_DECLARED_NUMERIC_POSITIONS.length).toBeGreaterThan(10);
		const names = CHECKPOINT_DECLARED_NUMERIC_POSITIONS.map(show);
		expect(names).toContain("treeSize");
		expect(names).toContain("segmentFirstSequence");
		// `v` too: a numeric LITERAL is just as forgeable, being `!==`-compared
		// against 2 and then re-canonicalized as 2 for the signature.
		expect(names).toContain("v");
	});

	it("every declared numeric position in the RECEIPT table is covered", () => {
		const uncovered = RECEIPT_DECLARED_NUMERIC_POSITIONS.filter(
			(position) => !numericPolicyCovers(RECEIPT_NUMERIC_POLICY, position),
		);
		expect(uncovered.map(show)).toEqual([]);
	});

	it("every declared CHECKPOINT position is covered on all THREE routes to it", () => {
		// The checkpoint is reached inside a receipt (`proof.checkpoint`), as a
		// served history member, and through the envelope that carries that history.
		// Step 9's members never pass through step 1's reader, so a policy covering
		// only the first route is exactly the gate-9 defect.
		for (const position of CHECKPOINT_DECLARED_NUMERIC_POSITIONS) {
			const where = show(position);
			expect(numericPolicyCovers(CHECKPOINT_NUMERIC_POLICY, position), where).toBe(true);
			expect(
				numericPolicyCovers(RECEIPT_NUMERIC_POLICY, ["proof", "checkpoint", ...position]),
				`embedded: ${where}`,
			).toBe(true);
			expect(
				numericPolicyCovers(ENVELOPE_NUMERIC_POLICY, ["checkpointHistory", ELEMENT, ...position]),
				`served: ${where}`,
			).toBe(true);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE REGISTRY — every JSON parse site in packages/verify/src, enumerated.
// ─────────────────────────────────────────────────────────────────────────────

interface ParseSiteDisposition {
	/** How many `JSON.parse(` / `readStrictJson(` call sites this file holds. */
	readonly sites: number;
	/** What the structures at those sites do about declared integers. */
	readonly policy: string;
}

/**
 * The disposition of every module in `packages/verify/src`. The `sites` count
 * is the mechanical half: it is recomputed from the source on every run, so
 * adding a parse site anywhere fails this test until its disposition is
 * written down. That is the guard the three previous rounds did not have.
 */
const REGISTRY: Readonly<Record<string, ParseSiteDisposition>> = {
	// ── Governed by the policy registry (this ship). ───────────────────────────
	"receipt-verify.ts": {
		// The scanner's member-name parse, `readStrictJson`'s own `JSON.parse`, and
		// four `readStrictJson` calls (its recursive use, the receipt, the snapshot,
		// and the snapshot's identity re-read on a numeric refusal).
		sites: 6,
		policy:
			"RECEIPT_NUMERIC_POLICY — frozen WHOLE: §2 declares no fractional domain and §5 refuses " +
			"unknown fields, so no position in a ut1 receipt could legitimately hold a fraction. " +
			"SNAPSHOT_NUMERIC_POLICY — SCOPED to the members §8 declares as integers, because §4 " +
			"promises the open signing scheme's unknown members stay free; the entries are type-checked " +
			"against TrustKey/TrustChain so a new number-typed member cannot compile without one.",
	},
	"receipt-cli.ts": {
		sites: 2,
		policy:
			"ENVELOPE_NUMERIC_POLICY — SCOPED: $.receipt inherits the receipt policy and " +
			"$.checkpointHistory[] the checkpoint policy, while every other envelope member stays open " +
			"for the resolver's extensions. anchorEvidence gets no policy because this build validates " +
			"none of it and therefore declares no integer in it. The R4 re-read of the decoded receipt " +
			"bytes gets no policy either: those bytes are frozen by readReceiptDocument in step 1, which " +
			"owns the SCHEMA_INVALID code that correctly blames the receipt rather than the envelope.",
	},
	// ── No parse site at all. Real entries, not omissions. ─────────────────────
	"receipt.ts": {
		sites: 0,
		policy: "NO PARSE SITE — display helpers over an already-parsed value.",
	},
	"canonical.ts": { sites: 0, policy: "NO PARSE SITE — a serializer, not a reader." },
	"constants.ts": { sites: 0, policy: "NO PARSE SITE — string constants only." },
	// ── Mirrored into packages/core. Enumerated here so the assertion below stays
	// exhaustive; the frozen numeric rule is deliberately NOT applied on this side.
	// The parity contract holds the two implementations byte-identical and §13 rules
	// a split worse than a shared bug, so any change here is a coordinated
	// core+verify ship. Per-file disposition is tracked internally, not in this repo.
	"index.ts": {
		sites: 3,
		policy:
			"MIRRORED into packages/core — out of scope for this ship; disposition tracked " +
			"internally. splitReceiptDocuments' parse is a well-formedness probe that keeps the " +
			"raw text and is IMMUNE.",
	},
	"verify.ts": {
		sites: 2,
		policy: "MIRRORED into packages/core — out of scope for this ship; disposition tracked internally.",
	},
	"cli.ts": {
		sites: 1,
		policy:
			"MIRRORED behaviourally on the --bundle path — out of scope for this ship; " +
			"disposition tracked internally.",
	},
	"anchor-verify.ts": {
		sites: 2,
		policy:
			"FILE-DIFF MIRRORED and out of scope by explicit constraint; disposition tracked " +
			"internally.",
	},
	"rekor-verify.ts": {
		sites: 2,
		policy:
			"FILE-DIFF MIRRORED and out of scope by explicit constraint; disposition tracked " +
			"internally. The hashedrekord entry-body parse reads NO numbers and binds the raw " +
			"bytes for both the leaf hash and the SET body — IMMUNE, and correctly so.",
	},
};

describe("the registry enumerates every parse site in packages/verify/src", () => {
	const sourceFiles = readdirSync(VERIFY_SRC).filter((f) => f.endsWith(".ts"));

	it("names every source module — a new one cannot slip in unenumerated", () => {
		expect(sourceFiles.slice().sort()).toEqual(Object.keys(REGISTRY).slice().sort());
	});

	it("counts every parse site — a new one fails until its disposition is written", () => {
		const actual: Record<string, number> = {};
		for (const file of sourceFiles) {
			const text = readFileSync(join(VERIFY_SRC, file), "utf-8");
			actual[file] = text.match(/\bJSON\.parse\(|\breadStrictJson\(/g)?.length ?? 0;
		}
		expect(actual).toEqual(
			Object.fromEntries(Object.entries(REGISTRY).map(([file, e]) => [file, e.sites])),
		);
	});

	it("every disposition says something — a blank policy is not an answer", () => {
		for (const [file, entry] of Object.entries(REGISTRY)) {
			expect(entry.policy.length, file).toBeGreaterThan(20);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE SURFACES. Each set: the fractional literal is REFUSED (and the refusal
// names THIS rule at THIS path), the conformant integer still verifies, and a
// fraction in an unknown extension member still loads.
// ─────────────────────────────────────────────────────────────────────────────

describe("surface 1 — the receipt document", () => {
	it("refuses a fractional literal at a declared integer, naming the rule and the path", () => {
		const bundle = mint({
			receiptAfterSign: (r) => ({
				...r,
				event: { ...(r.event as Record<string, unknown>), sequence: asNumber },
			}),
			bytes: (b) => Buffer.from(injectLiteral(b.toString("utf8"), roundsTo(12)), "utf8"),
		});
		const read = readReceiptDocument(bundle.receiptBytes);
		expect(read.ok).toBe(false);
		if (read.ok) return;
		// FAILED / SCHEMA_INVALID, not UNVERIFIABLE: the bytes became a document
		// and what it says is illegal.
		expect(read.refusal.kind).toBe("schema");
		expect(read.refusal.detail).toContain("non-integer number");
		expect(read.refusal.detail).toContain("$.event.sequence");
	});

	it("POSITIVE CONTROL: the untouched receipt still reads", () => {
		expect(readReceiptDocument(mint().receiptBytes).ok).toBe(true);
	});
});

describe("surface 2 — the §8 trust snapshot", () => {
	const fractionalHeadSequence = (): MintedBundle =>
		mint({
			snapshot: (s) => ({
				...s,
				chains: s.chains.map((c) => ({ ...c, headSegmentFirstSequence: asNumber })),
			}),
			snapshotBytes: (b) => Buffer.from(injectLiteral(b.toString("utf8"), roundsTo(9)), "utf8"),
		});

	it("refuses a fractional literal at a DECLARED integer, naming the rule and the path", () => {
		const load = loadTrustSnapshot(fractionalHeadSequence().snapshotBytes);
		expect(load.ok).toBe(false);
		if (load.ok) return;
		expect(load.detail).toContain("non-integer number");
		expect(load.detail).toContain("$.chains[0].headSegmentFirstSequence");
	});

	it("refuses it at the OTHER declared integer too", () => {
		const bundle = mint({
			snapshot: (s) => ({
				...s,
				keys: s.keys.map((k) =>
					k.role === "checkpoint"
						? { ...k, state: "retired" as const, activationSequence: asNumber }
						: k,
				),
			}),
			snapshotBytes: (b) => Buffer.from(injectLiteral(b.toString("utf8"), roundsTo(99)), "utf8"),
		});
		const load = loadTrustSnapshot(bundle.snapshotBytes);
		expect(load.ok).toBe(false);
		if (load.ok) return;
		expect(load.detail).toContain("non-integer number");
		expect(load.detail).toContain("activationSequence");
	});

	/**
	 * The P2 aliasing case, and the reason the policy is a TREE.
	 *
	 * A path PATTERN is matched against a string built by concatenating raw JSON
	 * keys, so an unknown top-level member literally NAMED `keys[0]` rendered the
	 * same text the real declared path renders and was wrongly refused — breaking
	 * the §4 forward-compat promise the previous round claimed to preserve.
	 * Descending the policy structurally cannot express that confusion.
	 */
	it("does not ALIAS a declared path: an unknown member named `keys[0]` stays free", () => {
		const bundle = mint();
		const document = JSON.parse(bundle.snapshotBytes.toString("utf8")) as Record<string, unknown>;
		const hostile = JSON.stringify({ ...document, "keys[0]": { activationSequence: 1.5 } });
		const load = loadTrustSnapshot(Buffer.from(hostile, "utf8"));
		expect(load.ok, load.ok === false ? load.detail : "").toBe(true);
	});

	it("POSITIVE CONTROL: fractions in ordinary unknown members stay legal (§4)", () => {
		const bundle = mint();
		const document = JSON.parse(bundle.snapshotBytes.toString("utf8")) as Record<string, unknown>;
		const extended = JSON.stringify({ ...document, schemeWeight: 1.5, nested: { x: 2.5 } });
		expect(loadTrustSnapshot(Buffer.from(extended, "utf8")).ok).toBe(true);
	});

	it("POSITIVE CONTROL: the untouched snapshot still loads", () => {
		expect(loadTrustSnapshot(mint().snapshotBytes).ok).toBe(true);
	});

	/**
	 * A numeric refusal is a DOCUMENT-level defect, so R-OUT-1 still binds: the
	 * report names WHICH snapshot it refused. Null identity is reserved for bytes
	 * that never became a document at all.
	 */
	it("a numeric refusal still reports the DECLARED identity, not null/null", () => {
		const bundle = mint({
			snapshot: (s) => ({
				...s,
				version: "2026-08-14",
				predecessor: "abc123",
				chains: s.chains.map((c) => ({ ...c, headSegmentFirstSequence: asNumber })),
			}),
			snapshotBytes: (b) => Buffer.from(injectLiteral(b.toString("utf8"), roundsTo(9)), "utf8"),
		});
		const load = loadTrustSnapshot(bundle.snapshotBytes);
		expect(load.ok).toBe(false);
		if (load.ok) return;
		expect(load.detail).toContain("non-integer number");
		expect(load.identity.version).toBe("2026-08-14");
		expect(load.identity.predecessor).toBe("abc123");
	});

	it("POSITIVE CONTROL: bytes that never became a document DO report null/null", () => {
		const load = loadTrustSnapshot(Buffer.from("{not json", "utf8"));
		expect(load.ok).toBe(false);
		if (load.ok) return;
		expect(load.identity.version).toBeNull();
		expect(load.identity.predecessor).toBeNull();
	});
});

describe("surface 3 — the served checkpoint history (the gate-9 defect)", () => {
	const runEnvelope = (envelopeText: string, bundle: MintedBundle) =>
		runReceiptCli(
			["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
			memoryIo({
				"trust.json": bundle.snapshotBytes,
				"envelope.json": Buffer.from(envelopeText, "utf8"),
			}),
		);

	const historyMutant = (
		patch: (c: Record<string, unknown>) => Record<string, unknown>,
		literal: string,
	): { text: string; bundle: MintedBundle } => {
		const bundle = mint({
			envelope: (e: ResolverEnvelope) => ({
				...e,
				checkpointHistory: (e.checkpointHistory ?? []).map((c, i) =>
					i === 0 ? (patch(c as unknown as Record<string, unknown>) as never) : c,
				),
			}),
		});
		return { text: injectLiteral(JSON.stringify(bundle.envelope), literal), bundle };
	};

	it("refuses a fractional treeSize in a SERVED history member, naming rule and path", () => {
		const { text, bundle } = historyMutant((c) => ({ ...c, treeSize: asNumber }), roundsTo(4));
		const result = runEnvelope(text, bundle);
		expect(result.exitCode).toBe(1);
		const report = JSON.parse(result.stdout) as {
			verdict: string;
			failure: { step: string; code: string; detail: string } | null;
		};
		// FAILED, not UNVERIFIABLE: the envelope IS a document and a member it
		// DECLARES carries an illegal literal.
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.code).toBe("ENVELOPE_INVALID");
		// The reason, not merely the refusal: ENVELOPE_INVALID is also what an R4
		// disagreement and a bad apiVersion return, and neither is this.
		expect(report.failure?.detail).toContain("illegal numeric literal");
		expect(report.failure?.detail).toContain("$.checkpointHistory[0].treeSize");
	});

	it("refuses a fractional `v` — the version label is signed material too", () => {
		const { text, bundle } = historyMutant((c) => ({ ...c, v: asNumber }), roundsTo(2));
		const report = JSON.parse(runEnvelope(text, bundle).stdout) as {
			failure: { detail: string } | null;
		};
		expect(report.failure?.detail).toContain("$.checkpointHistory[0].v");
	});

	it("refuses a fractional segmentFirstSequence", () => {
		const { text, bundle } = historyMutant(
			(c) => ({ ...c, segmentFirstSequence: asNumber }),
			roundsTo(1),
		);
		const report = JSON.parse(runEnvelope(text, bundle).stdout) as {
			failure: { detail: string } | null;
		};
		expect(report.failure?.detail).toContain("$.checkpointHistory[0].segmentFirstSequence");
	});

	it("POSITIVE CONTROL: the untouched envelope still reaches VERIFIED_CHECKPOINT_HISTORY", () => {
		const bundle = mint();
		const result = runEnvelope(JSON.stringify(bundle.envelope), bundle);
		expect(result.exitCode).toBe(0);
		expect((JSON.parse(result.stdout) as { verdict: string }).verdict).toBe(
			"VERIFIED_CHECKPOINT_HISTORY",
		);
	});

	it("POSITIVE CONTROL: a fraction in an unknown ENVELOPE member is still legal", () => {
		const bundle = mint({
			envelope: (e) => ({ ...e, servedLatencyMs: 12.5, meta: { weight: 0.25 } }),
		});
		const result = runEnvelope(JSON.stringify(bundle.envelope), bundle);
		expect(result.exitCode).toBe(0);
		expect((JSON.parse(result.stdout) as { verdict: string }).verdict).toBe(
			"VERIFIED_CHECKPOINT_HISTORY",
		);
	});
});

describe("surface 4 — the envelope's `receipt` convenience copy", () => {
	/**
	 * The surface this sweep found that no gate had hit.
	 *
	 * R4 compares the copy STRUCTURALLY against the parsed receipt bytes. A
	 * fractional literal in the copy rounds to the integer the bytes carry, so the
	 * two "agree", the receipt verifies from its own frozen bytes, and the run
	 * reports VERIFIED over an envelope whose convenience copy is not the document
	 * that was signed — while the copy is the only thing a consumer ever reads.
	 */
	it("refuses a fractional literal in the copy, which R4 alone would call equal", () => {
		const bundle = mint();
		const copy = JSON.parse(bundle.receiptBytes.toString("utf8")) as Record<string, unknown>;
		const signedSequence = Number((copy.event as Record<string, unknown>).sequence);
		const envelope = {
			...bundle.envelope,
			receipt: {
				...copy,
				event: { ...(copy.event as Record<string, unknown>), sequence: asNumber },
			},
		};
		const text = injectLiteral(JSON.stringify(envelope), roundsTo(signedSequence));

		const outcome = resolveEnvelope(Buffer.from(text, "utf8"));
		expect(outcome.kind).toBe("failed");
		if (outcome.kind !== "failed") return;
		expect(outcome.code).toBe("ENVELOPE_INVALID");
		// The reason: the numeric rule at the COPY's position — not the R4
		// equality, which would have reported agreement here precisely because
		// both sides round to the same integer.
		expect(outcome.detail).toContain("illegal numeric literal");
		expect(outcome.detail).toContain("$.receipt.event.sequence");
	});

	it("CONFOUND CONTROL: without the fraction, that same copy passes R4", () => {
		// Proves the case above is caught by the numeric rule and not by a
		// structural disagreement the mutation happened to introduce.
		const bundle = mint();
		const copy = JSON.parse(bundle.receiptBytes.toString("utf8")) as Record<string, unknown>;
		const envelope = {
			...bundle.envelope,
			receipt: { ...copy, event: { ...(copy.event as object) } },
		};
		expect(resolveEnvelope(Buffer.from(JSON.stringify(envelope), "utf8")).kind).toBe("ok");
	});

	it("POSITIVE CONTROL: the untouched envelope resolves", () => {
		expect(resolveEnvelope(Buffer.from(JSON.stringify(mint().envelope), "utf8")).kind).toBe("ok");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The scanner's guarantee, at the unit level: structural descent, not text.
// ─────────────────────────────────────────────────────────────────────────────

describe("the policy is descended structurally, never matched as a string", () => {
	it("a key that LOOKS like a path segment cannot reach a declared position", () => {
		expect(
			scanJsonForDuplicateKeys('{"keys[0]":{"activationSequence":1.5}}', {
				policy: SNAPSHOT_NUMERIC_POLICY,
			}).ok,
		).toBe(true);
		// …and the REAL position is still refused, which is what makes the line
		// above a scoping statement rather than a hole.
		expect(
			scanJsonForDuplicateKeys('{"keys":[{"activationSequence":1.5}]}', {
				policy: SNAPSHOT_NUMERIC_POLICY,
			}).ok,
		).toBe(false);
	});

	it("a dotted key cannot impersonate a nested one", () => {
		expect(
			scanJsonForDuplicateKeys('{"keys.activationSequence":1.5}', {
				policy: SNAPSHOT_NUMERIC_POLICY,
			}).ok,
		).toBe(true);
	});

	it("no policy means no constraint — every fraction is legal", () => {
		expect(scanJsonForDuplicateKeys('{"n":1.5,"m":-0,"deep":{"x":2.5}}').ok).toBe(true);
	});

	it("a fraction under an UNKNOWN member of a scoped structure stays legal", () => {
		expect(
			scanJsonForDuplicateKeys('{"futureSigningScheme":{"weight":1.5}}', {
				policy: SNAPSHOT_NUMERIC_POLICY,
			}).ok,
		).toBe(true);
	});
});
