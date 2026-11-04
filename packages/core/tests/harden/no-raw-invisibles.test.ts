// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * No tracked text file holds a RAW invisible or control character.
 *
 * Source that contains a bidirectional override, a zero-width character, a byte-order mark or a C0/C1
 * control looks like one thing in an editor and a diff, and means another to the compiler (the
 * "Trojan Source" class). A tool that decodes a JSON string can also turn a written escape into the
 * raw character on its way to disk, so the rule is about the BYTES in the repository, not about what
 * anyone typed. Where one is needed in code, write it as an escape sequence (a backslash, `u` and the
 * hex digits) or build it with `String.fromCodePoint`, so the file stays printable.
 *
 * The scan covers every file `git ls-files` lists and fails with `file:line U+XXXX` for each hit. Text
 * versus binary is decided by EXTENSION first: a known text type (TEXT_EXTENSIONS, and extension-less
 * names such as LICENSE, NOTICE and dotfiles) is ALWAYS scanned, NUL or not, and a known binary type
 * (BINARY_EXTENSIONS) never is. Only an unknown extension falls back to git's own heuristic, a NUL byte
 * in the first 8000 bytes. Without this, a source file that carries a planted NUL, the most hostile case,
 * would be read as a binary and skipped whole. A line is whatever sits between
 * two `\n` characters: never `splitlines`, which also splits on U+2028, U+2029, form feed and others
 * and would move every later line number.
 *
 * FORBIDDEN, as code points: C0 except tab, LF and CR (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F); DEL (0x7F);
 * C1 (0x80-0x9F); U+00AD (soft hyphen); U+061C; U+180E (Mongolian vowel separator); U+200B-U+200F;
 * U+2028 and U+2029; U+202A-U+202E; U+2060-U+2064; U+2066-U+2069; U+FEFF; and the Unicode TAG block
 * U+E0000-U+E007F, invisible in every editor and diff and the known "ASCII smuggling" carrier for hidden
 * instructions in text a model reads. Variation selectors (U+FE00-U+FE0F) stay allowed: emoji use them.
 *
 * ALLOWED_RAW is a census with EXACT per-file counts. An entry that no longer matches (the file is
 * clean now, is untracked, or has a different count) FAILS, so the list cannot rot into a blanket
 * exemption. It is empty today.
 *
 * WHAT A GREEN RUN CLAIMS: no tracked text file outside ALLOWED_RAW contains a forbidden code point,
 * and every ALLOWED_RAW count and code point set is exact. It does not look at binaries, at files git
 * does not track, or at a `-text` attribute (an unknown extension is judged by the NUL heuristic). The
 * "positive control" cases prove the scanner can see each class of character it is meant to catch.
 * Every character below is built from a code point, never typed.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// packages/core/tests/harden -> repo root
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Inclusive code point ranges that are forbidden raw. */
const FORBIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x00, 0x08],
	[0x0b, 0x0c],
	[0x0e, 0x1f],
	[0x7f, 0x7f],
	[0x80, 0x9f],
	[0x00ad, 0x00ad],
	[0x061c, 0x061c],
	[0x180e, 0x180e],
	[0x200b, 0x200f],
	[0x2028, 0x2029],
	[0x202a, 0x202e],
	[0x2060, 0x2064],
	[0x2066, 0x2069],
	[0xfeff, 0xfeff],
	[0xe0000, 0xe007f],
];

export function isForbidden(codePoint: number): boolean {
	return FORBIDDEN_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

interface Hit {
	line: number;
	codePoint: number;
}

const label = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * One native pass over a text: does it hold ANY forbidden code point? Built from FORBIDDEN_RANGES, so the two cannot drift.
 * A clean file (all of them, in a green tree) costs one regular-expression scan instead of a range check per character.
 */
const ANY_FORBIDDEN = new RegExp(
	`[${FORBIDDEN_RANGES.map(([lo, hi]) => `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`).join("")}]`,
	"u",
);

/** Every forbidden code point in `text`, with its 1-based line (lines split on "\n" only). */
export function findInvisibles(text: string): Hit[] {
	const hits: Hit[] = [];
	if (!ANY_FORBIDDEN.test(text)) return hits;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		for (const ch of lines[i] as string) {
			const cp = ch.codePointAt(0) as number;
			if (isForbidden(cp)) hits.push({ line: i + 1, codePoint: cp });
		}
	}
	return hits;
}

