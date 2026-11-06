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
import {
	firstTerminalOf,
	matchesTransfer,
	selectTransferEvent,
	type TransferStatus,
	transferIdHash,
} from "./verdict.js";
import { buildMerkleTree, generateInclusionProof, readAnchor } from "./verify.js";

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

/** A vault's verdict, and the events it was reached on: what every later check must read. */
export interface VaultReading {
	result: VaultVerificationResult;
	/**
	 * Every event on file, as parsed from its line (JSON objects only): the walked events in chain
	 * order, then the events left out of the walk (in a log where only some events have a sequence,
	 * the ones without), in file order. The first `result.chainLength` are the walked ones, and
	 * `orderedHashes[i]` is the hash of `events[i]`; an event past them has no leaf.
	 */
	events: readonly Record<string, unknown>[];
	/** Every walked line's stored hash, in chain order (`""` where it is not a string). */
	orderedHashes: readonly string[];
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
			// FAIL CLOSED — mirrors `core/src/audit/verify.ts`, error string included.
			// Skipping made an unreadable segment indistinguishable from an absent
			// one, so a vault nobody could open verified as clean.
			// SCRUBBED — mirrors core, error string included. The filename comes from
			// the audited vault and both CLIs print it verbatim, so an escape in a
			// segment's name could repaint the FAILED verdict.
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
			// Mirrors `core/src/audit/verify.ts`, error string included.
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
				(p): p is Record<string, unknown> =>
					p !== null && typeof p === "object" && !Array.isArray(p),
			),
		orderedHashes: ordered.map((e) => e.hash),
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

