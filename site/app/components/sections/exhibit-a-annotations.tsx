"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	buildLeaderPath,
	CARD_GAP,
	DRAW_DURATION_MS,
	DRAW_STAGGER_MS,
	DRAW_THRESHOLD,
	LEADER_GAP,
	UNIT_DASH,
} from "../../lib/leader-path";

export interface Annotation {
	/** Stable line key in the terminal frame (matches the span's data-line). */
	field: string;
	text: string;
}

interface Leader {
	field: string;
	d: string;
}

export default function ExhibitAAnnotations({
	annotations,
	children,
}: {
	annotations: Annotation[];
	children: React.ReactNode;
}) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<HTMLDivElement>(null);
	const labelRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
	const [leaders, setLeaders] = useState<Leader[]>([]);
	const [size, setSize] = useState<{ w: number; h: number } | null>(null);
	const [drawn, setDrawn] = useState(false);
	const [reduced, setReduced] = useState(false);
	const [active, setActive] = useState<string | null>(null);
	const [popover, setPopover] = useState<{ field: string; top: number } | null>(null);

	const measure = useCallback(() => {
		const wrap = wrapRef.current;
		const terminal = terminalRef.current;
		if (!wrap || !terminal) return;
		const wrapRect = wrap.getBoundingClientRect();
		const next: Leader[] = [];
		for (const a of annotations) {
			const label = labelRefs.current.get(a.field);
			const row = terminal.querySelector(`[data-line="${a.field}"]`);
			if (!label || !row) continue;
			const lr = label.getBoundingClientRect();
			const rr = row.getBoundingClientRect();
			if (lr.width === 0) continue; // annotation rail is display:none below md
			next.push({
				field: a.field,
				d: buildLeaderPath(
					lr.right - wrapRect.left + LEADER_GAP,
					lr.top + lr.height / 2 - wrapRect.top,
					rr.left - wrapRect.left - LEADER_GAP,
					rr.top + rr.height / 2 - wrapRect.top,
				),
			});
		}
		setLeaders(next);
		setSize({ w: wrapRect.width, h: wrapRect.height });
	}, [annotations]);

	// Geometry: after mount, on any resize, and again once webfonts settle.
	useEffect(() => {
		measure();
		const ro = new ResizeObserver(measure);
		if (wrapRef.current) ro.observe(wrapRef.current);
		document.fonts?.ready.then(measure).catch(() => {});
		return () => ro.disconnect();
	}, [measure]);

	// Activation: draw the leaders sequentially, once, on approach (IO-gated).
	// Reduced motion: leaders render fully drawn, no transition.
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			setReduced(true);
			setDrawn(true);
			return;
		}
		const io = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					setDrawn(true); // fires once
					io.disconnect();
				}
			},
			{ threshold: DRAW_THRESHOLD },
		);
		io.observe(wrap);
		return () => io.disconnect();
	}, []);

	// The annotated JSON lines are server DOM — make them keyboard-reachable.
	useEffect(() => {
		const terminal = terminalRef.current;
		if (!terminal) return;
		for (const a of annotations) {
			const row = terminal.querySelector(`[data-line="${a.field}"]`);
			if (!(row instanceof HTMLElement)) continue;
			row.setAttribute("tabindex", "0");
			row.setAttribute("role", "button");
			row.setAttribute("aria-haspopup", "dialog");
		}
	}, [annotations]);

	// Crosslink: mirror the active field onto the server-rendered lines.
	useEffect(() => {
		const terminal = terminalRef.current;
		if (!terminal) return;
		for (const row of terminal.querySelectorAll("[data-line]")) {
			row.setAttribute(
				"data-annotation-active",
				row.getAttribute("data-line") === active ? "true" : "false",
			);
		}
	}, [active]);

	// Popover dismissal: Escape anywhere, tap/click outside.
	useEffect(() => {
		if (!popover) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setPopover(null);
		};
		const onClick = (e: MouseEvent) => {
			if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setPopover(null);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("click", onClick);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("click", onClick);
		};
	}, [popover]);

	const fieldFromEvent = (target: EventTarget | null): string | null => {
		if (!(target instanceof Element)) return null;
		const field = target.closest("[data-line]")?.getAttribute("data-line") ?? null;
		return field && annotations.some((a) => a.field === field) ? field : null;
	};

	const openPopover = (field: string) => {
		const wrap = wrapRef.current;
		const row = terminalRef.current?.querySelector(`[data-line="${field}"]`);
		if (!wrap || !row) return;
		setPopover({
			field,
			top: row.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top + CARD_GAP,
		});
	};

	const onRowActivate = (field: string) => {
		if (window.matchMedia("(max-width: 767px)").matches) openPopover(field);
		else setActive(field);
	};

	const popoverText = popover ? annotations.find((a) => a.field === popover.field)?.text : null;

	return (
		<div
			ref={wrapRef}
			className="relative md:grid md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] md:gap-10"
		>
			{/* Annotation rail — desktop only, left of the terminal frame. */}
			<ul className="hidden flex-col justify-center gap-7 md:flex">
				{annotations.map((a) => (
					<li key={a.field}>
						<button
							type="button"
							ref={(el) => {
								if (el) labelRefs.current.set(a.field, el);
								else labelRefs.current.delete(a.field);
							}}
							data-active={active === a.field}
							onMouseEnter={() => setActive(a.field)}
							onMouseLeave={() => setActive(null)}
							onFocus={() => setActive(a.field)}
							onBlur={() => setActive(null)}
							className="focus-ring block max-w-[14rem] cursor-default text-left font-mono text-xs leading-5 text-white/70 transition-colors data-[active=true]:text-white"
						>
							{a.text}
						</button>
					</li>
				))}
			</ul>

			{/* Server-rendered terminal frame, passed through; hover/tap/focus by delegation
			    (focusin/focusout bubble, so onFocus/onBlur fire for the rows). */}
			<div
				ref={terminalRef}
				onMouseOver={(e) => {
					const f = fieldFromEvent(e.target);
					if (f) setActive(f);
				}}
				onMouseOut={() => setActive(null)}
				onFocus={(e) => {
					const f = fieldFromEvent(e.target);
					if (f) setActive(f);
				}}
				onBlur={() => setActive(null)}
				onClick={(e) => {
					const f = fieldFromEvent(e.target);
					if (f) onRowActivate(f);
				}}
				onKeyDown={(e) => {
					if (e.key !== "Enter" && e.key !== " ") return;
					const f = fieldFromEvent(e.target);
					if (f) {
						e.preventDefault();
						onRowActivate(f);
					}
				}}
			>
				{children}
			</div>

			{/* Leader lines — steel data ink on dark, drawn sequentially, once. */}
			{size && (
				<svg
					className="pointer-events-none absolute inset-0 hidden h-full w-full md:block"
					viewBox={`0 0 ${size.w} ${size.h}`}
					aria-hidden="true"
				>
					{leaders.map((l, i) => (
						<path
							key={l.field}
							d={l.d}
							pathLength={UNIT_DASH}
							fill="none"
							stroke="var(--color-tim)"
							strokeWidth={active === l.field ? 2 : 1.25}
							className={active && active !== l.field ? "opacity-40" : "opacity-100"}
							style={{
								strokeDasharray: UNIT_DASH,
								strokeDashoffset: drawn ? 0 : UNIT_DASH,
								transition: reduced
									? "none"
									: `stroke-dashoffset ${DRAW_DURATION_MS}ms ease-out ${i * DRAW_STAGGER_MS}ms, stroke-width 150ms ease, opacity 150ms ease`,
							}}
						/>
					))}
				</svg>
			)}

			{/* Mobile tap → annotation card: dark instrument surface, steel label. */}
			{popover && popoverText && (
				<div
					role="dialog"
					aria-label={`annotation: ${popover.field}`}
					className="absolute left-4 right-4 z-20 rounded-lg border border-white/15 bg-[#0f0f2a] p-4 shadow-xl md:hidden"
					style={{ top: popover.top }}
				>
					<p className="font-mono text-[12px] uppercase tracking-widest text-tim">
						{popover.field}
					</p>
					<p className="mt-1 font-mono text-sm leading-6 text-white/85">{popoverText}</p>
					<button
						type="button"
						onClick={() => setPopover(null)}
						className="focus-ring mt-3 font-mono text-xs uppercase tracking-widest text-white/70 underline"
					>
						close
					</button>
				</div>
			)}
		</div>
	);
}
