// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * ONE classification of the audit chain's tail against its `.meta` anchor, shared by everything
 * that reads or writes the chain: the writer (which proceeds, rolls its anchor forward, or refuses),
 * `quarantine-tail`, `verify` and `health`.
 *
 * The writer used to ADOPT whatever last line it found and rewrite `.meta` to it, so a truncation, a
 * replaced tail or extra events became the anchored truth at the next call, and `verify` passed over
 * the shortened chain. Here every (inventory, log, anchor) observation maps to exactly one named
 * state, and only three of them let a writer go on: `FRESH`, `MATCH`, and `ONE_PAST_ANCHOR` (a write
 * interrupted between its log append and its anchor update, which it rolls forward). Every other
 * state refuses; nothing is ever appended over a disagreement.
 *
 * Pure: no filesystem access. Callers acquire the observations (see `tail-read.ts` and
 * `stable-read.ts`) and pass them in. Total: it never throws; an input it cannot read is a state.
 * No catch-all: every branch returns a named state.
 *
 * Not judged here: the middle of the chain. A deletion or an edit before the tail is `verify`'s
 * (links, sequence, hashes, the count). The writer reads the tail only.
 *
 * IDENTICAL in packages/core/src/audit/tail-state.ts and packages/verify/src/tail-state.ts (the
 * file-diff test pins them, import lines aside).
 */

import { createHash } from "node:crypto";
import { GENESIS_HASH } from "../shared/constants.js";
import { canonicalize } from "./canonical.js";

/** The file kinds a vault file must not be. */
export type FileKind = "symlink" | "directory" | "fifo" | "socket" | "device" | "other";

/** What acquiring one file found: never read blind (see `tail-read.ts`). */
export type FileObservation =
	| { kind: "absent" }
	| { kind: "not_regular"; fileKind: FileKind }
	| { kind: "unavailable"; code: string }
	| { kind: "oversize"; size: number }
	| { kind: "read"; bytes: Buffer };

/** What listing one directory found. */
export type InventoryObservation =
	| { kind: "ok"; names: readonly string[] }
	| { kind: "missing" }
	| { kind: "unreadable"; code: string }
	| { kind: "oversize"; count: number };

/** The log as read: its last complete lines (or all of them), and the bytes after its last newline. */
export interface LogTail {
	/** Complete lines (each without its newline), in file order: the last two at most, or all. */
	lines: readonly Buffer[];
	/** Whether `lines` begins at the file's first line, so that `lines.length` IS the line count. */
	fromStart: boolean;
	/** The number of complete lines, when it is known without `fromStart` (a counted legacy log). */
	count?: number;
	/** Bytes after the last newline (empty when the log ends with one). */
	trailing: Buffer;
	/** The byte offset at which `trailing` starts. */
	trailingOffset: number;
}

export type LogObservation =
	| { kind: "absent" }
	| { kind: "not_regular"; fileKind: FileKind }
	| { kind: "unavailable"; code: string }
	| { kind: "oversize"; size: number }
	| { kind: "tail"; tail: LogTail };

/** Everything one classification looks at. */
export interface TailSnapshot {
	/** The names in `audit/`. */
	audit: InventoryObservation;
	/** The names in `audit/quarantine/` (`missing` is ordinary: no recovery ever ran). */
	quarantine: InventoryObservation;
	/** `audit/events.jsonl`. */
	log: LogObservation;
	/** `audit/events.jsonl.meta`. */
	anchor: FileObservation;
}

/** How a classification is used: the writer refuses any vault with more than one segment. */
export type ClassifyMode = "writer" | "reader";

export type TailStateName =
	| "INVENTORY_UNREADABLE"
	| "RECOVERY_PENDING"
	| "LOG_UNREADABLE"
	| "LOG_NOT_REGULAR"
	| "TAIL_OVERSIZE"
	| "SEGMENTED"
	| "ANCHOR_UNREADABLE"
	| "FRESH"
	| "LOG_EMPTY_ANCHOR_RECORDS_EVENTS"
	| "TAIL_UNPARSEABLE"
	| "TAIL_NOT_AN_EVENT"
	| "TAIL_MALFORMED"
	| "CORRUPT_TAIL"
	| "ONE_PAST_ANCHOR"
	| "ANCHOR_MISSING"
	| "MATCH"
	| "HEAD_MISMATCH"
	| "FEWER_THAN_ANCHOR"
	| "UNCHAINED_PAST_ANCHOR"
	| "MORE_THAN_ONE_PAST_ANCHOR"
	| "SEQUENCE_EXHAUSTED";

