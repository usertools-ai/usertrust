// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetPatternCache,
	flushPatterns,
	getPatternStats,
	hashPrompt,
	recordPattern,
} from "../../src/memory/patterns.js";

/**
 * Instrument for every `writeFile` the module under test performs.
 *
 * `vi.spyOn(fsp, "writeFile")` does NOT work here: a `node:fs/promises`
 * namespace object is not configurable in ESM, so the spy throws rather than
 * counting. It has to be a module mock that DELEGATES to the real
 * `writeFile` — a stubbed write would report a byte count no production path
 * ever pays, and would leave every read-back assertion below measuring a file
 * that was never created. `vi.hoisted` is what lets the hoisted `vi.mock`
 * factory close over this object.
 */
const writes = vi.hoisted(() => ({ bytes: 0, fail: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const writeFile: typeof actual.writeFile = async (...args) => {
		if (writes.fail) {
			throw new Error("EACCES: simulated write failure");
		}
		const data = args[1];
		writes.bytes += typeof data === "string" ? Buffer.byteLength(data) : (data as Buffer).length;
		return actual.writeFile(...args);
	};
	return { ...actual, default: actual, writeFile };
});

/** Mirrors `PERSIST_EVERY` in the module under test. */
const PERSIST_EVERY = 50;

let vault: string;
let memoryFile: string;

function record(model: string): Promise<void> {
	return recordPattern({ promptHash: "a".repeat(64), model, cost: 104, success: true }, vault);
}

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "pm-"));
	memoryFile = join(vault, "patterns", "memory.json");
	_resetPatternCache();
	writes.bytes = 0;
	writes.fail = false;
});

afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
	writes.fail = false;
	vi.restoreAllMocks();
	_resetPatternCache();
});

/** Total bytes handed to `writeFile` while `fn` runs. */
async function bytesWritten(fn: () => Promise<unknown>): Promise<number> {
	writes.bytes = 0;
	await fn();
	return writes.bytes;
}

describe("pattern memory write volume", () => {
	it("does not rewrite the whole history on every call", async () => {
		const total = await bytesWritten(async () => {
			for (let i = 0; i < 200; i++) {
				await record("claude-fable-5");
			}
		});
		// Rewrite-every-call is O(n^2): ~200 * (100 * ~180B) ~= 3.6 MB.
		// Debounced is ~200/PERSIST_EVERY rewrites. 500 KB separates them by an order of
		// magnitude in both directions, so this cannot pass or fail by accident.
		expect(total).toBeLessThan(500_000);
	});

	it("persists on the PERSIST_EVERY-th record, not before it", async () => {
		for (let i = 0; i < PERSIST_EVERY - 1; i++) {
			await record(`m-${i}`);
		}
		expect(existsSync(memoryFile)).toBe(false);

		await record("threshold");
		expect(existsSync(memoryFile)).toBe(true);
		expect(JSON.parse(readFileSync(memoryFile, "utf-8"))).toHaveLength(PERSIST_EVERY);
	});
});

describe("flushPatterns", () => {
	it("writes the tail that debouncing withheld", async () => {
		for (let i = 0; i < 3; i++) {
			await record(`m-${i}`);
		}
		// Fewer than PERSIST_EVERY: nothing has reached disk yet.
		expect(existsSync(memoryFile)).toBe(false);

		await flushPatterns(vault);

		const stored = JSON.parse(readFileSync(memoryFile, "utf-8")) as Array<{ model: string }>;
		expect(stored).toHaveLength(3);
		expect(stored.map((e) => e.model)).toEqual(["m-0", "m-1", "m-2"]);
	});

	it("writes nothing when nothing is pending", async () => {
		await record("only");
		await flushPatterns(vault);

		// A second flush must not rewrite the file, and a flush against a vault
		// nobody recorded to must not create an empty one.
		const idle = await bytesWritten(async () => {
			await flushPatterns(vault);
			await flushPatterns(join(vault, "never-used"));
		});
		expect(idle).toBe(0);
		expect(existsSync(join(vault, "never-used", "patterns", "memory.json"))).toBe(false);
	});

	it("reads back everything after a flush, across a cache reset", async () => {
		for (let i = 0; i < 7; i++) {
			await record(`m-${i}`);
		}
		await flushPatterns(vault);

		// The cache reset stands in for a fresh process: what survives is
		// exactly what the debounced write put on disk.
		_resetPatternCache();

		const stats = await getPatternStats(vault);
		expect(stats.totalEntries).toBe(7);
		expect(stats.uniqueModels).toBe(7);
	});
});

describe("behaviours debouncing must not change", () => {
	it("still evicts at MAX_ENTRIES", async () => {
		const seeded = Array.from({ length: 10_001 }, (_, i) => ({
			promptHash: "a".repeat(64),
			model: `model-${i}`,
			cost: 1,
			success: true,
			timestamp: new Date(Date.now() + i).toISOString(),
		}));
		mkdirSync(join(vault, "patterns"), { recursive: true });
		writeFileSync(memoryFile, JSON.stringify(seeded), "utf-8");
		_resetPatternCache();

		await record("final-model");
		await flushPatterns(vault);

		const stored = JSON.parse(readFileSync(memoryFile, "utf-8")) as Array<{ model: string }>;
		// 10,001 loaded + 1 new = 10,002, evict 2 oldest => 10,000.
		expect(stored).toHaveLength(10_000);
		expect(stored.some((e) => e.model === "model-0")).toBe(false);
		expect(stored.some((e) => e.model === "final-model")).toBe(true);
	});

	it("isolates a persist failure without losing the in-memory record", async () => {
		for (let i = 0; i < PERSIST_EVERY - 1; i++) {
			await record(`m-${i}`);
		}

		writes.fail = true;

		// The PERSIST_EVERY-th record is the first call to touch the disk.
		// `recordPattern` awaits `persist` with no catch, so it REJECTS — that is
		// unchanged by debouncing, and both `govern.ts` call sites isolate it with
		// `.catch(() => {})`. What this pins is the consequence that matters: the
		// isolation holds, and a failed write costs no record.
		await expect(record("during-failure")).rejects.toThrow(/simulated write failure/);
		await record("after-failure").catch(() => {});

		writes.fail = false;
		await flushPatterns(vault);

		const stored = JSON.parse(readFileSync(memoryFile, "utf-8")) as Array<{ model: string }>;
		expect(stored).toHaveLength(PERSIST_EVERY + 1);
		expect(stored.some((e) => e.model === "during-failure")).toBe(true);
		expect(stored.some((e) => e.model === "after-failure")).toBe(true);
	});

	it("never writes prompt text — only hashes", async () => {
		const prompt = "PROMPT-BODY-THAT-MUST-NEVER-LAND-ON-DISK";
		const promptHash = hashPrompt(prompt);

		await recordPattern({ promptHash, model: "claude-fable-5", cost: 104, success: true }, vault);
		await flushPatterns(vault);

		const raw = readFileSync(memoryFile, "utf-8");
		expect(raw).toContain(promptHash);
		expect(raw).not.toContain(prompt);
	});
});
