// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the Ledger window adds under an open record's status: a note when its hour was unusual, and its cost as a
 * share of the budget with where that budget came from; then the record's actions.
 */

import { useMemo } from "react";
import { toggleOnly } from "../../../shared/filter-chips.js";
import type { FilterState } from "../../../shared/filters.js";
import { type BudgetView, budgetShare, unusualNote } from "../../../shared/peek.js";
import type { LedgerRow } from "../../../shared/rows.js";

export function PeekExtra(props: {
	row: LedgerRow;
	rows: readonly LedgerRow[];
	budget: BudgetView;
}): React.JSX.Element | null {
	const { row, rows, budget } = props;
	const unusual = useMemo(() => unusualNote(rows, row), [rows, row]);
	const share = budgetShare(row.costUt, budget.ut);
	// The source is empty while nothing is loaded: then there is no budget to name, and no line about one. A record
	// with no cost has no share to put a budget beside, and nor has one whose cost is not a cost (below 0, not a
	// number). Which costs those are is the share's own answer, asked against a budget of 1 so that an unknown
	// budget, which still has a source to show, is not taken for a missing cost.
	const costed = budgetShare(row.costUt, 1) !== null;
	const source =
		!costed || budget.provenance === ""
			? null
			: `Budget: ${budget.provenance}${budget.note === null ? "" : ` (${budget.note})`}.`;
	if (unusual === null && share === null && source === null) return null;
	return (
		<div className="ut-lg-extra">
			{unusual !== null && (
				<p className="ut-lg-unusual" role="note">
					{unusual.text}
				</p>
			)}
			{(share !== null || source !== null) && (
				<p className="ut-lg-share">
					{share !== null && `${share}. `}
					{source !== null && <span className="prov">{source}</span>}
				</p>
			)}
		</div>
	);
}

/**
 * The record's actions: put it on the Spend chart as the pin, or keep only its lane or its model in the filters (a
 * second press, when that value is already the facet's only one, clears the facet). A lane or model with no name
 * gets no button.
 */
export function PeekActions(props: {
	row: LedgerRow;
	filters: FilterState;
	onPin(pos: number): void;
	onFilters(f: FilterState): void;
}): React.JSX.Element {
	const { row, filters, onPin, onFilters } = props;
	const { actor, model } = row;
	return (
		<div className="ut-lg-actions">
			<button type="button" className="ut-t3" onClick={() => onPin(row.pos)}>
				Show on chart
			</button>
			{actor.trim() !== "" && (
				<button
					type="button"
					className="ut-t3"
					onClick={() => onFilters(toggleOnly(filters, "actors", actor))}
				>
					{`Only ${actor}`}
				</button>
			)}
			{model !== undefined && model.trim() !== "" && (
				<button
					type="button"
					className="ut-t3"
					onClick={() => onFilters(toggleOnly(filters, "models", model))}
				>
					{`Only ${model}`}
				</button>
			)}
		</div>
	);
}
