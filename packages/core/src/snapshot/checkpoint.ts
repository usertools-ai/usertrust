// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { withAuditWriterLock } from "../audit/chain.js";
import { LOG_NAME, readVaultSnapshot } from "../audit/stable-read.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../shared/private-fs.js";

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
	// NOT `effective-budget.json`: it is derived (the budget the governor enforces, rewritten at every start), so a
	// restore never brings back an older run's budget as if it were current.
]);

/** Never captured: advisory lock file living inside audit/. */
const NEVER_CAPTURE = new Set([".audit-writer.lock"]);

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Never captured: a writer's PRIVATE temp file — one that exists only while a single write is in
 * flight, or after a writer crashed mid-write — matched by its exact name and place, as a path
 * relative to the vault:
 *  - `audit/.audit-writer.lock.<writerId>.tmp`: the lock, written in full before it is
 *    hard-linked into place (`audit/chain.ts`);
 *  - `audit/events.jsonl.meta.<uuid>.tmp`: the `.meta` head anchor, written before it is renamed
 *    over the anchor (the atomic anchor write of #293);
 *  - `audit/quarantine/.<sha256>-<offset>.<uuid>.tmp`: a torn tail's evidence, written before it is
 *    hard-linked to its `<sha256>-<offset>.torn` name (the quarantine of #293).
 * Each is either about to become another name — captured under that name once it has — or a crashed
 * writer's leftover that nothing reads. Capturing one copies a lock without holding it, or a
 * half-written file; and one removed mid-capture (as every live one soon is) fails the snapshot.
 *
 * Exact shapes, not a blanket `*.tmp`: `policies/` and `patterns/` hold the operator's own files,
 * whose names this code does not own, and anything else under `audit/` is evidence. Only these
 * names are known to be a writer's scratch.
 */
const WRITER_TEMP_FILES: readonly RegExp[] = [
	new RegExp(`^audit/\\.audit-writer\\.lock\\.${UUID}\\.tmp$`),
	new RegExp(`^audit/events\\.jsonl\\.meta\\.${UUID}\\.tmp$`),
	new RegExp(`^audit/quarantine/\\.[0-9a-f]{64}-(?:0|[1-9][0-9]{0,15})\\.${UUID}\\.tmp$`),
];

/** Is `relPath` (relative to the vault, platform separators) a writer's temp file? */
function isWriterTempFile(relPath: string): boolean {
	const path = relPath.split(sep).join("/");
	return WRITER_TEMP_FILES.some((shape) => shape.test(path));
}

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
	} catch (err) {
		// A directory we just saw in its parent's listing but cannot enumerate is a
		// part of the vault we did not read. Returning the partial list made
		// `createSnapshot` produce a snapshot MISSING files while reporting success —
		// and a snapshot is the thing a restore trusts, so a silently short one is
		// undetectable later by design. Fail the snapshot instead of writing a
		// plausible, incomplete one.
		throw new Error(
			`Cannot enumerate vault directory for snapshot: ${currentPath} (${err instanceof Error ? err.message : String(err)})`,
		);
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
			// Nor a writer's temp file, mid-write or left by a crash (see WRITER_TEMP_FILES).
			if (isWriterTempFile(relPath)) continue;
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
	} catch (err) {
		// ENOENT is the one honest empty: there is no vault, so there are no files
		// and a zero-file snapshot states that truthfully. Every other failure
		// (EACCES, EIO, ENOTDIR) means a vault we could not read, and answering
		// "no files" there is the same false OK as the nested case above.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return allFiles;
		throw new Error(
			`Cannot enumerate vault for snapshot: ${vaultPath} (${err instanceof Error ? err.message : String(err)})`,
		);
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
	// The chain (its log segments and their `.meta` anchor) comes from ONE consistent snapshot
	// (`stable-read.ts`), taken without the writer's lock, so a live vault can still be snapshotted.
	// Read file by file, an append landing between the log and its anchor captured an anchor AHEAD of
	// its log: a snapshot that restores into a vault every writer refuses (events "deleted"). A vault
	// that keeps changing, or ends in a line a live writer may still be writing, is not captured.
	const chain = readVaultSnapshot(join(vaultPath, "audit"));
	if (chain.kind !== "final") {
		throw new Error(
			chain.kind === "busy"
				? "Cannot snapshot the vault now: its audit chain kept changing while it was read. Try again."
				: "Cannot snapshot the vault: its audit log ends in bytes after its last newline, unchanged, while a writer holds the vault: torn, or a write in progress. Stop the writer and try again (if the bytes are still there, `usertrust audit quarantine-tail` repairs a torn tail).",
		);
	}
	// An audit directory that cannot be listed is a vault nobody read (as `gatherVaultFiles` refuses
	// one), and a chain file that is there but could not be read whole (not a regular file, over the
	// bound, an error) refuses the snapshot too: left out, it would be restored as a file that never
	// existed.
	const inventory = chain.snapshot.audit;
	if (inventory.kind === "unreadable" || inventory.kind === "oversize") {
		throw new Error(
			`Cannot enumerate vault for snapshot: ${join(vaultPath, "audit")} (${
				inventory.kind === "unreadable" ? inventory.code : `over ${inventory.count} names`
			})`,
		);
	}
	const chainBytes = new Map<string, Buffer>();
	for (const [name, file] of [
		...chain.snapshot.segments.map((sg) => [sg.name, sg.file] as const),
		[`${LOG_NAME}.meta`, chain.snapshot.anchor] as const,
	]) {
		if (file.kind === "absent") continue;
		if (file.kind !== "read") {
			throw new Error(
				`Cannot snapshot the vault: its audit file ${name} could not be read whole (${file.kind}).`,
			);
		}
		chainBytes.set(join("audit", name), file.bytes);
	}
	// Paths as `gatherVaultFiles` lists them: with this platform's separator.
	const isChainFile = (relPath: string): boolean => {
		const path = relPath.split(sep).join("/");
		return path === `audit/${LOG_NAME}.meta` || /^audit\/[^/]+\.jsonl$/.test(path);
	};
	// Every other file as listed; the chain's files exactly as the snapshot holds them.
	const files = [
		...(await gatherVaultFiles(vaultPath)).filter((relPath) => !isChainFile(relPath)),
		...chainBytes.keys(),
	].sort();
	const entries: Record<string, string> = {};
	let totalSize = 0;

	for (const relPath of files) {
		const content = chainBytes.get(relPath) ?? (await readFile(join(vaultPath, relPath)));
		entries[relPath] = content.toString("base64");
		totalSize += content.length;
	}

	// Forensic head anchors: the audit chain head and money-mirror value at capture
	// time. Best-effort (a fresh vault has neither); the desync guard on restore keys
	// off payload presence, not these fields, so their absence never weakens it. The head is the
	// captured anchor's, never the file read again.
	let auditHead: SnapshotMeta["auditHead"];
	try {
		const metaRaw = chainBytes.get(join("audit", `${LOG_NAME}.meta`))?.toString("utf-8");
		if (metaRaw !== undefined) {
			const m = JSON.parse(metaRaw) as { lastHash: string; sequence: number };
			auditHead = { lastHash: m.lastHash, sequence: m.sequence };
		}
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
	await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });

	const filePath = snapshotFilePath(vaultPath, name);
	await writeFile(filePath, JSON.stringify(payload, null, "\t"), {
		encoding: "utf-8",
		mode: PRIVATE_FILE_MODE,
	});

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
	const hasLedger = Object.hasOwn(payload.entries, "spend-ledger.json");

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
	await mkdir(auditDir, { recursive: true, mode: PRIVATE_DIR_MODE });
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
				await mkdir(dirname(fullPath), { recursive: true, mode: PRIVATE_DIR_MODE });
				const tmpPath = `${fullPath}.restore-tmp`;
				await writeFile(tmpPath, Buffer.from(b64Content, "base64"), { mode: PRIVATE_FILE_MODE });
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
