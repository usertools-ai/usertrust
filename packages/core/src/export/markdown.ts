// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Markdown / Obsidian exporter.
 *
 * Writes one frontmatter-rich note per ledger event, a Bases view
 * (`Receipts.base`), and a `Ledger Index.md` summary. Notes wikilink their
 * previous event so the hash chain renders as a literal chain in graph view.
 * Read-only against the vault; writes only into `outDir`.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveChainIntegrity, type PersistedAuditEvent, readLedgerEvents } from "../audit/read.js";
import { verifyVault } from "../audit/verify.js";

export interface ExportResult {
	written: number;
	outDir: string;
	/** Parsed-chain walk verdict (hash linkage over readable events). */
	chainValid: boolean;
	breakIndex: number | null;
	/** Full vault verification (segments, malformed lines, .meta anchor). */
	vaultValid: boolean;
	vaultErrors: string[];
}

const UT_TO_USD = 0.0001;

/** Mirrors packages/verify/src/receipt.ts detectProvider (verify stays zero-dep). */
function detectProvider(model: string): string {
	if (model.startsWith("claude")) return "anthropic";
	if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
	if (model.startsWith("gemini")) return "google";
	if (model.startsWith("command")) return "cohere";
	if (model.startsWith("mistral") || model.startsWith("mixtral")) return "mistral";
	return "unknown";
}

// ANCHOR-INTEGRATION: swap for real anchor verification when feat/external-anchoring lands.
function anchorState(vaultPath: string): "unanchored" | "present" {
	return existsSync(join(vaultPath, "audit", "anchors", "anchors.jsonl"))
		? "present"
		: "unanchored";
}

/**
 * Event ids come from the ledger on disk — never trust them as path
 * components. Used for both the `.md` filename and the wikilink target so
 * links keep resolving after sanitization.
 */
function sanitizeId(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function yamlString(value: string): string {
	return /^[A-Za-z0-9._:-]+$/.test(value) ? value : JSON.stringify(value);
}

function integrityFor(index: number, breakIndex: number | null): "verified" | "after-break" {
	return breakIndex !== null && index >= breakIndex ? "after-break" : "verified";
}

function noteFor(
	e: PersistedAuditEvent,
	index: number,
	prev: PersistedAuditEvent | undefined,
	breakIndex: number | null,
	anchor: "unanchored" | "present",
): string {
	const model = typeof e.data.model === "string" ? e.data.model : undefined;
	const cost = typeof e.data.cost === "number" ? e.data.cost : undefined;
	const fm: string[] = ["---"];
	fm.push(`ts: ${yamlString(e.timestamp)}`);
	fm.push(`kind: ${yamlString(e.kind)}`);
	fm.push(`actor: ${yamlString(e.actor)}`);
	if (model) {
		fm.push(`model: ${yamlString(model)}`);
		fm.push(`provider: ${detectProvider(model)}`);
	}
	if (cost !== undefined) {
		fm.push(`cost_ut: ${cost}`);
		fm.push(`cost_usd: ${cost * UT_TO_USD}`);
	}
	if (typeof e.data.settled === "boolean") fm.push(`settled: ${e.data.settled}`);
	if (typeof e.data.transferId === "string")
		fm.push(`transfer_id: ${yamlString(e.data.transferId)}`);
	if (typeof e.sequence === "number") fm.push(`seq: ${e.sequence}`);
	fm.push(`hash: ${yamlString(e.hash)}`);
	fm.push(`previous_hash: ${yamlString(e.previousHash)}`);
	fm.push(`integrity: ${integrityFor(index, breakIndex)}`);
	fm.push(`anchor_state: ${anchor}`);
	fm.push("---");

	const body: string[] = [""];
	body.push(`# ${e.kind} — ${e.timestamp}`);
	body.push("");
	body.push("```");
	body.push(JSON.stringify(e.data, null, 2));
	body.push("```");
	body.push("");
	body.push(prev ? `Previous: [[${sanitizeId(prev.id)}]]` : "Previous: _genesis_");
	body.push("");
	return fm.join("\n") + body.join("\n");
}

const BASE_VIEW = `views:
  - type: table
    name: Receipts
    order:
      - ts
      - kind
      - actor
      - model
      - cost_ut
      - settled
      - integrity
      - transfer_id
    sort:
      - property: ts
        direction: DESC
`;

export function exportMarkdown(vaultPath: string, outDir: string): ExportResult {
	const events = readLedgerEvents(vaultPath);
	const integrity = deriveChainIntegrity(events);
	// Parsed-chain walk alone misses vault-level failures (torn trailing line,
	// tail truncation vs the .meta anchor, sequence gaps) — run the full vault
	// verification too so an export from a tampered vault says so.
	const vault = verifyVault(vaultPath);
	const anchor = anchorState(vaultPath);

	mkdirSync(join(outDir, "receipts"), { recursive: true });
	let written = 0;
	for (let i = 0; i < events.length; i++) {
		const e = events[i] as PersistedAuditEvent;
		const day = sanitizeId(e.timestamp.slice(0, 10)) || "unknown-date";
		const dir = join(outDir, "receipts", day);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${sanitizeId(e.id)}.md`),
			noteFor(e, i, i > 0 ? events[i - 1] : undefined, integrity.breakIndex, anchor),
			"utf-8",
		);
		written++;
	}

	writeFileSync(join(outDir, "Receipts.base"), BASE_VIEW, "utf-8");

	const index: string[] = ["# Ledger Index", ""];
	index.push(`- Events exported: ${written}`);
	index.push(
		`- Chain integrity: ${integrity.valid ? "verified" : `BROKEN at seq ${(events[integrity.breakIndex ?? 0]?.sequence ?? integrity.breakIndex ?? 0).toString()}`}`,
	);
	index.push(
		`- Vault verification: ${vault.valid ? "passed" : `FAILED — ${vault.errors[0] ?? "unknown error"}`}`,
	);
	index.push(`- Anchor state: ${anchor}`);
	index.push(`- Vault: ${vaultPath}`);
	const newest = events.at(-1);
	if (newest) index.push(`- Newest receipt: [[${sanitizeId(newest.id)}]]`);
	index.push("");
	writeFileSync(join(outDir, "Ledger Index.md"), index.join("\n"), "utf-8");

	return {
		written,
		outDir,
		chainValid: integrity.valid,
		breakIndex: integrity.breakIndex,
		vaultValid: vault.valid,
		vaultErrors: vault.errors,
	};
}
