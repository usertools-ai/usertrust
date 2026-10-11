// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { parseEnd, parseReportArgs, run } from "../../src/cli/report.js";

const RATES = { inputPer1k: 100, outputPer1k: 500, cacheReadPer1k: 10, cacheWritePer1k: 125 };

describe("usertrust report --week", () => {
	let dir: string;
	let out: string[];
	let write: ReturnType<typeof vi.spyOn>;
	let stdout: string;
	// the writer stamps events with the real clock, so the window ends an hour from now
	const endIso = () => new Date(Date.now() + 3_600_000).toISOString();

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trust-report-"));
		out = [];
		stdout = "";
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			out.push(a.map(String).join(" "));
		});
		write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
		process.exitCode = undefined;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	async function vault(
		calls: Array<{ cost: number; data?: Record<string, unknown> }>,
		extra: Array<{ kind: string; data: Record<string, unknown> }> = [],
	) {
		mkdirSync(join(dir, ".usertrust", "audit"), { recursive: true });
		const w = createAuditWriter(dir);
		for (const c of calls) {
			await w.appendEvent({
				kind: "llm_call",
				actor: "local",
				data: {
					model: "claude-sonnet-5-5",
					cost: c.cost,
					settled: true,
					transferId: `t-${Math.random().toString(36).slice(2)}`,
					usageSource: "provider",
					usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
					appliedRates: RATES,
					...c.data,
				},
			});
		}
		for (const e of extra) await w.appendEvent({ kind: e.kind, actor: "local", data: e.data });
		w.release();
	}

	it("refuses without --week, without --end, and on every malformed flag (nothing scopes a report silently)", async () => {
		await vault([{ cost: 1 }]);
		for (const argv of [
			[],
			["--week"],
			["--week", "--end", "2026-10-12"],
			["--week", "--end", "2026-02-30T00:00:00Z"],
			["--week", "--end", "0"],
			["--week", "--end", endIso(), "--format", "pdf"],
			["--week", "--end", endIso(), "--agent-key", "nope"],
			["--week", "--end", endIso(), "--segment", "x"],
			["--week", "--end", endIso(), "--bogus"],
			["--week", "--end", "--format", "md"],
			["--week", "--end", endIso(), "--out"],
		]) {
			out = [];
			process.exitCode = undefined;
			await run(dir, {}, argv);
			expect(process.exitCode, JSON.stringify(argv)).toBe(1);
			expect(out.join("\n")).toContain("report failed");
		}
	});

	it("--flag=value is the only way to pass a value that begins with a dash", () => {
		expect(parseReportArgs(["--week", `--end=${endIso()}`, "--out=-x.md"], false).out).toBe(
			"-x.md",
		);
		expect(() => parseReportArgs(["--week", `--end=${endIso()}`, "--out", "-x.md"], false)).toThrow(
			/requires a value/,
		);
	});

	it("parseEnd needs a full instant with a zone and a real date", () => {
		expect(parseEnd("2026-10-12T00:00:00Z")).toBe(Date.parse("2026-10-12T00:00:00Z"));
		expect(parseEnd("2026-10-12T00:00:00+02:00")).toBe(Date.parse("2026-10-11T22:00:00Z"));
		for (const bad of [
			"2026-10-12",
			"2026-10-12T00:00:00",
			"2026-13-01T00:00:00Z",
			"2026-02-30T00:00:00Z",
			"",
		]) {
			expect(() => parseEnd(bad), bad).toThrow(/Invalid --end/);
		}
	});

	it("errors when there is no vault", async () => {
		await run(dir, {}, ["--week", "--end", endIso()]);
		expect(process.exitCode).toBe(1);
		expect(out.join("\n")).toContain("usertrust init");
	});

	it("a verified chain: figures reconcile to the events, the verdict is first, and the exit code is 0", async () => {
		await vault(
			[
				{ cost: 100, data: { costCenter: "agent-a" } },
				{ cost: 50, data: { costCenter: "agent-b", model: "gpt-5" } },
			],
			[{ kind: "policy_denied", data: { rule: "r" } }],
		);
		writeFileSync(
			join(dir, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 1000 }),
		);
		await run(dir, {}, ["--week", "--end", endIso()]);
		expect(process.exitCode).toBeUndefined();
		expect(stdout).toContain("Audit chain VERIFIED");
		expect(stdout.indexOf("VERIFIED")).toBeLessThan(stdout.indexOf("Confirmed spend"));
		expect(stdout).toContain("**Confirmed spend:** $0.02"); // 150 UT = $0.015
		expect(stdout).toContain("| agent-a | 1 | $0.01 | 66.7% |");
		expect(stdout).toContain("15.0% used");
		expect(stdout).not.toContain("UNVERIFIED");
		write.mockRestore();
	});

	it("a BROKEN chain still reports, stamps UNVERIFIED in every format, and exits 2", async () => {
		await vault([{ cost: 100 }, { cost: 200 }]);
		const log = join(dir, ".usertrust", "audit", "events.jsonl");
		const lines = readFileSync(log, "utf-8").trim().split("\n");
		const first = JSON.parse(lines[0] as string) as { data: { cost: number } };
		first.data.cost = 1; // tamper: the hash no longer matches
		writeFileSync(log, `${[JSON.stringify(first), ...lines.slice(1)].join("\n")}\n`);

		for (const format of ["md", "html", "json"] as const) {
			stdout = "";
			process.exitCode = undefined;
			await run(dir, {}, ["--week", "--end", endIso(), "--format", format]);
			expect(process.exitCode, format).toBe(2);
			expect(stdout, format).toMatch(/UNVERIFIED|"verified":false/);
		}
		stdout = "";
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "html"]);
		expect(stdout).toContain('role="alert"');
		expect(stdout.indexOf("UNVERIFIED")).toBeLessThan(stdout.indexOf("Weekly spend report"));
		write.mockRestore();
	});

	it("cache-write cost is labelled a cost DRIVER in every format, and 'avoidable' is never claimed", async () => {
		await vault([
			{
				cost: 900,
				data: {
					usage: {
						inputTokens: 1000,
						outputTokens: 200,
						cacheReadTokens: 10_000,
						cacheWriteTokens: 4000,
					},
				},
			},
		]);
		for (const format of ["md", "html"] as const) {
			stdout = "";
			await run(dir, {}, ["--week", "--end", endIso(), "--format", format]);
			expect(stdout, format).toMatch(/cost driver, not avoidable spend/);
			expect(stdout, format).not.toMatch(/avoidable spend (found|of|is|was|:)/i);
			expect(stdout, format).toMatch(/Cache write/);
		}
		write.mockRestore();
	});

	it("writes --out with mode 0600, never touching the vault", async () => {
		await vault([{ cost: 7 }]);
		const before = readFileSync(join(dir, ".usertrust", "audit", "events.jsonl"), "utf-8");
		const target = join(dir, "report.html");
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "html", "--out", target]);
		expect(readFileSync(target, "utf-8")).toContain("<!doctype html>");
		expect(readFileSync(join(dir, ".usertrust", "audit", "events.jsonl"), "utf-8")).toBe(before);
		write.mockRestore();
	});

	it("untrusted chain text (a model name with escapes and markup) is neutralised in every format", async () => {
		const evil = "bad\u001b]0;pwned\u0007<img src=x onerror=alert(1)>|\u009b2J";
		await vault([{ cost: 9, data: { model: evil, costCenter: evil } }]);
		for (const format of ["md", "html"] as const) {
			stdout = "";
			await run(dir, {}, ["--week", "--end", endIso(), "--format", format]);
			// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting NO control character survives
			expect(stdout, format).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
			if (format === "html") {
				expect(stdout).not.toContain("<img");
				expect(stdout).toContain("&lt;img");
			}
		}
		write.mockRestore();
	});
});
