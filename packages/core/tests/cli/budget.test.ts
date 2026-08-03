// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: `usertrust budget` — flag validation, exit codes, and output shape.
 *
 * TigerBeetle is mocked at module level (the pattern in tests/ledger/engine.test.ts
 * and tests/budget/allocation.test.ts). The command drives the real TrustTBClient
 * and the real getBudgetStatus; only the network driver is faked. What these tests
 * assert is therefore the payload the command actually emits rather than a
 * restatement of it.
 *
 * Only `Date` is faked. Faking setTimeout as well would risk hanging on the fs
 * promises `loadConfig` awaits, and nothing on this path waits for a timer.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Fake ledger state, mutated per test before the command runs. */
const ledger = vi.hoisted(() => ({
	/** Empty means the cost-center wallet does not exist — an implicit zero balance. */
	accounts: [] as Array<{ credits_posted: bigint; debits_posted: bigint; debits_pending: bigint }>,
}));

vi.mock("tigerbeetle-node", () => ({
	createClient: () => ({
		lookupAccounts: async () => ledger.accounts,
		createAccounts: async () => [],
		createTransfers: async () => [],
		lookupTransfers: async () => [],
		destroy: () => {},
	}),
	AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
	TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
	CreateAccountStatus: { created: 4294967295, exists: 1, exists_with_different_flags: 2 },
	CreateTransferStatus: {
		created: 4294967295,
		exceeds_credits: 22,
		overflows_debits: 30,
		overflows_debits_pending: 31,
	},
	amount_max: (1n << 128n) - 1n,
}));

import { run } from "../../src/cli/budget.js";
import { COMMANDS } from "../../src/cli/main.js";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const FIVE_HOURS_AGO = new Date(NOW - 5 * HOUR).toISOString();

/**
 * The exact payload contract from plan delta D12, sorted. Asserting the whole key
 * set — not just the presence of each field — is what stops a ledger account id or
 * a vault path from leaking into a payload an agent is handed.
 */
const DATA_KEYS = [
	"allocated",
	"balance",
	"burnRatePerHour",
	"costCenter",
	"fractionRemaining",
	"onPace",
	"parent",
	"projectedExhaustionMs",
	"remaining",
	"spent",
];

let tempDir: string;
let logOutput: string[];
/** Restored per test: the parent wallet falls back to this variable, so a real one leaks in. */
let savedParentEnv: string | undefined;

function makeVault(): void {
	mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
	writeFileSync(
		join(tempDir, ".usertrust", "usertrust.config.json"),
		JSON.stringify({
			budget: 50_000,
			tigerbeetle: { addresses: ["127.0.0.1:3001"], clusterId: 0 },
		}),
		"utf-8",
	);
}

function setBalance(available: number): void {
	ledger.accounts = [{ credits_posted: BigInt(available), debits_posted: 0n, debits_pending: 0n }];
}

