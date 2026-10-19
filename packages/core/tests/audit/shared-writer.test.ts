// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `openSharedAuditWriter`: the process's ONE audit writer per vault, behind a handle per governor.
 * Handles on one vault append through one writer (one mutex, one tail, one lock), join it at their
 * first append, and the last to release it releases the lock. Each handle's degraded state is its
 * own. A failed append is loud: a USERTRUST_AUDIT_DEGRADED process warning at a handle's first
 * failure and, with the count, at its release; the event is dead-lettered with its hash when its
 * bytes reached the chain anyway.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUDIT_DEGRADED_WARNING,
	type AuditWriter,
	AuditWriterLockHeldError,
	openSharedAuditWriter,
} from "../../src/audit/chain.js";
import { readChainDeadLetters } from "../../src/audit/dead-letters.js";
import { verifyVault } from "../../src/audit/verify.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { securePrivateVault } from "../../src/shared/private-fs.js";

let tempDir: string;
const handles: AuditWriter[] = [];
const warnings: Array<{ code: string | undefined; message: string }> = [];
const onWarning = (w: Error & { code?: string }) =>
	warnings.push({ code: w.code, message: w.message });

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "shared-writer-"));
	warnings.length = 0;
	process.on("warning", onWarning);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	for (const h of handles.splice(0)) {
		try {
			h.release();
		} catch {
			/* already released */
		}
	}
	process.off("warning", onWarning);
	vi.restoreAllMocks();
	rmSync(tempDir, { recursive: true, force: true });
});

/** A handle, opened as a governor opens one: the vault first made (or closed) owner-only. */
function open(vault = tempDir): AuditWriter {
	securePrivateVault(join(vault, VAULT_DIR), { create: true });
	const h = openSharedAuditWriter(vault);
	handles.push(h);
	return h;
}
const auditDir = () => join(tempDir, VAULT_DIR, "audit");
const lockPath = () => join(auditDir(), ".audit-writer.lock");
interface LogLine {
	hash: string;
	previousHash: string;
	sequence: number;
	kind: string;
	actor: string;
	data: unknown;
}
const logLines = (vault = tempDir) =>
	readFileSync(join(vault, VAULT_DIR, "audit", "events.jsonl"), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as LogLine);
