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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listReceipts, loadIndex, writeReceipt } from "../../src/audit/rotation.js";
import { AUDIT_DIR, RECEIPT_VERSION, VAULT_DIR } from "../../src/shared/constants.js";

describe("Audit Rotation — writeReceipt", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-rotation-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes a receipt to a date-organized directory", () => {
		const receipt = writeReceipt(tempDir, {
			kind: "policy",
			subsystem: "policy-gate",
			actor: "agent-1",
			data: { decision: "allow" },
		});

		expect(receipt).toBeDefined();
		expect(receipt?.v).toBe(RECEIPT_VERSION);
		expect(receipt?.kind).toBe("policy");
		expect(receipt?.actor).toBe("agent-1");
		expect(receipt?.ts).toBeDefined();
	});

	it("receipt file exists on disk", () => {
		const receipt = writeReceipt(tempDir, {
			kind: "system",
			subsystem: "audit",
			actor: "sys",
			data: { event: "test" },
		});

		expect(receipt).toBeDefined();
		const receiptId = receipt?.data.receiptId as string;
		const today = new Date().toISOString().split("T")[0] as string;
		const receiptPath = join(tempDir, ".usertrust", "audit", "system", today, `${receiptId}.json`);
		expect(existsSync(receiptPath)).toBe(true);

		const parsed = JSON.parse(readFileSync(receiptPath, "utf-8"));
		expect(parsed.kind).toBe("system");
	});

	it("includes correlationId when provided", () => {
		const receipt = writeReceipt(tempDir, {
			kind: "task",
			subsystem: "write-guard",
			actor: "worker-1",
			correlationId: "corr_test_123",
			data: { taskId: "T-001" },
		});

		expect(receipt).toBeDefined();
		expect(receipt?.correlationId).toBe("corr_test_123");
	});

	it("generates unique receipt IDs", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 10; i++) {
			const receipt = writeReceipt(tempDir, {
				kind: "system",
				subsystem: "test",
				actor: "sys",
				data: { n: i },
			});
			if (receipt) {
				ids.add(receipt.data.receiptId as string);
			}
		}
		expect(ids.size).toBe(10);
	});
});

describe("Audit Rotation — listReceipts", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-rotation-list-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for nonexistent kind", () => {
		const results = listReceipts(tempDir, "nonexistent");
		expect(results).toEqual([]);
	});

	it("lists all receipts of a kind", () => {
		writeReceipt(tempDir, {
			kind: "policy",
			subsystem: "gate",
			actor: "a1",
			data: { n: 1 },
		});
		writeReceipt(tempDir, {
			kind: "policy",
			subsystem: "gate",
			actor: "a2",
			data: { n: 2 },
		});
		writeReceipt(tempDir, {
			kind: "system",
			subsystem: "other",
			actor: "a3",
			data: { n: 3 },
		});

		const policyReceipts = listReceipts(tempDir, "policy");
		expect(policyReceipts).toHaveLength(2);

		const systemReceipts = listReceipts(tempDir, "system");
		expect(systemReceipts).toHaveLength(1);
	});

	it("returns receipts sorted newest-first", () => {
		writeReceipt(tempDir, {
			kind: "task",
			subsystem: "wg",
			actor: "w1",
			data: { order: 1 },
		});
		writeReceipt(tempDir, {
			kind: "task",
			subsystem: "wg",
			actor: "w2",
			data: { order: 2 },
		});

		const results = listReceipts(tempDir, "task");
		expect(results).toHaveLength(2);
		// Newest first
		const ts0 = new Date(results[0]?.ts).getTime();
		const ts1 = new Date(results[1]?.ts).getTime();
		expect(ts0).toBeGreaterThanOrEqual(ts1);
	});
});

describe("Audit Rotation — loadIndex", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-rotation-index-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array when no index exists", () => {
		const index = loadIndex(tempDir);
		expect(index).toEqual([]);
	});

	it("index grows with each receipt", () => {
		writeReceipt(tempDir, {
			kind: "policy",
			subsystem: "gate",
			actor: "a1",
			data: {},
		});
		writeReceipt(tempDir, {
			kind: "system",
			subsystem: "audit",
			actor: "a2",
			data: {},
		});

		const index = loadIndex(tempDir);
		expect(index).toHaveLength(2);
		expect(index[0]?.kind).toBe("policy");
		expect(index[1]?.kind).toBe("system");
	});

	it("index is bounded at the configured limit", () => {
		// Write 15 receipts with limit of 10
		for (let i = 0; i < 15; i++) {
			writeReceipt(
				tempDir,
				{
					kind: "system",
					subsystem: "test",
					actor: "sys",
					data: { n: i },
				},
				10,
			);
		}

		const index = loadIndex(tempDir);
		expect(index.length).toBeLessThanOrEqual(10);
	});

	it("index entries have correct path format", () => {
		writeReceipt(tempDir, {
			kind: "policy",
			subsystem: "gate",
			actor: "a1",
			data: {},
		});

		const index = loadIndex(tempDir);
		expect(index).toHaveLength(1);
		const entry = index[0] as (typeof index)[number];
		expect(entry.path).toMatch(/^policy\/\d{4}-\d{2}-\d{2}\/rcpt_/);
		expect(entry.kind).toBe("policy");
		expect(entry.actor).toBe("a1");
	});
});