function jsonOut(): { command: string; success: boolean; data: Record<string, unknown> } {
	const line = logOutput.find((l) => l.startsWith("{"));
	expect(line).toBeDefined();
	return JSON.parse(line as string);
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "trust-budget-cli-"));
	logOutput = [];
	ledger.accounts = [];
	savedParentEnv = process.env.USERTRUST_USER_ID;
	delete process.env.USERTRUST_USER_ID;
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logOutput.push(args.map(String).join(" "));
	});
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	// process.exitCode is undefined until something sets it; pin it so "still 0"
	// is a real assertion that the command reported success.
	process.exitCode = 0;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (savedParentEnv === undefined) delete process.env.USERTRUST_USER_ID;
	else process.env.USERTRUST_USER_ID = savedParentEnv;
	// The command sets process.exitCode on a failure verdict; reset it so a
	// deliberate failure does not leak into the vitest worker's own exit code.
	process.exitCode = 0;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("usertrust budget — JSON payload", () => {
	it("emits exactly the documented fields and the runway they describe", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: true }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--period-start",
			FIVE_HOURS_AGO,
		]);

		const out = jsonOut();
		expect(out.command).toBe("budget");
		expect(out.success).toBe(true);
		expect(Object.keys(out.data).sort()).toEqual(DATA_KEYS);
		expect(out.data.costCenter).toBe("research");
		expect(out.data.balance).toBe(750);
		expect(out.data.allocated).toBe(1000);
		expect(out.data.spent).toBe(250);
		expect(out.data.remaining).toBe(750);
		expect(out.data.fractionRemaining).toBeCloseTo(0.75);
		expect(out.data.burnRatePerHour).toBeCloseTo(50);
		expect(out.data.projectedExhaustionMs).toBe(NOW + 15 * HOUR);
		expect(out.data.onPace).toBeNull();
		expect(process.exitCode).toBe(0);
	});

	it("reads a never-allocated cost center as an implicit zero balance", async () => {
		makeVault();
		// ledger.accounts stays empty — the wallet was never created.

		await run(tempDir, { json: true }, [
			"--cost-center",
			"never-funded",
			"--allocated",
			"1000",
			"--period-start",
			FIVE_HOURS_AGO,
		]);

		const out = jsonOut();
		expect(out.success).toBe(true);
		expect(out.data.balance).toBe(0);
		expect(out.data.spent).toBe(1000);
		expect(out.data.remaining).toBe(0);
		expect(out.data.fractionRemaining).toBe(0);
		// Already exhausted projects to now, not to a future estimate.
		expect(out.data.projectedExhaustionMs).toBe(NOW);
		expect(process.exitCode).toBe(0);
	});

	it("reports zero burn and no projection when no period start is supplied", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: true }, ["--cost-center", "research", "--allocated", "1000"]);

		const out = jsonOut();
		expect(out.success).toBe(true);
		expect(out.data.burnRatePerHour).toBe(0);
		expect(out.data.projectedExhaustionMs).toBeNull();
		expect(out.data.onPace).toBeNull();
	});

	it("flags on-pace against a bounded period in both directions", async () => {
		makeVault();
		const periodEnd = new Date(NOW + 24 * HOUR).toISOString();

		setBalance(990); // spent 10 over 5h => 2 UT/h, 990 remaining => 495h of runway
		await run(tempDir, { json: true }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--period-start",
			FIVE_HOURS_AGO,
			"--period-end",
			periodEnd,
		]);
		expect(jsonOut().data.onPace).toBe(true);

		logOutput = [];
		setBalance(500); // spent 500 over 5h => 100 UT/h, 500 remaining => 5h of runway
		await run(tempDir, { json: true }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--period-start",
			FIVE_HOURS_AGO,
			"--period-end",
			periodEnd,
		]);
		expect(jsonOut().data.onPace).toBe(false);
	});
});

