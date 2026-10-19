// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/** The most a printed message keeps, in code points, after sanitizing. */
export const MAX_PRINTED_CHARS = 4_096;

// Escape sequences, 7-bit (ESC [ / ESC ]) and 8-bit (CSI / OSC) introducers alike, removed
// WHOLE so none of their text ("[2J") is left behind. An OSC body stops at a newline, so an
// unterminated one cannot swallow the lines after it.
const ESCAPE_SEQUENCES =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
	/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)?|\x1b[@-_]?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control-character strip is a terminal-injection defense
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;
// LINE SEPARATOR and PARAGRAPH SEPARATOR: no control class holds them, and a viewer that
// honours them starts a new line there, so a caller's message could show a forged log line.
// Built from code points so the source carries no invisible character.
const LINE_SEPARATORS = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, "g");

/**
 * `text` sanitized as `scrubForStderr` sanitizes it, never clipped, and where each of its UTF-16
 * code units stood in `text`: unit `j` of `clean` is unit `at[j]` of `text` (U+2028 and U+2029
 * there, `\n` here). The escape sequences are those the same search finds in `text`; then each
 * C0, DEL and C1 unit but the line break is removed. One pass after that search, so a caller can
 * find something in either text and act on the other at the same place.
 */
export function sanitizeMapped(text: string): { clean: string; at: Int32Array } {
	const lines = text.replace(LINE_SEPARATORS, "\n");
	const removed = new Uint8Array(lines.length);
	for (const m of lines.matchAll(ESCAPE_SEQUENCES)) removed.fill(1, m.index, m.index + m[0].length);
	const at = new Int32Array(lines.length);
	let clean = "";
	let kept = 0;
	let from = 0;
	for (let i = 0; i < lines.length; i++) {
		const code = lines.charCodeAt(i);
		const control = code !== 0x0a && (code <= 0x1f || (code >= 0x7f && code <= 0x9f));
		if (removed[i] === 1 || control) {
			clean += lines.slice(from, i);
			from = i + 1;
		} else at[kept++] = i;
	}
	return { clean: clean + lines.slice(from), at: at.subarray(0, kept) };
}

/**
 * Text the CLI prints at an operator's terminal that carries configured values (a ledger
 * address, a config path, a child's stderr). Turns U+2028 and U+2029 into `\n`, so they are
 * line breaks like any other (a caller that joins lines on `\n` folds them too, and an OSC body
 * stops at them); removes escape sequences, then every C0, DEL and C1 character (U+0085
 * included), keeping only the line breaks; then clips to `max` code points (MAX_PRINTED_CHARS
 * unless given). In that order: sanitized before it is clipped, so a cut can never leave half a
 * sequence behind.
 */
export function scrubForStderr(text: string, max: number = MAX_PRINTED_CHARS): string {
	const clean = text
		.replace(LINE_SEPARATORS, "\n")
		.replace(ESCAPE_SEQUENCES, "")
		.split("\n")
		.map((line) => line.replace(CONTROL_CHARACTERS, ""))
		.join("\n");
	// Code units bound code points from above, so text this short needs no count.
	if (clean.length <= max) return clean;
	const chars = Array.from(clean);
	return chars.length <= max ? clean : `${chars.slice(0, max).join("")}\u2026`;
}
