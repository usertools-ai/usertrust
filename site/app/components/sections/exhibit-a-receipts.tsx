"use client";

import { useRef, useState } from "react";
import type { JsonLine } from "../../lib/receipt-json";
import { tokenClass } from "../../lib/receipt-json";
import {
	lastProvider,
	nextProvider,
	prevProvider,
	rovingTabIndex,
	tabButtonClass,
} from "../../lib/sdk-tabs";
import TerminalFrame from "../terminal-frame";
import ExhibitAAnnotations, { type Annotation } from "./exhibit-a-annotations";

export interface ReceiptPanel {
	id: string;
	label: string;
	lab: string;
	/** simple-icons path for the lab mark, or null for the text-badge register. */
	mark: string | null;
	/**
	 * viewBox for that path. Passed in rather than imported: `receipt-labs.ts`
	 * pulls the whole provider-logo table, and importing it HERE would drag
	 * every unrelated mark on the page into this client bundle for the sake of
	 * one nine-character string.
	 */
	markViewBox: string;
	model: string;
	/** Client constructor a caller would wrap for this model, e.g. "Anthropic". */
	ctor: string;
	/** Governed surface that client exposes, e.g. "client.messages.create". */
	surface: string;
	settled: boolean;
	lines: JsonLine[];
	annotations: Annotation[];
}

/**
 * Exhibit A's three-way receipt switcher (Addendum J2).
 *
 * Same roving-tabs pattern as `exhibit-b-tabs.tsx` — one tab in the tab order,
 * arrows move focus AND selection, Home/End jump the ends — because two tab
 * strips on one page that behave differently is worse than either behaviour.
 *
 * The panels arrive fully computed from the server component: JSON lines,
 * annotations, lab identity. This island's whole job is selection, so switching
 * models is a re-render of already-derived data and never a re-parse of the
 * fixture. The default panel is server-rendered into the initial HTML, so the
 * receipt is readable with JavaScript still in flight.
 */
export default function ExhibitAReceipts({
	panels,
	provenanceLine,
}: {
	panels: ReceiptPanel[];
	provenanceLine: string;
}) {
	const [selected, setSelected] = useState(panels[0].id);
	const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
	const ids = panels.map((p) => p.id);
	const panel = panels.find((p) => p.id === selected) ?? panels[0];

	const focusAndSelect = (id: string) => {
		setSelected(id);
		tabRefs.current.get(id)?.focus();
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowRight") {
			e.preventDefault();
			focusAndSelect(nextProvider(ids, selected));
		} else if (e.key === "ArrowLeft") {
			e.preventDefault();
			focusAndSelect(prevProvider(ids, selected));
		} else if (e.key === "Home") {
			e.preventDefault();
			focusAndSelect(ids[0]);
		} else if (e.key === "End") {
			e.preventDefault();
			focusAndSelect(lastProvider(ids));
		}
	};

	return (
		<div className="mt-10">
			<div
				role="tablist"
				aria-label="captured model receipts"
				onKeyDown={onKeyDown}
				className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1"
			>
				{panels.map((p) => (
					<button
						key={p.id}
						ref={(el) => {
							if (el) tabRefs.current.set(p.id, el);
							else tabRefs.current.delete(p.id);
						}}
						type="button"
						role="tab"
						id={`receipt-tab-${p.id}`}
						aria-selected={selected === p.id}
						aria-controls={`receipt-panel-${p.id}`}
						tabIndex={rovingTabIndex(selected === p.id)}
						onClick={() => setSelected(p.id)}
						className={`focus-ring inline-flex items-center gap-2 rounded-md px-3 py-1.5 font-mono text-xs tracking-wide transition-colors ${tabButtonClass(
							selected === p.id,
						)}`}
					>
						<LabMark panel={p} className="h-3.5 w-3.5 shrink-0" />
						{p.label}
					</button>
				))}
			</div>

			{/* The call — static mono, emerald keyword accents. TerminalFrame's
			    shared chrome, no title; pre/code semantics preserved inside. */}
			<div
				role="tabpanel"
				id={`receipt-panel-${panel.id}`}
				aria-labelledby={`receipt-tab-${panel.id}`}
				// WAI-ARIA APG tabs pattern: the panel is reachable by Tab so keyboard
				// users move from the active tab straight into its content. The
				// matching lint rule is disabled for this file in biome.json (an
				// inline suppression would itself trip check-facts on the rule name).
				tabIndex={0}
				className="focus-ring mt-6 grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16"
			>
				<TerminalFrame className="min-w-0 self-start text-white/80">
					<pre data-code-sample>
						<code>
							<span className="text-ut">import</span> {"{ trust }"}{" "}
							<span className="text-ut">from</span>{" "}
							<span className="text-white/80">"usertrust"</span>;{"\n\n"}
							<span className="text-ut">const</span> client = <span className="text-ut">await</span>{" "}
							trust(<span className="text-ut">new</span> {panel.ctor}());{"\n\n"}
							<span className="text-ut">const</span> {"{ response, "}
							<span className="text-ut">receipt</span>
							{" }"} ={"\n  "}
							<span className="text-ut">await</span> {panel.surface}({"{"}
							{"\n"}
							{"  model: "}
							<span className="text-white/80">"{panel.model}"</span>,{"\n"}
							<span data-code-sample>{"  max_tokens: 256,"}</span>
							{"\n"}
							{"  messages: [...],"}
							{"\n"}
							{"}"});
						</code>
					</pre>
				</TerminalFrame>

				{/* The evidence — the SDK's actual return value, annotated. The
				    title bar carries the lab mark; the provenance line is the
				    frame's footer slot. */}
				<ExhibitAAnnotations annotations={panel.annotations}>
					<TerminalFrame
						className="receipt-terminal"
						title={
							<div className="flex w-full items-center gap-2">
								<LabMark panel={panel} className="h-4 w-4 shrink-0 text-white/45" />
								{/* Short enough to fit the bar. The longer wording ellipsized
								    at every viewport, which turns a label into a shrug. */}
								<span className="min-w-0 truncate">receipt · {panel.lab}</span>
							</div>
						}
						footer={
							<div className="border-t border-white/10 px-5 py-2.5 font-mono text-[12px] tracking-wide text-white/70">
								{provenanceLine}
							</div>
						}
					>
						{/* The receipt JSON — line-keyed spans the island targets. */}
						<pre>
							<code>
								{panel.lines.map((line) => (
									<span key={line.key} data-line={line.key} className="block rounded-sm px-1 py-px">
										{"  ".repeat(line.indent)}
										{line.tokens.map((tok) => (
											<span
												key={tok.key}
												className={tokenClass(tok.role, line.key === "settled" && panel.settled)}
											>
												{tok.text}
											</span>
										))}
									</span>
								))}
							</code>
						</pre>
					</TerminalFrame>
				</ExhibitAAnnotations>
			</div>
		</div>
	);
}

/**
 * The lab's mark, ghosted-mono — or its name in the 12px mono text-badge
 * register when the icon set carries no clean glyph for it.
 */
function LabMark({ panel, className }: { panel: ReceiptPanel; className?: string }) {
	if (panel.mark === null) {
		return (
			<span className="font-mono text-[12px] tracking-[0.12em] text-white/70">{panel.lab}</span>
		);
	}
	return (
		<svg
			viewBox={panel.markViewBox}
			role="img"
			aria-label={panel.lab}
			fill="currentColor"
			className={className}
		>
			<path d={panel.mark} />
		</svg>
	);
}