/** {@link VaultReading} for the anchored verdict. */
export interface AnchoredVaultReading {
	result: AnchoredVaultVerificationResult;
	/**
	 * The reading's events, as in {@link VaultReading}: the walked events in chain order (the ones
	 * the anchors were checked against), then any left out of the walk, in file order.
	 */
	events: readonly Record<string, unknown>[];
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
 * pass for a chain no anchor covers. IDENTICAL in packages/core/src/audit/verify.ts.
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
	/** The transfer's verdict (`transferVerdict`), when found: the status the receipt prints. */
	readonly status?: TransferStatus | undefined;
	/**
	 * When found: true only when this transaction's inclusion was proven against a verified anchor root (the receipt's
	 * `INCLUSION VERIFIED (anchor #n)`). A reader must take this from here, never by parsing the receipt text: the
	 * receipt also prints fields the vault under audit wrote.
	 */
	readonly inclusionVerified?: boolean | undefined;
	/**
	 * Present (and true) only when the transfer's records are on file but none is in the checked
	 * chain: each is an event without a sequence in a log where other events have one, so the walk
	 * left it out. Such a transfer is found, has no leaf, no inclusion proof and no anchored claim,
	 * and its result is never valid (the vault fails on those events' own errors). A transfer with a
	 * record in the checked chain is judged on those records alone.
	 */
	readonly outsideCheckedChain?: true | undefined;
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

/**
 * The audit files by verifyVault's rule, with the file each `sequence` was read from. An unreadable file
 * THROWS, as an unreadable `events.jsonl` always did here: "not found" would be a verdict on unread records.
 */
function auditSegments(auditDir: string): {
	count: number;
	empty: boolean;
	enumerated: boolean;
	seqFile: Map<number, string>;
} {
	let names: string[] = [];
	let enumerated = true;
	try {
		names = readdirSync(auditDir).filter((n) => n.endsWith(".jsonl") && n !== "events.jsonl");
	} catch {
		// Not enumerable: with events.jsonl also absent, "Audit log not found" returns before the vault reading.
		enumerated = false;
	}
	if (existsSync(join(auditDir, "events.jsonl"))) names.unshift("events.jsonl");
	let empty = true;
	const seqFile = new Map<number, string>();
	for (const name of names) {
		const text = readFileSync(join(auditDir, name), "utf-8").trim();
		empty &&= text === "";
		for (const l of text.split("\n")) {
			try {
				const seq = JSON.parse(l)?.sequence;
				if (Number.isSafeInteger(seq) && !seqFile.has(seq)) seqFile.set(seq, name);
			} catch {}
		}
	}
	return { count: names.length, empty, enumerated, seqFile };
}

/**
 * Each `Sequence gap: event X follows Y` the vault reading reported, NAMED: the absent range Y+1..X-1 and the files
 * holding Y and X. The names come from the verdict's own sequences, not from each file's first and last lines, so an
 * out-of-order segment cannot misname a gap; if either sequence is not in the (second) read of the files, the file
 * names are omitted rather than guessed.
 */
function nameGaps(errors: readonly string[], seqFile: ReadonlyMap<number, string>): string[] {
	const out: string[] = [];
	for (const e of errors) {
		const m = /^Sequence gap: event (\d+) follows (\d+)/.exec(e);
		if (m === null) continue;
		const [x, y] = [Number(m[1]), Number(m[2])];
		// A duplicated sequence reads "event 1 follows 1": no event is absent, so it keeps only the verdict's own error.
		if (!(x > y + 1)) continue;
		const [fileY, fileX] = [seqFile.get(y), seqFile.get(x)];
		const range = x - y === 2 ? `event ${y + 1} is` : `events ${y + 1}..${x - 1} are`;
		if (fileY === undefined || fileX === undefined)
			out.push(`audit events missing: ${range} absent`);
		else if (fileY === fileX)
			out.push(`audit events missing: ${range} absent inside ${fileY} (between ${y} and ${x})`);
		else
			out.push(
				`audit segment missing: ${range} absent between ${fileY} (ends at ${y}) and ${fileX} (starts at ${x})`,
			);
	}
	return out;
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
	const mainLog = join(vaultPath, "audit", "events.jsonl");
	// EVERY segment: a rotated transfer straddles files, and the live file alone lacks its history.
	const segments = auditSegments(join(vaultPath, "audit"));
	// An empty live log is a clean, empty reading only when the directory was listed: an unlistable one may
	// hold the records in segments, so it falls through to the vault reading, which reports the enumeration error.
	if (segments.count === 0 || (segments.empty && segments.enumerated)) {
		// No log at all means nothing could be read; an empty log is a clean, empty reading.
		const error = segments.count === 0 ? `Audit log not found: ${mainLog}` : "Audit log is empty";
		// An empty log is a complete reading only beside an anchor that agrees it is empty: absent, or at
		// sequence 0 on the genesis hash. An anchor that records events, or cannot be read, means the
		// records are gone, and the receipt must not assert the transfer never existed.
		const anchor = readAnchor(`${mainLog}.meta`);
		const anchorClean =
			anchor === null ||
			(!("corrupt" in anchor) && anchor.sequence === 0 && anchor.lastHash === GENESIS_HASH);
		return {
			found: false,
			valid: false,
			receipt: renderNotFound(txId, segments.count !== 0 && anchorClean),
			errors: [error],
		};
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

	// The events AND the verdict come from one vault reading, in the chain verifier's order.
	const reading = verifyVaultReading(vaultPath);
	const all = reading.events.map(normalizeEvent);
	// The reading's events are the walked ones (one per leaf, in chain order) followed by the events
	// left out of the walk. The transfer is matched over the WALKED events: they alone decide its
	// status, its terminal and its leaf. A record left out of the walk is not part of the checked
	// chain, so it never changes a transfer that has a walked record. Only a transfer with NO walked
	// record is matched over the rest, and is then reported as outside the checked chain: found
	// (it is on file), with no leaf, no proof and no anchored claim.
	const events = all.slice(0, reading.orderedHashes.length);
	// No per-use shape guard needed: `normalizeEvent` already guarantees `kind`
	// is a string, `data` is an object, and `transferId` is a string.
	// `settlement_unrecoverable` stores only the SHA-256 of its transferId, so that kind matches on the
	// hash of the queried id (`matchesTransfer`).
	const txHash = transferIdHash(txId);
	const walkedMatching = events.filter((e) => matchesTransfer(e, txId, txHash));
	const outsideMatching =
		walkedMatching.length === 0
			? all.slice(events.length).filter((e) => matchesTransfer(e, txId, txHash))
			: [];
	const outsideCheckedChain = outsideMatching.length > 0;
	const matching = outsideCheckedChain ? outsideMatching : walkedMatching;
	const firstTerminal = firstTerminalOf(matching);
	const targetEvent = selectTransferEvent(matching);

	// SCRUBBED: segment names and event ids are vault text, and these errors reach a terminal. A gap
	// is named even when the target is absent: its records may be what the missing segment held.
	const vaultErrors = [
		...reading.result.errors,
		...nameGaps(reading.result.errors, segments.seqFile),
	];
	if (targetEvent === undefined) {
		const errors = vaultErrors.map(scrubForError);
		// The absolute sentence only for a reading with no errors: a missing segment, an unreadable
		// directory or a failed chain may hold the records that were asked for.
		const receipt = renderNotFound(txId, vaultErrors.length === 0);
		return { found: false, valid: false, receipt, errors };
	}

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
	// Set ONLY where inclusion is proven against a verified anchor root; every other branch leaves it false.
	let inclusionVerified = false;

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
		// A target outside the checked chain has no leaf: no proof is ever built for it.
		if (!outsideCheckedChain && (state === "ANCHORED_VERIFIED" || state === "ANCHOR_STALE")) {
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
				inclusionVerified = ok;
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
	// Outside the checked chain: no leaf, so no Merkle claim of any kind, consistent or anchored.
	if (outsideCheckedChain) {
		merkleVerified = false;
		merkleLabel = "NO LEAF (NOT IN THE CHAIN)";
		inclusionVerified = false;
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
		...(outsideCheckedChain ? { outsideCheckedChain: true as const } : {}),
	};

	const allErrors = [...vaultErrors, ...anchorErrors].map(scrubForError);

	return {
		found: true,
		valid: chainVerified && merkleVerified && anchorsValid,
		receipt: renderReceipt(receiptData),
		status: eventStatus(targetEvent),
		errors: allErrors,
		inclusionVerified: inclusionVerified && chainVerified && anchorsValid,
		...(outsideCheckedChain ? { outsideCheckedChain: true as const } : {}),
		...(anchorState !== undefined ? { anchorState } : {}),
		...(anchoring !== undefined ? { anchoring } : {}),
	};
}
