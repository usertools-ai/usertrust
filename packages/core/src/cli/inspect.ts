// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust inspect — Show trust bank statement
 *
 * Reads vault state and displays balance, audit chain stats,
 * recent transactions, and Merkle root in a formatted table.
 */

import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { loadBudgetConfig, type PersistedAuditEvent } from "../audit/read.js";
import { type VaultReading, verifyVaultReading } from "../audit/verify.js";
import { GENESIS_HASH, VAULT_DIR } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import type { CliOptions } from "./init.js";
import { toSafeJson, warnIfVaultLoose } from "./target.js";

function computeSpent(events: AuditEvent[]): number {
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

/**
 * The vault's chain, read ONCE (`verifyVaultReading`): its verdict, and the events the spend, the
 * transactions and the Merkle root are taken from. A vault with nothing at its audit directory's path
 * (nothing governed yet) holds no events; anything else there is read, and judged.
 */
function readChain(vaultPath: string): VaultReading | undefined {
	try {
		lstatSync(join(vaultPath, "audit"));
	} catch (err) {
		if ((err as { code?: unknown } | null)?.code === "ENOENT") return undefined;
	}
	return verifyVaultReading(vaultPath);
}

/** The walk's events as this statement reads them: an event without `data` carries none. */
function statementEvents(events: readonly PersistedAuditEvent[]): AuditEvent[] {
	return events.map((e) => {
		const record = e as unknown as Record<string, unknown>;
		const data =
			typeof record.data === "object" && record.data !== null
				? (record.data as Record<string, unknown>)
				: {};
		return { ...(e as AuditEvent), data } as AuditEvent;
	});
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
	const reading = readChain(vaultPath);
	// A vault that kept changing while it was read has no snapshot: no statement is made from it.
	if (reading?.result.busy === true) {
		const message =
			"the vault is being written: its audit files kept changing while they were read, so there is no statement (run inspect again)";
		if (json) {
			console.log(
				toSafeJson({ command: "inspect", success: false, data: { busy: true, message } }),
			);
		} else {
			console.log(pc.yellow(`Chain: ${message}.`));
		}
		process.exitCode = 1;
		return;
	}
	const verification = reading?.result ?? { valid: true, errors: [], merkleRoot: null };
	const events = statementEvents(reading?.events ?? []);
	const spent = computeSpent(events);
	const remaining = config.budget - spent;
	const pct = config.budget > 0 ? ((remaining / config.budget) * 100).toFixed(1) : "0.0";
	const merkleRoot = verification.merkleRoot;
	const latestHash = reading?.orderedHashes[reading.orderedHashes.length - 1] ?? GENESIS_HASH;

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
					budget: config.budget,
					spent,
					remaining,
					percentRemaining: Number.parseFloat(pct),
					chain: {
						events: events.length,
						valid: verification.valid,
						latestHash,
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
		`${`|  Budget: ${remaining.toLocaleString()} / ${config.budget.toLocaleString()} UT remaining (${pct}%)`.padEnd(
			63,
		)}|`,
	);
	console.log(
		`${`|  Chain: ${events.length} events | Integrity: ${verification.valid ? "SHA-256 verified" : "INTEGRITY FAILURE"}`.padEnd(
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
	}
}
