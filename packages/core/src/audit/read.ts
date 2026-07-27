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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GENESIS_HASH } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import { canonicalize } from "./canonical.js";

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
			try {
				events.push(JSON.parse(line) as PersistedAuditEvent);
			} catch {
				// Malformed line — verification reports it; reading skips it.
			}
		}
	}

	const allHaveSeq = events.every((e) => typeof e.sequence === "number");
	return allHaveSeq
		? [...events].sort((a, b) => (a.sequence as number) - (b.sequence as number))
		: events;
}

export function loadBudgetConfig(vaultPath: string): { budget: number } {
	const configPath = join(vaultPath, "usertrust.config.json");
	if (!existsSync(configPath)) return { budget: 0 };
	try {
		const config = JSON.parse(readFileSync(configPath, "utf-8")) as { budget?: number };
		return { budget: typeof config.budget === "number" ? config.budget : 0 };
	} catch {
		return { budget: 0 };
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