/** The kinds of bytes after a log's last newline. */
export type TrailingKind = "fragment" | "non_event" | "unterminated_event";

export interface TailState {
	/** The state of the log's complete lines against the anchor. */
	state: TailStateName;
	/** Bytes after the log's last newline, when there are any: a writer refuses them in every state. */
	torn: { kind: TrailingKind; offset: number; length: number } | null;
	/** The last complete event's sequence and hash, when the last line is an event. */
	found: { sequence: number; hash: string } | null;
	/** The anchor, when it is valid. */
	anchored: { sequence: number; lastHash: string } | null;
	/** One line for a person: what the state means. */
	note: string;
}

/** The anchor's largest size: it holds one hash and one number. */
export const MAX_ANCHOR_BYTES = 4096;

const HEX64 = /^[0-9a-f]{64}$/;

// ── Parsing, total ──

/** One complete log line, judged before any field of it is read. */
export type ParsedLine =
	| {
			kind: "event";
			event: Record<string, unknown>;
			hash: string;
			previousHash: string;
			sequence: number | undefined;
	  }
	| { kind: "unparseable" }
	| { kind: "non_event" }
	| { kind: "malformed" };

/**
 * Parse one log line. `non_event`: JSON that is not an object with string `hash` and
 * `previousHash` (`null`, a number, an array, `{}`). `malformed`: an event whose `sequence` is present
 * but not a positive safe integer (`"10"`, `1.5`, `2 ** 53`). An event without `sequence` is a legacy
 * event: its sequence is its position, which only the caller knows.
 */
export function parseLine(line: Buffer | string): ParsedLine {
	let value: unknown;
	try {
		value = JSON.parse(typeof line === "string" ? line : line.toString("utf8"));
	} catch {
		return { kind: "unparseable" };
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return { kind: "non_event" };
	const event = value as Record<string, unknown>;
	const { hash, previousHash } = event;
	if (typeof hash !== "string" || typeof previousHash !== "string") return { kind: "non_event" };
	if (!("sequence" in event) || event.sequence === undefined) {
		return { kind: "event", event, hash, previousHash, sequence: undefined };
	}
	const sequence = event.sequence;
	if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
		return { kind: "malformed" };
	}
	return { kind: "event", event, hash, previousHash, sequence };
}

/**
 * Whether an event's stored hash is the writer's own hash of it: `sha256(canonicalize(event - hash))`.
 * Total: an event `canonicalize` refuses (a nested `1e400` parses to Infinity) does not hold.
 */
export function eventHashHolds(event: Record<string, unknown>): boolean {
	const { hash, ...rest } = event;
	if (typeof hash !== "string") return false;
	try {
		return createHash("sha256").update(canonicalize(rest)).digest("hex") === hash;
	} catch {
		return false;
	}
}

/** The kind of bytes after the last newline. */
export function trailingKind(trailing: Buffer): TrailingKind {
	const parsed = parseLine(trailing);
	if (parsed.kind === "unparseable") return "fragment";
	if (parsed.kind === "event" || parsed.kind === "malformed") return "unterminated_event";
	return "non_event";
}

/** The anchor's parsed value, or why it is not one. */
export type AnchorReading =
	| { kind: "absent" }
	| { kind: "valid"; sequence: number; lastHash: string }
	| { kind: "unreadable"; why: string };

/** Read the anchor observation: a JSON object with a 64-hex `lastHash` and a non-negative safe-integer `sequence`. */
export function readAnchorObservation(anchor: FileObservation): AnchorReading {
	switch (anchor.kind) {
		case "absent":
			return { kind: "absent" };
		case "not_regular":
			return { kind: "unreadable", why: `it is a ${anchor.fileKind}, not a regular file` };
		case "unavailable":
			return { kind: "unreadable", why: `it cannot be read (${anchor.code})` };
		case "oversize":
			return { kind: "unreadable", why: `it is ${anchor.size} bytes, over ${MAX_ANCHOR_BYTES}` };
		case "read": {
			let value: unknown;
			try {
				value = JSON.parse(anchor.bytes.toString("utf8"));
			} catch {
				return { kind: "unreadable", why: "it is not JSON" };
			}
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				return { kind: "unreadable", why: "it is not a JSON object" };
			}
			const { lastHash, sequence } = value as { lastHash?: unknown; sequence?: unknown };
			if (typeof lastHash !== "string" || !HEX64.test(lastHash)) {
				return { kind: "unreadable", why: "its lastHash is not a 64-hex hash" };
			}
			if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
				return { kind: "unreadable", why: "its sequence is not a non-negative safe integer" };
			}
			return { kind: "valid", sequence, lastHash };
		}
		default:
			return assertNever(anchor);
	}
}

