// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * "verified" is printed for an explicit, anchored pass and nothing else. The summary's integrity pill, every row and
 * the inspector's chain pill each said "verified" for the hash links being intact, which a log cut short and
 * rewritten to match also is, and the inspector's check showed a green VERIFIED under a receipt that printed
 * UNANCHORED. Each test here renders the component as the browser gets it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SummaryPayload } from "../src/shared/api.js";
import type { LedgerRow } from "../src/shared/rows.js";
import type { VerifyOutcome } from "../src/shared/verify-view.js";

// The components are .tsx files, which the tests' tsconfig (no `jsx`) cannot resolve statically: load them by a
// computed path, typed here by what the tests use.
type Component<P> = (props: P) => React.JSX.Element;
async function app<T>(file: string): Promise<T> {
	return (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as T;
}
const summaryStrip = async () =>
	(
		await app<{ SummaryStrip: Component<{ summary: SummaryPayload | null; live: "live" }> }>(
			"summary-strip",
		)
	).SummaryStrip;
const auditTable = async () =>
	(await app<{ Row: Component<{ row: LedgerRow }> }>("audit-table")).Row;
const rowPanel = async () =>
	app<{
		RowPanel: Component<{ row: LedgerRow; docked: boolean; onClose(): void }>;
		VerifyResult: Component<{ outcome: VerifyOutcome | null }>;
	}>("row-panel");

/** The text a reader sees, tags removed. Attribute values (titles) are checked separately where they matter. */
const text = (html: string): string => html.replace(/<[^>]*>/g, "");

function summary(over: Partial<SummaryPayload> = {}): SummaryPayload {
	return {
		vaultPath: "/v/.usertrust",
		budget: null,
		budgetSource: "unpublished",
		budgetWrittenAt: null,
		budgetProvenance: "unknown: none published",
		spentUt: 100,
		remainingUt: null,
		chain: { events: 3, valid: true, empty: false, breakIndex: null, errors: [] },
		anchorFile: "absent",
		remote: { kit: false },
		rowCount: 3,
		truncated: false,
		verifiedAt: "2026-10-13T09:15:00.000Z",
		...over,
	};
}

function row(over: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: "e1",
		ts: "2026-10-12T17:59:02.770Z",
		kind: "llm_call",
		actor: "local",
		model: "claude-sonnet-4-6",
		transferId: "tx_1",
		status: "settled",
		costUt: 5,
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		...over,
	};
}

describe("summary integrity pill: chained, never verified", () => {
	it("an intact chain with no anchor file reads chained, green, with 'hash links only · not anchored' under it", async () => {
		const html = renderToStaticMarkup(
			createElement(await summaryStrip(), { summary: summary(), live: "live" }),
		);
		expect(html).toMatch(
			/<span class="ut-pill" data-tone="approve" title="[^"]*"><i><\/i>chained<\/span>/,
		);
		expect(text(html)).toContain("hash links only · not anchored");
		expect(html.toLowerCase()).not.toContain("verified");
	});

	it("with an anchor file present the pill still reads chained, and the not-anchored line is gone", async () => {
		const html = renderToStaticMarkup(
			createElement(await summaryStrip(), {
				summary: summary({ anchorFile: "present" }),
				live: "live",
			}),
		);
		expect(text(html)).toContain("chained");
		expect(text(html)).not.toContain("not anchored");
		expect(html.toLowerCase()).not.toContain("verified");
	});

	it("the pill's hover text says what it covers, without 'verified'", async () => {
		const html = renderToStaticMarkup(
			createElement(await summaryStrip(), { summary: summary(), live: "live" }),
		);
		const title = /data-tone="approve" title="([^"]*)"/.exec(html)?.[1];
		expect(title).toBe("Every hash link in the vault is intact. This is not an anchored check.");
	});

	it("a broken chain keeps its red broken pill", async () => {
		const html = renderToStaticMarkup(
			createElement(await summaryStrip(), {
				summary: summary({
					chain: {
						events: 3,
						valid: false,
						empty: false,
						breakIndex: 1,
						errors: ["hash mismatch"],
					},
				}),
				live: "live",
			}),
		);
		expect(html).toContain('<span class="ut-pill" data-tone="stakes"><i></i>broken</span>');
		expect(text(html)).not.toContain("chained");
	});
});

