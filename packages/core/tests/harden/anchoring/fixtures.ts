// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Shared fixture builders for the external-anchoring adversarial corpus
 * (spec §10). Every fixture is built by REAL writer + emitter code, then
 * mutated by the test — no hand-crafted fantasy vaults.
 */

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyVaultWithAnchors as pkgVerifyVaultWithAnchors } from "../../../../verify/src/index.js";
import {
	createAnchorEmitter,
	initAnchorIdentity,
	mintSuccessorKey,
	readAnchorIdentity,
	recordRotatedIdentity,
} from "../../../src/audit/anchor.js";
import {
	type AnchorRecord,
	type AnchorTrust,
	anchorPayloadHash,
	gatherOrderedEventHashes,
	parseAnchorsContent,
} from "../../../src/audit/anchor-verify.js";
import { canonicalize } from "../../../src/audit/canonical.js";
import { createAuditWriter } from "../../../src/audit/chain.js";
import { buildMerkleTree } from "../../../src/audit/merkle.js";
import {
	type AnchoredVaultVerificationResult,
	type AnchorVerifyParams,
	verifyVaultWithAnchors,
} from "../../../src/audit/verify.js";
import { GENESIS_HASH, VAULT_DIR } from "../../../src/shared/constants.js";

const tracked: string[] = [];

export function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	tracked.push(d);
	return d;
}

