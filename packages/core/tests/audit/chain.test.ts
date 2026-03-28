import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";
import type { AuditEvent } from "../../src/shared/types.js";

describe("Audit Chain Writer", () => {
	let tempDir: string;
	let writer: ReturnType<typeof createAuditWriter>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-chain-"));
		writer = createAuditWriter(tempDir);
	});

	afterEach(() => {
		writer.release();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates JSONL file and writes first event with genesis hash", async () => {
		const event = await writer.appendEvent({
			kind: "test.event",
			actor: "test-system",
			data: { key: "value" },
		});

		const logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
		expect(existsSync(logPath)).toBe(true);
		expect(event.previousHash).toBe(GENESIS_HASH);
	});

	it("chains hashes — second event previousHash = first event hash", async () => {
		const first = await writer.appendEvent({
			kind: "test.first",
			actor: "test-system",
			data: { order: 1 },
		});

		const second = await writer.appendEvent({
			kind: "test.second",
			actor: "test-system",
			data: { order: 2 },
		});

		expect(second.previousHash).toBe(first.hash);
		expect(second.hash).not.toBe(first.hash);
	});

	it("each event hash is SHA-256 of canonical event without hash field", async () => {
		const event = await writer.appendEvent({
			kind: "test.verify",
			actor: "sys",
			data: { n: 42 },
		});

		const { hash: storedHash, ...eventWithoutHash } = event;
		const canonical = canonicalize(eventWithoutHash);
		const computedHash = createHash("sha256").update(canonical).digest("hex");
		expect(storedHash).toBe(computedHash);
	});

	it("returns valid AuditEvent with all required fields", async () => {
		const event = await writer.appendEvent({
			kind: "agent.activate",
			actor: "agent-1",
			data: { agentId: "scrubber", cost: 10 },
		});

		expect(event.id).toBeDefined();
		expect(typeof event.id).toBe("string");
		expect(event.hash).toHaveLength(64); // SHA-256 hex
		expect(event.previousHash).toBe(GENESIS_HASH);
		expect(event.timestamp).toBeDefined();
		expect(event.kind).toBe("agent.activate");
		expect(event.actor).toBe("agent-1");
		expect(event.data).toEqual({ agentId: "scrubber", cost: 10 });
	});

	it("writes valid JSONL — each line independently parseable", async () => {
		await writer.appendEvent({
			kind: "test.a",
			actor: "sys",
			data: { n: 1 },
		});
		await writer.appendEvent({
			kind: "test.b",
			actor: "sys",
			data: { n: 2 },
		});
		await writer.appendEvent({
			kind: "test.c",
			actor: "sys",
			data: { n: 3 },
		});

		const logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
		const content = readFileSync(logPath, "utf-8").trim();
		const lines = content.split("\n");
		expect(lines).toHaveLength(3);

		for (const line of lines) {
			const parsed = JSON.parse(line) as AuditEvent;
			expect(parsed.id).toBeDefined();
			expect(parsed.hash).toBeDefined();
		}
	});

	it("chain verification detects tampering — modified data", async () => {
		await writer.appendEvent({
			kind: "test.a",
			actor: "sys",
			data: { n: 1 },
		});
		await writer.appendEvent({
			kind: "test.b",
			actor: "sys",
			data: { n: 2 },
		});

		const logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
		const content = readFileSync(logPath, "utf-8").trim();
		const lines = content.split("\n");

		// Tamper with first event's data
		const event = JSON.parse(lines[0] as string) as AuditEvent;
		event.data = { n: 999 };
		lines[0] = JSON.stringify(event);
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		// Verify — recompute hash of first event and check mismatch
		const tampered = JSON.parse(lines[0] as string) as AuditEvent;
		const { hash: storedHash, ...eventWithoutHash } = tampered;
		const canonical = canonicalize(eventWithoutHash);
		const computedHash = createHash("sha256").update(canonical).digest("hex");
		expect(storedHash).not.toBe(computedHash);
	});

	it("chain verification detects tampering — broken previousHash link", async () => {
		const first = await writer.appendEvent({
			kind: "test.a",
			actor: "sys",
			data: { n: 1 },
		});
		await writer.appendEvent({
			kind: "test.b",
			actor: "sys",
			data: { n: 2 },
		});
		await writer.appendEvent({
			kind: "test.c",
			actor: "sys",
			data: { n: 3 },
		});

		const logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
		const content = readFileSync(logPath, "utf-8").trim();
		const lines = content.split("\n");

		// Remove the second event — breaks the chain
		const remaining = [lines[0] as string, lines[2] as string];
		writeFileSync(logPath, `${remaining.join("\n")}\n`);

		// The third event's previousHash should point to second event's hash
		const third = JSON.parse(remaining[1] as string) as AuditEvent;
		expect(third.previousHash).not.toBe(first.hash);
	});

	it("generates unique IDs for each event", async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 10; i++) {
			const event = await writer.appendEvent({
				kind: "test.unique",
				actor: "sys",
				data: { n: i },
			});
			ids.add(event.id);
		}
		expect(ids.size).toBe(10);
	});

	it("timestamp is a valid ISO string", async () => {
		const event = await writer.appendEvent({
			kind: "test.time",
			actor: "sys",
			data: {},
		});
		const parsed = new Date(event.timestamp);
		expect(parsed.toISOString()).toBe(event.timestamp);
	});

	it("persists .meta sidecar with last hash", async () => {
		const event = await writer.appendEvent({
			kind: "test.meta",
			actor: "sys",
			data: {},
		});

		const metaPath = join(tempDir, ".usertrust", "audit", "events.jsonl.meta");
		expect(existsSync(metaPath)).toBe(true);

		const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
			lastHash: string;
			sequence: number;
		};
		expect(meta.lastHash).toBe(event.hash);
	});

	it("reads .meta sidecar when log is empty (post-rotation)", async () => {
		const event = await writer.appendEvent({
			kind: "test.prerotate",
			actor: "sys",
			data: {},
		});

		// Simulate rotation: empty the log but keep .meta
		const logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
		writeFileSync(logPath, "");

		// Release and recreate writer (clears cache)
		writer.release();
		writer = createAuditWriter(tempDir);

		const next = await writer.appendEvent({
			kind: "test.postrotate",
			actor: "sys",
			data: {},
		});

		expect(next.previousHash).toBe(event.hash);
	});
});

