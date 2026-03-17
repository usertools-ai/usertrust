import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// ── Types ──

export interface SnapshotMeta {
	name: string;
	timestamp: string;
	files: string[];
	size: number;
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
	"govern.config.json",
	"leases.json",
]);

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
			const nested = await collectFiles(basePath, fullPath);
			results.push(...nested);
		} else if (entry.isFile()) {
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
 * Captures audit/, policies/, patterns/, govern.config.json, and leases.json.
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

	const meta: SnapshotMeta = {
		name,
		timestamp: new Date().toISOString(),
		files,
		size: totalSize,
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
 * Overwrites existing files with snapshot contents.
 */
export async function restoreSnapshot(vaultPath: string, name: string): Promise<void> {
	validateSnapshotName(name);
	const filePath = snapshotFilePath(vaultPath, name);
	const raw = await readFile(filePath, "utf-8");
	const payload: SnapshotPayload = JSON.parse(raw) as SnapshotPayload;

	for (const [relPath, b64Content] of Object.entries(payload.entries)) {
		if (relPath === "" || relPath === ".") {
			throw new Error("Invalid empty path in snapshot entry");
		}
		const fullPath = join(vaultPath, relPath);
		const resolvedPath = resolve(fullPath);
		const resolvedVault = resolve(vaultPath);
		if (!resolvedPath.startsWith(`${resolvedVault}/`)) {
			throw new Error(`Path traversal detected in snapshot: ${relPath}`);
		}
		const dir = join(fullPath, "..");
		await mkdir(dir, { recursive: true });
		const content = Buffer.from(b64Content, "base64");
		await writeFile(fullPath, content);
	}
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
