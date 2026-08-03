// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust budget — read one cost center's balance and runway
 *
 * `usertrust budget --cost-center <name> --allocated <int> [--parent <id>]
 * [--period-start <iso>] [--period-end <iso>] [--json]`
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
 * IDENTITY. The parent wallet is `--parent`, else `$USERTRUST_USER_ID`, else
 * `local`, and the resolved id is echoed in both output branches. It has to be:
 * a cost center read against the wrong parent is not an error but an implicit
 * zero balance (see `costCenterBalance`), so an unseen parent turns a funded cost
 * center into a confident "Balance: 0 UT". The DERIVED cost-center id stays
 * absent from the output — the payload carries no ledger account ids, no vault
 * paths, and no chain metadata, so it is safe to hand an agent verbatim as the
 * result of a `get_budget()` tool call.
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
	"Usage: usertrust budget --cost-center <name> --allocated <int> [--parent <id>] [--period-start <iso>] [--period-end <iso>] [--json]";

/** Parent wallet the cost center hangs off, when neither the flag nor the environment names one. */
const DEFAULT_PARENT_USER_ID = "local";

/** Environment fallback for the parent wallet, overridden by `--parent`. */
const PARENT_ENV_VAR = "USERTRUST_USER_ID";

const KNOWN_BUDGET_FLAGS = new Set([
	// Global flags main.ts passes to every subcommand — rejecting them here would
	// break `usertrust budget ... --json`, which main.ts forwards verbatim.
	"--json",
	"--skip-verify",
	"--reconfigure",
	// Budget flags.
	"--cost-center",
	"--parent",
	"--allocated",
	"--period-start",
	"--period-end",
]);

interface BudgetFlags {
	parentUserId: string;
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
 *
 * A SINGLE dash is refused for the same reason: `-x` also matches the wallet
 * charset, so `--parent -x` would read `-x::research` rather than reject a
 * dropped dash. `-cc-` IS a legal cost center, so the refusal costs reach —
 * hence `--flag=value`, which binds unambiguously and is the way to name one.
 * The message says so rather than leaving the operator to guess.
 */
function requireValue(flag: string, raw: string | undefined, inline: boolean): string {
	if (raw === undefined || raw === "") throw new Error(`${flag} requires a value`);
	if (!inline && raw.startsWith("-")) {
		throw new Error(`${flag} requires a value (write ${flag}=${raw} to pass it literally)`);
	}
	return raw;
}

/**
 * Mirrors PARENT_USER_ID_PATTERN in shared/ids.ts, which stays authoritative —
 * `costCenterUserId` still rejects anything this misses. Checking here buys only
 * the message: the deep check can quote nothing but its own regex, which is noise
 * to an operator who never set the value it is complaining about. Kept honest by
 * a source-parity test in tests/cli/budget.test.ts.
 */
const PARENT_USER_ID = /^[a-zA-Z0-9._@:-]{1,128}$/;

function parseParent(source: string, raw: string): string {
	if (!PARENT_USER_ID.test(raw)) {
		throw new Error(
			`Invalid ${source}: ${forDisplay(raw)} (1-128 characters, letters/digits/. _ @ : - only)`,
		);
	}
	return raw;
}

/**
 * Resolve the parent wallet: `--parent`, else the environment, else `local`.
 *
 * An environment variable set to the empty string — `export USERTRUST_USER_ID=$UNSET`
 * in a container entrypoint — means the operator named no parent, so it takes the
 * documented default. Passing "" through (as `??` does, since it substitutes for
 * null/undefined only) fails the derivation instead, quoting an id charset at
 * someone who never set an id.
 */
function resolveParentUserId(fromFlag: string | undefined): string {
	if (fromFlag !== undefined) return fromFlag;
	const fromEnv = process.env[PARENT_ENV_VAR];
	if (fromEnv === undefined || fromEnv.trim() === "") return DEFAULT_PARENT_USER_ID;
	// Deliberately validated untrimmed: ` acct_42 ` is a different wallet from
	// `acct_42`, and quietly trimming into the second one is how a read lands on
	// a wallet nobody named.
	return parseParent(`$${PARENT_ENV_VAR}`, fromEnv);
}

function parseAllocated(raw: string): number {
	const value = Number.parseInt(raw, 10);
	// parseInt("1O0") === 1 (partial parse, capital O) and NaN comparisons are
	// always false — either typo would quietly report a budget nobody granted.
	// Require the WHOLE value to be an integer, and a POSITIVE one: 0 sends
	// computeRunway down its `allocated <= 0` branch, which reports
	// fractionRemaining 0 and projects exhaustion at `now`, so a cost center
	// holding 750 UT prints "Balance: 750 UT" over "Remaining: 0 UT (0.0%)" and
	// an exhaustion date of this instant — a report that contradicts itself.
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`Invalid --allocated: ${forDisplay(raw)} (positive integer required)`);
	}
	return value;
}

