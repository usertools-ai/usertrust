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
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import pc from "picocolors";
import { verifyVaultComplete } from "../audit/complete.js";
import { type ReportFormat, render } from "../report/render.js";
import {
	AGENT_KEYS,
	type AgentKey,
	buildWeeklyReport,
	deadLettersForReport,
} from "../report/weekly.js";
import { VAULT_DIR } from "../shared/constants.js";
import { TrustConfigSchema } from "../shared/types.js";
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

/** Options that may appear more than once. Empty on purpose: every option is single-occurrence unless declared here. */
const REPEATABLE: ReadonlySet<string> = new Set();

/** A malformed invocation or config the operator must fix: exit 2, never a quiet default. */
class UsageError extends Error {}

/**
 * The vault config's budget, strictly. An ABSENT config or an absent `budget` key is "no budget configured"; a config
 * that cannot be read as JSON, or a `budget` that is not a finite non-negative number, is an error: reading it as zero
 * would print "no budget configured" for a vault whose operator configured one.
 */
function readVaultBudgetText(text: string): number {
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch {
		throw new UsageError("The vault config (usertrust.config.json) is not valid JSON");
	}
	if (config === null || typeof config !== "object" || Array.isArray(config)) {
		throw new UsageError("The vault config (usertrust.config.json) is not a JSON object");
	}
	const budget = (config as Record<string, unknown>)["budget"];
	if (budget === undefined) return 0;
	// The RUNTIME's own schema decides what a budget may be (a positive integer of usertokens), so the report accepts
	// exactly what the governor can load: 0 and 1.5 are refused here as they are there.
	const parsed = TrustConfigSchema.shape.budget.safeParse(budget);
	if (!parsed.success) {
		throw new UsageError(
			"The vault config's budget is not a positive integer of usertokens (the governor would not load it)",
		);
	}
	return parsed.data;
}

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
	const seen = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		const eq = a.indexOf("=");
		const name = eq >= 0 ? a.slice(0, eq) : a;
		// A repeated option would silently overwrite the first, so the report could state a scope nobody asked for.
		if (name.startsWith("--") && !REPEATABLE.has(name)) {
			if (seen.has(name)) throw new Error(`Duplicate option: ${scrubForTerminal(name)}`);
			seen.add(name);
		}
		if (a === "--week") {
			week = true;
			continue;
		}
		// The global flag, already honoured by the caller as `jsonFlag`; here only so it is counted like every other option.
		if (a === "--json") continue;
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

/** What a small side file (the vault config, the spend counter) holds. Opened only if it is a regular file. */
type SideFile =
	| { state: "absent" }
	| { state: "file"; text: string }
	| { state: "unreadable"; code: string };

/**
 * Read a side file the chain verdict does not depend on. Classified by stat before it is opened (a FIFO read would hang);
 * ENOENT from the stat is absent; anything else that is not a readable regular file is unreadable, never absent.
 */
function readSideFile(path: string): SideFile {
	try {
		if (!statSync(path).isFile()) return { state: "unreadable", code: "not a regular file" };
		return { state: "file", text: readFileSync(path, "utf-8") };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return { state: "absent" };
		return { state: "unreadable", code: typeof code === "string" ? code : "read failed" };
	}
}

/**
 * The governor's persisted counter, as recorded (NOT chain-verified). ABSENT is the governors' own reading too
 * (`loadSpendLedger`: ENOENT is a counter of 0, "the one honest zero"): a governor that has not persisted yet has counted
 * nothing, which lets the counter leg dispute a definite claim the counter does not support.
 */