function assertNever(value: never): never {
	throw new Error(`tail-state: unreachable ${JSON.stringify(value)}`);
}

// ── The classification ──

function result(
	state: TailStateName,
	note: string,
	extra: Partial<Omit<TailState, "state" | "note">> = {},
): TailState {
	return {
		state,
		torn: extra.torn ?? null,
		found: extra.found ?? null,
		anchored: extra.anchored ?? null,
		note,
	};
}

/**
 * Classify one snapshot. In `writer` mode a vault with another `*.jsonl` beside `events.jsonl` is
 * `SEGMENTED` (core never rotates the log); in `reader` mode the caller hands in the GLOBAL chain's
 * tail (every segment, in order) as the log.
 */
export function classifyAuditTail(snapshot: TailSnapshot, mode: ClassifyMode): TailState {
	const { audit, quarantine, log, anchor } = snapshot;
	if (audit.kind === "unreadable" || audit.kind === "oversize") {
		return result("INVENTORY_UNREADABLE", "the audit directory cannot be listed");
	}
	if (quarantine.kind === "unreadable" || quarantine.kind === "oversize") {
		return result("INVENTORY_UNREADABLE", "the audit quarantine directory cannot be listed");
	}
	if (quarantine.kind === "ok" && quarantine.names.includes("PENDING")) {
		return result(
			"RECOVERY_PENDING",
			"a recovery was interrupted (audit/quarantine/PENDING): nothing may append until it finishes",
		);
	}
	switch (log.kind) {
		case "unavailable":
			return result("LOG_UNREADABLE", `the audit log cannot be read (${log.code})`);
		case "not_regular":
			return result("LOG_NOT_REGULAR", `the audit log is a ${log.fileKind}, not a regular file`);
		case "oversize":
			return result(
				"TAIL_OVERSIZE",
				`the audit log's last lines are over the read limit (${log.size} bytes)`,
			);
		case "absent":
		case "tail":
			break;
		default:
			return assertNever(log);
	}
	if (
		mode === "writer" &&
		audit.kind === "ok" &&
		audit.names.some((name) => name.endsWith(".jsonl") && name !== "events.jsonl")
	) {
		return result(
			"SEGMENTED",
			"the audit directory holds another log segment beside events.jsonl; this writer does not write rotated vaults",
		);
	}
	const reading = readAnchorObservation(anchor);
	if (reading.kind === "unreadable") {
		return result("ANCHOR_UNREADABLE", `the audit anchor (.meta) is unreadable: ${reading.why}`);
	}
	const anchored =
		reading.kind === "valid" ? { sequence: reading.sequence, lastHash: reading.lastHash } : null;

	const tail: LogTail =
		log.kind === "tail"
			? log.tail
			: { lines: [], fromStart: true, trailing: Buffer.alloc(0), trailingOffset: 0 };
	const torn =
		tail.trailing.length > 0
			? {
					kind: trailingKind(tail.trailing),
					offset: tail.trailingOffset,
					length: tail.trailing.length,
				}
			: null;
	const n = tail.fromStart ? tail.lines.length : tail.count;

	// No complete line: an absent or empty log (or one holding only torn bytes).
	if (tail.lines.length === 0) {
		if (anchored === null) return result("FRESH", "an empty chain", { torn });
		if (anchored.sequence === 0 && anchored.lastHash === GENESIS_HASH) {
			return result("FRESH", "an empty chain under its genesis anchor", { torn, anchored });
		}
		if (anchored.sequence === 0) {
			return result("ANCHOR_UNREADABLE", "the anchor records no events but a non-genesis head", {
				torn,
			});
		}
		return result(
			"LOG_EMPTY_ANCHOR_RECORDS_EVENTS",
			`the log has no complete event; its anchor records ${anchored.sequence}`,
			{ torn, anchored },
		);
	}

	const lastLine = tail.lines[tail.lines.length - 1] as Buffer;
	const last = parseLine(lastLine);
	if (last.kind === "unparseable") {
		return result("TAIL_UNPARSEABLE", "the log's last line is not JSON", { torn, anchored });
	}
	if (last.kind === "non_event") {
		return result("TAIL_NOT_AN_EVENT", "the log's last line is JSON but not an audit event", {
			torn,
			anchored,
		});
	}
	if (last.kind === "malformed") {
		return result(
			"TAIL_MALFORMED",
			"the log's last event carries a sequence that is not a positive safe integer",
			{
				torn,
				anchored,
			},
		);
	}
	if (!eventHashHolds(last.event)) {
		return result("CORRUPT_TAIL", "the log's last event does not match its own hash", {
			torn,
			anchored,
		});
	}
	// A legacy event (no `sequence`) is at its position; the caller counts lines for one.
	const lastSeq = last.sequence ?? n;
	if (lastSeq === undefined) {
		return result(
			"TAIL_MALFORMED",
			"the log's last event has no sequence and its position is unknown",
			{
				torn,
				anchored,
			},
		);
	}
	const found = { sequence: lastSeq, hash: last.hash };
	const prevLine =
		tail.lines.length >= 2 ? (tail.lines[tail.lines.length - 2] as Buffer) : undefined;
	const onlyLine = n === 1;

	if (anchored === null) {
		if (onlyLine && lastSeq === 1 && last.previousHash === GENESIS_HASH) {
			return exhaustedOr(
				result(
					"ONE_PAST_ANCHOR",
					"the first event's anchor update did not land; the next write rolls it forward",
					{
						torn,
						found,
					},
				),
			);
		}
		return result(
			"ANCHOR_MISSING",
			`no anchor on a chain of ${n ?? "several"} events: deleted, or every write of it failed`,
			{ torn, found },
		);
	}

	if (lastSeq === anchored.sequence) {
		if (last.hash === anchored.lastHash) {
			return exhaustedOr(
				result("MATCH", "the log's last event is the anchored head", { torn, found, anchored }),
			);
		}
		return result("HEAD_MISMATCH", "the log's last event is not the anchored one", {
			torn,
			found,
			anchored,
		});
	}
	if (lastSeq < anchored.sequence) {
		return result(
			"FEWER_THAN_ANCHOR",
			`the log ends at sequence ${lastSeq}; its anchor records ${anchored.sequence} events: events after ${lastSeq} are missing`,
			{ torn, found, anchored },
		);
	}
	if (lastSeq === anchored.sequence + 1) {
		const chains = last.previousHash === anchored.lastHash;
		let predecessorIsTheHead: boolean;
		if (prevLine !== undefined) {
			const prev = parseLine(prevLine);
			const prevSeq =
				prev.kind === "event"
					? (prev.sequence ?? (n === undefined ? undefined : n - 1))
					: undefined;
			predecessorIsTheHead =
				prev.kind === "event" &&
				eventHashHolds(prev.event) &&
				prev.hash === anchored.lastHash &&
				prevSeq === anchored.sequence;
		} else {
			predecessorIsTheHead =
				onlyLine && anchored.sequence === 0 && anchored.lastHash === GENESIS_HASH;
		}
		if (chains && predecessorIsTheHead) {
			return exhaustedOr(
				result(
					"ONE_PAST_ANCHOR",
					"one event past the anchor: a write interrupted between its append and its anchor update; the next write rolls the anchor forward",
					{ torn, found, anchored },
				),
			);
		}
		return result("UNCHAINED_PAST_ANCHOR", "one event past the anchor does not chain from it", {
			torn,
			found,
			anchored,
		});
	}
	return result(
		"MORE_THAN_ONE_PAST_ANCHOR",
		`${lastSeq - anchored.sequence} events past the anchor: an unexplained discrepancy (an older version could leave this after repeated anchor failures)`,
		{ torn, found, anchored },
	);
}

