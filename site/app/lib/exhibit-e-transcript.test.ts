import assert from "node:assert/strict";
import { test } from "node:test";
import {
	finalLineText,
	initialTypewriterFrame,
	lastLineIndex,
	NBSP,
	splitTranscriptLine,
	stepTypewriter,
	transcriptMinHeightPx,
	visibleLines,
} from "./exhibit-e-transcript";

test("the CLS reservation is derived from the transcript, not a fixed 16rem", () => {
	const seven = ["a", "b", "c", "d", "e", "f", "g"];
	// 14px mono at leading-relaxed (1.625) = 22.75px per rendered line.
	assert.equal(transcriptMinHeightPx(seven), 159.25);
	// The old hardcoded min-h-[16rem] (256px) left ~96px of dead frame.
	assert.ok(transcriptMinHeightPx(seven) < 256);
	assert.equal(transcriptMinHeightPx([]), 0);
});

test("initialTypewriterFrame is the zeroed typing baseline", () => {
	assert.deepEqual(initialTypewriterFrame(), {
		shownLines: 0,
		finalChars: 0,
		lastStep: 0,
		phase: "typing",
	});
});

test("the first tick only records a timing baseline — no lines reveal yet", () => {
	const frame = stepTypewriter(initialTypewriterFrame(), 1000, 5, 10);
	assert.equal(frame.shownLines, 0);
	assert.equal(frame.lastStep, 1000);
	assert.equal(frame.phase, "typing");
});

test("a tick short of the line interval since the baseline advances nothing", () => {
	const baseline = stepTypewriter(initialTypewriterFrame(), 1000, 5, 10);
	const frame = stepTypewriter(baseline, 1030, 5, 10); // 30ms since baseline, interval is 70ms
	assert.equal(frame.shownLines, 0);
	assert.equal(frame.lastStep, 1000, "lastStep is unchanged until the interval elapses");
});

test("lines batch — one interval crossed reveals one line, never a per-char reveal", () => {
	const baseline = stepTypewriter(initialTypewriterFrame(), 1000, 5, 10);
	const frame = stepTypewriter(baseline, 1071, 5, 10); // 71ms elapsed, one interval
	assert.equal(frame.shownLines, 1);
	assert.equal(frame.lastStep, 1071);
});

test("a large elapsed gap batches multiple lines in a single tick, clamped to lastIndex", () => {
	const baseline = stepTypewriter(initialTypewriterFrame(), 1000, 5, 10);
	const frame = stepTypewriter(baseline, 1000 + 1000, 5, 10); // way more than 5 intervals
	assert.equal(frame.shownLines, 5, "clamped at lastIndex, never past it");
	assert.equal(frame.phase, "typing", "shownLines reaching lastIndex is not yet 'done'");
});

test("once every prior line has shown, the final line types at 2 chars per tick", () => {
	let frame = stepTypewriter(initialTypewriterFrame(), 1000, 5, 10);
	frame = { ...frame, shownLines: 5 }; // prior lines already fully revealed
	frame = stepTypewriter(frame, 1071, 5, 10);
	assert.equal(frame.finalChars, 2);
	assert.equal(frame.shownLines, 5);
	frame = stepTypewriter(frame, 1142, 5, 10);
	assert.equal(frame.finalChars, 4);
});

test("the final line's char count caps at its length and never overshoots on an odd length", () => {
	let frame: ReturnType<typeof stepTypewriter> = {
		shownLines: 3,
		finalChars: 6,
		lastStep: 1000,
		phase: "typing",
	};
	frame = stepTypewriter(frame, 1071, 3, 7); // odd-length final line
	assert.equal(frame.finalChars, 7, "capped at finalLineLength, not 8");
	assert.equal(frame.phase, "done", "phase flips to done the instant finalChars reaches the cap");
});

test("phase 'done' is terminal — further ticks are no-ops", () => {
	const done = { shownLines: 2, finalChars: 5, lastStep: 1000, phase: "done" as const };
	const next = stepTypewriter(done, 5000, 2, 5);
	assert.deepEqual(next, done);
});

test("an empty transcript (lastIndex -1, zero-length final line) is done on the very first tick", () => {
	const frame = stepTypewriter(initialTypewriterFrame(), 1000, -1, 0);
	assert.equal(frame.shownLines, -1);
	assert.equal(frame.finalChars, 0);
	assert.equal(frame.phase, "done");
});

// ---------------------------------------------------------------------------
// Render-side helpers — kept here (not in the section component) so
// check-facts's digit scan never has to see this arithmetic.
// ---------------------------------------------------------------------------

test("lastLineIndex is length-minus-one, and -1 for an empty transcript", () => {
	assert.equal(lastLineIndex(["a", "b", "c"]), 2);
	assert.equal(lastLineIndex(["only"]), 0);
	assert.equal(lastLineIndex([]), -1);
});

test("visibleLines returns every non-final line up to shownLines, clamped at lastIndex", () => {
	const lines = ["one", "two", "three", "four"]; // lastIndex = 3
	assert.deepEqual(visibleLines(lines, 0), []);
	assert.deepEqual(visibleLines(lines, 2), ["one", "two"]);
	assert.deepEqual(
		visibleLines(lines, 999),
		["one", "two", "three"],
		"never includes the final line, however far shownLines overshoots",
	);
});

test("finalLineText types the final line up to finalChars and handles an empty transcript", () => {
	const lines = ["first", "verified OK"];
	assert.equal(finalLineText(lines, 0), "");
	assert.equal(finalLineText(lines, 4), "veri");
	assert.equal(finalLineText(lines, 999), "verified OK", "never overshoots the real line text");
	assert.equal(finalLineText([], 5), "", "no final line to type when the transcript is empty");
});

test("NBSP is a real non-breaking space, not an ordinary one", () => {
	assert.equal(NBSP, "\u00A0");
	assert.notEqual(NBSP, " ");
});

// ---------------------------------------------------------------------------
// splitTranscriptLine \u2014 the key/value syntax-tint split (keys/annotations
// steel, values white), per the shared code-surface directive.
// ---------------------------------------------------------------------------

test("splitTranscriptLine splits a 'label: value' line at the first colon, colon stays with the key", () => {
	assert.deepEqual(splitTranscriptLine("Chain length: 9 events"), {
		key: "Chain length:",
		value: " 9 events",
	});
});

test("splitTranscriptLine only splits on the FIRST colon \u2014 timestamps keep theirs in the value", () => {
	assert.deepEqual(splitTranscriptLine("First event: 2026-08-08T00:31:12.036Z"), {
		key: "First event:",
		value: " 2026-08-08T00:31:12.036Z",
	});
});

test("splitTranscriptLine with no colon renders the whole line as a value, no key", () => {
	assert.deepEqual(splitTranscriptLine("no colon in this line"), {
		key: "",
		value: "no colon in this line",
	});
});

test("splitTranscriptLine falls back to NBSP for an empty line, so its box height survives", () => {
	assert.deepEqual(splitTranscriptLine(""), { key: "", value: NBSP });
});

test("splitTranscriptLine falls back to NBSP when the value half is empty (a bare trailing colon)", () => {
	assert.deepEqual(splitTranscriptLine("Status:"), { key: "Status:", value: NBSP });
});
