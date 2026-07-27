// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { exportMarkdown } from "../../src/export/markdown.js";

describe("exportMarkdown", () => {
	let tempDir: string;
	let vaultPath: string;
	let outDir: string;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-md-"));
		vaultPath = join(tempDir, ".usertrust");
		outDir = join(tempDir, "obsidian");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { model: "claude-sonnet-4-6", cost: 5, settled: true, transferId: "tx_test_1" },
		});
		await writer.appendEvent({ kind: "tool_use", actor: "local", data: { cost: 1 } });
		writer.release();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes one note per event plus Receipts.base and Ledger Index.md", () => {
		const result = exportMarkdown(vaultPath, outDir);
		expect(result.written).toBe(2);
		expect(result.chainValid).toBe(true);
		expect(existsSync(join(outDir, "Receipts.base"))).toBe(true);
		expect(existsSync(join(outDir, "Ledger Index.md"))).toBe(true);
		const dates = readdirSync(join(outDir, "receipts"));
		expect(dates).toHaveLength(1);
		expect(readdirSync(join(outDir, "receipts", dates[0] as string))).toHaveLength(2);
	});

	it("frontmatter carries the Bases-driving properties", () => {
		exportMarkdown(vaultPath, outDir);
		const dates = readdirSync(join(outDir, "receipts"));
		const dir = join(outDir, "receipts", dates[0] as string);
		const files = readdirSync(dir).sort();
		const notes = files.map((f) => readFileSync(join(dir, f), "utf-8"));
		const llmNote = notes.find((n) => n.includes("transfer_id: tx_test_1")) as string;
		expect(llmNote).toContain("kind: llm_call");
		expect(llmNote).toContain("model: claude-sonnet-4-6");
		expect(llmNote).toContain("provider: anthropic");
		expect(llmNote).toContain("cost_ut: 5");
		expect(llmNote).toContain("cost_usd: 0.0005");
		expect(llmNote).toContain("settled: true");
		expect(llmNote).toContain("seq: 1");
		expect(llmNote).toContain("integrity: verified");
		expect(llmNote).toContain("anchor_state: unanchored");
	});

	it("second event wikilinks the first (chain in graph view)", () => {
		exportMarkdown(vaultPath, outDir);
		const dates = readdirSync(join(outDir, "receipts"));
		const dir = join(outDir, "receipts", dates[0] as string);
		const notes = readdirSync(dir).map((f) => ({ f, body: readFileSync(join(dir, f), "utf-8") }));
		const second = notes.find((n) => n.body.includes("seq: 2")) as { f: string; body: string };
		const firstId = (notes.find((n) => n.body.includes("seq: 1")) as { f: string }).f.replace(
			/\.md$/,
			"",
		);
		expect(second.body).toContain(`[[${firstId}]]`);
	});

	it("is idempotent — re-export rewrites the same files", () => {
		exportMarkdown(vaultPath, outDir);
		const again = exportMarkdown(vaultPath, outDir);
		expect(again.written).toBe(2);
		const dates = readdirSync(join(outDir, "receipts"));
		expect(readdirSync(join(outDir, "receipts", dates[0] as string))).toHaveLength(2);
	});

	it("sanitizes hostile event ids so notes stay inside receipts/<date>/", () => {
		const crafted = {
			id: "../evil",
			timestamp: "2026-01-02T00:00:00.000Z",
			previousHash: "0".repeat(64),
			hash: "b".repeat(64),
			kind: "llm_call",
			actor: "local",
			data: { cost: 1 },
			sequence: 3,
		};
		appendFileSync(join(vaultPath, "audit", "events.jsonl"), `${JSON.stringify(crafted)}\n`);

		const result = exportMarkdown(vaultPath, outDir);
		expect(result.written).toBe(3);
		expect(existsSync(join(outDir, "receipts", "2026-01-02", ".._evil.md"))).toBe(true);
		expect(existsSync(join(outDir, "receipts", "evil.md"))).toBe(false);
	});

	it("reports vault-level failures the parsed-chain walk cannot see (tail truncation)", async () => {
		const logPath = join(vaultPath, "audit", "events.jsonl");
		const content = readFileSync(logPath, "utf-8");
		// Tear the last event mid-line: the parsed chain stays valid, but the
		// .meta anchor records 2 events and flags the truncation.
		(await import("node:fs")).writeFileSync(logPath, content.slice(0, content.length - 60));

		const result = exportMarkdown(vaultPath, outDir);
		expect(result.chainValid).toBe(true);
		expect(result.vaultValid).toBe(false);
		expect(result.vaultErrors.length).toBeGreaterThan(0);
		const indexNote = readFileSync(join(outDir, "Ledger Index.md"), "utf-8");
		expect(indexNote).toContain("Vault verification: FAILED");
	});

	it("stamps after-break integrity past a tamper point", async () => {
		const logPath = join(vaultPath, "audit", "events.jsonl");
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		const tampered = JSON.parse(lines[1] as string) as { data: { cost: number } };
		tampered.data.cost = 9999;
		const rewritten = [lines[0], JSON.stringify(tampered)].join("\n");
		rmSync(`${logPath}.meta`, { force: true });
		(await import("node:fs")).writeFileSync(logPath, `${rewritten}\n`);

		const result = exportMarkdown(vaultPath, outDir);
		expect(result.chainValid).toBe(false);
		expect(result.breakIndex).toBe(1);
		const dates = readdirSync(join(outDir, "receipts"));
		const dir = join(outDir, "receipts", dates[0] as string);
		const bodies = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf-8"));
		expect(bodies.some((b) => b.includes("integrity: verified"))).toBe(true);
		expect(bodies.some((b) => b.includes("integrity: after-break"))).toBe(true);
	});
});