/**
 * A full ISO-8601 INSTANT: date, time, and an explicit UTC offset. Nothing looser.
 *
 * `Date.parse` is far looser than "ISO-8601": it reads `1000` as the year 1000,
 * `0` as 1 January 2000, `5` as May 2001, `Dec 25` as this year's Christmas, and
 * pads whitespace away. A `--period-start 0` meant as "the start of the period"
 * therefore opens a ~26-year window and turns a real 450-UT-in-an-hour burn into
 * 0.00 UT/hour with an exhaustion date centuries out — a governance read that
 * fails open, the same bug class as the `parseInt("1O0")` one above.
 *
 * The offset is REQUIRED and a bare date is refused because both are silently
 * wrong rather than loudly wrong: a zone-less datetime is read in the HOST's
 * timezone and a bare date at UTC midnight, so one string names two different
 * instants on two machines and the window it opens is off by up to a day — which
 * scales the burn rate by the same factor.
 */
const ISO_8601_INSTANT =
	/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Whether `year-month-day` is a date that exists.
 *
 * `Date.parse` rolls an impossible day over instead of failing: 2026-02-30 comes
 * back as 2 March, a window silently two days wider than the one asked for. An
 * out-of-range month, time, or offset needs no check here — for those it does
 * return NaN.
 */
function isRealDate(year: number, month: number, day: number): boolean {
	if (!Number.isInteger(month) || month < 1 || month > 12) return false;
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const maxDay = month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
	return day >= 1 && day <= maxDay;
}

