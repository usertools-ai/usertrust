// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { withAuditWriterLock } from "../audit/chain.js";

// ── Types ──

export interface SnapshotMeta {
	name: string;
	timestamp: string;
	files: string[];
	size: number;
	/** Audit chain head at snapshot time (from events.jsonl.meta). */
	auditHead?: { lastHash: string; sequence: number };
	/** Money mirror value at snapshot time (from spend-ledger.json). */
	budgetSpent?: number;
}

export interface RestoreOptions {
	/** Acknowledge that a live TigerBeetle ledger will NOT be rolled back. */
	forceLedgerDesync?: boolean;
}

interface SnapshotPayload {
	meta: SnapshotMeta;
	entries: Record<string, string>; // relative path -> base64 content
}

// ── Constants ──

const SNAPSHOTS_DIR = "snapshots";

/** Directories to exclude from snapshots */
const EXCLUDED_DIRS = new Set(["tigerbeetle", "snapshots", "dlq"]);

/** Files/directories to include in snapshots */
const INCLUDED_PATHS = new Set([
	"audit",
	"policies",
	"patterns",
	"usertrust.config.json",
	"leases.json",
	// SNAP-1: the durable money mirror. Captured so a restore rolls the audit chain
	// and the money ledger back together, never one without the other.
	"spend-ledger.json",
]);

/** Never captured: advisory lock file living inside audit/. */
const NEVER_CAPTURE = new Set([".audit-writer.lock"]);

/**
 * Never captured NOR restored: external-anchoring state (mirror of the
 * append-only anchor store, identity.json with the durable anchorSeq
 * high-water, outbox). This bookkeeping is MONOTONIC by contract — rolling it
 * back with a snapshot would make the emitter re-mint anchorSeqs the store
 * already holds, publishing divergent records at occupied positions:
 * permanent, undeletable fork evidence that condemns an honest vault.
 */
const ANCHORS_REL_DIR = "audit/anchors";

const LOCK_FILE_NAME = ".audit-writer.lock";

// ── Internals ──

/**
 * Recursively collect all files under a directory, returning relative paths.
 */
async function collectFiles(basePath: string, currentPath: string): Promise<string[]> {
	const results: string[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(currentPath, { withFileTypes: true, encoding: "utf-8" });
	} catch {
		return results;
	}

	for (const entry of entries) {
		const fullPath = join(currentPath, entry.name as string);
		const relPath = relative(basePath, fullPath);

		if (entry.isDirectory()) {
			// Anchoring state is monotonic — never snapshot it (see ANCHORS_REL_DIR).
			if (relPath === ANCHORS_REL_DIR) continue;
			const nested = await collectFiles(basePath, fullPath);
			results.push(...nested);
		} else if (entry.isFile()) {
			// Never capture the audit-writer advisory lock — restoring a stale lock
			// would falsely block a future writer.
			if (NEVER_CAPTURE.has(entry.name as string)) continue;
			results.push(relPath);
		}
	}

	return results;
}

/**
 * Gather all files from the vault that should be included in a snapshot.
 */
async function gatherVaultFiles(vaultPath: string): Promise<string[]> {
	const allFiles: string[] = [];

	let topEntries: Dirent[];
	try {
		topEntries = await readdir(vaultPath, { withFileTypes: true, encoding: "utf-8" });
	} catch {
		return allFiles;
	}

	for (const entry of topEntries) {
		const name = entry.name as string;
		if (EXCLUDED_DIRS.has(name)) {
			continue;
		}
		if (!INCLUDED_PATHS.has(name)) {
			continue;
		}

		const fullPath = join(vaultPath, name);

		if (entry.isDirectory()) {
			const nested = await collectFiles(vaultPath, fullPath);
			allFiles.push(...nested);
		} else if (entry.isFile()) {
			allFiles.push(name);
		}
	}

	return allFiles.sort();
}

function snapshotsDir(vaultPath: string): string {
	return join(vaultPath, SNAPSHOTS_DIR);
}

function snapshotFilePath(vaultPath: string, name: string): string {
	return join(snapshotsDir(vaultPath), `${name}.json`);
}

function validateSnapshotName(name: string): void {
	if (
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("..") ||
		name.includes("\0") ||
		name.trim() === ""
	) {
		throw new Error(`Invalid snapshot name: ${name}`);
	}
}

// ── Public API ──

/**
 * Create a snapshot of the vault state.
 * Captures audit/, policies/, patterns/, usertrust.config.json, and leases.json.
 * Excludes tigerbeetle/, snapshots/, and dlq/.
 */
export async function createSnapshot(vaultPath: string, name: string): Promise<SnapshotMeta> {
	validateSnapshotName(name);
	const files = await gatherVaultFiles(vaultPath);
	const entries: Record<string, string> = {};
	let totalSize = 0;

	for (const relPath of files) {
		const fullPath = join(vaultPath, relPath);
		const content = await readFile(fullPath);
		entries[relPath] = content.toString("base64");
		totalSize += content.length;
	}

	// Forensic head anchors: the audit chain head and money-mirror value at capture
	// time. Best-effort (a fresh vault has neither); the desync guard on restore keys
	// off payload presence, not these fields, so their absence never weakens it.
	let auditHead: SnapshotMeta["auditHead"];
	try {
		const metaRaw = await readFile(join(vaultPath, "audit", "events.jsonl.meta"), "utf-8");
		const m = JSON.parse(metaRaw) as { lastHash: string; sequence: number };
		auditHead = { lastHash: m.lastHash, sequence: m.sequence };
	} catch {
		/* no audit head yet */
	}
	let budgetSpent: number | undefined;
	try {
		const led = JSON.parse(await readFile(join(vaultPath, "spend-ledger.json"), "utf-8")) as {
			budgetSpent?: number;
		};
		if (typeof led.budgetSpent === "number") budgetSpent = led.budgetSpent;
	} catch {
		/* no ledger yet */
	}

	const meta: SnapshotMeta = {
		name,
		timestamp: new Date().toISOString(),
		files,
		size: totalSize,
		...(auditHead !== undefined ? { auditHead } : {}),
		...(budgetSpent !== undefined ? { budgetSpent } : {}),
	};

	const payload: SnapshotPayload = { meta, entries };

	const dir = snapshotsDir(vaultPath);
	await mkdir(dir, { recursive: true });

	const filePath = snapshotFilePath(vaultPath, name);
	await writeFile(filePath, JSON.stringify(payload, null, "\t"), "utf-8");

	return meta;
}

