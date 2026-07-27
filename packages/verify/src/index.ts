// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// usertrust-verify — Standalone Audit Verification (zero dependencies)

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
	type AnchorRecord,
	type AnchorSource,
	type AnchorState,
	type AnchorTrust,
	type WitnessInput,
	type WitnessStatus,
	dedupeAnchorSet,
	evaluateAnchoredVault,
	gatherOrderedEventHashes,
	parseAnchorsContent,
	publicKeyFromSpkiBase64,
	readAnchorMirror,
	verifyInclusionAgainstAnchor,
} from "./anchor-verify.js";
import { canonicalize } from "./canonical.js";
import { GENESIS_HASH } from "./constants.js";
import {
	type ReceiptData,
	type TransactionEvent,
	renderNotFound,
	renderReceipt,
} from "./receipt.js";
import {
	buildMerkleTree,
	generateInclusionProof,
	readAnchor,
	verifyChain,
	verifyInclusionProof,
} from "./verify.js";

export { canonicalize } from "./canonical.js";
export { GENESIS_HASH } from "./constants.js";
export {
	type ReceiptData,
	type TransactionEvent,
	renderReceipt,
	renderNotFound,
} from "./receipt.js";
export {
	verifyChain,
	buildMerkleTree,
	hashLeaf,
	hashInternal,
	generateInclusionProof,
	verifyInclusionProof,
	generateConsistencyProof,
	verifyConsistencyProof,
	type ChainVerificationResult,
	type MerkleSibling,
	type MerkleInclusionProof,
	type MerkleConsistencyProof,
} from "./verify.js";
export {
	type AnchorChainResult,
	type AnchorEvaluation,
	type AnchorEvaluationInput,
	type AnchorEvaluationOptions,
	type AnchorRecord,
	type AnchorRotation,
	type AnchorSource,
	type AnchorState,
	type AnchorTrust,
	type WitnessInput,
	type WitnessStatus,
	anchorPayloadHash,
	anchorSigningPreimage,
	committedFieldsEqual,
	dedupeAnchorSet,
	evaluateAnchoredVault,
	gatherOrderedEventHashes,
	keyIdFromKeyObject,
	keyIdFromSpkiDer,
	parseAnchorRecord,
	parseAnchorsContent,
	publicKeyFromPem,
	publicKeyFromSpkiBase64,
	readAnchorMirror,
	verifyAnchorChain,
	verifyAnchorSignature,
	verifyInclusionAgainstAnchor,
	verifySignatureRaw,
} from "./anchor-verify.js";

// ── Vault Verification ──

export interface VaultVerificationResult {
	valid: boolean;
	errors: string[];
	chainLength: number;
	validHashes: number;
	merkleRoot: string | null;
	firstEvent: string | null;
	lastEvent: string | null;
}

interface Anchor {
	lastHash: string;
	sequence: number;
}

interface ParsedEvent {
	id: string;
	hash: string;
	previousHash: string;
	sequence?: number | undefined;
	timestamp?: string | undefined;
	parsed: Record<string, unknown>;
	sourceFile: string;
	line: number;
}

/**
 * Verify an entire `.usertrust` vault directory, anchored to the `.meta` head.
 *
 * BYTE-IDENTICAL to the core implementation (packages/core/src/audit/verify.ts):
 * gathers `events.jsonl` plus every rotated `*.jsonl` segment, orders all events
 * by the persisted global `sequence`, walks a single continuous chain (GENESIS
 * required only at the global head), enforces sequence continuity (so whole-
 * segment deletion surfaces as a sequence gap, not an indistinguishable
 * "previousHash mismatch"), and checks the `.meta` tail anchor. The differential
 * test pins the two implementations together.
 */