function parseIsoMs(flag: string, raw: string): number {
	const parts = ISO_8601_INSTANT.exec(raw);
	// The space separator is normalized to `T` so the value is read by the spec's
	// ISO parser rather than by V8's legacy heuristics; the shape is already fixed
	// by the match, so the substitution is exact.
	const ms = parts === null ? Number.NaN : Date.parse(raw.replace(" ", "T"));
	if (
		parts === null ||
		!isRealDate(Number(parts[1]), Number(parts[2]), Number(parts[3])) ||
		!Number.isFinite(ms)
	) {
		throw new Error(
			`Invalid ${flag}: ${forDisplay(raw)} (ISO-8601 instant with an explicit timezone required, e.g. 2026-07-27T09:00:00Z)`,
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
	let parent: string | undefined;
	let costCenter: string | undefined;
	let allocated: number | undefined;
	// The raw text travels with the parsed value so the cross-check below can quote
	// the bounds back in the form the caller typed them.
	let periodStart: { raw: string; ms: number } | undefined;
	let periodEnd: { raw: string; ms: number } | undefined;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string;
		// `--flag=value` is split here so the rest of the loop sees one shape. The
		// inline form is the only way to pass a value beginning with `-`: bound by
		// `=`, it cannot be a dropped dash, so `requireValue`'s refusal is lifted.
		const eq = token.startsWith("--") ? token.indexOf("=") : -1;
		const arg = eq > 2 ? token.slice(0, eq) : token;
		const inline = eq > 2 ? token.slice(eq + 1) : undefined;
		const next = (): string =>
			inline === undefined ? requireValue(arg, argv[++i], false) : requireValue(arg, inline, true);
		if (arg === "--cost-center") costCenter = next();
		else if (arg === "--parent") parent = parseParent(arg, next());
		else if (arg === "--allocated") allocated = parseAllocated(next());
		else if (arg === "--period-start") {
			const raw = next();
			periodStart = { raw, ms: parsePeriodStartMs(raw, nowMs) };
		} else if (arg === "--period-end") {
			const raw = next();
			periodEnd = { raw, ms: parseIsoMs(arg, raw) };
		} else if (!KNOWN_BUDGET_FLAGS.has(arg)) {
			// Reject EVERYTHING unrecognised, not just `--`-prefixed: a dropped dash
			// (`-period-start 2026-07-01T00:00:00Z`) matches no comparison above, and
			// falling through drops its VALUE on the next iteration too — the window
			// then defaults to now and the command exits 0 reporting a 0.00 UT/hour
			// burn, which is exactly what this guard exists to prevent. A bare
			// positional is the same failure with no dash at all.
			throw new Error(
				arg.startsWith("-")
					? `Unknown flag: ${forDisplay(arg)}. ${USAGE}`
					: `Unexpected argument: ${forDisplay(arg)}. ${USAGE}`,
			);
		}
	}

	const missing: string[] = [];
	if (costCenter === undefined) missing.push("--cost-center");
	if (allocated === undefined) missing.push("--allocated");
	if (costCenter === undefined || allocated === undefined) {
		throw new Error(`Missing required flag(s): ${missing.join(", ")}. ${USAGE}`);
	}

	// An end at or before the start is DISCARDED downstream — computeRunway keeps a
	// period end only when it is strictly after the start — and `onPace` comes back
	// null, printing "n/a": indistinguishable from a legitimately open-ended
	// allocation. Swapped bounds must fail instead, because "unknown" is the one
	// answer the flag was passed to rule out. Without `--period-start` the window
	// opens at `now`, so that is the bound the end has to clear.
	if (periodEnd !== undefined) {
		const startMs = periodStart?.ms ?? nowMs;
		if (periodEnd.ms <= startMs) {
			throw new Error(
				periodStart === undefined
					? `Invalid --period-end: ${forDisplay(periodEnd.raw)} is not after now, and no --period-start was given`
					: `Invalid --period-end: ${forDisplay(periodEnd.raw)} is not after --period-start ${forDisplay(periodStart.raw)}`,
			);
		}
	}

	return {
		parentUserId: resolveParentUserId(parent),
		costCenter,
		allocated,
		periodStartMs: periodStart?.ms,
		periodEndMs: periodEnd?.ms,
	};
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

/**
 * Argv fallback for a direct `run()` with no explicit args.
 *
 * `main.ts` always passes the already-stripped `rest`, but the bare argv still
 * carries the `budget` subcommand token, which the catch-all unknown-argument
 * guard would reject — the fallback would fail every time it was used.
 */
function processArgs(): string[] {
	const argv = process.argv.slice(2);
	return argv[0] === "budget" ? argv.slice(1) : argv;
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
		flags = parseBudgetFlags(args ?? processArgs(), nowMs);
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
			parentUserId: flags.parentUserId,
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
					// The wallet the balance was read from. A cost center under the wrong
					// parent reads as an implicit 0, so `balance` cannot be checked by a
					// caller who cannot see which wallet produced it.
					parent: flags.parentUserId,
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
	console.log(field("Parent wallet", flags.parentUserId));
	console.log(field("Allocated", `${flags.allocated} UT`));
	console.log(field("Spent", `${spent} UT`));
	console.log(field("Balance", `${balance} UT`));
	console.log(field("Remaining", `${runway.remaining} UT (${pct}%)`));
	console.log(field("Burn rate", `${runway.burnRatePerHour.toFixed(2)} UT/hour`));
	console.log(field("Projected exhaustion", formatExhaustion(runway.projectedExhaustionMs)));
	console.log(field("On pace", runway.onPace === null ? "n/a" : runway.onPace ? "yes" : "no"));
}