/** A state the writer would proceed from, unless the next sequence would not be a safe integer. */
function exhaustedOr(state: TailState): TailState {
	if (state.found !== null && !Number.isSafeInteger(state.found.sequence + 1)) {
		return {
			...state,
			state: "SEQUENCE_EXHAUSTED",
			note: "the next sequence would not be a safe integer",
		};
	}
	return state;
}

/** What the writer does in a state: go on, roll its anchor forward first, or refuse. */
export function writerAction(state: TailState): "proceed" | "roll_forward" | "refuse" {
	if (state.torn !== null) return "refuse";
	switch (state.state) {
		case "FRESH":
		case "MATCH":
			return "proceed";
		case "ONE_PAST_ANCHOR":
			return "roll_forward";
		case "INVENTORY_UNREADABLE":
		case "RECOVERY_PENDING":
		case "LOG_UNREADABLE":
		case "LOG_NOT_REGULAR":
		case "TAIL_OVERSIZE":
		case "SEGMENTED":
		case "ANCHOR_UNREADABLE":
		case "LOG_EMPTY_ANCHOR_RECORDS_EVENTS":
		case "TAIL_UNPARSEABLE":
		case "TAIL_NOT_AN_EVENT":
		case "TAIL_MALFORMED":
		case "CORRUPT_TAIL":
		case "ANCHOR_MISSING":
		case "HEAD_MISMATCH":
		case "FEWER_THAN_ANCHOR":
		case "UNCHAINED_PAST_ANCHOR":
		case "MORE_THAN_ONE_PAST_ANCHOR":
		case "SEQUENCE_EXHAUSTED":
			return "refuse";
		default:
			return assertNever(state.state);
	}
}