export function verifyVault(vaultPath: string): VaultVerificationResult {
	const auditDir = join(vaultPath, "audit");
	const errors: string[] = [];

	// 1-2. Gather segment files: events.jsonl first, then every other *.jsonl.
	const segmentFiles: string[] = [];
	const mainLog = join(auditDir, "events.jsonl");
	if (existsSync(mainLog)) {
		segmentFiles.push(mainLog);
	}
	if (existsSync(auditDir)) {
		try {
			for (const entry of readdirSync(auditDir).sort()) {
				if (entry.endsWith(".jsonl") && entry !== "events.jsonl") {
					segmentFiles.push(join(auditDir, entry));
				}
			}
		} catch {
			// Directory read failure — non-fatal
		}
	}

	// 3. Read the head anchor, fail-closed.
	const anchorRaw = readAnchor(`${mainLog}.meta`);
	let anchor: Anchor | null = null;
	if (anchorRaw !== null) {
		if ("corrupt" in anchorRaw) {
			errors.push("Audit anchor (.meta) present but corrupt");
		} else {
			anchor = anchorRaw;
		}
	}

	// 4. No segment files.
	if (segmentFiles.length === 0) {
		if (!existsSync(auditDir)) {
			errors.push(`Audit directory not found: ${auditDir}`);
		}
		if (anchor && anchor.sequence > 0) {
			errors.push(
				`Audit log missing but anchor records ${anchor.sequence} event(s) (deletion detected)`,
			);
		}
		return {
			valid: errors.length === 0,
			errors,
			chainLength: 0,
			validHashes: 0,
			merkleRoot: null,
			firstEvent: null,
			lastEvent: null,
		};
	}

	// 5. Parse every line of every segment.
	const events: ParsedEvent[] = [];
	for (const segmentFile of segmentFiles) {
		let content: string;
		try {
			content = readFileSync(segmentFile, "utf-8").trim();
		} catch {
			// Unreadable segment (e.g. broken symlink) — skip.
			continue;
		}
		if (content === "") continue;
		const lines = content.split("\n").filter((l) => l.trim());
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i] as string;
			try {
				const parsed = JSON.parse(raw) as Record<string, unknown>;
				events.push({
					id: typeof parsed.id === "string" ? parsed.id : "",
					hash: typeof parsed.hash === "string" ? parsed.hash : "",
					previousHash: typeof parsed.previousHash === "string" ? parsed.previousHash : "",
					sequence: typeof parsed.sequence === "number" ? parsed.sequence : undefined,
					timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
					parsed,
					sourceFile: segmentFile,
					line: i + 1,
				});
			} catch {
				errors.push(`malformed JSON (${basename(segmentFile)}:${i + 1})`);
			}
		}
	}

	// 6. Order by the persisted global sequence when available (legacy fallback:
	// file order, for hand-built sequence-less single-segment fixtures).
	const allHaveSeq = events.every((e) => typeof e.sequence === "number");
	const ordered = allHaveSeq
		? [...events].sort((a, b) => (a.sequence as number) - (b.sequence as number))
		: events;

	// 7. One continuous continuity walk.
	let expectedPrev = GENESIS_HASH;
	let validHashes = 0;
	let firstEvent: string | null = null;
	let lastEvent: string | null = null;
	for (let i = 0; i < ordered.length; i++) {
		const e = ordered[i] as ParsedEvent;

		if (e.previousHash !== expectedPrev) {
			errors.push(
				`Event ${i + 1} (${e.id}): previousHash mismatch. Expected ${expectedPrev}, got ${e.previousHash}`,
			);
		}

		if (allHaveSeq && i === 0 && e.sequence !== 1) {
			errors.push(`Sequence starts at ${e.sequence}, expected 1 (leading events deleted)`);
		}
		if (allHaveSeq && i > 0) {
			const prevSeq = (ordered[i - 1] as ParsedEvent).sequence as number;
			if (e.sequence !== prevSeq + 1) {
				errors.push(
					`Sequence gap: event ${e.sequence} follows ${prevSeq} (segment/event deletion)`,
				);
			}
		}

		const { hash: _storedHash, ...rest } = e.parsed;
		const computed = createHash("sha256").update(canonicalize(rest)).digest("hex");
		if (e.hash !== computed) {
			errors.push(`Event ${i + 1} (${e.id}): hash mismatch. Expected ${computed}, got ${e.hash}`);
		} else {
			validHashes++;
		}

		if (e.timestamp) {
			if (firstEvent === null) firstEvent = e.timestamp;
			lastEvent = e.timestamp;
		}

		expectedPrev = e.hash;
	}

	// 8. Tail anchor (only when the anchor is present and well-formed).
	if (anchor) {
		const last = ordered.at(-1);
		if (last && last.hash !== anchor.lastHash) {
			errors.push(
				`anchor mismatch: expected last hash ${anchor.lastHash}, got ${last.hash} (tail truncation)`,
			);
		}
		if (ordered.length !== anchor.sequence) {
			errors.push(
				`anchor mismatch: expected ${anchor.sequence} event(s), found ${ordered.length} (truncation/deletion)`,
			);
		}
	}

	// 9. Merkle root over the ordered event hashes (informational).
	let merkleRoot: string | null = null;
	if (ordered.length > 0) {
		const tree = buildMerkleTree(ordered.map((e) => e.hash));
		merkleRoot = tree.root ?? null;
	}

	// 10.
	return {
		valid: errors.length === 0,
		errors,
		chainLength: events.length,
		validHashes,
		merkleRoot,
		firstEvent,
		lastEvent,
	};
}

