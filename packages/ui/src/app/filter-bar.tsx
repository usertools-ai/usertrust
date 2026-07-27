// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_FILTERS, type FilterState, isFiltering } from "../shared/filters.js";
import { type LedgerRow, statusOf } from "../shared/rows.js";

function distinct(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((v): v is string => v !== undefined))].sort();
}

/** Shared field chrome: 32px tall, mono 12px, panel fill, dark-scheme native pickers. */
const FIELD_CLASSES =
	"h-8 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 font-mono text-xs text-[var(--text)] [color-scheme:dark] placeholder:text-[var(--faint)]";

function FacetPill(props: {
	label: string;
	options: string[];
	selected: string[];
	onChange(next: string[]): void;
}): React.JSX.Element {
	const { label, options, selected, onChange } = props;
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setOpen(false);
				triggerRef.current?.focus();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const active = selected.length > 0;
	return (
		<div ref={rootRef} className="relative">
			<button
				ref={triggerRef}
				type="button"
				aria-haspopup="true"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				title={active ? `${label}: ${selected.join(", ")}` : label}
				className={`h-8 max-w-[220px] truncate rounded-md border bg-[var(--panel)] px-3 font-mono text-xs ${
					active
						? "border-[var(--text)] text-[var(--text)]"
						: "border-[var(--border)] text-[var(--muted)]"
				}`}
			>
				{active ? `${label} · ${selected.length}` : label}
			</button>
			{open && (
				<div
					className="absolute top-full left-0 z-20 mt-1 max-h-60 min-w-40 max-w-[260px] overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-1"
					style={{ boxShadow: "var(--shadow)" }}
				>
					{options.length === 0 ? (
						<div className="px-2 py-1.5 font-mono text-[11px] text-[var(--faint)]">no values</div>
					) : (
						options.map((o) => (
							<label
								key={o}
								className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 font-mono text-xs text-[var(--text)] hover:bg-[var(--border)]"
							>
								<input
									type="checkbox"
									checked={selected.includes(o)}
									onChange={(e) =>
										onChange(
											e.currentTarget.checked ? [...selected, o] : selected.filter((x) => x !== o),
										)
									}
									className="accent-[var(--chart)]"
								/>
								<span className="max-w-[220px] truncate" title={o}>
									{o}
								</span>
							</label>
						))
					)}
				</div>
			)}
		</div>
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
			<div className="flex flex-wrap items-center gap-2">
				<input
					type="search"
					placeholder="Search transactions…"
					value={filters.search}
					onChange={(e) => onChange({ ...filters, search: e.currentTarget.value })}
					className={`${FIELD_CLASSES} w-[260px]`}
				/>
				<FacetPill
					label="kind"
					options={kinds}
					selected={filters.kinds}
					onChange={(v) => onChange({ ...filters, kinds: v })}
				/>
				<FacetPill
					label="model"
					options={models}
					selected={filters.models}
					onChange={(v) => onChange({ ...filters, models: v })}
				/>
				<FacetPill
					label="actor"
					options={actors}
					selected={filters.actors}
					onChange={(v) => onChange({ ...filters, actors: v })}
				/>
				<FacetPill
					label="status"
					options={statuses}
					selected={filters.statuses}
					onChange={(v) => onChange({ ...filters, statuses: v })}
				/>
				<input
					type="date"
					aria-label="from date"
					title="from"
					value={filters.from ?? ""}
					onChange={(e) => onChange({ ...filters, from: e.currentTarget.value || undefined })}
					className={FIELD_CLASSES}
				/>
				<input
					type="date"
					aria-label="to date"
					title="to"
					value={filters.to ?? ""}
					onChange={(e) => onChange({ ...filters, to: e.currentTarget.value || undefined })}
					className={FIELD_CLASSES}
				/>
				<input
					type="number"
					aria-label="min cost (UT)"
					placeholder="min UT"
					value={filters.costMin ?? ""}
					onChange={(e) =>
						onChange({
							...filters,
							costMin: e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value),
						})
					}
					className={`${FIELD_CLASSES} w-20`}
				/>
				<input
					type="number"
					aria-label="max cost (UT)"
					placeholder="max UT"
					value={filters.costMax ?? ""}
					onChange={(e) =>
						onChange({
							...filters,
							costMax: e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value),
						})
					}
					className={`${FIELD_CLASSES} w-20`}
				/>
			</div>
			{isFiltering(filters) && (
				<div className="flex flex-wrap items-center gap-1">
					{chips.map((c) => (
						<button
							key={c.label}
							type="button"
							onClick={c.clear}
							title={c.label}
							aria-label={`clear ${c.label}`}
							className="flex max-w-[220px] items-center gap-1 rounded-full border border-[var(--faint)] bg-[var(--panel)] px-2 py-0.5 font-mono text-[11px] text-[var(--muted)] hover:text-[var(--text)]"
						>
							<span className="truncate">{c.label}</span>
							<span aria-hidden="true">×</span>
						</button>
					))}
					<button
						type="button"
						onClick={() => onChange(EMPTY_FILTERS)}
						className="px-2 font-mono text-[11px] text-[var(--muted)] hover:text-[var(--text)]"
					>
						clear all
					</button>
				</div>
			)}
		</div>
	);
}
