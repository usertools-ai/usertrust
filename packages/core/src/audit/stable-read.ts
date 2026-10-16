// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * ONE snapshot of a vault's audit files, read without the writer's lock (`verify`, `health`), and
 * consistent: every phase of a verdict reads from it, never from the files again.
 *
 * An attempt is BRACKETED: both inventories, then the anchor (and the anchor mirror, when asked for),
 * then every segment (its identity and size before and after its bytes), then the anchor (and the
 * mirror) again, then both inventories again. It is consistent only when the two readings of each
 * agree and no segment changed while it was read:
 * a recovery that publishes its intent and cuts the log, or an append that lands, between two of
 * those reads is caught, and the attempt is made again (up to `attempts`, `delayMs` apart).
 *
 * A consistent snapshot is FINAL unless it ends in bytes after a newline (a torn tail) while a
 * writer may hold the vault's lock, judged both before and after the attempt (a writer that finished
 * its line and let go during the attempt was mid-write when the bytes were read): that is what an
 * append in flight looks like, so it is read again. A torn tail that stays byte-identical through
 * EVERY attempt under a live writer, with no attempt inconsistent, is reported as such
 * (`torn_writer_live`: torn, or a write in progress; stop the writer to classify it), never as clean
 * and never as busy. Anything that keeps CHANGING is `busy`: no verdict. Elapsed time is never taken as
 * proof that a write completed. With no live writer, nothing can be mid-write, so a consistent
 * snapshot is final as found.
 *
 * Whether a writer may hold the lock is judged read-only from the lock file, as the writer judges
 * it: its PID, its kernel boot id and its PID namespace. A lock that cannot be read, or names a
 * process this one cannot probe, counts as live: it cannot prove there is none.
 *
 * IDENTICAL in packages/core/src/audit/stable-read.ts and packages/verify/src/stable-read.ts (the
 * file-diff test pins them, import lines aside).
 */

import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
	acquireSmallFile,
	acquireWholeFile,
	listDirectory,
	MAX_INVENTORY_NAMES,
	MAX_SEGMENT_BYTES,
	MAX_SNAPSHOT_BYTES,
} from "./tail-read.js";
import { type FileObservation, type InventoryObservation, MAX_ANCHOR_BYTES } from "./tail-state.js";

/** One audit log segment, read whole. */
export interface SegmentRead {
	/** Its name in the audit directory: `events.jsonl`, or an older rotated segment. */
	name: string;
	file: FileObservation;
}

/** Everything one verdict reads. */
export interface VaultSnapshot {
	audit: InventoryObservation;
	quarantine: InventoryObservation;
	anchor: FileObservation;
	/** The log first (absent when there is none), then, when asked for, every other `*.jsonl`, by name. */
	segments: SegmentRead[];
	/** The anchor mirror (`anchors/anchors.jsonl`), when asked for (`StableReadOptions.mirror`). */
	mirror?: FileObservation;
}

export type VaultRead =
	| { kind: "final"; snapshot: VaultSnapshot; attempts: number }
	| { kind: "torn_writer_live"; snapshot: VaultSnapshot; attempts: number }
	| { kind: "busy"; attempts: number };

export interface StableReadOptions {
	/** The most attempts. Default 26. */
	attempts?: number;
	/** Between attempts, in milliseconds. Default 100. */
	delayMs?: number;
	/** Read the anchor mirror into the snapshot too, bracketed like the anchor: an anchored verdict. */
	mirror?: boolean;
	/**
	 * The most bytes the segments may take together (default `MAX_SNAPSHOT_BYTES`): each is read within what is
	 * left of it, after the ones before it, and one that does not fit is `oversize`, never read.
	 */
	maxSnapshotBytes?: number;
}

/** An audit directory's log. */
export const LOG_NAME = "events.jsonl";

const LOCK_FILE_NAME = ".audit-writer.lock";
const MAX_LOCK_BYTES = 4096;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PID_NS = /^pid:\[\d+\]$/;

