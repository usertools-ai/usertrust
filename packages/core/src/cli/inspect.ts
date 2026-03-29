// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust inspect — Show trust bank statement
 *
 * Reads vault state and displays balance, audit chain stats,
 * recent transactions, and Merkle root in a formatted table.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { buildMerkleTree } from "../audit/merkle.js";
import { verifyChain } from "../audit/verify.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import type { CliOptions } from "./init.js";

function loadConfig(vaultPath: string): { budget: number } {
	const configPath = join(vaultPath, "usertrust.config.json");
	if (!existsSync(configPath)) {
		return { budget: 0 };
	}
	try {
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw) as { budget?: number };
		return { budget: typeof config.budget === "number" ? config.budget : 0 };
	} catch {
		return { budget: 0 };
	}
}

function loadEvents(vaultPath: string): AuditEvent[] {
	const logPath = join(vaultPath, "audit", "events.jsonl");
	if (!existsSync(logPath)) return [];

	try {
		const content = readFileSync(logPath, "utf-8").trim();
		if (!content) return [];

		return content
			.split("\n")
			.filter((l) => l.trim())
			.map((line) => JSON.parse(line) as AuditEvent);
	} catch {
		return [];
	}
}

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
	const json = opts?.json === true;

	if (!existsSync(vaultPath)) {
		if (json) {
			console.log(
				JSON.stringify({
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

	const config = loadConfig(vaultPath);
	const events = loadEvents(vaultPath);
	const spent = computeSpent(events);
	const remaining = config.budget - spent;
	const pct = config.budget > 0 ? ((remaining / config.budget) * 100).toFixed(1) : "0.0";

	// Verify chain
	const logPath = join(vaultPath, "audit", "events.jsonl");
	const verification = verifyChain(logPath);

	// Build Merkle tree from event hashes
	const eventHashes = events.map((e) => e.hash);
	const { root: merkleRoot } = buildMerkleTree(eventHashes);

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
			JSON.stringify({
				command: "inspect",
				success: true,
				data: {
					budget: config.budget,
					spent,
					remaining,
					percentRemaining: Number.parseFloat(pct),
					chain: {
						events: verification.eventsVerified,
						valid: verification.valid,
						latestHash: verification.latestHash,
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
		`${`|  Chain: ${verification.eventsVerified} events | Integrity: ${verification.valid ? "SHA-256 verified" : "INTEGRITY FAILURE"}`.padEnd(
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
