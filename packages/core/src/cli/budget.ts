// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust budget — read one cost center's balance and runway
 *
 * `usertrust budget --cost-center <name> --allocated <int> [--period-start <iso>]
 * [--period-end <iso>] [--json]`
 *
 * EXPLICIT COST CENTER, NEVER ENUMERATION. There is no cost-center registry: a
 * cost center exists only as a derived sub-wallet, so "list every cost center" is
 * unanswerable from the ledger alone — an unfunded name and a typo are the same
 * observable state. Both the name and the allocation are therefore required, and
 * a missing one is a usage error rather than a default. Discovery waits for a
 * registry to discover from.
 *
 * `--allocated` IS AN INPUT, NOT A LOOKUP. It is what the caller believes it
 * granted; the balance is what the ledger actually holds. This command reports
 * the second against the first, which is exactly why a wrong `--allocated`
 * yields a wrong `spent` and a wrong runway rather than an error.
 *
 * NO PERIOD START MEANS NO WINDOW. Without `--period-start` the elapsed window is
 * zero by construction, so the burn rate is 0 and there is no projection. That is
 * the honest answer to "how fast is this burning?" from a caller who has not said
 * when the period began; inventing a window (midnight, process start) would
 * fabricate a rate. See the projection-honesty note on `Runway` — the estimate is
 * a naive linear extrapolation and must not drive irreversible decisions.
 *
 * IDENTITY. The parent wallet is `$USERTRUST_USER_ID`, defaulting to `local`.
 * The derived cost-center id is deliberately absent from the output: the payload
 * carries no ledger account ids, no vault paths, and no chain metadata, so it is
 * safe to hand an agent verbatim as the result of a `get_budget()` tool call.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { type BudgetStatus, getBudgetStatus } from "../budget/allocation.js";
import { loadConfig } from "../config.js";
import { TrustTBClient } from "../ledger/client.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { CliOptions } from "./init.js";

const USAGE =
	"Usage: usertrust budget --cost-center <name> --allocated <int> [--period-start <iso>] [--period-end <iso>] [--json]";

/** Parent wallet the cost center hangs off, when the environment does not name one. */
const DEFAULT_PARENT_USER_ID = "local";

const KNOWN_BUDGET_FLAGS = new Set([
	// Global flags main.ts passes to every subcommand — rejecting them here would
	// break `usertrust budget ... --json`, which main.ts forwards verbatim.
	"--json",
	"--skip-verify",
	"--reconfigure",
	// Budget flags.
	"--cost-center",
	"--allocated",
	"--period-start",
	"--period-end",
]);

interface BudgetFlags {
	costCenter: string;
	allocated: number;
	periodStartMs: number | undefined;
	periodEndMs: number | undefined;
}

/** Longest argv value echoed back in an error; the rest is dropped. */
const MAX_ECHOED_LENGTH = 120;

/**
 * Make an argv value safe to echo into the operator's terminal.
 *
 * Every "invalid value" message below quotes what the caller passed, and the
 * caller may be an agent. picocolors wraps a string in SGR codes but does not
 * sanitize it, so `--allocated $'\x1b]0;pwned\x07\x1b[2J'` would emit a real OSC
 * title-set and a screen-clear into the terminal of whoever ran the command.
 * C0 controls, DEL, and the C1 range collapse to `?`, and an over-long value is
 * truncated so a megabyte of argv cannot flood the screen either.
 *
 * Only the human branch needs this — `JSON.stringify` escapes control characters
 * itself — but the sweep happens where the message is built, so both branches
 * carry the same sanitized text.
 */
function forDisplay(raw: string): string {
	let out = "";
	for (const ch of raw) {
		const code = ch.codePointAt(0) as number;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "?" : ch;
	}
	return out.length > MAX_ECHOED_LENGTH ? `${out.slice(0, MAX_ECHOED_LENGTH)}...` : out;
}

