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
});