/**
 * Pure vault-mode verdict → process exit-code mapping (0 = VERIFIED, 1 = FAILED).
 * Extracted so the CLI's exit behavior is unit-testable without spawning a build.
 */
export function exitCodeFor(result: { valid: boolean }): number {
	return result.valid ? 0 : 1;
}

// ── Anchored Vault Verification (spec §7) ──

export interface AnchorVerifyParams {
	/** Raw contents of caller-fetched anchor artifacts (single JSON or JSONL). */
	readonly externalAnchorsRaw?: readonly string[] | undefined;
	/** Caller-pinned trust material — NEVER read from the vault under audit. */
	readonly trust?: AnchorTrust | undefined;
	readonly witness?: WitnessInput | undefined;
	readonly maxAnchorAgeMs?: number | undefined;
	readonly maxUnanchoredEvents?: number | undefined;
	readonly expectedVaultId?: string | undefined;
	readonly nowMs?: number | undefined;
}

export interface AnchoringReport {
	anchorSource: AnchorSource;
	anchorCount: number;
	latestAnchor: {
		anchorSeq: number;
		treeSize: number;
		lastHash: string;
		keyId: string;
		timestamp: string;
	} | null;
	unanchoredTail: { events: number; sinceTimestampMs: number | null };
	witness: { requested: boolean; status: WitnessStatus; error?: string };
	reasons: string[];
	warnings: string[];
}

export interface AnchoredVaultVerificationResult extends VaultVerificationResult {
	anchorState: AnchorState;
	anchoring: AnchoringReport;
}

/**
 * verifyVault + the spec §7.2 anchor state machine. Existing chain semantics
 * are UNCHANGED (verifyVault runs as-is); anchor evaluation is layered on
 * top additively. IDENTICAL function body in packages/core/src/audit/verify.ts
 * — the anchor differential test pins the two.
 */
export function verifyVaultWithAnchors(
	vaultPath: string,
	params: AnchorVerifyParams = {},
): AnchoredVaultVerificationResult {
	const base = verifyVault(vaultPath);
	const externalRecords: AnchorRecord[] = [];
	const externalErrors: string[] = [];
	for (const raw of params.externalAnchorsRaw ?? []) {
		const parsed = parseAnchorsContent(raw);
		externalRecords.push(...parsed.records);
		externalErrors.push(...parsed.errors);
	}
	const mirror = readAnchorMirror(vaultPath);
	const evaluation = evaluateAnchoredVault({
		orderedHashes: gatherOrderedEventHashes(vaultPath),
		externalAnchors: externalRecords,
		externalErrors,
		mirrorAnchors: mirror.records,
		mirrorErrors: mirror.errors,
		trust: params.trust ?? null,
		witness: params.witness ?? { requested: false },
		opts: {
			...(params.maxAnchorAgeMs !== undefined ? { maxAnchorAgeMs: params.maxAnchorAgeMs } : {}),
			...(params.maxUnanchoredEvents !== undefined
				? { maxUnanchoredEvents: params.maxUnanchoredEvents }
				: {}),
			...(params.expectedVaultId !== undefined ? { expectedVaultId: params.expectedVaultId } : {}),
			...(params.nowMs !== undefined ? { nowMs: params.nowMs } : {}),
		},
	});
	return {
		...base,
		valid: base.valid && evaluation.anchorsValid,
		errors: [...base.errors, ...evaluation.errors],
		anchorState: evaluation.anchorState,
		anchoring: {
			anchorSource: evaluation.anchorSource,
			anchorCount: evaluation.anchorCount,
			latestAnchor: evaluation.latestAnchor,
			unanchoredTail: evaluation.unanchoredTail,
			witness: evaluation.witness,
			reasons: evaluation.reasons,
			warnings: evaluation.warnings,
		},
	};
}