describe("usertrust budget — flag validation", () => {
	it("rejects an unknown flag before it ever looks for a vault", async () => {
		// No vault in tempDir: a typo must fail as a typo, not as a missing vault.
		await run(tempDir, { json: false }, ["--cost-centre", "research", "--allocated", "1000"]);

		expect(logOutput.join("\n")).toMatch(/Unknown flag: --cost-centre/);
		expect(logOutput.join("\n")).not.toMatch(/usertrust init/);
		expect(process.exitCode).toBe(1);
	});

	// A dropped dash matches no comparison in the parser, and letting it fall
	// through drops its VALUE on the next iteration too: the window would default
	// to now and the command would exit 0 reporting a 0.00 UT/hour burn.
	it("rejects a single-dash flag instead of dropping it and its value", async () => {
		makeVault();
		setBalance(500);

		await run(tempDir, { json: false }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"-period-start",
			FIVE_HOURS_AGO,
		]);

		expect(logOutput.join("\n")).toMatch(/Unknown flag: -period-start/);
		expect(logOutput.join("\n")).not.toMatch(/Burn rate/);
		expect(process.exitCode).toBe(1);
	});

	it("rejects a bare positional argument", async () => {
		makeVault();
		setBalance(500);

		await run(tempDir, { json: false }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"research",
		]);

		expect(logOutput.join("\n")).toMatch(/Unexpected argument: research/);
		expect(logOutput.join("\n")).toMatch(/Usage: usertrust budget/);
		expect(logOutput.join("\n")).not.toMatch(/Burn rate/);
		expect(process.exitCode).toBe(1);
	});

	it("accepts the global flags main.ts passes to every subcommand", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: true }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--json",
			"--skip-verify",
			"--reconfigure",
		]);

		expect(jsonOut().success).toBe(true);
		expect(process.exitCode).toBe(0);
	});

	it("requires --cost-center and --allocated, naming what is missing", async () => {
		makeVault();

		await run(tempDir, { json: false }, ["--allocated", "1000"]);
		expect(logOutput.join("\n")).toMatch(/--cost-center/);
		expect(logOutput.join("\n")).toMatch(/Usage: usertrust budget/);
		expect(process.exitCode).toBe(1);

		logOutput = [];
		process.exitCode = 0;
		await run(tempDir, { json: false }, ["--cost-center", "research"]);
		expect(logOutput.join("\n")).toMatch(/--allocated/);
		expect(process.exitCode).toBe(1);
	});

	it("rejects an --allocated value that is not a whole non-negative integer", async () => {
		makeVault();
		// "1O0" is a capital O: parseInt partial-parses it to 1, which would silently
		// report a 1 UT allocation as if the caller had asked for it.
		for (const bad of [
			"1O0",
			"1.5",
			"-5",
			"1e3",
			" 12",
			"12 ",
			"",
			"0x10",
			"99999999999999999999",
		]) {
			logOutput = [];
			process.exitCode = 0;
			await run(tempDir, { json: false }, ["--cost-center", "research", "--allocated", bad]);
			expect(logOutput.join("\n")).toMatch(/--allocated/);
			expect(process.exitCode).toBe(1);
		}
	});

	// 0 sends computeRunway down its `allocated <= 0` branch: fractionRemaining 0
	// and an exhaustion projection of "now". Against a cost center holding 750 UT
	// the report contradicts itself — "Balance: 750 UT" over "Remaining: 0 UT
	// (0.0%)" and an exhaustion date of this instant.
	it("rejects a zero --allocated rather than reporting an exhausted budget", async () => {
		makeVault();
		setBalance(750);

		for (const bad of ["0", "00", "0000"]) {
			logOutput = [];
			process.exitCode = 0;
			await run(tempDir, { json: false }, ["--cost-center", "research", "--allocated", bad]);
			expect(logOutput.join("\n")).toMatch(/Invalid --allocated/);
			expect(logOutput.join("\n")).toMatch(/positive integer/);
			expect(logOutput.join("\n")).not.toMatch(/Balance/);
			expect(process.exitCode).toBe(1);
		}
	});

	it("rejects a period bound that Date.parse cannot read", async () => {
		makeVault();

		for (const flag of ["--period-start", "--period-end"]) {
			logOutput = [];
			process.exitCode = 0;
			await run(tempDir, { json: false }, [
				"--cost-center",
				"research",
				"--allocated",
				"1000",
				flag,
				"yesterday",
			]);
			expect(logOutput.join("\n")).toMatch(new RegExp(`Invalid ${flag}`));
			expect(process.exitCode).toBe(1);
		}
	});

	// Date.parse is far looser than "ISO-8601": it reads "1000" as the year 1000
	// and "Dec 25" as a date. A typo'd --period-start 1000 stretches the elapsed
	// window by a millennium, turning a real 180 UT/h burn into 1e-4 UT/h — a
	// governance read that fails open, exactly like the parseInt("1O0") case.
	it("rejects a period bound that parses but is not a full ISO-8601 timestamp", async () => {
		makeVault();

		for (const flag of ["--period-start", "--period-end"]) {
			for (const bad of [
				"1000",
				"2026",
				"1",
				// Date.parse("0") is 1 Jan 2000 and Date.parse("5") is May 2001 — both
				// finite, so shape is the only thing that catches them. A caller passing
				// `--period-start 0` to mean "the start of the period" would otherwise
				// open a ~26-year window and report a hard burn as 0.00 UT/hour.
				"0",
				"5",
				"Dec 25",
				"Mar 2026",
				"2026-07",
				" 2026-07-27",
				"2026-07-27 ",
				"2026/07/27",
				"07/27/2026",
				// An epoch-ms value is not an ISO-8601 instant, however real it looks.
				"1800000000000",
			]) {
				logOutput = [];
				process.exitCode = 0;
				await run(tempDir, { json: false }, [
					"--cost-center",
					"research",
					"--allocated",
					"1000",
					flag,
					bad,
				]);
				expect(logOutput.join("\n")).toMatch(new RegExp(`Invalid ${flag}`));
				expect(process.exitCode).toBe(1);
			}
		}
	});

	it("accepts the ISO-8601 forms callers actually pass", async () => {
		makeVault();
		setBalance(750);

		for (const good of [
			"2026-07-27T09:00Z",
			"2026-07-27T09:00:00Z",
			"2026-07-27T09:00:00.5Z",
			"2026-07-27T09:00:00.500Z",
			"2026-07-27T09:00:00+02:00",
			"2026-07-27T09:00:00-05:00",
			"2026-07-27 09:00:00Z",
			// 2024 is a leap year; 2026 is not (see the impossible-date cases below).
			"2024-02-29T00:00:00Z",
		]) {
			logOutput = [];
			process.exitCode = 0;
			await run(tempDir, { json: true }, [
				"--cost-center",
				"research",
				"--allocated",
				"1000",
				"--period-start",
				good,
			]);
			expect(jsonOut().success).toBe(true);
			expect(process.exitCode).toBe(0);
		}
	});

	// A zone-less datetime is read in the HOST's timezone and a bare date at UTC
	// midnight, so one string names two different instants on two machines and the
	// window it opens is off by up to a day — which scales the burn rate by the
	// same factor. An instant has to say which zone it is in.
	it("rejects a period bound with no explicit timezone", async () => {
		makeVault();

		for (const flag of ["--period-start", "--period-end"]) {
			for (const bad of [
				"2026-07-27",
				"2026-07-27T09:00",
				"2026-07-27T09:00:00",
				"2026-07-27T09:00:00.500",
			]) {
				logOutput = [];
				process.exitCode = 0;
				await run(tempDir, { json: false }, [
					"--cost-center",
					"research",
					"--allocated",
					"1000",
					flag,
					bad,
				]);
				expect(logOutput.join("\n")).toMatch(new RegExp(`Invalid ${flag}`));
				expect(logOutput.join("\n")).toMatch(/explicit timezone/);
				expect(process.exitCode).toBe(1);
			}
		}
	});

	// Date.parse rolls an impossible day over rather than failing: 2026-02-30 comes
	// back as 2 March, a window silently two days wider than the one asked for.
	it("rejects a period bound naming a date that does not exist", async () => {
		makeVault();

		for (const bad of ["2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z"]) {
			logOutput = [];
			process.exitCode = 0;
			await run(tempDir, { json: false }, [
				"--cost-center",
				"research",
				"--allocated",
				"1000",
				"--period-start",
				bad,
			]);
			expect(logOutput.join("\n")).toMatch(/Invalid --period-start/);
			expect(process.exitCode).toBe(1);
		}
	});

	// A start after now makes the elapsed window zero, so the burn rate is 0 and
	// there is no projection: a hard-burning cost center would read as idle.
	it("rejects a --period-start in the future", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: false }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--period-start",
			new Date(NOW + HOUR).toISOString(),
		]);

		expect(logOutput.join("\n")).toMatch(/Invalid --period-start/);
		expect(logOutput.join("\n")).toMatch(/future/);
		expect(process.exitCode).toBe(1);
	});

	it("accepts a --period-end in the future — a bounded period has not ended yet", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: true }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--period-start",
			FIVE_HOURS_AGO,
			"--period-end",
			new Date(NOW + 24 * HOUR).toISOString(),
		]);

		expect(jsonOut().success).toBe(true);
		expect(process.exitCode).toBe(0);
	});

	// computeRunway keeps a period end only when it is strictly after the start, so
	// swapped bounds are silently DISCARDED and `onPace` prints "n/a" — the same
	// output as a legitimately open-ended allocation, and the one answer the flag
	// was passed to rule out.
	it("rejects a --period-end that is not strictly after --period-start", async () => {
		makeVault();
		setBalance(750);
		const earlier = new Date(NOW - 10 * HOUR).toISOString();

		// Swapped bounds, in both argument orders, plus a zero-length period.
		for (const argv of [
			["--period-start", FIVE_HOURS_AGO, "--period-end", earlier],
			["--period-end", earlier, "--period-start", FIVE_HOURS_AGO],
			["--period-start", FIVE_HOURS_AGO, "--period-end", FIVE_HOURS_AGO],
		]) {
			logOutput = [];
			process.exitCode = 0;
			await run(tempDir, { json: false }, [
				"--cost-center",
				"research",
				"--allocated",
				"1000",
				...argv,
			]);
			expect(logOutput.join("\n")).toMatch(/Invalid --period-end/);
			expect(logOutput.join("\n")).toMatch(/not after --period-start/);
			expect(logOutput.join("\n")).not.toMatch(/On pace/);
			expect(process.exitCode).toBe(1);
		}
	});

	// With no --period-start the window opens at `now`, so a past end is inverted
	// against it and would be discarded just as silently.
	it("rejects a past --period-end when no --period-start was given", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: false }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--period-end",
			FIVE_HOURS_AGO,
		]);

		expect(logOutput.join("\n")).toMatch(/Invalid --period-end/);
		expect(logOutput.join("\n")).toMatch(/no --period-start was given/);
		expect(process.exitCode).toBe(1);
	});

	it("refuses to swallow the next flag as a missing value", async () => {
		makeVault();

		// Without a guard, `--allocated` becomes the cost-center name: it matches the
		// cost-center charset, so it would be accepted as a real name.
		await run(tempDir, { json: false }, ["--cost-center", "--allocated", "1000"]);

		expect(logOutput.join("\n")).toMatch(/--cost-center requires a value/);
		expect(process.exitCode).toBe(1);
	});

	it("rejects a cost-center name outside the derivation charset", async () => {
		makeVault();

		await run(tempDir, { json: false }, ["--cost-center", "team/research", "--allocated", "1000"]);

		expect(logOutput.join("\n")).toMatch(/costCenter must match/);
		expect(process.exitCode).toBe(1);
	});
});

