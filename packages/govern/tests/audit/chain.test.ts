import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { GENESIS_HASH } from "../../src/shared/constants.js";
import type { AuditEvent } from "../../src/shared/types.js";

describe("Audit Chain Writer", () => {
	let tempDir: string;
	let writer: ReturnType<typeof createAuditWriter>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "govern-audit-chain-"));
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

		const logPath = join(tempDir, ".usertools", "audit", "events.jsonl");
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

		const logPath = join(tempDir, ".usertools", "audit", "events.jsonl");
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

		const logPath = join(tempDir, ".usertools", "audit", "events.jsonl");
		const content = readFileSync(logPath, "utf-8").trim();
		const lines = content.split("\n");

		// Tamper with first event's data
		const event = JSON.parse(lines[0]!) as AuditEvent;
		event.data = { n: 999 };
		lines[0] = JSON.stringify(event);
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		// Verify — recompute hash of first event and check mismatch
		const tampered = JSON.parse(lines[0]!) as AuditEvent;
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

		const logPath = join(tempDir, ".usertools", "audit", "events.jsonl");
		const content = readFileSync(logPath, "utf-8").trim();
		const lines = content.split("\n");

		// Remove the second event — breaks the chain
		const remaining = [lines[0]!, lines[2]!];
		writeFileSync(logPath, `${remaining.join("\n")}\n`);

		// The third event's previousHash should point to second event's hash
		const third = JSON.parse(remaining[1]!) as AuditEvent;
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

		const metaPath = join(tempDir, ".usertools", "audit", "events.jsonl.meta");
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
		const logPath = join(tempDir, ".usertools", "audit", "events.jsonl");
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
		tempDir = mkdtempSync(join(tmpdir(), "govern-audit-mutex-"));
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

		const logPath = join(tempDir, ".usertools", "audit", "events.jsonl");
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
		tempDir = mkdtempSync(join(tmpdir(), "govern-audit-flush-"));
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

		const logPath = join(tempDir, ".usertools", "audit", "events.jsonl");
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
		tempDir = mkdtempSync(join(tmpdir(), "govern-audit-lock-"));
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

		const lockPath = join(tempDir, ".usertools", "audit", ".audit-writer.lock");
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

		const lockPath = join(tempDir, ".usertools", "audit", ".audit-writer.lock");
		expect(existsSync(lockPath)).toBe(true);

		writer.release();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("detects stale lock from dead process and recovers", async () => {
		const lockPath = join(tempDir, ".usertools", "audit", ".audit-writer.lock");
		// Ensure audit dir exists for the lock file
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tempDir, ".usertools", "audit"), { recursive: true });
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 999999999, startedAt: "2020-01-01T00:00:00Z" }),
		);

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
});
