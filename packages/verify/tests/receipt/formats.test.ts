// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The FORMAT layer — receipt-spec §2/§4a/§5/§12, enforced at §7 step 1.
 *
 * Two review rounds found nine soundness holes in this verifier and they were
 * ONE hole nine times: structure was checked and format was not. `stringAt`
 * answers "is this a present, non-empty string", which is a different question
 * from "is this the thing the spec declares", and every one of the nine was the
 * gap between those two questions:
 *
 *  - a sibling hash of `<64 hex>zz` FOLDS TO THE SAME ROOT, because Node's hex
 *    decoder stops at the first non-hex pair and silently drops the tail;
 *  - `startedAt: "not-a-date"` verified, and no consumer reads it as a time;
 *  - `sourceReservationReceiptId: "not-an-id"` named no receipt and verified;
 *  - `mintedAt`, `event.timestamp` and the checkpoint's `publishedAt` were
 *    presence-only, as were `oid`, `objectSha256` and both content bindings.
 *
 * So this file is written against the CLASS, not the nine instances. Its
 * binding test is the LAST one: it enumerates every member the field table
 * declares, and requires each to refuse a hostile value. A field that nobody
 * validates cannot pass it, which is what makes the class closed rather than
 * sampled — and what stops the tenth instance from being a tenth review round.
 *
 * The other half of every assertion here is that the CLEAN receipt still
 * verifies. A verifier that rejects good receipts is exactly as broken as one
 * that accepts bad ones, and a format layer is the easiest possible place to
 * introduce the first kind of break.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type FormatName,
	type JsonObject,
	type JsonValue,
	loadTrustSnapshot,
	receiptFieldFormats,
	verifyReceipt,
	verifyReceiptBase,
} from "../../src/receipt-verify.js";
import {
	ALT_RECEIPT_ID,
	CHECKPOINT_KEY,
	CHECKPOINT_KEY_SUCCESSOR,
	checkpointPreimage,
	MINT_KEY,
	MINT_KEY_SUCCESSOR,
	type MintOptions,
	mint,
	type Projection,
	type SegmentCheckpoint,
	signEd25519,
	type TrustSnapshot,
} from "./harness.js";

type Run = ReturnType<typeof verifyReceiptBase>;

function verifyMinted(options: MintOptions = {}): Run {
	const bundle = mint(options);
	const load = loadTrustSnapshot(bundle.snapshotBytes);
	if (!load.ok) throw new Error(`fixture snapshot did not load: ${load.detail}`);
	return verifyReceiptBase({ receiptBytes: bundle.receiptBytes, snapshot: load.snapshot });
}

function expectSchemaRefusal(actual: Run, what: string): void {
	expect(actual.failure, what).toMatchObject({ step: "schema", code: "SCHEMA_INVALID" });
}

/** Edit one path of the SIGNED document. Step 1 runs before step 4, so a broken
 * signature never masks a schema refusal — and every vector here is about what
 * step 1 does or does not notice. */