/**
 * The parent wallet decides which account the balance is read from, and reading the
 * wrong one is not an error: `costCenterBalance` reports a wallet that does not
 * exist as an implicit 0 by design. A cost center funded under `acct_42` therefore
 * prints a confident "Balance: 0 UT / Spent: 1000 UT" when the command resolves a
 * different parent — so the parent must be settable, and must be visible in both
 * output branches.
 */
describe("usertrust budget — parent wallet", () => {
	it("defaults to local and says so in both output branches", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: true }, ["--cost-center", "research", "--allocated", "1000"]);
		expect(jsonOut().data.parent).toBe("local");

		logOutput = [];
		await run(tempDir, { json: false }, ["--cost-center", "research", "--allocated", "1000"]);
		expect(logOutput.join("\n")).toMatch(/Parent wallet:\s+local/);
		expect(process.exitCode).toBe(0);
	});

	it("reads the parent from --parent and echoes the resolved id", async () => {
		makeVault();
		setBalance(1000);

		await run(tempDir, { json: true }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--parent",
			"acct_42",
		]);
		expect(jsonOut().data.parent).toBe("acct_42");
		expect(jsonOut().success).toBe(true);

		logOutput = [];
		await run(tempDir, { json: false }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--parent",
			"acct_42",
		]);
		expect(logOutput.join("\n")).toMatch(/Parent wallet:\s+acct_42/);
		expect(process.exitCode).toBe(0);
	});

	// Issue #64: account ids come from the length-prefixed tuple hash
	// `TrustTBClient.deriveCostCenterAccountId`, which no colon on either side of
	// `--parent` can make ambiguous — so the CLI door must admit it, not just the
	// authoritative `PARENT_USER_ID_PATTERN` in shared/ids.ts.
	it("accepts a colon-bearing --parent id", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: true }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--parent",
			"acct:123",
		]);

		const out = jsonOut();
		expect(out.success).toBe(true);
		expect(out.data.parent).toBe("acct:123");
		expect(process.exitCode).toBe(0);
	});

	// The inline `=` form is the only way to pass a value beginning with `-`, but a
	// leading `:` needs no such escape — this exercises the inline form's parsing
	// path specifically (`eq` splitting, `inline` value) with a colon-bearing id.
	it("accepts a colon-bearing --parent id through the inline form", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: true }, [
			"--parent=:x",
			"--cost-center",
			"research",
			"--allocated",
			"1000",
		]);

		const out = jsonOut();
		expect(out.success).toBe(true);
		expect(out.data.parent).toBe(":x");
		expect(process.exitCode).toBe(0);
	});

	it("takes --parent over the environment", async () => {
		makeVault();
		setBalance(750);
		process.env.USERTRUST_USER_ID = "from-env";

		await run(tempDir, { json: true }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--parent",
			"from-flag",
		]);

		expect(jsonOut().data.parent).toBe("from-flag");
		expect(process.exitCode).toBe(0);
	});

	it("falls back to the environment when no --parent is given", async () => {
		makeVault();
		setBalance(750);
		process.env.USERTRUST_USER_ID = "from-env";

		await run(tempDir, { json: true }, ["--cost-center", "research", "--allocated", "1000"]);

		expect(jsonOut().data.parent).toBe("from-env");
		expect(process.exitCode).toBe(0);
	});

	// `export USERTRUST_USER_ID=$SOME_UNSET_VAR` in a container entrypoint sets the
	// variable to "". `??` substitutes for null/undefined only, so the empty string
	// used to reach the derivation and fail there, quoting an internal id charset at
	// an operator who never set the variable.
	it("treats an empty or whitespace-only environment value as unset", async () => {
		makeVault();
		setBalance(750);

		for (const empty of ["", " ", "\t\n"]) {
			logOutput = [];
			process.exitCode = 0;
			process.env.USERTRUST_USER_ID = empty;
			await run(tempDir, { json: true }, ["--cost-center", "research", "--allocated", "1000"]);
			expect(jsonOut().success).toBe(true);
			expect(jsonOut().data.parent).toBe("local");
			expect(process.exitCode).toBe(0);
		}
	});

	it("rejects a --parent outside the wallet-id charset, naming the flag", async () => {
		makeVault();

		await run(tempDir, { json: false }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--parent",
			"acct 42",
		]);

		expect(logOutput.join("\n")).toMatch(/Invalid --parent: acct 42/);
		// The charset in the message must list `:` now that colon-bearing parent ids
		// (issue #64) are admitted — a stale message would send an operator hunting
		// for a character that is actually allowed.
		expect(logOutput.join("\n")).toContain("(1-128 characters, letters/digits/. _ @ : - only)");
		expect(logOutput.join("\n")).not.toMatch(/parentUserId must match/);
		expect(process.exitCode).toBe(1);
	});

	it("rejects a non-empty but invalid environment value, naming the variable", async () => {
		makeVault();
		process.env.USERTRUST_USER_ID = "acct 42";

		await run(tempDir, { json: false }, ["--cost-center", "research", "--allocated", "1000"]);

		expect(logOutput.join("\n")).toMatch(/Invalid \$USERTRUST_USER_ID: acct 42/);
		expect(process.exitCode).toBe(1);
	});

	it("requires a value for --parent rather than swallowing the next flag", async () => {
		makeVault();

		await run(tempDir, { json: false }, ["--parent", "--cost-center", "research"]);

		expect(logOutput.join("\n")).toMatch(/--parent requires a value/);
		expect(process.exitCode).toBe(1);
	});

	// `-x` matches the wallet charset, so a single-dash token would otherwise bind
	// as the parent id and the command would confidently report on `-x::research`.
	it("refuses a single-dash token as the --parent value", async () => {
		makeVault();

		await run(tempDir, { json: false }, ["--parent", "-x", "--cost-center", "research"]);

		expect(logOutput.join("\n")).toMatch(/--parent requires a value/);
		expect(process.exitCode).toBe(1);
	});

	it("refuses a single-dash token as the --cost-center value", async () => {
		makeVault();

		await run(tempDir, { json: false }, ["--cost-center", "-x", "--allocated", "1000"]);

		expect(logOutput.join("\n")).toMatch(/--cost-center requires a value/);
		expect(process.exitCode).toBe(1);
	});

	it("points at the inline form rather than leaving the operator guessing", async () => {
		makeVault();

		await run(tempDir, { json: false }, ["--parent", "-cc-", "--cost-center", "research"]);

		expect(logOutput.join("\n")).toMatch(/write --parent=-cc- to pass it literally/);
		expect(process.exitCode).toBe(1);
	});

	// `-cc-` is a legal parent id and a legal cost center. The space-separated form
	// cannot accept it without also accepting a dropped dash, so `=` is the way in.
	it("accepts a leading-dash parent through --parent=", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: true }, [
			"--parent=-cc-",
			"--cost-center",
			"research",
			"--allocated",
			"1000",
		]);

		const out = jsonOut();
		expect(out.success).toBe(true);
		expect(out.data.parent).toBe("-cc-");
		expect(process.exitCode).toBe(0);
	});

	it("accepts a leading-dash cost center through --cost-center=", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: true }, ["--cost-center=-cc-", "--allocated", "1000"]);

		const out = jsonOut();
		expect(out.success).toBe(true);
		expect(out.data.costCenter).toBe("-cc-");
		expect(process.exitCode).toBe(0);
	});

	it("rejects an inline form with no value", async () => {
		makeVault();

		await run(tempDir, { json: false }, ["--cost-center=", "--allocated", "1000"]);

		expect(logOutput.join("\n")).toMatch(/--cost-center requires a value/);
		expect(process.exitCode).toBe(1);
	});

	it("still rejects an unknown flag written in the inline form", async () => {
		makeVault();

		await run(tempDir, { json: false }, [
			"--nope=1",
			"--cost-center",
			"research",
			"--allocated",
			"1000",
		]);

		expect(logOutput.join("\n")).toMatch(/Unknown flag: --nope/);
		expect(process.exitCode).toBe(1);
	});
});

