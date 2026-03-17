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
		tempDir = mkdtempSync(join(tmpdir(), "govern-verify-"));
		writer = createAuditWriter(tempDir);
		logPath = join(tempDir, ".usertools", "audit", "events.jsonl");
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
		const event = JSON.parse(lines[0]!) as AuditEvent;
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
		const remaining = [lines[0]!, lines[2]!];
		writeFileSync(logPath, `${remaining.join("\n")}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("previousHash mismatch"))).toBe(true);
	});

	it("handles empty file (content is whitespace)", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tempDir, ".usertools", "audit"), { recursive: true });
		writeFileSync(logPath, "   \n  \n");

		const result = verifyChain(logPath);
		expect(result.valid).toBe(true);
		expect(result.eventsVerified).toBe(0);
	});

	it("detects malformed JSON", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tempDir, ".usertools", "audit"), { recursive: true });
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
});
