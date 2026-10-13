// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	deriveChainIntegrity,
	describeBudgetSource,
	isKnownBudget,
	loadBudgetConfig,
	readLedgerEvents,
	verifyVault,
} from "usertrust";
import { isHeaderSpend } from "../shared/aggregate.js";
import type { SummaryPayload } from "../shared/api.js";
import { type RemoteSettings, remoteSettings } from "../shared/kit.js";
import { type LedgerRow, toLedgerRows } from "../shared/rows.js";
import { TransferIndex } from "./verdicts.js";

export type { SummaryPayload } from "../shared/api.js";

export const ROW_CAP = 100_000;
const GENESIS = "0".repeat(64);

export interface LedgerState {
	rows: LedgerRow[];
	/** Every event by transfer, for each row's TRANSFER verdict; the live tail adds to it. */
	transfers: TransferIndex;
	summary: SummaryPayload;
	lastHash: string;
	byteOffset: number;
	/** Whether the audit directory existed at this load: once a server has seen it, its absence is a deletion. */
	auditDirPresent: boolean;
}

// Presence of the mirror file is not a verdict — a planted empty/junk file
// must not read as "anchored". verifyVaultWithAnchors needs a caller-pinned
// genesis the UI server does not have.
function anchorFile(vaultPath: string): "present" | "absent" {
	return existsSync(join(vaultPath, "audit", "anchors", "anchors.jsonl")) ? "present" : "absent";
}

/**
 * The summary's budget fields, read from the vault: the governor's record of what it enforces, else the vault config.
 * The server re-reads them when either file changes (a governor starting writes the record OUTSIDE `audit/`).
 */
export function budgetSummary(
	vaultPath: string,
	spentUt: number,
): Pick<
	SummaryPayload,
	"budget" | "budgetSource" | "budgetWrittenAt" | "budgetProvenance" | "remainingUt"
> {
	const config = loadBudgetConfig(vaultPath);
	const budget = isKnownBudget(config.source) ? config.budget : null;
	return {
		budget,
		budgetSource: config.source,
		budgetWrittenAt: config.writtenAt,
		budgetProvenance: describeBudgetSource(config),
		remainingUt: budget === null ? null : budget - spentUt,
	};
}

/**
 * The vault config's `remote` section. A missing or unreadable config leaves every remote load off. The path is
 * statted FIRST: opening a FIFO planted there would block this process (at startup, and on every config poll).
 */
export function readRemoteSettings(vaultPath: string): RemoteSettings {
	const path = join(vaultPath, "usertrust.config.json");
	try {
		if (!statSync(path).isFile()) return remoteSettings(undefined);
		return remoteSettings(JSON.parse(readFileSync(path, "utf-8")) as unknown);
	} catch {
		return remoteSettings(undefined);
	}
}

/**
 * Whether the vault's audit directory is ABSENT, present, or could not be checked (its error code). Only ENOENT is
 * absence: `existsSync` is false on EACCES (no search permission on the vault) and on ENOTDIR too, and both readers
 * then see no events, so treating those as absence showed a vault this process cannot read as empty and clean.
 */
function auditDirState(vaultPath: string): "absent" | "present" | string {
	const auditPath = join(vaultPath, "audit");
	try {
		statSync(auditPath);
		return "present";
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") return code ?? "unknown error";
		// statSync follows links, so a link whose target is missing (an unmounted volume, say) throws ENOENT too: the vault
		// is out of reach, not absent. Either link counts: the audit entry or the vault directory itself.
		if (isDanglingLink(auditPath) || isDanglingLink(vaultPath))
			return "a symbolic link on its path has no target";
		return "absent";
	}
}

/** True for a symbolic link that does not resolve; false for anything else, including a path that does not exist. */
function isDanglingLink(path: string): boolean {
	try {
		if (!lstatSync(path).isSymbolicLink()) return false;
	} catch {
		return false;
	}
	try {
		statSync(path);
		return false;
	} catch {
		return true;
	}
}

/** `verifyVault`'s error for a vault with no audit directory: no evidence either way, not tampering. */
const NO_AUDIT_DIR = "Audit directory not found:";

/**
 * `auditDirSeen`: whether this process has ever seen the vault's audit directory. A first run has none; a directory that
 * existed and is gone was deleted, whatever it held (events, malformed lines, nothing), and must never read as a first
 * run. A count of parsed events missed a log of malformed lines only, which verification fails with zero events.
 */
export function loadState(
	vaultPath: string,
	rowCap: number = ROW_CAP,
	auditDirSeen = false,
): LedgerState {
	const events = readLedgerEvents(vaultPath);
	const integrity = deriveChainIntegrity(events);
	const vault = verifyVault(vaultPath);
	let spentUt = 0;
	for (const e of events) {
		if (isHeaderSpend(e.kind, e.data.cost)) spentUt += e.data.cost;
	}

	// A project before its first governed call has no audit directory, and verifyVault reports exactly that, which
	// the dashboard showed as a red CHAIN INTEGRITY FAILURE. That one error, with no events and the directory really
	// absent, is dropped; every other error stands. A log deleted while its anchor records events keeps its
	// "deletion detected" (the anchor lives in the audit directory, so that directory exists), and if verifyVault ever
	// words the missing-directory error differently, it is kept too: the vault reads as broken, never as clean.
	// The exception is for an audit directory this process has never seen: one deleted while the dashboard was open
	// (the live tail resyncs, and the reload finds it gone) is evidence destroyed, not a first run.
	const auditDir = auditDirState(vaultPath);
	const deletedWhileOpen = auditDir === "absent" && auditDirSeen;
	const noAuditDir = events.length === 0 && auditDir === "absent" && !auditDirSeen;
	const errors = noAuditDir
		? vault.errors.filter((e) => !e.startsWith(NO_AUDIT_DIR))
		: deletedWhileOpen
			? [
					...vault.errors,
					"The audit directory disappeared while this dashboard was open (deletion detected)",
				]
			: auditDir === "absent" || auditDir === "present"
				? vault.errors
				: // verifyVault calls an unreadable directory "not found": say what actually stopped the read.
					[
						...vault.errors,
						`Audit directory could not be read (${auditDir}): this vault was not verified`,
					];
	const valid = integrity.valid && (vault.valid || (noAuditDir && errors.length === 0));

	const truncated = events.length > rowCap;
	const visible = truncated ? events.slice(-rowCap) : events;
	// Integrity indexes are relative to the full ordered list; re-derive for the slice.
	const offset = events.length - visible.length;
	const sliceIntegrity =
		integrity.breakIndex === null
			? integrity
			: { valid: false, breakIndex: Math.max(0, integrity.breakIndex - offset) };
	// Every event, not only the visible slice: a visible row's verdict can rest on an earlier record of its transfer.
	const transfers = new TransferIndex();
	transfers.add(events);
	const rows = toLedgerRows(visible, sliceIntegrity, transfers.verdictOf);

	const logPath = join(vaultPath, "audit", "events.jsonl");
	const byteOffset = existsSync(logPath) ? statSync(logPath).size : 0;

	return {
		rows,
		transfers,
		summary: {
			vaultPath,
			...budgetSummary(vaultPath, spentUt),
			spentUt,
			chain: {
				events: events.length,
				valid,
				empty: valid && events.length === 0,
				breakIndex: integrity.breakIndex,
				errors,
			},
			anchorFile: anchorFile(vaultPath),
			remote: readRemoteSettings(vaultPath),
			rowCount: rows.length,
			truncated,
		},
		lastHash: events.at(-1)?.hash ?? GENESIS,
		byteOffset,
		auditDirPresent: auditDir === "present",
	};
}