// ── The verdict a verifier gives ──

/**
 * The errors a verifier adds for a chain whose tail is `tail`, read with the anchor `anchor`, over
 * `count` events. The states reported line by line or file by file before this (bytes after the last
 * newline, a line that is not an event) add none, unless nothing else was reported (`errorsSoFar`):
 * no refused state is ever clean. The states only the tail shows name themselves. And the COUNT: the
 * anchor records how many events the chain holds, one more under an interrupted write's anchor;
 * short is truncation, long is events the anchor never recorded. Shared by every verifier entry point,
 * so one state is never worded two ways.
 */
export function verdictErrors(
	tail: TailState,
	anchor: FileObservation,
	count: number,
	errorsSoFar: number,
): string[] {
	const errors = stateErrors(tail, anchor, count, errorsSoFar);
	const anchored = tail.anchored;
	if (anchored !== null && tail.state !== "LOG_EMPTY_ANCHOR_RECORDS_EVENTS") {
		const expected = anchored.sequence + (tail.state === "ONE_PAST_ANCHOR" ? 1 : 0);
		if (count !== expected) {
			errors.push(
				`anchor mismatch: expected ${expected} event(s), found ${count} (${
					count < expected ? "truncation/deletion" : "more events than the anchor records"
				})`,
			);
		}
	}
	return errors;
}

function stateErrors(
	tail: TailState,
	anchor: FileObservation,
	count: number,
	errorsSoFar: number,
): string[] {
	switch (tail.state) {
		case "FRESH":
		case "MATCH":
		case "ONE_PAST_ANCHOR":
		case "SEQUENCE_EXHAUSTED":
			return [];
		case "RECOVERY_PENDING":
			return [
				"Audit recovery interrupted: audit/quarantine/PENDING is present (finish the recovery, then verify again)",
			];
		case "ANCHOR_UNREADABLE": {
			const reading = readAnchorObservation(anchor);
			return [
				`Audit anchor (.meta) present but corrupt${reading.kind === "unreadable" ? `: ${reading.why}` : ""}`,
			];
		}
		case "LOG_EMPTY_ANCHOR_RECORDS_EVENTS":
			return [
				`Audit log missing but anchor records ${tail.anchored?.sequence ?? "some"} event(s) (deletion detected)`,
			];
		case "ANCHOR_MISSING":
			return [
				`Audit anchor (.meta) missing on a chain of ${count} event(s): deleted, or every write of it failed`,
			];
		case "HEAD_MISMATCH":
		case "FEWER_THAN_ANCHOR":
			return [
				`anchor mismatch: expected last hash ${tail.anchored?.lastHash}, got ${tail.found?.hash} (tail truncation)`,
			];
		case "UNCHAINED_PAST_ANCHOR":
			return [
				`anchor mismatch: the event after the anchored head (sequence ${tail.found?.sequence}) does not chain from it`,
			];
		case "MORE_THAN_ONE_PAST_ANCHOR":
			return [
				`anchor mismatch: ${(tail.found?.sequence ?? 0) - (tail.anchored?.sequence ?? 0)} events past the anchor, an unexplained discrepancy (an older version could leave this after repeated anchor failures)`,
			];
		case "INVENTORY_UNREADABLE":
		case "LOG_UNREADABLE":
		case "LOG_NOT_REGULAR":
		case "TAIL_OVERSIZE":
		case "SEGMENTED":
		case "TAIL_UNPARSEABLE":
		case "TAIL_NOT_AN_EVENT":
		case "TAIL_MALFORMED":
		case "CORRUPT_TAIL":
			return errorsSoFar > 0 ? [] : [`audit tail ${tail.state}: ${tail.note}`];
		default:
			return assertNever(tail.state);
	}
}
