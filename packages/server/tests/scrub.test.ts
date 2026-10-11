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
});
