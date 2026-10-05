// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * receipt-spec v0.9.6 — the CROSS-IMPLEMENTATION vectors.
 *
 * Every other vector in this directory is built by `harness.ts`, which this
 * repo also wrote: a harness and a verifier that share one reading of §4a agree
 * with each other whether or not that reading is the one the minting chain
 * implements. That is exactly how v0.9.5 shipped a verifier that rejected every
 * real proxy-v1 checkpoint.
 *
 * `proxy-v1-checkpoints.json` was NOT produced here. It is the output of the
 * proxy-v1 minting chain's own code — its incremental per-segment Merkle builder
 * (chain-link leaf included), its inclusion-proof generator, and its checkpoint
 * statement builder and Ed25519 signer — run over three segments: a genesis
 * segment (sequences 1–4, mint events at 1, 2 and 3), a successor (5–9, mint
 * events at 5, 6, 7 and 9), and a third (10–11, mint event at 11) that holds
 * its chain link and two events, so its tree PROMOTES leaf 2, and that makes
 * the history walk cross a NON-genesis predecessor. The mint positions are
 * §4a's boundaries and every proof node a receipt can recompute: a segment's
 * first event, leaf 1 (the chain link in a non-genesis segment), leaf 2 (the
 * node over the link and the predecessor), odd leaves (the predecessor), and
 * the last leaf of a segment with a successor. The
 * checkpoint key is the harness's `CHECKPOINT_KEY` seed, so the trust snapshot
 * is the harness's own. The proxy's signer output is stored verbatim,
 * transport members included; `toWireCheckpoint` below is the whole of the
 * mapping into the receipt's wire form.
 *
 * What this file still takes from the harness: the receipt envelope and its
 * mint signature (the receipt layer is this repo's), and the projection the
 * mint events carry (handed to the generator as input).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type JsonValue,
	loadTrustSnapshot,
	type ReceiptReport,
	verifyReceipt,
} from "../../src/receipt-verify.js";
import {
	CHECKPOINT_KEY,
	checkpointPreimage,
	type HarnessInclusionProof,
	type MintedBundle,
	merkleInteriorHash,
	merkleLeafHash,
	mint,
	type SegmentCheckpoint,
	signEd25519,
} from "./harness.js";

interface ProxyMint {
	readonly event: Record<string, unknown>;
	readonly inclusion: Record<string, unknown>;
}

interface ProxySegment {
	readonly mints?: readonly ProxyMint[];
	readonly signed: Record<string, unknown>;
}

const PROXY = JSON.parse(
	readFileSync(new URL("./proxy-v1-checkpoints.json", import.meta.url), "utf8"),
) as { checkpointPublicKeySpkiBase64: string; segments: ProxySegment[] };

const SEGMENTS = PROXY.segments;

/**
 * The proxy's signed root → the receipt's §5 `proof.checkpoint`. The proxy
 * stores the signature as `signature` beside two publication-evidence members
 * (`publishedTo`, `reference`) and its `publicKey`; none of those is in the
 * signed statement (§4a), and the wire calls the signature `sig`. Everything
 * else passes through untouched — so a member the proxy signs and §4a does not
 * name reaches the verifier, which is the point.
 */
function toWireCheckpoint(signed: Record<string, unknown>): SegmentCheckpoint {
	const { signature, publishedTo: _p, reference: _r, publicKey: _k, ...statement } = signed;
	return { ...statement, sig: signature } as unknown as SegmentCheckpoint;
}

const WIRE = SEGMENTS.map((s) => toWireCheckpoint(s.signed));

/** The proxy's mint event at `sequence` in segment `index`, with its proof. */
function proxyMint(index: number, sequence: number): ProxyMint {
	const found = (SEGMENTS[index] as ProxySegment).mints?.find((m) => m.event.sequence === sequence);
	if (found === undefined) throw new Error(`proxy segment ${index} has no mint at ${sequence}`);
	return found;
}

/**
 * A receipt around the proxy's mint event at `sequence` in segment `index`, its
 * inclusion proof and that segment's checkpoint. `checkpoint` lets a vector
 * substitute the embedded statement.
 */
function proxyReceipt(
	index: number,
	sequence: number,
	checkpoint: SegmentCheckpoint = WIRE[index] as SegmentCheckpoint,
): MintedBundle {
	const { event, inclusion } = proxyMint(index, sequence);
	return mint({
		receiptBeforeSign: (r) => ({
			...r,
			event: event as never,
			proof: {
				...r.proof,
				mintEventHash: event.hash as string,
				inclusion: inclusion as unknown as HarnessInclusionProof,
				checkpoint,
			},
		}),
		snapshot: (s) => ({
			...s,
			chains: s.chains.map((c) => ({
				...c,
				genesisSegmentId: WIRE[0]?.segmentId as string,
				headSegmentId: WIRE[WIRE.length - 1]?.segmentId as string,
				headSegmentFirstSequence: WIRE[WIRE.length - 1]?.segmentFirstSequence as number,
			})),
		}),
	});
}

