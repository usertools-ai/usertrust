import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VAULT_DIR } from "../shared/constants.js";

// ── Types ──

export interface PatternEntry {
	promptHash: string;
	model: string;
	cost: number;
	success: boolean;
	timestamp: string;
}

export interface PatternStats {
	totalEntries: number;
	uniqueModels: number;
	hitCount: Map<string, number>;
}

// ── Constants ──

const PATTERNS_DIR = "patterns";
const MEMORY_FILE = "memory.json";
const MAX_ENTRIES = 10_000;

// ── Instance-scoped cache (keyed by vault path) ──

interface CacheEntry {
	entries: PatternEntry[];
	initialized: boolean;
}

const cacheByVault = new Map<string, CacheEntry>();

function resolveVaultKey(vaultPath?: string): string {
	return vaultPath ?? VAULT_DIR;
}

function getCache(vaultPath?: string): CacheEntry {
	const key = resolveVaultKey(vaultPath);
	let entry = cacheByVault.get(key);
	if (entry === undefined) {
		entry = { entries: [], initialized: false };
		cacheByVault.set(key, entry);
	}
	return entry;
}

function memoryFilePath(vaultPath?: string): string {
	const base = vaultPath ?? VAULT_DIR;
	return join(base, PATTERNS_DIR, MEMORY_FILE);
}

/** Reset internal state — for testing only. */
export function _resetPatternCache(): void {
	cacheByVault.clear();
}

// ── Internals ──

async function ensureLoaded(vaultPath?: string): Promise<PatternEntry[]> {
	const cache = getCache(vaultPath);
	if (cache.initialized) {
		return cache.entries;
	}
	const filePath = memoryFilePath(vaultPath);
	try {
		const raw = await readFile(filePath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			cache.entries = [];
		} else {
			cache.entries = parsed as PatternEntry[];
		}
	} catch {
		// File doesn't exist or is corrupt — start fresh
		cache.entries = [];
	}
	cache.initialized = true;
	return cache.entries;
}

async function persist(entries: PatternEntry[], vaultPath?: string): Promise<void> {
	const filePath = memoryFilePath(vaultPath);
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true });

	// Atomic write via rename
	const tmpPath = `${filePath}.tmp.${Date.now()}`;
	await writeFile(tmpPath, JSON.stringify(entries, null, "\t"), "utf-8");
	await rename(tmpPath, filePath);
}

// ── Public API ──

/**
 * Hash prompt text with SHA-256. Never store raw prompts.
 */
export function hashPrompt(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Record a pattern entry from a completed LLM call.
 * Appends to `.usertools/patterns/memory.json`.
 * Evicts oldest entries when exceeding 10,000.
 */
export async function recordPattern(
	entry: Omit<PatternEntry, "timestamp">,
	vaultPath?: string,
): Promise<void> {
	const entries = await ensureLoaded(vaultPath);

	const full: PatternEntry = {
		...entry,
		timestamp: new Date().toISOString(),
	};

	entries.push(full);

	// Evict oldest if over capacity
	if (entries.length > MAX_ENTRIES) {
		const excess = entries.length - MAX_ENTRIES;
		entries.splice(0, excess);
	}

	const cache = getCache(vaultPath);
	cache.entries = entries;
	await persist(entries, vaultPath);
}

/**
 * Suggest the best model for a given prompt hash based on past patterns.
 * Returns the model with the best cost-adjusted success ratio, or null if
 * no patterns exist for this prompt hash.
 */
export function suggestModel(promptHash: string, vaultPath?: string): string | null {
	const cache = getCache(vaultPath);
	if (!cache.initialized || cache.entries.length === 0) {
		return null;
	}

	// Filter entries matching this prompt hash
	const matching = cache.entries.filter((e) => e.promptHash === promptHash);
	if (matching.length === 0) {
		return null;
	}

	// Group by model, compute success rate / average cost
	const modelStats = new Map<
		string,
		{ successes: number; total: number; totalCost: number }
	>();

	for (const entry of matching) {
		let stats = modelStats.get(entry.model);
		if (stats === undefined) {
			stats = { successes: 0, total: 0, totalCost: 0 };
			modelStats.set(entry.model, stats);
		}
		stats.total += 1;
		stats.totalCost += entry.cost;
		if (entry.success) {
			stats.successes += 1;
		}
	}

	// Score: success_rate / avg_cost (higher is better)
	// If avg_cost is 0, treat as very efficient (use large score)
	let bestModel: string | null = null;
	let bestScore = -1;

	for (const [model, stats] of modelStats) {
		const successRate = stats.successes / stats.total;
		const avgCost = stats.totalCost / stats.total;
		const score = avgCost > 0 ? successRate / avgCost : successRate * 1_000_000;

		if (score > bestScore) {
			bestScore = score;
			bestModel = model;
		}
	}

	return bestModel;
}

/**
 * Return summary statistics for all stored patterns.
 */
export async function getPatternStats(vaultPath?: string): Promise<PatternStats> {
	const entries = await ensureLoaded(vaultPath);

	const models = new Set<string>();
	const hitCount = new Map<string, number>();

	for (const entry of entries) {
		models.add(entry.model);
		hitCount.set(entry.promptHash, (hitCount.get(entry.promptHash) ?? 0) + 1);
	}

	return {
		totalEntries: entries.length,
		uniqueModels: models.size,
		hitCount,
	};
}
