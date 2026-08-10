"use client";

import { useEffect, useRef, useState } from "react";
import {
	finalLineText,
	IO_THRESHOLD,
	initialTypewriterFrame,
	lastLineIndex,
	splitTranscriptLine,
	stepTypewriter,
	transcriptMinHeightPx,
	visibleLines,
} from "@/lib/exhibit-e-transcript";

type Phase = "static" | "waiting" | "typing" | "done";

/**
 * Terminal body — rendered as TerminalFrame's children (exhibit-e.tsx owns
 * the frame itself, since it's a server component that can pass this client
 * island through as children). This root div owns only the one thing the
 * shared frame can't know about: min-h reserves the tallest state so the
 * typewriter never shifts layout; the mono body copy, padding, and
 * horizontal scroll all come from TerminalFrame now. Server HTML is the
 * FINISHED transcript (island contract): reduced-motion and no-JS visitors
 * get the whole thing immediately, final line already emerald. Motion users
 * are re-armed to blank in the effect below and get one typing pass, fired
 * once by IntersectionObserver, before the section scrolls into view. Lines
 * batch per rAF tick, never per character — only the final line types
 * char-by-char. The batching math, its timing constants, and the array-index
 * bookkeeping all live in app/lib/exhibit-e-transcript.ts: check-facts scans
 * this file for bare digit literals, so none of that can live here.
 */
export default function ExhibitETranscript({ lines }: { lines: string[] }) {
	const lastIndex = lastLineIndex(lines);
	const [phase, setPhase] = useState<Phase>("static");
	const [shownLines, setShownLines] = useState(lines.length);
	const [finalChars, setFinalChars] = useState(lines[lastIndex]?.length ?? 0);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const rafRef = useRef(0);
	// The finished transcript's REAL height, measured off the server-rendered
	// DOM before the island blanks it. Null until measured; the lib's line-count
	// floor covers no-JS, reduced-motion and that one pre-measurement render.
	const [measuredPx, setMeasuredPx] = useState<number | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: lines/lastIndex are stable fixture data — this set-piece arms once per mount, not on every render.
	useEffect(() => {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const root = rootRef.current;
		if (!root) return;

		let played = false;
		const finalLineLength = lines[lastIndex]?.length ?? 0;

		const start = () => {
			let frame = initialTypewriterFrame();
			const tick = (t: number) => {
				frame = stepTypewriter(frame, t, lastIndex, finalLineLength);
				setShownLines(frame.shownLines);
				setFinalChars(frame.finalChars);
				if (frame.phase === "done") {
					setPhase("done");
					return;
				}
				rafRef.current = requestAnimationFrame(tick);
			};
			rafRef.current = requestAnimationFrame(tick);
		};

		const io = new IntersectionObserver(
			([record]) => {
				if (!record?.isIntersecting || played) return;
				played = true;
				io.disconnect();
				setPhase("typing");
				start();
			},
			{ threshold: IO_THRESHOLD },
		);

		// Measure BEFORE arming. What is on screen right now is the finished
		// transcript the server sent, with every soft wrap this viewport
		// produces, so its height is the exact height the typewriter will end
		// at — which a line COUNT cannot know (see transcriptMinHeightPx).
		// Both state writes land in the same commit, so the blanked render is
		// already reserving the measured height and the box never shrinks.
		setMeasuredPx(root.getBoundingClientRect().height);

		// Arm: blank the terminal now, before it scrolls into view.
		setPhase("waiting");
		setShownLines(0);
		setFinalChars(0);
		io.observe(root);

		return () => {
			io.disconnect();
			cancelAnimationFrame(rafRef.current);
		};
	}, []);

	const showFinal =
		phase === "static" || phase === "done" || (phase === "typing" && shownLines >= lastIndex);

	return (
		<div ref={rootRef} style={{ minHeight: `${measuredPx ?? transcriptMinHeightPx(lines)}px` }}>
			{/* Screen readers get the whole transcript immediately; the
			    typewriter is a purely visual effect. */}
			<pre className="sr-only">{lines.join("\n")}</pre>
			<div aria-hidden="true">
				{visibleLines(lines, shownLines).map((line, i) => {
					const { key, value } = splitTranscriptLine(line);
					return (
						// whitespace-pre-wrap, not whitespace-pre: the verdict line
						// ("Vault integrity: VERIFIED (UNANCHORED — internal consistency
						// only)") is longer than the frame is wide, so pre clipped it
						// mid-word at every viewport — and the crop landed exactly on the
						// honesty qualifier. Soft wrap makes the sentence fully visible
						// without interaction; the Merkle root hex has no break
						// opportunity, so it still rides the frame's overflow-x-auto.
						<div key={line || `blank-${i}`} className="whitespace-pre-wrap">
							{key && <span className="text-tim">{key}</span>}
							<span className="text-white">{value}</span>
						</div>
					);
				})}
				{showFinal && lastIndex >= 0 && (
					<div
						className={`whitespace-pre-wrap text-ut ${phase === "done" || phase === "static" ? "ok-stamp" : ""}`}
					>
						{phase === "typing" ? finalLineText(lines, finalChars) : lines[lastIndex]}
					</div>
				)}
			</div>
		</div>
	);
}