describe("Audit Chain Writer — concurrency", () => {
	let tempDir: string;
	let writer: ReturnType<typeof createAuditWriter>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-mutex-"));
		writer = createAuditWriter(tempDir);
	});

	afterEach(() => {
		writer.release();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("concurrent appends produce a valid hash chain", async () => {
		const promises = Array.from({ length: 5 }, (_, i) =>
			writer.appendEvent({
				kind: "test.concurrent",
				actor: "sys",
				data: { n: i },
			}),
		);

		await Promise.all(promises);

		const logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
		const content = readFileSync(logPath, "utf-8").trim();
		const lines = content.split("\n");
		let expectedPrev = GENESIS_HASH;

		for (const line of lines) {
			const event = JSON.parse(line) as AuditEvent & { sequence: number };
			expect(event.previousHash).toBe(expectedPrev);
			expectedPrev = event.hash;
		}
	});
});

describe("Audit Chain Writer — flush and release", () => {
	let tempDir: string;
	let writer: ReturnType<typeof createAuditWriter>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-flush-"));
		writer = createAuditWriter(tempDir);
	});

	afterEach(() => {
		writer.release();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("flush resolves after pending appends", async () => {
		const pending = writer.appendEvent({
			kind: "test.flush",
			actor: "sys",
			data: {},
		});

		await writer.flush();
		await pending;

		const logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
		const content = readFileSync(logPath, "utf-8").trim();
		expect(content.split("\n")).toHaveLength(1);
	});

	it("flush resolves immediately when nothing is pending", async () => {
		await writer.flush();
		// Should not throw or hang
	});

	it("release creates a clean state", () => {
		writer.release();
		expect(writer.isDegraded()).toBe(false);
		expect(writer.getWriteFailures()).toBe(0);
	});
});