/** Extensions (lowercase, no dot) whose files are ALWAYS text: scanned even when they hold a NUL. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
	"ts tsx mts cts js jsx mjs cjs json jsonl md mdx yml yaml css scss html htm sh bash zsh txt toml svg xml tape env py csv tsv lock map".split(
		" ",
	),
);
/** Extensions whose files are NEVER scanned. */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set(
	"png jpg jpeg gif webp ico bmp avif mp4 mov webm m4a mp3 wav ogg woff woff2 ttf otf eot pdf zip gz tgz bz2 xz wasm node".split(
		" ",
	),
);
/** Extension-less names that are text. Any dotfile (.gitignore, .npmrc) is text too. */
const TEXT_NAMES: ReadonlySet<string> = new Set([
	"LICENSE",
	"NOTICE",
	"CODEOWNERS",
	"README",
	"Makefile",
	"Dockerfile",
]);

/** True when the first 8000 bytes hold a NUL: git's own test for a binary file (used for an unknown extension only). */
export function looksBinary(bytes: Buffer): boolean {
	return bytes.subarray(0, 8000).includes(0);
}

/** 'text' (always scanned), 'binary' (never) or 'unknown' (the NUL heuristic decides), by extension. */
export function kindOf(file: string): "text" | "binary" | "unknown" {
	const base = file.slice(file.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	if (dot > 0) {
		const ext = base.slice(dot + 1).toLowerCase();
		if (TEXT_EXTENSIONS.has(ext)) return "text";
		if (BINARY_EXTENSIONS.has(ext)) return "binary";
		return "unknown";
	}
	return dot === 0 || TEXT_NAMES.has(base) ? "text" : "unknown";
}

/** Hits in one file's bytes: all of a known text type, none of a known binary, the NUL heuristic for the rest. */
export function scanFile(file: string, bytes: Buffer): Hit[] {
	const kind = kindOf(file);
	if (kind === "binary") return [];
	if (kind === "unknown" && looksBinary(bytes)) return [];
	return findInvisibles(bytes.toString("utf8"));
}

/**
 * The census: files named in `allowed` must have EXACTLY that many hits; every other file must have
 * none. Returns one sentence per problem, empty when the tree agrees with the census.
 */
export function censusProblems(
	found: ReadonlyMap<string, Hit[]>,
	allowed: Readonly<Record<string, { count: number; codePoints: readonly number[]; why: string }>>,
	tracked: ReadonlySet<string>,
): string[] {
	const problems: string[] = [];
	for (const [file, hits] of found) {
		if (Object.hasOwn(allowed, file)) continue;
		for (const h of hits)
			problems.push(
				`${file}:${h.line} ${label(h.codePoint)} (a raw invisible or control character)`,
			);
	}
	for (const [file, entry] of Object.entries(allowed)) {
		if (!tracked.has(file)) {
			problems.push(`ALLOWED_RAW names ${file}, which is not a tracked file: remove the entry`);
			continue;
		}
		if (entry.why.trim() === "") problems.push(`ALLOWED_RAW entry ${file} has no reason`);
		const hits = found.get(file) ?? [];
		const n = hits.length;
		if (n !== entry.count) {
			problems.push(
				`ALLOWED_RAW says ${file} holds ${entry.count}, it holds ${n}${n === 0 ? " (fixed? remove the entry)" : ""}`,
			);
		}
		const have = [...new Set(hits.map((h) => h.codePoint))].sort((a, b) => a - b).map(label);
		const want = [...entry.codePoints].sort((a, b) => a - b).map(label);
		if (have.join(",") !== want.join(",")) {
			problems.push(
				`ALLOWED_RAW says ${file} holds ${want.join(" ") || "nothing"}, it holds ${have.join(" ") || "nothing"}`,
			);
		}
	}
	return problems;
}

/**
 * Files that hold a raw character, each with its exact count, code point set and why it is still there. EMPTY: the six files that held one
 * were fixed by writing the character as an escape sequence. An entry added here is a bug to fix, not a place to hide one; it must say why.
 */
const ALLOWED_RAW: Readonly<
	Record<string, { count: number; codePoints: readonly number[]; why: string }>
> = {};

function trackedFiles(): string[] {
	const r = spawnSync("git", ["ls-files", "-z"], {
		cwd: REPO,
		encoding: "buffer",
		maxBuffer: 1 << 28,
	});
	if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr.toString("utf8").trim()}`);
	return r.stdout
		.toString("utf8")
		.split("\0")
		.filter((f) => f !== "");
}

describe("no raw invisible or control characters in tracked text files", () => {
	it("every tracked text file is clean, except the files ALLOWED_RAW counts exactly", () => {
		const files = trackedFiles();
		expect(files.length).toBeGreaterThan(100);
		const found = new Map<string, Hit[]>();
		for (const file of files) {
			if (kindOf(file) === "binary") continue; // never scanned: do not read it either
			let bytes: Buffer;
			try {
				bytes = readFileSync(join(REPO, file));
			} catch {
				continue; // a tracked path deleted in the working tree is not a hit
			}
			const hits = scanFile(file, bytes);
			if (hits.length > 0) found.set(file, hits);
		}
		expect(censusProblems(found, ALLOWED_RAW, new Set(files))).toEqual([]);
		// timing: 60 s budget for the whole tracked tree (about 1,100 files). The scan takes about 90 ms on an idle 14-core host;
		// under a CPU burn of 5 busy loops per core it took 0.63-0.71 s (3 of 3 passed at the 5 s default). The per-character
		// version it replaced took about 650 ms idle and over 5 s under the same burn (timed out 3 of 3), and once timed out
		// on a loaded CI runner at the 5 s default.
	}, 60_000);
});

describe("the scanner can see what it is meant to catch (positive controls)", () => {
	it("flags every forbidden range at both ends, and nothing just outside them", () => {
		for (const [lo, hi] of FORBIDDEN_RANGES) {
			expect(isForbidden(lo), label(lo)).toBe(true);
			expect(isForbidden(hi), label(hi)).toBe(true);
		}
		// the allowed neighbours: tab, LF, CR, space, tilde, NBSP, thin space, hyphen, the line before U+2060, U+2065, U+206A
		for (const cp of [
			0x09,
			0x0a,
			0x0d,
			0x20,
			0x7e,
			0xa0,
			0xac,
			0xae,
			0xe9,
			0x061b,
			0x061d,
			0x180d,
			0x180f,
			0x200a,
			0x2010,
			0x2027,
			0x202f,
			0x205f,
			0x2065,
			0x206a,
			0xfeff - 1,
			0xfe00,
			0xfe0f,
			0xdffff,
			0xe0080,
			0xfffd,
			0x1f600,
		]) {
			expect(isForbidden(cp), label(cp)).toBe(false);
		}
		// the C0 holes the rule leaves open are exactly tab, LF and CR
		const allowedC0 = Array.from({ length: 0x20 }, (_, cp) => cp).filter((cp) => !isForbidden(cp));
		expect(allowedC0).toEqual([0x09, 0x0a, 0x0d]);
	});

	it("reports file:line and U+XXXX for a planted fixture of every class, with line numbers split on LF only", () => {
		const planted = [
			0x1b, 0x7f, 0x85, 0x061c, 0x200b, 0x200d, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060,
			0x2064, 0x2066, 0x2069, 0xfeff, 0x00ad, 0x180e, 0xe0000, 0xe0041, 0xe007f,
		];
		// one planted character per line, with a clean line between each, and the U+2028 / U+2029 / form-feed line breakers INSIDE lines
		const text = planted
			.map((cp) => `clean line\nbefore ${String.fromCodePoint(cp)} after`)
			.join("\n");
		const hits = findInvisibles(text);
		expect(hits.map((h) => label(h.codePoint))).toEqual(planted.map(label));
		// line 2, 4, 6 ...: a splitlines-style split would have moved the lines after U+2028 and U+2029
		expect(hits.map((h) => h.line)).toEqual(planted.map((_cp, i) => 2 * (i + 1)));

		const dir = mkdtempSync(join(tmpdir(), "no-raw-invisibles-"));
		mkdirSync(join(dir, "sub"));
		const file = join(dir, "sub", "planted.ts");
		writeFileSync(file, text);
		const found = new Map([["sub/planted.ts", scanFile("sub/planted.ts", readFileSync(file))]]);
		const problems = censusProblems(found, {}, new Set(["sub/planted.ts"]));
		expect(problems).toHaveLength(planted.length);
		expect(problems[0]).toBe("sub/planted.ts:2 U+001B (a raw invisible or control character)");
		expect(problems.at(-1)).toBe(
			`sub/planted.ts:${2 * planted.length} U+E007F (a raw invisible or control character)`,
		);
		// the TAG block built from a code point (the ASCII-smuggling carrier), one in the middle of the block too
		expect(findInvisibles(`a${String.fromCodePoint(0xe0041)}b`)).toEqual([
			{ line: 1, codePoint: 0xe0041 },
		]);
		// a NUL is a forbidden character in the text scan (a file holding one would be read as a binary and skipped, which the next case pins)
		expect(findInvisibles(`x${String.fromCodePoint(0)}y`)).toEqual([{ line: 1, codePoint: 0 }]);
	});

	it("does not flag tab, LF, CR, accented letters, emoji or ordinary spaces; a CRLF file keeps its line numbers", () => {
		const text = `a${String.fromCodePoint(0x09)}b\r\n${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f600)} ${String.fromCodePoint(0xa0)}${String.fromCodePoint(0x200a)}\r\n`;
		expect(findInvisibles(text)).toEqual([]);
		const crlf = `ok\r\nbad ${String.fromCodePoint(0x202e)} here\r\n`;
		expect(findInvisibles(crlf)).toEqual([{ line: 2, codePoint: 0x202e }]);
	});

	it("a known text file is scanned EVEN WITH A NUL: a planted .ts fixture holding a NUL and a U+202E is flagged for both", () => {
		const bytes = Buffer.from(
			`x${String.fromCodePoint(0)}y\nz ${String.fromCodePoint(0x202e)} w\n`,
		);
		expect(looksBinary(bytes)).toBe(true); // the old heuristic would have skipped it whole
		for (const name of [
			"planted.ts",
			"dir/planted.MJS",
			"notes.md",
			"data.json",
			"LICENSE",
			".gitignore",
			"x.sh",
		]) {
			expect(kindOf(name), name).toBe("text");
			expect(scanFile(name, bytes), name).toEqual([
				{ line: 1, codePoint: 0 },
				{ line: 2, codePoint: 0x202e },
			]);
		}
	});

	it("a known binary is never scanned, and an unknown extension falls back to the NUL heuristic", () => {
		const bad = String.fromCodePoint(0x202e);
		const textual = Buffer.from(`x ${bad} y\n`);
		for (const name of ["a.png", "b.JPG", "c.mp4", "d.woff2", "e.wasm"]) {
			expect(kindOf(name), name).toBe("binary");
			expect(scanFile(name, textual), name).toEqual([]);
		}
		expect(kindOf("blob.dat")).toBe("unknown");
		expect(kindOf("Makefile2")).toBe("unknown");
		const withNul = Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0x47]), textual]);
		expect(scanFile("blob.dat", withNul)).toEqual([]);
		expect(scanFile("blob.dat", textual)).toEqual([{ line: 1, codePoint: 0x202e }]);
		// the heuristic looks at the first 8000 bytes only
		const late = Buffer.concat([
			Buffer.from("a".repeat(8100)),
			Buffer.from([0x00]),
			Buffer.from(`\n${bad}\n`),
		]);
		expect(looksBinary(late)).toBe(false);
		expect(scanFile("blob.dat", late)).toHaveLength(2);
		expect(scanFile("blob.dat", Buffer.from(`${"a".repeat(9000)}\nx ${bad} y\n`))).toEqual([
			{ line: 2, codePoint: 0x202e },
		]);
	});

	it("the allowlist is empty: no tracked text file holds a raw invisible or control character", () => {
		expect(Object.keys(ALLOWED_RAW)).toEqual([]);
	});
});

describe("the census cannot rot", () => {
	const hit = (line: number): Hit => ({ line, codePoint: 0x200b });
	const tracked = new Set(["a.ts", "b.ts"]);

	it("passes only when every allowlisted count is exact and every other file is clean", () => {
		const allowed = { "a.ts": { count: 2, codePoints: [0x200b], why: "planted" } };
		expect(censusProblems(new Map([["a.ts", [hit(1), hit(3)]]]), allowed, tracked)).toEqual([]);
	});

	it("a stale entry fails: fixed file, wrong count, untracked file, missing reason", () => {
		const allowed = { "a.ts": { count: 2, codePoints: [0x200b], why: "planted" } };
		expect(censusProblems(new Map(), allowed, tracked)[0]).toMatch(
			/holds 2, it holds 0 \(fixed\? remove the entry\)/,
		);
		expect(censusProblems(new Map([["a.ts", [hit(1)]]]), allowed, tracked)[0]).toMatch(
			/holds 2, it holds 1/,
		);
		expect(
			censusProblems(new Map([["a.ts", [hit(1), hit(2), hit(3)]]]), allowed, tracked)[0],
		).toMatch(/holds 2, it holds 3/);
		expect(
			censusProblems(
				new Map(),
				{ "gone.ts": { count: 1, codePoints: [0x200b], why: "x" } },
				tracked,
			)[0],
		).toMatch(/not a tracked file/);
		expect(
			censusProblems(
				new Map([["a.ts", [hit(1)]]]),
				{ "a.ts": { count: 1, codePoints: [0x200b], why: " " } },
				tracked,
			)[0],
		).toMatch(/no reason/);
	});

	it("an allowlisted file does not hide a hit in another file", () => {
		const allowed = { "a.ts": { count: 1, codePoints: [0x200b], why: "planted" } };
		const found = new Map([
			["a.ts", [hit(4)]],
			["b.ts", [hit(7)]],
		]);
		expect(censusProblems(found, allowed, tracked)).toEqual([
			"b.ts:7 U+200B (a raw invisible or control character)",
		]);
	});

	it("a different code point in an allowlisted file fails, so an entry cannot hide a worse character", () => {
		const allowed = { "a.ts": { count: 1, codePoints: [0x200b], why: "planted" } };
		const worse: Hit = { line: 3, codePoint: 0x202e };
		expect(censusProblems(new Map([["a.ts", [worse]]]), allowed, tracked)).toEqual([
			"ALLOWED_RAW says a.ts holds U+200B, it holds U+202E",
		]);
	});
});
