// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust report --week --end <ISO instant with zone> [--format md|html|json] [--out <path>]
 *                       [--agent-key <key>] [--segment <n>] [--top <n>]
 *
 * A weekly spend report from the customer's OWN vault: spend by agent and model, cost drivers, top costs, budget
 * status. READ-ONLY on the vault (readers never write): the only file it writes is `--out`.
 *
 * Money-command flag rules (AGENTS.md): every flag is validated, nothing that scopes a report has a silent default
 * (`--end` is required, never "now"), `--flag=value` is the only way to pass a value that begins with `-`, the
 * unknown-argument guard is a catch-all, and every echoed value goes through the terminal scrubber.
 *
 * The integrity verdict is part of the report: a chain that does not verify still produces a report, stamped
 * UNVERIFIED everywhere, and the exit code is 2 so a cron job notices.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import pc from "picocolors";
import { loadBudgetConfig, readLedgerEvents } from "../audit/read.js";
import { verifyVault } from "../audit/verify.js";
import { type ReportFormat, render } from "../report/render.js";
import { AGENT_KEYS, type AgentKey, buildWeeklyReport } from "../report/weekly.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { CliOptions } from "./init.js";
import { scrubForTerminal, toSafeJson } from "./target.js";

/** Same shape as `cli/budget.ts` (kept as a local copy: that module imports the native TigerBeetle binding). */
const ISO_8601_INSTANT =
	/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isRealDate(year: number, month: number, day: number): boolean {
	if (!Number.isInteger(month) || month < 1 || month > 12) return false;
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const maxDay = month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
	return day >= 1 && day <= maxDay;
}

export function parseEnd(raw: string): number {
	const parts = ISO_8601_INSTANT.exec(raw);
	const ms = parts === null ? Number.NaN : Date.parse(raw.replace(" ", "T"));
	if (
		parts === null ||
		!isRealDate(Number(parts[1]), Number(parts[2]), Number(parts[3])) ||
		!Number.isFinite(ms)
	) {
		throw new Error(
			`Invalid --end: ${scrubForTerminal(raw)} (ISO-8601 instant with an explicit timezone required, e.g. 2026-10-12T00:00:00Z)`,
		);
	}
	return ms;
}

function requireValue(flag: string, raw: string | undefined, inline: boolean): string {
	if (raw === undefined || raw === "") throw new Error(`${flag} requires a value`);
	if (!inline && raw.startsWith("-")) {
		throw new Error(
			`${flag} requires a value (write ${flag}=${scrubForTerminal(raw)} to pass it literally)`,
		);
	}
	return raw;
}

function nonNegativeInt(flag: string, raw: string, max: number): number {
	if (!/^\d{1,6}$/.test(raw))
		throw new Error(`Invalid ${flag}: ${scrubForTerminal(raw)} (a non-negative integer)`);
	const n = Number(raw);
	if (n > max) throw new Error(`Invalid ${flag}: ${n} (at most ${max})`);
	return n;
}

function positiveInt(flag: string, raw: string, max: number): number {
	if (!/^\d{1,16}$/.test(raw) || Number(raw) < 1) {
		throw new Error(`Invalid ${flag}: ${scrubForTerminal(raw)} (a positive integer)`);
	}
	const n = Number(raw);
	if (n > max) throw new Error(`Invalid ${flag}: ${n} (at most ${max})`);
	return n;
}

export interface ReportArgs {
	week: boolean;
	endMs: number;
	format: ReportFormat;
	out: string | undefined;
	agentKey: AgentKey;
	segment: number | undefined;
	top: number;
	/** `--budget`: the budget in usertokens, overriding the vault config (a server tenant's budget lives in the server's tenant config). */
	budget: number | undefined;
	/** `--tenant-config`: a JSON file whose `budget` is the budget in usertokens. */
	tenantConfig: string | undefined;
}

const VALUE_FLAGS = [
	"--end",
	"--format",
	"--out",
	"--agent-key",
	"--segment",
	"--top",
	"--budget",
	"--tenant-config",
] as const;

