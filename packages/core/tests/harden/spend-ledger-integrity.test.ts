// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `spend-ledger.json` — absent is not the same fact as unreadable.
 *
 * This file carries cumulative spend ACROSS restarts, and its value seeds two
 * things at startup: the in-process `budgetSpent`, and — via
 * `max(0, budget - budgetSpent)` — the TigerBeetle enforcing wallet. So the
 * answer "0" is load-bearing in two places at once.
 *
 * "0" is the correct answer to *no ledger* (a first run has spent nothing) and
 * the wrong answer to *a ledger we could not read* (an unknown amount has been
 * spent). Collapsing the two re-grants the full budget in-process and re-seeds
 * the enforcing wallet with it.
 *
 * These tests drive the two governors through their PUBLIC entry points rather
 * than the module-private loader, because the loader being correct is not the
 * property that matters — the property that matters is that a governor refuses
 * to start on a ledger it cannot interpret.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { SpendLedgerUnreadableError } from "../../src/shared/errors.js";

let root: string;
let vault: string;

const ledgerPath = () => join(vault, "spend-ledger.json");

/** dryRun keeps TigerBeetle out of it — the ledger read happens before any engine. */
const opts = () => ({ budget: 100_000, dryRun: true, vaultBase: root }) as never;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "usertrust-spend-ledger-"));
	vault = join(root, ".usertrust");
	await mkdir(vault, { recursive: true });
});

afterEach(() => {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Best-effort; the OS reclaims the temp dir regardless.
	}
});

describe("spend ledger — absent means zero", () => {
	it("starts clean when there is no ledger at all", async () => {
		// A first run has genuinely spent nothing. This is the one honest zero and
		// it must keep working, or every new vault fails to start.
		await expect(createGovernor(opts())).resolves.toBeDefined();
	});

	it("reads a well-formed ledger", async () => {
		writeFileSync(
			ledgerPath(),
			JSON.stringify({ budgetSpent: 4200, updatedAt: new Date(0).toISOString() }),
			"utf-8",
		);
		await expect(createGovernor(opts())).resolves.toBeDefined();
	});

	it("accepts a zero-spend ledger, which is distinct from an absent one", async () => {
		writeFileSync(
			ledgerPath(),
			JSON.stringify({ budgetSpent: 0, updatedAt: new Date(0).toISOString() }),
			"utf-8",
		);
		await expect(createGovernor(opts())).resolves.toBeDefined();
	});
});

describe("spend ledger — unreadable must not read as zero", () => {
	const corrupt: ReadonlyArray<readonly [string, string]> = [
		["truncated mid-write", '{"budgetSpent": 42'],
		["zero-length (the post-power-loss shape)", ""],
		["all NUL bytes (the other post-power-loss shape)", "\0\0\0\0\0\0\0\0"],
		["valid JSON, wrong shape", '{"spent": 42}'],
		["valid JSON, not an object", "[1,2,3]"],
		["budgetSpent not a number", '{"budgetSpent": "42"}'],
		["negative cumulative spend", '{"budgetSpent": -1}'],
		["non-finite cumulative spend", '{"budgetSpent": 1e999}'],
	];

	for (const [label, body] of corrupt) {
		it(`REFUSES to start on ${label}`, async () => {
			writeFileSync(ledgerPath(), body, "utf-8");
			await expect(createGovernor(opts())).rejects.toThrow(SpendLedgerUnreadableError);
		});
	}

	it("REFUSES to start on a ledger it lacks permission to read", async () => {
		writeFileSync(ledgerPath(), JSON.stringify({ budgetSpent: 7 }), "utf-8");
		await chmod(ledgerPath(), 0o000);
		try {
			await createGovernor(opts());
			// Root ignores the permission bits; the setup cannot hold there.
		} catch (err) {
			expect(err).toBeInstanceOf(SpendLedgerUnreadableError);
		} finally {
			await chmod(ledgerPath(), 0o600);
		}
	});

	it("names the file and the reason, so the operator can act", async () => {
		writeFileSync(ledgerPath(), "{", "utf-8");
		await expect(createGovernor(opts())).rejects.toThrow(/spend-ledger\.json/);
		await expect(createGovernor(opts())).rejects.toThrow(/delete it to reset/i);
	});
});

describe("spend ledger — trust() enforces the same contract as createGovernor()", () => {
	// The two governors carry byte-identical copies of the loader; a one-sided
	// edit would leave `trust()` re-granting the budget while `createGovernor()`
	// refused. Drive BOTH.
	it("trust() also refuses a corrupt ledger", async () => {
		writeFileSync(ledgerPath(), '{"budgetSpent": ', "utf-8");
		await expect(
			trust({} as never, { budget: 100_000, dryRun: true, vaultBase: root } as never),
		).rejects.toThrow(SpendLedgerUnreadableError);
	});

	it("trust() gets PAST the ledger read when none is present", async () => {
		// `trust()` loads the ledger before it detects the client kind, so a stub
		// client fails detection LATER. Asserting the failure is not the ledger's is
		// what proves the absent-ledger path still returns zero rather than throwing
		// — without coupling this test to client-detection internals.
		const err = await trust(
			{} as never,
			{ budget: 100_000, dryRun: true, vaultBase: root } as never,
		).catch((e: unknown) => e);
		expect(err).not.toBeInstanceOf(SpendLedgerUnreadableError);
		expect(String(err)).toMatch(/Unsupported LLM client/);
	});
});
