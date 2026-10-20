// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// usertrust-verify — Standalone Audit Verification (zero dependencies)

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	type AnchorRecord,
	type AnchorSource,
	type AnchorState,
	type AnchorTrust,
	dedupeAnchorSet,
	evaluateAnchoredVault,
	parseAnchorMirror,
	parseAnchorsContent,
	publicKeyFromSpkiBase64,
	verifyInclusionAgainstAnchor,
	type WitnessInput,
	type WitnessStatus,
	worseAnchorState,
} from "./anchor-verify.js";
import { canonicalize } from "./canonical.js";
import { GENESIS_HASH } from "./constants.js";
import {
	eventStatus,
	type ReceiptData,
	renderNotFound,
	renderReceipt,
	type TransactionEvent,
} from "./receipt.js";
import { parseRekorReceipt, type RekorVerification, verifyRekorReceipt } from "./rekor-verify.js";
import { LOG_NAME, readVaultSnapshot, type StableReadOptions } from "./stable-read.js";
import { MAX_SEGMENT_BYTES, MAX_SNAPSHOT_BYTES, splitLines } from "./tail-read.js";
import {
	classifyAuditTail,
	type FileObservation,
	type LogObservation,
	parseLine,
	type TailState,
	trailingKind,
	verdictErrors,
} from "./tail-state.js";
import {
	firstTerminalOf,
	matchesTransfer,
	selectTransferEvent,
	type TransferStatus,
	transferIdHash,
} from "./verdict.js";
import { buildMerkleTree, generateInclusionProof } from "./verify.js";

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
	firstTerminalOf,
	matchesTransfer,
	selectTransferEvent,
	type TransferStatus,
	type TransferVerdict,
	transferIdHash,
	transferKeysOf,
	transferVerdict,
} from "./verdict.js";
export {
	buildMerkleTree,
	generateConsistencyProof,
	generateInclusionProof,
	hashInternal,
	hashLeaf,
	type MerkleConsistencyProof,
	type MerkleInclusionProof,
	type MerkleSibling,
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
	/**
	 * The chain's tail against its anchor (`tail-state.ts`): `MATCH`, `FRESH`, `ONE_PAST_ANCHOR` (an
	 * interrupted write: valid, with its note), or the state that refuses it. `null` when no consistent
	 * snapshot could be read (`busy`).
	 */
	tailState?: TailState | null;
	/** The vault's files kept changing while they were read: no verdict, never "broken". */
	busy?: true;
	/** A torn tail under a writer that holds the vault: torn, or a write still in progress. */
	writerLive?: true;
}

/** A vault's verdict, and the events it was reached on: what every later check must read. */
export interface VaultReading {
	result: VaultVerificationResult;
	/** The events walked, in chain order, as parsed from their lines (JSON objects only). */
	events: readonly Record<string, unknown>[];
	/** Every walked line's stored hash, in chain order (`""` where it is not a string). */
	orderedHashes: readonly string[];
	/**
	 * The segment each walked `sequence` was read from (`null` where more than one line holds it, so no
	 * one file can be named): for naming a sequence gap beside the verdict, never for the verdict.
	 */
	sequenceSegments: ReadonlyMap<number, string | null>;
	/** The anchor mirror as the same snapshot read it, when asked for (`opts.mirror`). */
	mirror?: FileObservation;
}

export interface ChainVerificationResult {
	valid: boolean;
	eventsVerified: number;
	errors: string[];
	skipped: number;
	latestHash: string;
	verifiedAt: string;
	/** The log's tail against its anchor (`tail-state.ts`); `null` when there was no snapshot (`busy`). */
	tailState?: TailState | null;
	/** The log kept changing while it was read: no verdict, never "broken". */
	busy?: true;
	/** A torn tail under a writer that holds the vault: torn, or a write still in progress. */
	writerLive?: true;
}

/**
 * The chain in ONE log file and its `.meta` anchor (`<audit dir>/events.jsonl`, or any one log under
 * its own name), verified exactly as `verifyVault` verifies a vault: the same bracketed snapshot, the
 * directory's real inventory (an interrupted recovery is seen), the same walk (links, sequence at its
 * position, every hash), and the writer's own classification of the tail. ONE answer path: this used
 * to read the log and its anchor unbracketed, with an empty inventory made up for the classifier, and
 * no position rule, so it could pass what `verifyVault` refused. A log that is not there is an empty
 * chain, as it always was. `eventsVerified` counts the complete lines walked, events or not.
 */