/**
 * Exit-code policy for anchored verification. Exit codes stay 0/1
 * (constraints §4.3); `--require-anchor` and `--require-external-anchor` are
 * new INPUTS, not changed defaults.
 */
export function exitCodeForAnchored(
	result: {
		valid: boolean;
		anchorState: AnchorState;
		anchoring: { anchorSource: AnchorSource };
	},
	opts?: { requireAnchor?: boolean; requireExternalAnchor?: boolean },
): number {
	if (!result.valid) return 1;
	if (
		opts?.requireAnchor === true &&
		(result.anchorState === "UNANCHORED" ||
			result.anchorState === "ANCHOR_UNVERIFIABLE" ||
			result.anchorState === "ANCHOR_STALE")
	) {
		return 1;
	}
	if (
		opts?.requireExternalAnchor === true &&
		(result.anchorState !== "ANCHORED_VERIFIED" || result.anchoring.anchorSource !== "external")
	) {
		return 1;
	}
	return 0;
}

// ── Single Transaction Verification ──

export interface TransactionVerificationResult {
	readonly found: boolean;
	readonly valid: boolean;
	readonly receipt: string;
	readonly errors: string[];
	/** Present when anchor inputs were supplied: the §7.2 vault-level state,
	 * so CLI strict gates (--require-anchor / --require-external-anchor) can
	 * be enforced in --tx mode too. */
	readonly anchorState?: AnchorState | undefined;
	readonly anchoring?: AnchoringReport | undefined;
}

/**
 * Verify a single transaction and return a formatted receipt.
 *
 * Finds the event matching `txId` (by `data.transferId`) and verifies the
 * hash chain. WITHOUT anchor inputs the receipt claims chain consistency
 * only — the historical self-referential inclusion check (proof verified
 * against a root recomputed from the same events, F1) is retired (AC-5.2).
 * WITH anchor inputs the §7.2 state machine runs over the whole vault first
 * (AC-5.4) and inclusion is proven against the SIGNED EXTERNAL anchor root.
 */