function codeOf(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "EUNKNOWN";
}

/**
 * The segment names a snapshot reads: the log first, then, with `withSegments` (a vault's chain),
 * every other `*.jsonl` in the directory, sorted. Without it (one file handed to `verifyChain`), the
 * log alone: a copy beside it is never read into it.
 */
function segmentNames(
	audit: InventoryObservation,
	logName: string,
	withSegments: boolean,
): string[] {
	const others =
		withSegments && audit.kind === "ok"
			? audit.names.filter((n) => n.endsWith(".jsonl") && n !== logName).sort()
			: [];
	return [logName, ...others];
}

function sameInventory(a: InventoryObservation, b: InventoryObservation): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "ok" && b.kind === "ok") {
		const x = [...a.names].sort();
		const y = [...b.names].sort();
		return x.length === y.length && x.every((n, i) => n === y[i]);
	}
	return JSON.stringify(a) === JSON.stringify(b);
}

function sameFile(a: FileObservation, b: FileObservation): boolean {
	if (a.kind === "read" && b.kind === "read") return a.bytes.equals(b.bytes);
	return a.kind !== "read" && b.kind !== "read" && JSON.stringify(a) === JSON.stringify(b);
}

function sameSnapshot(a: VaultSnapshot, b: VaultSnapshot): boolean {
	return (
		sameInventory(a.audit, b.audit) &&
		sameInventory(a.quarantine, b.quarantine) &&
		sameFile(a.anchor, b.anchor) &&
		(a.mirror === undefined || b.mirror === undefined
			? a.mirror === b.mirror
			: sameFile(a.mirror, b.mirror)) &&
		a.segments.length === b.segments.length &&
		a.segments.every((s, i) => {
			const t = b.segments[i];
			return t !== undefined && s.name === t.name && sameFile(s.file, t.file);
		})
	);
}

/** The audit directory's listing: the directory the OS opens at its path (`listDirectory`). */
function listAuditDirectory(auditDir: string): InventoryObservation {
	return listDirectory(auditDir, MAX_INVENTORY_NAMES, true);
}

/** What one attempt reads: the log by name, its other segments, and the anchor mirror. */
interface AttemptScope {
	logName: string;
	withSegments: boolean;
	withMirror: boolean;
	/** The bytes every segment may take together. */
	maxSnapshotBytes: number;
}

/** One bracketed attempt. */
function attempt(
	auditDir: string,
	scope: AttemptScope,
): { snapshot: VaultSnapshot; consistent: boolean } {
	const quarantineDir = join(auditDir, "quarantine");
	const metaPath = join(auditDir, `${scope.logName}.meta`);
	const mirrorPath = join(auditDir, "anchors", "anchors.jsonl");
	const audit = listAuditDirectory(auditDir);
	const quarantine = listDirectory(quarantineDir);
	const anchor = acquireSmallFile(metaPath, MAX_ANCHOR_BYTES);
	const mirror = scope.withMirror ? acquireWholeFile(mirrorPath) : undefined;
	const segments: SegmentRead[] = [];
	let changed = mirror?.changed === true;
	// Every segment is held at once: each is read within what the ones before it left of the snapshot's bound.
	let left = scope.maxSnapshotBytes;
	for (const name of segmentNames(audit, scope.logName, scope.withSegments)) {
		const read = acquireWholeFile(join(auditDir, name), Math.min(MAX_SEGMENT_BYTES, left));
		changed ||= read.changed;
		if (read.file.kind === "read") left -= read.file.bytes.length;
		segments.push({ name, file: read.file });
	}
	const consistent =
		!changed &&
		sameFile(anchor, acquireSmallFile(metaPath, MAX_ANCHOR_BYTES)) &&
		(mirror === undefined || sameFile(mirror.file, acquireWholeFile(mirrorPath).file)) &&
		sameInventory(audit, listAuditDirectory(auditDir)) &&
		sameInventory(quarantine, listDirectory(quarantineDir));
	return {
		snapshot: {
			audit,
			quarantine,
			anchor,
			segments,
			...(mirror !== undefined ? { mirror: mirror.file } : {}),
		},
		consistent,
	};
}

