import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetPatternCache,
	getPatternStats,
	hashPrompt,
	recordPattern,
	suggestModel,
} from "../../src/memory/patterns.js";

describe("Pattern Memory", () => {
	let tempDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		_resetPatternCache();
		tempDir = await mkdtemp(join(tmpdir(), "govern-patterns-"));
		vaultPath = tempDir;
	});

	afterEach(async () => {
		_resetPatternCache();
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("hashPrompt", () => {
		it("returns deterministic SHA-256 hex", () => {
			const hash = hashPrompt("Hello, world!");
			expect(hash).toBe(hashPrompt("Hello, world!"));
			expect(hash).toMatch(/^[a-f0-9]{64}$/);
		});

		it("returns different hashes for different inputs", () => {
			expect(hashPrompt("hello")).not.toBe(hashPrompt("world"));
		});
	});

	describe("recordPattern", () => {
		it("stores entry to file", async () => {
			const promptHash = hashPrompt("test prompt");

			await recordPattern(
				{
					promptHash,
					model: "claude-sonnet-4-20250514",
					cost: 0.003,
					success: true,
				},
				vaultPath,
			);

			const filePath = join(vaultPath, "patterns", "memory.json");
			const raw = await readFile(filePath, "utf-8");
			const entries = JSON.parse(raw) as Array<Record<string, unknown>>;

			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				promptHash,
				model: "claude-sonnet-4-20250514",
				cost: 0.003,
				success: true,
			});
			expect(entries[0]).toHaveProperty("timestamp");
		});

		it("appends multiple entries", async () => {
			const promptHash = hashPrompt("test prompt");

			await recordPattern(
				{ promptHash, model: "claude-sonnet-4-20250514", cost: 0.003, success: true },
				vaultPath,
			);
			await recordPattern({ promptHash, model: "gpt-4o", cost: 0.005, success: false }, vaultPath);

			const stats = await getPatternStats(vaultPath);
			expect(stats.totalEntries).toBe(2);
		});
	});

	describe("suggestModel", () => {
		it("returns model with best success rate for given prompt hash", async () => {
			const promptHash = hashPrompt("coding task");

			// claude-sonnet-4-20250514: 3/3 success at low cost
			for (let i = 0; i < 3; i++) {
				await recordPattern(
					{ promptHash, model: "claude-sonnet-4-20250514", cost: 0.003, success: true },
					vaultPath,
				);
			}

			// gpt-4o: 1/3 success at higher cost
			await recordPattern({ promptHash, model: "gpt-4o", cost: 0.01, success: true }, vaultPath);
			await recordPattern({ promptHash, model: "gpt-4o", cost: 0.01, success: false }, vaultPath);
			await recordPattern({ promptHash, model: "gpt-4o", cost: 0.01, success: false }, vaultPath);

			const suggestion = suggestModel(promptHash, vaultPath);
			expect(suggestion).toBe("claude-sonnet-4-20250514");
		});

		it("returns null for unknown prompt hash", async () => {
			await recordPattern(
				{
					promptHash: hashPrompt("known"),
					model: "claude-sonnet-4-20250514",
					cost: 0.003,
					success: true,
				},
				vaultPath,
			);

			const suggestion = suggestModel(hashPrompt("unknown"), vaultPath);
			expect(suggestion).toBeNull();
		});

		it("returns null when cache is empty", () => {
			const suggestion = suggestModel(hashPrompt("anything"));
			expect(suggestion).toBeNull();
		});
	});

	describe("getPatternStats", () => {
		it("returns correct counts", async () => {
			const hash1 = hashPrompt("prompt A");
			const hash2 = hashPrompt("prompt B");

			await recordPattern(
				{ promptHash: hash1, model: "claude-sonnet-4-20250514", cost: 0.003, success: true },
				vaultPath,
			);
			await recordPattern(
				{ promptHash: hash1, model: "gpt-4o", cost: 0.01, success: true },
				vaultPath,
			);
			await recordPattern(
				{ promptHash: hash2, model: "claude-sonnet-4-20250514", cost: 0.003, success: false },
				vaultPath,
			);

			const stats = await getPatternStats(vaultPath);
			expect(stats.totalEntries).toBe(3);
			expect(stats.uniqueModels).toBe(2);
			expect(stats.hitCount.get(hash1)).toBe(2);
			expect(stats.hitCount.get(hash2)).toBe(1);
		});

		it("returns zeros for empty memory", async () => {
			const stats = await getPatternStats(vaultPath);
			expect(stats.totalEntries).toBe(0);
			expect(stats.uniqueModels).toBe(0);
			expect(stats.hitCount.size).toBe(0);
		});
	});

	describe("eviction", () => {
		it("10K entry limit evicts oldest", async () => {
			const promptHash = hashPrompt("bulk");

			// Insert 10,001 entries
			const entries = [];
			for (let i = 0; i < 10_001; i++) {
				entries.push({
					promptHash,
					model: `model-${i}`,
					cost: 0.001,
					success: true,
					timestamp: new Date(Date.now() + i).toISOString(),
				});
			}

			// Write directly to bypass slow individual recordPattern calls
			const { mkdir, writeFile } = await import("node:fs/promises");
			const { join } = await import("node:path");
			const dir = join(vaultPath, "patterns");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "memory.json"), JSON.stringify(entries), "utf-8");

			// Reset cache so it reloads from file
			_resetPatternCache();

			// Record one more — should trigger eviction
			await recordPattern(
				{ promptHash, model: "final-model", cost: 0.001, success: true },
				vaultPath,
			);

			const stats = await getPatternStats(vaultPath);
			// 10,001 loaded + 1 new = 10,002, evict 2 oldest => 10,000
			expect(stats.totalEntries).toBe(10_000);

			// The very first entry (model-0) should have been evicted
			const filePath = join(vaultPath, "patterns", "memory.json");
			const raw = await readFile(filePath, "utf-8");
			const stored = JSON.parse(raw) as Array<{ model: string }>;
			const hasModel0 = stored.some((e) => e.model === "model-0");
			expect(hasModel0).toBe(false);

			// The last entry should be present
			const hasFinal = stored.some((e) => e.model === "final-model");
			expect(hasFinal).toBe(true);
		});
	});
});
