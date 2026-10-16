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
 *
 * ONE READ PER VERDICT. `verifyVaultReading` hands back the events it verified,
 * and everything the CLI judges after it (the anchors' coverage, the caller's
 * receipts, the dead letters) is judged against THOSE, never against the log read
 * again: a log changed between two reads let an unverified second version satisfy
 * the checks the first one passed.
 */

import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { GENESIS_HASH } from "../shared/constants.js";
import {
	type AnchorRecord,
	type AnchorSource,
	type AnchorState,
	type AnchorTrust,
	evaluateAnchoredVault,
	parseAnchorMirror,
	parseAnchorsContent,
	type WitnessInput,
	type WitnessStatus,
	worseAnchorState,
} from "./anchor-verify.js";
import { canonicalize } from "./canonical.js";
import { buildMerkleTree } from "./merkle.js";
import type { PersistedAuditEvent } from "./read.js";
import { parseRekorReceipt, type RekorVerification, verifyRekorReceipt } from "./rekor-verify.js";
import { LOG_NAME, readVaultSnapshot, type StableReadOptions } from "./stable-read.js";
import { MAX_SEGMENT_BYTES, splitLines } from "./tail-read.js";
import {
	classifyAuditTail,
	type FileObservation,
	type LogObservation,
	parseLine,
	type TailState,
	trailingKind,
	verdictErrors,
} from "./tail-state.js";

export type { AnchorRecord, AnchorSource, AnchorState, AnchorTrust, WitnessInput };

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
	events: readonly PersistedAuditEvent[];
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
 * Gathers `events.jsonl` plus every rotated `*.jsonl` segment, orders all events
 * by the persisted global `sequence`, walks a single continuous chain (GENESIS
 * required only at the global head), enforces sequence continuity (so whole-
 * segment deletion surfaces as a sequence gap rather than an indistinguishable
 * "previousHash mismatch"), and checks the `.meta` tail anchor.
 */
export function verifyVault(vaultPath: string): VaultVerificationResult {
	return verifyVaultReading(vaultPath).result;
}

/**
 * @internal {@link verifyVault} with the snapshot's retries bounded by the caller, for one that retries on its own and
 * must not block while a vault keeps changing: the live dashboard. The verifier's default (26 attempts, 100 ms apart)
 * sleeps synchronously. A read that still changes within the bound is `busy`. Core-only: the standalone verifier is a
 * CLI that may block, and has no such caller.
 */
export function verifyVaultBounded(
	vaultPath: string,
	opts: Pick<StableReadOptions, "attempts" | "delayMs">,
): VaultVerificationResult {
	return verifyVaultReading(vaultPath, opts).result;
}

/**
 * {@link verifyVault}, handing back the events it verified with its verdict. A check that judges
 * the vault after its verification takes them from here: reading the log a second time judged
 * whatever the log held THEN, never hash-checked. IDENTICAL in packages/verify/src/index.ts.
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
 * packages/verify/src/index.ts.
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
						? `Audit segment could not be read: ${name} (${file.size} bytes, over the ${MAX_SEGMENT_BYTES}-byte bound for one read)`
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
		events: ordered.map((e) => e.parsed as unknown as PersistedAuditEvent),
		orderedHashes: ordered.map((e) => e.hash),
		sequenceSegments: segmentsBySequence(events),
		lines: lineCount,
		skipped,
		...(snapshot.mirror !== undefined ? { mirror: snapshot.mirror } : {}),
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

/** {@link VaultReading} for the anchored verdict. */
export interface AnchoredVaultReading {
	result: AnchoredVaultVerificationResult;
	/** The events walked, in chain order: the ones the anchors were checked against. */
	events: readonly PersistedAuditEvent[];
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
 * top additively. IDENTICAL function body in packages/verify/src/index.ts
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
 * pass for a chain no anchor covers. IDENTICAL in packages/verify/src/index.ts.
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