/**
 * Take a flag's value, refusing the flag that follows it.
 *
 * `--cost-center --allocated 5` would otherwise bind `--allocated` as the cost
 * center: it matches the cost-center charset, so the derivation accepts it and
 * the command silently reads a wallet nobody named.
 */
function requireValue(flag: string, raw: string | undefined): string {
	if (raw === undefined || raw.startsWith("--")) throw new Error(`${flag} requires a value`);
	return raw;
}

function parseAllocated(raw: string): number {
	const value = Number.parseInt(raw, 10);
	// parseInt("1O0") === 1 (partial parse, capital O) and NaN comparisons are
	// always false — either typo would quietly report a budget nobody granted.
	// Require the WHOLE value to be a non-negative integer.
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
		throw new Error(`Invalid --allocated: ${forDisplay(raw)} (non-negative integer required)`);
	}
	return value;
}

/**
 * Full ISO-8601 date, optionally with a time, and optionally with an offset.
 *
 * `Date.parse` is far looser than "ISO-8601": it reads `1000` as the year 1000,
 * `Dec 25` as this year's Christmas, and pads whitespace away. A typo'd
 * `--period-start 1000` therefore stretches the elapsed window by a millennium
 * and turns a real 180 UT/h burn into 1e-4 UT/h — a governance read that
 * fails open, the same bug class as the `parseInt("1O0")` one above. Requiring
 * the shape as well as parseability is what makes the flag mean what it says.
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function parseIsoMs(flag: string, raw: string): number {
	const ms = Date.parse(raw);
	if (!ISO_8601.test(raw) || !Number.isFinite(ms)) {
		throw new Error(
			`Invalid ${flag}: ${forDisplay(raw)} (ISO-8601 timestamp required, e.g. 2026-07-27T09:00:00Z)`,
		);
	}
	return ms;
}

/**
 * Parse `--period-start`, refusing a start that has not happened yet.
 *
 * The elapsed window is `max(0, now - start)`, so a future start makes it zero,
 * and a zero window reports a burn rate of 0 UT/h with no projection. A cost
 * center burning hard would read as idle. A start in the future is a typo, not
 * a window.
 */
function parsePeriodStartMs(raw: string, nowMs: number): number {
	const ms = parseIsoMs("--period-start", raw);
	if (ms > nowMs) {
		throw new Error(
			`Invalid --period-start: ${forDisplay(raw)} is in the future (it would report a zero burn rate)`,
		);
	}
	return ms;
}

function parseBudgetFlags(argv: string[], nowMs: number): BudgetFlags {
	let costCenter: string | undefined;
	let allocated: number | undefined;
	let periodStartMs: number | undefined;
	let periodEndMs: number | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		const next = (): string | undefined => argv[++i];
		if (arg === "--cost-center") costCenter = requireValue(arg, next());
		else if (arg === "--allocated") allocated = parseAllocated(requireValue(arg, next()));
		else if (arg === "--period-start")
			periodStartMs = parsePeriodStartMs(requireValue(arg, next()), nowMs);
		else if (arg === "--period-end") periodEndMs = parseIsoMs(arg, requireValue(arg, next()));
		else if (arg.startsWith("--") && !KNOWN_BUDGET_FLAGS.has(arg)) {
			// Reject unknown flags rather than ignoring them — a typoed --allocted
			// must not silently report the runway of an allocation nobody set.
			throw new Error(`Unknown flag: ${forDisplay(arg)}`);
		}
	}

	const missing: string[] = [];
	if (costCenter === undefined) missing.push("--cost-center");
	if (allocated === undefined) missing.push("--allocated");
	if (costCenter === undefined || allocated === undefined) {
		throw new Error(`Missing required flag(s): ${missing.join(", ")}. ${USAGE}`);
	}

	return { costCenter, allocated, periodStartMs, periodEndMs };
}

