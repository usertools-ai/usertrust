// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useMemo } from "react";
import { EMPTY_FILTERS, type FilterState, isFiltering } from "../shared/filters.js";
import { type LedgerRow, statusOf } from "../shared/rows.js";

function distinct(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((v): v is string => v !== undefined))].sort();
}

function FacetSelect(props: {
	label: string;
	options: string[];
	selected: string[];
	onChange(next: string[]): void;
}): React.JSX.Element {
	return (
		<label className="flex items-center gap-1 text-xs text-[var(--muted)]">
			{props.label}
			<select
				multiple
				value={props.selected}
				onChange={(e) => props.onChange([...e.currentTarget.selectedOptions].map((o) => o.value))}
				className="max-w-40 rounded border border-[var(--border)] bg-[var(--panel)] p-1 text-[var(--text)]"
			>
				{props.options.map((o) => (
					<option key={o} value={o}>
						{o}
					</option>
				))}
			</select>
		</label>
	);
}

export function FilterBar(props: {
	rows: LedgerRow[];
	filters: FilterState;
	onChange(f: FilterState): void;
}): React.JSX.Element {
	const { rows, filters, onChange } = props;
	const kinds = useMemo(() => distinct(rows.map((r) => r.kind)), [rows]);
	const models = useMemo(() => distinct(rows.map((r) => r.model)), [rows]);
	const actors = useMemo(() => distinct(rows.map((r) => r.actor)), [rows]);
	const statuses = useMemo(() => distinct(rows.map((r) => statusOf(r))), [rows]);

	const chips: Array<{ label: string; clear(): void }> = [];
	for (const k of filters.kinds)
		chips.push({
			label: `kind: ${k}`,
			clear: () => onChange({ ...filters, kinds: filters.kinds.filter((x) => x !== k) }),
		});
	for (const m of filters.models)
		chips.push({
			label: `model: ${m}`,
			clear: () => onChange({ ...filters, models: filters.models.filter((x) => x !== m) }),
		});
	for (const a of filters.actors)
		chips.push({
			label: `actor: ${a}`,
			clear: () => onChange({ ...filters, actors: filters.actors.filter((x) => x !== a) }),
		});
	for (const s of filters.statuses)
		chips.push({
			label: `status: ${s}`,
			clear: () => onChange({ ...filters, statuses: filters.statuses.filter((x) => x !== s) }),
		});
	if (filters.from)
		chips.push({
			label: `from: ${filters.from}`,
			clear: () => onChange({ ...filters, from: undefined }),
		});
	if (filters.to)
		chips.push({
			label: `to: ${filters.to}`,
			clear: () => onChange({ ...filters, to: undefined }),
		});
	if (filters.costMin !== undefined)
		chips.push({
			label: `cost ≥ ${filters.costMin}`,
			clear: () => onChange({ ...filters, costMin: undefined }),
		});
	if (filters.costMax !== undefined)
		chips.push({
			label: `cost ≤ ${filters.costMax}`,
			clear: () => onChange({ ...filters, costMax: undefined }),
		});

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-3">
				<input
					type="search"
					placeholder="Search transactions…"
					value={filters.search}
					onChange={(e) => onChange({ ...filters, search: e.currentTarget.value })}
					className="w-64 rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-sm"
				/>
				<FacetSelect
					label="kind"
					options={kinds}
					selected={filters.kinds}
					onChange={(v) => onChange({ ...filters, kinds: v })}
				/>
				<FacetSelect
					label="model"
					options={models}
					selected={filters.models}
					onChange={(v) => onChange({ ...filters, models: v })}
				/>
				<FacetSelect
					label="actor"
					options={actors}
					selected={filters.actors}
					onChange={(v) => onChange({ ...filters, actors: v })}
				/>
				<FacetSelect
					label="status"
					options={statuses}
					selected={filters.statuses}
					onChange={(v) => onChange({ ...filters, statuses: v })}
				/>
				<input
					type="date"
					value={filters.from ?? ""}
					onChange={(e) => onChange({ ...filters, from: e.currentTarget.value || undefined })}
					className="rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-1 text-xs"
				/>
				<input
					type="date"
					value={filters.to ?? ""}
					onChange={(e) => onChange({ ...filters, to: e.currentTarget.value || undefined })}
					className="rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-1 text-xs"
				/>
				<input
					type="number"
					placeholder="min UT"
					value={filters.costMin ?? ""}
					onChange={(e) =>
						onChange({
							...filters,
							costMin: e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value),
						})
					}
					className="w-20 rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-1 text-xs"
				/>
				<input
					type="number"
					placeholder="max UT"
					value={filters.costMax ?? ""}
					onChange={(e) =>
						onChange({
							...filters,
							costMax: e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value),
						})
					}
					className="w-20 rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-1 text-xs"
				/>
			</div>
			{isFiltering(filters) && (
				<div className="flex flex-wrap items-center gap-1">
					{chips.map((c) => (
						<button
							key={c.label}
							type="button"
							onClick={c.clear}
							className="rounded-full border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-xs text-[var(--muted)]"
						>
							{c.label} ✕
						</button>
					))}
					<button
						type="button"
						onClick={() => onChange(EMPTY_FILTERS)}
						className="px-2 text-xs text-[var(--accent)]"
					>
						clear all
					</button>
				</div>
			)}
		</div>
	);
}
