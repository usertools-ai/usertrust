import { describe, expect, it } from "vitest";
import { MAX_PRINTED_CHARS, scrubForStderr } from "../src/cli/scrub.js";

describe("scrubForStderr", () => {
	it("removes 7-bit and 8-bit escape sequences whole", () => {
		expect(scrubForStderr("a\x1b[2Jb")).toBe("ab");
		expect(scrubForStderr("a\x9b31mb")).toBe("ab");
		expect(scrubForStderr("a\x1b]0;pwned\x07b")).toBe("ab");
		expect(scrubForStderr("a\x9d0;pwned\x9cb")).toBe("ab");
	});

	it("removes every other C0, DEL and C1 character, and keeps line breaks", () => {
		expect(scrubForStderr("one\x00\x07\t\r\x7f\x85\x9f\ntwo")).toBe("one\ntwo");
	});

	it("U+2028 and U+2029 are line breaks, and U+0085 is removed as a C1 control", () => {
		const ls = String.fromCodePoint(0x2028);
		const ps = String.fromCodePoint(0x2029);
		const nel = String.fromCodePoint(0x85);
		const out = scrubForStderr(`one${ls}two${ps}three${nel}four`);
		expect(out).toBe("one\ntwo\nthreefour");
		for (const char of [ls, ps, nel]) expect(out).not.toContain(char);
		// An OSC body stops at them as it does at a newline.
		expect(scrubForStderr(`a\x1b]0;title${ls}the fix`)).toBe("a\nthe fix");
	});

	it("an unterminated OSC cannot swallow the lines after it", () => {
		expect(scrubForStderr("a\x1b]0;title\nthe fix")).toBe("a\nthe fix");
	});

	it("leaves ordinary text alone", () => {
		const text = "no TigerBeetle answered at 127.0.0.1:3001 (cluster 0): é 漢 [ok]";
		expect(scrubForStderr(text)).toBe(text);
	});

	it("clips after sanitizing, so a cut never leaves part of a sequence", () => {
		const text = `${"x".repeat(MAX_PRINTED_CHARS - 1)}\x1b[2J${"y".repeat(100)}`;
		const out = scrubForStderr(text);
		expect(out).toBe(`${"x".repeat(MAX_PRINTED_CHARS - 1)}y…`);
		expect(out).not.toContain("[2J");
	});

	it("clips to the max it is given, in code points, and not at all at Infinity", () => {
		expect(scrubForStderr("ab\x1b[2Jcd", 3)).toBe("abc\u2026");
		// Two code units each: three of them fit a max of 3, though their length is 6.
		const face = String.fromCodePoint(0x1f600);
		expect(scrubForStderr(face.repeat(3), 3)).toBe(face.repeat(3));
		expect(scrubForStderr(face.repeat(3), 2)).toBe(`${face.repeat(2)}\u2026`);
		const long = "x".repeat(MAX_PRINTED_CHARS * 3);
		expect(scrubForStderr(`${long}\x1b[2J`, Number.POSITIVE_INFINITY)).toBe(long);
	});
});
