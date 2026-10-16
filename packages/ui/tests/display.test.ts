// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	anchorView,
	chainStatus,
	costView,
	ESTIMATED_TITLE,
	listState,
	transferView,
	usageView,
	verifiedAsOf,
	windowNotice,
} from "../src/shared/display.js";
import type { LedgerRow } from "../src/shared/rows.js";

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		id: "5d014ce0-8008-4b5e-b44b-e1b1c8daf2d8",
		ts: "2026-10-12T17:59:02.770Z",
		kind: "llm_call",
		actor: "local",
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		...overrides,
	};
}

describe("chainStatus", () => {
	const chain = { events: 0, breakIndex: null, errors: [] };

	it("red-first (red banner on a new project): a vault with no events and nothing wrong is EMPTY", () => {
		expect(chainStatus({ ...chain, valid: true, empty: true })).toBe("empty");
	});

	it("events and nothing wrong: verified", () => {
		expect(chainStatus({ ...chain, events: 3, valid: true, empty: false })).toBe("verified");
	});

	// The over-correction guard: an empty flag must never quiet a failure (a deleted log, a corrupt anchor).
	it("an invalid chain is BROKEN, even with no events and even if flagged empty", () => {
		expect(chainStatus({ ...chain, valid: false, empty: false })).toBe("broken");
		expect(chainStatus({ ...chain, valid: false, empty: true })).toBe("broken");
	});
});

describe("anchorView", () => {
	it("red-first ('absent', unexplained): says what the file is, that it is NOT verified here, and how to verify", () => {
		const shown = anchorView("absent");
		expect(shown.label).toBe("not present");
		expect(shown.explainer).toMatch(/only checks whether the file exists/);
		expect(shown.explainer).toMatch(/does not verify anchors/);
		expect(shown.explainer).toContain("usertrust verify --anchors <file> --pubkey <genesis.pem>");
		// red-first (no trust input): without --pubkey the CLI reports anchors unverifiable; the key is pinned outside
		expect(shown.explainer).toMatch(/pinned outside this vault, never one read from it/);
	});

	it("a present file is still not a verdict: the same explainer", () => {
		expect(anchorView("present")).toEqual({ ...anchorView("absent"), label: "present" });
	});
});

describe("costView", () => {
	it("red-first (estimated looked identical to provider-reported): an estimated cost is marked", () => {
		expect(costView(row({ costUt: 530, costUsd: 0.053, usageSource: "estimated" }))).toEqual({
			ut: "530 UT",
			usd: "$0.0530",
			estimated: true,
		});
	});

	it("a provider-reported cost, or one with no usage source, is not marked estimated", () => {
		expect(costView(row({ costUt: 412, usageSource: "provider" }))?.estimated).toBe(false);
		expect(costView(row({ costUt: 25 }))?.estimated).toBe(false);
	});

	it("no cost: nothing to show, never a 0", () => {
		expect(costView(row())).toBeNull();
	});
});

describe("usageView", () => {
	// Usage is estimated when the provider reported none, when a reported count is refused as implausible, or when the
	// caller supplied an estimate; the record does not say which. The inspector said "the provider reported none".
	it("red-first (a cause the record does not support): an estimate is named, never explained", () => {
		const shown = usageView(row({ costUt: 530, usageSource: "estimated" }));
		expect(shown).toEqual({ text: "estimated", tone: "info" });
		expect(`${shown.text} ${ESTIMATED_TITLE}`).not.toMatch(/reported none|no usage|did not report/);
	});

	it("provider-reported, or no source recorded", () => {
		expect(usageView(row({ costUt: 412, usageSource: "provider" }))).toEqual({
			text: "provider-reported",
			tone: "ink",
		});
		expect(usageView(row({ costUt: 25 }))).toEqual({ text: "source not recorded", tone: "na" });
	});
});

describe("transferView", () => {
	it("red-first (the event id shown under 'Tx'): a row with no transfer says so, never prints its event id", () => {
		const shown = transferView(row({ kind: "policy_denied" }));
		expect(shown).toEqual({ kind: "none" });
		expect(JSON.stringify(shown)).not.toContain("5d014ce0");
	});

	it("a row with a transfer shows the transfer id", () => {
		expect(transferView(row({ transferId: "tx_7c1e19e3" }))).toEqual({
			kind: "transfer",
			id: "tx_7c1e19e3",
		});
	});
});

describe("listState", () => {
	it("red-first ('no matching transactions — clear filters' while loading): loading is its own state", () => {
		expect(listState({ phase: "loading", chain: null, total: 0, shown: 0 })).toBe("loading");
		expect(listState({ phase: "loading", chain: "empty", total: 0, shown: 0 })).toBe("loading");
	});

	it("a loaded empty vault is the first-run state, not 'no matches'", () => {
		expect(listState({ phase: "loaded", chain: "empty", total: 0, shown: 0 })).toBe("first-run");
	});

	it("a broken vault with no rows is never shown as a first run", () => {
		expect(listState({ phase: "loaded", chain: "broken", total: 0, shown: 0 })).toBe("no-rows");
	});

	it("rows that the filters hide: filtered-out", () => {
		expect(listState({ phase: "loaded", chain: "verified", total: 20, shown: 0 })).toBe(
			"filtered-out",
		);
	});

	it("a failed load with nothing held says so; rows already held stay shown", () => {
		expect(listState({ phase: "failed", chain: null, total: 0, shown: 0 })).toBe("failed");
		expect(listState({ phase: "failed", chain: "verified", total: 5, shown: 5 })).toBe("rows");
		expect(listState({ phase: "loading", chain: "verified", total: 5, shown: 5 })).toBe("rows");
	});
});

describe("windowNotice", () => {
	it("red-first (a grey one-liner): the 100k window names what it limits", () => {
		const notice = windowNotice({
			truncated: true,
			rowCount: 100_000,
			chain: { events: 123_456, valid: true, empty: false, breakIndex: null, errors: [] },
		});
		expect(notice).toContain("newest");
		expect(notice).toContain((100_000).toLocaleString());
		expect(notice).toContain((123_456).toLocaleString());
		expect(notice).toMatch(/Filters, Trends and Export cover these only/);
	});

	it("no window: no notice", () => {
		expect(
			windowNotice({
				truncated: false,
				rowCount: 20,
				chain: { events: 20, valid: true, empty: false, breakIndex: null, errors: [] },
			}),
		).toBeNull();
	});
});

describe("verifiedAsOf: when the integrity verdict was last derived from a full read", () => {
	it("shows the instant of the last full read in the reader's local time", () => {
		const local = (d: Date): string => `local(${d.toISOString()})`;
		expect(verifiedAsOf("2026-10-13T09:15:00.000Z", local)).toBe(
			"verified as of local(2026-10-13T09:15:00.000Z)",
		);
	});

	it("says no full read has succeeded yet, never a time, when there is none", () => {
		expect(verifiedAsOf(null)).toBe("not yet read in full");
	});

	it("shows an unparseable value as it is, never as a made-up time", () => {
		expect(verifiedAsOf("not a time", () => "never")).toBe("verified as of not a time");
	});
});
