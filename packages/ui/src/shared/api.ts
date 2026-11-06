// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Wire types shared between the server and the SPA. The SPA imports these
 * from `../shared/api.js` — never from server code (Amendment A2).
 */

import type { RowStatus } from "./rows.js";

export interface SummaryPayload {
	vaultPath: string;
	/**
	 * The budget in usertokens, or null when it is UNKNOWN: the vault's governor recorded none and the vault config
	 * gives none. Never 0 standing in for "unknown".
	 */
	budget: number | null;
	/**
	 * Where `budget` came from: the governor's record of what it enforces, or the vault config. Unknown: `several`
	 * governors that disagree, an `unreadable` record, or `unpublished` (no governor has published one yet).
	 */
	budgetSource: "governor" | "config" | "several" | "unreadable" | "unpublished";
	/** When the governor wrote its record (`budgetSource: "governor"` only, else null). */
	budgetWrittenAt: string | null;
	/** Where the budget came from, in words, SHOWN beside it. The page reads a governor record as enforced only while it is fresh (BUDGET_RECORD_FRESH_MS). */
	budgetProvenance: string;
	spentUt: number;
	/** `budget - spentUt`, or null when the budget is unknown: there is no remaining figure without a budget. */
	remainingUt: number | null;
	/**
	 * `empty`: no events and nothing wrong, a project before its first governed call. It is never set beside a
	 * failure: a log deleted while its anchor still records events has no events either, and is `valid: false`.
	 */
	chain: {
		events: number;
		valid: boolean;
		empty: boolean;
		breakIndex: number | null;
		errors: string[];
	};
	// File presence only — not a verification verdict. The UI has no
	// operator-pinned genesis, and inventing one from the vault under audit
	// would violate "anchor trust never comes from the vault under audit".
	anchorFile: "present" | "absent";
	/** The vault config's `remote` section (`shared/kit.ts`): `kit` loads the usertrust mark from usertrust.ai. */
	remote: { kit: boolean };
	rowCount: number;
	truncated: boolean;
	/**
	 * When the chain verdict was last derived from a full read of the vault (ISO-8601), or null when no full read has
	 * succeeded yet. An append extends the verdict without changing it; a read that failed leaves it as it was. The
	 * dashboard is a monitor: `usertrust verify` is the authoritative check.
	 */
	verifiedAt: string | null;
}

/** A dashboard setting kept in the workspace (never in the vault). */
export type SettingKey = "plan.monthlyUt" | "people.rateUsdPerHour";

export interface SettingEntry {
	/** ISO-8601 UTC: the time from which `value` is in force. */
	at: string;
	key: SettingKey;
	/** null means the setting is unset from `at` on. */
	value: number | null;
}

/** GET /api/session: the token this server start requires on every write. */
export interface SessionPayload {
	token: string;
}

/**
 * GET /api/settings, and the reply to PUT /api/settings. While settings are off (the workspace would sit inside
 * the vault, or is unsafe), every value is null, `history` is empty and `problem` says why.
 */
export interface SettingsPayload {
	/** The value in force now, per key; null when unset. */
	values: Record<SettingKey, number | null>;
	/** Every entry, oldest first. */
	history: SettingEntry[];
	/** What is wrong with the workspace, or null. */
	problem: string | null;
}

/** The body of PUT /api/settings: exactly these two fields. The server dates the entry. */
export interface SettingUpdate {
	key: SettingKey;
	value: number | null;
}

/** What `AtPayload.counts` counts: `llm_call` records (not `llm_call_failed`), denials, and every other record. */
export type AtCounts = Record<"llm_call" | "denied" | "other", number>;

/**
 * GET /api/at?pos=N or GET /api/at?t=<ISO>: the vault as recorded at one position. A position is an event's index in
 * the ordered list the chain is verified over, across the whole vault (`LedgerRow.pos`).
 */
export interface AtPayload {
	/** The position answered: the one asked for, the head when the one asked for is past it, or the last at `t`. */
	pos: number;
	/** The event's time at `pos`, as recorded. */
	ts: string;
	/** The last position (the number of positions, minus 1). */
	head: number;
	/** Whether the position asked for was past the head, so `pos` is the head instead. */
	clamped: boolean;
	/**
	 * Bumped by a full reload whose records differ from the state it replaces: another log identity, event count, tip
	 * hash or break index, or any record whose content (its hash recomputed) or stored hash differs or sits elsewhere,
	 * such as a record rewritten in place after an existing break with every stored hash kept. A reload of an unchanged
	 * vault (the periodic re-verify) and an append leave it as it was. A position names a record only within one epoch,
	 * so a page holding `#at=N` from another epoch knows that N may now name another record. It starts at 0 on every
	 * server start, so two starts can share a value: a page reconnects and reloads when the server restarts, and never
	 * compares epochs across one.
	 */
	epoch: number;
	/** Spend at `pos`: the cost of every `llm_call` record at positions `0..pos` (the header's Spend rule). */
	spentUt: number;
	/** Records at positions `0..pos`: `llm_call` (not `llm_call_failed`), denials (`policy_denied`, `ledger_rejected`), and the rest. */
	counts: AtCounts;
	/**
	 * Whether the chain verifies up to and including `pos`: `breakIndex` is the position of the first event that breaks
	 * it (over the whole vault), or null. Never more than the whole-vault verdict: with no break, `valid` is that verdict
	 * (`SummaryPayload.chain.valid`), so a vault that fails for a reason no event marks is invalid at every position.
	 */
	chain: { valid: boolean; breakIndex: number | null };
	/** Today's budget: there is no budget history yet, and `note` says so. */
	budget: { ut: number | null; note: string };
	/**
	 * The monthly plan (`plan.monthlyUt`) in force at the position's running-maximum time (the latest time recorded at
	 * or before it: the event's own in a log written in order), or null (unset, no time, or settings off).
	 */
	plan: number | null;
	/** The position of the first row held (`/api/events`), or `head + 1` when none is. */
	windowStartPos: number;
	/**
	 * The status at `pos` of each held row, by event hash, whose status there can differ from its status now: a row at or
	 * before `pos` whose transfer has a record after it. Every other row at or before `pos` has its current status.
	 */
	statusAt: Record<string, RowStatus>;
}
