"use client";

import { useEffect, useRef, useState } from "react";
import Stamp from "../stamp";
import TerminalFrame from "../terminal-frame";
import {
	CHITS,
	chitCardClass,
	chitLineClass,
	DROP_STAGGER_MS,
	editorLineClass,
	POLICY_LINES,
	type PolicyLine,
	type PolicyOp,
	RAIL_CHAINED,
	RAIL_REASON,
	RAIL_THROWN,
	SPOOL_IO_THRESHOLD,
} from "./lib/exhibit-f-policy";

type Phase = "settled" | "armed" | "playing";

function opsInLine(line: PolicyLine): PolicyOp[] {
	return line.segs.flatMap((s) => (s.op ? [s.op] : []));
}

/**
 * Exhibit F island: the policy editor + print spool + thrown-error card.
 * One client component owns both columns because the operator-chip
 * highlight state spans the YAML editor AND the chits. SSR renders the
 * settled end state; motion users are re-armed after mount and the story
 * plays once on IO. Highlights use `tim` (steel-on-dark equivalent per the
 * shared contract).
 *
 * The card that appears when the violating chit ejects carries BOTH halves of
 * a denial's evidence: the thrown PolicyDeniedError the caller receives, and
 * the policy_denied chain event the governor writes before rethrowing it. The
 * earlier ruling here said denials wrote no audit event at all, and that was
 * true when it was written — the denial-events change made it false, and
 * Exhibit C renders the real captured event in full.
 *
 * The policy editor (left) is TerminalFrame with title="policy.yaml" — a
 * clean fit for the shared {title, children} shape, imported directly into
 * this client island since TerminalFrame is plain markup with no
 * server-only APIs. The compact thrown-error card (right, in the narrow
 * w-72 print-spool column) stays a small receipt-style chit matching the
 * chit stack above it, not a full TerminalFrame: its 12px type (the
 * Addendum H floor) and p-3 padding are scaled to the print-spool
 * illustration, not the page's code-surface body copy, and forcing the
 * 14px contract onto it would overpower that narrow column.
 */
