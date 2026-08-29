// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

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

/**
 * Persist at most once per this many recorded patterns.
 *
 * `persist` rewrites the WHOLE history — at the 10,000-entry cap that is a
 * 1.9 MB write to store ~150 bytes of new information, ~13,000x write
 * amplification, paid on every governed call while holding the process-global
 * mutex below. Measured: 3.94 ms/call at the cap, and turning pattern memory
 * off raised concurrent governed throughput 39 -> 66 calls/sec, so the
 * CONTENTION cost more than the latency did.
 *
 * The tradeoff this buys: up to PERSIST_EVERY - 1 records are lost on a hard
 * crash. That is acceptable because this file has never been fsynced and is
 * documented best-effort — pattern memory is NOT the audit chain: it is not
 * hash-chained, not authenticated, not durable, and is never evidence of
 * spend, approval, reservation, commit, or release. `flushPatterns` closes
 * the window on a clean shutdown, which is the case that is actually
 * recoverable.
 *
 * RAISING THIS CONSTANT WIDENS A SECOND WINDOW, not just the crash one. A
 * FAILED write (ENOSPC, a read-only vault, a permissions change) now costs up
 * to PERSIST_EVERY - 1 records where it used to cost 1, because that many
 * records rode on the one write that failed. Same acceptance argument — this
 * is a best-effort, never-fsynced cache — but it is a real widening and it
 * scales linearly with this number, so weigh both windows before changing it.
 * `tests/memory/patterns-debounce.test.ts` pins that a failed write still
 * costs no record while the PROCESS survives: the records stay in the cache
 * and a later successful flush carries them. Only losing the process loses
 * them.
 *
 * The file format and the atomic tmp + rename write are UNCHANGED. Only the
 * frequency changes, so there is nothing to migrate and no new corruption
 * mode: an append-only log would be O(1) per call but can tear mid-append,
 * which tmp + rename cannot.
 */
const PERSIST_EVERY = 50;

// ── AsyncMutex (AUD-464) ──

/**
 * In-process async mutex for serializing pattern memory writes.
 *
 * SINGLE-PROCESS CONSTRAINT: This mutex is process-local (in-memory).
 * It guarantees sequential read-modify-write cycles within a single
 * Node.js process but provides NO protection across multiple processes.
 * Pattern memory is process-local, so this is sufficient.
 */
class AsyncMutex {
	private queue: Promise<void> = Promise.resolve();

	async acquire(): Promise<() => void> {
		let release: (() => void) | undefined;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prev = this.queue;
		this.queue = next;
		await prev;
		return release as () => void;
	}
}

const patternMutex = new AsyncMutex();

// ── Instance-scoped cache (keyed by vault path) ──

interface CacheEntry {
	entries: PatternEntry[];
	initialized: boolean;
	/** Records accumulated since the last successful `persist`. */
	pendingWrites: number;
}

const cacheByVault = new Map<string, CacheEntry>();

function resolveVaultKey(vaultPath?: string): string {
	return vaultPath ?? VAULT_DIR;
}

function getCache(vaultPath?: string): CacheEntry {
	const key = resolveVaultKey(vaultPath);
	let entry = cacheByVault.get(key);
	if (entry === undefined) {
		entry = { entries: [], initialized: false, pendingWrites: 0 };
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
 * Appends to `.usertrust/patterns/memory.json`.
 * Evicts oldest entries when exceeding 10,000.
 *
 * Uses an async mutex to serialize concurrent read-modify-write cycles
 * and prevent entry loss under concurrent calls (AUD-464).
 */
export async function recordPattern(
	entry: Omit<PatternEntry, "timestamp">,
	vaultPath?: string,
): Promise<void> {
	const release = await patternMutex.acquire();
	try {
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

		// Debounced persist. The counter is reset BEFORE the write, not after:
		// a failed write must not leave the counter parked at the threshold,
		// which would turn a persistent write failure into a rewrite attempt on
		// every subsequent call — the exact per-call cost this exists to remove.
		cache.pendingWrites++;
		if (cache.pendingWrites >= PERSIST_EVERY) {
			cache.pendingWrites = 0;
			await persist(entries, vaultPath);
		}
	} finally {
		release();
	}
}

/**
 * Write any records the debounce is still withholding.
 *
 * Call this on clean shutdown — `TrustedClient.destroy()` does, after
 * in-flight calls have drained so their records are included. Without it the
 * tail of a run (up to PERSIST_EVERY - 1 records) never reaches disk.
 *
 * Best-effort, exactly like `recordPattern`: it takes the same mutex, uses the
 * same unchanged `persist`, and adds no fsync. Callers isolate it with
 * `.catch(() => {})` — a cache flush must never turn a clean shutdown into a
 * throw.
 */
export async function flushPatterns(vaultPath?: string): Promise<void> {
	const release = await patternMutex.acquire();
	try {
		const cache = getCache(vaultPath);
		if (cache.pendingWrites === 0) {
			// Nothing withheld. Note this is also the never-loaded case, where
			// writing would create an empty file for a vault nobody recorded to.
			return;
		}
		cache.pendingWrites = 0;
		await persist(cache.entries, vaultPath);
	} finally {
		release();
	}
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
	const modelStats = new Map<string, { successes: number; total: number; totalCost: number }>();

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
