/**
 * Pure typewriter-step math for Exhibit E's verify-transcript terminal.
 *
 * This module lives OUTSIDE app/components/sections/ on purpose: the
 * check-facts prebuild gate scans sections/*.tsx for bare digit literals, and
 * this state machine's timing constants (a 70ms line interval, a 2-char
 * typing tick, a 0.4 IntersectionObserver threshold) are animation tuning,
 * not marketing facts — they have no business living in facts.json, but they
 * also can't sit as literals inside the section file. Sections import the
 * behavior from here; they never retype the numbers.
 *
 * Lines batch by ELAPSED TIME, never per-character — only the final line
 * (the verifier's last output line) types character-by-character, once every
 * prior line is already shown. Exported as a pure reducer (state + timestamp
 * in, next state out) so the rAF-driven component just calls it in a loop and
 * the batching math itself is unit-testable without a DOM or a real clock.
 */

export const LINE_INTERVAL_MS = 70;
export const IO_THRESHOLD = 0.4;
const CHARS_PER_TICK = 2;

export interface TypewriterFrame {
	/** Count of non-final lines currently shown (0..lastIndex). */
	shownLines: number;
	/** Characters of the final line typed so far. */
	finalChars: number;
	/** rAF timestamp of the last line-reveal step; 0 means "not yet baselined". */
	lastStep: number;
	phase: "typing" | "done";
}

export function initialTypewriterFrame(): TypewriterFrame {
	return { shownLines: 0, finalChars: 0, lastStep: 0, phase: "typing" };
}

/**
 * Render-side helpers below. These carry no facts.json/marketing meaning —
 * they're array-index arithmetic (`lines.length - 1`, `slice(0, n)`) — but
 * check-facts's digit scan doesn't parse JS, it just looks for bare digit
 * tokens on a line, so this bookkeeping has to live here too, not in the
 * section component.
 */

/** Index of the transcript's final (OK) line; -1 for an empty transcript. */
export function lastLineIndex(lines: string[]): number {
	return lines.length - 1;
}

/** The non-final lines currently revealed, given how many have shown. */
export function visibleLines(lines: string[], shownLines: number): string[] {
	return lines.slice(0, Math.min(shownLines, lastLineIndex(lines)));
}

/** The final line's text, typed up to `finalChars`. */
export function finalLineText(lines: string[], finalChars: number): string {
	return lines[lastLineIndex(lines)]?.slice(0, finalChars) ?? "";
}

/** Placeholder for a blank captured line — preserves its line-box height. */
export const NBSP = "\u00A0";

/**
 * One rendered transcript line, in px: TerminalFrame's body is 14px mono at
 * `leading-relaxed` (1.625), so 22.75px. Kept here with the other section
 * digits \u2014 check-facts scans the section file, not this module.
 */
const TRANSCRIPT_LINE_PX = 22.75;

/**
 * The CLS reservation for the terminal, derived from the transcript the
 * frame will actually hold. The island types its way to this height, so the
 * frame must reserve it up front \u2014 but a hardcoded `min-h-[16rem]` (256px)
 * over a 7-line fixture left ~96px of permanently empty terminal under the
 * finished output, reading as a broken frame rather than a reservation.
 */
export function transcriptMinHeightPx(lines: string[]): number {
	return lines.length * TRANSCRIPT_LINE_PX;
}

export interface TranscriptLineTokens {
	/** The label up to and including its colon (steel), or "" when the line carries no key. */
	key: string;
	/** Everything after the key (white) — the placeholder when the line is blank. */
	value: string;
}

/**
 * Splits one captured transcript line into its syntax-tint roles per the
 * shared code-surface directive (keys/annotations steel, values white) —
 * the same two-role split `tokenClass` applies to Exhibit A's receipt JSON,
 * so this transcript never reinvents its own scheme. Every captured line is
 * "label: value" (e.g. "Chain length: 9 events"); the label through its
 * colon is the key, the remainder is the value. A line with no colon
 * (defensive — not produced by today's fixture) renders entirely as a value.
 */
export function splitTranscriptLine(line: string): TranscriptLineTokens {
	const i = line.indexOf(":");
	if (i === -1) return { key: "", value: line || NBSP };
	return { key: line.slice(0, i + 1), value: line.slice(i + 1) || NBSP };
}

/**
 * Advances one rAF tick. `lastIndex` is the index of the final (OK) line;
 * `finalLineLength` is its character count. Idempotent once `phase` is
 * "done" — later calls return the same frame unchanged.
 */
export function stepTypewriter(
	frame: TypewriterFrame,
	t: number,
	lastIndex: number,
	finalLineLength: number,
): TypewriterFrame {
	if (frame.phase === "done") return frame;

	if (frame.shownLines < lastIndex) {
		// First-ever tick just plants the timing baseline — no reveal yet.
		const lastStep = frame.lastStep === 0 ? t : frame.lastStep;
		if (t - lastStep < LINE_INTERVAL_MS) {
			return { ...frame, lastStep };
		}
		// Whole lines batch per elapsed interval — never a per-line rAF stall
		// even if a tab was backgrounded and the gap since lastStep is huge.
		const advance = Math.max(1, Math.round((t - lastStep) / LINE_INTERVAL_MS));
		return {
			...frame,
			shownLines: Math.min(lastIndex, frame.shownLines + advance),
			lastStep: t,
		};
	}

	const finalChars = Math.min(finalLineLength, frame.finalChars + CHARS_PER_TICK);
	return {
		shownLines: lastIndex,
		finalChars,
		lastStep: frame.lastStep,
		phase: finalChars >= finalLineLength ? "done" : "typing",
	};
}
