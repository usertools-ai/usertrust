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
	parseAnchorsContent,
	readAnchorMirror,
	type WitnessInput,
	type WitnessStatus,
} from "./anchor-verify.js";
import { canonicalize } from "./canonical.js";
import { buildMerkleTree } from "./merkle.js";
import type { PersistedAuditEvent } from "./read.js";

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

/** A vault's verdict, and the events it was reached on: what every later check must read. */
export interface VaultReading {
	result: VaultVerificationResult;
	/**
	 * Every event on file, as parsed from its line (JSON objects only): the walked events in chain
	 * order, then the events left out of the walk (in a log where only some events have a sequence,
	 * the ones without), in file order. The first `result.chainLength` are the walked ones, and
	 * `orderedHashes[i]` is the hash of `events[i]`; an event past them has no leaf.
	 */
	events: readonly PersistedAuditEvent[];
	/** Every walked line's stored hash, in chain order (`""` where it is not a string). */
	orderedHashes: readonly string[];
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

		// A line that parses but is not a JSON object is skipped like a malformed one. `null`
		// threw on its first field read; a number, string, boolean or array was hashed as an
		// object it is not, and its missing hash became the link the next event was checked against.
		if (event === null || typeof event !== "object" || Array.isArray(event)) {
			errors.push(
				JSON.stringify({
					line: i + 1,
					error: "non-object line",
					raw: line.substring(0, 100),
				}),
			);
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
 * {@link verifyVault}, handing back the events it verified with its verdict. A check that judges
 * the vault after its verification takes them from here: reading the log a second time judged
 * whatever the log held THEN, never hash-checked. IDENTICAL in packages/verify/src/index.ts.
 */
export function verifyVaultReading(vaultPath: string): VaultReading {
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
			// NOT "non-fatal". A directory that exists but cannot be enumerated is a
			// vault we did not read, and swallowing that produced the worst possible
			// answer: with `events.jsonl` also absent or unreadable, `segmentFiles`
			// stayed empty, the branch below found the directory present so pushed no
			// error, and verification returned `valid: true, chainLength: 0` — a clean
			// bill of health, exit 0, on a vault nobody could open. We cannot verify
			// what we cannot list, and "0 events, all hashes valid" is a claim about
			// evidence rather than an absence of it.
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
			result: {
				valid: errors.length === 0,
				errors,
				chainLength: 0,
				validHashes: 0,
				merkleRoot: null,
				firstEvent: null,
				lastEvent: null,
			},
			events: [],
			orderedHashes: [],
		};
	}

