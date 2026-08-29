// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetPatternCache, recordPattern } from "../../src/memory/patterns.js";

/**
 * Byte counter for every `writeFile` the module under test performs.
 *
 * `vi.spyOn(fsp, "writeFile")` does NOT work here: a `node:fs/promises`
 * namespace object is not configurable in ESM, so the spy throws rather than
 * counting. It has to be a module mock that DELEGATES to the real
 * `writeFile` — a stubbed write would report a number no production path
 * ever pays. `vi.hoisted` is what lets the hoisted `vi.mock` factory close
 * over this object.
 */
const writes = vi.hoisted(() => ({ bytes: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const writeFile: typeof actual.writeFile = async (...args) => {
		const data = args[1];
		writes.bytes += typeof data === "string" ? Buffer.byteLength(data) : (data as Buffer).length;
		return actual.writeFile(...args);
	};
	return { ...actual, default: actual, writeFile };
});

let vault: string;
beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "pm-"));
	_resetPatternCache();
	writes.bytes = 0;
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
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
				await recordPattern(
					{ promptHash: "a".repeat(64), model: "claude-fable-5", cost: 104, success: true },
					vault,
				);
			}
		});
		// Rewrite-every-call is O(n^2): ~200 * (100 * ~180B) ~= 3.6 MB.
		// Debounced is ~200/PERSIST_EVERY rewrites. 500 KB separates them by an order of
		// magnitude in both directions, so this cannot pass or fail by accident.
		expect(total).toBeLessThan(500_000);
	});
});