export function parseReportArgs(argv: readonly string[], jsonFlag: boolean): ReportArgs {
	let week = false;
	let end: string | undefined;
	let format: string | undefined;
	let out: string | undefined;
	let agentKey: string | undefined;
	let segment: string | undefined;
	let top: string | undefined;
	let budget: string | undefined;
	let tenantConfig: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a === "--week") {
			week = true;
			continue;
		}
		const eq = a.indexOf("=");
		const name = eq >= 0 ? a.slice(0, eq) : a;
		if ((VALUE_FLAGS as readonly string[]).includes(name)) {
			const inline = eq >= 0;
			const value = requireValue(name, inline ? a.slice(eq + 1) : argv[i + 1], inline);
			if (!inline) i += 1;
			if (name === "--end") end = value;
			else if (name === "--format") format = value;
			else if (name === "--out") out = value;
			else if (name === "--agent-key") agentKey = value;
			else if (name === "--segment") segment = value;
			else if (name === "--budget") budget = value;
			else if (name === "--tenant-config") tenantConfig = value;
			else top = value;
			continue;
		}
		throw new Error(`Unknown argument: ${scrubForTerminal(a)}`);
	}
	if (!week)
		throw new Error("Usage: usertrust report --week --end <ISO instant with zone> [options]");
	if (end === undefined) {
		throw new Error(
			"--end is required (the exclusive end of the 7-day window), e.g. --end 2026-10-12T00:00:00Z",
		);
	}
	const fmt = format ?? (jsonFlag ? "json" : "md");
	if (fmt !== "md" && fmt !== "html" && fmt !== "json") {
		throw new Error(`Invalid --format: ${scrubForTerminal(fmt)} (md, html or json)`);
	}
	if (jsonFlag && fmt !== "json") throw new Error(`--json conflicts with --format ${fmt}`);
	if (budget !== undefined && tenantConfig !== undefined) {
		throw new Error("--budget and --tenant-config both name the budget: give one");
	}
	const key = agentKey ?? "auto";
	if (!(AGENT_KEYS as readonly string[]).includes(key)) {
		throw new Error(`Invalid --agent-key: ${scrubForTerminal(key)} (${AGENT_KEYS.join(", ")})`);
	}
	// `--segment` picks a dot-separated piece of a COST CENTER; every other key ignores it, and a silently ignored
	// grouping option is a report that does not say what was asked for.
	if (segment !== undefined && key !== "auto" && key !== "cost-center") {
		throw new Error(`--segment applies only to --agent-key auto or cost-center, not ${key}`);
	}
	return {
		week,
		endMs: parseEnd(end),
		format: fmt,
		out,
		agentKey: key as AgentKey,
		segment: segment === undefined ? undefined : nonNegativeInt("--segment", segment, 32),
		// An explicit value is honoured or refused, never rewritten: `--top 0` asks for no rows and is refused.
		top: top === undefined ? 10 : positiveInt("--top", top, 100),
		budget:
			budget === undefined ? undefined : positiveInt("--budget", budget, Number.MAX_SAFE_INTEGER),
		tenantConfig,
	};
}

/**
 * ONE snapshot of the vault: every audit file is read exactly once into a private temp directory, and the verdict AND the
 * figures both come from that copy. `verifyVault` and `readLedgerEvents` each read the files themselves, so run against
 * the live vault a writer (or an attacker) changing it between the two reads produced a report stamped VERIFIED over
 * events that were never verified. The vault itself is only read.
 *
 * ABSENCE IS NOT A VALUE. The copy is the verifier's input set: every regular file of the audit directory except the writer lock
 * (the event log, any rotated segments, their anchor sidecars, the index). Only entries that are not regular files are
 * skipped. A read error on a regular file (EACCES, EIO), a directory that cannot be listed, or a file that cannot be
 * examined is a PROBLEM, returned to the caller, and the report is UNVERIFIED with exit code 2: leaving the file out would
 * let the copy verify as a shorter (even an empty) chain.
 */
