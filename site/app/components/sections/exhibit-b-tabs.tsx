"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useRef, useState } from "react";
import {
	lastProvider,
	nextProvider,
	PROVIDER_TABS,
	type ProviderId,
	prevProvider,
	rovingTabIndex,
	TRUST_PREFIX,
	tabButtonClass,
	trustLineBody,
} from "../../lib/sdk-tabs";
import TerminalFrame from "../terminal-frame";

export default function ExhibitBTabs() {
	const [selected, setSelected] = useState<ProviderId>("anthropic");
	const reduced = useReducedMotion();
	const baseId = useId();
	const tabRefs = useRef<Map<ProviderId, HTMLButtonElement>>(new Map());

	const ids = PROVIDER_TABS.map((t) => t.id);
	const tab = PROVIDER_TABS.find((t) => t.id === selected) ?? PROVIDER_TABS[0];

	const focusAndSelect = (id: ProviderId) => {
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
		// min-w-0: as a grid item this root defaults to min-width:auto, so the
		// widest code line's min-content (~412px) propagated out through
		// TerminalFrame's overflow-hidden container and widened the track past
		// the 342px available at 390 — the code painted to the viewport edge with
		// no frame border in front of it and the frame's own overflow-x-auto
		// never engaged.
		<div className="min-w-0">
			<div
				role="tablist"
				aria-label="SDK provider"
				onKeyDown={onKeyDown}
				className="flex w-fit gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1"
			>
				{PROVIDER_TABS.map((t) => (
					<button
						key={t.id}
						ref={(el) => {
							if (el) tabRefs.current.set(t.id, el);
							else tabRefs.current.delete(t.id);
						}}
						type="button"
						role="tab"
						id={`${baseId}-tab-${t.id}`}
						aria-selected={selected === t.id}
						aria-controls={`${baseId}-panel-${t.id}`}
						tabIndex={rovingTabIndex(selected === t.id)}
						onClick={() => setSelected(t.id)}
						className={`focus-ring rounded-md px-4 py-1.5 font-mono text-xs tracking-wide transition-colors ${tabButtonClass(
							selected === t.id,
						)}`}
					>
						{t.label}
					</button>
				))}
			</div>

			<div
				role="tabpanel"
				id={`${baseId}-panel-${tab.id}`}
				aria-labelledby={`${baseId}-tab-${tab.id}`}
				// WAI-ARIA APG tabs pattern: the tabpanel must be reachable by Tab so keyboard
				// users can move straight from the active tab into its content. The matching
				// accessibility lint rule is disabled for this file in biome.json (an inline
				// suppression comment would itself trip check-facts on the rule's name).
				tabIndex={0}
				className="focus-ring mt-4"
			>
				{/* min-h reserves the tallest panel — no CLS on tab switch. TerminalFrame
				    is plain markup (no server-only APIs), so this client island imports
				    and renders it directly rather than needing a server/children split. */}
				<TerminalFrame className="min-h-[23rem] text-white/80">
					<pre data-code-sample>
						<code className="block">
							<AnimatePresence initial={false} mode="popLayout">
								{tab.lines.map((line) => (
									<motion.span
										key={line.key}
										layout={!reduced}
										initial={reduced || !line.changed ? false : { opacity: 0, y: 6 }}
										animate={{ opacity: 1, y: 0 }}
										exit={
											reduced || !line.changed
												? { opacity: 0, transition: { duration: 0 } }
												: { opacity: 0, y: -6, transition: { duration: 0.15 } }
										}
										transition={
											reduced ? { duration: 0 } : { type: "spring", stiffness: 550, damping: 42 }
										}
										className="block min-h-[1.75rem] whitespace-pre"
									>
										{line.trust ? (
											<>
												{TRUST_PREFIX}
												{/* persistent emerald underline — same line, same position, every tab */}
												<span className="border-b-2 border-ut pb-px">
													{trustLineBody(line.text)}
												</span>
												{";"}
											</>
										) : (
											line.text || " "
										)}
									</motion.span>
								))}
							</AnimatePresence>
						</code>
					</pre>
				</TerminalFrame>
			</div>
		</div>
	);
}
