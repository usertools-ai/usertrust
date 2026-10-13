// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { deriveChainIntegrity, loadBudgetConfig, readLedgerEvents } from "../../src/audit/read.js";

describe("readLedgerEvents", () => {
	let tempDir: string;
	let vaultPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-read-"));
		vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns [] for a missing or empty vault", () => {
		expect(readLedgerEvents(join(tempDir, "nope"))).toEqual([]);
		expect(readLedgerEvents(vaultPath)).toEqual([]);
	});

	it("reads events in sequence order", async () => {
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { model: "claude-sonnet-4-6", cost: 5, settled: true, transferId: "tx_a" },
		});
		await writer.appendEvent({ kind: "tool_use", actor: "local", data: { cost: 1 } });
		writer.release();

		const events = readLedgerEvents(vaultPath);
		expect(events).toHaveLength(2);
		expect(events[0]?.sequence).toBe(1);
		expect(events[0]?.kind).toBe("llm_call");
		expect(events[1]?.sequence).toBe(2);
	});

	it("skips malformed lines but keeps intact events", async () => {
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost: 5 } });
		writer.release();
		appendFileSync(join(vaultPath, "audit", "events.jsonl"), "not-json\n");

		const events = readLedgerEvents(vaultPath);
		expect(events).toHaveLength(1);
	});

	it("skips a line that parses but is not an event (null, a number, an array), and never throws on one", async () => {
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost: 5 } });
		writer.release();
		appendFileSync(join(vaultPath, "audit", "events.jsonl"), "null\n7\n[1]\n");

		const read = () => readLedgerEvents(vaultPath);
		expect(read).not.toThrow();
		expect(read().map((e) => e.kind)).toEqual(["llm_call"]);
	});

	it("merges rotated segments ordered by global sequence", async () => {
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost: 1 } });
		await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost: 2 } });
		writer.release();
		// Simulate rotation: move first line into a rotated segment file.
		const logPath = join(vaultPath, "audit", "events.jsonl");
		const lines = (await import("node:fs")).readFileSync(logPath, "utf-8").trim().split("\n");
		writeFileSync(join(vaultPath, "audit", "events-2026-01-01.jsonl"), `${lines[0]}\n`);
		writeFileSync(logPath, `${lines[1]}\n`);

		const events = readLedgerEvents(vaultPath);
		expect(events.map((e) => e.sequence)).toEqual([1, 2]);
	});
});

describe("loadBudgetConfig", () => {
	it("a missing or malformed config, with no record, is source unpublished (UNKNOWN, 0 only as a placeholder); a valid one is source config", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "trust-cfg-"));
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(vaultPath, { recursive: true });
		const unpublished = { budget: 0, source: "unpublished", writtenAt: null, reason: null };
		expect(loadBudgetConfig(vaultPath)).toEqual(unpublished);
		writeFileSync(join(vaultPath, "usertrust.config.json"), "{broken");
		expect(loadBudgetConfig(vaultPath)).toEqual(unpublished);
		writeFileSync(join(vaultPath, "usertrust.config.json"), JSON.stringify({ budget: 50000 }));
		expect(loadBudgetConfig(vaultPath)).toEqual({
			budget: 50000,
			source: "config",
			writtenAt: null,
			reason: null,
		});
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("a planted non-file at the config's path is never opened", () => {
		const unpublished = { budget: 0, source: "unpublished", writtenAt: null, reason: null };
		let tempDir: string;
		let vaultPath: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "trust-cfg-"));
			vaultPath = join(tempDir, ".usertrust");
			mkdirSync(vaultPath, { recursive: true });
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it.skipIf(process.platform === "win32")(
			"red-first (hangs): a FIFO with no record gives no budget at once; no reader blocks on it",
			() => {
				const fifo = join(vaultPath, "usertrust.config.json");
				execFileSync("mkfifo", [fifo]);
				// The bound. A reader that OPENS the FIFO blocks this thread, where no timer can fire, so a separate
				// process releases it after 1.5 s by writing a config with a budget: that reader then returns late, with
				// the planted figure, and fails both assertions instead of hanging the run.
				const releaser = spawn(
					process.execPath,
					[
						"-e",
						'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], \'{"budget":5000}\'), 1500)',
						fifo,
					],
					{ stdio: "ignore" },
				);
				try {
					const t0 = Date.now();
					expect(loadBudgetConfig(vaultPath)).toEqual(unpublished);
					expect(Date.now() - t0).toBeLessThan(1_000);
				} finally {
					releaser.kill("SIGKILL");
				}
			},
		);

		it("a directory at the config's path gives no budget", () => {
			mkdirSync(join(vaultPath, "usertrust.config.json"));
			expect(loadBudgetConfig(vaultPath)).toEqual(unpublished);
		});
	});
});

describe("deriveChainIntegrity", () => {
	let tempDir: string;
	let vaultPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-integ-"));
		vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function writeThree(): Promise<void> {
		const writer = createAuditWriter(tempDir);
		for (const cost of [1, 2, 3]) {
			await writer.appendEvent({ kind: "llm_call", actor: "local", data: { cost } });
		}
		writer.release();
	}

	it("valid chain → valid, breakIndex null", async () => {
		await writeThree();
		const integ = deriveChainIntegrity(readLedgerEvents(vaultPath));
		expect(integ).toEqual({ valid: true, breakIndex: null });
	});

	it("tampered middle event → breakIndex at the tampered event", async () => {
		await writeThree();
		const events = readLedgerEvents(vaultPath);
		const tampered = events.map((e, i) => (i === 1 ? { ...e, data: { ...e.data, cost: 999 } } : e));
		const integ = deriveChainIntegrity(tampered);
		expect(integ.valid).toBe(false);
		expect(integ.breakIndex).toBe(1);
	});

	it("empty chain → valid", () => {
		expect(deriveChainIntegrity([])).toEqual({ valid: true, breakIndex: null });
	});
});
