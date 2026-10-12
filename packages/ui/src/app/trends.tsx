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
import { formatUsd, formatUt } from "../shared/format.js";
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

/** Tooltip label: the full bucket, with its zone (`YYYY-MM-DD` / `YYYY-MM-DD HH:00Z`). */
function formatBucketUtc(t: number, granularity: Granularity): string {
	const d = new Date(t);
	const ymd = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
	return granularity === "day" ? `${ymd} (UTC)` : `${ymd} ${pad2(d.getUTCHours())}:00Z`;
}

/** Display-only compaction of a full ISO timestamp: `YYYY-MM-DD HH:mmZ`. */
function formatIsoCompact(ts: string): string {
	return `${ts.slice(0, 16).replace("T", " ")}Z`;
}

function Tile(props: {
	label: string;
	value: string;
	sub: string;
	tone?: "red" | "alert";
}): React.JSX.Element {
	return (
		<div className="ut-tile">
			<span className="ut-tile-h">{props.label}</span>
			<span className={`ut-tile-main${props.tone ? ` ${props.tone}` : ""}`}>{props.value}</span>
			<span className="ut-sub">{props.sub}</span>
		</div>
	);
}

function BarList(props: { title: string; totals: KeyTotal[] }): React.JSX.Element {
	const max = props.totals[0]?.costUt ?? 1;
	return (
		<div className="ut-card">
			<span className="ut-tile-h">{props.title}</span>
			<div className="ut-blist">
				{props.totals.slice(0, 8).map((t) => (
					<div key={t.key} style={{ display: "contents" }}>
						<span className="k" title={t.key}>
							{t.key}
						</span>
						<span className="v">
							{formatUt(t.costUt)} · {t.count}×
						</span>
						<div className="ut-meter">
							<i style={{ width: `${max > 0 ? (t.costUt / max) * 100 : 0}%` }} />
						</div>
					</div>
				))}
			</div>
			{props.totals.length > 8 && <span className="ut-sub">top 8 of {props.totals.length}</span>}
			{props.totals.length === 0 && <span className="ut-why">No costed records in view.</span>}
		</div>
	);
}

export function Trends(props: {
	/** The rows in view, after the filters. */
	rows: LedgerRow[];
	/** The server's row window, when it holds only the newest N events. */
	newestOf: number | undefined;
}): React.JSX.Element {
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
	// Everything here is the rows in view: never the vault, when the server holds a window of it.
	const scope =
		props.newestOf === undefined
			? "in view"
			: `in view, of the newest ${props.newestOf.toLocaleString()}`;

	return (
		<div className="ut-trends">
			<div className="ut-tiles">
				{/* Every costed record in view: an action's cost, an ambiguity's. The header's Spend is llm_call records
				    only, over the whole vault, and is labelled as that: two rules, each named. */}
				<Tile
					label="Cost in view"
					value={formatUt(tiles.totalCostUt)}
					sub={`${formatUsd(tiles.totalCostUt)} · every costed record`}
				/>
				<Tile
					label="Records"
					value={tiles.calls.toLocaleString()}
					sub={`${tiles.costed.toLocaleString()} with a cost · ${scope}`}
				/>
				<Tile
					label="Avg cost"
					value={`${tiles.avgCostUt.toFixed(1)} UT`}
					sub={`per costed record (${tiles.costed.toLocaleString()})`}
				/>
				<Tile
					label="Failed"
					value={`${(tiles.errorRate * 100).toFixed(1)}%`}
					sub={`${tiles.byStatus.failed.toLocaleString()} of ${tiles.calls.toLocaleString()} records`}
					{...(tiles.errorRate > 0 ? { tone: "red" as const } : {})}
				/>
				{/* Money states and unknowns are COUNTED where an operator looks, never folded into another number. */}
				<Tile
					label="Unrecoverable"
					value={tiles.byStatus.unrecoverable.toLocaleString()}
					sub="ran and recorded, not charged"
					{...(tiles.byStatus.unrecoverable > 0 ? { tone: "alert" as const } : {})}
				/>
				<Tile
					label="Ambiguous"
					value={tiles.byStatus.ambiguous.toLocaleString()}
					sub="settlement not confirmed"
				/>
				<Tile
					label="Unknown"
					value={tiles.byStatus.unknown.toLocaleString()}
					sub="no outcome recorded"
				/>
			</div>
			<div className="ut-card">
				<div className="ut-card-h">
					<span className="ut-tile-h">Cost over time · UTC</span>
					<div className="ut-seg small" role="tablist" aria-label="bucket size">
						{(["day", "hour"] as const).map((g) => (
							<button
								key={g}
								type="button"
								role="tab"
								aria-selected={granularity === g}
								onClick={() => setGranularity(g)}
							>
								{g === "day" ? "By day" : "By hour"}
							</button>
						))}
					</div>
				</div>
				{series.length === 0 ? (
					<div className="ut-empty">
						<b>No records in view</b>
					</div>
				) : (
					<ResponsiveContainer width="100%" height={240}>
						<BarChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
							<CartesianGrid stroke="var(--line)" vertical={false} />
							<XAxis
								dataKey="t"
								type="number"
								scale="time"
								domain={["dataMin", "dataMax"]}
								padding={{ left: 16, right: 16 }}
								tickFormatter={(t: number) => formatTickUtc(t, granularity)}
								tick={{ fill: "var(--body)", fontSize: 10.5, fontFamily: "var(--mono)" }}
								tickLine={false}
								axisLine={{ stroke: "var(--line)" }}
							/>
							<YAxis
								width={48}
								tickFormatter={(v: number) => v.toLocaleString()}
								tick={{ fill: "var(--body)", fontSize: 10.5, fontFamily: "var(--mono)" }}
								tickLine={false}
								axisLine={false}
							/>
							<Tooltip
								cursor={{ fill: "rgba(155, 123, 255, 0.08)" }}
								contentStyle={{
									background: "var(--raised)",
									border: "1px solid var(--line)",
									borderRadius: 10,
									boxShadow: "var(--shadow)",
									fontFamily: "var(--mono)",
									fontSize: 11.5,
								}}
								labelStyle={{ color: "var(--body)" }}
								itemStyle={{ color: "var(--ink)" }}
								labelFormatter={(label) => formatBucketUtc(Number(label), granularity)}
								formatter={(value) => [formatUt(Number(value)), "cost"]}
							/>
							<Bar
								dataKey="costUt"
								name="cost"
								fill="var(--intel)"
								barSize={12}
								radius={[2, 2, 0, 0]}
							/>
						</BarChart>
					</ResponsiveContainer>
				)}
			</div>
			<div className="ut-split">
				<BarList title="Cost by kind" totals={costByKind(props.rows)} />
				<BarList title="Cost by model" totals={costByModel(props.rows)} />
			</div>
			<div className="ut-sub mono">
				{props.rows.length.toLocaleString()} records {scope}
				{window && ` · ${formatIsoCompact(window.first)} to ${formatIsoCompact(window.last)}`}
			</div>
		</div>
	);
}
