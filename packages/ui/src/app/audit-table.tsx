// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import {
	type ChainStatus,
	costView,
	type LoadPhase,
	listState,
	transferView,
} from "../shared/display.js";
import { type SortKey, sortRows } from "../shared/filters.js";
import { compactActor, formatUtc } from "../shared/format.js";
import { type LedgerRow, type RowStatus, statusOf } from "../shared/rows.js";

const SORTS: Array<{ key: SortKey; label: string }> = [
	{ key: "seq", label: "Position" },
	{ key: "ts", label: "Time" },
	{ key: "costUt", label: "Cost" },
	{ key: "model", label: "Model" },
	{ key: "actor", label: "Actor" },
	{ key: "kind", label: "Kind" },
];

/**
 * Each status's badge tone. Settling is normal, not a celebration: neutral. Green is earned by verification only
 * (the integrity mark). A Record, so a new status cannot fall into another's colour unnoticed. An ungoverned call is
 * amber: it ran unmetered, which an operator should see.
 */
export const STATUS_TONE: Record<RowStatus, string | undefined> = {
	settled: undefined,
	released: "faint",
	failed: "stakes",
	denied: "stakes",
	ambiguous: "info",
	ungoverned: "info",
	// Ran and recorded, NOT charged: a money state of its own colour.
	unrecoverable: "alert",
	info: "faint",
	// Never settled's look: an unknown outcome must not read as a settled one.
	unknown: "unknown",
};

function Sep(): React.JSX.Element {
	return (
		<span className="d" aria-hidden="true">
			·
		</span>
	);
}

function Row(props: { row: LedgerRow }): React.JSX.Element {
	const { row } = props;
	const status = statusOf(row);
	const cost = costView(row);
	const tx = transferView(row);
	return (
		<>
			<span className="ut-l">
				<span className="ut-line">
					<span className="ut-badge" data-tone={STATUS_TONE[status]}>
						<i aria-hidden="true" />
						{status}
					</span>
					<span className="ut-rtitle">{row.model ?? row.kind}</span>
				</span>
				<span className="ut-meta">
					<span className="m" title={row.ts}>
						{formatUtc(row.ts)}
					</span>
					<Sep />
					<span title={`actor ${row.actor}`}>{compactActor(row.actor)}</span>
					{row.model !== undefined && (
						<>
							<Sep />
							<span className="m">{row.kind}</span>
						</>
					)}
					<Sep />
					{tx.kind === "transfer" ? (
						<span className="m" title={`transfer ${tx.id}`}>
							tx {tx.id}
						</span>
					) : (
						<span className="none">no transfer</span>
					)}
					<Sep />
					{row.integrity === "verified" ? (
						<span className="ok">✓ verified</span>
					) : (
						<span className="bad">⚠ after break</span>
					)}
				</span>
			</span>
			<span className="ut-fig">
				{cost === null ? (
					<span className="ut-amt na">no cost recorded</span>
				) : (
					<>
						<span className="ut-amt">{cost.ut}</span>
						<span className="ut-recd">
							{cost.estimated && (
								<span className="ut-est" title="Estimated: the provider reported no usage">
									est.
								</span>
							)}
							{cost.usd}
						</span>
					</>
				)}
			</span>
		</>
	);
}

function Empty(props: {
	state: Exclude<ReturnType<typeof listState>, "rows">;
	hidden: number;
	onClearFilters(): void;
}): React.JSX.Element {
	switch (props.state) {
		case "loading":
			return (
				<div className="ut-skel">
					<span className="sr-only">Loading the ledger…</span>
					{[0, 1, 2, 3, 4, 5].map((i) => (
						<span key={i} aria-hidden="true" />
					))}
				</div>
			);
		case "failed":
			return (
				<div className="ut-empty" role="status">
					<b>The ledger could not be loaded</b>
					The server did not answer. This view loads again when the live connection returns.
				</div>
			);
		case "first-run":
			return (
				<div className="ut-empty" role="status">
					<b>No governed calls yet</b>
					This vault has no events, and nothing is wrong with it. The ledger starts at the first
					governed call: wrap a client with <code>trust()</code>, make a call, and it appears here.
				</div>
			);
		case "no-rows":
			return (
				<div className="ut-empty" role="status">
					<b>No events to show</b>
					The vault failed verification: see the integrity failure above.
				</div>
			);
		case "filtered-out":
			return (
				<div className="ut-empty" role="status">
					<b>Nothing matches these filters</b>
					{props.hidden.toLocaleString()} {props.hidden === 1 ? "record is" : "records are"} hidden
					by them.
					<br />
					<button type="button" className="ut-ghost" onClick={props.onClearFilters}>
						Clear filters
					</button>
				</div>
			);
	}
}