/** Whether this filesystem folds case: `a` found as `A`. */
const caseInsensitive = (() => {
	const probe = mkdtempSync(join(tmpdir(), "case-probe-"));
	try {
		writeFileSync(join(probe, "a"), "");
		return existsSync(join(probe, "A"));
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();
/**
 * macOS: a path's firmlinked spelling under /System/Volumes/Data — the same directory (one dev:ino)
 * whose real path is ANOTHER string. Undefined where there is none.
 */
function firmlinkedSpelling(dir: string): string | undefined {
	const real = realpathSync.native(dir);
	const other = join("/System/Volumes/Data", real);
	try {
		const a = statSync(real, { bigint: true });
		const b = statSync(other, { bigint: true });
		return a.dev === b.dev && a.ino === b.ino && realpathSync.native(other) !== real
			? other
			: undefined;
	} catch {
		return undefined;
	}
}
/** This test's own: a warning from an earlier test's release can land a tick later, in this one. */
const degradedWarnings = () =>
	warnings.filter((w) => w.code === AUDIT_DEGRADED_WARNING && w.message.includes(tempDir));
/** The parent PID is a live process other than this one: its lock is held. */
const heldByAnotherProcess = () => {
	mkdirSync(auditDir(), { recursive: true });
	writeFileSync(
		lockPath(),
		JSON.stringify({ pid: process.ppid, startedAt: "2020-01-01T00:00:00Z" }),
	);
};

describe("openSharedAuditWriter: one writer per vault per process", () => {
	it("two handles on one vault append CONCURRENTLY into ONE linked chain; neither fails", async () => {
		const a = open();
		const b = open();
		await Promise.all(
			Array.from({ length: 60 }, (_, i) =>
				(i % 2 === 0 ? a : b).appendEvent({ kind: "test.shared", actor: "sys", data: { i } }),
			),
		);
		const chain = logLines();
		expect(chain).toHaveLength(60);
		chain.forEach((e, i) => {
			expect(e.sequence).toBe(i + 1);
			if (i > 0) expect(e.previousHash).toBe(chain[i - 1]?.hash);
		});
		expect(a.getWriteFailures() + b.getWriteFailures()).toBe(0);
		expect(a.isDegraded() || b.isDegraded()).toBe(false);
		expect(verifyVault(join(tempDir, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 60 });
	});

	it("CONTROL: two writers of their own (the old shape) — the second's every append fails on the lock", async () => {
		const { createAuditWriter } = await import("../../src/audit/chain.js");
		const a = createAuditWriter(tempDir);
		const b = createAuditWriter(tempDir);
		try {
			await a.appendEvent({ kind: "test.a", actor: "sys", data: {} });
			await expect(
				b.appendEvent({ kind: "test.b", actor: "sys", data: {} }),
			).rejects.toBeInstanceOf(AuditWriterLockHeldError);
		} finally {
			a.release();
			b.release();
		}
	});

	it("two spellings of one vault (a symlink) share the writer", async () => {
		const alias = `${tempDir}-alias`;
		symlinkSync(tempDir, alias);
		try {
			const a = open();
			const b = open(alias);
			await a.appendEvent({ kind: "test.a", actor: "sys", data: {} });
			// A rejection is caught so that it fails THIS assertion (a second writer would be refused the
			// lock), rather than erroring the test.
			const refused = await b.appendEvent({ kind: "test.b", actor: "sys", data: {} }).then(
				() => undefined,
				(err: unknown) => err,
			);
			expect(refused).toBeUndefined();
			expect(logLines()).toHaveLength(2);
			expect(b.getWriteFailures()).toBe(0);
		} finally {
			unlinkSync(alias);
		}
	});

	it("a handle opened with a RELATIVE path stays on its vault after a chdir, and shares the writer with one opened by the absolute path", async () => {
		const elsewhere = `${tempDir}-elsewhere`;
		mkdirSync(elsewhere);
		const cwd = process.cwd();
		process.chdir(tempDir);
		try {
			// Each outcome is captured, so that a refused append fails an assertion here rather than
			// erroring the test.
			const outcome = (p: Promise<unknown>) =>
				p.then(
					() => "appended",
					(err: unknown) => err,
				);
			const relative = open(".");
			const outcomes = [
				await outcome(relative.appendEvent({ kind: "test.before-chdir", actor: "sys", data: {} })),
			];
			process.chdir(elsewhere);
			const absolute = open(tempDir);
			outcomes.push(
				await outcome(relative.appendEvent({ kind: "test.after-chdir", actor: "sys", data: {} })),
				await outcome(absolute.appendEvent({ kind: "test.absolute", actor: "sys", data: {} })),
			);
			expect(outcomes).toEqual(["appended", "appended", "appended"]);
			expect(relative.getWriteFailures() + absolute.getWriteFailures()).toBe(0);
			expect(logLines().map((e) => e.kind)).toEqual([
				"test.before-chdir",
				"test.after-chdir",
				"test.absolute",
			]);
			expect(existsSync(join(elsewhere, VAULT_DIR))).toBe(false);
		} finally {
			process.chdir(cwd);
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it.runIf(caseInsensitive)(
		"two spellings of one vault by CASE (a case-insensitive filesystem) share the writer, under the directory's own name",
		async () => {
			const vault = join(tempDir, "Vault");
			mkdirSync(vault);
			const a = open(vault);
			const b = open(join(tempDir, "vault"));
			const settled = await Promise.allSettled([
				a.appendEvent({ kind: "test.a", actor: "sys", data: {} }),
				b.appendEvent({ kind: "test.b", actor: "sys", data: {} }),
			]);
			expect(settled.filter((r) => r.status === "rejected")).toEqual([]);
			expect(logLines(vault)).toHaveLength(2);
			expect(readdirSync(tempDir)).toEqual(["Vault"]);
			expect(verifyVault(join(vault, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 2 });
		},
	);

	it.runIf(!caseInsensitive)(
		"CONTROL (a case-sensitive filesystem): Vault and vault are two vaults, with a writer each",
		async () => {
			const upper = join(tempDir, "Vault");
			const lower = join(tempDir, "vault");
			mkdirSync(upper);
			mkdirSync(lower);
			const a = open(upper);
			const b = open(lower);
			await a.appendEvent({ kind: "test.a", actor: "sys", data: {} });
			await b.appendEvent({ kind: "test.b", actor: "sys", data: {} });
			expect(a.getWriteFailures() + b.getWriteFailures()).toBe(0);
			expect(logLines(upper).map((e) => e.kind)).toEqual(["test.a"]);
			expect(logLines(lower).map((e) => e.kind)).toEqual(["test.b"]);
			for (const v of [upper, lower]) {
				expect(existsSync(join(v, VAULT_DIR, "audit", ".audit-writer.lock"))).toBe(true);
			}
		},
	);

	it.runIf(firmlinkedSpelling(tmpdir()) !== undefined)(
		"a spelling with ANOTHER real path but the same inode (macOS: a firmlink) shares the writer: the key is the inode, not a path",
		async () => {
			const other = firmlinkedSpelling(tempDir);
			if (other === undefined) throw new Error("no firmlinked spelling of this vault");
			const a = open(tempDir);
			const b = open(other);
			const settled = await Promise.allSettled([
				a.appendEvent({ kind: "test.a", actor: "sys", data: {} }),
				b.appendEvent({ kind: "test.b", actor: "sys", data: {} }),
			]);
			expect(settled.filter((r) => r.status === "rejected")).toEqual([]);
			expect(logLines()).toHaveLength(2);
		},
	);

	it("two vaults whose audit directories are ONE (a symlink) get a writer each: the second is refused, loudly, and its dead letters are in its OWN queue", async () => {
		const second = `${tempDir}-second`;
		mkdirSync(join(second, VAULT_DIR), { recursive: true });
		const first = open();
		await first.appendEvent({ kind: "test.first", actor: "sys", data: {} });
		symlinkSync(auditDir(), join(second, VAULT_DIR, "audit"));
		try {
			const other = open(second);
			// Captured, so that an append that is NOT refused fails this assertion.
			const outcome = await other
				.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_2nd" } })
				.then(
					() => "appended",
					(err: unknown) => err,
				);
			expect(outcome).toBeInstanceOf(AuditWriterLockHeldError);
			expect(readChainDeadLetters(join(second, VAULT_DIR), () => undefined)).toMatchObject({
				missing: 1,
				missingTransferIds: ["tx_2nd"],
			});
			expect(existsSync(join(tempDir, VAULT_DIR, "dlq"))).toBe(false);
		} finally {
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("a vault an earlier writer built under another spelling is continued, not forked: the same files, one chain", async () => {
		// The shape before this fix: a writer of its own, by an alias, and then the shared writer.
		const { createAuditWriter } = await import("../../src/audit/chain.js");
		const alias = `${tempDir}-alias`;
		symlinkSync(tempDir, alias);
		try {
			const old = createAuditWriter(alias);
			await old.appendEvent({ kind: "test.old1", actor: "sys", data: {} });
			await old.appendEvent({ kind: "test.old2", actor: "sys", data: {} });
			old.release();
			const h = open(tempDir);
			await h.appendEvent({ kind: "test.new", actor: "sys", data: {} });
			h.release();
		} finally {
			unlinkSync(alias);
		}
		const chain = logLines();
		expect(chain.map((e) => e.kind)).toEqual(["test.old1", "test.old2", "test.new"]);
		expect(chain[2]?.sequence).toBe(3);
		expect(chain[2]?.previousHash).toBe(chain[1]?.hash);
		expect(readdirSync(auditDir()).filter((f) => f.endsWith(".jsonl"))).toEqual(["events.jsonl"]);
		expect(verifyVault(join(tempDir, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});

	it("a handle joins at its first append: one that never appends takes no lock and holds nothing", async () => {
		const idle = open();
		expect(existsSync(lockPath())).toBe(false);
		await idle.flush();
		idle.release();
		expect(existsSync(lockPath())).toBe(false);
		const active = open();
		await active.appendEvent({ kind: "test.a", actor: "sys", data: {} });
		expect(existsSync(lockPath())).toBe(true);
	});

	it("the lock stays while ANY joined handle is open, and goes with the last; release is idempotent", async () => {
		const a = open();
		const b = open();
		await a.appendEvent({ kind: "test.a", actor: "sys", data: {} });
		await b.appendEvent({ kind: "test.b", actor: "sys", data: {} });
		a.release();
		a.release(); // a second release must not count as another handle leaving
		expect(existsSync(lockPath())).toBe(true);
		await b.appendEvent({ kind: "test.b2", actor: "sys", data: {} });
		b.release();
		expect(existsSync(lockPath())).toBe(false);
		expect(logLines()).toHaveLength(3);
	});

	it("an append after the release (a late call) lands on the chain and keeps nothing: no lock is left behind", async () => {
		const a = open();
		await a.appendEvent({ kind: "test.1", actor: "sys", data: {} });
		a.release();
		expect(existsSync(lockPath())).toBe(false);
		await a.appendEvent({ kind: "test.2", actor: "sys", data: {} });
		expect(existsSync(lockPath())).toBe(false);
		a.release();
		const b = open();
		await b.appendEvent({ kind: "test.3", actor: "sys", data: {} });
		b.release();
		const chain = logLines();
		expect(chain.map((e) => e.sequence)).toEqual([1, 2, 3]);
		expect(chain[2]?.previousHash).toBe(chain[1]?.hash);
		expect(verifyVault(join(tempDir, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});
});

describe("a destroyed governor's late append never holds the writer for the others", () => {
	it("A released, then A's late append, then B released: the lock goes with B, as the last open handle", async () => {
		const a = open();
		const b = open();
		await a.appendEvent({ kind: "test.a", actor: "sys", data: {} });
		await b.appendEvent({ kind: "test.b", actor: "sys", data: {} });
		a.release(); // A's governor is destroyed; B is still open
		await a.appendEvent({ kind: "test.a-late", actor: "sys", data: {} }); // A's call finishes late
		expect(existsSync(lockPath())).toBe(true); // B still holds it
		b.release();
		expect(existsSync(lockPath())).toBe(false);
		expect(logLines().map((e) => (e as unknown as { kind: string }).kind)).toEqual([
			"test.a",
			"test.b",
			"test.a-late",
		]);
	});

	it("a release that lands while an append is still queued leaves the writer to that append, which releases it", async () => {
		const a = open();
		await a.appendEvent({ kind: "test.1", actor: "sys", data: {} });
		// Joined, but not yet written: it waits on the writer's mutex when the governor is destroyed.
		const queued = a.appendEvent({ kind: "test.2", actor: "sys", data: {} });
		a.release();
		await queued;
		expect(existsSync(lockPath())).toBe(false); // no lock orphaned on a writer nobody holds
		// And the vault is not left to a stale writer: the next client writes, refused by nothing.
		const b = open();
		const refused = await b.appendEvent({ kind: "test.3", actor: "sys", data: {} }).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(refused).toBeUndefined();
		b.release();
		expect(logLines()).toHaveLength(3);
	});

	it("two late appends at once both land, and neither keeps the writer", async () => {
		const a = open();
		await a.appendEvent({ kind: "test.a", actor: "sys", data: {} });
		a.release();
		await Promise.all([
			a.appendEvent({ kind: "test.late1", actor: "sys", data: {} }),
			a.appendEvent({ kind: "test.late2", actor: "sys", data: {} }),
		]);
		expect(existsSync(lockPath())).toBe(false);
		expect(logLines()).toHaveLength(3);
	});
});

describe("a failed append is loud, and each handle's degraded state is its own", () => {
	it("one warning at a handle's FIRST failure, one with the count at its release; the events are dead-lettered", async () => {
		heldByAnotherProcess();
		const a = open();
		for (let i = 0; i < 3; i++) {
			await expect(
				a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: `tx_${i}` } }),
			).rejects.toBeInstanceOf(AuditWriterLockHeldError);
		}
		await new Promise((r) => setImmediate(r)); // warnings are emitted on the next tick
		expect(degradedWarnings()).toHaveLength(1);
		expect(degradedWarnings()[0]?.message).toMatch(
			/are degraded — failing: AuditWriterLockHeldError/,
		);
		expect(degradedWarnings()[0]?.message).toContain(join(VAULT_DIR, "dlq", "dead-letters.jsonl"));
		expect(a.isDegraded()).toBe(true);
		expect(a.getWriteFailures()).toBe(3);
		a.release();
		await new Promise((r) => setImmediate(r));
		expect(degradedWarnings()).toHaveLength(2);
		expect(degradedWarnings()[1]?.message).toMatch(
			/3 audit writes failed while this controller was open/,
		);
		// Every lost event is in the dead-letter queue, and the reader counts each as missing.
		const dl = readChainDeadLetters(join(tempDir, VAULT_DIR), () => undefined);
		expect(dl).toMatchObject({
			missing: 3,
			missingByKind: { llm_call: 3 },
			missingTransferIds: ["tx_0", "tx_1", "tx_2"],
		});
	});

	it("a release that lands while failing appends are still queued reports THEIR whole count once they finish; a late batch is counted too", async () => {
		heldByAnotherProcess();
		const a = open();
		const settle = (p: Promise<unknown>) =>
			p.then(
				() => "appended",
				(err: unknown) => err,
			);
		const queued = [0, 1, 2].map((i) =>
			settle(a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: `tx_q${i}` } })),
		);
		// destroy() whose drain timed out: the three are still queued on the writer.
		a.release();
		const outcomes = await Promise.all(queued);
		expect(outcomes.every((o) => o instanceof AuditWriterLockHeldError)).toBe(true);
		await new Promise((r) => setImmediate(r));
		const atRelease = degradedWarnings().map((w) => w.message);
		expect(atRelease).toHaveLength(2);
		expect(atRelease[0]).toMatch(/are degraded — failing: AuditWriterLockHeldError/);
		expect(atRelease[1]).toMatch(/3 audit writes failed while this controller was open/);
		// Late calls after the release: the first failure warns, and the batch's count follows it.
		const late = await Promise.all(
			[0, 1].map((i) =>
				settle(
					a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: `tx_l${i}` } }),
				),
			),
		);
		expect(late.every((o) => o instanceof AuditWriterLockHeldError)).toBe(true);
		await new Promise((r) => setImmediate(r));
		const after = degradedWarnings()
			.map((w) => w.message)
			.slice(2);
		expect(after).toHaveLength(2);
		expect(after[0]).toMatch(/are degraded — failing:/);
		expect(after[1]).toMatch(/2 audit writes failed after this controller was destroyed/);
	});

	it("a report never clears what the governor reads: a late failure stays counted and degraded, through a later late success", async () => {
		const a = open();
		await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_open" } });
		a.release();
		// A call that outlived destroy(): its append fails (a directory where the anchor is renamed to),
		// and it is the last in flight, so its own report runs before its rejection reaches its caller.
		const meta = join(auditDir(), "events.jsonl.meta");
		const anchor = readFileSync(meta);
		rmSync(meta);
		mkdirSync(meta);
		const failedLate = await a
			.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_late1" } })
			.then(
				() => "appended",
				(err: unknown) => err,
			);
		expect(failedLate).toBeInstanceOf(Error);
		// What that caller reads (`failClosed` refuses on it, and its error names the count):
		expect(a.getWriteFailures()).toBe(1);
		expect(a.isDegraded()).toBe(true);
		rmSync(meta, { recursive: true });
		writeFileSync(meta, anchor);
		// A second late call succeeds: the handle stays degraded, so a failClosed call still refuses.
		await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_late2" } });
		expect(a.isDegraded()).toBe(true);
		expect(a.getWriteFailures()).toBe(1);
		await new Promise((r) => setImmediate(r));
		expect(degradedWarnings().map((w) => w.message)).toEqual([
			expect.stringMatching(/are degraded — failing:/),
			expect.stringMatching(/1 audit write failed after this controller was destroyed/),
		]);
	});

	it("CONTROL: a handle with no failure emits no warning, at its appends or its release", async () => {
		const a = open();
		await a.appendEvent({ kind: "test.ok", actor: "sys", data: {} });
		a.release();
		await new Promise((r) => setImmediate(r));
		expect(degradedWarnings()).toEqual([]);
	});

	it("one handle's failures do not mark another handle degraded", async () => {
		heldByAnotherProcess();
		const a = open();
		const b = open();
		await expect(a.appendEvent({ kind: "test.a", actor: "sys", data: {} })).rejects.toThrow();
		expect(a.isDegraded()).toBe(true);
		expect(b.isDegraded()).toBe(false);
		expect(b.getWriteFailures()).toBe(0);
		// The other process lets go of the vault: b appends on the shared writer and is not degraded.
		rmSync(lockPath());
		await b.appendEvent({ kind: "test.b", actor: "sys", data: {} });
		expect(b.isDegraded()).toBe(false);
	});

	it("a vault whose audit directory is a file: each append fails, counted, warned and dead-lettered", async () => {
		mkdirSync(join(tempDir, VAULT_DIR), { recursive: true });
		writeFileSync(auditDir(), "not a directory");
		const a = open();
		await expect(
			a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_unreached" } }),
		).rejects.toThrow();
		await new Promise((r) => setImmediate(r));
		expect(a.isDegraded()).toBe(true);
		expect(a.getWriteFailures()).toBe(1);
		expect(degradedWarnings()).toHaveLength(1);
		expect(readChainDeadLetters(join(tempDir, VAULT_DIR), () => undefined)).toMatchObject({
			missing: 1,
			missingTransferIds: ["tx_unreached"],
		});
		a.release();
	});

	it("an event whose bytes DID reach the chain before the failure is dead-lettered WITH its hash, and is not counted missing", async () => {
		const a = open();
		await a.appendEvent({ kind: "test.first", actor: "sys", data: {} });
		// The `.meta` anchor cannot be replaced (a directory in its place): the next append's log line is
		// fsync'd, then the anchor write fails, and the append rejects for an event that IS on the chain.
		const meta = join(auditDir(), "events.jsonl.meta");
		rmSync(meta);
		mkdirSync(meta);
		await expect(a.appendEvent({ kind: "test.second", actor: "sys", data: {} })).rejects.toThrow();
		const chain = logLines();
		expect(chain).toHaveLength(2);
		const letters = readFileSync(join(tempDir, VAULT_DIR, "dlq", "dead-letters.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { eventHash?: string });
		expect(letters).toHaveLength(1);
		expect(letters[0]?.eventHash).toBe(chain[1]?.hash);
		const byHash = new Map(chain.map((e) => [e.hash, e]));
		expect(readChainDeadLetters(join(tempDir, VAULT_DIR), (h) => byHash.get(h))).toMatchObject({
			missing: 0,
			onChain: 1,
		});
	});
});
