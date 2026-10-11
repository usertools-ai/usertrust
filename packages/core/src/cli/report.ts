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

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

export interface ReportArgs {
	week: boolean;
	endMs: number;
	format: ReportFormat;
	out: string | undefined;
	agentKey: AgentKey;
	segment: number | undefined;
	top: number;
}

const VALUE_FLAGS = ["--end", "--format", "--out", "--agent-key", "--segment", "--top"] as const;

export function parseReportArgs(argv: readonly string[], jsonFlag: boolean): ReportArgs {
	let week = false;
	let end: string | undefined;
	let format: string | undefined;
	let out: string | undefined;
	let agentKey: string | undefined;
	let segment: string | undefined;
	let top: string | undefined;
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
	if (jsonFlag && fmt !== "json") throw new Error("--json conflicts with --format " + fmt);
	const key = agentKey ?? "auto";
	if (!(AGENT_KEYS as readonly string[]).includes(key)) {
		throw new Error(`Invalid --agent-key: ${scrubForTerminal(key)} (${AGENT_KEYS.join(", ")})`);
	}
	return {
		week,
		endMs: parseEnd(end),
		format: fmt,
		out,
		agentKey: key as AgentKey,
		segment: segment === undefined ? undefined : nonNegativeInt("--segment", segment, 32),
		top: top === undefined ? 10 : Math.max(1, nonNegativeInt("--top", top, 100)),
	};
}

export async function run(rootDir?: string, opts?: CliOptions, args?: string[]): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);
	const json = opts?.json === true;
	const argv = args ?? process.argv.slice(3);

	const fail = (message: string): void => {
		if (json) console.log(toSafeJson({ command: "report", success: false, data: { message } }));
		else console.log(`${pc.red("report failed:")} ${scrubForTerminal(message)}`);
		process.exitCode = 1;
	};

	let parsed: ReportArgs;
	try {
		parsed = parseReportArgs(argv, json);
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
		return;
	}
	if (!existsSync(vaultPath)) {
		fail("No trust vault found. Run `usertrust init` first.");
		return;
	}

	try {
		const verdict = verifyVault(vaultPath);
		const events = readLedgerEvents(vaultPath);
		const model = buildWeeklyReport(
			events,
			{
				verified: verdict.valid,
				errors: verdict.errors,
				chainLength: verdict.chainLength,
				firstEvent: verdict.firstEvent,
				lastEvent: verdict.lastEvent,
			},
			{
				endMs: parsed.endMs,
				agentKey: parsed.agentKey,
				...(parsed.segment !== undefined ? { segment: parsed.segment } : {}),
				topN: parsed.top,
				budget: loadBudgetConfig(vaultPath).budget,
			},
		);
		const text = render(model, parsed.format);
		if (parsed.out !== undefined) {
			const target = resolve(root, parsed.out);
			writeFileSync(target, text, { encoding: "utf-8", mode: 0o600 });
			if (!json) console.log(`Wrote ${parsed.format} report to ${scrubForTerminal(target)}`);
			else
				console.log(
					toSafeJson({
						command: "report",
						success: true,
						data: { out: target, verified: verdict.valid },
					}),
				);
		} else {
			process.stdout.write(text);
		}
		if (!verdict.valid) process.exitCode = 2;
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
}
