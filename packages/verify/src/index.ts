// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// usertrust-verify — Standalone Audit Verification (zero dependencies)

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	type AnchorRecord,
	type AnchorSource,
	type AnchorState,
	type AnchorTrust,
	dedupeAnchorSet,
	evaluateAnchoredVault,
	gatherOrderedEventHashes,
	parseAnchorsContent,
	publicKeyFromSpkiBase64,
	readAnchorMirror,
	verifyInclusionAgainstAnchor,
	type WitnessInput,
	type WitnessStatus,
	worseAnchorState,
} from "./anchor-verify.js";
import { canonicalize } from "./canonical.js";
import { GENESIS_HASH } from "./constants.js";
import {
	type ReceiptData,
	renderNotFound,
	renderReceipt,
	type TransactionEvent,
} from "./receipt.js";
import { parseRekorReceipt, type RekorVerification, verifyRekorReceipt } from "./rekor-verify.js";
import {
	buildMerkleTree,
	generateInclusionProof,
	readAnchor,
	verifyChain,
	verifyInclusionProof,
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
	type WitnessInput,
	type WitnessStatus,
	worseAnchorState,
} from "./anchor-verify.js";
export { canonicalize } from "./canonical.js";
export { GENESIS_HASH } from "./constants.js";
export {
	type ReceiptData,
	renderNotFound,
	renderReceipt,
	type TransactionEvent,
} from "./receipt.js";
export {
	parseRekorReceipt,
	parseSignedNote,
	REKOR_PROD_PUBKEY_PEM,
	type RekorReceipt,
	type RekorVerification,
	type SignedNote,
	verifyIndexInclusion,
	verifyRekorReceipt,
} from "./rekor-verify.js";
export {
	buildMerkleTree,
	type ChainVerificationResult,
	generateConsistencyProof,
	generateInclusionProof,
	hashInternal,
	hashLeaf,
	type MerkleConsistencyProof,
	type MerkleInclusionProof,
	type MerkleSibling,
	verifyChain,
	verifyConsistencyProof,
	verifyInclusionProof,
} from "./verify.js";

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
 * Scrub control characters out of a value on its way into an error string.
 *
 * These errors are printed by the non-JSON CLI, so an escape sequence inside one
 * can repaint the verdict line it appears on. Substitutes rather than deletes, so
 * a scrubbed byte stays visible as evidence.
 */
