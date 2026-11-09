// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the day-one window tests share: a few records (one of them an ambiguous charge), a summary, and the loader for
 * an app component by a computed path (the tests' tsconfig has no `jsx`, so a `.tsx` file cannot be imported statically).
 */

import type { PersistedAuditEvent } from "usertrust";
import type { DeskData } from "../../src/app/desk/desk-types.js";
import type { SummaryPayload } from "../../src/shared/api.js";
import { EMPTY_FILTERS } from "../../src/shared/filters.js";
import { listView } from "../../src/shared/list-view.js";
import { type LedgerRow, toLedgerRows } from "../../src/shared/rows.js";
import { defaultDeskData } from "./desk.js";

export type Component<P> = (props: P) => React.JSX.Element;

/** The default export-by-name of an app module, loaded by a computed path. */
export async function appExport<T>(path: string, name: string): Promise<T> {
	const mod = (await import(/* @vite-ignore */ `../../src/app/${path}.js`)) as Record<string, T>;
	return mod[name] as T;
}

/** Markup with React's generated ids (useId) replaced, so the same component drawn at two places in a tree compares equal. */
export function noIds(html: string): string {
	return html.replace(/_R_[a-z0-9]+_/g, "_ID_");
}

function evt(n: number, kind: string, cost: number, data: object = {}): PersistedAuditEvent {
	return {
		id: `id-${n}`,
		timestamp: `2026-11-0${n}T10:00:00.000Z`,
		previousHash: "0".repeat(64),
		hash: String(n).repeat(64).slice(0, 64),
		kind,
		actor: "local",
		data: { cost, model: "claude-sonnet-5", ...data },
		sequence: n,
	};
}

/** Three records: two settled calls and an ambiguous charge. */
export function dayOneRows(): LedgerRow[] {
	return toLedgerRows(
		[
			evt(1, "llm_call", 1_500),
			evt(2, "llm_call", 28_000),
			evt(3, "settlement_ambiguous", 400, { transferId: "t3" }),
		],
		{ valid: true, breakIndex: null },
		undefined,
		0,
	);
}

export function dayOneSummary(over: Partial<SummaryPayload> = {}): SummaryPayload {
	return {
		vaultPath: "/v/.usertrust",
		budget: 1_000_000,
		budgetSource: "config",
		budgetWrittenAt: null,
		budgetProvenance: "from the vault config",
		spentUt: 123_400,
		remainingUt: 876_600,
		chain: { events: 3, valid: true, empty: false, breakIndex: null, errors: [] },
		anchorFile: "absent",
		remote: { kit: false },
		rowCount: 3,
		truncated: false,
		verifiedAt: "2026-11-03T09:15:00.000Z",
		...over,
	};
}

/** The desk's data holding the three records and a summary. */
export function loadedData(over: Partial<DeskData> = {}): Partial<DeskData> {
	const rows = dayOneRows();
	const summary = dayOneSummary();
	return {
		rows,
		summary,
		head: 2,
		list: listView({ rows, at: null, filters: EMPTY_FILTERS, phase: "loaded", summary }),
		...over,
	};
}

/** `defaultDeskData` is re-exported so a window test needs one import for its fixtures. */
export { defaultDeskData };
