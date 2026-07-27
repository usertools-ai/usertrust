// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { type LedgerRow, statusOf } from "../shared/rows.js";

type SortKey = "seq" | "ts" | "kind" | "actor" | "model" | "costUt";
const COLUMNS: Array<{
	key: SortKey | "status" | "integrity" | "transferId";
	label: string;
	width: string;
}> = [
	{ key: "ts", label: "Time", width: "w-44" },
	{ key: "kind", label: "Kind", width: "w-32" },
	{ key: "actor", label: "Actor", width: "w-28" },
	{ key: "model", label: "Model", width: "w-44" },
	{ key: "costUt", label: "Cost", width: "w-28" },
	{ key: "status", label: "Status", width: "w-24" },
	{ key: "integrity", label: "Integrity", width: "w-28" },
	{ key: "transferId", label: "Tx", width: "flex-1" },
];

function compare(a: LedgerRow, b: LedgerRow, key: SortKey): number {
	if (key === "seq") return (a.seq ?? 0) - (b.seq ?? 0);
	if (key === "costUt") return (a.costUt ?? 0) - (b.costUt ?? 0);
	const av = String(a[key] ?? "");
	const bv = String(b[key] ?? "");
	return av.localeCompare(bv);
}

function StatusBadge(props: { row: LedgerRow }): React.JSX.Element {
	const status = statusOf(props.row);
	const color =
		status === "settled"
			? "text-[var(--accent)]"
			: status === "failed"
				? "text-[var(--danger)]"
				: "text-[var(--muted)]";
	return <span className={`text-xs uppercase ${color}`}>{status}</span>;
}

function IntegrityBadge(props: { row: LedgerRow }): React.JSX.Element {
	if (props.row.integrity === "verified")
		return <span className="text-xs text-[var(--accent)]">✓ verified</span>;
	return <span className="text-xs text-[var(--danger)]">⚠ after break</span>;
}

export function AuditTable(props: {
	rows: LedgerRow[];
	onOpen(row: LedgerRow): void;
}): React.JSX.Element {
	const [sortKey, setSortKey] = useState<SortKey>("seq");
	const [desc, setDesc] = useState(true);
	const sorted = useMemo(() => {
		const copy = [...props.rows].sort((a, b) => compare(a, b, sortKey));
		return desc ? copy.reverse() : copy;
	}, [props.rows, sortKey, desc]);

	const parentRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: sorted.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 36,
		overscan: 20,
	});

	const sortBy = (key: SortKey): void => {
		if (key === sortKey) setDesc(!desc);
		else {
			setSortKey(key);
			setDesc(true);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col rounded border border-[var(--border)]">
			<div className="flex border-b border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-xs font-medium text-[var(--muted)]">
				{COLUMNS.map((c) => (
					<button
						key={c.key}
						type="button"
						className={`${c.width} shrink-0 text-left`}
						onClick={() => {
							if (c.key !== "status" && c.key !== "integrity" && c.key !== "transferId")
								sortBy(c.key);
						}}
					>
						{c.label}
						{c.key === sortKey ? (desc ? " ↓" : " ↑") : ""}
					</button>
				))}
			</div>
			<div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
				<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
					{virtualizer.getVirtualItems().map((item) => {
						const row = sorted[item.index] as LedgerRow;
						return (
							<button
								type="button"
								key={row.id}
								onClick={() => props.onOpen(row)}
								className="absolute left-0 flex w-full border-b border-[var(--border)] px-2 py-2 text-left text-xs hover:bg-[var(--panel)]"
								style={{ top: 0, transform: `translateY(${item.start}px)` }}
							>
								<span className="w-44 shrink-0 text-[var(--muted)]">
									{row.ts.replace("T", " ").slice(0, 19)}
								</span>
								<span className="w-32 shrink-0">{row.kind}</span>
								<span className="w-28 shrink-0 text-[var(--muted)]">{row.actor}</span>
								<span className="w-44 shrink-0">{row.model ?? "—"}</span>
								<span className="w-28 shrink-0">
									{row.costUt !== undefined ? `${row.costUt} UT` : "—"}
									{row.costUsd !== undefined && (
										<span className="text-[var(--muted)]"> ${row.costUsd.toFixed(4)}</span>
									)}
								</span>
								<span className="w-24 shrink-0">
									<StatusBadge row={row} />
								</span>
								<span className="w-28 shrink-0">
									<IntegrityBadge row={row} />
								</span>
								<span className="flex-1 truncate font-mono text-[var(--muted)]">
									{row.transferId ?? row.id}
								</span>
							</button>
						);
					})}
				</div>
			</div>
			<div className="border-t border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)]">
				{sorted.length} transactions
			</div>
		</div>
	);
}
