import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical.js";
import { GENESIS_HASH } from "../src/constants.js";
import { verifyTransaction } from "../src/index.js";

// ── Helpers ──

function computeHash(event: Record<string, unknown>): string {
	const { hash: _stored, ...withoutHash } = event;
	const canonical = canonicalize(withoutHash);
	return createHash("sha256").update(canonical).digest("hex");
}

function buildChain(
	events: Array<{
		kind: string;
		data: Record<string, unknown>;
		sequence: number;
	}>,
): string[] {
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];

	for (const evt of events) {
		const event: Record<string, unknown> = {
			id: `test-${evt.sequence}`,
			timestamp: new Date(Date.now() + evt.sequence * 1000).toISOString(),
			previousHash,
			kind: evt.kind,
			actor: "local",
			data: evt.data,
			sequence: evt.sequence,
		};
		const hash = computeHash(event);
		const fullEvent = { ...event, hash };
		previousHash = hash;
		lines.push(JSON.stringify(fullEvent));
	}

	return lines;
}

function writeAuditLog(vaultPath: string, lines: string[]): void {
	const auditDir = join(vaultPath, "audit");
	mkdirSync(auditDir, { recursive: true });
	writeFileSync(join(auditDir, "events.jsonl"), lines.join("\n"), "utf-8");
}

// ── Tests ──

describe("verifyTransaction", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "verify-tx-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns verified receipt for a settled transaction", () => {
		const lines = buildChain([
			{
				kind: "llm_call",
				data: { transferId: "tx-aaa", model: "claude-3", cost: 5, settled: true },
				sequence: 1,
			},
			{
				kind: "llm_call",
				data: { transferId: "tx-bbb", model: "claude-3", cost: 3, settled: true },
				sequence: 2,
			},
			{
				kind: "llm_call",
				data: { transferId: "tx-ccc", model: "gpt-4o", cost: 2, settled: true },
				sequence: 3,
			},
		]);
		writeAuditLog(tempDir, lines);

		const result = verifyTransaction(tempDir, "tx-bbb");

		expect(result.found).toBe(true);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.receipt).toContain("VERIFIED");
		expect(result.receipt).toContain("SETTLED");
		expect(result.receipt).toContain("tx-bbb");
	});

	it("returns verified receipt for a failed transaction", () => {
		const lines = buildChain([
			{
				kind: "llm_call",
				data: { transferId: "tx-ok", model: "claude-3", cost: 5, settled: true },
				sequence: 1,
			},
			{
				kind: "llm_call_failed",
				data: { transferId: "tx-fail", model: "gpt-4o", error: "rate limit exceeded" },
				sequence: 2,
			},
			{
				kind: "llm_call",
				data: { transferId: "tx-ok2", model: "claude-3", cost: 2, settled: true },
				sequence: 3,
			},
		]);
		writeAuditLog(tempDir, lines);

		const result = verifyTransaction(tempDir, "tx-fail");

		expect(result.found).toBe(true);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.receipt).toContain("FAILED");
		expect(result.receipt).toContain("rate limit exceeded");
	});

	it("returns not found for a missing transaction ID", () => {
		const lines = buildChain([
			{
				kind: "llm_call",
				data: { transferId: "tx-exists", model: "claude-3", cost: 1, settled: true },
				sequence: 1,
			},
		]);
		writeAuditLog(tempDir, lines);

		const result = verifyTransaction(tempDir, "tx-nonexistent");

		expect(result.found).toBe(false);
		expect(result.receipt).toContain("not found");
		expect(result.receipt).toContain("tx-nonexistent");
	});

	it("returns error when audit log path does not exist", () => {
		const missingPath = join(tempDir, "nonexistent-vault");

		const result = verifyTransaction(missingPath, "tx-anything");

		expect(result.found).toBe(false);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain(join(missingPath, "audit", "events.jsonl"));
	});

	it("returns not found for an empty audit log", () => {
		const auditDir = join(tempDir, "audit");
		mkdirSync(auditDir, { recursive: true });
		writeFileSync(join(auditDir, "events.jsonl"), "", "utf-8");

		const result = verifyTransaction(tempDir, "tx-anything");

		expect(result.found).toBe(false);
	});

	it("reports invalid chain when a hash is corrupted", () => {
		const lines = buildChain([
			{
				kind: "llm_call",
				data: { transferId: "tx-1", model: "claude-3", cost: 5, settled: true },
				sequence: 1,
			},
			{
				kind: "llm_call",
				data: { transferId: "tx-2", model: "claude-3", cost: 3, settled: true },
				sequence: 2,
			},
			{
				kind: "llm_call",
				data: { transferId: "tx-3", model: "claude-3", cost: 2, settled: true },
				sequence: 3,
			},
		]);

		// Corrupt the hash of the second event
		const parsed = JSON.parse(lines[1] as string) as Record<string, unknown>;
		parsed.hash = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
		lines[1] = JSON.stringify(parsed);

		writeAuditLog(tempDir, lines);

		const result = verifyTransaction(tempDir, "tx-2");

		expect(result.found).toBe(true);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it("computes cumulative spend up to and including the target event", () => {
		const lines = buildChain([
			{
				kind: "llm_call",
				data: { transferId: "tx-a", model: "claude-3", cost: 5, settled: true },
				sequence: 1,
			},
			{
				kind: "llm_call",
				data: { transferId: "tx-b", model: "claude-3", cost: 3, settled: true },
				sequence: 2,
			},
			{
				kind: "llm_call",
				data: { transferId: "tx-c", model: "claude-3", cost: 2, settled: true },
				sequence: 3,
			},
		]);
		writeAuditLog(tempDir, lines);

		const result = verifyTransaction(tempDir, "tx-b");

		expect(result.found).toBe(true);
		expect(result.valid).toBe(true);
		// Cumulative spend at tx-b: 5 + 3 = 8
		expect(result.receipt).toContain("8 UT");
		expect(result.receipt).toContain("$0.0008");
	});

	it("handles llm_call event with no cost field", () => {
		const lines = buildChain([
			{
				kind: "llm_call",
				data: { transferId: "tx-nocost", model: "claude-3", settled: true },
				sequence: 1,
			},
			{
				kind: "llm_call",
				data: { transferId: "tx-withcost", model: "claude-3", cost: 5, settled: true },
				sequence: 2,
			},
		]);
		writeAuditLog(tempDir, lines);

		const result = verifyTransaction(tempDir, "tx-withcost");

		expect(result.found).toBe(true);
		expect(result.valid).toBe(true);
		// Only tx-withcost's cost (5) counted — tx-nocost has no cost
		expect(result.receipt).toContain("5 UT");
		expect(result.receipt).toContain("$0.0005");
	});
});
