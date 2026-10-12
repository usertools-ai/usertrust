// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Shared vault ledger reader.
 *
 * Read-only helpers used by the CLI (`inspect`, `export`) and the
 * `usertrust-ui` server. Gathers `events.jsonl` plus rotated `*.jsonl`
 * segments and orders by the persisted global `sequence` (same segment
 * discipline as `verifyVault`). Malformed lines are skipped here —
 * verification (`verifyChain`/`verifyVault`) is where they are reported.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GENESIS_HASH } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import { canonicalize } from "./canonical.js";
import { readEffectiveBudget } from "./effective-budget.js";

export interface PersistedAuditEvent extends AuditEvent {
	sequence?: number;
}

export interface ChainIntegrity {
	valid: boolean;
	/** 0-based index into the ordered events of the first broken link, or null. */
	breakIndex: number | null;
}

export function readLedgerEvents(vaultPath: string): PersistedAuditEvent[] {
	const auditDir = join(vaultPath, "audit");
	if (!existsSync(auditDir)) return [];

	const segmentFiles: string[] = [];
	const mainLog = join(auditDir, "events.jsonl");
	if (existsSync(mainLog)) segmentFiles.push(mainLog);
	try {
		for (const entry of readdirSync(auditDir).sort()) {
			if (entry.endsWith(".jsonl") && entry !== "events.jsonl") {
				segmentFiles.push(join(auditDir, entry));
			}
		}
	} catch {
		// Directory read failure — treat as no extra segments
	}

	const events: PersistedAuditEvent[] = [];
	for (const segmentFile of segmentFiles) {
		let content: string;
		try {
			content = readFileSync(segmentFile, "utf-8").trim();
		} catch {
			continue;
		}
		if (content === "") continue;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				// Malformed line — verification reports it; reading skips it.
				continue;
			}
			// A line that parses but is not an event object (`null`, a number, an array) is malformed
			// too: verification reports it, and reading it as an event threw on its first field.
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			events.push(parsed as PersistedAuditEvent);
		}
	}

	const allHaveSeq = events.every((e) => typeof e.sequence === "number");
	return allHaveSeq
		? [...events].sort((a, b) => (a.sequence as number) - (b.sequence as number))
		: events;
}

/**
 * Where a vault reader's budget came from:
 * - `governor`: the budget the vault's governor recorded as the one it ENFORCES (`effective-budget.json`);
 * - `config`: no record, so the vault's own `usertrust.config.json`;
 * - `none`: neither gives one, or the record exists but cannot be read. The budget is then UNKNOWN, and `budget`
 *   is 0 only as a placeholder: a reader must not compute a remaining figure from it.
 */
export type BudgetSource = "governor" | "config" | "none";

export function loadBudgetConfig(vaultPath: string): { budget: number; source: BudgetSource } {
	const recorded = readEffectiveBudget(vaultPath);
	if (recorded.state === "recorded") return { budget: recorded.budget, source: "governor" };
	// An unreadable record is not an absent one: the config file may not be what the governor enforced.
	if (recorded.state === "unreadable") return { budget: 0, source: "none" };
	const configPath = join(vaultPath, "usertrust.config.json");
	if (!existsSync(configPath)) return { budget: 0, source: "none" };
	try {
		const config = JSON.parse(readFileSync(configPath, "utf-8")) as { budget?: number };
		return typeof config.budget === "number" && config.budget > 0
			? { budget: config.budget, source: "config" }
			: { budget: 0, source: "none" };
	} catch {
		return { budget: 0, source: "none" };
	}
}

/**
 * Walk an in-memory ordered chain and locate the first broken link
 * (recomputed-hash mismatch or previousHash discontinuity).
 */
export function deriveChainIntegrity(events: PersistedAuditEvent[]): ChainIntegrity {
	let expectedPrev = GENESIS_HASH;
	for (let i = 0; i < events.length; i++) {
		const e = events[i] as PersistedAuditEvent;
		if (e.previousHash !== expectedPrev) {
			return { valid: false, breakIndex: i };
		}
		const { hash: storedHash, ...rest } = e;
		const computed = createHash("sha256").update(canonicalize(rest)).digest("hex");
		if (computed !== storedHash) {
			return { valid: false, breakIndex: i };
		}
		expectedPrev = storedHash;
	}
	return { valid: true, breakIndex: null };
}
