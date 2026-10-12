// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The report and the governor must agree on ONE state. A budget is a wallet of units, and a local (nominal) call debits it
 * at the 1-unit floor: 100 such calls exhaust a 100-unit budget. The report reads 100% used, and the governor refuses the
 * next call. A report that counted dollars only would say 0% used over a wallet enforcement already considers empty.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/report.js";
import { createGovernor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

describe("report and governor agree on an exhausted budget of nominal units", () => {
	let dir: string;
	let stdout: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trust-budget-agree-"));
		mkdirSync(join(dir, VAULT_DIR), { recursive: true });
		process.env.USERTRUST_TEST = "1";
		stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		process.exitCode = undefined;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		process.env.USERTRUST_TEST = "";
		rmSync(dir, { recursive: true, force: true });
	});

	it("100 nominal calls on a 100-unit budget: the report reads 100% used and the governor refuses the next call", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100,
			vaultBase: dir,
			endpoint: { class: "local", runtime: "ollama" },
		});
		for (let i = 0; i < 100; i++) {
			const auth = await gov.authorize({ model: "qwen2.5:7b" });
			await gov.settle(auth, { inputTokens: 10, outputTokens: 10, usageSource: "provider" });
		}
		// enforcement: the wallet is empty
		await expect(gov.authorize({ model: "qwen2.5:7b" })).rejects.toThrow();
		await gov.destroy();

		const end = new Date(Date.now() + 3_600_000).toISOString();
		await run(dir, {}, ["--week", "--end", end, "--budget", "100", "--format", "json"]);
		const out = JSON.parse(stdout) as {
			budget: {
				usedFraction: number;
				overBudget: boolean;
				recordedSessionUt: number;
				recordedSessionNominal: number;
				recordedSessionWallet: number;
			};
			totals: { confirmedUt: number; nominalUt: number };
		};
		expect(out.budget.recordedSessionNominal).toBe(100);
		expect(out.budget.recordedSessionUt).toBe(0); // none of it is dollars
		expect(out.budget.recordedSessionWallet).toBe(100);
		expect(out.budget.usedFraction).toBe(1); // report and enforcement agree on one state
		expect(out.totals.confirmedUt).toBe(0);
		expect(out.totals.nominalUt).toBe(100);
	}, 60_000);
});
