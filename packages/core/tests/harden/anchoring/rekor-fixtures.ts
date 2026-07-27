// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Synthetic transparency-log fixtures for the Rekor receipt corpus.
 *
 * The Merkle primitives here are an INDEPENDENT reference implementation of
 * RFC 6962 §2.1 (MTH) and §2.1.1 (PATH) — deliberately recursive and
 * deliberately NOT sharing code with src/audit/merkle.ts or the RFC 9162
 * index-walk verifier under test. A verifier checked against its own algorithm
 * proves nothing; the property test drives this reference against
 * verifyIndexInclusion for every (treeSize <= 20, index) pair.
 */

import {
	createHash,
	sign as cryptoSign,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import { type AnchorRecord, anchorPayloadHash } from "../../../src/audit/anchor-verify.js";
import { canonicalize } from "../../../src/audit/canonical.js";
import type { RekorReceipt } from "../../../src/audit/rekor-verify.js";

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

/** RFC 6962 leaf hash: sha256(0x00 || entry). */
export function leafHash(entry: Buffer): Buffer {
	return createHash("sha256").update(LEAF_PREFIX).update(entry).digest();
}

function nodeHash(left: Buffer, right: Buffer): Buffer {
	return createHash("sha256").update(NODE_PREFIX).update(left).update(right).digest();
}

/** Largest power of two strictly less than n (n > 1). */
function splitPoint(n: number): number {
	let k = 1;
	while (k * 2 < n) k *= 2;
	return k;
}

/** RFC 6962 §2.1 MTH(D[n]) over raw entries. */
export function mth(leaves: readonly Buffer[]): Buffer {
	if (leaves.length === 0) return createHash("sha256").digest();
	if (leaves.length === 1) return leafHash(leaves[0] as Buffer);
	const k = splitPoint(leaves.length);
	return nodeHash(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}

/**
 * RFC 6962 §2.1.1 PATH(m, D[n]) — the audit path for leaf m, leaf->root order.
 * PATH(m, D[1]) = {}; with k = largest power of two < n,
 * m < k  => PATH(m, D[0:k]) : MTH(D[k:n]),
 * m >= k => PATH(m - k, D[k:n]) : MTH(D[0:k]).
 */
export function inclusionPath(m: number, leaves: readonly Buffer[]): Buffer[] {
	const n = leaves.length;
	if (n === 1) return [];
	const k = splitPoint(n);
	if (m < k) return [...inclusionPath(m, leaves.slice(0, k)), mth(leaves.slice(k))];
	return [...inclusionPath(m - k, leaves.slice(k)), mth(leaves.slice(0, k))];
}

/**
 * Build a signed note (checkpoint) exactly as the verifier parses it:
 * `<origin>\n<treeSize>\n<base64 root>\n\n— <origin> <base64(keyhint || DER sig)>\n`
 * The signature covers the 3 body lines INCLUDING their trailing LF.
 */
export function signedNote(
	origin: string,
	treeSize: number,
	root: Buffer,
	signKey: KeyObject,
	keyhint: Buffer = Buffer.from([0xde, 0xad, 0xbe, 0xef]),
): string {
	const body = `${origin}\n${treeSize}\n${root.toString("base64")}\n`;
	const der = cryptoSign("sha256", Buffer.from(body, "utf8"), {
		key: signKey,
		dsaEncoding: "der",
	});
	const noteSig = Buffer.concat([keyhint, der]).toString("base64");
	return `${body}\n— ${origin} ${noteSig}\n`;
}

export interface SyntheticLog {
	treeSize: number;
	rootHex: string;
	checkpoint: string;
	pathFor(index: number): string[];
}

/** A whole synthetic log: root, a signed checkpoint over it, and audit paths. */
export function makeSyntheticLog(
	entries: readonly Buffer[],
	signKey: KeyObject,
	origin: string,
): SyntheticLog {
	const root = mth(entries);
	return {
		treeSize: entries.length,
		rootHex: root.toString("hex"),
		checkpoint: signedNote(origin, entries.length, root, signKey),
		pathFor: (index: number): string[] =>
			inclusionPath(index, entries).map((h) => h.toString("hex")),
	};
}

/** Stand-in for the record signer's public key inside the logged entry body. */
const FIXTURE_RECORD_PUBKEY_PEM = generateKeyPairSync("ed25519").publicKey.export({
	type: "spki",
	format: "pem",
}) as string;

/** The hashedrekord entry body the Rekor sink (T3) proposes for a record. */
export function hashedRekordEntry(record: AnchorRecord, publicKeyPem: string): Buffer {
	return Buffer.from(
		canonicalize({
			apiVersion: "0.0.1",
			kind: "hashedrekord",
			spec: {
				data: { hash: { algorithm: "sha256", value: anchorPayloadHash(record) } },
				signature: {
					content: record.sig,
					publicKey: { content: Buffer.from(publicKeyPem, "utf8").toString("base64") },
				},
			},
		}),
		"utf8",
	);
}

export interface RekorFixtureOptions {
	logSize?: number;
	logIndex?: number;
	origin?: string;
	url?: string;
	integratedTime?: number;
	publicKeyPem?: string;
}

export interface RekorFixture {
	receipt: RekorReceipt;
	logPubkeyPem: string;
	logPrivateKey: KeyObject;
	entryBody: Buffer;
	/** Deep copy with `mutate` applied — the adversarial-mutation driver. */
	tamper(mutate: (receipt: RekorReceipt) => void): RekorReceipt;
}

/**
 * A complete, verifying receipt for a REAL anchor record: the record's entry is
 * planted at `logIndex` in a synthetic log of `logSize` entries, and the
 * checkpoint is signed by a freshly generated P-256 log key.
 */
export function makeRekorReceipt(
	record: AnchorRecord,
	opts: RekorFixtureOptions = {},
): RekorFixture {
	const url = opts.url ?? "https://rekor.sigstore.dev";
	const origin = opts.origin ?? new URL(url).host;
	const logSize = opts.logSize ?? 8;
	const logIndex = opts.logIndex ?? logSize - 1;
	const entry = hashedRekordEntry(record, opts.publicKeyPem ?? FIXTURE_RECORD_PUBKEY_PEM);
	const entries: Buffer[] = [];
	for (let i = 0; i < logSize; i++) {
		entries.push(i === logIndex ? entry : randomBytes(48));
	}
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const log = makeSyntheticLog(entries, privateKey, origin);
	const receipt: RekorReceipt = {
		v: 1,
		vaultId: record.vaultId,
		anchorSeq: record.anchorSeq,
		artifactHash: anchorPayloadHash(record),
		entryBody: entry.toString("base64"),
		log: {
			url,
			logIndex,
			treeSize: logSize,
			rootHash: log.rootHex,
			hashes: log.pathFor(logIndex),
			checkpoint: log.checkpoint,
			integratedTime: opts.integratedTime ?? 1_760_000_000,
		},
	};
	return {
		receipt,
		logPubkeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
		logPrivateKey: privateKey,
		entryBody: entry,
		tamper: (mutate: (receipt: RekorReceipt) => void): RekorReceipt => {
			const copy = JSON.parse(JSON.stringify(receipt)) as RekorReceipt;
			mutate(copy);
			return copy;
		},
	};
}