function withValueAt(path: readonly string[], value: JsonValue): MintOptions {
	return {
		receiptAfterSign: (receipt) => {
			const copy = structuredClone(receipt) as Record<string, unknown>;
			let cursor: Record<string, unknown> = copy;
			for (let i = 0; i < path.length - 1; i += 1) {
				cursor = cursor[path[i] as string] as Record<string, unknown>;
			}
			cursor[path[path.length - 1] as string] = value as unknown;
			return copy;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The named findings, one test each, in the words of the review that found them.
// ─────────────────────────────────────────────────────────────────────────────

describe("§4a — a sibling hash is 64 lowercase hex, and a lenient decoder is not a reader", () => {
	it("refuses `<64 hex>zz`, which folds to the SAME root under Node's hex decoder", () => {
		// The vector is not hypothetical arithmetic: `Buffer.from(hex, "hex")`
		// stops at the first non-hex pair and returns what it got, so the appended
		// `zz` is dropped and the fold reaches the signed root exactly as the
		// honest sibling would. The proof therefore VERIFIES here and FAILS under
		// any implementation whose decoder refuses trailing junk — an interop
		// split in a frozen format, decided by a decoder rather than by the spec.
		const clean = mint();
		const inclusion = (clean.receipt.proof as JsonObject).inclusion as JsonObject;
		const honest = ((inclusion.siblings as JsonObject[])[0] as JsonObject).hash as string;

		const actual = verifyMinted({
			inclusion: (proof) => ({
				...proof,
				siblings: proof.siblings.map((sibling, index) =>
					index === 0 ? { ...sibling, hash: `${sibling.hash}zz` } : sibling,
				),
			}),
		});
		expectSchemaRefusal(actual, "sibling hash with a non-hex tail");

		// And the proof of the premise, so the vector cannot rot into a tautology:
		// the tail really is dropped, so nothing downstream would have caught it.
		expect(Buffer.from(`${honest}zz`, "hex").toString("hex")).toBe(honest);
	});

	it("refuses uppercase hex and a short digest in the same position", () => {
		for (const hash of ["A".repeat(64), "abcd"]) {
			expectSchemaRefusal(
				verifyMinted({
					inclusion: (proof) => ({
						...proof,
						siblings: proof.siblings.map((sibling, index) =>
							index === 0 ? { ...sibling, hash } : sibling,
						),
					}),
				}),
				hash,
			);
		}
	});
});

describe("§2 — the timestamps are RFC 3339 UTC 'Z' with millisecond precision", () => {
	const bad = [
		"not-a-date",
		"2026-08-11",
		"2026-08-11T18:00:00Z",
		"2026-08-11T18:00:00.000+00:00",
		"2026-08-11t18:00:00.000z",
		// Syntactically perfect and not an instant: `Date` rolls it to March 2nd,
		// which is why the round trip and not the regex is the test.
		"2026-02-30T00:00:00.000Z",
		"2026-13-01T00:00:00.000Z",
	];

	it("refuses every non-conformant `startedAt` and `endedAt`", () => {
		for (const value of bad) {
			expectSchemaRefusal(
				verifyMinted({ projection: (p: Projection) => ({ ...p, startedAt: value }) }),
				`startedAt ${value}`,
			);
			expectSchemaRefusal(
				verifyMinted({ projection: (p: Projection) => ({ ...p, endedAt: value }) }),
				`endedAt ${value}`,
			);
		}
	});

	it("refuses a `mintedAt` and an `event.timestamp` that are not times", () => {
		expectSchemaRefusal(
			verifyMinted(withValueAt(["mintedAt"], "not-a-date")),
			"mintedAt not-a-date",
		);
		expectSchemaRefusal(
			verifyMinted({ event: (e) => ({ ...e, timestamp: "not-a-date" }) }),
			"event.timestamp not-a-date",
		);
	});

	it("refuses a checkpoint `publishedAt` that is not a time — at step 6, which owns the statement", () => {
		const actual = verifyMinted({
			checkpointsUnsigned: (checkpoints) =>
				checkpoints.map((c) => ({ ...c, publishedAt: "whenever" })),
		});
		expect(actual.failure).toMatchObject({ step: "checkpoint", code: "CHECKPOINT_INVALID" });
	});

	it("accepts the boundary instants a conformant minter emits", () => {
		for (const value of [
			"1970-01-01T00:00:00.000Z",
			"2026-12-31T23:59:59.999Z",
			"2024-02-29T12:00:00.000Z",
		]) {
			expect(
				verifyMinted({
					projection: (p: Projection) => ({ ...p, startedAt: value, endedAt: value }),
				}).verdict,
				value,
			).toBe("VERIFIED_CHECKPOINT");
		}
	});
});

describe("§2 — `sourceReservationReceiptId` is a Ut1ReceiptId, not a string", () => {
	const fallbackSession = (sourceReservationReceiptId: string): MintOptions => ({
		projection: (p: Projection) => ({
			...p,
			work: {
				kind: "session",
				repoId: "github.com:R_kgDOK1x2Yw",
				origin: { kind: "billedUnfinalized", sourceReservationReceiptId },
			},
		}),
	});

	it("refuses an id that is not a canonical §12 id", () => {
		for (const id of ["not-an-id", "", "ut1_", `ut1_${"1".repeat(23)}`, ALT_RECEIPT_ID.slice(4)]) {
			expectSchemaRefusal(verifyMinted(fallbackSession(id)), `sourceReservationReceiptId ${id}`);
		}
	});

	it("accepts the fallback variant when the link is a real receipt id", () => {
		expect(verifyMinted(fallbackSession(ALT_RECEIPT_ID)).verdict).toBe("VERIFIED_CHECKPOINT");
	});
});

describe("a declared format is also a TYPE — a member of the wrong type is not the member", () => {
	it("refuses a number where §2 declares a timestamp", () => {
		// The wrong-type case has to be part of the format, not a separate check
		// the next reader forgets: `stringAt` answers `null` for a number, which
		// every caller in this file spells "is missing" — a true statement about
		// a different document than the one in hand.
		expectSchemaRefusal(
			verifyMinted({ projection: (p: Projection) => ({ ...p, startedAt: 5 }) }),
			"startedAt as a number",
		);
	});

	it("refuses a keyed commitment whose body is not base64url at all", () => {
		// Two different rejections behind one format: a body outside the alphabet
		// (here) and a body that IS base64url but does not decode to a 32-byte MAC
		// (the `c1_short` vector in the closure sweep below).
		expectSchemaRefusal(
			verifyMinted({
				projection: (p: Projection) => ({
					...p,
					work: {
						kind: "issue",
						repoId: "github.com:R_kgDOK1x2Yw",
						number: 7,
						providerArtifactId: "I_kwDO",
						observedRevision: "rev_2",
						contentBinding: { kind: "privateHmacSha256V1", commitment: "c1_$$$" },
						repositoryMembership: { status: "providerVerified", proofId: "pv_9f3a2c81d0" },
					},
				}),
			}),
			"commitment outside the base64url alphabet",
		);
	});
});

describe("§2/§4a — the digests that were presence-only", () => {
	const commitWork = (patch: Record<string, unknown>): MintOptions => ({
		projection: (p: Projection) => ({
			...p,
			work: { ...(p.work as Record<string, unknown>), ...patch },
		}),
	});

	it("refuses a truncated or uppercase git OID, and a `objectSha256` that is not a digest", () => {
		expectSchemaRefusal(commitOid("37df16d3"), "32-bit OID prefix");
		expectSchemaRefusal(commitOid("37DF16D3A4C1B8E05F92D7A6C31E4B8079FA2D51"), "uppercase OID");
		expectSchemaRefusal(verifyMinted(commitWork({ objectSha256: "not-a-digest" })), "objectSha256");
	});

	function commitOid(oid: string): Run {
		return verifyMinted(commitWork({ oid }));
	}

	it("binds the OID's LENGTH to `oidAlg` in both directions", () => {
		expectSchemaRefusal(
			verifyMinted(commitWork({ oid: "a".repeat(64), oidAlg: "sha1" })),
			"sha256-length OID under sha1",
		);
		expectSchemaRefusal(
			verifyMinted(commitWork({ oid: "a".repeat(40), oidAlg: "sha256" })),
			"sha1-length OID under sha256",
		);
		expect(verifyMinted(commitWork({ oid: "a".repeat(64), oidAlg: "sha256" })).verdict).toBe(
			"VERIFIED_CHECKPOINT",
		);
	});

	it("refuses an `event.previousHash` that is not the previous event's digest shape", () => {
		expectSchemaRefusal(
			verifyMinted({ event: (e) => ({ ...e, previousHash: "genesis" }) }),
			"previousHash genesis",
		);
		// The all-zero genesis sentinel IS a digest shape and stays legal.
		expect(verifyMinted({ event: (e) => ({ ...e, previousHash: "0".repeat(64) }) }).verdict).toBe(
			"VERIFIED_CHECKPOINT",
		);
	});

	it("refuses a lineage edge that is not a digest, at step 6", () => {
		// `previousSegmentRoot` is read by nobody before step 6 on the receipt's
		// own checkpoint, so §4a's format is the only thing that can refuse it —
		// and the edge is exactly what v2 added its signature to protect.
		const actual = verifyMinted({
			checkpointsUnsigned: (checkpoints) =>
				checkpoints.map((c, index) => (index === 2 ? { ...c, previousSegmentRoot: "nope" } : c)),
		});
		expect(actual.failure).toMatchObject({ step: "checkpoint", code: "CHECKPOINT_INVALID" });
	});

	it("leaves the receipt's own checkpoint ROOT to equality 6 and the fold, which are stronger", () => {
		// Rewriting it breaks `inclusion.root === checkpoint.root` first, and a
		// root that survived THAT would still have to be the digest the siblings
		// fold to. The format is pinned transitively here; where it is not — a
		// SERVED history member, whose root is only ever compared to the next
		// member's edge — step 6's shape check is what holds it (below).
		const actual = verifyMinted({
			checkpointsUnsigned: (checkpoints) =>
				checkpoints.map((c, index) => (index === 2 ? { ...c, root: "not-a-root" } : c)),
		});
		expect(actual.failure).toMatchObject({ step: "event", code: "EVENT_MISMATCH" });
	});

	it("keeps §4a's genesis sentinel legal in `previousSegmentRoot`", () => {
		// The genesis checkpoint carries the fixed string, so the format is
		// "digest OR genesis" and not "digest" — a rule that over-rejected here
		// would refuse every conformant chain at its first segment.
		expect(verifyMinted().verdict).toBe("VERIFIED_CHECKPOINT");
	});
});

describe("§2 — a catalog entry that is empty is not well formed", () => {
	it("refuses a blank `models`, `providers` or `pricing.tableVersions` entry", () => {
		for (const patch of [
			{ models: ["", "claude-opus-4-5"] },
			{ providers: [""] },
			{ pricing: { tableVersions: [""] } },
		]) {
			const actual = verifyMinted({ projection: (p: Projection) => ({ ...p, ...patch }) });
			expect(actual.failure, JSON.stringify(patch)).toMatchObject({
				step: "semantics",
				code: "SEMANTIC_INVALID",
			});
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The step-9 half: a SERVED history member never passes through step 1's
// reader, so §4a's member formats have to hold where step 6 applies them.
// ─────────────────────────────────────────────────────────────────────────────

describe("§7 step 9 — a served history member is held to the same §4a formats", () => {
	function runWithHistory(history: readonly JsonValue[]): ReturnType<typeof verifyReceipt> {
		const bundle = mint();
		const load = loadTrustSnapshot(bundle.snapshotBytes);
		if (!load.ok) throw new Error(load.detail);
		return verifyReceipt({
			receiptBytes: bundle.receiptBytes,
			snapshot: load.snapshot,
			extensions: { checkpointHistory: history },
		});
	}

	function resign(unsigned: Record<string, unknown>): JsonValue {
		return {
			...unsigned,
			sig: signEd25519(CHECKPOINT_KEY, checkpointPreimage(unsigned)),
		} as unknown as JsonValue;
	}

	it("refuses a validly SIGNED member whose root is not a digest", () => {
		// The gap this closes: a history member's `root` is compared only to the
		// NEXT member's `previousSegmentRoot`, so two members carrying the same
		// non-digest string walk clean. Nothing folds it, nothing recomputes it —
		// §4a's format is the only rule there is.
		const bundle = mint();
		const history = JSON.parse(JSON.stringify(bundle.history)) as JsonObject[];
		const { sig: _first, ...genesis } = history[0] as unknown as SegmentCheckpoint;
		const { sig: _second, ...second } = history[1] as unknown as SegmentCheckpoint;
		const report = runWithHistory([
			resign({ ...genesis, root: "not-a-root" }),
			resign({ ...second, previousSegmentRoot: "not-a-root" }),
			history[2] as JsonValue,
		]);
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
		expect(report.checks.checkpointHistory.failure?.detail).toContain("root");
	});

	it("refuses a validly SIGNED member whose publishedAt is not a time", () => {
		const bundle = mint();
		const history = JSON.parse(JSON.stringify(bundle.history)) as JsonObject[];
		const { sig: _dropped, ...second } = history[1] as unknown as SegmentCheckpoint;
		const report = runWithHistory([
			history[0] as JsonValue,
			resign({ ...second, publishedAt: "whenever" }),
			history[2] as JsonValue,
		]);
		// Upgrade-only: the base verdict is untouched and the extension names why.
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(report.checks.checkpointHistory.failure?.code).toBe("HISTORY_INVALID");
		expect(report.checks.checkpointHistory.failure?.detail).toContain("publishedAt");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — the retirement boundary, read across the rotation LINK.
// ─────────────────────────────────────────────────────────────────────────────

describe("§8 — a key with a declared successor cannot stay `active`", () => {
	/** The conformant rotation the corpus already mints, for contrast. */
	function rotated(patch: (s: TrustSnapshot) => void): MintOptions {
		return {
			snapshot: (snapshot) => {
				patch(snapshot);
				return snapshot;
			},
		};
	}

	it("refuses a snapshot whose predecessor is still active — the rotated key has NO boundary", () => {
		// The defect this closes: `keyStatePermits` gives an `active` key no upper
		// bound, because §8 says an active key "has no successor yet". Declare a
		// successor and leave the predecessor active and both keys sit in the
		// pinned lineage, with the rotated-away key free to sign new material
		// forever — a clean-looking rotation that rotates nothing.
		for (const role of ["mint", "checkpoint"] as const) {
			const predecessor = role === "mint" ? MINT_KEY : CHECKPOINT_KEY;
			const successor = role === "mint" ? MINT_KEY_SUCCESSOR : CHECKPOINT_KEY_SUCCESSOR;
			const bundle = mint(
				rotated((s) => {
					s.keys.push({
						keyId: successor.keyId,
						alg: "ed25519",
						publicKey: successor.publicKeyPem,
						role,
						...(role === "mint" ? { minterKind: "proxy" } : {}),
						predecessorKeyId: predecessor.keyId,
						state: "active",
					});
				}),
			);
			const load = loadTrustSnapshot(bundle.snapshotBytes);
			expect(load.ok, role).toBe(false);
			expect(load.ok === false && load.detail, role).toContain("names it as predecessor");
		}
	});

	it("accepts `retired` and `revoked` predecessors — the rule is about the boundary, not the link", () => {
		for (const state of ["retired", "revoked"] as const) {
			const bundle = mint(
				rotated((s) => {
					const predecessor = s.keys.find((k) => k.keyId === CHECKPOINT_KEY.keyId);
					if (predecessor !== undefined) {
						predecessor.state = state;
						if (state === "retired") predecessor.activationSequence = 18;
					}
					s.keys.push({
						keyId: CHECKPOINT_KEY_SUCCESSOR.keyId,
						alg: "ed25519",
						publicKey: CHECKPOINT_KEY_SUCCESSOR.publicKeyPem,
						role: "checkpoint",
						predecessorKeyId: CHECKPOINT_KEY.keyId,
						state: "active",
					});
				}),
			);
			expect(loadTrustSnapshot(bundle.snapshotBytes).ok, state).toBe(true);
		}
	});

	it("still reports a CYCLE as a cycle — the new rule does not steal its vector", () => {
		const bundle = mint(
			rotated((s) => {
				const predecessor = s.keys.find((k) => k.keyId === MINT_KEY.keyId);
				if (predecessor !== undefined) predecessor.predecessorKeyId = MINT_KEY_SUCCESSOR.keyId;
				s.keys.push({
					keyId: MINT_KEY_SUCCESSOR.keyId,
					alg: "ed25519",
					publicKey: MINT_KEY_SUCCESSOR.publicKeyPem,
					role: "mint",
					minterKind: "proxy",
					predecessorKeyId: MINT_KEY.keyId,
					state: "active",
				});
			}),
		);
		const load = loadTrustSnapshot(bundle.snapshotBytes);
		expect(load.ok).toBe(false);
		expect(load.ok === false && load.detail).toContain("cyclic");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — `notApplicable` is a claim about the INPUT, not about the run.
// ─────────────────────────────────────────────────────────────────────────────

describe("§7 — an arrival context that was supplied but never compared", () => {
	it("reports `unavailable`, not `notApplicable`, when an earlier step failed", () => {
		const bundle = mint({ projection: (p: Projection) => ({ ...p, startedAt: "not-a-date" }) });
		const load = loadTrustSnapshot(bundle.snapshotBytes);
		if (!load.ok) throw new Error(load.detail);
		const report = verifyReceiptBase({
			receiptBytes: bundle.receiptBytes,
			snapshot: load.snapshot,
			arrivalId: String(bundle.receipt.receiptId),
		});
		expect(report.verdict).toBe("FAILED");
		// §7 reserves `notApplicable` for an input that "does not exist in this
		// context and never could". The operator handed one over; it exists.
		expect(report.arrivalContext.result).toBe("unavailable");
		expect(report.arrivalContext.expected).toBe(String(bundle.receipt.receiptId));
		expect(report.steps.registry.result).toBe("unavailable");
	});

	it("keeps `notApplicable` when no arrival context was supplied at all", () => {
		const report = verifyMinted();
		expect(report.arrivalContext).toEqual({ result: "notApplicable", expected: null });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The binding test: the CLASS, not the instances.
// ─────────────────────────────────────────────────────────────────────────────

describe("the field table is CLOSED — every declared format is enforced", () => {
	/** One hostile value per format, each the shape the spec rules out. */
	const HOSTILE: Partial<Record<FormatName, JsonValue>> = {
		hex64: "not-a-digest",
		hex64OrGenesis: "not-a-root",
		hex32: "zz",
		gitOid: "37df16d3",
		rfc3339UtcMs: "not-a-date",
		receiptId: "not-an-id",
		opaqueHandle: "has a space",
		keyedRepoId: "r1_not-a-mac",
		keyedContentCommitment: "c1_short",
		providerRepoUrl: "/Users/cam/private/customer-acme",
		canonicalBase64: "not base64!",
		nonEmpty: "",
		integer: "3",
	};

	const MEMBERSHIP = { status: "providerVerified", proofId: "pv_9f3a2c81d0" };
	const REPO_ID = "github.com:R_kgDOK1x2Yw";
	const COMMITMENT = `c1_${createHash("sha256").update("usertrust/test-commitment").digest("base64url")}`;

	/** A work value carrying exactly the variants a path names. */
	function workForPath(path: string): Record<string, unknown> | null {
		const kind = /work\[(\w+)\]/.exec(path)?.[1] ?? "commit";
		const binding = /contentBinding\[(\w+)\]/.exec(path)?.[1] ?? "publicSha256";
		if (kind === "commit") {
			return {
				kind: "commit",
				repoId: REPO_ID,
				repo: "github.com/usertools-ai/usertrust",
				oid: "37df16d3a4c1b8e05f92d7a6c31e4b8079fa2d51",
				oidAlg: "sha1",
				objectSha256: "b".repeat(64),
				repositoryMembership: MEMBERSHIP,
			};
		}
		if (kind === "pr" || kind === "issue") {
			return {
				kind,
				repoId: REPO_ID,
				number: 92,
				providerArtifactId: "PR_kwDOK1x2Yw6h3Qm2",
				observedRevision: "rev_1",
				contentBinding:
					binding === "publicSha256"
						? { kind: "publicSha256", sha256: "a".repeat(64) }
						: { kind: "privateHmacSha256V1", commitment: COMMITMENT },
				repositoryMembership: MEMBERSHIP,
			};
		}
		if (kind === "session") {
			return path.includes("origin")
				? {
						kind: "session",
						repoId: REPO_ID,
						origin: { kind: "billedUnfinalized", sourceReservationReceiptId: ALT_RECEIPT_ID },
					}
				: { kind: "session", repoId: REPO_ID };
		}
		return null;
	}

	/** `a.b[]​.c` / `a.b[variant].c` → the concrete member path in the document. */
	function segmentsOf(path: string): string[] {
		const out: string[] = [];
		for (const raw of path.split(".")) {
			const array = raw.endsWith("[]");
			const variant = /^([^[]+)\[[^\]]+\]$/.exec(raw);
			if (array) {
				out.push(raw.slice(0, -2), "0");
			} else if (variant !== null) {
				out.push(variant[1] as string);
			} else {
				out.push(raw);
			}
		}
		return out;
	}

	const declared = receiptFieldFormats();

	it("declares a format for every member of the signed receipt", () => {
		// A sanity floor rather than a count to maintain: the point is that the
		// table is the ONLY place a member is declared, so an undeclared one is
		// an unknown field, which step 1 already refuses.
		expect(declared.length).toBeGreaterThan(100);
		expect(new Set(declared.map((f) => f.owner))).toEqual(
			new Set(["schema", "event", "signature", "inclusion", "checkpoint", "semantics"]),
		);
	});

	const enforceable = declared.filter(
		(field) => field.owner === "schema" && HOSTILE[field.format] !== undefined,
	);

	it("covers every schema-owned member — no format is declared and then skipped", () => {
		// If this ever shrinks silently, the sweep below stops proving anything.
		expect(enforceable.length).toBeGreaterThanOrEqual(40);
	});

	for (const field of enforceable) {
		it(`refuses a hostile ${field.format} at ${field.path}`, () => {
			const work = workForPath(field.path);
			expect(work, field.path).not.toBeNull();
			const base: MintOptions =
				field.path.includes("work[") && work !== null
					? { projection: (p: Projection) => ({ ...p, work }) }
					: {};
			const hostile = HOSTILE[field.format] as JsonValue;
			const planted = withValueAt(segmentsOf(field.path), hostile);
			const actual = verifyMinted({ ...base, ...planted });
			expectSchemaRefusal(actual, `${field.path} = ${JSON.stringify(hostile)}`);
		});
	}

	it("and accepts every variant when its members ARE well formed — no false positives", () => {
		for (const path of [
			"work[commit].oid",
			"work[pr].contentBinding[publicSha256].sha256",
			"work[issue].contentBinding[privateHmacSha256V1].commitment",
			"work[session].repoId",
			"work[session].origin.sourceReservationReceiptId",
		]) {
			const work = workForPath(path) as Record<string, unknown>;
			expect(verifyMinted({ projection: (p: Projection) => ({ ...p, work }) }).verdict, path).toBe(
				"VERIFIED_CHECKPOINT",
			);
		}
	});
});