export function AuditTable(props: {
	/** The rows in view, after the filters. */
	rows: LedgerRow[];
	/** Every row held, before the filters. */
	total: number;
	phase: LoadPhase;
	chain: ChainStatus | null;
	liveIds?: Set<string>;
	selected: string | null;
	onOpen(row: LedgerRow): void;
	onClearFilters(): void;
}): React.JSX.Element {
	const [sortKey, setSortKey] = useState<SortKey>("seq");
	const [desc, setDesc] = useState(true);
	const sorted = useMemo(() => sortRows(props.rows, sortKey, desc), [props.rows, sortKey, desc]);

	const parentRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: sorted.length,
		getScrollElement: () => parentRef.current,
		// Two-line rows; a narrow list stacks the cost under them, so each row is measured.
		estimateSize: () => 62,
		getItemKey: (i) => (sorted[i] as LedgerRow).hash,
		gap: 2,
		paddingStart: 8,
		paddingEnd: 24,
		overscan: 12,
	});

	const sortBy = (key: SortKey): void => {
		if (key === sortKey) setDesc(!desc);
		else {
			setSortKey(key);
			setDesc(true);
		}
	};

	const state = listState({
		phase: props.phase,
		chain: props.chain,
		total: props.total,
		shown: sorted.length,
	});

	return (
		<>
			<div className="ut-cap">
				<span className="lead">Sort</span>
				{SORTS.map((s) => (
					<button
						key={s.key}
						type="button"
						aria-pressed={s.key === sortKey}
						onClick={() => sortBy(s.key)}
						title={
							s.key === sortKey
								? `sorted by ${s.label.toLowerCase()}, ${desc ? "descending" : "ascending"}`
								: `sort by ${s.label.toLowerCase()}`
						}
					>
						{s.label}
						{s.key === sortKey && <span aria-hidden="true">{desc ? " ↓" : " ↑"}</span>}
					</button>
				))}
			</div>
			<div ref={parentRef} className="ut-list">
				{state !== "rows" ? (
					<Empty
						state={state}
						hidden={props.total - sorted.length}
						onClearFilters={props.onClearFilters}
					/>
				) : (
					<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
						{virtualizer.getVirtualItems().map((item) => {
							const row = sorted[item.index] as LedgerRow;
							const sel = props.selected === row.hash;
							return (
								<button
									type="button"
									// The event hash, unique on the chain: an id can repeat, and duplicate keys drop or duplicate rows.
									key={row.hash}
									data-index={item.index}
									ref={virtualizer.measureElement}
									onClick={() => props.onOpen(row)}
									aria-current={sel ? "true" : undefined}
									className={`ut-row${sel ? " sel" : ""}${props.liveIds?.has(row.hash) ? " fresh" : ""}`}
									style={{
										position: "absolute",
										top: 0,
										left: 8,
										right: 8,
										transform: `translateY(${item.start}px)`,
									}}
								>
									<Row row={row} />
								</button>
							);
						})}
					</div>
				)}
			</div>
			<div className="ut-foot">
				<span>
					{sorted.length === props.total
						? `${props.total.toLocaleString()} ${props.total === 1 ? "record" : "records"}`
						: `${sorted.length.toLocaleString()} of ${props.total.toLocaleString()} records`}
				</span>
				<span>times in UTC</span>
			</div>
		</>
	);
}
