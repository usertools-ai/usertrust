// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * THE TAIL READ. The writer decides how to continue a log from its last line alone, so it reads
 * only the end of the file: `readTailText` reads the last `windowBytes` bytes and doubles the
 * window back toward the start until the text holds the last non-blank line complete with some
 * non-blank text before it (so trimming the text never reaches into that line), or the whole file.
 * The text always starts at the start of the file or just after a newline byte, never inside a
 * character, so a window boundary cannot split one.
 *
 * Small windows exercise the growth here without large files. The writer's verdicts on logs
 * larger than the default window are held in tail-read-verdicts.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTailText } from "../../src/audit/chain.js";

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A new file holding exactly `content`; its path. */
function fileWith(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "trust-tail-read-"));
	dirs.push(dir);
	const path = join(dir, "events.jsonl");
	writeFileSync(path, content);
	return path;
}

/** `lines`, each terminated by `eol`. */
const terminated = (lines: readonly string[], eol = "\n"): string =>
	lines.map((l) => `${l}${eol}`).join("");

/** `n` short event-shaped lines. */
const shortLines = (n: number): string[] =>
	Array.from({ length: n }, (_, i) => `{"sequence":${i + 1}}`);

/** The last non-blank line as the writer's verdict reads it: the text trimmed, split on "\n". */
function lastLineOf(text: string): string {
	const lines = text.trim().split("\n");
	return lines[lines.length - 1] as string;
}

/**
 * What every read must give: a suffix of the file that starts at its start or just after a
 * newline byte, decoded intact, whose last line (as the verdict reads it) is the whole file's; and
 * `whole` exactly when that suffix is the whole file.
 */
function expectTailOf(path: string, r: { text: string; whole: boolean }): void {
	const file = readFileSync(path);
	const tail = Buffer.from(r.text, "utf8");
	const start = file.length - tail.length;
	expect(start).toBeGreaterThanOrEqual(0);
	expect(file.subarray(start).equals(tail)).toBe(true);
	expect(r.whole).toBe(start === 0);
	if (start > 0) expect(file[start - 1]).toBe(0x0a);
	expect(r.text.includes("\ufffd")).toBe(false);
	expect(lastLineOf(r.text)).toBe(lastLineOf(file.toString("utf8")));
}

/**
 * The fewest bytes a read can end with: from the newline before the last non-blank character
 * that precedes the last non-blank line, to the end of the file (the whole file when there is no
 * such newline). A window doubled from `window` stops below twice that, or at `window`.
 */
function boundOf(path: string, window: number): number {
	const s = readFileSync(path, "utf8");
	const lastEnd = s.trimEnd().length;
	const lastStart = s.lastIndexOf("\n", lastEnd - 1) + 1;
	const prevEnd = s.slice(0, lastStart).trimEnd().length;
	const newline = prevEnd === 0 ? -1 : s.lastIndexOf("\n", prevEnd - 1);
	const fewest = newline === -1 ? Buffer.byteLength(s) : Buffer.byteLength(s.slice(newline));
	return Math.max(window, 2 * fewest);
}

/** The read is bounded by the window's growth, not by the size of the file. */
function expectBounded(path: string, window: number, r: { text: string }): void {
	expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(boundOf(path, window));
}

describe("readTailText: files it reads to their start", () => {
	it("an empty file is empty text, read whole", () => {
		expect(readTailText(fileWith(""), 16)).toEqual({ text: "", whole: true });
	});

	it("a file of blank lines and spaces longer than the window is read to its start", () => {
		for (const content of [" \n\t\n\n".repeat(40), `${" \n".repeat(40)}   `]) {
			expect(readTailText(fileWith(content), 16)).toEqual({ text: content, whole: true });
		}
	});

	it("one line shorter than the window, with and without its newline, is read whole", () => {
		for (const content of ['{"a":1}\n', '{"a":1}']) {
			expect(readTailText(fileWith(content), 16)).toEqual({ text: content, whole: true });
		}
	});

	it("one line longer than the window by several doublings, with and without its newline", () => {
		const line = `{"pad":"${"x".repeat(1000)}"}`;
		for (const content of [`${line}\n`, line, `${line}\n\n  \n`]) {
			expect(readTailText(fileWith(content), 16)).toEqual({ text: content, whole: true });
		}
	});

	it("a log with no newline at all is read to its start, its text the whole file", () => {
		const content = '{"id":"half-writ'.repeat(30);
		expect(readTailText(fileWith(content), 16)).toEqual({ text: content, whole: true });
	});

	it("a byte order mark at the start of the file is kept in the text, as a full read keeps it", () => {
		const path = fileWith('\ufeff{"a":1}\n');
		expect(readTailText(path, 16)).toEqual({ text: readFileSync(path, "utf-8"), whole: true });
		expect(readTailText(path, 16).text.startsWith("\ufeff")).toBe(true);
	});
});