describe("audit rows: no mark while intact, '⚠ after break' after a break", () => {
	it("an intact row carries no integrity mark at all", async () => {
		const html = renderToStaticMarkup(createElement(await auditTable(), { row: row() }));
		expect(html.toLowerCase()).not.toContain("verified");
		expect(html).not.toContain("✓");
		expect(html).not.toContain("after break");
	});

	it("a row after a break reads '⚠ after break' in the break colour", async () => {
		const html = renderToStaticMarkup(
			createElement(await auditTable(), { row: row({ integrity: "after-break" }) }),
		);
		expect(html).toContain('<span class="bad">⚠ after break</span>');
	});
});

describe("inspector chain pill", () => {
	it("an intact row reads 'chained up to here', its hover text saying every link up to it is intact", async () => {
		const { RowPanel } = await rowPanel();
		const html = renderToStaticMarkup(
			createElement(RowPanel, { row: row(), docked: true, onClose: () => {} }),
		);
		expect(html).toContain(
			'title="every hash link up to this record is intact"><i></i>chained up to here</span>',
		);
		expect(html.toLowerCase()).not.toContain("verified");
		expect(text(html)).not.toMatch(/independent/i);
	});

	it("a row after a break reads 'after break'", async () => {
		const { RowPanel } = await rowPanel();
		const html = renderToStaticMarkup(
			createElement(RowPanel, {
				row: row({ integrity: "after-break" }),
				docked: true,
				onClose: () => {},
			}),
		);
		expect(html).toContain('<span class="ut-pill" data-tone="stakes"><i></i>after break</span>');
		expect(html).not.toContain("chained up to here");
	});
});

describe("the explicit check: the verdict above the receipt, verified only for an anchored pass", () => {
	const RECEIPT = "┌──┐\n│  Merkle .. X │\n└──┘";
	const verdictAt = (html: string): number => html.indexOf('class="ut-verdict"');
	const receiptAt = (html: string): number => html.indexOf('class="ut-receipt"');

	it("an anchored pass: a green 'verified', above the receipt", async () => {
		const { VerifyResult } = await rowPanel();
		const html = renderToStaticMarkup(
			createElement(VerifyResult, { outcome: { kind: "verified", receipt: RECEIPT } }),
		);
		expect(html).toContain('<span class="ut-pill" data-tone="approve"><i></i>verified</span>');
		expect(verdictAt(html)).toBeGreaterThanOrEqual(0);
		expect(verdictAt(html)).toBeLessThan(receiptAt(html));
	});

	it("an UNANCHORED pass: 'consistent, unanchored' in the neutral routine colour, above the receipt, never 'verified'", async () => {
		const { VerifyResult } = await rowPanel();
		const html = renderToStaticMarkup(
			createElement(VerifyResult, {
				outcome: { kind: "consistent-unanchored", receipt: RECEIPT },
			}),
		);
		// No data-tone: the neutral colour a routine state (settled) has, not the green of a pass.
		expect(html).toContain('<span class="ut-pill"><i></i>consistent, unanchored</span>');
		expect(html).not.toContain('data-tone="approve"');
		expect(html.toLowerCase()).not.toContain("verified");
		expect(verdictAt(html)).toBeLessThan(receiptAt(html));
	});

	it("a failed check keeps its red 'failed' and its reason", async () => {
		const { VerifyResult } = await rowPanel();
		const html = renderToStaticMarkup(
			createElement(VerifyResult, {
				outcome: { kind: "failed", receipt: RECEIPT, reason: "hash mismatch" },
			}),
		);
		expect(html).toContain('<span class="ut-pill" data-tone="stakes"><i></i>failed</span>');
		expect(text(html)).toContain("hash mismatch");
		expect(verdictAt(html)).toBeLessThan(receiptAt(html));
	});

	it("before any result the live region is already there, empty, so the verdict is announced when it lands", async () => {
		const { VerifyResult } = await rowPanel();
		const html = renderToStaticMarkup(createElement(VerifyResult, { outcome: null }));
		expect(html).toBe('<div aria-live="polite"></div>');
	});
});