export function verifyChain(
	logPath: string,
	opts: StableReadOptions = {},
): ChainVerificationResult {
	const verifiedAt = new Date().toISOString();
	const { result, orderedHashes, lines, skipped } = readAuditDirectory(
		dirname(logPath),
		opts,
		basename(logPath),
		"chain",
	);
	return {
		valid: result.valid,
		eventsVerified: lines,
		errors: result.errors,
		skipped,
		latestHash: orderedHashes[orderedHashes.length - 1] ?? GENESIS_HASH,
		verifiedAt,
		tailState: result.tailState ?? null,
		...(result.busy === true ? { busy: true as const } : {}),
		...(result.writerLive === true ? { writerLive: true as const } : {}),
	};
}

interface ParsedEvent {
	id: string;
	hash: string;
	previousHash: string;
	sequence?: number | undefined;
	timestamp?: string | undefined;
	parsed: Record<string, unknown>;
	/** The line as read, for the tail's classification. */
	raw: Buffer;
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
 * BYTE-IDENTICAL to the core implementation (packages/core/src/audit/verify.ts),
 * in `verifyVaultReading`: gathers `events.jsonl` plus every rotated `*.jsonl`
 * segment, orders all events by the persisted global `sequence`, walks a single
 * continuous chain (GENESIS required only at the global head), enforces sequence
 * continuity (so whole-segment deletion surfaces as a sequence gap, not an
 * indistinguishable "previousHash mismatch"), and checks the `.meta` tail
 * anchor. The differential test pins the two implementations together.
 */
export function verifyVault(vaultPath: string): VaultVerificationResult {
	return verifyVaultReading(vaultPath).result;
}

/**
 * {@link verifyVault}, handing back the events it verified with its verdict. A check that judges
 * the vault after its verification takes them from here: reading the log a second time judged
 * whatever the log held THEN, never hash-checked. IDENTICAL in packages/core/src/audit/verify.ts.
 */
export function verifyVaultReading(vaultPath: string, opts: StableReadOptions = {}): VaultReading {
	const { result, events, orderedHashes, sequenceSegments, mirror } = readAuditDirectory(
		join(vaultPath, "audit"),
		opts,
		LOG_NAME,
		"vault",
	);
	return {
		result,
		events,
		orderedHashes,
		sequenceSegments,
		...(mirror !== undefined ? { mirror } : {}),
	};
}

/** Each walked `sequence` and the segment it was read from; `null` where more than one line holds it. */
function segmentsBySequence(events: readonly ParsedEvent[]): Map<number, string | null> {
	const out = new Map<number, string | null>();
	for (const e of events) {
		if (e.sequence === undefined) continue;
		out.set(e.sequence, out.has(e.sequence) ? null : e.sourceFile);
	}
	return out;
}

/** A verdict over one audit directory's snapshot, with the count of complete lines it walked. */
interface AuditDirectoryReading extends VaultReading {
	/** The complete lines read, events or not. */
	lines: number;
	/** The complete lines that are not events: not JSON, not an event, or a malformed sequence. */
	skipped: number;
}

/**
 * The one walk every verifier entry point gives its verdict from: `vault`, a vault's audit directory
 * (`verifyVault`), which must be there; `chain`, one log file verified alone (`verifyChain`), where a
 * directory that is not there holds an absent log, an empty chain. IDENTICAL in
 * packages/core/src/audit/verify.ts.
 */
function readAuditDirectory(
	auditDir: string,
	opts: StableReadOptions,
	logName: string,
	mode: "vault" | "chain",
): AuditDirectoryReading {
	const errors: string[] = [];

	// 1. ONE snapshot (`stable-read.ts`): every phase below reads it, never the files again. A vault's
	// chain is every segment in its directory; one log verified alone is that file alone.
	const read = readVaultSnapshot(auditDir, opts, logName, mode === "vault");
	if (read.kind === "busy") {
		return {
			result: {
				valid: false,
				errors: [
					"the vault is being written: its audit files kept changing while they were read, so there is no verdict (run verify again)",
				],
				chainLength: 0,
				validHashes: 0,
				merkleRoot: null,
				firstEvent: null,
				lastEvent: null,
				tailState: null,
				busy: true,
			},
			events: [],
			orderedHashes: [],
			sequenceSegments: new Map(),
			lines: 0,
			skipped: 0,
		};
	}
	const { snapshot } = read;
	if (read.kind === "torn_writer_live") {
		errors.push(
			"the log ends in bytes after its last newline while a writer holds the vault: torn, or a write in progress (stop the writer to classify it)",
		);
	}

	// 2. The directory. One that exists but cannot be listed is a vault nobody read: never "0 events,
	// all valid" (SCRUBBED: the path is the caller's, and the non-JSON CLI prints this).
	if (snapshot.audit.kind === "missing") {
		if (mode === "vault") errors.push(`Audit directory not found: ${auditDir}`);
	} else if (snapshot.audit.kind !== "ok") {
		errors.push(
			scrubForError(
				`Audit directory could not be enumerated: ${auditDir} (${
					snapshot.audit.kind === "unreadable"
						? snapshot.audit.code
						: `over ${snapshot.audit.count} names`
				})`,
			),
		);
	}

	// 3. Every segment's complete lines, split as BYTES (`splitLines`: a log over V8's string limit is
	// never decoded whole) and each parsed alone. A segment that cannot be read, or is over the bound
	// for one read, is reported, never skipped as if absent; bytes after its last newline are refused
	// by name, whatever they are; a line that is not JSON, not an event, or an event with a malformed
	// sequence is an error, never read on trust.
	const events: ParsedEvent[] = [];
	// The log's complete lines in file order, for the tail's classification.
	let liveLines: Buffer[] = [];
	let liveTrailing: Buffer = Buffer.alloc(0);
	let liveTrailingOffset = 0;
	let unreadableSegment: LogObservation | undefined;
	let lineCount = 0;
	let skipped = 0;
	for (const segment of snapshot.segments) {
		// SCRUBBED: a segment's name comes from the audited vault, and both CLIs print it.
		const name = scrubForError(segment.name);
		const file = segment.file;
		if (file.kind === "absent") continue;
		if (file.kind !== "read") {
			errors.push(
				file.kind === "not_regular"
					? `Audit segment could not be read: ${name} (a ${file.fileKind}, not a regular file)`
					: file.kind === "oversize"
						? file.size > MAX_SEGMENT_BYTES
							? `Audit segment could not be read: ${name} (${file.size} bytes, over the ${MAX_SEGMENT_BYTES}-byte bound for one read)`
							: `Audit segment could not be read: ${name} (${file.size} bytes: with the segments read before it, over the ${opts.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES}-byte bound one verdict reads within)`
						: `Audit segment could not be read: ${name}`,
			);
			unreadableSegment ??=
				file.kind === "not_regular" || file.kind === "oversize"
					? file
					: { kind: "unavailable", code: "EUNREADABLE" };
			continue;
		}
		const { lines, trailing, trailingOffset } = splitLines(file.bytes);
		if (trailing.length > 0) {
			errors.push(
				`torn tail: ${trailing.length} byte(s) after the last newline of ${name} (${trailingKind(trailing).replaceAll("_", " ")})`,
			);
		}
		if (segment.name === logName) {
			liveLines = lines;
			liveTrailing = trailing;
			liveTrailingOffset = trailingOffset;
		}
		lineCount += lines.length;
		// The writer appends in sequence order: within one segment, a sequence never follows a larger
		// one (lines swapped, or moved, keep their hashes and links, and sort back into a valid chain).
		let previousInFile: number | undefined;
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i] as Buffer;
			const line = parseLine(raw);
			if (line.kind !== "event") skipped++;
			if (line.kind === "event" && line.sequence !== undefined) {
				if (previousInFile !== undefined && line.sequence <= previousInFile) {
					errors.push(
						`sequence ${line.sequence} follows ${previousInFile} in the file, out of order (${name}:${i + 1})`,
					);
				}
				previousInFile = line.sequence;
			}
			if (line.kind === "unparseable") {
				errors.push(`malformed JSON (${name}:${i + 1})`);
				continue;
			}
			if (line.kind === "non_event") {
				errors.push(`not an audit event (${name}:${i + 1})`);
				continue;
			}
			if (line.kind === "malformed") {
				errors.push(`malformed sequence, not a positive safe integer (${name}:${i + 1})`);
				continue;
			}
			const { event } = line;
			events.push({
				id: typeof event.id === "string" ? event.id : "",
				hash: line.hash,
				previousHash: line.previousHash,
				sequence: line.sequence,
				timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
				parsed: event,
				raw,
				sourceFile: segment.name,
				line: i + 1,
			});
		}
	}

	// 4. Order by the persisted global sequence when every event has one (a legacy chain, with events
	// written before sequences: file order, each event at its line).
	const allHaveSeq = events.every((e) => typeof e.sequence === "number");
	const ordered = allHaveSeq
		? [...events].sort((a, b) => (a.sequence as number) - (b.sequence as number))
		: events;

	// 5. One continuous walk: links, sequence continuity (every present sequence is its position),
	// and every hash recomputed, TOTALLY: an event canonicalization refuses is an error at that event.
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
		if (!allHaveSeq && e.sequence !== undefined && e.sequence !== i + 1) {
			errors.push(`Event ${i + 1} (${e.id}): sequence ${e.sequence} is not its position ${i + 1}`);
		}

		const { hash: _storedHash, ...rest } = e.parsed;
		let computed: string | undefined;
		try {
			computed = createHash("sha256").update(canonicalize(rest)).digest("hex");
		} catch {
			computed = undefined;
		}
		if (computed === undefined) {
			errors.push(`Event ${i + 1} (${e.id}): unhashable (its canonical form cannot be computed)`);
		} else if (e.hash !== computed) {
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

	// 6. The tail against its anchor: ONE classification (`tail-state.ts`), the writer's own. The
	// chain's last lines are the log's, in file order, unless ANY other segment is there: then they are
	// the last events by sequence, across every segment. (Judged on the log's lines alone, a chain whose
	// only segment is a rotated one read as an empty log: a truncated chain renamed, its anchor deleted,
	// was FRESH and valid.) An event ONE past the anchor that chains from it is an interrupted write's,
	// rolled forward by the next append: valid, with a note.
	const rotated = snapshot.segments.some((sg) => sg.name !== logName && sg.file.kind !== "absent");
	const chainLines = rotated ? ordered.map((e) => e.raw) : liveLines;
	const log: LogObservation =
		unreadableSegment !== undefined
			? unreadableSegment
			: snapshot.segments.every((sg) => sg.file.kind === "absent")
				? { kind: "absent" }
				: {
						kind: "tail",
						tail: {
							lines: chainLines.slice(-2),
							fromStart: chainLines.length <= 2,
							count: chainLines.length,
							trailing: liveTrailing,
							trailingOffset: liveTrailingOffset,
						},
					};
	const tailState = classifyAuditTail(
		{ audit: snapshot.audit, quarantine: snapshot.quarantine, log, anchor: snapshot.anchor },
		"reader",
	);
	// The state's own error, and the count the anchor records (`verdictErrors`).
	errors.push(...verdictErrors(tailState, snapshot.anchor, ordered.length, errors.length));

	// 7. Merkle root over the ordered event hashes (informational).
	let merkleRoot: string | null = null;
	if (ordered.length > 0) {
		const tree = buildMerkleTree(ordered.map((e) => e.hash));
		merkleRoot = tree.root ?? null;
	}

	// 8.
	return {
		result: {
			valid: errors.length === 0,
			errors,
			chainLength: events.length,
			validHashes,
			merkleRoot,
			firstEvent,
			lastEvent,
			tailState,
			...(read.kind === "torn_writer_live" ? { writerLive: true as const } : {}),
		},
		events: ordered.map((e) => e.parsed),
		orderedHashes: ordered.map((e) => e.hash),
		sequenceSegments: segmentsBySequence(events),
		lines: lineCount,
		skipped,
		...(snapshot.mirror !== undefined ? { mirror: snapshot.mirror } : {}),
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

/** {@link VaultReading} for the anchored verdict. */
export interface AnchoredVaultReading {
	result: AnchoredVaultVerificationResult;
	/** The events walked, in chain order: the ones the anchors were checked against. */
	events: readonly Record<string, unknown>[];
	/** Their hashes, in the same order: the leaves the anchors cover. */
	orderedHashes: readonly string[];
	/** The segment each walked `sequence` was read from, as in {@link VaultReading}. */
	sequenceSegments: ReadonlyMap<number, string | null>;
	/**
	 * The anchor records the verdict was reached on, as read ONCE: the caller's and the vault mirror's.
	 * Anything built on the verdict (`--tx`'s covering anchor and its rotation keys) takes them from
	 * here: the mirror read again could hold records the state machine never checked.
	 */
	anchors: { external: readonly AnchorRecord[]; mirror: readonly AnchorRecord[] };
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
 * (`verifyVaultWithAnchorsReading`) — the anchor differential test pins the two.
 */
export function verifyVaultWithAnchors(
	vaultPath: string,
	params: AnchorVerifyParams = {},
): AnchoredVaultVerificationResult {
	return verifyVaultWithAnchorsReading(vaultPath, params).result;
}

/**
 * {@link verifyVaultWithAnchors}, handing back the events it verified. The anchors are checked
 * against THOSE events' hashes: gathering them with a second read of the log let a log swapped
 * between the reads pass its integrity walk as one chain and its anchors as another, an anchored
 * pass for a chain no anchor covers. IDENTICAL in packages/core/src/audit/verify.ts.
 */
export function verifyVaultWithAnchorsReading(
	vaultPath: string,
	params: AnchorVerifyParams = {},
): AnchoredVaultReading {
	// The anchor mirror comes from the same bracketed snapshot as the chain: read after it, a mirror
	// that gained an anchor (and the log its events) while the walk ran judged the walk's chain against
	// an anchor it never held (a rollback, for an honest vault).
	const reading = verifyVaultReading(vaultPath, { mirror: true });
	const base = reading.result;
	// No snapshot (`busy`): there is nothing to check the anchors against. Never evaluated over a chain
	// of no events, which every anchor would call a deletion: not evaluated, and said so.
	if (base.busy === true) {
		return {
			result: {
				...base,
				anchorState: "ANCHOR_UNVERIFIABLE",
				anchoring: {
					anchorSource: "none",
					anchorCount: 0,
					latestAnchor: null,
					unanchoredTail: { events: 0, sinceTimestampMs: null },
					witness: { requested: params.witness?.requested === true, status: "not-consulted" },
					reasons: ["busy"],
					warnings: [],
				},
			},
			events: reading.events,
			orderedHashes: reading.orderedHashes,
			sequenceSegments: reading.sequenceSegments,
			anchors: { external: [], mirror: [] },
		};
	}
	const externalRecords: AnchorRecord[] = [];
	const externalErrors: string[] = [];
	for (const raw of params.externalAnchorsRaw ?? []) {
		const parsed = parseAnchorsContent(raw);
		externalRecords.push(...parsed.records);
		externalErrors.push(...parsed.errors);
	}
	const mirror = parseAnchorMirror(reading.mirror ?? { kind: "absent" });
	const rekor = verifySuppliedRekorReceipts(
		params.rekorReceiptsRaw ?? [],
		externalRecords,
		mirror.records,
		params.rekorLogPubkeysPem ?? [],
	);
	const evaluation = evaluateAnchoredVault({
		orderedHashes: reading.orderedHashes,
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
		result: {
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
		},
		events: reading.events,
		orderedHashes: reading.orderedHashes,
		sequenceSegments: reading.sequenceSegments,
		anchors: { external: externalRecords, mirror: mirror.records },
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
	/** The vault kept changing while it was read: no search, no verdict (`errors` says so). */
	readonly busy?: true | undefined;
	/** The vault's chain could not be read (`errors` says why): a failure, never "not found". */
	readonly failed?: true | undefined;
	/** The transfer's verdict (`transferVerdict`), when found: the status the receipt prints. */
	readonly status?: TransferStatus | undefined;
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
export function normalizeEvent(raw: unknown): TransactionEvent {
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
	const reason = str(d.reason);
	const voidError = str(d.voidError);

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
			...(reason !== undefined ? { reason } : { reason: undefined }),
			...(voidError !== undefined ? { voidError } : { voidError: undefined }),
			// PRESERVED for the same reason, and a sharper one: defaulting to ""
			// mapped every event WITHOUT a transferId onto the same empty id, so
			// `--tx ""` (an unset shell variable) matched them and returned
			// found/valid with exit 0 for a transaction that does not exist. A
			// false OK, manufactured by the normalizer meant to prevent them.
			...(str(d.transferId) !== undefined ? { transferId: str(d.transferId) } : {}),
			...(str(d.transferIdHash) !== undefined ? { transferIdHash: str(d.transferIdHash) } : {}),
			// The `...d` above carries whatever the file held. A non-string id (a number, an object) must not
			// reach the renderer, which scrubs strings: drop it, so the event reads as having no id.
			...(typeof d.transferId !== "string" ? { transferId: undefined } : {}),
			...(typeof d.transferIdHash !== "string" ? { transferIdHash: undefined } : {}),
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

/** Whether anything at all is at `path`, a dangling link included: only ENOENT is nothing. */
function somethingAt(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (err) {
		return (err as { code?: unknown } | null)?.code !== "ENOENT";
	}
}

/**
 * Each `Sequence gap: event X follows Y` the vault reading reported, NAMED: the absent range Y+1..X-1 and the files
 * holding Y and X. The names come from the verdict's own sequences, as the same snapshot read them
 * (`sequenceSegments`), not from each file's first and last lines, so an out-of-order segment cannot misname a
 * gap; a sequence that no one file holds (absent, or held twice) leaves the file names out rather than guessed.
 */
function nameGaps(
	errors: readonly string[],
	seqFile: ReadonlyMap<number, string | null>,
): string[] {
	const out: string[] = [];
	for (const e of errors) {
		const m = /^Sequence gap: event (\d+) follows (\d+)/.exec(e);
		if (m === null) continue;
		const [x, y] = [Number(m[1]), Number(m[2])];
		// A duplicated sequence reads "event 1 follows 1": no event is absent, so it keeps only the verdict's own error.
		if (!(x > y + 1)) continue;
		const [fileY, fileX] = [seqFile.get(y), seqFile.get(x)];
		const range = x - y === 2 ? `event ${y + 1} is` : `events ${y + 1}..${x - 1} are`;
		if (fileY == null || fileX == null) out.push(`audit events missing: ${range} absent`);
		else if (fileY === fileX)
			out.push(`audit events missing: ${range} absent inside ${fileY} (between ${y} and ${x})`);
		else
			out.push(
				`audit segment missing: ${range} absent between ${fileY} (ends at ${y}) and ${fileX} (starts at ${x})`,
			);
	}
	return out;
}

/** An error of the walk's that says a file the chain may be in was never read: a segment, or the directory's listing. */
function isUnreadError(error: string): boolean {
	return (
		error.startsWith("Audit segment could not be read: ") ||
		error.startsWith("Audit directory could not be enumerated: ")
	);
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

	// Nothing at all at the audit directory's path: there is no log to search, so not found. Anything
	// there (a directory whose chain is only in a rotated segment, a link leading nowhere) is read by
	// the snapshot below and judged: a chain found there is searched, and one that cannot be read is a
	// failure, never "not found".
	if (!somethingAt(auditDir)) {
		return {
			found: false,
			valid: false,
			// Nothing could be read: never the absolute "no event exists" sentence.
			receipt: renderNotFound(txId, false),
			errors: [`Audit log not found: ${mainLog}`],
		};
	}

	// ONE snapshot of the vault: the event searched for, the chain's verdict and the inclusion proof's
	// hashes all come from it. Reading the log again for each let a log changed between the reads be
	// searched as one chain and proved as another: a forged event shown under a proof of the genuine one.
	const anchored =
		anchorParams === undefined ? undefined : verifyVaultWithAnchorsReading(vaultPath, anchorParams);
	const reading = anchored ?? verifyVaultReading(vaultPath);
	// No snapshot: nothing was searched, so nothing is "not found" (and no verdict is given).
	if (reading.result.busy === true) {
		return {
			found: false,
			valid: false,
			busy: true,
			receipt: renderNotFound(txId, false),
			errors: reading.result.errors,
		};
	}
	if (reading.result.chainLength === 0) {
		// An empty log is one where nothing can be found; a log that could not be read is a failure.
		return reading.result.errors.length === 0
			? {
					found: false,
					valid: false,
					// A clean, empty reading: the classification agreed the anchor records no events.
					receipt: renderNotFound(txId, true),
					errors: ["Audit log is empty"],
				}
			: {
					found: false,
					valid: false,
					failed: true,
					receipt: renderNotFound(txId, false),
					errors: reading.result.errors,
				};
	}

	const events: TransactionEvent[] = reading.events.map(normalizeEvent);

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
	// `settlement_unrecoverable` stores only the SHA-256 of its transferId, so that kind matches on the
	// hash of the queried id (`matchesTransfer`).
	const txHash = transferIdHash(txId);
	const matching = events.filter((e) => matchesTransfer(e, txId, txHash));
	const firstTerminal = firstTerminalOf(matching);
	const targetEvent = selectTransferEvent(matching);

	// SCRUBBED: segment names and event ids are vault text, and these errors reach a terminal. A gap
	// is named even when the target is absent: its records may be what the missing segment held.
	const vaultErrors = [
		...reading.result.errors,
		...nameGaps(reading.result.errors, reading.sequenceSegments),
	];
	if (targetEvent === undefined) {
		const errors = vaultErrors.map(scrubForError);
		// A segment, or the directory, that could not be read may hold the transfer's records: never
		// "not found" there (a verdict on records nobody read), a failure. The absolute receipt sentence only
		// for a reading with no errors: a missing segment or a failed chain may hold the records asked for.
		const receipt = renderNotFound(txId, vaultErrors.length === 0);
		return reading.result.errors.some(isUnreadError)
			? { found: false, valid: false, failed: true, receipt, errors }
			: { found: false, valid: false, receipt, errors };
	}

	// The chain's verdict, from the same snapshot.
	const chainVerified = reading.result.valid;

	// Merkle root over the stored hashes — informational display only. The
	// self-referential inclusion check (F1: proof AND root computed from the
	// same allHashes) is retired; inclusion is only ever claimed against a
	// verified EXTERNAL anchor root below (AC-5.2).
	const tree = buildMerkleTree([...reading.orderedHashes]);
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
		const vaultResult = (anchored as AnchoredVaultReading).result;
		anchorsValid = vaultResult.valid;
		anchorState = vaultResult.anchorState;
		anchoring = vaultResult.anchoring;
		anchorErrors.push(...vaultResult.anchoring.reasons.map((r) => `anchor: ${r}`));
		const state = vaultResult.anchorState;
		if (state === "ANCHORED_VERIFIED" || state === "ANCHOR_STALE") {
			const orderedHashes = (anchored as AnchoredVaultReading).orderedHashes;
			const pos = typeof targetEvent.sequence === "number" ? targetEvent.sequence : leafIndex + 1;
			// The records the verdict was reached on, never the mirror read again: a mirror changed since
			// could add a rotation, and a record under its key, that the state machine never checked.
			const { external, mirror } = (anchored as AnchoredVaultReading).anchors;
			const uniqueAnchors = dedupeAnchorSet([...external, ...mirror]).unique;
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
				covering.treeSize <= orderedHashes.length &&
				// The proof must be for THIS event. `pos` is the event's stored `sequence`, but the leaf at that
				// position is whatever the ordered chain holds there: a sequence-less or duplicated-sequence record
				// can put ANOTHER event's leaf at `pos`, and a proof for that leaf would label this one VERIFIED.
				orderedHashes[pos - 1] === targetEvent.hash
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
	// THE BOUNDARY IS THE FIRST TERMINAL, NOT THE SELECTED ONE. Ambiguity moves
	// `targetEvent` later, so using its position slid the boundary past an appended
	// detection and let it decorate a receipt whose real terminal came first.
	// Nothing after the first terminal is evidence about the outcome.
	const boundary = firstTerminal ?? targetEvent;
	const boundaryIndex = matching.indexOf(boundary);
	const detection = matching
		.slice(0, boundaryIndex < 0 ? matching.length : boundaryIndex)
		.find((e) => e.kind === "anomaly_detected");
	const detectionReason = detection !== undefined ? detection.data.message : undefined;

	const receiptData: ReceiptData = {
		event: targetEvent,
		...(detectionReason !== undefined ? { detectionReason } : {}),
		chainLength: reading.result.chainLength,
		merkleRoot,
		merkleVerified,
		chainVerified,
		verifiedAt: new Date(),
		merkleLabel,
	};

	const allErrors = [...vaultErrors, ...anchorErrors].map(scrubForError);

	return {
		found: true,
		valid: chainVerified && merkleVerified && anchorsValid,
		receipt: renderReceipt(receiptData),
		status: eventStatus(targetEvent),
		errors: allErrors,
		...(anchorState !== undefined ? { anchorState } : {}),
		...(anchoring !== undefined ? { anchoring } : {}),
	};
}
