// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Dead-lettered chain events: the audit events that never reached the chain.
 *
 * When an append fails, the writer writes the event to `<vault>/dlq/dead-letters.jsonl` (source
 * `audit.chain.appendEvent`) and the call goes on (unless `audit.failClosed`): the money moved, the
 * chain has no record of it. The chain itself cannot show that — a chain with an event missing
 * still verifies, link by link — so `usertrust verify` and `usertrust health` read this file beside
 * it, and a vault with a missing event is reported INCOMPLETE.
 *
 * A dead letter whose `eventHash` names an event on the chain, and that event is the dead-lettered
 * one (the same kind, actor and data), is not missing: its bytes reached the chain before the
 * failure (the `.meta` sidecar failed after the fsync). One without an `eventHash` (written before it
 * was recorded, or for an event that never reached the log), or whose `eventHash` names another
 * event, counts as missing. A line that is not a dead letter this code can read counts as missing too: a gap the
 * reader cannot rule out is reported, never assumed away.
 *
 * Each dead letter carries the writer's SHA-256 over its own content (`checksum`, corruption
 * detection, not tamper-evidence). It is recomputed here exactly as the writer computes it, and a
 * record that fails it is UNREADABLE: counted missing whatever its `source` or `eventHash` say, since
 * a corrupted `source` would otherwise hide a lost event. A record without a checksum is not one the
 * writer wrote (every release since the checksum was added writes it), and is read the same way.
 *
 * READ-ONLY, like every reader and verifier: nothing here writes to the vault.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalize } from "./canonical.js";
import { acquireWholeFile, listDirectory, MAX_INVENTORY_NAMES, splitLines } from "./tail-read.js";

/** The `source` the chain writer stamps on a dead-lettered append. */
export const CHAIN_APPEND_DEAD_LETTER_SOURCE = "audit.chain.appendEvent";

export interface ChainDeadLetters {
	/** The file read: `<vault>/dlq/dead-letters.jsonl`. */
	path: string;
	/** Dead-lettered chain events not on the chain, plus unreadable lines (each a possible one). */
	missing: number;
	/** `missing`, by the dead-lettered event's `kind` (`"<unreadable>"` for a line that did not parse). */
	missingByKind: Record<string, number>;
	/** The `transferId` of each missing event that names one, in file order. */
	missingTransferIds: string[];
	/** Dead letters of chain events whose bytes reached the chain after all (their `eventHash` is that event). */
	onChain: number;
	/** Lines from another source: not chain events, reported for completeness only. */
	otherSources: number;
}

/** What the reader compares of the chain's event at a dead letter's `eventHash`. */
export interface ChainEventView {
	kind?: unknown;
	actor?: unknown;
	data?: unknown;
}

/** The file could not be read: whether events are missing is unknown, which is not "none". */
export interface ChainDeadLettersUnreadable {
	path: string;
	unreadable: string;
}

/**
 * Read `<vaultDir>/dlq/dead-letters.jsonl` (`vaultDir` is the `.usertrust` directory, as
 * `verifyVault` takes it). `eventAt` returns the vault's chain event with a hash, if there is one.
 * No file: nothing was ever dead-lettered, and nothing is missing. A file that exists but cannot be
 * read is reported as such, never as empty.
 */