/**
 * Every "invalid value" message quotes what the caller passed, and the caller may
 * be an agent. picocolors wraps a string in SGR codes but does not sanitize it, so
 * an unsanitized message hands raw OSC/CSI bytes straight to the terminal of
 * whoever ran the command: `\x1b]0;pwned\x07` retitles the window, `\x1b[2J`
 * clears it.
 *
 * The human branch is asserted against the injected sequences rather than
 * against the ESC byte alone: picocolors legitimately emits SGR codes when
 * colour is enabled, and an SGR code is not an injection. The `--json` branch is
 * never colourised, so the stronger "no ESC anywhere" assertion holds outright
 * there.
 */
describe("usertrust budget — terminal safety", () => {
	/** ESC and BEL by name — a raw control byte in a source file is invisible. */
	const ESC = "\u001b";
	const BEL = "\u0007";
	/** An OSC title-set + BEL, a screen clear, and a CSI cursor move. */
	const ESCAPES = `${ESC}]0;pwned${BEL}${ESC}[2J${ESC}[1;1H`;

	/** The injected control sequences, none of which may survive into output. */
	function expectNoInjection(output: string): void {
		expect(output).not.toContain(`${ESC}]`);
		expect(output).not.toContain(`${ESC}[2J`);
		expect(output).not.toContain(`${ESC}[1;1H`);
		expect(output).not.toContain(BEL);
	}

	it("neutralises an OSC/CSI payload in an --allocated value", async () => {
		makeVault();

		await run(tempDir, { json: false }, ["--cost-center", "research", "--allocated", ESCAPES]);

		const combined = logOutput.join("\n");
		expect(combined).toMatch(/Invalid --allocated/);
		expectNoInjection(combined);
		// Swept, not dropped: the operator still sees that something was passed.
		expect(combined).toContain("?");
		expect(process.exitCode).toBe(1);
	});

	// Widening PARENT_USER_ID to admit `:` (issue #64) must not widen it into
	// admitting control bytes: ESC and BEL are still outside the charset, so this
	// still fails validation, and the failure message must still echo through
	// `forDisplay` rather than the raw argv.
	it("neutralises an OSC/CSI payload in a --parent value", async () => {
		makeVault();

		await run(tempDir, { json: false }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--parent",
			ESCAPES,
		]);

		const combined = logOutput.join("\n");
		expect(combined).toMatch(/Invalid --parent/);
		expectNoInjection(combined);
		expect(combined).toContain("?");
		expect(process.exitCode).toBe(1);
	});

	it("neutralises an OSC/CSI payload in a period bound", async () => {
		makeVault();

		for (const flag of ["--period-start", "--period-end"]) {
			logOutput = [];
			process.exitCode = 0;
			await run(tempDir, { json: false }, [
				"--cost-center",
				"research",
				"--allocated",
				"1000",
				flag,
				`2026-07-27${ESCAPES}`,
			]);
			expectNoInjection(logOutput.join("\n"));
			expect(process.exitCode).toBe(1);
		}
	});

	it("neutralises an OSC/CSI payload in an unknown flag", async () => {
		await run(tempDir, { json: false }, [`--${ESCAPES}`, "x"]);

		const combined = logOutput.join("\n");
		expect(combined).toMatch(/Unknown flag/);
		expectNoInjection(combined);
		expect(process.exitCode).toBe(1);
	});

	it("truncates an over-long value instead of flooding the screen", async () => {
		makeVault();

		await run(tempDir, { json: false }, [
			"--cost-center",
			"research",
			"--allocated",
			"9".repeat(5000),
		]);

		const combined = logOutput.join("\n");
		expect(combined).toContain("...");
		expect(combined.length).toBeLessThan(400);
		expect(process.exitCode).toBe(1);
	});

	it("keeps the --json failure branch parseable and escape-free", async () => {
		makeVault();

		await run(tempDir, { json: true }, ["--cost-center", "research", "--allocated", ESCAPES]);

		const line = logOutput.find((l) => l.startsWith("{")) as string;
		const parsed = JSON.parse(line) as {
			command: string;
			success: boolean;
			data: { message: string };
		};
		expect(parsed.command).toBe("budget");
		expect(parsed.success).toBe(false);
		expect(parsed.data.message).toMatch(/Invalid --allocated/);
		// The JSON branch is never colourised, so no ESC byte is legitimate here.
		expect(line).not.toContain(ESC);
		expect(parsed.data.message).not.toContain(ESC);
		expectNoInjection(line);
		expect(process.exitCode).toBe(1);
	});

	it("still round-trips a successful --json payload unchanged", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: true }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--period-start",
			FIVE_HOURS_AGO,
		]);

		const out = jsonOut();
		expect(out.success).toBe(true);
		expect(Object.keys(out.data).sort()).toEqual(DATA_KEYS);
		expect(out.data.costCenter).toBe("research");
	});
});

