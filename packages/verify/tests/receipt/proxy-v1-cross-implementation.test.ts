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
 * segment (sequences 1–4, mint event at 3), a successor (5–9, mint event at 7),
 * and a third (10–12) that exists so the history walk crosses a NON-genesis
 * predecessor. The checkpoint key is the harness's `CHECKPOINT_KEY` seed, so
 * the trust snapshot is the harness's own. The proxy's signer output is stored
 * verbatim, transport members included; `toWireCheckpoint` below is the whole
 * of the mapping into the receipt's wire form.
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
	mint,
	type SegmentCheckpoint,
	signEd25519,
} from "./harness.js";

interface ProxySegment {
	readonly event?: Record<string, unknown>;
	readonly inclusion?: Record<string, unknown>;
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

function segment(index: number): ProxySegment & {
	event: Record<string, unknown>;
	inclusion: Record<string, unknown>;
} {
	const s = SEGMENTS[index] as ProxySegment;
	if (s.event === undefined || s.inclusion === undefined) {
		throw new Error(`proxy segment ${index} carries no mint event`);
	}
	return s as ProxySegment & { event: Record<string, unknown>; inclusion: Record<string, unknown> };
}

/**
 * A receipt around proxy segment `index`'s mint event, inclusion proof and
 * checkpoint. `checkpoint` lets a vector substitute the embedded statement.
 */
function proxyReceipt(
	index: number,
	checkpoint: SegmentCheckpoint = WIRE[index] as SegmentCheckpoint,
): MintedBundle {
	const { event, inclusion } = segment(index);
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

describe("proxy-v1 cross-implementation (receipt-spec v0.9.6)", () => {
	it("the fixture is what it claims: the harness's checkpoint key, three segments, two mint events", () => {
		expect(PROXY.checkpointPublicKeySpkiBase64).toBe(CHECKPOINT_KEY.publicKeySpkiBase64);
		expect(SEGMENTS.length).toBe(3);
		expect(SEGMENTS.filter((s) => s.event !== undefined).length).toBe(2);
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
		const genesis = segment(0);
		const successor = segment(1);
		const offset = (cp: SegmentCheckpoint) => (cp.previousSegmentRoot === "genesis" ? 0 : 1);
		for (const [index, s] of [genesis, successor].entries()) {
			const cp = WIRE[index] as SegmentCheckpoint;
			expect(s.inclusion.leafIndex).toBe(
				Number(s.event.sequence) - cp.segmentFirstSequence + offset(cp),
			);
		}
		// Concretely: genesis 3 − 1 + 0 = 2; successor 7 − 5 + 1 = 3. v0.9.5's
		// `sequence − first` is right for the first and wrong for the second.
		expect(genesis.inclusion.leafIndex).toBe(2);
		expect(successor.inclusion.leafIndex).toBe(3);
		expect(successor.inclusion.leafIndex).not.toBe(
			Number(successor.event.sequence) - (WIRE[1] as SegmentCheckpoint).segmentFirstSequence,
		);
	});

	it("a GENESIS-segment receipt (offset 0) built from proxy bytes verifies, history included", () => {
		const report = run(proxyReceipt(0), WIRE);
		expect(report.failure).toBeNull();
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");
	});

	it("a NON-genesis receipt (offset 1) built from proxy bytes verifies, history included", () => {
		// The walk crosses both kinds of predecessor: 5 = 1 + 4 − 0 and
		// 10 = 5 + 6 − 1. v0.9.5's `first + treeSize` refuses the second.
		const report = run(proxyReceipt(1), WIRE);
		expect(report.failure).toBeNull();
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");
	});

	it("dropping segmentStartPreviousHash from a proxy checkpoint FAILS", () => {
		const { segmentStartPreviousHash: _dropped, ...rest } = WIRE[1] as SegmentCheckpoint;
		const report = run(proxyReceipt(1, rest as SegmentCheckpoint));
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
		const report = run(proxyReceipt(1, resign(eleven as Omit<SegmentCheckpoint, "sig">)));
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.code).toBe("CHECKPOINT_INVALID");
	});

	it("an altered segmentStartPreviousHash breaks the PROXY's signature", () => {
		const altered = {
			...(WIRE[1] as SegmentCheckpoint),
			segmentStartPreviousHash: "1".repeat(64),
		};
		const report = run(proxyReceipt(1, altered));
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.code).toBe("CHECKPOINT_INVALID");
		expect(report.failure?.detail).toContain("signature does not verify");
	});
});
