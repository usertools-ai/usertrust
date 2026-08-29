// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Flush accounting for the audit chain writer.
 *
 * These tests exist to make the number of fsyncs a MEASURED quantity rather
 * than an argued one. The pre-group-commit writer flushed twice per event —
 * `events.jsonl`, then the `.meta` sidecar — so durable-write throughput was
 * the governed-call ceiling: 8 concurrent appends cost 17 fsyncs (2 per event
 * plus one for the advisory lock file), and 8 whole PROCESSES only bought
 * 1.28x, because the ceiling is durable writes on one device. Group commit
 * shares one flush across everyone who wrote during the scheduling gap.
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

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../../src/shared/types.js";

/** Per-test interception. Reset in `beforeEach`; read inside the fs mock. */
const hooks: {
	/** Called before every real `fsyncSync`. Throw to simulate a flush failure. */
	onFsync?: (fd: number) => void;
	/** Called before every real `openSync`. Throw to fail that specific open. */
	onOpen?: (path: unknown, flags: unknown) => void;
	/**
	 * Given the byte length of a pending write, return the SHORT count to write
	 * instead. `undefined` writes everything, as the real syscall usually does.
	 */
	shortWrite?: (length: number) => number | undefined;
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
		openSync: (path: unknown, flags?: unknown, mode?: unknown): number => {
			hooks.onOpen?.(path, flags);
			return (actual.openSync as (...a: unknown[]) => number)(path, flags, mode);
		},
		writeSync: (fd: number, ...rest: unknown[]): number => {
			const [buffer, offset, length] = rest as [Buffer | string, number?, number?];
			const short = Buffer.isBuffer(buffer)
				? hooks.shortWrite?.(length ?? buffer.length)
				: undefined;
			if (short !== undefined) {
				return actual.writeSync(fd, buffer as Buffer, offset ?? 0, short);
			}
			return (actual.writeSync as (...a: unknown[]) => number)(fd, ...rest);
		},
	};
});

const { createAuditWriter } = await import("../../src/audit/chain.js");
const { readDurableEventHash } = await import("../../src/audit/chain.js");
const { verifyChain } = await import("../../src/audit/verify.js");

let vault: string;
beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "gc-"));
	delete hooks.onFsync;
	delete hooks.onOpen;
	delete hooks.shortWrite;
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
	delete hooks.onFsync;
	delete hooks.onOpen;
	delete hooks.shortWrite;
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

const logPathOf = (root: string): string => join(root, ".usertrust", "audit", "events.jsonl");

const readLines = (root: string): (AuditEvent & { sequence: number })[] =>
	readFileSync(logPathOf(root), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as AuditEvent & { sequence: number });