describe("usertrust budget — human output", () => {
	it("exits 1 with the standard message when no vault is found", async () => {
		await run(tempDir, { json: false }, ["--cost-center", "research", "--allocated", "1000"]);

		expect(logOutput.join("\n")).toMatch(/usertrust init/);
		expect(process.exitCode).toBe(1);
	});

	it("carries every runway field", async () => {
		makeVault();
		setBalance(750);

		await run(tempDir, { json: false }, [
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--period-start",
			FIVE_HOURS_AGO,
		]);

		const combined = logOutput.join("\n");
		expect(combined).toContain("research");
		expect(combined).toMatch(/Allocated:\s+1000 UT/);
		expect(combined).toMatch(/Spent:\s+250 UT/);
		expect(combined).toMatch(/Balance:\s+750 UT/);
		expect(combined).toMatch(/Remaining:\s+750 UT \(75\.0%\)/);
		expect(combined).toMatch(/Burn rate:\s+50\.00 UT\/hour/);
		expect(combined).toContain(new Date(NOW + 15 * HOUR).toISOString());
		expect(combined).toMatch(/On pace:/);
		expect(process.exitCode).toBe(0);
	});

	it("prints raw milliseconds when the projection falls outside Date range", async () => {
		makeVault();
		// 1 UT spent over 5h against a near-max remaining balance projects ~3e22 ms
		// away. `new Date(that).toISOString()` throws RangeError beyond ±8.64e15.
		setBalance(9_007_199_254_739_999);

		await run(tempDir, { json: false }, [
			"--cost-center",
			"research",
			"--allocated",
			"9007199254740000",
			"--period-start",
			FIVE_HOURS_AGO,
		]);

		// A raw number (here in exponential notation) rather than a RangeError.
		const combined = logOutput.join("\n");
		expect(combined).toMatch(/Projected exhaustion:\s+[0-9.e+]+ ms$/m);
		expect(process.exitCode).toBe(0);
	});
});