function readSpendLedger(path: string): { value: number } | { unreadable: true } {
	const f = readSideFile(path);
	if (f.state === "absent") return { value: 0 };
	if (f.state === "unreadable") return { unreadable: true };
	try {
		const v = (JSON.parse(f.text) as { budgetSpent?: unknown } | null)?.budgetSpent;
		return typeof v === "number" && Number.isFinite(v) && v >= 0
			? { value: v }
			: { unreadable: true };
	} catch {
		return { unreadable: true };
	}
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
 * Refuses an `--out` that RESOLVES (through symlinks) inside the vault: the report must never be written into the
 * integrity substrate it reads, whatever path spelling reaches it. The file's own real path when it exists, else the real
 * path of its directory plus its name.
 */
function assertOutsideVault(target: string, vaultPath: string): void {
	// The OS's resolution (`realpath(3)`), not the JS one: `realpathSync` resolves `..` lexically before it follows a link, so
	// `link/..` names a different directory than the OS opens. And it FAILS CLOSED: a path that cannot be resolved cannot be
	// shown to be outside the vault, so it is refused rather than let through.
	const real = (p: string): string => realpathSync.native(p);
	const refuse = (what: string): never => {
		throw new UsageError(
			`--out cannot be shown to be outside the vault (${what}): the report is never written into the audit data it reads`,
		);
	};
	let vaultReal: string;
	try {
		vaultReal = real(vaultPath);
	} catch {
		refuse("the vault path could not be resolved");
		return; // unreachable: refuse throws
	}
	const inside = (p: string): boolean => p === vaultReal || p.startsWith(`${vaultReal}${sep}`);
	// Two paths can be the vault, and either refuses:
	//  - the file the name RESOLVES to, when it exists (a link from outside pointing in);
	//  - the directory ENTRY the write replaces: `writeReportFile` renames a temp file over `target` itself, which replaces
	//    a symlink and does not follow it. A link INSIDE the vault that points outside therefore passes the first test and
	//    still has the vault's own entry replaced by the report.
	let resolved: string | undefined;
	try {
		resolved = real(target);
	} catch (err) {
		// Not existing yet is the normal case; any other failure (a symlink loop, no permission) is not a clean answer.
		if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
			refuse(
				scrubForTerminal(
					String((err as NodeJS.ErrnoException | undefined)?.code ?? "unresolvable"),
				),
			);
		}
	}
	let entry: string;
	try {
		entry = join(real(dirname(target)), basename(target));
	} catch (err) {
		entry = target;
		refuse(
			`its directory could not be resolved: ${scrubForTerminal(String((err as NodeJS.ErrnoException | undefined)?.code ?? "unresolvable"))}`,
		);
	}
	const hit =
		resolved !== undefined && inside(resolved) ? resolved : inside(entry) ? entry : undefined;
	if (hit !== undefined) {
		throw new UsageError(
			`--out resolves inside the vault (${scrubForTerminal(hit)}): the report is never written into the audit data it reads`,
		);
	}
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

export async function run(rootDir?: string, opts?: CliOptions, args?: string[]): Promise<void> {
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
		// The verdict is `usertrust verify`'s own, on the LIVE vault: integrity AND completeness, one function shared with that
		// command (audit/complete.ts). The report makes no integrity claim of its own. The instant is taken before the read.
		const readAtIso = new Date().toISOString();
		const complete = verifyVaultComplete(vaultPath);
		const { result } = complete.reading;
		// The figures come from the events the verifier walked, never from a second read of the log.
		const events = complete.reading.events;
		const verified = complete.valid;
		// A config that cannot be read makes the budget UNKNOWN, not the chain unverified: the verifier does not read it.
		const config = readSideFile(join(vaultPath, "usertrust.config.json"));
		const configUnreadable = config.state === "unreadable";
		const dead = complete.deadLetters;
		// Shortfall amounts are usable only from a queue read cleanly: an unreadable queue, an unreadable line or a
		// shortfall that is not one leaves the headless proven figure an upper bound.
		const deadLetters = deadLettersForReport(dead);
		const model = buildWeeklyReport(
			events,
			{
				verified,
				errors: complete.errors,
				chainLength: result.chainLength,
				firstEvent: result.firstEvent,
				lastEvent: result.lastEvent,
				readAtIso,
			},
			{
				endMs: parsed.endMs,
				agentKey: parsed.agentKey,
				...(parsed.segment !== undefined ? { segment: parsed.segment } : {}),
				topN: parsed.top,
				budget:
					parsed.budget !== undefined || parsed.tenantConfig !== undefined
						? budget
						: config.state === "file"
							? readVaultBudgetText(config.text)
							: 0,
				budgetSource,
				spendLedger: readSpendLedger(join(vaultPath, "spend-ledger.json")),
				deadLetters,
				// An unreadable config is an UNKNOWN budget, never "no budget configured".
				budgetUnreadable:
					configUnreadable && parsed.budget === undefined && parsed.tenantConfig === undefined,
			},
		);
		const text = render(model, parsed.format);
		if (parsed.out !== undefined) {
			const target = resolve(root, parsed.out);
			assertOutsideVault(target, vaultPath);
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
		fail(err instanceof Error ? err.message : String(err), err instanceof UsageError ? 2 : 1);
	}
}