describe("readTailText: files it reads only the end of", () => {
	it("many short lines: the text starts just after a newline, not at the start of the file", () => {
		const path = fileWith(terminated(shortLines(200)));
		for (const window of [16, 32, 64]) {
			const r = readTailText(path, window);
			expect(r.whole).toBe(false);
			expectTailOf(path, r);
			expectBounded(path, window, r);
		}
	});

	it("a last line longer than the window: the window grows back past its start", () => {
		const big = `{"sequence":501,"pad":"${"x".repeat(1000)}"}`;
		const path = fileWith(terminated([...shortLines(500), big]));
		for (const window of [16, 32]) {
			const r = readTailText(path, window);
			expect(r.whole).toBe(false);
			expect(r.text.endsWith(`${big}\n`)).toBe(true);
			expectTailOf(path, r);
			expectBounded(path, window, r);
		}
	});

	it("blank lines and spaces after the last line, longer than the window, are read past", () => {
		const path = fileWith(`${terminated(shortLines(100))}${" \n\n\t\n   \n".repeat(30)}`);
		const r = readTailText(path, 16);
		expect(r.whole).toBe(false);
		expect(r.text).toContain('{"sequence":100}\n');
		expectTailOf(path, r);
		expectBounded(path, 16, r);
	});

	it("lines of Unicode whitespace after the last line are read past as blank", () => {
		const blanks = "\u00a0\n\u2028\n\ufeff\n\u3000 \n".repeat(20);
		const path = fileWith(`${terminated(shortLines(100))}${blanks}`);
		const r = readTailText(path, 16);
		expect(r.whole).toBe(false);
		expect(r.text).toContain('{"sequence":100}\n');
		expectTailOf(path, r);
		expectBounded(path, 16, r);
	});

	it("a last line led by whitespace is read with a non-blank line before it", () => {
		for (const lead of ["  ", "\t", "\u00a0", "\ufeff"]) {
			const path = fileWith(`${terminated([...shortLines(100), `${lead}{"sequence":101}`])}\n\n`);
			const r = readTailText(path, 16);
			expect(r.whole).toBe(false);
			expect(lastLineOf(r.text)).toBe(`${lead}{"sequence":101}`);
			expectTailOf(path, r);
			expectBounded(path, 16, r);
		}
	});

	it("a character cut by the window boundary is decoded whole, at every cut", () => {
		const lines = Array.from({ length: 30 }, (_, i) =>
			i % 2 === 0 ? "\u20ac".repeat(20) : "\u{1f600}".repeat(15),
		);
		const path = fileWith(terminated([...lines, "\u00e9\u20ac\u{1f600}".repeat(12)]));
		for (let window = 16; window <= 48; window++) {
			const r = readTailText(path, window);
			expect(r.whole).toBe(false);
			expectTailOf(path, r);
			expectBounded(path, window, r);
		}
	});

	it("CRLF line endings: the text starts after a line feed and keeps every carriage return", () => {
		const path = fileWith(terminated(shortLines(100), "\r\n"));
		const r = readTailText(path, 16);
		expect(r.whole).toBe(false);
		expect(r.text.endsWith('{"sequence":100}\r\n')).toBe(true);
		expectTailOf(path, r);
		expectBounded(path, 16, r);
	});

	it("a torn tail, short or longer than the window: the text holds every byte after the newline", () => {
		for (const torn of [
			'{"id":"half-writ',
			`{"pad":"${"y".repeat(300)}`,
			"  ",
			"\u20ac\u{1f600}",
		]) {
			const path = fileWith(`${terminated(shortLines(100))}${torn}`);
			const r = readTailText(path, 16);
			expect(r.whole).toBe(false);
			expect(r.text.endsWith(`\n${torn}`)).toBe(true);
			expectTailOf(path, r);
			expectBounded(path, 16, r);
		}
	});

	it("the default window: a log of about 1 MB is read from its last 8 KiB only", () => {
		const line = (i: number) => `{"sequence":${i + 1},"pad":"${"p".repeat(180)}"}`;
		const path = fileWith(terminated(Array.from({ length: 5000 }, (_, i) => line(i))));
		expect(readFileSync(path).length).toBeGreaterThan(1_000_000);
		const r = readTailText(path);
		expect(r.whole).toBe(false);
		expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(8192);
		expectTailOf(path, r);
	});
});