function run(bundle: MintedBundle, history?: readonly SegmentCheckpoint[]): ReceiptReport {
	const load = loadTrustSnapshot(bundle.snapshotBytes);
	if (!load.ok) throw new Error(`snapshot did not load: ${load.detail}`);
	return verifyReceipt({
		receiptBytes: bundle.receiptBytes,
		snapshot: load.snapshot,
		extensions:
			history === undefined
				? {}
				: { checkpointHistory: JSON.parse(JSON.stringify(history)) as JsonValue },
	});
}

function resign(statement: Omit<SegmentCheckpoint, "sig">): SegmentCheckpoint {
	return {
		...statement,
		sig: signEd25519(CHECKPOINT_KEY, checkpointPreimage(statement)),
	} as SegmentCheckpoint;
}

/** A non-genesis receipt's offset: the chain link holds leaf 0. */
function offsetOf(checkpoint: SegmentCheckpoint): 0 | 1 {
	return checkpoint.previousSegmentRoot === "genesis" ? 0 : 1;
}

describe("proxy-v1 cross-implementation (receipt-spec v0.9.6)", () => {
	it("the fixture is what it claims: the harness's checkpoint key, three segments, eight mint events", () => {
		expect(PROXY.checkpointPublicKeySpkiBase64).toBe(CHECKPOINT_KEY.publicKeySpkiBase64);
		expect(SEGMENTS.length).toBe(3);
		expect(SEGMENTS.map((s) => (s.mints ?? []).map((m) => m.event.sequence))).toEqual([
			[1, 2, 3],
			[5, 6, 7, 9],
			[11],
		]);
		// The third segment holds its link and two events: level 0 promotes leaf 2.
		expect(WIRE[2]?.treeSize).toBe(3);
	});

	it("the proxy signs TWELVE members — v0.9.5's eleven plus segmentStartPreviousHash", () => {
		for (const wire of WIRE) {
			const { sig: _sig, ...statement } = wire;
			expect(Object.keys(statement).sort()).toEqual(
				[
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
				].sort(),
			);
		}
		// Genesis: the all-zero chain genesis. Successors: the predecessor's last event.
		expect(WIRE[0]?.segmentStartPreviousHash).toBe("0".repeat(64));
		expect(WIRE[1]?.segmentStartPreviousHash).not.toBe("0".repeat(64));
	});

	it("the proxy's tree offsets leafIndex by the chain link ONLY in a non-genesis segment", () => {
		for (const [index, s] of SEGMENTS.entries()) {
			const cp = WIRE[index] as SegmentCheckpoint;
			for (const { event, inclusion } of s.mints ?? []) {
				expect(inclusion.leafIndex).toBe(
					Number(event.sequence) - cp.segmentFirstSequence + offsetOf(cp),
				);
			}
		}
		// Concretely: genesis 3 − 1 + 0 = 2; successor 7 − 5 + 1 = 3. v0.9.5's
		// `sequence − first` is right for the first and wrong for the second.
		expect(proxyMint(0, 3).inclusion.leafIndex).toBe(2);
		expect(proxyMint(1, 7).inclusion.leafIndex).toBe(3);
	});

	it("a GENESIS-segment receipt (offset 0) built from proxy bytes verifies, history included", () => {
		const report = run(proxyReceipt(0, 3), WIRE);
		expect(report.failure).toBeNull();
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");
	});

	it("a NON-genesis receipt (offset 1) built from proxy bytes verifies, history included", () => {
		// The walk crosses both kinds of predecessor: 5 = 1 + 4 − 0 and
		// 10 = 5 + 6 − 1. v0.9.5's `first + treeSize` refuses the second.
		const report = run(proxyReceipt(1, 7), WIRE);
		expect(report.failure).toBeNull();
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");
	});

	it("each segment's FIRST event links to its signed segmentStartPreviousHash, and verifies", () => {
		for (const [index, sequence] of [
			[0, 1],
			[1, 5],
		] as const) {
			const { event } = proxyMint(index, sequence);
			expect(event.previousHash).toBe((WIRE[index] as SegmentCheckpoint).segmentStartPreviousHash);
			expect(run(proxyReceipt(index, sequence), WIRE).verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");
		}
	});

	it("every proof node a receipt can RECOMPUTE is the node the proxy built", () => {
		// The real-bytes control for §4a's recomputable nodes: the proxy's leaf 0
		// is the predecessor's root in the raw-hash position, and its leaves are
		// the hash chain, so the receipt rebuilds — from its own signed values —
		// the level-0 sibling at an odd leaf and the node over leaves 0 and 1 at
		// leaf 2. Every honest receipt satisfies them, and verifies.
		const recomputed: string[] = [];
		for (const [index, s] of SEGMENTS.entries()) {
			const cp = WIRE[index] as SegmentCheckpoint;
			const offset = offsetOf(cp);
			for (const { event, inclusion } of s.mints ?? []) {
				const leaf = Number(inclusion.leafIndex);
				const siblings = inclusion.siblings as { hash: string }[];
				const previous = event.previousHash as string;
				if (leaf % 2 === 1) {
					const known = leaf - 1 >= offset ? previous : cp.previousSegmentRoot;
					expect(siblings[0]?.hash).toBe(merkleLeafHash(known));
					recomputed.push(`${event.sequence}@0`);
				} else if (leaf === 2 && offset === 1) {
					const at = cp.treeSize === 3 ? 0 : 1;
					expect(siblings[at]?.hash).toBe(
						merkleInteriorHash(merkleLeafHash(cp.previousSegmentRoot), merkleLeafHash(previous)),
					);
					recomputed.push(`${event.sequence}@${at}`);
				}
				expect(run(proxyReceipt(index, Number(event.sequence)), WIRE).verdict).toBe(
					"VERIFIED_CHECKPOINT_HISTORY",
				);
			}
		}
		// Leaf 1 genesis (2), leaf 1 link (5), leaf 2 (6), leaf 3 (7), leaf 5 (9),
		// and leaf 2 where level 0 promoted it (11).
		expect(recomputed).toEqual(["2@0", "5@0", "6@1", "7@0", "9@0", "11@0"]);
	});

	it("a checkpoint re-signed over another previousSegmentRoot FAILS wherever the link is recomputable", () => {
		// Leaf 1 (sibling 0 IS the link), leaf 2 (sibling 1 is the node over the
		// link and leaf 1), and leaf 2 of a three-leaf tree (that node is sibling 0).
		for (const [index, sequence] of [
			[1, 5],
			[1, 6],
			[2, 11],
		] as const) {
			const { sig: _sig, ...statement } = WIRE[index] as SegmentCheckpoint;
			const forged = resign({ ...statement, previousSegmentRoot: "1".repeat(64) });
			const report = run(proxyReceipt(index, sequence, forged));
			expect(report.failure, `sequence ${sequence}`).toMatchObject({
				step: "event",
				code: "EVENT_MISMATCH",
			});
			expect(report.failure?.detail, `sequence ${sequence}`).toContain("chain link");
		}
	});

	it("at a segment's LAST leaf, the successor the proxy signed starts from exactly that event", () => {
		// The real-bytes control for the successor binding: the proxy's next
		// segment signs its predecessor's final event hash as its start hash.
		const { event, inclusion } = proxyMint(1, 9);
		expect(inclusion.leafIndex).toBe(Number(inclusion.treeSize) - 1);
		expect((WIRE[2] as SegmentCheckpoint).segmentStartPreviousHash).toBe(event.hash);
		expect(run(proxyReceipt(1, 9), WIRE).verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");
		// Re-signed over another start hash, the successor contradicts the receipt.
		const { sig: _sig, ...successor } = WIRE[2] as SegmentCheckpoint;
		const contradicting = [
			WIRE[0] as SegmentCheckpoint,
			WIRE[1] as SegmentCheckpoint,
			resign({ ...successor, segmentStartPreviousHash: "2".repeat(64) }),
		];
		const report = run(proxyReceipt(1, 9), contradicting);
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(report.checks.checkpointHistory).toMatchObject({
			result: "failed",
			failure: { code: "HISTORY_INVALID" },
		});
		expect(report.checks.checkpointHistory.failure?.detail).toContain("final event");
	});

	it("dropping segmentStartPreviousHash from a proxy checkpoint FAILS", () => {
		const { segmentStartPreviousHash: _dropped, ...rest } = WIRE[1] as SegmentCheckpoint;
		const report = run(proxyReceipt(1, 7, rest as SegmentCheckpoint));
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.code).toBe("CHECKPOINT_INVALID");
		expect(report.failure?.detail).toContain("segmentStartPreviousHash");
	});

	it("the v0.9.5 ELEVEN-member statement, validly re-signed, FAILS — it was never minted", () => {
		const {
			sig: _sig,
			segmentStartPreviousHash: _dropped,
			...eleven
		} = WIRE[1] as SegmentCheckpoint;
		const report = run(proxyReceipt(1, 7, resign(eleven as Omit<SegmentCheckpoint, "sig">)));
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.code).toBe("CHECKPOINT_INVALID");
	});

	it("an altered segmentStartPreviousHash breaks the PROXY's signature", () => {
		const altered = {
			...(WIRE[1] as SegmentCheckpoint),
			segmentStartPreviousHash: "1".repeat(64),
		};
		const report = run(proxyReceipt(1, 7, altered));
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.code).toBe("CHECKPOINT_INVALID");
		expect(report.failure?.detail).toContain("signature does not verify");
	});
});
