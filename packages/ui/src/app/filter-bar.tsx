// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
	activeFilterCount,
	EMPTY_FILTERS,
	type FilterState,
	isFiltering,
} from "../shared/filters.js";
import { costBoundLabel } from "../shared/format.js";
import { PHONE_QUERY } from "../shared/layout.js";
import {
	JOB_TYPE_CAVEAT,
	jobTypeOf,
	type LedgerRow,
	statusOf,
	typeSourceOf,
} from "../shared/rows.js";

/** Each distinct value with the number of rows carrying it, by value. */
function counted(values: Array<string | undefined>): Array<{ value: string; n: number }> {
	const counts = new Map<string, number>();
	for (const v of values) if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([value, n]) => ({ value, n }));
}

/** Each facet's value of a row: module-level, so a facet's memo sees the same function on every render. */
const KIND = (r: LedgerRow): string => r.kind;
const MODEL = (r: LedgerRow): string | undefined => r.model;
const ACTOR = (r: LedgerRow): string => r.actor;
const STATUS = (r: LedgerRow): string => statusOf(r);

function Facet(props: {
	label: string;
	/** The rows the values are counted over, and each row's value. Counted only while the list is open. */
	rows: LedgerRow[];
	valueFor(r: LedgerRow): string | undefined;
	selected: string[];
	onChange(next: string[]): void;
}): React.JSX.Element {
	const { label, rows, valueFor, selected, onChange } = props;
	const [open, setOpen] = useState(false);
	// A pass over every row, so never while closed: a moving position changes the rows on every answer, and six closed
	// facets counting 100,000 rows each time held the page up for nothing anyone could see.
	const options = useMemo(() => (open ? counted(rows.map(valueFor)) : []), [open, rows, valueFor]);
	// Placed when it opens: a fixed width, its left edge clamped 16 px inside BOTH window edges (aligning to the trigger's
	// right edge alone pushed a narrow screen's first facet off the left), and no taller than the room below the trigger.
	const [place, setPlace] = useState({ left: 0, width: 260, maxHeight: 300 });
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	const toggle = (): void => {
		const trigger = triggerRef.current;
		if (!open && trigger !== null) {
			const r = trigger.getBoundingClientRect();
			const width = Math.min(260, window.innerWidth - 32);
			const x = Math.min(Math.max(r.left, 16), window.innerWidth - 16 - width);
			setPlace({
				left: x - r.left,
				width,
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
					className="ut-pop"
					style={{ left: place.left, width: place.width, maxHeight: place.maxHeight }}
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

/** Memoized: the page re-renders on every answer, and the bar's rows (deferred) change only after it. */
export const FilterBar = memo(function FilterBar(props: {
	rows: LedgerRow[];
	filters: FilterState;
	onChange(f: FilterState): void;
	/** The rows are a held view (the moment after a new position lands): the facets' counts are dimmed and busy. */
	held?: boolean;
}): React.JSX.Element {
	const { rows, filters, onChange } = props;
	const held = props.held === true;
	// On a phone the bar is one button, and the filters open in a sheet over the page; elsewhere the button and the
	// sheet's header are not shown and the bar is the row it always was.
	const [sheet, setSheet] = useState(false);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const sheetRef = useRef<HTMLDivElement | null>(null);
	const doneRef = useRef<HTMLButtonElement | null>(null);

	// The sheet is modal: it takes focus, Escape (or Done, or the scrim) closes it and focus goes back to the button,
	// and Tab cycles inside it. An open facet list takes the first Escape, as it does anywhere.
	useEffect(() => {
		if (!sheet) return;
		doneRef.current?.focus();
		const onKey = (e: KeyboardEvent): void => {
			const root = sheetRef.current;
			if (e.key === "Escape") {
				if (root?.querySelector(".ut-pop")) return;
				setSheet(false);
				return;
			}
			if (e.key !== "Tab" || root === null) return;
			const focusables = root.querySelectorAll<HTMLElement>(
				"button, [href], input, [tabindex]:not([tabindex='-1'])",
			);
			if (focusables.length === 0) return;
			const first = focusables[0] as HTMLElement;
			const last = focusables[focusables.length - 1] as HTMLElement;
			const active = document.activeElement;
			if (e.shiftKey && (active === first || !root.contains(active))) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && (active === last || !root.contains(active))) {
				e.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("keydown", onKey);
			// Back to the button that opened it.
			if (buttonRef.current?.isConnected) buttonRef.current.focus();
		};
	}, [sheet]);

	// A window widened past the phone layout leaves the bar open as a row: the sheet's state must not outlive it.
	useEffect(() => {
		if (!sheet) return;
		const m = window.matchMedia(PHONE_QUERY);
		const on = (): void => {
			if (!m.matches) setSheet(false);
		};
		m.addEventListener("change", on);
		return () => m.removeEventListener("change", on);
	}, [sheet]);

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
	for (const p of filters.providers)
		chips.push({
			label: `provider: ${p}`,
			clear: () => onChange({ ...filters, providers: filters.providers.filter((x) => x !== p) }),
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
	for (const t of filters.jobTypes)
		chips.push({
			label: `job type: ${t} (${JOB_TYPE_CAVEAT})`,
			clear: () => onChange({ ...filters, jobTypes: filters.jobTypes.filter((x) => x !== t) }),
		});
	for (const t of filters.typeSources)
		chips.push({
			label: `type declared by: ${t}`,
			clear: () =>
				onChange({ ...filters, typeSources: filters.typeSources.filter((x) => x !== t) }),
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
			label: costBoundLabel("≥", filters.costMin),
			clear: () => onChange({ ...filters, costMin: undefined }),
		});
	if (filters.costMax !== undefined)
		chips.push({
			label: costBoundLabel("≤", filters.costMax),
			clear: () => onChange({ ...filters, costMax: undefined }),
		});

	const cost = (key: "costMin" | "costMax", value: string): void =>
		onChange({ ...filters, [key]: value === "" ? undefined : Number(value) });

	const applied = activeFilterCount(filters);

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className="ut-btn ut-filters-btn"
				aria-haspopup="dialog"
				aria-expanded={sheet}
				aria-controls="ut-filter-sheet"
				onClick={() => setSheet(true)}
			>
				<span>Filters{applied > 0 ? ` (${applied})` : ""}</span>
				<span className="chev" aria-hidden="true">
					▾
				</span>
			</button>
			{sheet && (
				<button
					type="button"
					className="ut-scrim"
					aria-hidden="true"
					tabIndex={-1}
					onClick={() => setSheet(false)}
				/>
			)}
			<div
				ref={sheetRef}
				id="ut-filter-sheet"
				className="ut-bar"
				data-sheet={sheet}
				data-held={held}
				aria-busy={held}
				// A dialog only while open (and only a phone opens it); otherwise the bar is the plain row it always was.
				{...(sheet ? { role: "dialog", "aria-modal": true, "aria-label": "Filters" } : {})}
			>
				<div className="ut-sheet-head">
					<b>Filters{applied > 0 ? ` (${applied})` : ""}</b>
					<button ref={doneRef} type="button" className="ut-btn" onClick={() => setSheet(false)}>
						Done
					</button>
				</div>
				<Facet
					label="kind"
					rows={rows}
					valueFor={KIND}
					selected={filters.kinds}
					onChange={(v) => onChange({ ...filters, kinds: v })}
				/>
				<Facet
					label="model"
					rows={rows}
					valueFor={MODEL}
					selected={filters.models}
					onChange={(v) => onChange({ ...filters, models: v })}
				/>
				<Facet
					label="actor"
					rows={rows}
					valueFor={ACTOR}
					selected={filters.actors}
					onChange={(v) => onChange({ ...filters, actors: v })}
				/>
				<Facet
					label="status"
					rows={rows}
					valueFor={STATUS}
					selected={filters.statuses}
					onChange={(v) => onChange({ ...filters, statuses: v })}
				/>
				<Facet
					label="job type (declared)"
					rows={rows}
					valueFor={jobTypeOf}
					selected={filters.jobTypes}
					onChange={(v) => onChange({ ...filters, jobTypes: v })}
				/>
				<Facet
					label="type declared by"
					rows={rows}
					valueFor={typeSourceOf}
					selected={filters.typeSources}
					onChange={(v) => onChange({ ...filters, typeSources: v })}
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
							min={0}
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
						min={0}
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
});