function scrubForError(raw: string): string {
	let out = "";
	for (const ch of raw) {
		const code = ch.codePointAt(0) as number;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "?" : ch;
	}
	return out;
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
		} catch (err) {
			// NOT "non-fatal". Mirrors `packages/core/src/audit/verify.ts` verbatim
			// per the parity requirement in AGENTS.md. A directory that exists but
			// cannot be enumerated is a vault we did not read, and swallowing that
			// produced the worst possible answer: with `events.jsonl` also absent or
			// unreadable, `segmentFiles` stayed empty, the branch below found the
			// directory present so pushed no error, and verification returned
			// `valid: true, chainLength: 0` — a clean bill of health, exit 0, on a
			// vault nobody could open. Fixing only the core copy would have left the
			// STANDALONE verifier — the one an auditor is told to trust instead of
			// us — still answering valid.
			// SCRUBBED. Both halves are attacker-influenced: `auditDir` comes from a
			// caller-supplied path and `err.message` embeds it. The non-JSON CLI
			// prints this string, so an escape sequence in either could repaint the
			// very FAILED verdict this error exists to produce — the terminal-forgery
			// surface AGENTS.md already names for every other value on that output.
			errors.push(
				scrubForError(
					`Audit directory could not be enumerated: ${auditDir} (${err instanceof Error ? err.message : String(err)})`,
				),
			);
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
		const documents = splitReceiptDocuments(raw);
		if (documents.length === 0) {
			// A receipts artifact that holds no receipts is a supply failure, not an
			// absence of evidence: the caller passed --rekor-receipts, so an empty
			// file means the receipt they meant to present never made it here.
			receiptsFailed++;
			errors.push("rekor-receipt-invalid: receipts artifact contained no receipts");
			continue;
		}
		for (const document of documents) {
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
 * Coerce one parsed JSONL record into a GUARANTEED-shape `TransactionEvent`.
 *
 * `events.jsonl` is written by the party under audit, so `JSON.parse(...) as
 * TransactionEvent` was a promise the data never made. Every consumer
 * downstream then trusted it: `kind.endsWith(...)`, `data.transferId`,
 * `data.cost`, and the renderer's `forDisplay` over `message`/`error` each
 * dereference or iterate a value that a valid-JSON record can set to `null`, a
 * number, or an object — turning a verification that should return a VERDICT
 * into an uncaught throw.
 *
 * That mattered more after terminal ranking landed, because the old first-match
 * lookup stopped AT the target and the ranking scan walks past it — so a
 * malformed record appended to the tail could break verification of an EARLIER
 * transaction. But guarding each use site is the wrong shape of fix: it is one
 * guard per consumer, and the three found by review were three consumers, not
 * three bugs. Normalizing once at the boundary makes the type honest instead,
 * so nothing downstream needs to re-check.
 *
 * Wrong-typed values become absent rather than throwing or being coerced to a
 * plausible-looking default: a `cost` of `"12"` is not a cost, and rendering it
 * as one would be a different lie than crashing.
 *
 * Unknown keys are PRESERVED — this narrows the fields the verifier reads, and
 * is not a schema that silently drops a field a future producer adds.
 */
function normalizeEvent(raw: unknown): TransactionEvent {
	const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
	const num = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) ? v : undefined;

	const o: Record<string, unknown> =
		raw !== null && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};
	const d: Record<string, unknown> =
		o.data !== null && typeof o.data === "object" && !Array.isArray(o.data)
			? (o.data as Record<string, unknown>)
			: {};

	const model = str(d.model);
	const cost = num(d.cost);
	const error = str(d.error);
	const message = str(d.message);

	return {
		id: str(o.id) ?? "",
		timestamp: str(o.timestamp) ?? "",
		previousHash: str(o.previousHash) ?? "",
		kind: str(o.kind) ?? "",
		actor: str(o.actor) ?? "",
		data: {
			...d,
			...(model !== undefined ? { model } : { model: undefined }),
			...(cost !== undefined ? { cost } : { cost: undefined }),
			...(typeof d.settled === "boolean" ? { settled: d.settled } : { settled: undefined }),
			...(error !== undefined ? { error } : { error: undefined }),
			...(message !== undefined ? { message } : { message: undefined }),
			// PRESERVED for the same reason, and a sharper one: defaulting to ""
			// mapped every event WITHOUT a transferId onto the same empty id, so
			// `--tx ""` (an unset shell variable) matched them and returned
			// found/valid with exit 0 for a transaction that does not exist. A
			// false OK, manufactured by the normalizer meant to prevent them.
			...(str(d.transferId) !== undefined ? { transferId: str(d.transferId) } : {}),
		} as TransactionEvent["data"],
		// PRESERVED, not defaulted. A legacy segment may legitimately carry no
		// `sequence` (the v1 event schema allows it), and inventing 0 killed the
		// `leafIndex + 1` fallback downstream: `pos` became 0, failed `pos >= 1`,
		// and an otherwise covered event was marked INCLUSION UNVERIFIABLE. A
		// default that looks like data is worse than an absence that reads as one.
		...(num(o.sequence) !== undefined ? { sequence: num(o.sequence) } : {}),
		hash: str(o.hash) ?? "",
	};
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
			events.push(normalizeEvent(JSON.parse(lines[i] as string)));
		} catch {
			parseErrors.push(`Event ${i + 1}: malformed JSON`);
		}
	}

	// Find the target event.
	//
	// TERMINAL EVIDENCE OUTRANKS A DETECTION, and a settlement outranks a failure.
	// Plain first-match was ambiguous for any transfer with more than one record,
	// and the anomaly path makes that concrete in both directions:
	//
	//   - `govern.ts` appends `anomaly_detected` and only then calls
	//     `emitter.abort()` IF the emitter has one. A stream object without
	//     `abort` keeps going and settles normally, so the chain holds the
	//     detection AND a real `llm_call` — first-match picked the detection and
	//     rendered a settled, billed call as stopped, hiding its spend.
	//   - When the cutoff DOES take effect, `finalizeStreamVoid` wins
	//     `finalizeOnce("void")` and appends `stream_partial_delivery` with the
	//     same id (`govern.ts:1895`). That is the terminal evidence the abort
	//     completed — AGENTS.md classifies it a failure terminal — so falling back
	//     to the detection rendered a finished call as PENDING forever.
	//
	// `settled` marks a settlement terminal and covers the dynamic
	// `<action.kind>` kinds that cannot be enumerated here; the failure terminals
	// are named plus the `_failed` suffix.
	//
	// SHAPE-GUARDED. `events.jsonl` is untrusted, and unlike the old first-match
	// lookup — which stopped AT the target — this scans the whole array, so it
	// reaches records after it. A later object with a null or missing `data` would
	// otherwise throw on the dereference and take down verification of an EARLIER
	// transaction: a tampered tail breaking historical `--tx` checks.
	// An EMPTY txId matches nothing, deliberately. `--tx "$TX_ID"` with an unset
	// variable is a real invocation, and treating "" as a query would search for a
	// transaction that cannot exist — the answer to which must be "not found",
	// never a verified verdict with exit 0.
	if (txId.trim() === "") {
		return {
			found: false,
			valid: false,
			receipt: renderNotFound(txId),
			errors: ["No transaction id supplied"],
		};
	}

	// No per-use shape guard needed: `normalizeEvent` already guarantees `kind`
	// is a string, `data` is an object, and `transferId` is a string.
	const matching = events.filter((e) => e.data.transferId === txId);
	const isFailureTerminal = (e: TransactionEvent): boolean =>
		e.kind === "stream_partial_delivery" ||
		e.kind === "llm_call_failed" ||
		e.kind.endsWith("_failed");
	// A DENIAL is conclusive too. It was missing from this predicate, so a later
	// appended `settled: true` could still override an earlier `policy_denied` or
	// `ledger_rejected` — the same forgery, one kind along. A refused call moved no
	// money and will never settle, which is exactly what "terminal" means here.
	const isDenialTerminal = (e: TransactionEvent): boolean =>
		e.kind === "policy_denied" || e.kind === "ledger_rejected";
	// `settlement_ambiguous` is CONCLUSIVE and comes FIRST. The producer appends it
	// BEFORE the `llm_call` it corrects (`headless.ts:1425` then `:1484`;
	// `govern.ts:1798` then `:1887`), so a crash or a failed second append can
	// leave it as the only durable record of the outcome. Excluding it let a later
	// hash-valid `settled: true` rewrite an ambiguous settlement into a clean one —
	// the same forgery as the failure and denial cases, one kind along, and the
	// most valuable one to forge because it converts "we do not know whether this
	// spend landed" into "it did".
	const isTerminal = (e: TransactionEvent): boolean =>
		e.data.settled !== undefined ||
		isFailureTerminal(e) ||
		isDenialTerminal(e) ||
		e.kind === "settlement_ambiguous";

	// FIRST TERMINAL IN CHAIN ORDER WINS. Not the best-TYPED terminal anywhere in
	// the log — that was a forgery vector, and it was mine.
	//
	// Ranking settlement above failure across the WHOLE history let a LATER record
	// override an EARLIER one. The audited party owns `events.jsonl`, so it could
	// append a hash-valid `settled: true` reusing a transferId after an anchored
	// FAILURE or DENIAL, and the receipt would read SETTLED — without altering the
	// anchored prefix, so anchoring would not catch it either. `finalizeOnce`
	// makes first-terminal-wins a producer invariant (AGENTS.md); a verifier that
	// ranks by type instead of by order does not merely miss a forgery, it
	// performs one.
	//
	// A DETECTION is still outranked, which is the whole point of scanning past
	// the first match: `anomaly_detected` precedes its terminal by construction
	// and is not conclusive on its own.
	const targetEvent = matching.find(isTerminal) ?? matching[0];

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

	// Carry the DETECTOR's reason across terminal selection. Ranking a terminal
	// above the detection is right for status and wrong for reason: a successful
	// anomaly cutoff selects `stream_partial_delivery`, whose `error` is the SDK's
	// generic "Request was aborted" rather than what the detector observed.
	// ONLY a detection that PRECEDES the selected terminal. The producer writes
	// `anomaly_detected` before the terminal it explains, so anything after one is
	// not evidence about it — and searching the whole history let an appended,
	// UNANCHORED detection decorate a receipt whose inclusion proof covers only
	// the terminal. That renders forged text under an INCLUSION VERIFIED heading,
	// which is worse than showing nothing: the proof is real and the reader has no
	// way to see that it does not cover the line beside it.
	const targetIndex = matching.indexOf(targetEvent);
	const detection = matching
		.slice(0, targetIndex < 0 ? matching.length : targetIndex)
		.find((e) => e.kind === "anomaly_detected");
	const detectionReason = detection !== undefined ? detection.data.message : undefined;

	const receiptData: ReceiptData = {
		event: targetEvent,
		...(detectionReason !== undefined ? { detectionReason } : {}),
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
