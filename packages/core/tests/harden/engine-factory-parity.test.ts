// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `createTBEngine` — and the two TigerBeetle status predicates it classifies
 * rejections with — are DUPLICATED between `govern.ts` and `headless.ts`. AGENTS.md
 * (Known drift) records the rule: change both in lockstep. Nothing mechanical
 * enforced it until this suite.
 *
 * The failure it exists to catch: a change landed in one governor's copy and not
 * the other's. Both copies build the funded, balance-enforcing holding wallet that
 * IS the budget enforcement, so a one-sided edit does not fail a build or a type
 * check — `trust()` and `createGovernor()` simply stop agreeing about where money
 * is held or how a ledger rejection is classified, and only whichever governor the
 * deployment happens to use is right. Envelope routing made that concrete: the
 * debit account and the D5 `debit_account_not_found` mapping have to be identical
 * on both, or an attributed hold spends from the session wallet on one of them.
 *
 * Comments and blank lines are stripped before comparison — the two copies carry
 * deliberately different prose (each names its own file) — so what is pinned is the
 * CODE. Do not "fix" a failure here by editing this test: copy the change across.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const governSourcePath = fileURLToPath(new URL("../../src/govern.ts", import.meta.url));
const headlessSourcePath = fileURLToPath(new URL("../../src/headless.ts", import.meta.url));

/**
 * Pull one top-level function out of a source file as text, minus comments and
 * blank lines. Relies on the house formatting: a declaration line starting at
 * column 0 and a closing `}` at column 0.
 */
function extractFunction(sourcePath: string, name: string): string {
	const lines = readFileSync(sourcePath, "utf-8").split("\n");
	const start = lines.findIndex((line) => {
		const bare = line.startsWith("export ") ? line.slice("export ".length) : line;
		return bare.startsWith(`function ${name}(`) || bare.startsWith(`async function ${name}(`);
	});
	if (start === -1) {
		throw new Error(
			`${sourcePath}: no top-level declaration of ${name} — was it renamed, moved, or indented?`,
		);
	}
	const end = lines.indexOf("}", start);
	if (end === -1) {
		throw new Error(`${sourcePath}: ${name} has no closing brace at column 0`);
	}
	return lines
		.slice(start, end + 1)
		.map((line) => (line.startsWith("export ") ? line.slice("export ".length) : line))
		.filter((line) => line.trim() !== "" && !line.trim().startsWith("//"))
		.join("\n");
}

const DRIFT_HINT =
	"govern.ts and headless.ts carry duplicate copies of this function and must change " +
	"in lockstep (AGENTS.md, Known drift). Copy the edit into the other file verbatim — " +
	"do not relax this test.";

describe("engine factory parity — govern.ts and headless.ts stay in lockstep", () => {
	it.each(["createTBEngine", "isTBInsufficientBalance", "isTBDebitAccountNotFound"])(
		"keeps %s identical in both governors",
		(name) => {
			expect(extractFunction(headlessSourcePath, name), DRIFT_HINT).toBe(
				extractFunction(governSourcePath, name),
			);
		},
	);

	it("still finds a real function body to compare (guards the extractor itself)", () => {
		const body = extractFunction(governSourcePath, "createTBEngine");
		// A silently-empty extraction would make every assertion above vacuous.
		expect(body).toContain("createFundedBudgetWallet");
		expect(body).toContain("spendPending");
		expect(body.split("\n").length).toBeGreaterThan(20);
	});
});
