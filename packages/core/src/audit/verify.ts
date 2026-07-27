// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Audit Chain Verifier
 *
 * Reads a JSONL audit log and verifies:
 * 1. Each event's hash matches the SHA-256 of its canonical representation
 * 2. Each event's previousHash links to the prior event's hash
 * 3. The first event chains from GENESIS_HASH
 * 4. The fsync'd `.meta` head anchor matches the tail (detects truncation /
 *    deletion of an otherwise internally-consistent chain)
 *
 * `verifyVault` extends this across rotated segment files: it parses every
 * `*.jsonl` segment, orders by the persisted global `sequence`, walks ONE
 * continuous chain (GENESIS required only at the global head), and checks the
 * `.meta` tail anchor. This algorithm is mirrored byte-for-byte in the zero-dep
 * `usertrust-verify` package (packages/verify/src/index.ts) — the differential
 * test pins them together.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { GENESIS_HASH } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import {
	type AnchorRecord,
	type AnchorSource,
	type AnchorState,
	type AnchorTrust,
	evaluateAnchoredVault,
	gatherOrderedEventHashes,
	parseAnchorsContent,
	readAnchorMirror,
	type WitnessInput,
	type WitnessStatus,
	worseAnchorState,
} from "./anchor-verify.js";
import { canonicalize } from "./canonical.js";
import { buildMerkleTree } from "./merkle.js";
import { parseRekorReceipt, type RekorVerification, verifyRekorReceipt } from "./rekor-verify.js";

export type { AnchorRecord, AnchorSource, AnchorState, AnchorTrust, WitnessInput };

export interface ChainVerificationResult {
	valid: boolean;
	eventsVerified: number;
	errors: string[];
	skipped: number;
	latestHash: string;
	verifiedAt: string;
}

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

/**
 * Read the `.meta` head anchor sidecar. Fail-closed:
 *  - absent → `null` (unanchored / legacy vault; allowed)
 *  - present but unparseable or missing `lastHash`/`sequence` → `{ corrupt: true }`
 *    (tampering the anchor must NOT silently disable it)
 */