/**
 * Restore the vault state from a named snapshot.
 *
 * Atomic (stage-then-commit), audit-writer-lock-aware, and refuses any restore
 * that would sever money<->audit correspondence:
 *  - a snapshot that rolls back the audit chain MUST carry spend-ledger.json;
 *  - a live TigerBeetle store (which cannot be file-rolled-back) blocks an audit
 *    rollback unless the operator passes `forceLedgerDesync`.
 */
export async function restoreSnapshot(
	vaultPath: string,
	name: string,
	opts?: RestoreOptions,
): Promise<void> {
	validateSnapshotName(name);
	const filePath = snapshotFilePath(vaultPath, name);
	const raw = await readFile(filePath, "utf-8");
	const payload: SnapshotPayload = JSON.parse(raw) as SnapshotPayload;

	const entries = Object.entries(payload.entries);
	const rollsBackAudit = entries.some(([p]) => p.startsWith("audit/"));
	const hasLedger = Object.prototype.hasOwnProperty.call(payload.entries, "spend-ledger.json");

	// Desync guard 1: a snapshot that rolls the audit chain back MUST carry the money
	// mirror, or restoring audit alone deletes spend events whose money still exists.
	if (rollsBackAudit && !hasLedger) {
		throw new Error(
			"Refusing restore: snapshot rolls back the audit chain but has no spend-ledger.json — money and audit would desync. Re-create the snapshot with a version that captures spend-ledger.json.",
		);
	}
	// Desync guard 2: TigerBeetle is a live append-only ledger that cannot be file-
	// rolled-back to the snapshot point. Rolling audit back while TB moves on forks
	// money<->audit. Refuse unless the operator explicitly acknowledges.
	if (rollsBackAudit && existsSync(join(vaultPath, "tigerbeetle")) && !opts?.forceLedgerDesync) {
		throw new Error(
			"Refusing restore: a live TigerBeetle ledger is present and cannot be rolled back to match the restored audit chain. Reconcile TB first, then re-run with --force.",
		);
	}

	// The advisory lock lives in audit/; ensure the dir exists so we can take it.
	const auditDir = join(vaultPath, "audit");
	await mkdir(auditDir, { recursive: true });
	const logPath = join(auditDir, "events.jsonl");

	await withAuditWriterLock(logPath, async () => {
		const resolvedVault = resolve(vaultPath);
		const staged: { finalPath: string; tmpPath: string }[] = [];
		try {
			// Phase 1: validate every path and materialize each target as a temp file.
			for (const [relPath, b64Content] of entries) {
				if (relPath === "" || relPath === ".") {
					throw new Error("Invalid empty path in snapshot entry");
				}
				// Never restore an advisory lock captured by an older snapshot.
				if (relPath.split("/").pop() === LOCK_FILE_NAME) continue;
				// Never restore anchoring state, even from snapshots captured
				// before this exclusion existed — rolling back the anchorSeq
				// high-water re-mints occupied store positions (permanent fork
				// evidence). The live anchors/ dir stays as-is.
				if (relPath === ANCHORS_REL_DIR || relPath.startsWith(`${ANCHORS_REL_DIR}/`)) continue;

				const fullPath = join(vaultPath, relPath);
				const resolvedPath = resolve(fullPath);
				if (!resolvedPath.startsWith(`${resolvedVault}/`)) {
					throw new Error(`Path traversal detected in snapshot: ${relPath}`);
				}
				await mkdir(dirname(fullPath), { recursive: true });
				const tmpPath = `${fullPath}.restore-tmp`;
				await writeFile(tmpPath, Buffer.from(b64Content, "base64"));
				staged.push({ finalPath: fullPath, tmpPath });
			}
			// Phase 2: commit — rename staged temps into place. Renames are fast and
			// same-filesystem-atomic, bounding the crash window to the rename loop.
			for (const s of staged) {
				await rename(s.tmpPath, s.finalPath);
			}
		} catch (err) {
			// Any failure before/at commit: remove uncommitted temps, leaving originals intact.
			for (const s of staged) {
				try {
					await rm(s.tmpPath, { force: true });
				} catch {
					/* best effort */
				}
			}
			throw err;
		}
	});
}

/**
 * List all snapshots in the vault, sorted by timestamp (oldest first).
 */
export async function listSnapshots(vaultPath: string): Promise<SnapshotMeta[]> {
	const dir = snapshotsDir(vaultPath);
	let dirEntries: Dirent[];
	try {
		dirEntries = await readdir(dir, { withFileTypes: true, encoding: "utf-8" });
	} catch {
		return [];
	}

	const metas: SnapshotMeta[] = [];

	for (const entry of dirEntries) {
		const name = entry.name as string;
		if (!entry.isFile() || !name.endsWith(".json")) {
			continue;
		}
		try {
			const raw = await readFile(join(dir, name), "utf-8");
			const payload = JSON.parse(raw) as SnapshotPayload;
			metas.push(payload.meta);
		} catch {
			// Skip corrupt snapshot files
		}
	}

	metas.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	return metas;
}
