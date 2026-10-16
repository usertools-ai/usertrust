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
 * Text the CLI prints at an operator's terminal that carries configured values (a ledger
 * address, a config path, a child's stderr). Turns U+2028 and U+2029 into `\n`, so they are
 * line breaks like any other (a caller that joins lines on `\n` folds them too, and an OSC body
 * stops at them); removes escape sequences, then every C0, DEL and C1 character (U+0085
 * included), keeping only the line breaks; then clips to MAX_PRINTED_CHARS. In that
 * order: sanitized before it is clipped, so a cut can never leave half a sequence behind.
 */
export function scrubForStderr(text: string): string {
	const clean = text
		.replace(LINE_SEPARATORS, "\n")
		.replace(ESCAPE_SEQUENCES, "")
		.split("\n")
		.map((line) => line.replace(CONTROL_CHARACTERS, ""))
		.join("\n");
	const chars = Array.from(clean);
	return chars.length <= MAX_PRINTED_CHARS
		? clean
		: `${chars.slice(0, MAX_PRINTED_CHARS).join("")}…`;
}