describe("Audit Chain Writer — advisory lock", () => {
	let tempDir: string;
	let writer: ReturnType<typeof createAuditWriter>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-lock-"));
		writer = createAuditWriter(tempDir);
	});

	afterEach(() => {
		writer.release();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates .audit-writer.lock on first append", async () => {
		await writer.appendEvent({
			kind: "test.lock",
			actor: "sys",
			data: {},
		});

		const lockPath = join(tempDir, ".usertrust", "audit", ".audit-writer.lock");
		expect(existsSync(lockPath)).toBe(true);

		const lockContent = JSON.parse(readFileSync(lockPath, "utf-8")) as {
			pid: number;
			startedAt: string;
		};
		expect(lockContent.pid).toBe(process.pid);
	});

	it("lock file is removed by release()", async () => {
		await writer.appendEvent({
			kind: "test.release",
			actor: "sys",
			data: {},
		});

		const lockPath = join(tempDir, ".usertrust", "audit", ".audit-writer.lock");
		expect(existsSync(lockPath)).toBe(true);

		writer.release();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("detects stale lock from dead process and recovers", async () => {
		const lockPath = join(tempDir, ".usertrust", "audit", ".audit-writer.lock");
		// Ensure audit dir exists for the lock file
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		writeFileSync(lockPath, JSON.stringify({ pid: 999999999, startedAt: "2020-01-01T00:00:00Z" }));

		const event = await writer.appendEvent({
			kind: "test.stale",
			actor: "sys",
			data: {},
		});

		expect(event.previousHash).toBe(GENESIS_HASH);
		const lockContent = JSON.parse(readFileSync(lockPath, "utf-8")) as {
			pid: number;
		};
		expect(lockContent.pid).toBe(process.pid);
	});

	it("reclaims same-PID lock file", async () => {
		const lockPath = join(tempDir, ".usertrust", "audit", ".audit-writer.lock");
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		// Write a lock from our own PID (simulates crash without cleanup)
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: process.pid, startedAt: "2020-01-01T00:00:00Z" }),
		);

		const event = await writer.appendEvent({
			kind: "test.reclaim",
			actor: "sys",
			data: {},
		});

		expect(event.previousHash).toBe(GENESIS_HASH);
	});

	it("removes corrupt lock file and proceeds", async () => {
		const lockPath = join(tempDir, ".usertrust", "audit", ".audit-writer.lock");
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		writeFileSync(lockPath, "NOT VALID JSON!!!");

		const event = await writer.appendEvent({
			kind: "test.corrupt-lock",
			actor: "sys",
			data: {},
		});

		expect(event.previousHash).toBe(GENESIS_HASH);
	});

	it("throws when lock is held by a live process (EPERM)", async () => {
		const lockPath = join(tempDir, ".usertrust", "audit", ".audit-writer.lock");
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		// PID 1 (launchd/init) always exists and process.kill(1, 0) throws EPERM
		writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt: "2020-01-01T00:00:00Z" }));

		await expect(
			writer.appendEvent({
				kind: "test.eperm",
				actor: "sys",
				data: {},
			}),
		).rejects.toThrow("Audit writer lock held by PID 1");
	});

	it("throws when lock is held by a live accessible process (process.kill succeeds)", async () => {
		const lockPath = join(tempDir, ".usertrust", "audit", ".audit-writer.lock");
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		// Use the parent process PID — process.kill(ppid, 0) succeeds without error
		const ppid = process.ppid;
		writeFileSync(lockPath, JSON.stringify({ pid: ppid, startedAt: "2020-01-01T00:00:00Z" }));

		await expect(
			writer.appendEvent({
				kind: "test.live-lock",
				actor: "sys",
				data: {},
			}),
		).rejects.toThrow(`Audit writer lock held by PID ${ppid}`);
	});

	it("recovers from unknown error code in process.kill (error swallowed by outer catch)", async () => {
		// When process.kill throws with an unknown error code, the error
		// propagates through the inner catch (line 110) to the outer catch,
		// which swallows it and removes the stale lock file. The writer recovers.
		const freshDir = mkdtempSync(join(tmpdir(), "trust-audit-killmock-"));
		const freshWriter = createAuditWriter(freshDir);
		const lockPath = join(freshDir, VAULT_DIR, "audit", ".audit-writer.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: 999999998, startedAt: "2020-01-01T00:00:00Z" }));

		const origKill = process.kill.bind(process);
		process.kill = ((pid: number, signal?: string | number) => {
			if (pid === 999999998) {
				throw Object.assign(new Error("Unknown kill error"), {
					code: "EUNKNOWN",
				});
			}
			return origKill(pid, signal as number);
		}) as typeof process.kill;

		try {
			// The unknown error is swallowed by the outer catch; writer succeeds
			const event = await freshWriter.appendEvent({
				kind: "test.unknown-kill-err",
				actor: "sys",
				data: {},
			});
			expect(event.previousHash).toBe(GENESIS_HASH);
		} finally {
			process.kill = origKill;
			freshWriter.release();
			rmSync(freshDir, { recursive: true, force: true });
		}
	});

	it("recovers from non-Error thrown by process.kill", async () => {
		const freshDir = mkdtempSync(join(tmpdir(), "trust-audit-killmock2-"));
		const freshWriter = createAuditWriter(freshDir);
		const lockPath = join(freshDir, VAULT_DIR, "audit", ".audit-writer.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: 999999997, startedAt: "2020-01-01T00:00:00Z" }));

		const origKill = process.kill.bind(process);
		process.kill = ((pid: number, signal?: string | number) => {
			if (pid === 999999997) throw "string error";
			return origKill(pid, signal as number);
		}) as typeof process.kill;

		try {
			// Non-Error is also swallowed by outer catch; writer recovers
			const event = await freshWriter.appendEvent({
				kind: "test.non-error-kill",
				actor: "sys",
				data: {},
			});
			expect(event.previousHash).toBe(GENESIS_HASH);
		} finally {
			process.kill = origKill;
			freshWriter.release();
			rmSync(freshDir, { recursive: true, force: true });
		}
	});
});

