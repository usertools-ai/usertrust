// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A scheduled run whose lock is taken by another process between the emit and the
 * redelivery is contention, not a failed delivery: it is recorded as `locked` and
 * exits 0.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let grabLockAfterEmit = false;
vi.mock("../../../src/audit/anchor.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../../src/audit/anchor.js")>();
	return {
		...real,
		createAnchorEmitter: (...a: Parameters<typeof real.createAnchorEmitter>) => {
			const emitter = real.createAnchorEmitter(...a);
			const anchorNow = emitter.anchorNow;
			emitter.anchorNow = async () => {
				const r = await anchorNow();
				if (grabLockAfterEmit) {
					// A live process that is not this one takes the writer lock.
					writeFileSync(
						join(real.anchorsDir(String(a[0])), ".anchor-writer.lock"),
						JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }),
					);
				}
				return r;
			};
			return emitter;
		},
	};
});

import { readLastRun } from "../../../src/audit/anchor-last-run.js";
import { run as anchorRun } from "../../../src/cli/anchor.js";
import { cleanupAll, makeAnchoredVault, tmp } from "./fixtures.js";

const origCwd = process.cwd();
const origHome = process.env.HOME;

beforeEach(() => {
	process.env.HOME = tmp("anchor-race-home-");
});

afterEach(() => {
	process.chdir(origCwd);
	process.env.HOME = origHome;
	delete process.env.USERTRUST_ANCHOR_KEY;
	process.exitCode = 0;
	grabLockAfterEmit = false;
	vi.restoreAllMocks();
	cleanupAll();
});

async function scheduled(args: string[]): Promise<{ reason: string; exit: number }> {
	const lines: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		lines.push(a.map(String).join(" "));
	});
	process.exitCode = 0;
	await anchorRun(["now", "--scheduled", ...args], { json: true });
	const exit = Number(process.exitCode ?? 0);
	process.exitCode = 0;
	vi.restoreAllMocks();
	return { reason: JSON.parse(lines.at(-1) as string).data.reason, exit };
}

describe("a lock taken between the emit and the redelivery", () => {
	it("is 'locked' with exit 0, and without the race the same quiet run is no-new-events", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const first = await scheduled(["--sink-file", s.storeFile]);
		expect(first.reason).toBe("anchored");
		// positive control: a quiet run with no race
		const quiet = await scheduled(["--sink-file", s.storeFile]);
		expect(quiet).toEqual({ reason: "no-new-events", exit: 0 });
		grabLockAfterEmit = true;
		const raced = await scheduled(["--sink-file", s.storeFile]);
		expect(raced).toEqual({ reason: "locked", exit: 0 });
		expect(readLastRun(s.root)).toMatchObject({ ok: true, reason: "locked" });
	});
});