describe("usertrust budget — dispatch", () => {
	it("is a registered command so `did you mean` can suggest it", () => {
		expect(COMMANDS).toContain("budget");
	});

	// main.ts always passes the stripped `rest`, but the documented argv fallback
	// still sees the `budget` subcommand token — which the catch-all unknown-argument
	// guard would reject, making the default path fail every time it was taken.
	it("drops the subcommand token when falling back to process.argv", async () => {
		makeVault();
		const argv = process.argv;
		process.argv = [
			"node",
			"usertrust",
			"budget",
			"--cost-center",
			"research",
			"--allocated",
			"1000",
		];
		try {
			await run(tempDir, { json: true });
		} finally {
			process.argv = argv;
		}

		const payload = JSON.parse(logOutput.join("\n"));
		expect(payload.success).toBe(true);
		expect(payload.data.costCenter).toBe("research");
		expect(process.exitCode).not.toBe(1);
	});
});

/**
 * `PARENT_USER_ID` in cli/budget.ts is a deliberate DISPLAY-SIDE mirror of the
 * authoritative `PARENT_USER_ID_PATTERN` in shared/ids.ts (see the comment above
 * each): the CLI checks early only to quote a useful message, and `costCenterUserId`
 * still enforces the real charset downstream. A module-private regex can't be
 * imported and compared by reference, so this test reads both sources as text and
 * extracts the declaration lines instead — string identity is exactly what "mirror"
 * has to mean, and this is what stops the two from drifting apart silently again
 * (the failure this test exists to catch: issue #64 shipped a `:` to shared/ids.ts
 * without shipping it to the CLI mirror, so `--parent acct:123` was refused at the
 * door the ledger itself would have accepted).
 */