export function snapshotVault(vaultPath: string): {
	dir: string;
	problems: string[];
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "usertrust-report-"));
	const problems: string[] = [];
	const problem = (what: string, err: unknown): void => {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		problems.push(`Could not read ${what}${code !== undefined ? ` (${code})` : ""}`);
	};
	try {
		const auditSrc = join(vaultPath, "audit");
		if (existsSync(auditSrc)) {
			const auditDst = join(dir, "audit");
			mkdirSync(auditDst, { recursive: true, mode: 0o700 });
			let names: string[] = [];
			try {
				names = readdirSync(auditSrc);
			} catch (err) {
				problem("the audit directory", err);
			}
			for (const name of names) {
				// A dot-named log segment is part of the chain the verifier reads; only the writer lock is not.
				if (name === ".audit-writer.lock") continue;
				const src = join(auditSrc, name);
				let isFile: boolean;
				try {
					isFile = statSync(src).isFile();
				} catch (err) {
					problem(`audit/${name}`, err);
					continue;
				}
				if (!isFile) continue; // a subdirectory (anchors/, llm_call/) is not part of the chain
				try {
					writeFileSync(join(auditDst, name), readFileSync(src), { mode: 0o600 });
				} catch (err) {
					problem(`audit/${name}`, err);
				}
			}
		}
		const configSrc = join(vaultPath, "usertrust.config.json");
		if (existsSync(configSrc)) {
			try {
				writeFileSync(join(dir, "usertrust.config.json"), readFileSync(configSrc), { mode: 0o600 });
			} catch (err) {
				problem("usertrust.config.json", err);
			}
		}
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		throw err;
	}
	return { dir, problems, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** `budget` (usertokens, a positive safe integer) from a tenant config file. */
function readTenantBudget(path: string): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		throw new Error(
			`--tenant-config ${scrubForTerminal(path)} could not be read as JSON (${err instanceof Error ? scrubForTerminal(err.message) : "error"})`,
		);
	}
	const b = (parsed as { budget?: unknown } | null)?.budget;
	if (typeof b !== "number" || !Number.isSafeInteger(b) || b < 1) {
		throw new Error(`--tenant-config ${scrubForTerminal(path)} has no positive integer "budget"`);
	}
	return b;
}

/**
 * Writes the report 0600 whatever is already at `target`: a 0600 temp file in the SAME directory, renamed into place. A
 * `mode` option only applies at creation, so writing through an existing 0644 file left a financial report world-readable.
 */
function writeReportFile(target: string, text: string): void {
	const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
	try {
		writeFileSync(tmp, text, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		renameSync(tmp, target);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}

export interface ReportHooks {
	/** Test seam: runs right after the snapshot is taken, before anything is verified or read. */
	afterSnapshot?: () => void;
}

export async function run(
	rootDir?: string,
	opts?: CliOptions,
	args?: string[],
	hooks?: ReportHooks,
): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);
	const json = opts?.json === true;
	const argv = args ?? process.argv.slice(3);

	// Exit 1 is an unusable path or an operational failure; exit 2 is an argument of the wrong shape.
	const fail = (message: string, code = 1): void => {
		if (json) console.log(toSafeJson({ command: "report", success: false, data: { message } }));
		else console.log(`${pc.red("report failed:")} ${scrubForTerminal(message)}`);
		process.exitCode = code;
	};

	let parsed: ReportArgs;
	try {
		parsed = parseReportArgs(argv, json);
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err), 2);
		return;
	}
	if (!existsSync(vaultPath)) {
		fail("No trust vault found. Run `usertrust init` first.");
		return;
	}

	try {
		let budget = 0;
		let budgetSource = "vault config";
		if (parsed.budget !== undefined) {
			budget = parsed.budget;
			budgetSource = "--budget";
		} else if (parsed.tenantConfig !== undefined) {
			budget = readTenantBudget(resolve(root, parsed.tenantConfig));
			budgetSource = "tenant config";
		}
		const snapshot = snapshotVault(vaultPath);
		let model: ReturnType<typeof buildWeeklyReport>;
		let verified: boolean;
		try {
			hooks?.afterSnapshot?.();
			// verdict and figures from the SAME bytes
			const verdict = verifyVault(snapshot.dir);
			const events = readLedgerEvents(snapshot.dir);
			verified = verdict.valid && snapshot.problems.length === 0;
			model = buildWeeklyReport(
				events,
				{
					// A file the snapshot could not read is part of the verdict, never an omission from it.
					verified: verdict.valid && snapshot.problems.length === 0,
					errors: [...snapshot.problems, ...verdict.errors],
					chainLength: verdict.chainLength,
					firstEvent: verdict.firstEvent,
					lastEvent: verdict.lastEvent,
				},
				{
					endMs: parsed.endMs,
					agentKey: parsed.agentKey,
					...(parsed.segment !== undefined ? { segment: parsed.segment } : {}),
					topN: parsed.top,
					budget:
						parsed.budget !== undefined || parsed.tenantConfig !== undefined
							? budget
							: loadBudgetConfig(snapshot.dir).budget,
					budgetSource,
				},
			);
		} finally {
			snapshot.cleanup();
		}
		const text = render(model, parsed.format);
		if (parsed.out !== undefined) {
			const target = resolve(root, parsed.out);
			writeReportFile(target, text);
			if (!json) console.log(`Wrote ${parsed.format} report to ${scrubForTerminal(target)}`);
			else
				console.log(
					toSafeJson({
						command: "report",
						success: true,
						data: { out: target, verified },
					}),
				);
		} else {
			process.stdout.write(text);
		}
		if (!verified) process.exitCode = 2;
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
}