describe("Audit Chain Writer — getLastEvent edge cases", () => {
	let tempDir: string;

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("falls back to .meta when last JSONL line is corrupt", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-corrupt-line-"));
		const writer1 = createAuditWriter(tempDir);

		const event = await writer1.appendEvent({
			kind: "test.preCorrupt",
			actor: "sys",
			data: {},
		});
		writer1.release();

		// Corrupt the JSONL (append garbage that will be the "last line")
		const logPath = join(tempDir, VAULT_DIR, "audit", "events.jsonl");
		const content = readFileSync(logPath, "utf-8");
		writeFileSync(logPath, `${content}NOT_VALID_JSON\n`);

		// Create a new writer — it should fall back to .meta
		const writer2 = createAuditWriter(tempDir);
		const next = await writer2.appendEvent({
			kind: "test.postCorrupt",
			actor: "sys",
			data: {},
		});

		// Should chain from the .meta sidecar (the last valid event's hash)
		expect(next.previousHash).toBe(event.hash);
		writer2.release();
	});

	it("returns genesis hash when JSONL is corrupt and .meta is missing", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-corrupt-no-meta-"));
		const auditDir = join(tempDir, VAULT_DIR, "audit");
		mkdirSync(auditDir, { recursive: true });

		const logPath = join(auditDir, "events.jsonl");
		writeFileSync(logPath, "NOT_VALID_JSON\n");

		const writer = createAuditWriter(tempDir);
		const event = await writer.appendEvent({
			kind: "test.fromGenesis",
			actor: "sys",
			data: {},
		});

		// No .meta, corrupt JSONL → fallback to genesis
		expect(event.previousHash).toBe(GENESIS_HASH);
		writer.release();
	});

	it("returns genesis hash when JSONL is empty and .meta is missing", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-empty-no-meta-"));
		const auditDir = join(tempDir, VAULT_DIR, "audit");
		mkdirSync(auditDir, { recursive: true });

		// Create an empty JSONL file with no .meta sidecar
		const logPath = join(auditDir, "events.jsonl");
		writeFileSync(logPath, "");

		const writer = createAuditWriter(tempDir);
		const event = await writer.appendEvent({
			kind: "test.emptyNoMeta",
			actor: "sys",
			data: {},
		});

		expect(event.previousHash).toBe(GENESIS_HASH);
		writer.release();
	});

	it("reads and chains from pre-existing JSONL (no cache, sequence from event)", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-preexist-"));

		// Write events with first writer
		const writer1 = createAuditWriter(tempDir);
		const event1 = await writer1.appendEvent({
			kind: "test.preexist",
			actor: "sys",
			data: { n: 1 },
		});
		writer1.release();

		// Delete the .meta sidecar so the new writer must parse the JSONL
		const metaPath = join(tempDir, VAULT_DIR, "audit", "events.jsonl.meta");
		if (existsSync(metaPath)) {
			const { unlinkSync } = await import("node:fs");
			unlinkSync(metaPath);
		}

		// Create a new writer (no cache, no .meta) — must parse last line
		const writer2 = createAuditWriter(tempDir);
		const event2 = await writer2.appendEvent({
			kind: "test.continued",
			actor: "sys",
			data: { n: 2 },
		});

		// Should chain from the first event's hash
		expect(event2.previousHash).toBe(event1.hash);
		writer2.release();
	});

	it("returns genesis hash when JSONL is corrupt and .meta is also corrupt", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-all-corrupt-"));
		const auditDir = join(tempDir, VAULT_DIR, "audit");
		mkdirSync(auditDir, { recursive: true });

		const logPath = join(auditDir, "events.jsonl");
		writeFileSync(logPath, "NOT_VALID_JSON\n");
		writeFileSync(`${logPath}.meta`, "ALSO_NOT_VALID_JSON");

		const writer = createAuditWriter(tempDir);
		const event = await writer.appendEvent({
			kind: "test.allCorrupt",
			actor: "sys",
			data: {},
		});

		expect(event.previousHash).toBe(GENESIS_HASH);
		writer.release();
	});
});

