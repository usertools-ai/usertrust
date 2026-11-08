// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { memo, useId, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
	costByJobType,
	costByKind,
	costByModel,
	spendOverTime,
	statTiles,
	timeWindow,
} from "../shared/aggregate.js";
import type { AtPayload } from "../shared/api.js";
import { type ChartSummary, chartSummary } from "../shared/chart-summary.js";
import {
	formatUsd,
	formatUsdAxis,
	formatUt,
	formatUtcMinute,
	UT_KEY,
	Y_AXIS_ALLOW_DECIMALS,
} from "../shared/format.js";
import { JOB_TYPE_CAVEAT, type LedgerRow } from "../shared/rows.js";
import { shownLabel } from "../shared/timeline-view.js";
import { BarList } from "./bar-list.js";
import { TickingFigure } from "./ticking-figure.js";

type Granularity = "day" | "hour";

/**
 * The chart's figures as a table, and the button that shows it. Hidden, the table is still read by a screen reader
 * (the chart's SVG is not); shown, it is there for anyone who cannot hover a 12px bar, a keyboard user included: the
 * chart itself has no keyboard route. The button is a disclosure (`aria-expanded`, `aria-controls` the table).
 */
export function ChartTable(props: {
	summary: ChartSummary;
	shown: boolean;
	onToggle(): void;
}): React.JSX.Element {
	const id = useId();
	return (
		<>
			<div className="ut-chart-foot">
				<button
					type="button"
					className="ut-btn"
					aria-expanded={props.shown}
					aria-controls={id}
					onClick={props.onToggle}
				>
					{props.shown ? "Hide table" : "Show table"}
				</button>
			</div>
			<table id={id} className={props.shown ? "ut-chart-table" : "ut-sr-only"}>
				<caption>{props.summary.caption}</caption>
				<thead>
					<tr>
						<th scope="col">Bucket</th>
						<th scope="col">Cost (USD)</th>
						<th scope="col">Cost (UT)</th>
					</tr>
				</thead>
				<tbody>
					{props.summary.rows.map((r) => (
						<tr key={r.label}>
							<th scope="row">{r.label}</th>
							<td>{r.usd}</td>
							<td>{r.ut}</td>
						</tr>
					))}
				</tbody>
			</table>
		</>
	);
}

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

function Tile(props: {
	label: string;
	/** A string, or a figure that renders itself (the cost total counts to a new value). */
	value: React.ReactNode;
	sub: string;
	tone?: "red" | "alert";
	/** The exact figure, on hover, behind a rounded one. */
	valueTitle?: string;
}): React.JSX.Element {
	return (
		<div className="ut-tile">
			<span className="ut-tile-h">{props.label}</span>
			<span
				className={`ut-tile-main${props.tone ? ` ${props.tone}` : ""}`}
				title={props.valueTitle}
			>
				{props.value}
			</span>
			<span className="ut-sub">{props.sub}</span>
		</div>
	);
}

/** Memoized: the page re-renders on every answer, and the rows it draws (deferred) change only after it. */
export const Trends = memo(function Trends(props: {
	/** The rows in view, after the filters. */
	rows: LedgerRow[];
	/** The server's row window, when it holds only the newest N events. */
	newestOf: number | undefined;
	/** The past position the rows are cut at (`cutRows`), or null (or absent) for live. */
	at?: AtPayload | null;
	/** The live vault's last position: a clamped answer stops saying "latest record" once records follow it. */
	head?: number;
}): React.JSX.Element {
	const at = props.at ?? null;
	const [granularity, setGranularity] = useState<Granularity>("day");
	const [tableShown, setTableShown] = useState(false);
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
	const summary = useMemo(
		() => chartSummary(series, granularity, (t) => formatBucketUtc(t, granularity)),
		[series, granularity],
	);
	const tiles = useMemo(() => statTiles(props.rows), [props.rows]);
	const window = useMemo(() => timeWindow(props.rows), [props.rows]);
	// Each a pass over every row: computed once per row set, not on every render (a granularity switch, the table).
	const byKind = useMemo(() => costByKind(props.rows), [props.rows]);
	const byModel = useMemo(() => costByModel(props.rows), [props.rows]);
	const byJobType = useMemo(() => costByJobType(props.rows), [props.rows]);
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
					value={
						// A move between positions jumps from recorded value to recorded value; the switch between live and past remounts
						// it.
						<TickingFigure
							key={at === null ? "live" : "past"}
							ut={tiles.totalCostUt}
							jump={at !== null}
						/>
					}
					valueTitle={formatUsd(tiles.totalCostUt)}
					sub={`${formatUt(tiles.totalCostUt)} · every costed record`}
				/>
				<Tile
					label="Records"
					value={tiles.calls.toLocaleString()}
					sub={`${tiles.costed.toLocaleString()} with a cost · ${scope}`}
				/>
				<Tile
					label="Avg cost"
					value={formatUsd(tiles.avgCostUt)}
					sub={`${tiles.avgCostUt.toFixed(1)} UT · per costed record (${tiles.costed.toLocaleString()})`}
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
					{/* One chart, bucketed two ways: a toggle, not tabs (there is no panel to switch to). A fieldset would
					    bring its own border and padding into a control that is styled as a segmented switch. */}
					{/* biome-ignore lint/a11y/useSemanticElements: role="group" keeps the segmented look; a fieldset restyles it */}
					<div className="ut-seg small" role="group" aria-label="Bucket size">
						{(["day", "hour"] as const).map((g) => (
							<button
								key={g}
								type="button"
								aria-pressed={granularity === g}
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
					// The container is the chart's image: the label states the series, and the table below lists every
					// bucket (an image's children are not exposed, so the SVG is hidden and out of the tab order; the
					// table's button is the keyboard's way to the figures).
					<ResponsiveContainer width="100%" height={240} role="img" aria-label={summary.label}>
						<BarChart
							data={series}
							margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
							aria-hidden="true"
							tabIndex={-1}
						>
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
								width={64}
								allowDecimals={Y_AXIS_ALLOW_DECIMALS}
								tickFormatter={(v: number) => formatUsdAxis(v)}
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
								formatter={(value) => [
									`${formatUsd(Number(value))} · ${formatUt(Number(value))}`,
									"cost",
								]}
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
				{series.length > 0 && (
					<ChartTable
						summary={summary}
						shown={tableShown}
						onToggle={() => setTableShown((s) => !s)}
					/>
				)}
			</div>
			<div className="ut-split">
				<BarList title="Cost by kind" totals={byKind} />
				<BarList title="Cost by model" totals={byModel} />
			</div>
			<div className="ut-split">
				<BarList
					title={`Cost by job type (${JOB_TYPE_CAVEAT})`}
					note={`The type each caller declared when it authorized the job. "untyped": no type was declared. Every bucket is listed, and together they add up to the total in view.`}
					totals={byJobType}
					limit={Number.POSITIVE_INFINITY}
				/>
			</div>
			<div className="ut-sub mono">
				{props.rows.length.toLocaleString()} records {scope}
				{window && ` · ${formatUtcMinute(window.first)} to ${formatUtcMinute(window.last)}`}
				{at !== null && ` · ${shownLabel(at, props.head ?? at.head, new Date().toISOString())}`}
			</div>
			<div className="ut-sub mono">{UT_KEY}</div>
		</div>
	);
});