export function readChainDeadLetters(
	vaultDir: string,
	eventAt: (hash: string) => ChainEventView | undefined,
): ChainDeadLetters | ChainDeadLettersUnreadable {
	const dlqDir = join(vaultDir, "dlq");
	const path = join(dlqDir, "dead-letters.jsonl");
	// Acquired, never read blind: through no link (a dangling link is not "no queue"), never
	// blocking on a FIFO, only as a regular file, and within a bound. Absent: nothing was ever
	// dead-lettered, unless the queue's DIRECTORY is a link that leads nowhere (or cannot be listed):
	// the file is then not known to be absent, only unreachable.
	const file = acquireWholeFile(path).file;
	const dir = file.kind === "absent" ? listDirectory(dlqDir, MAX_INVENTORY_NAMES, true) : undefined;
	if (dir !== undefined && dir.kind !== "missing" && dir.kind !== "ok") {
		return {
			path,
			unreadable:
				dir.kind === "unreadable"
					? `its directory cannot be read (${dir.code})`
					: "its directory cannot be read",
		};
	}
	if (file.kind === "absent") {
		return {
			path,
			missing: 0,
			missingByKind: Object.create(null) as Record<string, number>,
			missingTransferIds: [],
			onChain: 0,
			otherSources: 0,
		};
	}
	if (file.kind !== "read") {
		return {
			path,
			unreadable:
				file.kind === "not_regular"
					? `a ${file.fileKind}, not a regular file`
					: file.kind === "unavailable"
						? file.code
						: file.kind === "oversize"
							? `${file.size} bytes, over the bound for one read`
							: "read failed",
		};
	}
	const result: ChainDeadLetters = {
		path,
		missing: 0,
		// No prototype: an event kind is caller text, and `constructor` or `__proto__` must count like
		// any other kind, never read an inherited property or vanish into the prototype.
		missingByKind: Object.create(null) as Record<string, number>,
		missingTransferIds: [],
		onChain: 0,
		otherSources: 0,
	};
	const countMissing = (kind: string, transferId: unknown) => {
		result.missing++;
		result.missingByKind[kind] = (result.missingByKind[kind] ?? 0) + 1;
		if (typeof transferId === "string" && transferId !== "")
			result.missingTransferIds.push(transferId);
	};
	// Split as bytes and decoded one line at a time: a queue over V8's string limit (512 MiB) cannot
	// be decoded whole, and a line that cannot be decoded is an unreadable letter, never a crash.
	const { lines, trailing } = splitLines(file.bytes);
	for (const bytes of trailing.length > 0 ? [...lines, trailing] : lines) {
		let entry: unknown;
		try {
			const line = bytes.toString("utf-8");
			if (line.trim() === "") continue;
			entry = JSON.parse(line);
		} catch {
			countMissing("<unreadable>", undefined);
			continue;
		}
		if (entry === null || typeof entry !== "object") {
			countMissing("<unreadable>", undefined);
			continue;
		}
		if (!checksumHolds(entry as Record<string, unknown>)) {
			countMissing("<unreadable>", undefined);
			continue;
		}
		const e = entry as { source?: unknown; eventHash?: unknown; payload?: unknown };
		if (e.source !== CHAIN_APPEND_DEAD_LETTER_SOURCE) {
			if (typeof e.source === "string") {
				result.otherSources++;
			} else {
				countMissing("<unreadable>", undefined);
			}
			continue;
		}
		const payload = (e.payload ?? {}) as ChainEventView;
		if (typeof e.eventHash === "string" && isThisEvent(eventAt(e.eventHash), payload)) {
			result.onChain++;
			continue;
		}
		const kind =
			typeof payload.kind === "string" && payload.kind !== "" ? payload.kind : "<unknown>";
		const data = (payload.data ?? {}) as { transferId?: unknown };
		countMissing(kind, data.transferId);
	}
	return result;
}

/**
 * Whether a dead letter's `checksum` is the SHA-256 the writer computed over the rest of it: over
 * `canonicalize(rest)`, or over `JSON.stringify(rest)` where canonicalize could not run (a `NaN` in
 * the payload — which JSON then holds as `null`, so the writer's fallback string is reproduced from
 * the parsed record). `rest` is the record without `checksum` and `checksumAlg`, in its own key
 * order. Absent, or of another algorithm, it does not hold.
 */
function checksumHolds(entry: Record<string, unknown>): boolean {
	const { checksum, checksumAlg } = entry;
	if (typeof checksum !== "string" || (checksumAlg !== undefined && checksumAlg !== "sha256")) {
		return false;
	}
	const rest: Record<string, unknown> = {};
	for (const key of Object.keys(entry)) {
		if (key !== "checksum" && key !== "checksumAlg") rest[key] = entry[key];
	}
	const sha = (text: string) => createHash("sha256").update(text).digest("hex");
	let canonical: string | undefined;
	try {
		canonical = canonicalize(rest);
	} catch {
		canonical = undefined;
	}
	if (canonical !== undefined && sha(canonical) === checksum) return true;
	try {
		return sha(JSON.stringify(rest)) === checksum;
	} catch {
		// A record nested past the serializer's depth (it parsed, but neither form can be rebuilt):
		// unreadable, and counted missing, never a crash that leaves verify with no verdict.
		return false;
	}
}

/**
 * Whether `onChain`, the chain's event at a dead letter's `eventHash`, is the dead-lettered event
 * itself: the same kind, actor and data. A checksum shows that a record is whole, not that it is
 * true, so an `eventHash` naming some other event on the chain does not put this one there.
 */
function isThisEvent(onChain: ChainEventView | undefined, payload: ChainEventView): boolean {
	if (onChain === undefined || onChain.kind !== payload.kind) return false;
	try {
		return (
			canonicalize(onChain.actor) === canonicalize(payload.actor) &&
			canonicalize(onChain.data) === canonicalize(payload.data)
		);
	} catch {
		return false;
	}
}

/** One line for a human: how many events are missing, by kind, and where they are. */
export function describeMissingEvents(d: ChainDeadLetters): string {
	const kinds = Object.entries(d.missingByKind)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([kind, n]) => `${kind} ×${n}`)
		.join(", ");
	return `${d.missing} audit event${d.missing === 1 ? "" : "s"} never reached the chain (${kinds}); they are dead-lettered in ${d.path}`;
}