	// 5. Parse every line of every segment.
	const events: ParsedEvent[] = [];
	for (const segmentFile of segmentFiles) {
		let content: string;
		try {
			content = readFileSync(segmentFile, "utf-8").trim();
		} catch {
			// FAIL CLOSED. Skipping made a segment that could not be READ
			// indistinguishable from one that did not exist: with `events.jsonl`
			// present but unreadable and no usable `.meta`, this returned
			// `valid: true, chainLength: 0`, and `health` printed `verified` for
			// evidence nobody had opened. A vault that cannot be read is a vault
			// that cannot be verified, which is a different answer from "clean".
			// SCRUBBED, like the enumeration error above it. The filename comes from
			// the audited vault — a broken symlink can be NAMED with an ANSI escape —
			// and both human-facing CLIs print this string verbatim, so an unscrubbed
			// name lets the vault repaint the FAILED verdict this error exists to
			// produce. I added this error immediately beneath one that already calls
			// `scrubForError` for exactly that reason.
			errors.push(`Audit segment could not be read: ${scrubForError(basename(segmentFile))}`);
			continue;
		}
		if (content === "") continue;
		const lines = content.split("\n").filter((l) => l.trim());
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i] as string;
			let value: unknown;
			try {
				value = JSON.parse(raw);
			} catch {
				errors.push(`malformed JSON (${basename(segmentFile)}:${i + 1})`);
				continue;
			}
			// A line that parses but is not a JSON object (`42`, `[]`, `null`, `"x"`) is not an event,
			// and is never walked as one. Walked, it had no `sequence`, and one event without a
			// `sequence` switched the whole vault to the file-order walk below, which skips both
			// sequence checks: a vault with its leading events deleted then named only the stray
			// line's hash, never the deletion. It is its own error, and the walk runs over the rest.
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				errors.push(`non-object line (${scrubForError(basename(segmentFile))}:${i + 1})`);
				continue;
			}
			const parsed = value as Record<string, unknown>;
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
		}
	}

	// 6. Order by the persisted global sequence. The file-order walk, with both sequence checks
	// off, is only for a log in which NO event has a sequence (the legacy shape). A log where only
	// some events have one is not that log: each event without a numeric sequence is its own error
	// and is left out of the walk, which runs over the sequenced events in sequence order with
	// both sequence checks on. Before, one such event switched the whole vault to the file-order
	// walk, and a leading deletion or a gap among the other events was never named.
	const sequenced = events.filter((e) => typeof e.sequence === "number");
	const legacy = sequenced.length === 0;
	// The events left out of the walk, in file order: none in a legacy log.
	const unwalked = legacy ? [] : events.filter((e) => typeof e.sequence !== "number");
	for (const e of unwalked) {
		errors.push(`event without sequence (${scrubForError(basename(e.sourceFile))}:${e.line})`);
	}
	const ordered = legacy
		? events
		: [...sequenced].sort((a, b) => (a.sequence as number) - (b.sequence as number));

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

		if (!legacy && i === 0 && e.sequence !== 1) {
			errors.push(`Sequence starts at ${e.sequence}, expected 1 (leading events deleted)`);
		}
		if (!legacy && i > 0) {
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
		result: {
			valid: errors.length === 0,
			errors,
			chainLength: ordered.length,
			validHashes,
			merkleRoot,
			firstEvent,
			lastEvent,
		},
		// THE INVARIANT every reader of `events` relies on: the walked events (`ordered`) FOLLOWED BY
		// the events left out of the walk, in file order. So `events[i]` is walked event `i`, whose
		// hash is `orderedHashes[i]`, for every `i < chainLength`, and an index at or past
		// `chainLength` has no leaf. A figure (a spend, a transaction list) is built from every event
		// on file; a check on the chain reads the first `chainLength`. Every parsed line is a JSON
		// object (step 5 refuses the rest, as its own error), so the filter only narrows the type and
		// removes nothing, which the invariant needs; it is kept so no later check can ever be handed a
		// non-object.
		events: [...ordered, ...unwalked]
			.map((e) => e.parsed as unknown)
			.filter(
				(p): p is PersistedAuditEvent => p !== null && typeof p === "object" && !Array.isArray(p),
			),
		orderedHashes: ordered.map((e) => e.hash),
	};
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

/** {@link VaultReading} for the anchored verdict. */
export interface AnchoredVaultReading {
	result: AnchoredVaultVerificationResult;
	/**
	 * The reading's events, as in {@link VaultReading}: the walked events in chain order (the ones
	 * the anchors were checked against), then any left out of the walk, in file order.
	 */
	events: readonly PersistedAuditEvent[];
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

/** Options an earlier release took, now removed. Passing one is refused: ignoring it would drop evidence the caller expects checked. */
const REMOVED_ANCHOR_PARAMS = ["rekorReceiptsRaw", "rekorLogPubkeysPem"] as const;

function refuseRemovedAnchorParams(params: AnchorVerifyParams): void {
	for (const key of REMOVED_ANCHOR_PARAMS) {
		if (key in (params as object)) {
			throw new Error(
				`verifyVaultWithAnchors: the "${key}" option was removed; transparency-log receipts are no longer verified`,
			);
		}
	}
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
	refuseRemovedAnchorParams(params);
	const reading = verifyVaultReading(vaultPath);
	const base = reading.result;
	const externalRecords: AnchorRecord[] = [];
	const externalErrors: string[] = [];
	for (const raw of params.externalAnchorsRaw ?? []) {
		const parsed = parseAnchorsContent(raw);
		externalRecords.push(...parsed.records);
		externalErrors.push(...parsed.errors);
	}
	const mirror = readAnchorMirror(vaultPath);
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
		},
	});
	return {
		result: {
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
		},
		events: reading.events,
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
