// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { recordEffectiveBudget } from "../../core/src/budget/effective-record.js";
import { loadState } from "../src/server/state.js";

describe("loadState", () => {
	let tempDir: string;
	let vaultPath: string;
	let logPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-state-"));
		vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		logPath = join(vaultPath, "audit", "events.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function seed(count: number): Promise<void> {
		const writer = createAuditWriter(tempDir);
		for (let i = 0; i < count; i++) {
			await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost: 1 } });
		}
		writer.release();
	}

	function tamperLine(index: number): void {
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		const parsed = JSON.parse(lines[index] as string) as { data: { cost: number } };
		parsed.data.cost = 9999;
		lines[index] = JSON.stringify(parsed);
		writeFileSync(logPath, `${lines.join("\n")}\n`);
	}

	it("torn append: vault invalid with errors surfaced, no local break, rows stay verified", async () => {
		await seed(1);
		appendFileSync(logPath, "{ not json\n");

		const state = loadState(vaultPath);
		expect(state.summary.chain.valid).toBe(false);
		expect(state.summary.chain.breakIndex).toBeNull();
		expect(state.summary.chain.errors.length).toBeGreaterThan(0);
		expect(state.summary.chain.errors.join(" ")).toContain("malformed JSON");
		expect(state.rows).toHaveLength(1);
		expect(state.rows[0]?.integrity).toBe("verified");
	});

	it("truncation: break before the visible slice marks every visible row after-break", async () => {
		await seed(4);
		tamperLine(1);

		const state = loadState(vaultPath, 2);
		expect(state.summary.truncated).toBe(true);
		expect(state.summary.rowCount).toBe(2);
		expect(state.summary.chain.events).toBe(4);
		expect(state.rows.map((r) => r.integrity)).toEqual(["after-break", "after-break"]);
	});

	it("truncation: break inside the visible slice lands on the right row", async () => {
		await seed(4);
		tamperLine(3);

		const state = loadState(vaultPath, 2);
		expect(state.rows.map((r) => r.integrity)).toEqual(["verified", "after-break"]);
	});

	it("reports an absent anchors.jsonl as file-absent, not as a verdict", async () => {
		await seed(1);
		const state = loadState(vaultPath);
		expect(state.summary.anchorFile).toBe("absent");
		expect(state.summary).not.toHaveProperty("anchorState");
	});

	it("reports a planted empty anchors.jsonl as file-present, not as anchored", async () => {
		await seed(1);
		mkdirSync(join(vaultPath, "audit", "anchors"), { recursive: true });
		writeFileSync(join(vaultPath, "audit", "anchors", "anchors.jsonl"), "");
		const state = loadState(vaultPath);
		expect(state.summary.anchorFile).toBe("present");
		expect(state.summary).not.toHaveProperty("anchorState");
	});

	// The pilot dashboard: a server tenant's budget is passed to its governor in memory, so the vault's config file
	// never held it; the summary read 0 ("no budget set") and a NEGATIVE remaining. The governor's record carries it.
	async function spend(costs: number[]): Promise<void> {
		const writer = createAuditWriter(tempDir);
		for (const cost of costs) {
			await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost } });
		}
		writer.release();
	}

	it("red-first (budget 0, remaining -300): a tenant vault shows its enforced budget and the correct remaining", async () => {
		await spend([100, 200]);
		recordEffectiveBudget(vaultPath, 2_000);
		const { summary } = loadState(vaultPath);
		expect(summary).toMatchObject({
			budget: 2_000,
			budgetSource: "governor",
			budgetWrittenAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
			budgetProvenance: expect.stringMatching(/^the enforced budget, as of \d{4}-/),
			spentUt: 300,
			remainingUt: 1_700,
		});
	});

	it("no record and no configured budget: UNKNOWN — budget and remaining are null, never 0 and a negative", async () => {
		await spend([300]);
		const { summary } = loadState(vaultPath);
		expect(summary).toMatchObject({
			budget: null,
			budgetSource: "none",
			spentUt: 300,
			remainingUt: null,
		});
	});

	it("no record: the vault config's budget, labelled as such", async () => {
		await spend([300]);
		writeFileSync(join(vaultPath, "usertrust.config.json"), JSON.stringify({ budget: 1_000 }));
		const { summary } = loadState(vaultPath);
		expect(summary).toMatchObject({
			budget: 1_000,
			budgetSource: "config",
			budgetWrittenAt: null,
			budgetProvenance: "from usertrust.config.json; not confirmed as enforced",
			remainingUt: 700,
		});
	});

	it("several live governors with different budgets: budget and remaining are null, the source says several", async () => {
		await spend([300]);
		writeFileSync(
			join(vaultPath, "effective-budget.json"),
			JSON.stringify({
				budget: null,
				governors: 2,
				writtenAt: "2026-10-12T00:00:00.000Z",
				pid: 1,
				processStartedAt: "2026-10-12T00:00:00.000Z",
			}),
		);
		const { summary } = loadState(vaultPath);
		expect(summary).toMatchObject({ budget: null, budgetSource: "several", remainingUt: null });
		expect(summary.budgetProvenance).toMatch(/^unknown: several governors with different budgets/);
	});
});
