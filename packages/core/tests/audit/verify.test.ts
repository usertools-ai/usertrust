import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { verifyChain } from "../../src/audit/verify.js";
import { GENESIS_HASH } from "../../src/shared/constants.js";
import type { AuditEvent } from "../../src/shared/types.js";

describe("verifyChain", () => {
	let tempDir: string;
	let writer: ReturnType<typeof createAuditWriter>;
	let logPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-verify-"));
		writer = createAuditWriter(tempDir);
		logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
	});

	afterEach(() => {
		writer.release();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns valid for an empty/missing file", () => {
		const result = verifyChain("/nonexistent/path/events.jsonl");
		expect(result.valid).toBe(true);
		expect(result.eventsVerified).toBe(0);
		expect(result.latestHash).toBe(GENESIS_HASH);
	});

	it("returns valid for a correctly chained log", async () => {
		await writer.appendEvent({ kind: "test.a", actor: "sys", data: { n: 1 } });
		await writer.appendEvent({ kind: "test.b", actor: "sys", data: { n: 2 } });
		await writer.appendEvent({ kind: "test.c", actor: "sys", data: { n: 3 } });

		const result = verifyChain(logPath);
		expect(result.valid).toBe(true);
		expect(result.eventsVerified).toBe(3);
		expect(result.errors).toHaveLength(0);
	});

	it("detects tampered event data", async () => {
		await writer.appendEvent({ kind: "test.a", actor: "sys", data: { n: 1 } });
		await writer.appendEvent({ kind: "test.b", actor: "sys", data: { n: 2 } });

		// Tamper with first event
		const content = readFileSync(logPath, "utf-8").trim();
		const lines = content.split("\n");
		const event = JSON.parse(lines[0] as string) as AuditEvent;
		(event.data as Record<string, unknown>).n = 999;
		lines[0] = JSON.stringify(event);
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("hash mismatch");
	});

	it("detects deleted event (broken previousHash chain)", async () => {
		await writer.appendEvent({ kind: "test.a", actor: "sys", data: { n: 1 } });
		await writer.appendEvent({ kind: "test.b", actor: "sys", data: { n: 2 } });
		await writer.appendEvent({ kind: "test.c", actor: "sys", data: { n: 3 } });

		// Delete the second event
		const content = readFileSync(logPath, "utf-8").trim();
		const lines = content.split("\n");
		const remaining = [lines[0] as string, lines[2] as string];
		writeFileSync(logPath, `${remaining.join("\n")}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("previousHash mismatch"))).toBe(true);
	});

	it("handles empty file (content is whitespace)", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		writeFileSync(logPath, "   \n  \n");

		const result = verifyChain(logPath);
		expect(result.valid).toBe(true);
		expect(result.eventsVerified).toBe(0);
	});

	it("detects malformed JSON", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		writeFileSync(logPath, "not valid json\n");

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("malformed JSON");
	});

	it("latestHash matches the last event's hash", async () => {
		const e1 = await writer.appendEvent({
			kind: "test.a",
			actor: "sys",
			data: {},
		});
		const e2 = await writer.appendEvent({
			kind: "test.b",
			actor: "sys",
			data: {},
		});

		const result = verifyChain(logPath);
		expect(result.latestHash).toBe(e2.hash);
	});

	it("continues chain verification after a malformed JSON line", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });

		// First line: valid event but broken chain start
		const event1 = await writer.appendEvent({
			kind: "test.a",
			actor: "sys",
			data: {},
		});

		// Insert a malformed line between valid events
		const content = readFileSync(logPath, "utf-8");
		writeFileSync(logPath, `${content.trim()}\nNOT_VALID_JSON\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		expect(result.eventsVerified).toBe(2);
		expect(result.errors.some((e) => e.includes("malformed JSON"))).toBe(true);
	});

	it("detects multiple errors in a single chain", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });

		// Write a chain with hash and previousHash both wrong
		const badEvent1 = JSON.stringify({
			id: "bad-1",
			timestamp: new Date().toISOString(),
			previousHash: "wrong_prev",
			hash: "wrong_hash",
			kind: "test",
			actor: "sys",
			data: {},
		});
		const badEvent2 = JSON.stringify({
			id: "bad-2",
			timestamp: new Date().toISOString(),
			previousHash: "also_wrong",
			hash: "also_wrong_hash",
			kind: "test",
			actor: "sys",
			data: {},
		});
		writeFileSync(logPath, `${badEvent1}\n${badEvent2}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		// Should detect at least previousHash mismatch and hash mismatch errors
		expect(result.errors.length).toBeGreaterThanOrEqual(2);
	});
});
