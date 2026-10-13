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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
 * - `several`: the vault's live governors enforce different budgets, so the budget is UNKNOWN;
 * - `unreadable`: the record exists but cannot be read (`reason` says why). UNKNOWN, never the config's figure: the
 *   config file may not be what the governor enforced;
 * - `unpublished`: no record and no config budget. UNKNOWN: a governor publishes its budget only once it holds the
 *   vault's writer lock (its first append), so a vault whose governor has not yet appended has none to read. Never
 *   "no budget configured": every governor enforces one, the built-in default at least.
 * For the three unknown sources `budget` is 0 only as a placeholder: a reader must not compute a remaining figure from it.
 */
export type BudgetSource = "governor" | "config" | "several" | "unreadable" | "unpublished";

/** Whether a source gives a budget at all: `several`, `unreadable` and `unpublished` do not. */
export function isKnownBudget(source: BudgetSource): boolean {
	return source === "governor" || source === "config";
}

export interface VaultBudget {
	budget: number;
	source: BudgetSource;
	/** When the governor wrote its record (`governor` and `several`, else null): the figure's age, always shown. */
	writtenAt: string | null;
	/** Why the record could not be read (`unreadable` only, else null). */
	reason: string | null;
}

const UNPUBLISHED: VaultBudget = {
	budget: 0,
	source: "unpublished",
	writtenAt: null,
	reason: null,
};

export function loadBudgetConfig(vaultPath: string): VaultBudget {
	const recorded = readEffectiveBudget(vaultPath);
	if (recorded.state === "recorded") {
		return {
			budget: recorded.budget,
			source: "governor",
			writtenAt: recorded.writtenAt,
			reason: null,
		};
	}
	// Several live governors enforcing different budgets: unknown, never one of them, and never the config's.
	if (recorded.state === "several")
		return { budget: 0, source: "several", writtenAt: recorded.writtenAt, reason: null };
	// An unreadable record is not an absent one: the config file may not be what the governor enforced.
	if (recorded.state === "unreadable")
		return { budget: 0, source: "unreadable", writtenAt: null, reason: recorded.reason };
	const configPath = join(vaultPath, "usertrust.config.json");
	try {
		// stat FIRST: opening a FIFO planted at this path would block every reader (inspect, health, the UI). A missing
		// config, or one that is not a regular file, gives no budget.
		if (!statSync(configPath).isFile()) return { ...UNPUBLISHED };
		const config = JSON.parse(readFileSync(configPath, "utf-8")) as { budget?: number };
		return typeof config.budget === "number" && config.budget > 0
			? { budget: config.budget, source: "config", writtenAt: null, reason: null }
			: { ...UNPUBLISHED };
	} catch {
		return { ...UNPUBLISHED };
	}
}

/**
 * The one wording of a budget's PROVENANCE, shown wherever the budget is (the ledger UI, inspect, report). Only a
 * governor record reads as the enforced figure, and always with its age; a config budget says it is unconfirmed.
 */
export function describeBudgetSource(
	b: Pick<VaultBudget, "source" | "writtenAt"> & { reason?: string | null },
): string {
	switch (b.source) {
		case "governor":
			return `the enforced budget, as of ${b.writtenAt ?? "an unknown time"}`;
		case "config":
			return "from usertrust.config.json; not confirmed as enforced";
		case "several":
			return `unknown: several governors with different budgets, as of ${b.writtenAt ?? "an unknown time"}`;
		case "unreadable":
			return `unknown: the enforced-budget record could not be read; ${b.reason ?? "unreadable"}`;
		case "unpublished":
			return "unknown: not yet published; no governor has recorded the budget it enforces";
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
