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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	"projectedExhaustionMs",
	"remaining",
	"spent",
];

let tempDir: string;
let logOutput: string[];

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
});
