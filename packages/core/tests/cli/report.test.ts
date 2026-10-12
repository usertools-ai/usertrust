// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { verifyVault } from "../../src/audit/verify.js";
import { reportArgv } from "../../src/cli/flags.js";
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
			["--week", "--end", endIso(), "--agent-key", "actor", "--segment", "1"],
			["--week", "--end", endIso(), "--agent-key", "principal.id", "--segment", "0"],
			["--week", "--end", endIso(), "--top", "0"],
			["--week", "--end", endIso(), "--budget", "0"],
			["--week", "--end", endIso(), "--budget", "5", "--tenant-config", "x.json"],
			["--week", "--end", endIso(), "--bogus"],
			["--week", "--end", "--format", "md"],
			["--week", "--end", endIso(), "--out"],
		]) {
			out = [];
			process.exitCode = undefined;
			await run(dir, {}, argv);
			expect(process.exitCode, JSON.stringify(argv)).toBe(2);
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
				{ cost: 50, data: { principal: { id: "agent-b" }, model: "gpt-5" } },
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
		expect(stdout).toContain("| `agent-a` | 1 | $0.01 | 66.7% |");
		// only the unattributed 50 UT debits the session wallet; the cost-center 100 UT debits its envelope
		expect(stdout).toContain("5.0% of the budget used");
		expect(stdout).toContain("payer is not recorded");
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

	it("--budget and --tenant-config name a server tenant's budget, and the report says where it came from", async () => {
		await vault([{ cost: 100, data: { principal: { id: "a" } } }]);
		await run(dir, {}, ["--week", "--end", endIso(), "--budget", "1000"]);
		expect(stdout).toContain("source: `--budget`");
		expect(stdout).toContain("10.0% of the budget used");
		stdout = "";
		const tenant = join(dir, "tenant.config.json");
		writeFileSync(tenant, JSON.stringify({ budget: 500, tigerbeetle: { addresses: ["x"] } }));
		await run(dir, {}, ["--week", "--end", endIso(), "--tenant-config", tenant]);
		expect(stdout).toContain("source: `tenant config`");
		expect(stdout).toContain("20.0% of the budget used");
		// an unreadable or budget-less tenant config is refused, not silently "no budget"
		for (const bad of ["{ not json", JSON.stringify({ budget: "5" }), JSON.stringify({})]) {
			writeFileSync(tenant, bad);
			out = [];
			process.exitCode = undefined;
			await run(dir, {}, ["--week", "--end", endIso(), "--tenant-config", tenant]);
			expect(process.exitCode, bad).toBe(1);
			expect(out.join("\n")).toContain("tenant-config");
		}
	});

	it("verdict and figures come from ONE snapshot: a rewrite after the snapshot cannot be reported as verified", async () => {
		await vault([{ cost: 100 }]);
		const log = join(dir, ".usertrust", "audit", "events.jsonl");
		const original = readFileSync(log, "utf-8");
		const tampered = original.replace(/"cost":100/, '"cost":9999');
		expect(tampered).not.toBe(original);
		// the live vault is rewritten right after the report took its snapshot
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"], {
			afterSnapshot: () => writeFileSync(log, tampered),
		});
		const model = JSON.parse(stdout) as {
			integrity: { verified: boolean };
			totals: { confirmedUt: number };
		};
		// verified bytes AND figures are the snapshot's: 100 UT, verified. Never "verified" over 9,999 UT.
		expect(model.integrity.verified).toBe(true);
		expect(model.totals.confirmedUt).toBe(100);
		expect(process.exitCode).toBeUndefined();
		// and the NEXT report, which snapshots the rewritten file, sees it for what it is
		stdout = "";
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
		expect((JSON.parse(stdout) as { integrity: { verified: boolean } }).integrity.verified).toBe(
			false,
		);
		expect(process.exitCode).toBe(2);
		write.mockRestore();
	});

	it("the integrity verdict is scrubbed: control bytes in an event id cannot erase the UNVERIFIED line", async () => {
		await vault([{ cost: 100 }]);
		const log = join(dir, ".usertrust", "audit", "events.jsonl");
		const lines = readFileSync(log, "utf-8").trim().split("\n");
		const first = JSON.parse(lines[0] as string) as { id: string };
		first.id = "evil\u001b[2K\u001b[1A\u009b2Jid";
		writeFileSync(log, `${[JSON.stringify(first), ...lines.slice(1)].join("\n")}\n`);
		for (const format of ["md", "html"] as const) {
			stdout = "";
			await run(dir, {}, ["--week", "--end", endIso(), "--format", format]);
			// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting NO control character survives
			expect(stdout, format).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
			expect(stdout, format).toContain("UNVERIFIED");
		}
		write.mockRestore();
	});

	it("a malformed line in the chain still yields a report: UNVERIFIED, exit 2, no crash", async () => {
		await vault([{ cost: 100 }]);
		const log = join(dir, ".usertrust", "audit", "events.jsonl");
		writeFileSync(
			log,
			`${readFileSync(log, "utf-8")}{"id":"x","kind":"llm_call","timestamp":"2026-10-01T00:00:00Z","data":null}\nnot json at all\n`,
		);
		await run(dir, {}, ["--week", "--end", endIso()]);
		expect(process.exitCode).toBe(2);
		expect(stdout).toContain("UNVERIFIED");
		expect(stdout).toContain("Confirmed spend");
		write.mockRestore();
	});

	it("a literal null line in the log yields a report, never a crash: UNVERIFIED, exit 2", async () => {
		await vault([{ cost: 100 }]);
		const log = join(dir, ".usertrust", "audit", "events.jsonl");
		writeFileSync(log, `${readFileSync(log, "utf-8")}null\n`);
		await run(dir, {}, ["--week", "--end", endIso()]);
		expect(process.exitCode).toBe(2);
		expect(stdout).toContain("UNVERIFIED");
		write.mockRestore();
	});

	it("a dot-named log segment is part of the snapshot: the verdict matches the live vault's", async () => {
		await vault([{ cost: 100 }, { cost: 200 }, { cost: 300 }]);
		const lines = readFileSync(join(dir, ".usertrust", "audit", "events.jsonl"), "utf-8")
			.trim()
			.split("\n");
		writeFileSync(join(dir, ".usertrust", "audit", ".hidden-0001.jsonl"), `${lines[0]}\n`);
		writeFileSync(
			join(dir, ".usertrust", "audit", "events.jsonl"),
			`${lines.slice(1).join("\n")}\n`,
		);
		const live = verifyVault(join(dir, ".usertrust"));
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
		expect((JSON.parse(stdout) as { integrity: { verified: boolean } }).integrity.verified).toBe(
			live.valid,
		);
		write.mockRestore();
	});

	describe("a writer appending during the snapshot", () => {
		const auditDir = () => join(dir, ".usertrust", "audit");
		const state = () => ({
			log: readFileSync(join(auditDir(), "events.jsonl")),
			meta: readFileSync(join(auditDir(), "events.jsonl.meta")),
		});

		async function twoStates() {
			await vault([{ cost: 100 }, { cost: 200 }]);
			const before = state();
			const w = createAuditWriter(dir);
			await w.appendEvent({
				kind: "llm_call",
				actor: "local",
				data: { model: "m", cost: 300, settled: true, transferId: "t-late" },
			});
			w.release();
			const after = state();
			writeFileSync(join(auditDir(), "events.jsonl"), before.log);
			writeFileSync(join(auditDir(), "events.jsonl.meta"), before.meta);
			return { before, after };
		}

		it("log and sidecar both replaced between the reads: retried, VERIFIED, not UNVERIFIED", async () => {
			const { after } = await twoStates();
			await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"], {
				betweenReads: (attempt) => {
					if (attempt !== 1) return;
					writeFileSync(join(auditDir(), "events.jsonl"), after.log);
					writeFileSync(join(auditDir(), "events.jsonl.meta"), after.meta);
				},
			});
			expect((JSON.parse(stdout) as { integrity: { verified: boolean } }).integrity.verified).toBe(
				true,
			);
			expect(process.exitCode).toBeUndefined();
			write.mockRestore();
		});

		it("a new log over the OLD sidecar that RESOLVES (the sidecar advances): the settled state is read, nothing dropped", async () => {
			const { before, after } = await twoStates();
			// the writer has fsynced the log and not yet replaced the sidecar
			writeFileSync(join(auditDir(), "events.jsonl"), after.log);
			writeFileSync(join(auditDir(), "events.jsonl.meta"), before.meta);
			await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"], {
				betweenReads: (attempt) => {
					if (attempt === 1) writeFileSync(join(auditDir(), "events.jsonl.meta"), after.meta);
				},
			});
			const out = JSON.parse(stdout) as {
				integrity: { verified: boolean };
				totals: { confirmedCalls: number };
			};
			expect(out.integrity.verified).toBe(true);
			expect(out.totals.confirmedCalls).toBe(3);
			expect(process.exitCode).toBeUndefined();
			write.mockRestore();
		});

		it("a PERSISTENT tail (a crash between the log fsync and the sidecar replace) is kept and reported UNVERIFIED, never dropped", async () => {
			const { before, after } = await twoStates();
			writeFileSync(join(auditDir(), "events.jsonl"), after.log);
			writeFileSync(join(auditDir(), "events.jsonl.meta"), before.meta);
			// what the verifier says about these very bytes
			expect(verifyVault(join(dir, ".usertrust")).valid).toBe(false);
			await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"], { persistMs: 100 });
			const out = JSON.parse(stdout) as {
				integrity: { verified: boolean };
				totals: { confirmedCalls: number };
			};
			expect(out.integrity.verified).toBe(false);
			expect(out.totals.confirmedCalls).toBe(3); // the extra event is in the figures, not silently omitted
			expect(process.exitCode).toBe(2);
			write.mockRestore();
		});

		it("a persistent UNTERMINATED tail gets the same verdict from the report as from the verifier", async () => {
			await vault([{ cost: 100 }, { cost: 200 }]);
			const log = join(auditDir(), "events.jsonl");
			writeFileSync(log, `${readFileSync(log, "utf-8")}{"id":"half`);
			const live = verifyVault(join(dir, ".usertrust"));
			await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"], { persistMs: 100 });
			const out = JSON.parse(stdout) as { integrity: { verified: boolean } };
			expect(out.integrity.verified).toBe(live.valid);
			expect(process.exitCode).toBe(live.valid ? undefined : 2);
			write.mockRestore();
		});

		it("a busy active log does not hide a real mismatch in a stable rotated segment", async () => {
			await vault([{ cost: 100 }, { cost: 200 }, { cost: 300 }]);
			const lines = readFileSync(join(auditDir(), "events.jsonl"), "utf-8").trim().split("\n");
			// rotate by hand: the first line becomes a segment, then tamper with it
			const tampered = (lines[0] as string).replace('"cost":100', '"cost":999');
			expect(tampered).not.toBe(lines[0]);
			writeFileSync(join(auditDir(), "events-0001.jsonl"), `${tampered}\n`);
			writeFileSync(join(auditDir(), "events.jsonl"), `${lines.slice(1).join("\n")}\n`);
			let n = 0;
			await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"], {
				persistMs: 50,
				betweenReads: () => {
					n += 1;
					writeFileSync(
						join(auditDir(), "events.jsonl.meta"),
						JSON.stringify({ lastHash: "x".repeat(64), sequence: n }),
					);
				},
			});
			const out = JSON.parse(stdout) as { integrity: { verified: boolean; errors: string[] } };
			expect(out.integrity.verified).toBe(false);
			const text = out.integrity.errors.join(" | ");
			expect(text).toMatch(/Vault busy/);
			expect(text).toMatch(/mismatch|hash|tamper|invalid|sequence/i); // the real problem is still there
			expect(out.integrity.errors.length).toBeGreaterThan(1);
			expect(process.exitCode).toBe(2);
			write.mockRestore();
		});

		it("a SLOW sidecar replace inside the persistence window reads VERIFIED, not as a broken chain", async () => {
			const { before, after } = await twoStates();
			writeFileSync(join(auditDir(), "events.jsonl"), after.log);
			writeFileSync(join(auditDir(), "events.jsonl.meta"), before.meta);
			let attempts = 0;
			await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"], {
				persistMs: 400,
				betweenReads: () => {
					attempts += 1;
					// the sidecar lands partway through the window, after several identical reads
					if (attempts === 4) writeFileSync(join(auditDir(), "events.jsonl.meta"), after.meta);
				},
			});
			const out = JSON.parse(stdout) as {
				integrity: { verified: boolean };
				totals: { confirmedCalls: number };
			};
			expect(attempts).toBeGreaterThanOrEqual(4);
			expect(out.integrity.verified).toBe(true);
			expect(out.totals.confirmedCalls).toBe(3);
			write.mockRestore();
		});

		it("a sidecar that changes on EVERY attempt is reported as a busy vault, not a broken chain, exit 2", async () => {
			await vault([{ cost: 100 }]);
			let n = 0;
			await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"], {
				betweenReads: () => {
					n += 1;
					writeFileSync(
						join(auditDir(), "events.jsonl.meta"),
						JSON.stringify({ lastHash: "x".repeat(64), sequence: n }),
					);
				},
			});
			const out = JSON.parse(stdout) as { integrity: { verified: boolean; errors: string[] } };
			expect(out.integrity.verified).toBe(false);
			expect(out.integrity.errors.join(" ")).toMatch(/Vault busy/);
			expect(out.integrity.errors.join(" ")).not.toMatch(/mismatch|corrupt/i);
			expect(process.exitCode).toBe(2);
			write.mockRestore();
		});
	});

	it("a repeated option exits 2: every option is single-occurrence, none can silently overwrite another", async () => {
		await vault([{ cost: 1 }]);
		for (const argv of [
			["--week", "--week", "--end", endIso()],
			["--week", "--end", endIso(), "--format", "pdf", "--format", "md"],
			["--week", "--end", endIso(), "--format=md", "--format", "json"],
			["--week", "--end", endIso(), "--end", endIso()],
			["--week", "--end", endIso(), "--top", "3", "--top", "4"],
			["--json", "--week", "--end", endIso(), "--json"],
		]) {
			process.exitCode = undefined;
			await run(dir, {}, argv);
			expect(process.exitCode, JSON.stringify(argv)).toBe(2);
		}
		write.mockRestore();
	});

	it("a malformed vault budget config exits 2 with a named reason, never 'no budget configured'", async () => {
		for (const bad of [
			"{not json",
			'{"budget":"5"}',
			'{"budget":-1}',
			'{"budget":0}',
			'{"budget":1.5}',
			"[]",
			"null",
		]) {
			rmSync(join(dir, ".usertrust"), { recursive: true, force: true });
			await vault([{ cost: 1 }]);
			writeFileSync(join(dir, ".usertrust", "usertrust.config.json"), bad);
			stdout = "";
			out = [];
			process.exitCode = undefined;
			await run(dir, {}, ["--week", "--end", endIso()]);
			expect(process.exitCode, bad).toBe(2);
			expect(out.join("\n"), bad).toMatch(/vault config/);
			expect(stdout, bad).not.toMatch(/no budget configured/i);
		}
		write.mockRestore();
	});

	it("a global flag in front of the command is refused like one behind it: both orders", async () => {
		await vault([{ cost: 1 }]);
		for (const [label, argv] of [
			["after", ["report", "--week", "--end", endIso(), "--skip-verify"]],
			["before", ["--skip-verify", "report", "--week", "--end", endIso()]],
			["before, reconfigure", ["--reconfigure", "report", "--week", "--end", endIso()]],
		] as const) {
			process.exitCode = undefined;
			await run(dir, {}, reportArgv(argv));
			expect(process.exitCode, label).toBe(2);
		}
		// CONTROL: --json in front is honoured, and a repeated --json (either side) is refused
		process.exitCode = undefined;
		await run(dir, {}, reportArgv(["--json", "report", "--week", "--end", endIso()]));
		expect(process.exitCode).toBeUndefined();
		process.exitCode = undefined;
		await run(dir, {}, reportArgv(["--json", "report", "--week", "--end", endIso(), "--json"]));
		expect(process.exitCode).toBe(2);
		write.mockRestore();
	});

	it("CONTROL: an absent budget key or config is 'no budget configured' and succeeds", async () => {
		await vault([{ cost: 1 }]);
		writeFileSync(join(dir, ".usertrust", "usertrust.config.json"), "{}");
		await run(dir, {}, ["--week", "--end", endIso()]);
		expect(process.exitCode).toBeUndefined();
		write.mockRestore();
	});

	it("--segment is accepted with auto and cost-center", async () => {
		await vault([{ cost: 1 }]);
		for (const key of ["auto", "cost-center"]) {
			process.exitCode = undefined;
			await run(dir, {}, ["--week", "--end", endIso(), "--agent-key", key, "--segment", "1"]);
			expect(process.exitCode, key).toBeUndefined();
		}
		write.mockRestore();
	});

	it("--out over an existing 0644 file leaves a 0600 file: the report is never written through", async () => {
		await vault([{ cost: 100 }]);
		const target = join(dir, "report.md");
		writeFileSync(target, "old", { mode: 0o644 });
		chmodSync(target, 0o644);
		await run(dir, {}, ["--week", "--end", endIso(), "--out", target]);
		expect(statSync(target).mode & 0o777).toBe(0o600);
		expect(readFileSync(target, "utf-8")).toContain("Confirmed spend");
		expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
		write.mockRestore();
	});

	it("HTML discloses a settlement shortfall like markdown does", async () => {
		await vault(
			[{ cost: 100, data: { transferId: "t-short" } }],
			[
				{
					kind: "settlement_shortfall",
					data: { transferId: "t-short", actual: 100, posted: 60, shortfall: 40 },
				},
			],
		);
		for (const format of ["md", "html"] as const) {
			stdout = "";
			await run(dir, {}, ["--week", "--end", endIso(), "--format", format]);
			expect(stdout, format).toContain("settlement_shortfall");
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

	// Review round 2 (P1, introduced by the snapshot): a read error was turned into ABSENCE, so with the log and its
	// anchor unreadable the copy verified as an EMPTY chain: VERIFIED, exit 0. The copy is the verifier's input set and
	// any read error on a regular file makes the report UNVERIFIED, exit 2.
	describe("the snapshot never turns a read failure into absence", () => {
		const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
		const log = () => join(dir, ".usertrust", "audit", "events.jsonl");
		const meta = () => join(dir, ".usertrust", "audit", "events.jsonl.meta");

		it.skipIf(asRoot)(
			"an unreadable LOG is UNVERIFIED, exit 2, never a shorter chain",
			async () => {
				await vault([{ cost: 100 }, { cost: 200 }]);
				chmodSync(log(), 0o000);
				try {
					await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
				} finally {
					chmodSync(log(), 0o600);
				}
				const model = JSON.parse(stdout) as {
					integrity: { verified: boolean; errors: string[] };
				};
				expect(model.integrity.verified).toBe(false);
				expect(model.integrity.errors.join(" ")).toMatch(/events\.jsonl.*EACCES/);
				expect(process.exitCode).toBe(2);
				write.mockRestore();
			},
		);

		it.skipIf(asRoot)("an unreadable ANCHOR (.meta) is UNVERIFIED, exit 2", async () => {
			await vault([{ cost: 100 }]);
			chmodSync(meta(), 0o000);
			try {
				await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
			} finally {
				chmodSync(meta(), 0o600);
			}
			expect((JSON.parse(stdout) as { integrity: { verified: boolean } }).integrity.verified).toBe(
				false,
			);
			expect(process.exitCode).toBe(2);
			write.mockRestore();
		});

		it.skipIf(asRoot)(
			"the log AND its anchor both unreadable cannot verify as an empty chain",
			async () => {
				await vault([{ cost: 100 }]);
				chmodSync(log(), 0o000);
				chmodSync(meta(), 0o000);
				try {
					await run(dir, {}, ["--week", "--end", endIso(), "--format", "md"]);
				} finally {
					chmodSync(log(), 0o600);
					chmodSync(meta(), 0o600);
				}
				expect(stdout).toContain("UNVERIFIED");
				expect(stdout).not.toContain("Audit chain VERIFIED");
				expect(process.exitCode).toBe(2);
				write.mockRestore();
			},
		);

		it("a MISSING segment (a deleted rotated file) is UNVERIFIED, exit 2", async () => {
			await vault([{ cost: 100 }, { cost: 200 }, { cost: 300 }]);
			// rotate by hand: move the first line out into a segment, then delete the segment
			const lines = readFileSync(log(), "utf-8").trim().split("\n");
			const seg = join(dir, ".usertrust", "audit", "events-0001.jsonl");
			writeFileSync(seg, `${lines[0]}\n`);
			writeFileSync(log(), `${lines.slice(1).join("\n")}\n`);
			rmSync(seg);
			await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
			expect((JSON.parse(stdout) as { integrity: { verified: boolean } }).integrity.verified).toBe(
				false,
			);
			expect(process.exitCode).toBe(2);
			write.mockRestore();
		});

		it("CONTROL: with every file readable the same vault verifies, exit 0", async () => {
			await vault([{ cost: 100 }, { cost: 200 }]);
			await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
			expect((JSON.parse(stdout) as { integrity: { verified: boolean } }).integrity.verified).toBe(
				true,
			);
			expect(process.exitCode).toBeUndefined();
			expect(readdirSync(join(dir, ".usertrust", "audit")).length).toBeGreaterThan(0);
			write.mockRestore();
		});
	});
});
