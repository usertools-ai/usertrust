// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
	costByKind,
	costByModel,
	type KeyTotal,
	spendOverTime,
	statTiles,
} from "../shared/aggregate.js";
import type { LedgerRow } from "../shared/rows.js";

function Tile(props: { label: string; value: string }): React.JSX.Element {
	return (
		<div className="flex flex-1 flex-col rounded border border-[var(--border)] bg-[var(--panel)] p-3">
			<span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{props.label}</span>
			<span className="text-lg font-semibold">{props.value}</span>
		</div>
	);
}

function BarList(props: { title: string; totals: KeyTotal[] }): React.JSX.Element {
	const max = props.totals[0]?.costUt ?? 1;
	return (
		<div className="flex flex-1 flex-col gap-2 rounded border border-[var(--border)] bg-[var(--panel)] p-3">
			<h3 className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
				{props.title}
			</h3>
			{props.totals.slice(0, 8).map((t) => (
				<div key={t.key} className="flex items-center gap-2 text-xs">
					<span className="w-36 truncate">{t.key}</span>
					<div className="h-2 flex-1 rounded bg-[var(--bg)]">
						<div
							className="h-2 rounded bg-[var(--accent)]"
							style={{ width: `${max > 0 ? (t.costUt / max) * 100 : 0}%` }}
						/>
					</div>
					<span className="w-20 text-right text-[var(--muted)]">
						{t.costUt} UT · {t.count}
					</span>
				</div>
			))}
			{props.totals.length === 0 && (
				<span className="text-xs text-[var(--muted)]">no data in filter</span>
			)}
		</div>
	);
}

export function Trends(props: { rows: LedgerRow[] }): React.JSX.Element {
	const [granularity, setGranularity] = useState<"day" | "hour">("day");
	const series = useMemo(() => spendOverTime(props.rows, granularity), [props.rows, granularity]);
	const tiles = useMemo(() => statTiles(props.rows), [props.rows]);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
			<div className="flex gap-3">
				<Tile label="Total spend" value={`${tiles.totalCostUt.toLocaleString()} UT`} />
				<Tile label="Events" value={tiles.calls.toLocaleString()} />
				<Tile label="Avg cost" value={`${tiles.avgCostUt.toFixed(1)} UT`} />
				<Tile label="Error rate" value={`${(tiles.errorRate * 100).toFixed(1)}%`} />
			</div>
			<div className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
				<div className="mb-2 flex items-center justify-between">
					<h3 className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
						Spend over time
					</h3>
					<div className="flex gap-1 text-xs">
						{(["day", "hour"] as const).map((g) => (
							<button
								key={g}
								type="button"
								onClick={() => setGranularity(g)}
								className={`rounded px-2 py-0.5 ${granularity === g ? "bg-[var(--bg)] text-[var(--text)]" : "text-[var(--muted)]"}`}
							>
								{g}
							</button>
						))}
					</div>
				</div>
				<ResponsiveContainer width="100%" height={220}>
					<BarChart data={series}>
						<CartesianGrid stroke="var(--border)" vertical={false} />
						<XAxis dataKey="bucket" stroke="var(--muted)" fontSize={10} />
						<YAxis stroke="var(--muted)" fontSize={10} />
						<Tooltip
							contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)" }}
						/>
						<Bar dataKey="costUt" fill="var(--accent)" radius={[2, 2, 0, 0]} />
					</BarChart>
				</ResponsiveContainer>
			</div>
			<div className="flex gap-3">
				<BarList title="Cost by task type" totals={costByKind(props.rows)} />
				<BarList title="Cost by model" totals={costByModel(props.rows)} />
			</div>
		</div>
	);
}
