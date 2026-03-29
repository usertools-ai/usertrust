// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Audit Rotation — Daily receipt indexing
 *
 * Writes individual audit receipts to date-organized directories under
 * the vault's audit directory. Maintains a bounded index.json for fast
 * receipt lookup.
 *
 * Structure: .usertrust/audit/<kind>/<YYYY-MM-DD>/<receiptId>.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_DIR, RECEIPT_VERSION, VAULT_DIR } from "../shared/constants.js";
import { trustId } from "../shared/ids.js";

// ── Types ──

export interface AuditReceipt {
	v: number;
	ts: string;
	kind: string;
	subsystem: string;
	actor: string;
	correlationId?: string;
	data: Record<string, unknown>;
}

export interface WriteReceiptInput {
	kind: string;
	subsystem: string;
	actor: string;
	correlationId?: string;
	data: Record<string, unknown>;
}

export interface IndexEntry {
	receiptId: string;
	kind: string;
	ts: string;
	actor: string;
	correlationId?: string;
	path: string;
}

// ── Helpers ──

function getTodayDate(): string {
	const now = new Date();
	return now.toISOString().split("T")[0] ?? "unknown";
}

function getDailyDir(auditRoot: string, kind: string): string {
	return join(auditRoot, kind, getTodayDate());
}

function getIndexPath(auditRoot: string): string {
	return join(auditRoot, "index.json");
}

// ── Index management ──

function updateIndex(auditRoot: string, entry: IndexEntry, indexLimit: number): void {
	try {
		const indexPath = getIndexPath(auditRoot);
		let index: IndexEntry[] = [];

		if (existsSync(indexPath)) {
			const raw = readFileSync(indexPath, "utf-8");
			index = JSON.parse(raw) as IndexEntry[];
		}

		index.push(entry);

		// Keep index bounded
		if (index.length > indexLimit) {
			index = index.slice(-indexLimit);
		}

		writeFileSync(indexPath, JSON.stringify(index, null, "\t"));
	} catch {
		// Index update failure is non-fatal
	}
}

// ── Public API ──

/**
 * Write an audit receipt to the daily-rotated directory structure.
 *
 * @param vaultPath - Root vault directory (parent of .usertrust/)
 * @param input - Receipt data to write
 * @param indexLimit - Maximum index entries (default: 10000)
 * @returns The written receipt, or undefined if the write failed
 */
export function writeReceipt(
	vaultPath: string,
	input: WriteReceiptInput,
	indexLimit = 10_000,
): AuditReceipt | undefined {
	try {
		const auditRoot = join(vaultPath, VAULT_DIR, AUDIT_DIR);
		const receiptId = trustId("rcpt");
		const ts = new Date().toISOString();

		const receipt: AuditReceipt = {
			v: RECEIPT_VERSION,
			ts,
			kind: input.kind,
			subsystem: input.subsystem,
			actor: input.actor,
			...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
			data: {
				receiptId,
				...input.data,
			},
		};

		// Write individual receipt file with daily rotation
		const dailyDir = getDailyDir(auditRoot, input.kind);
		if (!existsSync(dailyDir)) {
			mkdirSync(dailyDir, { recursive: true });
		}
		const receiptFile = join(dailyDir, `${receiptId}.json`);
		writeFileSync(receiptFile, JSON.stringify(receipt, null, "\t"));

		// Update index
		updateIndex(
			auditRoot,
			{
				receiptId,
				kind: input.kind,
				ts,
				actor: input.actor,
				...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
				path: `${input.kind}/${getTodayDate()}/${receiptId}.json`,
			},
			indexLimit,
		);

		return receipt;
	} catch {
		return undefined;
	}
}

/**
 * List all receipts of a given kind (optionally filtered by date).
 *
 * @param vaultPath - Root vault directory
 * @param kind - Receipt kind to list
 * @param date - Optional date filter (YYYY-MM-DD)
 * @returns Array of receipts, sorted newest-first
 */
export function listReceipts(vaultPath: string, kind: string, date?: string): AuditReceipt[] {
	const kindDir = join(vaultPath, VAULT_DIR, AUDIT_DIR, kind);
	if (!existsSync(kindDir)) return [];

	try {
		const results: AuditReceipt[] = [];
		const entries = readdirSync(kindDir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (date && entry.name !== date) continue;

				const dateDir = join(kindDir, entry.name);
				const files = readdirSync(dateDir).filter((f) => f.endsWith(".json"));
				for (const f of files) {
					try {
						const raw = readFileSync(join(dateDir, f), "utf-8");
						results.push(JSON.parse(raw) as AuditReceipt);
					} catch {
						// Skip invalid files
					}
				}
			} else if (entry.isFile() && entry.name.endsWith(".json")) {
				try {
					const raw = readFileSync(join(kindDir, entry.name), "utf-8");
					results.push(JSON.parse(raw) as AuditReceipt);
				} catch {
					// Skip invalid files
				}
			}
		}

		return results.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
	} catch {
		return [];
	}
}

/**
 * Load the audit index.
 *
 * @param vaultPath - Root vault directory
 * @returns Array of index entries
 */
export function loadIndex(vaultPath: string): IndexEntry[] {
	const indexPath = getIndexPath(join(vaultPath, VAULT_DIR, AUDIT_DIR));
	if (!existsSync(indexPath)) return [];

	try {
		const raw = readFileSync(indexPath, "utf-8");
		return JSON.parse(raw) as IndexEntry[];
	} catch {
		return [];
	}
}
