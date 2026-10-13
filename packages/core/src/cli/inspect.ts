// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust inspect — Show trust bank statement
 *
 * Reads vault state and displays balance, audit chain stats,
 * recent transactions, and Merkle root in a formatted table.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { describeBudgetSource, isKnownBudget, loadBudgetConfig } from "../audit/read.js";
import { verifyVaultReading } from "../audit/verify.js";
import { GENESIS_HASH, VAULT_DIR } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import { describeMissingSegments } from "./audit-segments.js";
import type { CliOptions } from "./init.js";
import { scrubForTerminal, toSafeJson, warnIfVaultLoose } from "./target.js";

function computeSpent(events: readonly AuditEvent[]): number {
	let spent = 0;
	for (const e of events) {
		if (e.kind !== "llm_call") continue;
		const cost = e.data.cost;
		if (typeof cost === "number") {
			spent += cost;
		}
	}
	return spent;
}

function formatTime(timestamp: string): string {
	try {
		const d = new Date(timestamp);
		return d.toTimeString().slice(0, 8);
	} catch {
		return "??:??:??";
	}
}

function padRight(s: string, len: number): string {
	return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
	return s.length >= len ? s.slice(0, len) : " ".repeat(len - s.length) + s;
}

export async function run(rootDir?: string, opts?: CliOptions): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);
	warnIfVaultLoose(vaultPath);
	const json = opts?.json === true;

	if (!existsSync(vaultPath)) {
		if (json) {
			console.log(
				toSafeJson({
					command: "inspect",
					success: false,
					data: { message: "No trust vault found. Run `usertrust init` first." },
				}),
			);
		} else {
			console.log(`${pc.red("No trust vault found.")} Run \`usertrust init\` first.`);
		}
		return;
	}

	const config = loadBudgetConfig(vaultPath);
	// ONE READING for the verdict, the count, the latest hash, the Merkle root, the spend and the table:
	// every audit segment, ordered by `sequence`, walked as one chain, exactly as `usertrust verify`
	// reads it. Verifying the live log alone failed every rotated vault (its first event links to the
	// previous segment, not to GENESIS, and the `.meta` anchor counts every event), and listing events
	// from a second read let the table and the root describe a log the verdict never judged.
	const reading = verifyVaultReading(vaultPath);
	const verification = reading.result;
	const events = reading.events;
	const spent = computeSpent(events);
	// An UNKNOWN budget (no governor record, no configured budget) has no remaining figure: subtracting spend from the
	// placeholder 0 printed a negative balance for a vault whose governor enforces a real budget elsewhere.
	const budgetKnown = isKnownBudget(config.source);
	const remaining = budgetKnown ? config.budget - spent : null;
	const pct =
		remaining !== null && config.budget > 0 ? ((remaining / config.budget) * 100).toFixed(1) : null;
	// Wherever the budget is shown, so is where it came from: only a governor record is the ENFORCED figure, and it
	// carries its age; a config budget says it is unconfirmed.
	const provenance = describeBudgetSource(config);

	const latestHash = reading.orderedHashes.at(-1) ?? GENESIS_HASH;
	const merkleRoot = verification.merkleRoot;
	// A `Sequence gap:` says an event follows the wrong one, not which file is gone: name the absent
	// range and its neighbouring segments beside it. Event ids and segment file names inside these
	// errors are text from the vault under inspection: the TABLE scrubs every line it prints, while
	// --json keeps the vault's own bytes (`toSafeJson` escapes C1) so the evidence is not replaced by `?`.
	const chainErrors = [
		...verification.errors,
		...describeMissingSegments(join(vaultPath, "audit"), verification.errors),
	];

	if (json) {
		const transactions = events
			.slice(-10)
			.reverse()
			.map((e) => ({
				time: e.timestamp,
				model: typeof e.data.model === "string" ? e.data.model : "unknown",
				cost: typeof e.data.cost === "number" ? e.data.cost : null,
				receipt: typeof e.data.transferId === "string" ? e.data.transferId : e.id,
			}));

		console.log(
			toSafeJson({
				command: "inspect",
				success: true,
				data: {
					budget: budgetKnown ? config.budget : null,
					budgetSource: config.source,
					budgetWrittenAt: config.writtenAt,
					budgetProvenance: provenance,
					spent,
					remaining,
					percentRemaining: pct === null ? null : Number.parseFloat(pct),
					chain: {
						events: verification.chainLength,
						valid: verification.valid,
						latestHash,
						errors: chainErrors,
					},
					merkleRoot: merkleRoot ?? null,
					transactions,
				},
			}),
		);
		return;
	}

	// Header
	console.log("+--------------------------------------------------------------+");
	console.log(`|  ${pc.bold("* usertrust vault")}${" ".repeat(43)}|`);
	console.log(
		`${(
			remaining === null
				? `|  Budget: ${provenance}, ${spent.toLocaleString()} UT spent`
				: `|  Budget: ${remaining.toLocaleString()} / ${config.budget.toLocaleString()} UT remaining (${pct}%)`
		).padEnd(63)}|`,
	);
	if (remaining !== null) console.log(`${`|    (${provenance})`.padEnd(63)}|`);
	console.log(
		`${`|  Chain: ${verification.chainLength} events | Integrity: ${verification.valid ? "SHA-256 verified" : "INTEGRITY FAILURE"}`.padEnd(
			63,
		)}|`,
	);
	if (merkleRoot) {
		console.log(`${`|  Merkle root: ${merkleRoot.slice(0, 16)}...`.padEnd(63)}|`);
	}
	console.log("+----------+--------------+--------+---------------------------+");
	console.log("| Time     | Model        | Cost   | Receipt                   |");
	console.log("+----------+--------------+--------+---------------------------+");

	// Show last 10 transactions
	const recent = events.slice(-10).reverse();
	for (const e of recent) {
		const time = formatTime(e.timestamp);
		const model = typeof e.data.model === "string" ? e.data.model : "unknown";
		const cost = typeof e.data.cost === "number" ? `${e.data.cost} UT` : "—";
		const receipt = typeof e.data.transferId === "string" ? e.data.transferId : e.id.slice(0, 20);

		console.log(
			`| ${padRight(time, 8)} | ${padRight(model, 12)} | ${padLeft(cost, 6)} | ${padRight(receipt, 25)} |`,
		);
	}

	if (recent.length === 0) {
		console.log(`| ${padRight("No transactions recorded", 58)} |`);
	}

	console.log("+----------+--------------+--------+---------------------------+");

	// Show integrity status with color below the table
	if (!verification.valid) {
		console.log(pc.red("WARNING: Chain integrity check failed!"));
		for (const err of chainErrors) console.log(pc.red(`  - ${scrubForTerminal(err)}`));
	}
}