function readAnchor(metaPath: string): Anchor | { corrupt: true } | null {
	if (!existsSync(metaPath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
		if (typeof parsed.lastHash === "string" && typeof parsed.sequence === "number") {
			return { lastHash: parsed.lastHash, sequence: parsed.sequence };
		}
		return { corrupt: true };
	} catch {
		return { corrupt: true };
	}
}

export function verifyChain(logPath: string): ChainVerificationResult {
	const errors: string[] = [];

	const anchorRaw = readAnchor(`${logPath}.meta`);
	let anchor: Anchor | null = null;
	if (anchorRaw !== null) {
		if ("corrupt" in anchorRaw) {
			errors.push("Audit anchor (.meta) present but corrupt");
		} else {
			anchor = anchorRaw;
		}
	}

	const content = existsSync(logPath) ? readFileSync(logPath, "utf-8").trim() : "";
	if (content === "") {
		if (anchor && anchor.sequence > 0) {
			errors.push(`Audit log missing/empty but anchor records ${anchor.sequence} event(s)`);
		}
		return {
			valid: errors.length === 0,
			eventsVerified: 0,
			errors,
			skipped: 0,
			latestHash: GENESIS_HASH,
			verifiedAt: new Date().toISOString(),
		};
	}

	const lines = content.split("\n").filter((l) => l.trim());
	let expectedPreviousHash = GENESIS_HASH;
	let latestHash = GENESIS_HASH;
	let skipped = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;

		let event: AuditEvent;
		try {
			event = JSON.parse(line) as AuditEvent;
		} catch (_parseErr) {
			errors.push(
				JSON.stringify({
					line: i + 1,
					error: "malformed JSON",
					raw: line.substring(0, 100),
				}),
			);
			// Do NOT reset expectedPreviousHash — skip the corrupt line
			// so subsequent intact events can still verify against the chain
			skipped++;
			continue;
		}

		if (event.previousHash !== expectedPreviousHash) {
			errors.push(
				`Event ${i + 1} (${event.id}): previousHash mismatch. ` +
					`Expected ${expectedPreviousHash}, got ${event.previousHash}`,
			);
		}

		const { hash: storedHash, ...eventWithoutHash } = event;
		const canonical = canonicalize(eventWithoutHash);
		const computedHash = createHash("sha256").update(canonical).digest("hex");

		if (storedHash !== computedHash) {
			errors.push(
				`Event ${i + 1} (${event.id}): hash mismatch. ` +
					`Expected ${computedHash}, got ${storedHash}`,
			);
		}

		expectedPreviousHash = storedHash;
		latestHash = storedHash;
	}

	if (anchor) {
		if (latestHash !== anchor.lastHash) {
			errors.push(
				`anchor mismatch: expected last hash ${anchor.lastHash}, got ${latestHash} (tail truncation)`,
			);
		}
		if (lines.length !== anchor.sequence) {
			errors.push(
				`anchor mismatch: expected ${anchor.sequence} event(s), found ${lines.length} (truncation/deletion)`,
			);
		}
	}

	return {
		valid: errors.length === 0,
		eventsVerified: lines.length,
		errors,
		skipped,
		latestHash,
		verifiedAt: new Date().toISOString(),
	};
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
 * Gathers `events.jsonl` plus every rotated `*.jsonl` segment, orders all events
 * by the persisted global `sequence`, walks a single continuous chain (GENESIS
 * required only at the global head), enforces sequence continuity (so whole-
 * segment deletion surfaces as a sequence gap rather than an indistinguishable
 * "previousHash mismatch"), and checks the `.meta` tail anchor.
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

// ── Anchored Vault Verification (spec §7) ──

export interface AnchorVerifyParams {
	/** Raw contents of caller-fetched anchor artifacts (single JSON or JSONL). */
	readonly externalAnchorsRaw?: readonly string[] | undefined;
	/** Raw transparency-log receipts: one receipt JSON, or JSONL of receipts. */
	readonly rekorReceiptsRaw?: readonly string[] | undefined;
	/**
	 * Caller-pinned transparency-log keys. Supplying none is only meaningful for
	 * the one log whose key ships with the verifier (rekor.sigstore.dev); any
	 * other log without a pin is refused rather than trusted.
	 */
	readonly rekorLogPubkeysPem?: readonly string[] | undefined;
	/** Caller-pinned trust material — NEVER read from the vault under audit. */
	readonly trust?: AnchorTrust | undefined;
	readonly witness?: WitnessInput | undefined;
	readonly maxAnchorAgeMs?: number | undefined;
	readonly maxUnanchoredEvents?: number | undefined;
	readonly expectedVaultId?: string | undefined;
	readonly nowMs?: number | undefined;
}

export interface RekorReport {
	receiptsVerified: number;
	receiptsFailed: number;
	/** Max attested time among verified receipts of the NEWEST anchor (ms). */
	latestAttestedTimeMs: number | null;
	errors: string[];
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
	/** Present only when transparency-log receipts were supplied. */
	rekor?: RekorReport;
}

export interface AnchoredVaultVerificationResult extends VaultVerificationResult {
	anchorState: AnchorState;
	anchoring: AnchoringReport;
}

/**
 * Split one raw receipt artifact into receipt documents. A file may hold a
 * single (possibly pretty-printed) receipt or JSONL of many, so the whole-file
 * parse is tried first and line-splitting is the fallback — the reverse would
 * shred a pretty-printed receipt into unparseable fragments.
 *
 * IDENTICAL in packages/core/src/audit/verify.ts.
 */
function splitReceiptDocuments(raw: string): string[] {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return [];
	try {
		JSON.parse(trimmed);
		return [trimmed];
	} catch {
		return trimmed
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}
}

/**
 * Verify every supplied transparency-log receipt against the anchor record it
 * names. Receipts are OPTIONAL evidence, but supplied evidence is not
 * advisory: a receipt is only ever presented to strengthen a claim, so one
 * that does not verify fails the vault closed rather than being dropped.
 *
 * Records are matched by anchorSeq with the external copy governing (the same
 * precedence the evaluator's merge uses). A receipt may bind to ANY record at
 * its anchorSeq: committed-equal twins differ in exactly the timestamp and
 * signature a receipt commits to, so the emitter's published twin must not
 * depend on which copy the auditor happened to fetch first.
 *
 * IDENTICAL in packages/core/src/audit/verify.ts.
 */
function verifySuppliedRekorReceipts(
	receiptsRaw: readonly string[],
	externalRecords: readonly AnchorRecord[],
	mirrorRecords: readonly AnchorRecord[],
	logPubkeysPem: readonly string[],
): RekorReport | null {
	if (receiptsRaw.length === 0) return null;
	const bySeq = new Map<number, AnchorRecord[]>();
	for (const record of [...externalRecords, ...mirrorRecords]) {
		const twins = bySeq.get(record.anchorSeq);
		if (twins === undefined) {
			bySeq.set(record.anchorSeq, [record]);
		} else {
			twins.push(record);
		}
	}
	// The NEWEST anchor by the evaluator's own rule (largest treeSize, earliest
	// anchorSeq on a tie) — only its receipts may speak for freshness.
	const merged = [...bySeq.keys()]
		.sort((a, b) => a - b)
		.map((seq) => (bySeq.get(seq) as AnchorRecord[])[0] as AnchorRecord);
	const latestSeq = [...merged].sort((a, b) => b.treeSize - a.treeSize)[0]?.anchorSeq ?? null;

	const errors: string[] = [];
	let receiptsVerified = 0;
	let receiptsFailed = 0;
	let latestAttestedTimeMs: number | null = null;
	for (const raw of receiptsRaw) {
		for (const document of splitReceiptDocuments(raw)) {
			const parsed = parseRekorReceipt(document);
			if (parsed.receipt === null) {
				receiptsFailed++;
				errors.push(parsed.error as string);
				continue;
			}
			const receipt = parsed.receipt;
			const candidates = bySeq.get(receipt.anchorSeq) ?? [];
			if (candidates.length === 0) {
				receiptsFailed++;
				errors.push(`rekor-receipt-invalid: receipt for unknown anchorSeq ${receipt.anchorSeq}`);
				continue;
			}
			let verified: RekorVerification | null = null;
			let firstErrors: string[] = [];
			for (const candidate of candidates) {
				const result = verifyRekorReceipt(receipt, candidate, logPubkeysPem);
				if (result.ok) {
					verified = result;
					break;
				}
				if (firstErrors.length === 0) firstErrors = result.errors;
			}
			if (verified === null) {
				receiptsFailed++;
				errors.push(...firstErrors);
				continue;
			}
			receiptsVerified++;
			if (receipt.anchorSeq === latestSeq && verified.attestedTimeMs !== null) {
				latestAttestedTimeMs =
					latestAttestedTimeMs === null
						? verified.attestedTimeMs
						: Math.max(latestAttestedTimeMs, verified.attestedTimeMs);
			}
		}
	}
	return { receiptsVerified, receiptsFailed, latestAttestedTimeMs, errors };
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
	const rekor = verifySuppliedRekorReceipts(
		params.rekorReceiptsRaw ?? [],
		externalRecords,
		mirror.records,
		params.rekorLogPubkeysPem ?? [],
	);
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
			...(rekor !== null && rekor.latestAttestedTimeMs !== null
				? { attestedTimeMs: rekor.latestAttestedTimeMs }
				: {}),
		},
	});
	// A broken receipt is ANCHOR_INVALID (fail-closed), escalated by the state
	// machine's own severity ordering so MISMATCH still outranks it.
	const rekorFailed = rekor !== null && rekor.receiptsFailed > 0;
	return {
		...base,
		valid: base.valid && evaluation.anchorsValid && !rekorFailed,
		errors: [...base.errors, ...evaluation.errors, ...(rekor?.errors ?? [])],
		anchorState: rekorFailed
			? worseAnchorState(evaluation.anchorState, "ANCHOR_INVALID")
			: evaluation.anchorState,
		anchoring: {
			anchorSource: evaluation.anchorSource,
			anchorCount: evaluation.anchorCount,
			latestAnchor: evaluation.latestAnchor,
			unanchoredTail: evaluation.unanchoredTail,
			witness: evaluation.witness,
			reasons: rekorFailed
				? [...new Set([...evaluation.reasons, "rekor-receipt-invalid"])]
				: evaluation.reasons,
			warnings: evaluation.warnings,
			...(rekor !== null ? { rekor } : {}),
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
