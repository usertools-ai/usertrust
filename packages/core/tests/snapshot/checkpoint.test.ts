import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSnapshot, listSnapshots, restoreSnapshot } from "../../src/snapshot/checkpoint.js";

describe("Checkpoint / Restore", () => {
	let tempDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "trust-snapshot-"));
		vaultPath = tempDir;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/** Helper to populate a vault with test files */
	async function populateVault(): Promise<void> {
		// audit/
		await mkdir(join(vaultPath, "audit"), { recursive: true });
		await writeFile(join(vaultPath, "audit", "chain.jsonl"), "line1\nline2\n");
		await writeFile(join(vaultPath, "audit", "index.json"), '{"count": 2}');

		// policies/
		await mkdir(join(vaultPath, "policies"), { recursive: true });
		await writeFile(join(vaultPath, "policies", "default.json"), '{"maxBudget": 50000}');

		// patterns/
		await mkdir(join(vaultPath, "patterns"), { recursive: true });
		await writeFile(join(vaultPath, "patterns", "memory.json"), "[]");

		// usertrust.config.json
		await writeFile(join(vaultPath, "usertrust.config.json"), '{"version": 1}');

		// leases.json
		await writeFile(join(vaultPath, "leases.json"), "{}");

		// Excluded directories
		await mkdir(join(vaultPath, "tigerbeetle"), { recursive: true });
		await writeFile(join(vaultPath, "tigerbeetle", "data.tb"), "binary-data");

		await mkdir(join(vaultPath, "dlq"), { recursive: true });
		await writeFile(join(vaultPath, "dlq", "dead-letter.jsonl"), "error\n");
	}

	describe("createSnapshot", () => {
		it("captures vault files", async () => {
			await populateVault();

			const meta = await createSnapshot(vaultPath, "test-snap");

			expect(meta.name).toBe("test-snap");
			expect(meta.timestamp).toBeTruthy();
			expect(meta.files).toContain("audit/chain.jsonl");
			expect(meta.files).toContain("audit/index.json");
			expect(meta.files).toContain("policies/default.json");
			expect(meta.files).toContain("patterns/memory.json");
			expect(meta.files).toContain("usertrust.config.json");
			expect(meta.files).toContain("leases.json");
			expect(meta.size).toBeGreaterThan(0);
		});

		it("excludes tigerbeetle/ and snapshots/ directories", async () => {
			await populateVault();

			// Create a prior snapshot to verify snapshots/ is excluded
			await createSnapshot(vaultPath, "prior-snap");
			const meta = await createSnapshot(vaultPath, "test-snap");

			const hasTB = meta.files.some((f) => f.startsWith("tigerbeetle"));
			const hasSnapshots = meta.files.some((f) => f.startsWith("snapshots"));
			const hasDlq = meta.files.some((f) => f.startsWith("dlq"));

			expect(hasTB).toBe(false);
			expect(hasSnapshots).toBe(false);
			expect(hasDlq).toBe(false);
		});

		it("stores snapshot as JSON with base64 entries", async () => {
			await populateVault();

			await createSnapshot(vaultPath, "encoded-snap");

			const snapFile = join(vaultPath, "snapshots", "encoded-snap.json");
			const raw = await readFile(snapFile, "utf-8");
			const payload = JSON.parse(raw) as {
				meta: { name: string };
				entries: Record<string, string>;
			};

			expect(payload.meta.name).toBe("encoded-snap");
			expect(payload.entries["usertrust.config.json"]).toBeTruthy();

			// Verify base64 decoding
			const decoded = Buffer.from(
				payload.entries["usertrust.config.json"] as string,
				"base64",
			).toString("utf-8");
			expect(decoded).toBe('{"version": 1}');
		});
	});

	describe("restoreSnapshot", () => {
		it("reverts to captured state", async () => {
			await populateVault();

			// Take snapshot
			await createSnapshot(vaultPath, "restore-test");

			// Modify files
			await writeFile(join(vaultPath, "usertrust.config.json"), '{"version": 99}');
			await writeFile(join(vaultPath, "audit", "chain.jsonl"), "modified-content\n");

			// Restore
			await restoreSnapshot(vaultPath, "restore-test");

			// Verify restoration
			const config = await readFile(join(vaultPath, "usertrust.config.json"), "utf-8");
			expect(config).toBe('{"version": 1}');

			const chain = await readFile(join(vaultPath, "audit", "chain.jsonl"), "utf-8");
			expect(chain).toBe("line1\nline2\n");
		});

		it("restores files even if directories were deleted", async () => {
			await populateVault();
			await createSnapshot(vaultPath, "deleted-dirs");

			// Delete the policies directory
			await rm(join(vaultPath, "policies"), { recursive: true, force: true });

			// Restore
			await restoreSnapshot(vaultPath, "deleted-dirs");

			// Verify policies/ was recreated
			const policy = await readFile(join(vaultPath, "policies", "default.json"), "utf-8");
			expect(policy).toBe('{"maxBudget": 50000}');
		});
	});

	describe("listSnapshots", () => {
		it("returns all snapshots sorted by timestamp", async () => {
			await populateVault();

			await createSnapshot(vaultPath, "alpha");
			// Small delay to ensure different timestamps
			await new Promise((r) => setTimeout(r, 10));
			await createSnapshot(vaultPath, "beta");
			await new Promise((r) => setTimeout(r, 10));
			await createSnapshot(vaultPath, "gamma");

			const snapshots = await listSnapshots(vaultPath);

			expect(snapshots).toHaveLength(3);
			expect(snapshots[0]?.name).toBe("alpha");
			expect(snapshots[1]?.name).toBe("beta");
			expect(snapshots[2]?.name).toBe("gamma");

			// Verify sorted by timestamp
			for (let i = 1; i < snapshots.length; i++) {
				expect(snapshots[i]?.timestamp >= snapshots[i - 1]?.timestamp).toBe(true);
			}
		});

		it("returns empty array when no snapshots exist", async () => {
			const snapshots = await listSnapshots(vaultPath);
			expect(snapshots).toEqual([]);
		});
	});

	describe("named snapshots", () => {
		it("supports creating and restoring multiple named snapshots", async () => {
			await populateVault();

			// Snapshot "v1"
			await createSnapshot(vaultPath, "v1");

			// Modify and snapshot "v2"
			await writeFile(join(vaultPath, "usertrust.config.json"), '{"version": 2}');
			await createSnapshot(vaultPath, "v2");

			// Restore v1
			await restoreSnapshot(vaultPath, "v1");
			let config = await readFile(join(vaultPath, "usertrust.config.json"), "utf-8");
			expect(config).toBe('{"version": 1}');

			// Restore v2
			await restoreSnapshot(vaultPath, "v2");
			config = await readFile(join(vaultPath, "usertrust.config.json"), "utf-8");
			expect(config).toBe('{"version": 2}');
		});
	});

	// ── Edge cases for uncovered branches ──

	describe("gatherVaultFiles edge cases", () => {
		it("returns empty array when vault path does not exist (line 74)", async () => {
			const nonExistentPath = join(tempDir, "non-existent-vault");
			const meta = await createSnapshot(nonExistentPath, "empty-snap");

			expect(meta.files).toEqual([]);
			expect(meta.size).toBe(0);
		});

		it("skips entries not in INCLUDED_PATHS set (line 83)", async () => {
			// Create files/dirs that are NOT in the include set
			await mkdir(join(vaultPath, "custom-dir"), { recursive: true });
			await writeFile(join(vaultPath, "custom-dir", "data.txt"), "hello");
			await writeFile(join(vaultPath, "random-file.txt"), "world");

			// Create one included file for reference
			await writeFile(join(vaultPath, "usertrust.config.json"), '{"version": 1}');

			const meta = await createSnapshot(vaultPath, "filter-snap");

			// Only the included file should be present
			expect(meta.files).toContain("usertrust.config.json");
			expect(meta.files).not.toContain("custom-dir/data.txt");
			expect(meta.files).not.toContain("random-file.txt");
		});

		it("handles vault with missing optional files (e.g. no leases.json)", async () => {
			// Only create audit directory, no leases.json
			await mkdir(join(vaultPath, "audit"), { recursive: true });
			await writeFile(join(vaultPath, "audit", "chain.jsonl"), "data\n");

			const meta = await createSnapshot(vaultPath, "partial-snap");

			expect(meta.files).toContain("audit/chain.jsonl");
			expect(meta.files).not.toContain("leases.json");
		});
	});

	describe("collectFiles with nested directories (lines 54-55)", () => {
		it("recursively collects files from nested subdirectories", async () => {
			// Create a deeply nested structure under an included path
			await mkdir(join(vaultPath, "audit", "nested", "deep"), {
				recursive: true,
			});
			await writeFile(join(vaultPath, "audit", "nested", "deep", "event.jsonl"), "nested-data");
			await writeFile(join(vaultPath, "audit", "nested", "summary.json"), "{}");
			await writeFile(join(vaultPath, "audit", "top.jsonl"), "top-data");

			const meta = await createSnapshot(vaultPath, "nested-snap");

			expect(meta.files).toContain("audit/top.jsonl");
			expect(meta.files).toContain("audit/nested/summary.json");
			expect(meta.files).toContain("audit/nested/deep/event.jsonl");
		});
	});

	describe("listSnapshots edge cases", () => {
		it("skips non-JSON files in snapshots directory (line 185)", async () => {
			await populateVault();

			// Create a valid snapshot
			await createSnapshot(vaultPath, "valid");

			// Place a non-JSON file in the snapshots dir
			const snapshotsDir = join(vaultPath, "snapshots");
			await writeFile(join(snapshotsDir, "notes.txt"), "not a snapshot");

			const snapshots = await listSnapshots(vaultPath);

			// Only the valid .json snapshot should be listed
			expect(snapshots).toHaveLength(1);
			expect(snapshots[0]?.name).toBe("valid");
		});

		it("skips subdirectories in snapshots directory (line 185)", async () => {
			await populateVault();

			await createSnapshot(vaultPath, "real");

			// Create a subdirectory inside snapshots/
			const snapshotsDir = join(vaultPath, "snapshots");
			await mkdir(join(snapshotsDir, "subdir"), { recursive: true });
			// Also put a .json file inside the subdir (should not be found)
			await writeFile(join(snapshotsDir, "subdir", "nested.json"), '{"meta": {}}');

			const snapshots = await listSnapshots(vaultPath);

			expect(snapshots).toHaveLength(1);
			expect(snapshots[0]?.name).toBe("real");
		});

		it("skips corrupt snapshot files gracefully", async () => {
			await populateVault();
			await createSnapshot(vaultPath, "good");

			// Write a corrupt JSON file to snapshots dir
			const snapshotsDir = join(vaultPath, "snapshots");
			await writeFile(join(snapshotsDir, "corrupt.json"), "{ not valid json !!!");

			const snapshots = await listSnapshots(vaultPath);

			// Only the good snapshot should be returned
			expect(snapshots).toHaveLength(1);
			expect(snapshots[0]?.name).toBe("good");
		});
	});

	describe("restoreSnapshot edge cases", () => {
		it("throws when snapshot does not exist", async () => {
			await expect(restoreSnapshot(vaultPath, "nonexistent")).rejects.toThrow();
		});
	});
});
