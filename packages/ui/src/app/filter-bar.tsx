// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_FILTERS, type FilterState, isFiltering } from "../shared/filters.js";
import { type LedgerRow, statusOf } from "../shared/rows.js";

/** Each distinct value with the number of rows carrying it, by value. */
function counted(values: Array<string | undefined>): Array<{ value: string; n: number }> {
	const counts = new Map<string, number>();
	for (const v of values) if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([value, n]) => ({ value, n }));
}

function Facet(props: {
	label: string;
	options: Array<{ value: string; n: number }>;
	selected: string[];
	onChange(next: string[]): void;
}): React.JSX.Element {
	const { label, options, selected, onChange } = props;
	const [open, setOpen] = useState(false);
	// Placed when it opens: aligned to the trigger's right edge when it would otherwise run past the window's, and no
	// taller than the room below the trigger, so no option is cut off at a window edge.
	const [place, setPlace] = useState({ right: false, maxHeight: 300 });
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	const toggle = (): void => {
		const trigger = triggerRef.current;
		if (!open && trigger !== null) {
			const r = trigger.getBoundingClientRect();
			const width = Math.min(320, window.innerWidth - 32);
			setPlace({
				right: r.left + width > window.innerWidth - 16,
				maxHeight: Math.max(140, Math.min(300, window.innerHeight - r.bottom - 24)),
			});
		}
		setOpen((o) => !o);
	};

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
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
		<div ref={rootRef} className="ut-facet">
			<button
				ref={triggerRef}
				type="button"
				aria-haspopup="true"
				aria-expanded={open}
				onClick={toggle}
				title={active ? `${label}: ${selected.join(", ")}` : `filter by ${label}`}
				className={`ut-chip${active ? " on" : ""}`}
			>
				<span className="t">{label}</span>
				{active && <span className="n">{selected.length}</span>}
				<span className="chev" aria-hidden="true">
					▾
				</span>
			</button>
			{open && (
				<fieldset
					className={`ut-pop${place.right ? " right" : ""}`}
					style={{ maxHeight: place.maxHeight }}
				>
					<legend className="sr-only">filter by {label}</legend>
					{options.length === 0 ? (
						<div className="ut-opt">no values</div>
					) : (
						options.map((o) => (
							<label key={o.value} className="ut-opt">
								<input
									type="checkbox"
									checked={selected.includes(o.value)}
									onChange={(e) =>
										onChange(
											e.currentTarget.checked
												? [...selected, o.value]
												: selected.filter((x) => x !== o.value),
										)
									}
								/>
								<span className="t" title={o.value}>
									{o.value}
								</span>
								<span className="n">{o.n}</span>
							</label>
						))
					)}
				</fieldset>
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
	const kinds = useMemo(() => counted(rows.map((r) => r.kind)), [rows]);
	const models = useMemo(() => counted(rows.map((r) => r.model)), [rows]);
	const actors = useMemo(() => counted(rows.map((r) => r.actor)), [rows]);
	const statuses = useMemo(() => counted(rows.map((r) => statusOf(r))), [rows]);

	const chips: Array<{ label: string; clear(): void }> = [];
	if (filters.search.trim() !== "")
		chips.push({
			label: `search: ${filters.search.trim()}`,
			clear: () => onChange({ ...filters, search: "" }),
		});
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
			label: `from ${filters.from} UTC`,
			clear: () => onChange({ ...filters, from: undefined }),
		});
	if (filters.to)
		chips.push({
			label: `to ${filters.to} UTC`,
			clear: () => onChange({ ...filters, to: undefined }),
		});
	// A cost bound hides every row WITHOUT a cost (an unknown cost is not 0), and the chip says so.
	if (filters.costMin !== undefined)
		chips.push({
			label: `cost ≥ ${filters.costMin} UT · uncosted hidden`,
			clear: () => onChange({ ...filters, costMin: undefined }),
		});
	if (filters.costMax !== undefined)
		chips.push({
			label: `cost ≤ ${filters.costMax} UT · uncosted hidden`,
			clear: () => onChange({ ...filters, costMax: undefined }),
		});

	const cost = (key: "costMin" | "costMax", value: string): void =>
		onChange({ ...filters, [key]: value === "" ? undefined : Number(value) });

	return (
		<>
			<div className="ut-bar">
				<Facet
					label="kind"
					options={kinds}
					selected={filters.kinds}
					onChange={(v) => onChange({ ...filters, kinds: v })}
				/>
				<Facet
					label="model"
					options={models}
					selected={filters.models}
					onChange={(v) => onChange({ ...filters, models: v })}
				/>
				<Facet
					label="actor"
					options={actors}
					selected={filters.actors}
					onChange={(v) => onChange({ ...filters, actors: v })}
				/>
				<Facet
					label="status"
					options={statuses}
					selected={filters.statuses}
					onChange={(v) => onChange({ ...filters, statuses: v })}
				/>
				<span className="ut-sep" aria-hidden="true" />
				{/* The filters compare the UTC date, the date each row shows: the pickers say so. */}
				<label className="ut-field">
					From (UTC)
					<input
						type="date"
						value={filters.from ?? ""}
						onChange={(e) => onChange({ ...filters, from: e.currentTarget.value || undefined })}
					/>
				</label>
				<label className="ut-field">
					To (UTC)
					<input
						type="date"
						value={filters.to ?? ""}
						onChange={(e) => onChange({ ...filters, to: e.currentTarget.value || undefined })}
					/>
				</label>
				<span className="ut-sep" aria-hidden="true" />
				<span className="ut-range">
					<label className="ut-field">
						Cost
						<input
							type="number"
							aria-label="minimum cost in UT"
							placeholder="min UT"
							value={filters.costMin ?? ""}
							onChange={(e) => cost("costMin", e.currentTarget.value)}
						/>
					</label>
					<span className="to" aria-hidden="true">
						to
					</span>
					<input
						className="ut-field-bare"
						type="number"
						aria-label="maximum cost in UT"
						placeholder="max UT"
						value={filters.costMax ?? ""}
						onChange={(e) => cost("costMax", e.currentTarget.value)}
					/>
				</span>
			</div>
			{isFiltering(filters) && (
				<div className="ut-active">
					<span className="ut-label">Filtering</span>
					{chips.map((c) => (
						<button
							key={c.label}
							type="button"
							onClick={c.clear}
							title={`clear ${c.label}`}
							aria-label={`clear ${c.label}`}
							className="ut-chip on"
						>
							<span className="t">{c.label}</span>
							<span className="x" aria-hidden="true">
								×
							</span>
						</button>
					))}
					<button type="button" className="ut-ghost" onClick={() => onChange(EMPTY_FILTERS)}>
						Clear all
					</button>
				</div>
			)}
		</>
	);
}
