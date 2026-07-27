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

type Granularity = "day" | "hour";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Axis tick: `MM-DD` (day) / `MM-DD HH:mm` (hour). Buckets are UTC — format in UTC. */
function formatTickUtc(t: number, granularity: Granularity): string {
	const d = new Date(t);
	const md = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
	return granularity === "day" ? md : `${md} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** Tooltip label: reconstruct the full bucket string (`YYYY-MM-DD` / `YYYY-MM-DD HH:00`). */
function formatBucketUtc(t: number, granularity: Granularity): string {
	const d = new Date(t);
	const ymd = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
	return granularity === "day" ? ymd : `${ymd} ${pad2(d.getUTCHours())}:00`;
}

/** Display-only compaction of a full ISO timestamp: `YYYY-MM-DD HH:mm`. */
function formatIsoCompact(ts: string): string {
	return ts.slice(0, 16).replace("T", " ");
}

function Tile(props: { label: string; value: string; danger?: boolean }): React.JSX.Element {
	return (
		<div className="flex flex-1 flex-col gap-1 rounded border border-[var(--border)] bg-[var(--panel)] p-3">
			<span className="text-[10px] uppercase tracking-wide text-[var(--muted)] [font-family:var(--font-sans)]">
				{props.label}
			</span>
			<span
				className={`text-[18px] font-medium tabular-nums ${props.danger ? "text-[var(--danger)]" : ""}`}
			>
				{props.value}
			</span>
		</div>
	);
}

function BarList(props: { title: string; totals: KeyTotal[] }): React.JSX.Element {
	const max = props.totals[0]?.costUt ?? 1;
	return (
		<div className="flex flex-col gap-2 rounded border border-[var(--border)] bg-[var(--panel)] p-3">
			<h3 className="text-[10px] uppercase tracking-wide text-[var(--muted)] [font-family:var(--font-sans)]">
				{props.title}
			</h3>
			{props.totals.slice(0, 8).map((t) => (
				<div key={t.key} className="flex items-center gap-2 text-xs">
					<span className="w-36 truncate" title={t.key}>
						{t.key}
					</span>
					<div className="h-1 flex-1 rounded-[1px] bg-[var(--bg)]">
						<div
							className="h-1 rounded-[1px] bg-[var(--chart)]"
							style={{ width: `${max > 0 ? (t.costUt / max) * 100 : 0}%` }}
						/>
					</div>
					<span className="w-28 shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-[var(--muted)]">
						{t.costUt.toLocaleString()} UT · {t.count}×
					</span>
				</div>
			))}
			{props.totals.length > 8 && (
				<span className="text-[10px] text-[var(--faint)]">top 8 of {props.totals.length}</span>
			)}
			{props.totals.length === 0 && (
				<span className="text-xs text-[var(--faint)]">no data in filter</span>
			)}
		</div>
	);
}

export function Trends(props: { rows: LedgerRow[] }): React.JSX.Element {
	const [granularity, setGranularity] = useState<Granularity>("day");
	const series = useMemo(
		() =>
			spendOverTime(props.rows, granularity)
				.map((b) => ({
					...b,
					t: Date.parse(
						granularity === "day" ? `${b.bucket}T00:00:00Z` : `${b.bucket.replace(" ", "T")}:00Z`,
					),
				}))
				.filter((b) => !Number.isNaN(b.t)),
		[props.rows, granularity],
	);
	const tiles = useMemo(() => statTiles(props.rows), [props.rows]);
	const window = useMemo(() => {
		let first: string | undefined;
		let last: string | undefined;
		for (const r of props.rows) {
			if (first === undefined || r.ts < first) first = r.ts;
			if (last === undefined || r.ts > last) last = r.ts;
		}
		return first !== undefined && last !== undefined ? { first, last } : undefined;
	}, [props.rows]);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
			<div className="flex gap-3">
				<Tile label="Total spend" value={`${tiles.totalCostUt.toLocaleString()} UT`} />
				<Tile label="Events" value={tiles.calls.toLocaleString()} />
				<Tile label="Avg cost" value={`${tiles.avgCostUt.toFixed(1)} UT`} />
				<Tile
					label="Error rate"
					value={`${(tiles.errorRate * 100).toFixed(1)}%`}
					danger={tiles.errorRate > 0}
				/>
			</div>
			<div className="reveal reveal-3 flex flex-col gap-3">
				<div className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
					<div className="mb-2 flex items-center justify-between">
						<h3 className="text-[10px] uppercase tracking-wide text-[var(--muted)] [font-family:var(--font-sans)]">
							Spend over time
						</h3>
						<div className="flex gap-1">
							{(["day", "hour"] as const).map((g) => (
								<button
									key={g}
									type="button"
									aria-pressed={granularity === g}
									onClick={() => setGranularity(g)}
									className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${granularity === g ? "bg-[var(--panel-2)] text-[var(--text)]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}
								>
									{g}
								</button>
							))}
						</div>
					</div>
					{series.length === 0 ? (
						<div className="flex h-[240px] items-center justify-center text-xs text-[var(--faint)]">
							no data in filter
						</div>
					) : (
						<ResponsiveContainer width="100%" height={240}>
							<BarChart data={series}>
								<CartesianGrid stroke="var(--border)" strokeOpacity={0.4} vertical={false} />
								<XAxis
									dataKey="t"
									type="number"
									scale="time"
									domain={["dataMin", "dataMax"]}
									padding={{ left: 16, right: 16 }}
									tickFormatter={(t: number) => formatTickUtc(t, granularity)}
									tick={{ fill: "var(--muted)", fontSize: 10, fontFamily: "var(--font-mono)" }}
									tickLine={false}
									axisLine={{ stroke: "var(--border)" }}
								/>
								<YAxis
									width={44}
									tickFormatter={(v: number) => v.toLocaleString()}
									tick={{ fill: "var(--muted)", fontSize: 10, fontFamily: "var(--font-mono)" }}
									tickLine={false}
									axisLine={false}
								/>
								<Tooltip
									cursor={{ fill: "var(--panel-2)" }}
									contentStyle={{
										background: "var(--panel-2)",
										border: "1px solid var(--border)",
										borderRadius: 6,
										boxShadow: "var(--shadow)",
										fontFamily: "var(--font-mono)",
										fontSize: 11,
									}}
									labelStyle={{ color: "var(--muted)" }}
									itemStyle={{ color: "var(--text)" }}
									labelFormatter={(label) => formatBucketUtc(Number(label), granularity)}
									formatter={(value) => [`${Number(value).toLocaleString()} UT`, "cost"]}
								/>
								<Bar
									dataKey="costUt"
									name="cost"
									fill="var(--chart)"
									barSize={12}
									radius={[2, 2, 0, 0]}
								/>
							</BarChart>
						</ResponsiveContainer>
					)}
				</div>
				<div className="grid grid-cols-2 gap-3">
					<BarList title="Cost by task type" totals={costByKind(props.rows)} />
					<BarList title="Cost by model" totals={costByModel(props.rows)} />
				</div>
				<div className="pb-2 text-[11px] text-[var(--faint)]">
					{props.rows.length.toLocaleString()} events
					{window &&
						` · window ${formatIsoCompact(window.first)} — ${formatIsoCompact(window.last)}`}
				</div>
			</div>
		</div>
	);
}