export function cleanupAll(): void {
	for (const d of tracked.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
}

export async function appendEvents(root: string, n: number, start = 1): Promise<void> {
	const w = createAuditWriter(root);
	try {
		for (let i = 0; i < n; i++) {
			await w.appendEvent({
				kind: "llm_call",
				actor: "sys",
				data: { cost: 1, transferId: `tr_${start + i}` },
			});
		}
	} finally {
		w.release();
	}
}

export interface AnchoredSetup {
	root: string;
	vaultPath: string;
	storeDir: string;
	storeFile: string;
	keyFile: string;
	rootPem: string;
	trust: AnchorTrust;
}

/** Fresh vault with `events` events, anchor identity, and a file-sink store. */
export async function makeAnchoredVault(events: number): Promise<AnchoredSetup> {
	const root = tmp("anchor-fix-");
	const storeDir = tmp("anchor-store-");
	const storeFile = join(storeDir, "anchors.jsonl");
	writeFileSync(storeFile, "");
	const keyFile = join(storeDir, "key.pem");
	await appendEvents(root, events);
	const { publicKeyPem } = initAnchorIdentity(root, { keyFile });
	return {
		root,
		vaultPath: join(root, VAULT_DIR),
		storeDir,
		storeFile,
		keyFile,
		rootPem: publicKeyPem,
		trust: { rootPem: publicKeyPem },
	};
}

/** One emit cycle through the real emitter (publishes to the file sink). */
export async function anchorOnce(s: AnchoredSetup, keyFile = s.keyFile): Promise<AnchorRecord> {
	const emitter = createAnchorEmitter(s.root, {
		signer: { type: "pem", file: keyFile },
		sinks: [{ type: "file", path: s.storeFile }],
	});
	const result = await emitter.anchorNow();
	await emitter.stop();
	if (!result.emitted || result.record === undefined) {
		throw new Error(`fixture anchor failed: ${result.reason}`);
	}
	return result.record;
}

/** Cross-signed rotation via the real emitter; returns the successor key. */
export async function rotateOnce(
	s: AnchoredSetup,
	currentKeyFile = s.keyFile,
): Promise<{ keyId: string; publicKeyPem: string; publicKeySpki: string; keyFile: string }> {
	const identity = readAnchorIdentity(s.root);
	if (identity === null) throw new Error("fixture: no identity");
	const successor = mintSuccessorKey(identity.vaultId);
	const emitter = createAnchorEmitter(s.root, {
		signer: { type: "pem", file: currentKeyFile },
		sinks: [{ type: "file", path: s.storeFile }],
	});
	const result = await emitter.rotate({
		keyId: successor.keyId,
		publicKeySpki: successor.publicKeySpki,
	});
	await emitter.stop();
	if (!result.emitted) throw new Error(`fixture rotate failed: ${result.reason}`);
	recordRotatedIdentity(s.root, {
		keyId: successor.keyId,
		publicKeySpki: successor.publicKeySpki,
	});
	return successor;
}

export function storeRecords(s: AnchoredSetup): AnchorRecord[] {
	return parseAnchorsContent(readFileSync(s.storeFile, "utf-8")).records;
}

export function storeRaw(s: AnchoredSetup): string {
	return readFileSync(s.storeFile, "utf-8");
}

/**
 * Verify via BOTH packages' glue and assert their verdicts agree — every
 * corpus scenario doubles as a core↔verify differential test (the anchoring
 * extension of the lockstep guarantee). Returns the core result.
 * `external` entries are RAW artifact contents.
 */
export function verify(
	s: AnchoredSetup,
	opts?: Partial<AnchorVerifyParams> & { external?: string[] },
): AnchoredVaultVerificationResult {
	const { external, ...rest } = opts ?? {};
	const params = {
		externalAnchorsRaw: external ?? [storeRaw(s)],
		trust: s.trust,
		witness: { requested: false },
		...rest,
	};
	const core = verifyVaultWithAnchors(s.vaultPath, params);
	const pkg = pkgVerifyVaultWithAnchors(s.vaultPath, params);
	const project = (r: AnchoredVaultVerificationResult): string =>
		JSON.stringify({
			valid: r.valid,
			anchorState: r.anchorState,
			reasons: [...r.anchoring.reasons].sort(),
			warnings: [...r.anchoring.warnings].sort(),
			anchorCount: r.anchoring.anchorCount,
			anchorSource: r.anchoring.anchorSource,
			tail: r.anchoring.unanchoredTail.events,
			chainLength: r.chainLength,
		});
	const coreVerdict = project(core);
	const pkgVerdict = project(pkg as unknown as AnchoredVaultVerificationResult);
	if (coreVerdict !== pkgVerdict) {
		throw new Error(
			`core↔verify anchor verdict divergence:\ncore: ${coreVerdict}\npkg:  ${pkgVerdict}`,
		);
	}
	return core;
}

/** Sign an arbitrary anchor payload with a PEM key (attacker/key-holder sim). */
export function signRecord(payload: Omit<AnchorRecord, "sig">, keyFile: string): AnchorRecord {
	const key = createPrivateKey(readFileSync(keyFile, "utf-8"));
	const sig = cryptoSign(null, Buffer.from(canonicalize(payload), "utf8"), key).toString("base64");
	return { ...payload, sig } as AnchorRecord;
}

export function pubPemFromKeyFile(keyFile: string): string {
	const pub = createPublicKey(createPrivateKey(readFileSync(keyFile, "utf-8")));
	return pub.export({ type: "spki", format: "pem" }) as string;
}

export function computeRoot(s: AnchoredSetup, treeSize: number): string {
	const hashes = gatherOrderedEventHashes(s.vaultPath);
	const { root } = buildMerkleTree(hashes.slice(0, treeSize));
	if (root === undefined) throw new Error("empty tree");
	return root;
}

export function vaultHashes(s: AnchoredSetup): string[] {
	return gatherOrderedEventHashes(s.vaultPath);
}

/** Next-record payload continuing the real chain (for handcrafted attacks). */
export function nextPayload(
	s: AnchoredSetup,
	prev: AnchorRecord,
	over: Partial<Omit<AnchorRecord, "sig">> = {},
): Omit<AnchorRecord, "sig"> {
	const hashes = vaultHashes(s);
	const treeSize = (over.treeSize as number | undefined) ?? hashes.length;
	return {
		v: 1,
		vaultId: prev.vaultId,
		anchorSeq: prev.anchorSeq + 1,
		prevAnchorHash: anchorPayloadHash(prev),
		treeSize,
		lastHash: hashes[treeSize - 1] as string,
		merkleRoot: computeRoot(s, treeSize),
		timestamp: new Date().toISOString(),
		keyId: prev.rotation?.nextKeyId ?? prev.keyId,
		...over,
	} as Omit<AnchorRecord, "sig">;
}

/**
 * THE F1 mutation: change one event's data, then recompute EVERY hash,
 * previousHash link, and the .meta sidecar so the chain is internally
 * consistent again. Invisible to the pre-anchor verifier by construction.
 */
export function mutateAndRechain(s: AnchoredSetup, eventIndex: number): void {
	const logPath = join(s.vaultPath, "audit", "events.jsonl");
	const lines = readFileSync(logPath, "utf-8").trim().split("\n");
	const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
	const target = events[eventIndex] as Record<string, unknown> & { data: Record<string, unknown> };
	target.data = { ...target.data, n: "TAMPERED" };
	let prev = GENESIS_HASH;
	const rechained: string[] = [];
	let lastHash = "";
	for (const e of events) {
		const { hash: _h, ...rest } = e;
		(rest as Record<string, unknown>).previousHash = prev;
		const hash = createHash("sha256").update(canonicalize(rest)).digest("hex");
		rechained.push(canonicalize({ ...rest, hash }));
		prev = hash;
		lastHash = hash;
	}
	writeFileSync(logPath, `${rechained.join("\n")}\n`);
	writeFileSync(`${logPath}.meta`, JSON.stringify({ lastHash, sequence: events.length }));
}

/** Truncate the log to `keep` events and rewrite .meta to match (rollback). */
export function truncateVault(s: AnchoredSetup, keep: number): void {
	const logPath = join(s.vaultPath, "audit", "events.jsonl");
	const lines = readFileSync(logPath, "utf-8").trim().split("\n").slice(0, keep);
	const last = JSON.parse(lines[lines.length - 1] as string) as { hash: string };
	writeFileSync(logPath, `${lines.join("\n")}\n`);
	writeFileSync(`${logPath}.meta`, JSON.stringify({ lastHash: last.hash, sequence: keep }));
}

export function snapshotVault(s: AnchoredSetup): string {
	const snap = tmp("anchor-snap-");
	cpSync(s.vaultPath, join(snap, VAULT_DIR), { recursive: true });
	return snap;
}

export function restoreVault(s: AnchoredSetup, snapRoot: string): void {
	rmSync(s.vaultPath, { recursive: true, force: true });
	cpSync(join(snapRoot, VAULT_DIR), s.vaultPath, { recursive: true });
}
