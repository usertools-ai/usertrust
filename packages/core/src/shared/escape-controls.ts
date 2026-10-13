// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Untrusted text (a path the caller named) shown on a terminal: C0, DEL and C1 are written as
 * visible escapes, `\n`, `\r` and `\t` by name and the rest as `\xHH`, so a crafted directory name
 * can neither forge a line nor drive the terminal (C1 holds the 8-bit CSI/OSC introducers).
 *
 * An ESCAPER, not one of AGENTS.md's sanitizers: it keeps every character readable rather than
 * replacing it with `?`, because the text it shows is a path the operator has to find. A backslash
 * is left as it is, so a Windows path reads as written. Apply it to the DISPLAYED copy only; the
 * filesystem gets the real path. The CLI's sanitizers live in `cli/`, which the governor does not
 * import; this is the shared one for the governor's own notices and refusals.
 */
export function escapeControls(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? escapeOne(ch, code) : ch;
	}
	return out;
}

const NAMED: Record<string, string> = { "\t": "\\t", "\n": "\\n", "\r": "\\r" };

function escapeOne(ch: string, code: number): string {
	return NAMED[ch] ?? `\\x${code.toString(16).padStart(2, "0")}`;
}