/**
 * An epoch-ms projection on its way to a terminal.
 *
 * `new Date(ms).toISOString()` throws RangeError outside ±8.64e15 ms, and a large
 * balance against a near-zero burn rate lands there routinely. Printing the raw
 * number beats crashing a read-only command over a projection it already
 * describes as noisy.
 */
function formatExhaustion(ms: number | null): string {
	if (ms === null) return "not projectable";
	return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : `${ms} ms`;
}

function field(label: string, value: string): string {
	return `  ${`${label}:`.padEnd(22)}${value}`;
}

export async function run(rootDir?: string, opts?: CliOptions, args?: string[]): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);
	const json = opts?.json === true;

	// Use process.exitCode (not process.exit) so buffered stdout flushes.
	const fail = (message: string, humanMessage?: string): void => {
		if (json) {
			console.log(JSON.stringify({ command: "budget", success: false, data: { message } }));
		} else {
			console.log(humanMessage ?? pc.red(message));
		}
		process.exitCode = 1;
	};

	// Read once, before parsing: `--period-start` is validated against it and the
	// same instant is the `nowMs` the runway is computed from.
	const nowMs = Date.now();

	let flags: BudgetFlags;
	try {
		flags = parseBudgetFlags(args ?? process.argv.slice(2), nowMs);
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
		return;
	}

	if (!existsSync(vaultPath)) {
		fail(
			"No trust vault found. Run `usertrust init` first.",
			`${pc.red("No trust vault found.")} Run \`usertrust init\` first.`,
		);
		return;
	}

	let tb: TrustTBClient | undefined;
	let status: BudgetStatus;
	try {
		const config = await loadConfig(undefined, root);
		tb = new TrustTBClient({
			addresses: config.tigerbeetle.addresses,
			clusterId: BigInt(config.tigerbeetle.clusterId),
		});
		status = await getBudgetStatus(tb, {
			parentUserId: process.env.USERTRUST_USER_ID ?? DEFAULT_PARENT_USER_ID,
			costCenter: flags.costCenter,
			allocated: flags.allocated,
			// No --period-start means a zero-length window, hence a zero burn rate.
			periodStartMs: flags.periodStartMs ?? nowMs,
			...(flags.periodEndMs !== undefined ? { periodEndMs: flags.periodEndMs } : {}),
			nowMs,
		});
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
		return;
	} finally {
		tb?.destroy();
	}

	const { balance, runway } = status;
	// `spent` is derived, not stored: the ledger holds a balance, and what was
	// spent is whatever the caller's allocation no longer covers. Clamped for the
	// same reason getBudgetStatus clamps it — an over-funded cost center must not
	// report negative spend.
	const spent = Math.max(0, flags.allocated - balance);

	if (json) {
		console.log(
			JSON.stringify({
				command: "budget",
				success: true,
				data: {
					costCenter: flags.costCenter,
					balance,
					allocated: flags.allocated,
					spent,
					remaining: runway.remaining,
					fractionRemaining: runway.fractionRemaining,
					burnRatePerHour: runway.burnRatePerHour,
					projectedExhaustionMs: runway.projectedExhaustionMs,
					onPace: runway.onPace,
				},
			}),
		);
		return;
	}

	const pct = (runway.fractionRemaining * 100).toFixed(1);
	console.log(`${pc.bold("Cost center:")} ${flags.costCenter}`);
	console.log(field("Allocated", `${flags.allocated} UT`));
	console.log(field("Spent", `${spent} UT`));
	console.log(field("Balance", `${balance} UT`));
	console.log(field("Remaining", `${runway.remaining} UT (${pct}%)`));
	console.log(field("Burn rate", `${runway.burnRatePerHour.toFixed(2)} UT/hour`));
	console.log(field("Projected exhaustion", formatExhaustion(runway.projectedExhaustionMs)));
	console.log(field("On pace", runway.onPace === null ? "n/a" : runway.onPace ? "yes" : "no"));
}