export default function ExhibitFSpool() {
	// "settled" is both the server HTML and the reduced-motion experience:
	// spool settled, violator already ejected into the rail, stamp applied.
	const [phase, setPhase] = useState<Phase>("settled");
	const [ejecting, setEjecting] = useState(false);
	const [ejected, setEjected] = useState(true);
	/*
	 * Hover and pin are two different states and used to share one slot, which
	 * produced two defects at once: a click-pinned chip looked identical to a
	 * merely hovered one, and moving the pointer off a PINNED chip silently
	 * unpinned it (onMouseLeave cleared whatever `activeOp` held, pin or not).
	 * Hover is transient and clears on mouseleave; the pin only toggles on
	 * click/focus. Hover wins the highlight while it exists, so hovering a
	 * neighbour still previews it without destroying the pin underneath.
	 */
	const [pinnedOp, setPinnedOp] = useState<PolicyOp | null>(null);
	const [hoverOp, setHoverOp] = useState<PolicyOp | null>(null);
	const activeOp = hoverOp ?? pinnedOp;
	const rootRef = useRef<HTMLDivElement | null>(null);
	const playedRef = useRef(false);

	useEffect(() => {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const root = rootRef.current;
		if (!root) return;
		setPhase("armed");
		setEjected(false);
		const io = new IntersectionObserver(
			([record]) => {
				if (!record?.isIntersecting || playedRef.current) return;
				playedRef.current = true;
				io.disconnect();
				setPhase("playing");
			},
			{ threshold: SPOOL_IO_THRESHOLD },
		);
		io.observe(root);
		return () => io.disconnect();
	}, []);

	const railVisible = ejected || phase === "settled";

	return (
		// The YAML wants the spare width, not an even split: the policy's longest
		// line runs well past half the row, while the right column is a fixed
		// narrow stack that was centering itself inside a much wider cell on
		// desktop while the editor clipped rule values mid-token at every width.
		<div
			ref={rootRef}
			className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-[minmax(0,1fr)_20rem]"
		>
			{/* left: the policy, as a mono editor frame */}
			{/* self-start, not the grid's default stretch: matching the spool
			    column's height left a tall band of empty terminal under the last
			    YAML line, which reads as a broken frame rather than a tall one. */}
			<TerminalFrame className="self-start" title="policy.yaml">
				<pre>
					{POLICY_LINES.map((line, i) => {
						const hot = activeOp !== null && opsInLine(line).includes(activeOp);
						return (
							<div key={i} className={editorLineClass(hot)}>
								{line.segs.map((seg, j) => {
									const op = seg.op;
									if (!op) return <span key={j}>{seg.t}</span>;
									return (
										<button
											key={j}
											type="button"
											data-operator={op}
											data-cursor-hover
											aria-pressed={pinnedOp === op}
											onClick={() => setPinnedOp((cur) => (cur === op ? null : op))}
											onMouseEnter={() => setHoverOp(op)}
											onMouseLeave={() => setHoverOp((cur) => (cur === op ? null : cur))}
											onFocus={() => setHoverOp(op)}
											onBlur={() => setHoverOp((cur) => (cur === op ? null : cur))}
											className="focus-ring rounded-sm border border-tim/40 bg-tim/10 px-1 text-tim transition-colors aria-pressed:border-tim aria-pressed:bg-tim/30 aria-pressed:text-white"
										>
											{seg.t}
										</button>
									);
								})}
							</div>
						);
					})}
				</pre>
			</TerminalFrame>

			{/* right: the print spool + the denial's thrown-error card */}
			<div>
				<div className="mx-auto w-72">
					<div className="rounded-sm border border-brand-border bg-brand-surface px-3 py-2 text-center font-mono text-[12px] uppercase tracking-widest text-white/70">
						print spool
					</div>
					<ol className="mt-3 flex flex-col gap-2">
						{CHITS.map((chit, i) => {
							const violator = chit.verdict === "blocked";
							if (violator && (phase === "settled" || ejected)) return null;
							const anim =
								phase === "armed"
									? "opacity-0"
									: phase === "playing"
										? violator && ejecting
											? "chit-eject"
											: "chit-drop"
										: "";
							return (
								<li
									key={chit.id}
									className={chitCardClass(violator, anim)}
									style={
										phase === "playing" && !(violator && ejecting)
											? { animationDelay: `${i * DROP_STAGGER_MS}ms` }
											: undefined
									}
									onAnimationEnd={
										violator
											? (e) => {
													if (e.animationName === "chit-drop") setEjecting(true);
													if (e.animationName === "chit-eject") setEjected(true);
												}
											: undefined
									}
								>
									<div className="flex items-center justify-between font-mono text-[12px] text-white/70">
										<span>{chit.id}</span>
										{chit.verdict === "pass" ? (
											<span className="text-ut">✓</span>
										) : (
											<span className="text-danger">✗</span>
										)}
									</div>
									{chit.lines.map((ln) => {
										const hot = activeOp !== null && (ln.caughtBy ?? []).includes(activeOp);
										if (ln.redacted) {
											return (
												<div
													key={ln.label}
													className="mt-1 flex items-center gap-2"
													data-operator={(ln.caughtBy ?? []).join(" ")}
												>
													<span className="font-mono text-[12px] text-white/70">{ln.label}</span>
													<span
														role="img"
														aria-label="card number redacted before it ever reached the ledger"
														className="h-2 flex-1 rounded-[1px]"
														style={{
															background:
																"repeating-linear-gradient(90deg, rgba(242,239,230,0.8) 0 18px, transparent 18px 24px)",
														}}
													/>
												</div>
											);
										}
										return (
											<div
												key={ln.label}
												data-operator={(ln.caughtBy ?? []).join(" ")}
												className={`mt-1 flex justify-between font-mono text-[12px] ${chitLineClass(hot)}`}
											>
												<span>{ln.label}</span>
												<span>{ln.value}</span>
											</div>
										);
									})}
								</li>
							);
						})}
					</ol>

					{/* the denial's evidence — a thrown error, NOT a chain entry */}
					<div className="mt-6 border-t border-dashed border-brand-border pt-3">
						<p className="font-mono text-[12px] uppercase tracking-widest text-white/70">
							thrown AND chained
						</p>
						{railVisible ? (
							<div
								className={`lift-1 relative mt-2 rounded-sm border border-danger/50 bg-danger/5 p-3 ${
									phase === "playing" ? "rail-arrive" : ""
								}`}
							>
								{/* The stamp is lifted clear of the text block and the first
								    paragraph reserves the stamp's footprint (pr-24): at
								    -top-3 the stamp's lower border stroke ran straight
								    through both 12px lines of RAIL_THROWN, reading as
								    strike-through rather than as a stamp. */}
								<Stamp word="BLOCKED" className="absolute -right-3 -top-6 z-10" />
								<p className="pr-24 font-mono text-[12px] text-white/80">{RAIL_THROWN}</p>
								<p className="mt-1 font-mono text-[12px] text-ut/90">{RAIL_CHAINED}</p>
								<p className="mt-1 font-mono text-[12px] text-white/70">{RAIL_REASON}</p>
							</div>
						) : (
							/* reserved space — the card's arrival must not shift layout.
							   h-32, not h-24: the settled card measures ~120px (p-3 plus
							   two wrapped RAIL_THROWN lines and three wrapped RAIL_REASON
							   lines), so the shorter placeholder shifted the column ~24px
							   on arrival — the exact shift it exists to prevent. */
							<div className="mt-2 h-40" aria-hidden="true" />
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