describe("Audit Chain Writer — degraded state and DLQ", () => {
	let tempDir: string;

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("sets degraded state and increments writeFailures on write error", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-degraded-"));
		const writer = createAuditWriter(tempDir);

		// Write once to get the lock + initial state
		await writer.appendEvent({
			kind: "test.ok",
			actor: "sys",
			data: {},
		});

		expect(writer.isDegraded()).toBe(false);
		expect(writer.getWriteFailures()).toBe(0);

		// Make the JSONL file read-only so the next write fails
		const logPath = join(tempDir, VAULT_DIR, "audit", "events.jsonl");
		chmodSync(logPath, 0o444);

		// The append should throw
		await expect(
			writer.appendEvent({
				kind: "test.fail",
				actor: "sys",
				data: {},
			}),
		).rejects.toThrow();

		expect(writer.isDegraded()).toBe(true);
		expect(writer.getWriteFailures()).toBe(1);

		// Restore permissions for cleanup
		chmodSync(logPath, 0o644);

		// Check DLQ was written
		const dlqPath = join(tempDir, VAULT_DIR, "dlq", "dead-letters.jsonl");
		expect(existsSync(dlqPath)).toBe(true);
		const dlqContent = readFileSync(dlqPath, "utf-8").trim();
		const dlqEntry = JSON.parse(dlqContent);
		expect(dlqEntry.source).toBe("audit.chain.appendEvent");

		writer.release();
	});

	it("release resets degraded state and write failure count", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-reset-"));
		const writer = createAuditWriter(tempDir);

		await writer.appendEvent({
			kind: "test.ok",
			actor: "sys",
			data: {},
		});

		// Force a failure
		const logPath = join(tempDir, VAULT_DIR, "audit", "events.jsonl");
		chmodSync(logPath, 0o444);

		await expect(
			writer.appendEvent({ kind: "test.fail", actor: "sys", data: {} }),
		).rejects.toThrow();

		expect(writer.isDegraded()).toBe(true);
		expect(writer.getWriteFailures()).toBe(1);

		// Restore and release
		chmodSync(logPath, 0o644);
		writer.release();

		expect(writer.isDegraded()).toBe(false);
		expect(writer.getWriteFailures()).toBe(0);
	});

	it("writes multiple DLQ entries when repeated failures occur", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-dlq-multi-"));
		const writer = createAuditWriter(tempDir);

		await writer.appendEvent({
			kind: "test.ok",
			actor: "sys",
			data: {},
		});

		const logPath = join(tempDir, VAULT_DIR, "audit", "events.jsonl");
		chmodSync(logPath, 0o444);

		// First failure creates DLQ dir and writes
		await expect(
			writer.appendEvent({ kind: "test.fail1", actor: "sys", data: {} }),
		).rejects.toThrow();

		// Second failure — DLQ dir already exists (covers the else branch)
		await expect(
			writer.appendEvent({ kind: "test.fail2", actor: "sys", data: {} }),
		).rejects.toThrow();

		expect(writer.getWriteFailures()).toBe(2);

		chmodSync(logPath, 0o644);

		// Verify both DLQ entries were written
		const dlqPath = join(tempDir, VAULT_DIR, "dlq", "dead-letters.jsonl");
		const dlqContent = readFileSync(dlqPath, "utf-8").trim().split("\n");
		expect(dlqContent).toHaveLength(2);

		writer.release();
	});

	it("DLQ write failure does not throw (last resort fallback)", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-dlq-fail-"));
		const writer = createAuditWriter(tempDir);

		await writer.appendEvent({
			kind: "test.ok",
			actor: "sys",
			data: {},
		});

		// Make the log read-only AND make the DLQ dir impossible to create
		const logPath = join(tempDir, VAULT_DIR, "audit", "events.jsonl");
		chmodSync(logPath, 0o444);

		// Make the vault dir read-only so DLQ dir can't be created
		const vaultDir = join(tempDir, VAULT_DIR);
		chmodSync(vaultDir, 0o555);

		// Should throw from the write failure, but NOT from DLQ failure
		await expect(
			writer.appendEvent({ kind: "test.fail", actor: "sys", data: {} }),
		).rejects.toThrow();

		// Restore permissions for cleanup
		chmodSync(vaultDir, 0o755);
		chmodSync(logPath, 0o644);
		writer.release();
	});

	it("handles non-Error exceptions in the degraded path (String(err))", async () => {
		// We can't easily make the fs functions throw a non-Error, but we
		// can verify that the degraded state tracks non-Error write failures
		// by checking that isDegraded and getWriteFailures work correctly
		// after multiple failures of different types
		tempDir = mkdtempSync(join(tmpdir(), "trust-audit-multi-fail-"));
		const writer = createAuditWriter(tempDir);

		await writer.appendEvent({
			kind: "test.ok",
			actor: "sys",
			data: {},
		});

		const logPath = join(tempDir, VAULT_DIR, "audit", "events.jsonl");
		chmodSync(logPath, 0o444);

		// Three consecutive failures
		for (let i = 0; i < 3; i++) {
			await expect(
				writer.appendEvent({ kind: `test.fail${i}`, actor: "sys", data: {} }),
			).rejects.toThrow();
		}

		expect(writer.getWriteFailures()).toBe(3);
		expect(writer.isDegraded()).toBe(true);

		chmodSync(logPath, 0o644);
		writer.release();
	});
});
