"use client";

import { useEffect, useRef, useState } from "react";
import Stamp from "../stamp";
import {
	CHITS,
	chitCardClass,
	chitLineClass,
	DROP_STAGGER_MS,
	editorLineClass,
	POLICY_LINES,
	type PolicyLine,
	type PolicyOp,
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
 * RULING: denials write NO audit event today. There is deliberately no
 * "audit chain" label and no chain-entry card here — the card that appears
 * when the violating chit ejects is the real thrown error (RAIL_THROWN /
 * PolicyDeniedError), never a logged event. Never rename this back to imply
 * the denial produced an audit-chain entry.
 */
export default function ExhibitFSpool() {
	// "settled" is both the server HTML and the reduced-motion experience:
	// spool settled, violator already ejected into the rail, stamp applied.
	const [phase, setPhase] = useState<Phase>("settled");
	const [ejecting, setEjecting] = useState(false);
	const [ejected, setEjected] = useState(true);
	const [activeOp, setActiveOp] = useState<PolicyOp | null>(null);
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
		<div ref={rootRef} className="mt-12 grid gap-8 md:grid-cols-2">
			{/* left: the policy, as a mono editor frame */}
			<div className="overflow-hidden rounded-xl border border-white/10 bg-[#0d0d20]">
				<div className="flex h-9 items-center border-b border-white/[0.06] px-4 font-mono text-[11px] uppercase tracking-[0.12em] text-white/50">
					policy.yaml
				</div>
				<pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed md:p-5">
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
											aria-pressed={activeOp === op}
											onClick={() => setActiveOp((cur) => (cur === op ? null : op))}
											onMouseEnter={() => setActiveOp(op)}
											onMouseLeave={() => setActiveOp((cur) => (cur === op ? null : cur))}
											onFocus={() => setActiveOp(op)}
											onBlur={() => setActiveOp((cur) => (cur === op ? null : cur))}
											className="focus-ring rounded-sm border border-tim/40 bg-tim/10 px-1 text-tim"
										>
											{seg.t}
										</button>
									);
								})}
							</div>
						);
					})}
				</pre>
			</div>

			{/* right: the print spool + the denial's thrown-error card */}
			<div>
				<div className="mx-auto w-64">
					<div className="rounded-sm border border-brand-border bg-brand-surface px-3 py-2 text-center font-mono text-[0.6rem] uppercase tracking-widest text-white/40">
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
									<div className="flex items-center justify-between font-mono text-[0.6rem] text-white/40">
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
													<span className="font-mono text-[0.6rem] text-white/40">{ln.label}</span>
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
												className={`mt-1 flex justify-between font-mono text-[0.65rem] ${chitLineClass(hot)}`}
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
						<p className="font-mono text-[0.6rem] uppercase tracking-widest text-white/40">
							thrown, not chained
						</p>
						{railVisible ? (
							<div
								className={`relative mt-2 rounded-sm border border-danger/50 bg-danger/5 p-3 ${
									phase === "playing" ? "rail-arrive" : ""
								}`}
							>
								<Stamp word="BLOCKED" className="absolute -right-2 -top-3" />
								<p className="font-mono text-[0.65rem] text-white/80">{RAIL_THROWN}</p>
								<p className="mt-1 font-mono text-[0.6rem] text-white/50">{RAIL_REASON}</p>
							</div>
						) : (
							/* reserved space — the card's arrival must not shift layout */
							<div className="mt-2 h-20" aria-hidden="true" />
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