describe("usertrust budget — parent-id pattern parity with shared/ids.ts", () => {
	const budgetSourcePath = fileURLToPath(new URL("../../src/cli/budget.ts", import.meta.url));
	const idsSourcePath = fileURLToPath(new URL("../../src/shared/ids.ts", import.meta.url));

	/** Pull the regex literal out of a `const NAME = /pattern/;` declaration line. */
	function extractPattern(sourcePath: string, declaration: RegExp): string {
		const source = readFileSync(sourcePath, "utf-8");
		const match = declaration.exec(source);
		if (match === null) {
			throw new Error(
				`${sourcePath}: could not find a line matching ${declaration.source} — did the ` +
					"declaration move or get renamed?",
			);
		}
		return match[1] as string;
	}

	it("keeps the CLI mirror byte-identical to the authoritative pattern", () => {
		const mirrored = extractPattern(budgetSourcePath, /^const PARENT_USER_ID = (\/.*\/);$/m);
		const authoritative = extractPattern(
			idsSourcePath,
			/^export const PARENT_USER_ID_PATTERN = (\/.*\/);$/m,
		);

		expect(
			mirrored,
			"cli/budget.ts's PARENT_USER_ID has drifted from shared/ids.ts's " +
				"PARENT_USER_ID_PATTERN. shared/ids.ts is authoritative — fix cli/budget.ts to " +
				"match it verbatim (or, if the charset itself is changing, edit shared/ids.ts " +
				"first and then copy the new literal into cli/budget.ts).",
		).toBe(authoritative);
	});
});
