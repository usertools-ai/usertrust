// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { recordEffectiveBudget } from "../../core/src/budget/effective-record.js";
import { loadState, readRemoteSettings } from "../src/server/state.js";

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

	// A project before its first governed call has no vault, or an audit directory with no log yet. Neither is
	// tampering, and the dashboard showed both as a red CHAIN INTEGRITY FAILURE (or the second as "verified").
	it("red-first (red 'Audit directory not found'): a project with no vault yet is EMPTY, valid, with no errors", () => {
		const fresh = join(tempDir, "fresh-project", ".usertrust");
		const { summary } = loadState(fresh);
		expect(summary.chain).toEqual({
			events: 0,
			valid: true,
			empty: true,
			breakIndex: null,
			errors: [],
		});
	});

	it("red-first (an empty log read as 'verified'): an audit directory with no events is EMPTY", () => {
		const { summary } = loadState(vaultPath);
		expect(summary.chain).toMatchObject({ events: 0, valid: true, empty: true, errors: [] });
	});

	// The over-correction guard: zero events is NOT enough to be empty. A log deleted while its anchor still records
	// events is the deletion the anchor exists to catch, and it stays a failure.
	it("a deleted log whose anchor records events stays a FAILURE, never empty", async () => {
		await seed(3);
		rmSync(logPath);
		const { summary } = loadState(vaultPath);
		expect(summary.chain.events).toBe(0);
		expect(summary.chain.valid).toBe(false);
		expect(summary.chain.empty).toBe(false);
		expect(summary.chain.errors.join(" ")).toContain("deletion detected");
	});

	it("an emptied log whose anchor records events stays a FAILURE, never empty", async () => {
		await seed(2);
		writeFileSync(logPath, "");
		const { summary } = loadState(vaultPath);
		expect(summary.chain).toMatchObject({ events: 0, valid: false, empty: false });
		expect(summary.chain.errors.length).toBeGreaterThan(0);
	});

	// existsSync is false for a directory this process cannot reach, not only for an absent one, and both readers
	// then see no events: the empty-vault exception made such a vault read as clean.
	it("red-first (an unreadable vault read as clean): a vault path that is not a directory is a FAILURE, never empty", () => {
		const blocked = join(tempDir, "blocked");
		mkdirSync(blocked);
		const notADir = join(blocked, ".usertrust");
		writeFileSync(notADir, "not a directory");
		const { summary } = loadState(notADir);
		expect(summary.chain).toMatchObject({ events: 0, valid: false, empty: false });
		expect(summary.chain.errors.join(" ")).toContain("could not be read (ENOTDIR)");
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"red-first (an unreadable vault read as clean): a vault this process may not search is a FAILURE, never empty",
		async () => {
			await seed(2);
			chmodSync(vaultPath, 0o000);
			try {
				const { summary } = loadState(vaultPath);
				expect(summary.chain).toMatchObject({ valid: false, empty: false });
				expect(summary.chain.errors.join(" ")).toContain("could not be read (EACCES)");
			} finally {
				chmodSync(vaultPath, 0o700);
			}
		},
	);

	// Opening a FIFO blocks until a writer appears: a FIFO planted at the config path froze the server at startup and
	// on every config poll. A helper thread opens the FIFO's write end after 1.5 s (non-blocking, so it never waits
	// itself): it unblocks a reader that wrongly opened it, so a regression FAILS on the time bound instead of hanging.
	it.skipIf(process.platform === "win32")(
		"red-first (blocked on open): a FIFO at the config path is refused without being opened",
		async () => {
			const fifo = join(vaultPath, "usertrust.config.json");
			execFileSync("mkfifo", [fifo]);
			const helper = new Worker(
				`const { openSync, writeSync, closeSync, constants } = require("node:fs");
				const { workerData } = require("node:worker_threads");
				const pause = new Int32Array(new SharedArrayBuffer(4));
				Atomics.wait(pause, 0, 0, 1500);
				const until = Date.now() + 5000;
				while (Date.now() < until) {
					try {
						const fd = openSync(workerData, constants.O_WRONLY | constants.O_NONBLOCK);
						writeSync(fd, '{"remote":{"kit":true}}');
						closeSync(fd);
						break;
					} catch {
						Atomics.wait(pause, 0, 0, 50);
					}
				}`,
				{ eval: true, workerData: fifo },
			);
			const started = Date.now();
			const remote = readRemoteSettings(vaultPath);
			const elapsed = Date.now() - started;
			await helper.terminate();
			expect(elapsed).toBeLessThan(1000);
			expect(remote).toEqual({ kit: false });
		},
	);

	it("a vault with events is not empty", async () => {
		await seed(1);
		expect(loadState(vaultPath).summary.chain).toMatchObject({
			events: 1,
			valid: true,
			empty: false,
		});
	});

	it("the kit mark is off by default, and when the config is unreadable", async () => {
		await seed(1);
		expect(loadState(vaultPath).summary.remote).toEqual({ kit: false });
		writeFileSync(join(vaultPath, "usertrust.config.json"), "{ not json");
		expect(loadState(vaultPath).summary.remote).toEqual({ kit: false });
	});

	it("red-first (no setting existed): remote.kit true in the vault config turns the kit mark on, beside the budget", async () => {
		await seed(1);
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 1_000, remote: { kit: true } }),
		);
		const { summary } = loadState(vaultPath);
		expect(summary.remote).toEqual({ kit: true });
		expect(summary).toMatchObject({ budget: 1_000, budgetSource: "config" });
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
			budgetSource: "unpublished",
			budgetProvenance:
				"unknown: not yet published; no governor has recorded the budget it enforces",
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