/** Whether a segment ends in bytes after its last newline. */
function endsTorn(snapshot: VaultSnapshot): boolean {
	return snapshot.segments.some(
		(s) =>
			s.file.kind === "read" &&
			s.file.bytes.length > 0 &&
			s.file.bytes[s.file.bytes.length - 1] !== 0x0a,
	);
}

function sleepSync(ms: number): void {
	if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read the vault's audit files into ONE consistent snapshot (see the module doc): the log `logName`
 * and its anchor, with `withSegments` every other segment of the chain (a vault's), and with
 * `opts.mirror` the anchor mirror. One file verified alone is `logName` without its siblings.
 */
export function readVaultSnapshot(
	auditDir: string,
	opts: StableReadOptions = {},
	logName = LOG_NAME,
	withSegments = true,
): VaultRead {
	const scope: AttemptScope = {
		logName,
		withSegments,
		withMirror: opts.mirror === true,
		maxSnapshotBytes: Math.max(0, opts.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES),
	};
	const attempts = Math.max(1, opts.attempts ?? 26);
	const delayMs = Math.max(0, opts.delayMs ?? 100);
	// The torn snapshot seen under a live writer, while it stays the same: a completed failure, not a
	// write in flight, if it never changes. Any attempt that differs from it, or that was itself
	// inconsistent, means the vault is changing: busy, never the stale torn snapshot.
	let torn: VaultSnapshot | undefined;
	let tornSteady = true;
	for (let i = 1; i <= attempts; i++) {
		const liveBefore = writerMayHoldLock(auditDir);
		const { snapshot, consistent } = attempt(auditDir, scope);
		if (consistent && (!endsTorn(snapshot) || (!liveBefore && !writerMayHoldLock(auditDir)))) {
			return { kind: "final", snapshot, attempts: i };
		}
		if (!consistent || (torn !== undefined && !sameSnapshot(torn, snapshot))) tornSteady = false;
		if (consistent) torn = snapshot;
		if (i < attempts) sleepSync(delayMs);
	}
	if (torn !== undefined && tornSteady)
		return { kind: "torn_writer_live", snapshot: torn, attempts };
	return { kind: "busy", attempts };
}

function thisBootId(): string | undefined {
	try {
		const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
		return BOOT_ID.test(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

function thisPidNamespace(): string | undefined {
	try {
		const ns = readlinkSync("/proc/self/ns/pid");
		return PID_NS.test(ns) ? ns : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a writer may hold the vault's lock, judged read-only as the writer judges it. No lock
 * file: no writer. A lock that cannot be read or parsed, from another or an unknown PID namespace,
 * or whose PID is alive (or cannot be probed): a writer may hold it. A lock written before this
 * boot, or whose PID is gone: none.
 */
export function writerMayHoldLock(auditDir: string): boolean {
	const lock = acquireSmallFile(join(auditDir, LOCK_FILE_NAME), MAX_LOCK_BYTES);
	if (lock.kind === "absent") return false;
	if (lock.kind !== "read") return true;
	let claim: unknown;
	try {
		claim = JSON.parse(lock.bytes.toString("utf8"));
	} catch {
		return true;
	}
	if (claim === null || typeof claim !== "object") return true;
	const { pid, bootId, pidNs } = claim as { pid?: unknown; bootId?: unknown; pidNs?: unknown };
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return true;
	if (pidNs !== undefined) {
		const here = thisPidNamespace();
		if (here === undefined || typeof pidNs !== "string" || pidNs !== here) return true;
	}
	if (typeof bootId === "string" && BOOT_ID.test(bootId)) {
		const boot = thisBootId();
		if (boot !== undefined && bootId !== boot) return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return codeOf(err) !== "ESRCH";
	}
}
