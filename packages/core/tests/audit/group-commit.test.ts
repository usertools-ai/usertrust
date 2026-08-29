// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Flush accounting for the audit chain writer.
 *
 * These tests exist to make the number of fsyncs a MEASURED quantity rather
 * than an argued one. The pre-group-commit writer flushed twice per event —
 * `events.jsonl`, then the `.meta` sidecar — so durable-write throughput was
 * the governed-call ceiling. The characterization test below records that
 * number before the change; Task 3 tightens it to a strict upper bound.
 *
 * Separate file from `chain.test.ts` because these need `node:fs` interception
 * that suite does not install.
 *
 * `vi.spyOn(fs, "fsyncSync")` does NOT work here — a node builtin's ESM
 * namespace is not configurable, and the spy throws `Cannot redefine property`.
 * The whole module is mocked instead, the way `harden/denial-meta-failure`
 * already does it, with the per-test behaviour hanging off a mutable `hooks`
 * object so the mock factory itself stays hoist-safe.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Per-test interception. Reset in `beforeEach`; read inside the fs mock. */
const hooks: {
	/** Called before every real `fsyncSync`. Throw to simulate a flush failure. */
	onFsync?: (fd: number) => void;
} = {};

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		default: actual,
		fsyncSync: (fd: number): void => {
			hooks.onFsync?.(fd);
			actual.fsyncSync(fd);
		},
	};
});

const { createAuditWriter } = await import("../../src/audit/chain.js");

let vault: string;
beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "gc-"));
	delete hooks.onFsync;
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
	delete hooks.onFsync;
	vi.restoreAllMocks();
});

/** Count fsyncSync calls made while `fn` runs. Deterministic — no wall-clock. */
async function countFsyncs(fn: () => Promise<unknown>): Promise<number> {
	let n = 0;
	hooks.onFsync = () => {
		n++;
	};
	try {
		await fn();
	} finally {
		delete hooks.onFsync;
	}
	return n;
}

describe("audit chain — flush accounting", () => {
	it("performs at least one fsync per concurrent append today (characterization)", async () => {
		const w = createAuditWriter(vault);
		const n = await countFsyncs(async () => {
			await Promise.all(
				Array.from({ length: 8 }, (_, i) =>
					w.appendEvent({ kind: "llm_call", actor: "local", data: { i } }),
				),
			);
		});
		// Today: 2 fsyncs per event (log + .meta sidecar) = 16 for 8 events,
		// plus 1 for the advisory lock file on the first append = 17.
		// Task 3 tightens this to a strict upper bound.
		expect(n).toBeGreaterThanOrEqual(8);
		w.release();
	});
});