describe("audit chain — flush accounting", () => {
	it("shares ONE log flush across a concurrent batch", async () => {
		const w = createAuditWriter(vault);
		// Warm up: the advisory lock file costs its own fsync on the first
		// append, and counting it would flatter the batch by one.
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { warm: true } });
		const n = await countFsyncs(async () => {
			await Promise.all(
				Array.from({ length: 8 }, (_, i) =>
					w.appendEvent({ kind: "llm_call", actor: "local", data: { i } }),
				),
			);
		});
		// Was 16 for these 8 events (2 each). Now exactly 2 for the whole
		// batch: one for `events.jsonl`, one for the `.meta` sidecar.
		expect(n).toBe(2);
		w.release();
	});

	it("shares one log fsync across a concurrent batch", async () => {
		const w = createAuditWriter(vault);
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { warm: true } });
		const n = await countFsyncs(async () => {
			await Promise.all(
				Array.from({ length: 16 }, (_, i) =>
					w.appendEvent({ kind: "llm_call", actor: "local", data: { i } }),
				),
			);
		});
		// 16 events must cost far fewer than 32 flushes. Loose bound: it must at least halve.
		expect(n).toBeLessThan(16);
		w.release();
	});

	it("keeps the chain contiguous and verifiable under concurrency", async () => {
		const w = createAuditWriter(vault);
		const events = await Promise.all(
			Array.from({ length: 50 }, (_, i) =>
				w.appendEvent({ kind: "llm_call", actor: "local", data: { i } }),
			),
		);
		const seqs = events.map((e) => (e as { sequence: number }).sequence).sort((a, b) => a - b);
		expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
		expect(new Set(events.map((e) => e.hash)).size).toBe(50);

		// Measuring the flush count proves nothing about the chain. Read the
		// bytes back and verify them: order on disk, links, and hashes.
		const lines = readLines(vault);
		expect(lines).toHaveLength(50);
		expect(lines.map((e) => e.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
		expect(verifyChain(logPathOf(vault)).valid).toBe(true);
		w.release();
	});

	it("resolves no caller before its bytes are fsync'd", async () => {
		const w = createAuditWriter(vault);
		const order: string[] = [];
		// WHAT THIS INSTRUMENT DOES NOT SEE: a resolve that happened before the
		// fsync would still be OBSERVED after it, because `runFlush` is fully
		// synchronous and no microtask can run between the two. Mutation-checked
		// on 2026-08-28 by hoisting the resolve loop above `fsyncSync` — this
		// test still passed. The two failure tests below are what actually catch
		// it: a flush that throws must leave every member REJECTED, which is
		// impossible once they have resolved. Read them as this property's
		// detectors, and do not delete them as "just error-path coverage".
		hooks.onFsync = () => {
			order.push("fsync");
		};
		await Promise.all(
			Array.from({ length: 4 }, () =>
				w.appendEvent({ kind: "llm_call", actor: "local", data: {} }).then(() => {
					order.push("resolve");
				}),
			),
		);
		// Every resolve must be preceded by at least one fsync.
		expect(order[0]).toBe("fsync");
		expect(order.filter((o) => o === "resolve")).toHaveLength(4);
		expect(order.indexOf("resolve")).toBeGreaterThan(order.lastIndexOf("fsync"));
		w.release();
	});

	it("refuses a write that makes no progress rather than spinning", async () => {
		const w = createAuditWriter(vault);
		// `writeSync` returning 0 forever is the degenerate short write. Looping
		// on it would hang the writer — and a hung audit append hangs the
		// governed call behind it — so it must fail loudly into the ordinary
		// degrade path instead. The batch it opened is left with no members and
		// must still close its descriptor.
		hooks.shortWrite = () => 0;
		await expect(w.appendEvent({ kind: "llm_call", actor: "local", data: {} })).rejects.toThrow(
			/write made no progress/,
		);
		delete hooks.shortWrite;
		expect(w.isDegraded()).toBe(true);
		expect(w.getWriteFailures()).toBe(1);
		// The writer is still usable: the next append opens a fresh batch.
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { after: true } });
		expect(readLines(vault)).toHaveLength(1);
		w.release();
	});

	it("completes a short write instead of truncating the line", async () => {
		const w = createAuditWriter(vault);
		// `writeSync` is allowed to write fewer bytes than asked. Short exactly
		// one log line, mid-UTF-8-boundary-safe (a byte count, not a char count),
		// and the writer must loop until the rest lands — a truncated line is an
		// unparseable audit record no reader can recover.
		let shortened = 0;
		hooks.shortWrite = (length) => {
			if (shortened > 0 || length < 8) return undefined;
			shortened++;
			return Math.floor(length / 3);
		};
		await Promise.all(
			Array.from({ length: 3 }, (_, i) =>
				w.appendEvent({ kind: "llm_call", actor: "local", data: { i, pad: "é".repeat(40) } }),
			),
		);
		expect(shortened).toBe(1);
		const lines = readLines(vault);
		expect(lines).toHaveLength(3);
		expect(verifyChain(logPathOf(vault)).valid).toBe(true);
		w.release();
	});

	it("fails every member of a batch when the flush fails", async () => {
		const w = createAuditWriter(vault);
		// Warm up FIRST: without this the lock file's own fsync throws inside
		// the mutex and every caller fails on its own, so the test would pass
		// while proving nothing about the shared flush.
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { warm: true } });
		hooks.onFsync = () => {
			throw new Error("EIO");
		};
		const results = await Promise.allSettled(
			Array.from({ length: 5 }, () =>
				w.appendEvent({ kind: "llm_call", actor: "local", data: {} }),
			),
		);
		expect(results.every((r) => r.status === "rejected")).toBe(true);
		expect(w.isDegraded()).toBe(true);
		// Bookkeeping is per MEMBER, exactly as it was when every member was
		// its own append: five failures, five dead letters.
		expect(w.getWriteFailures()).toBe(5);
		const dlq = readFileSync(join(vault, ".usertrust", "dlq", "dead-letters.jsonl"), "utf-8")
			.trim()
			.split("\n");
		expect(dlq).toHaveLength(5);
		// Nothing durable was flushed, so no member may claim a chain handle.
		for (const r of results) {
			expect(readDurableEventHash((r as PromiseRejectedResult).reason)).toBeUndefined();
		}
		delete hooks.onFsync;
		w.release();
	});

	it("settles every member even when the failure bookkeeping itself throws", async () => {
		const w = createAuditWriter(vault);
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { warm: true } });
		hooks.onFsync = () => {
			throw new Error("EIO");
		};
		// The degrade path warns and dead-letters before rejecting. If that work
		// is what settles the members, a throw inside it strands every caller on
		// a promise that never resolves — an audit append that hangs hangs the
		// governed call behind it. The settle must run from a `finally`.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {
			throw new Error("console is gone");
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const results = await Promise.allSettled(
			Array.from({ length: 3 }, () =>
				w.appendEvent({ kind: "llm_call", actor: "local", data: {} }),
			),
		);
		warn.mockRestore();
		error.mockRestore();
		delete hooks.onFsync;
		expect(results.every((r) => r.status === "rejected")).toBe(true);
		w.release();
	});

	it("gives each member of a sidecar-failed batch its OWN durable hash", async () => {
		const w = createAuditWriter(vault);
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { warm: true } });
		// The log fsync succeeds and only the sidecar open fails, so every
		// member's bytes ARE on the chain. A shared error instance would hand
		// all four the LAST member's hash — a correlation handle pointing at
		// somebody else's record, which is worse than no handle at all.
		hooks.onOpen = (path, flags) => {
			if (typeof path === "string" && path.endsWith(".meta") && flags === "w") {
				const err = new Error(`EACCES: permission denied, open '${path}'`);
				(err as NodeJS.ErrnoException).code = "EACCES";
				throw err;
			}
		};
		const results = await Promise.allSettled(
			Array.from({ length: 4 }, (_, i) =>
				w.appendEvent({ kind: "llm_call", actor: "local", data: { i } }),
			),
		);
		delete hooks.onOpen;
		expect(results.every((r) => r.status === "rejected")).toBe(true);

		const hashes = results.map((r) => readDurableEventHash((r as PromiseRejectedResult).reason));
		expect(hashes.every((h) => typeof h === "string")).toBe(true);
		expect(new Set(hashes).size).toBe(4);
		// And each one names a record an auditor can actually read back.
		const onDisk = new Set(readLines(vault).map((e) => e.hash));
		for (const h of hashes) expect(onDisk.has(h as string)).toBe(true);
		w.release();
	});

	it("flush() awaits an in-flight batch", async () => {
		const w = createAuditWriter(vault);
		const pending = w.appendEvent({ kind: "llm_call", actor: "local", data: {} });
		let flushed = false;
		hooks.onFsync = () => {
			flushed = true;
		};
		await w.flush();
		expect(flushed).toBe(true);
		expect(readLines(vault)).toHaveLength(1);
		await pending;
		w.release();
	});
});
