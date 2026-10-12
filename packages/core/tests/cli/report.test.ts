// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { readChainDeadLetters } from "../../src/audit/dead-letters.js";
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

	it("--out that RESOLVES inside the vault is refused (exit 2), directly or through a symlink; nothing is written", async () => {
		await vault([{ cost: 1 }]);
		const vaultDir = join(dir, ".usertrust");
		const log = join(vaultDir, "audit", "events.jsonl");
		const before = readFileSync(log, "utf-8");
		writeFileSync(join(vaultDir, "usertrust.config.json"), JSON.stringify({ budget: 1000 }));
		const configBefore = readFileSync(join(vaultDir, "usertrust.config.json"), "utf-8");
		symlinkSync(log, join(dir, "link-into-vault.md"));
		symlinkSync(join(vaultDir, "audit"), join(dir, "dirlink"));
		for (const out of [
			log,
			join(vaultDir, "usertrust.config.json"),
			join(dir, "link-into-vault.md"),
			join(dir, "dirlink", "report.md"),
			join(vaultDir, "new-file.md"),
		]) {
			process.exitCode = undefined;
			await run(dir, {}, ["--week", "--end", endIso(), "--out", out]);
			expect(process.exitCode, out).toBe(2);
		}
		expect(readFileSync(log, "utf-8")).toBe(before);
		expect(readFileSync(join(vaultDir, "usertrust.config.json"), "utf-8")).toBe(configBefore);
		expect(existsSync(join(vaultDir, "new-file.md"))).toBe(false);
		expect(existsSync(join(vaultDir, "audit", "report.md"))).toBe(false);
		// CONTROL: a path beside the vault is fine
		process.exitCode = undefined;
		await run(dir, {}, ["--week", "--end", endIso(), "--out", join(dir, "ok.md")]);
		expect(process.exitCode).toBeUndefined();
		write.mockRestore();
	});

	it("--out naming a SYMLINK that lives inside the vault and points outside is refused: the rename would replace the vault's own entry", async () => {
		await vault([{ cost: 1 }]);
		const vaultDir = join(dir, ".usertrust");
		const outside = join(dir, "outside-target.md");
		writeFileSync(outside, "ORIGINAL");
		const inVault = join(vaultDir, "link-out.md");
		symlinkSync(outside, inVault);
		process.exitCode = undefined;
		await run(dir, {}, ["--week", "--end", endIso(), "--out", inVault]);
		expect(process.exitCode).toBe(2);
		// both files unchanged: the entry is still the same symlink, and its target was never written
		expect(readFileSync(outside, "utf-8")).toBe("ORIGINAL");
		expect(lstatSync(inVault).isSymbolicLink()).toBe(true);
		expect(readdirSync(vaultDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
		write.mockRestore();
	});

	it("the governor's spend ledger is read from the same snapshot: equal is silent, a difference is flagged", async () => {
		await vault([{ cost: 100 }]);
		const ledger = join(dir, ".usertrust", "spend-ledger.json");
		writeFileSync(ledger, JSON.stringify({ budgetSpent: 100 }));
		stdout = "";
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
		expect((JSON.parse(stdout) as { spendLedger: { differs: boolean } }).spendLedger.differs).toBe(
			false,
		);
		writeFileSync(ledger, JSON.stringify({ budgetSpent: 9999 }));
		stdout = "";
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
		const out = JSON.parse(stdout) as {
			spendLedger: { differs: boolean; recorded: number };
			integrity: { verified: boolean };
		};
		expect(out.spendLedger).toMatchObject({ differs: true, recorded: 9999 });
		expect(out.integrity.verified).toBe(true); // the unverified file never touches the VERIFIED claim
		write.mockRestore();
	});

	it("the verdict states the instant the chain was read, in md, html and json", async () => {
		await vault([{ cost: 1 }]);
		const before = Date.now();
		// markdown wraps vault-derived text in a code span, html does not
		const stamp = /Chain as read at `?(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;
		for (const format of ["md", "html"] as const) {
			stdout = "";
			await run(dir, {}, ["--week", "--end", endIso(), "--format", format]);
			const at = stamp.exec(stdout)?.[1];
			expect(at, format).toBeDefined();
			const ms = Date.parse(at as string);
			expect(ms, format).toBeGreaterThanOrEqual(before - 1);
			expect(ms, format).toBeLessThanOrEqual(Date.now());
		}
		stdout = "";
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
		const out = JSON.parse(stdout) as { integrity: { readAtIso: string; verified: boolean } };
		expect(out.integrity.verified).toBe(true);
		expect(Number.isFinite(Date.parse(out.integrity.readAtIso))).toBe(true);
		write.mockRestore();
	});

	it("an ABSENT spend ledger reads as a counter of 0, as the governors read it: a headless ambiguity over budget is disputed, not definite", async () => {
		// headless settle() appends settlement_ambiguous BEFORE it adds to the counter and persists it
		await vault([], [{ kind: "settlement_ambiguous", data: { transferId: "t-amb", cost: 1200 } }]);
		const ledger = join(dir, ".usertrust", "spend-ledger.json");
		expect(existsSync(ledger)).toBe(false);
		type Out = {
			spendLedger: { recorded: number | null; differs: boolean; unreadable: boolean };
			budget: { overBudget: boolean; overBudgetDisputed: boolean; possiblyOverBudget: boolean };
		};
		stdout = "";
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "json", "--budget", "1000"]);
		const out = JSON.parse(stdout) as Out;
		// the third leg: the chain shows session spend, the counter (absent = 0) shows none
		expect(out.spendLedger).toMatchObject({ recorded: 0, differs: true, unreadable: false });
		expect(out.budget).toMatchObject({
			overBudget: false,
			overBudgetDisputed: true,
			possiblyOverBudget: true,
		});
		// CONTROL: once the governor has persisted a counter that agrees, the definite claim stands
		writeFileSync(ledger, JSON.stringify({ budgetSpent: 1200 }));
		stdout = "";
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "json", "--budget", "1000"]);
		expect((JSON.parse(stdout) as Out).budget).toMatchObject({
			overBudget: true,
			overBudgetDisputed: false,
		});
		write.mockRestore();
	});

	it.skipIf(process.getuid?.() === 0)(
		"a spend ledger that EXISTS but cannot be read stays unreadable, never the absent-file zero",
		async () => {
			await vault([{ cost: 100 }]);
			const ledger = join(dir, ".usertrust", "spend-ledger.json");
			writeFileSync(ledger, JSON.stringify({ budgetSpent: 100 }));
			chmodSync(ledger, 0o000);
			try {
				stdout = "";
				await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
				const out = JSON.parse(stdout) as { spendLedger: { unreadable: boolean } };
				expect(out.spendLedger.unreadable).toBe(true);
			} finally {
				chmodSync(ledger, 0o600);
			}
			write.mockRestore();
		},
	);

	describe("COMPLETENESS: a dead-lettered chain event that is not on the chain is not VERIFIED", () => {
		type Out = { integrity: { verified: boolean; errors: string[] } };
		const readReport = async (): Promise<Out> => {
			stdout = "";
			process.exitCode = undefined;
			await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
			return JSON.parse(stdout) as Out;
		};

		/** tx_kept on the chain from writer A; tx_lost from writer B (a second writer): rejected and dead-lettered. */
		async function vaultWithOneLostEvent(): Promise<void> {
			mkdirSync(join(dir, ".usertrust", "audit"), { recursive: true });
			const a = createAuditWriter(dir);
			const b = createAuditWriter(dir);
			try {
				await a.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: { transferId: "tx_kept", cost: 5 },
				});
				await expect(
					b.appendEvent({
						kind: "llm_call",
						actor: "local",
						data: { transferId: "tx_lost", cost: 7 },
					}),
				).rejects.toThrow();
			} finally {
				a.release();
				b.release();
			}
		}

		it("an event dead-lettered and absent from the chain: UNVERIFIED and INCOMPLETE, and `verify` agrees on the same vault", async () => {
			await vaultWithOneLostEvent();
			const out = await readReport();
			expect(out.integrity.verified).toBe(false);
			expect(out.integrity.errors.join("\n")).toContain("INCOMPLETE");
			expect(out.integrity.errors.join("\n")).toContain("never reached the chain");
			expect(process.exitCode).toBe(2);
			// the verifier's own reader, on the real vault, agrees on the count
			const verifier = readChainDeadLetters(join(dir, ".usertrust"), () => undefined);
			expect("missing" in verifier && verifier.missing).toBe(1);
			// the message names the vault's real queue, never the snapshot's temp path
			expect(out.integrity.errors.join("\n")).toContain(join(dir, ".usertrust", "dlq"));
			write.mockRestore();
		});

		it("a dead letter whose event DID reach the chain (its eventHash is on it) stays VERIFIED", async () => {
			mkdirSync(join(dir, ".usertrust", "audit"), { recursive: true });
			const w = createAuditWriter(dir);
			try {
				await w.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: { transferId: "tx_1", cost: 5 },
				});
				// the second event reaches the chain, but its .meta update fails: it is dead-lettered WITH its hash
				const meta = join(dir, ".usertrust", "audit", "events.jsonl.meta");
				rmSync(meta, { force: true });
				mkdirSync(meta);
				try {
					await expect(
						w.appendEvent({
							kind: "llm_call",
							actor: "local",
							data: { transferId: "tx_2", cost: 5 },
						}),
					).rejects.toThrow();
				} finally {
					rmSync(meta, { recursive: true });
				}
			} finally {
				w.release();
			}
			const out = await readReport();
			expect(out.integrity.errors.join("\n")).not.toContain("INCOMPLETE");
			write.mockRestore();
		});

		it.skipIf(process.getuid?.() === 0)(
			"a queue that EXISTS but cannot be read is UNVERIFIED (INCOMPLETE?), never 'no dead letters'",
			async () => {
				await vault([{ cost: 1 }]);
				const dlqDir = join(dir, ".usertrust", "dlq");
				mkdirSync(dlqDir, { recursive: true });
				const queue = join(dlqDir, "dead-letters.jsonl");
				writeFileSync(queue, "");
				chmodSync(queue, 0o000);
				try {
					const out = await readReport();
					expect(out.integrity.verified).toBe(false);
					expect(out.integrity.errors.join("\n")).toContain("INCOMPLETE?");
				} finally {
					chmodSync(queue, 0o600);
				}
				write.mockRestore();
			},
		);

		it("no queue at all: nothing was ever dead-lettered, so VERIFIED stands", async () => {
			await vault([{ cost: 1 }]);
			const out = await readReport();
			expect(out.integrity.verified).toBe(true);
			write.mockRestore();
		});
	});

	it("the dead-letter queue is read from the snapshot: a dead-lettered shortfall makes a headless post exact at the posted amount, an unreadable queue an upper bound", async () => {
		await vault([
			{
				cost: 100,
				data: { transferId: "t-cap", source: "headless", ledgerPosted: true },
			},
		]);
		const dlqDir = join(dir, ".usertrust", "dlq");
		mkdirSync(dlqDir, { recursive: true });
		const entry = {
			source: "audit.chain.appendEvent",
			payload: {
				kind: "settlement_shortfall",
				actor: "local",
				data: { transferId: "t-cap", actual: 100, posted: 60, shortfall: 40 },
			},
			error: "disk full",
			timestamp: "2026-10-08T01:00:00.000Z",
		};
		const checksum = createHash("sha256").update(canonicalize(entry)).digest("hex");
		const dlq = join(dlqDir, "dead-letters.jsonl");
		writeFileSync(dlq, `${JSON.stringify({ ...entry, checksum, checksumAlg: "sha256" })}\n`);
		type Totals = {
			postProvenUt: number;
			postProvenDeadLetterUt: number;
			postProvenUpperUt: number;
		};
		stdout = "";
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
		let totals = (JSON.parse(stdout) as { totals: Totals }).totals;
		expect(totals).toMatchObject({
			postProvenUt: 60,
			postProvenDeadLetterUt: 60,
			postProvenUpperUt: 0,
		});
		// no queue file at all proves nothing: the shortfall may not have been appended yet, so only an upper bound
		rmSync(dlq);
		stdout = "";
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
		totals = (JSON.parse(stdout) as { totals: Totals }).totals;
		expect(totals).toMatchObject({ postProvenUt: 0, postProvenUpperUt: 100 });
		// a corrupt queue: only an upper bound, and completeness is unknown
		writeFileSync(dlq, "{corrupt\n");
		stdout = "";
		await run(dir, {}, ["--week", "--end", endIso(), "--format", "json"]);
		const parsed = JSON.parse(stdout) as { totals: Totals; integrity: { verified: boolean } };
		expect(parsed.totals).toMatchObject({ postProvenUt: 0, postProvenUpperUt: 100 });
		// an unreadable queue means completeness is unknown: the chain is not VERIFIED
		expect(parsed.integrity.verified).toBe(false);
		write.mockRestore();
	});

	// A root process can read a mode-000 file, so the unreadable config cannot be staged there.
	it.skipIf(process.getuid?.() === 0)(
		"an UNREADABLE vault config reads as 'budget unknown', never 'no budget configured'",
		async () => {
			await vault([{ cost: 1 }]);
			const cfg = join(dir, ".usertrust", "usertrust.config.json");
			writeFileSync(cfg, JSON.stringify({ budget: 1000 }));
			chmodSync(cfg, 0o000);
			try {
				for (const format of ["md", "html"] as const) {
					stdout = "";
					process.exitCode = undefined;
					await run(dir, {}, ["--week", "--end", endIso(), "--format", format]);
					expect(stdout, format).toMatch(/Budget unknown/);
					expect(stdout, format).not.toMatch(/No budget is configured/);
					expect(process.exitCode, format).toBe(2);
				}
			} finally {
				chmodSync(cfg, 0o600);
			}
			write.mockRestore();
		},
	);

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