export function verifyTransaction(
	vaultPath: string,
	txId: string,
	anchorParams?: AnchorVerifyParams,
): TransactionVerificationResult {
	const auditDir = join(vaultPath, "audit");
	const mainLog = join(auditDir, "events.jsonl");

	if (!existsSync(mainLog)) {
		return {
			found: false,
			valid: false,
			receipt: renderNotFound(txId),
			errors: [`Audit log not found: ${mainLog}`],
		};
	}

	const content = readFileSync(mainLog, "utf-8").trim();
	if (!content) {
		return {
			found: false,
			valid: false,
			receipt: renderNotFound(txId),
			errors: ["Audit log is empty"],
		};
	}

	const lines = content.split("\n").filter((l) => l.trim());
	const events: TransactionEvent[] = [];
	const parseErrors: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		try {
			events.push(JSON.parse(lines[i] as string) as TransactionEvent);
		} catch {
			parseErrors.push(`Event ${i + 1}: malformed JSON`);
		}
	}

	// Find the target event
	const targetEvent = events.find((e) => e.data.transferId === txId);

	if (targetEvent === undefined) {
		return {
			found: false,
			valid: false,
			receipt: renderNotFound(txId),
			errors: [],
		};
	}

	// Verify the full chain
	const chainResult = verifyChain(mainLog);
	const chainVerified = chainResult.valid;

	// Merkle root over the stored hashes — informational display only. The
	// self-referential inclusion check (F1: proof AND root computed from the
	// same allHashes) is retired; inclusion is only ever claimed against a
	// verified EXTERNAL anchor root below (AC-5.2).
	const allHashes = events.map((e) => e.hash);
	const tree = buildMerkleTree(allHashes);
	let merkleRoot = tree.root ?? "";
	const leafIndex = events.indexOf(targetEvent);

	let merkleVerified: boolean;
	let merkleLabel: string;
	let anchorsValid = true;
	let anchorState: AnchorState | undefined;
	let anchoring: AnchoringReport | undefined;
	const anchorErrors: string[] = [];

	if (anchorParams === undefined) {
		merkleVerified = chainVerified;
		merkleLabel = chainVerified ? "CHAIN CONSISTENT (UNANCHORED)" : "CHAIN INCONSISTENT";
	} else {
		// AC-5.4: the anchor state machine runs over the WHOLE vault first —
		// an ANCHOR_INVALID / ANCHOR_MISMATCH vault must never render
		// "INCLUSION VERIFIED", whatever the single-event proof says.
		const vaultResult = verifyVaultWithAnchors(vaultPath, anchorParams);
		anchorsValid = vaultResult.valid;
		anchorState = vaultResult.anchorState;
		anchoring = vaultResult.anchoring;
		anchorErrors.push(...vaultResult.anchoring.reasons.map((r) => `anchor: ${r}`));
		const state = vaultResult.anchorState;
		if (state === "ANCHORED_VERIFIED" || state === "ANCHOR_STALE") {
			const orderedHashes = gatherOrderedEventHashes(vaultPath);
			const pos = typeof targetEvent.sequence === "number" ? targetEvent.sequence : leafIndex + 1;
			const candidates: AnchorRecord[] = [];
			for (const raw of anchorParams.externalAnchorsRaw ?? []) {
				candidates.push(...parseAnchorsContent(raw).records);
			}
			candidates.push(...readAnchorMirror(vaultPath).records);
			const uniqueAnchors = dedupeAnchorSet(candidates).unique;
			const covering = uniqueAnchors
				.filter((r) => r.treeSize >= pos)
				.sort((a, b) => a.treeSize - b.treeSize)[0];
			if (covering === undefined) {
				// Honest tail label — never "verified" for unanchored events.
				merkleVerified = chainVerified;
				merkleLabel = "IN UNANCHORED TAIL";
			} else if (
				anchorParams.trust !== undefined &&
				pos >= 1 &&
				covering.treeSize <= orderedHashes.length
			) {
				const proof = generateInclusionProof(
					pos - 1,
					orderedHashes.slice(0, covering.treeSize),
					"events.jsonl",
				);
				// §7.1: resolve the covering record's epoch key the way the chain
				// walk does — root + caller pins + in-chain rotation successors.
				// This branch is gated on ANCHORED_VERIFIED/ANCHOR_STALE, so every
				// rotation here was already validated; a forged rotation never
				// reaches this point. Without this, a post-rotation-covered event
				// falsely reports INCLUSION FAILED (the state machine accepted it).
				const inChainSuccessorPems = uniqueAnchors.flatMap((r) => {
					if (r.rotation === undefined) return [];
					const k = publicKeyFromSpkiBase64(r.rotation.nextPublicKeySpki);
					return k === null ? [] : [k.export({ type: "spki", format: "pem" }) as string];
				});
				const ok = verifyInclusionAgainstAnchor(proof, covering, {
					...anchorParams.trust,
					successorPinsPem: [
						...(anchorParams.trust.successorPinsPem ?? []),
						...inChainSuccessorPems,
					],
				});
				merkleVerified = ok;
				merkleRoot = covering.merkleRoot;
				merkleLabel = ok
					? `INCLUSION VERIFIED (anchor #${covering.anchorSeq})`
					: "INCLUSION FAILED (anchored root)";
			} else {
				merkleVerified = false;
				merkleLabel = "INCLUSION UNVERIFIABLE";
			}
		} else if (state === "UNANCHORED") {
			merkleVerified = chainVerified;
			merkleLabel = chainVerified ? "CHAIN CONSISTENT (UNANCHORED)" : "CHAIN INCONSISTENT";
		} else if (state === "ANCHOR_UNVERIFIABLE") {
			merkleVerified = chainVerified;
			merkleLabel = "INCLUSION UNVERIFIABLE";
		} else {
			merkleVerified = false;
			merkleLabel = "INCLUSION UNVERIFIABLE";
		}
	}

	// Compute cumulative spend up to and including this event
	let cumulativeSpend = 0;
	for (const evt of events) {
		if (evt.data.cost !== undefined && evt.kind === "llm_call") {
			cumulativeSpend += evt.data.cost;
		}
		if (evt === targetEvent) break;
	}

	const receiptData: ReceiptData = {
		event: targetEvent,
		chainLength: events.length,
		merkleRoot,
		merkleVerified,
		chainVerified,
		cumulativeSpend,
		verifiedAt: new Date(),
		merkleLabel,
	};

	const allErrors = [...parseErrors, ...chainResult.errors, ...anchorErrors];

	return {
		found: true,
		valid: chainVerified && merkleVerified && anchorsValid,
		receipt: renderReceipt(receiptData),
		errors: allErrors,
		...(anchorState !== undefined ? { anchorState } : {}),
		...(anchoring !== undefined ? { anchoring } : {}),
	};
}