describe("Audit Rotation — writeReceipt error paths", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-rotation-err-"));
	});

	afterEach(() => {
		// Restore permissions if needed before rmSync
		try {
			chmodSync(tempDir, 0o755);
		} catch {
			/* ignore */
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns undefined when write fails (outer catch)", () => {
		// Make the temp dir read-only so mkdir for audit dir fails
		chmodSync(tempDir, 0o555);

		const result = writeReceipt(tempDir, {
			kind: "policy",
			subsystem: "gate",
			actor: "a1",
			data: {},
		});

		expect(result).toBeUndefined();
	});

	it("omits correlationId when not provided", () => {
		const receipt = writeReceipt(tempDir, {
			kind: "policy",
			subsystem: "gate",
			actor: "a1",
			data: {},
		});

		expect(receipt).toBeDefined();
		expect("correlationId" in (receipt as NonNullable<typeof receipt>)).toBe(false);
	});
});

describe("Audit Rotation — listReceipts edge cases", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-rotation-list-edge-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads legacy flat files (not in date directories)", () => {
		// Create a receipt file directly in the kind dir (legacy format)
		const kindDir = join(tempDir, VAULT_DIR, AUDIT_DIR, "policy");
		mkdirSync(kindDir, { recursive: true });

		const receipt = {
			v: RECEIPT_VERSION,
			ts: new Date().toISOString(),
			kind: "policy",
			subsystem: "gate",
			actor: "legacy-actor",
			data: { receiptId: "rcpt_legacy_001" },
		};
		writeFileSync(join(kindDir, "rcpt_legacy_001.json"), JSON.stringify(receipt));

		const results = listReceipts(tempDir, "policy");
		expect(results).toHaveLength(1);
		expect(results[0]?.actor).toBe("legacy-actor");
	});

	it("skips invalid JSON files in date directories", () => {
		const today = new Date().toISOString().split("T")[0] as string;
		const dateDir = join(tempDir, VAULT_DIR, AUDIT_DIR, "policy", today);
		mkdirSync(dateDir, { recursive: true });

		writeFileSync(join(dateDir, "bad.json"), "NOT VALID JSON");
		writeFileSync(
			join(dateDir, "good.json"),
			JSON.stringify({
				v: RECEIPT_VERSION,
				ts: new Date().toISOString(),
				kind: "policy",
				subsystem: "gate",
				actor: "a1",
				data: {},
			}),
		);

		const results = listReceipts(tempDir, "policy");
		expect(results).toHaveLength(1);
		expect(results[0]?.actor).toBe("a1");
	});

	it("skips invalid JSON files in legacy flat dir", () => {
		const kindDir = join(tempDir, VAULT_DIR, AUDIT_DIR, "policy");
		mkdirSync(kindDir, { recursive: true });

		writeFileSync(join(kindDir, "corrupt.json"), "CORRUPT");

		const results = listReceipts(tempDir, "policy");
		expect(results).toHaveLength(0);
	});

	it("filters by date when provided", () => {
		// Write receipts for today
		writeReceipt(tempDir, {
			kind: "policy",
			subsystem: "gate",
			actor: "a1",
			data: { n: 1 },
		});

		const today = new Date().toISOString().split("T")[0] as string;
		const results = listReceipts(tempDir, "policy", today);
		expect(results).toHaveLength(1);

		// Non-matching date returns empty
		const noResults = listReceipts(tempDir, "policy", "1999-01-01");
		expect(noResults).toHaveLength(0);
	});

	it("returns empty array when readdirSync throws (outer catch)", () => {
		// Create the kind dir, then make it unreadable
		const kindDir = join(tempDir, VAULT_DIR, AUDIT_DIR, "unreadable");
		mkdirSync(kindDir, { recursive: true });
		chmodSync(kindDir, 0o000);

		const results = listReceipts(tempDir, "unreadable");
		expect(results).toEqual([]);

		// Restore for cleanup
		chmodSync(kindDir, 0o755);
	});
});

describe("Audit Rotation — loadIndex edge cases", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-rotation-index-edge-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for corrupt index.json", () => {
		const indexPath = join(tempDir, VAULT_DIR, AUDIT_DIR, "index.json");
		mkdirSync(join(tempDir, VAULT_DIR, AUDIT_DIR), { recursive: true });
		writeFileSync(indexPath, "NOT VALID JSON");

		const index = loadIndex(tempDir);
		expect(index).toEqual([]);
	});
});
