// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * PII and injection scanning takes time proportional to the message.
 *
 * `detectPII` and `detectInjection` run synchronously on every governed call before the hold
 * (`pii: "warn"` is the default), and usertrust-server runs every tenant's governor in one process.
 * Three patterns were quadratic on long separator-free text: the email pattern (any run of
 * local-part characters with no `@`), the JWT pattern (`-eyJ-eyJ…`) and the triple-backtick
 * delimiter (a run of backticks with no keyword). 200k characters took 26 s on the email pattern.
 *
 * The time bound is a RATIO to a plain linear pass over the same string, measured in the same run,
 * never a number of milliseconds, so it holds on a slow or loaded machine: the baseline slows too.
 * Each input is scanned first at 1/16 of its full size, where a quadratic scan is already far past
 * the bound but still takes only seconds, and only then at the full 1M characters.
 */

import { describe, expect, it } from "vitest";
import { detectInjection } from "../../src/policy/injection.js";
import { detectPII } from "../../src/policy/pii.js";

const FULL = 1_000_000;
const SIZES = [FULL / 16, FULL];
/** Scan time over baseline time. A linear scan here measures well under it; a quadratic one, thousands of times over. */
const MAX_RATIO = 200;

let sink = 0;

/** The linear baseline: one pass over every character. */
function linearPass(s: string): void {
	let sum = 0;
	for (let i = 0; i < s.length; i++) sum = (sum + s.charCodeAt(i)) | 0;
	sink ^= sum;
}

function timeMs(fn: () => void): number {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

function median(xs: number[]): number {
	const sorted = [...xs].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] as number;
}

interface Verdict {
	ok: boolean;
	size: number;
	ratio: number;
}

/**
 * Whether `scan` stays within MAX_RATIO of the baseline at every size, stopping at the first size
 * that does not. A scan over the bound is measured once more and the faster time kept, so one
 * garbage-collection pause does not fail it.
 */
function withinRatio(
	scan: (s: string) => unknown,
	make: (n: number) => string,
	sizes: readonly number[] = SIZES,
): Verdict {
	let last: Verdict = { ok: true, size: 0, ratio: 0 };
	for (const size of sizes) {
		const s = make(size);
		expect(s.length).toBe(size);
		const baseline = Math.max(
			median([1, 2, 3, 4, 5].map(() => timeMs(() => linearPass(s)))),
			0.001,
		);
		let t = timeMs(() => scan(s));
		if (t / baseline > MAX_RATIO)
			t = Math.min(
				t,
				timeMs(() => scan(s)),
			);
		last = { ok: t / baseline <= MAX_RATIO, size, ratio: t / baseline };
		if (!last.ok) return last;
	}
	return last;
}

/** `unit` repeated to exactly `n` characters, then `tail`. */
function run(unit: string, tail = ""): (n: number) => string {
	return (n) =>
		unit.repeat(Math.ceil((n - tail.length) / unit.length)).slice(0, n - tail.length) + tail;
}

/** `head`, then `unit` repeated to exactly `n` characters in all. */
function after(head: string, unit: string, tail = ""): (n: number) => string {
	return (n) => head + run(unit, tail)(n - head.length);
}

/** Each pattern's worst plausible input: a run of its class with no terminator, or one that fails. */
const WORST: ReadonlyArray<[string, (n: number) => string]> = [
	["email: local-part run, no @", run("x")],
	["email: dots and plus, no @", run("a.b+c")],
	["email: @ then a domain run with no TLD", after("x@", "x.")],
	["email: an @ every other character", run("x@")],
	["phone: digits and dots", run("12.")],
	["phone: three-digit groups, repeated separators", run("123 - ")],
	["phone: a digit, then parentheses", after("1", "(")],
	["phone: one run of digits and spaces, glued to words", after("x", "1 ", "1x")],
	["phone: a run of separators, glued to words", after("x", " (-.)+", "1x")],
	["phone: short runs between words", run("x12 ")],
	["phone: 15-digit groups, one short of oversized", run("123456789012345 ")],
	["ssn: digits", run("1")],
	["ipv4: digits and dots", run("1.")],
	["ipv4: out-of-range candidates", run("999.")],
	["credit card: digits, then a letter", run("1", "x")],
	["credit card: digits and spaces", run("1 ")],
	["credit card: two-digit groups and dashes", run("12-")],
	["api key: sk- then dashes, then a dot", after("sk-", "-", ".")],
	["api key: repeated starts", run(".sk-")],
	["aws key: repeated prefix", run("AKIA")],
	["github token: prefix, letters, then _", after("ghp_", "a", "_")],
	["github token: repeated starts", run("-ghp_")],
	["bearer: Bearer then spaces", after("Bearer", " ")],
	["bearer: repeated", run("Bearer ")],
	["jwt: eyJ then a run, no dot", after("eyJ", "a")],
	["jwt: repeated starts in one run", run("-eyJ")],
	["jwt: segments that fail at the third dot", run("-eyJaaaaaaaaaaaa.aaaaaaaaaaaa")],
	["private key: BEGIN then capitals", after("-----BEGIN ", "A")],
	["private key: repeated BEGIN", run("-----BEGIN ")],
	["generic secret: SG. then dashes", after("SG.", "-", ".")],
	["generic secret: repeated npm_", run("-npm_")],
	["generic secret: hex run, then g", run("a", "g")],
	["generic secret: hex-letter runs", run(`${"a".repeat(64)} `)],
	["injection intent: verb then spaces", after("ignore", " ")],
	["injection intent: repeated verb and filler", run("ignore all ")],
	["base64: run then ===", run("A", "===")],
	["backtick: backticks, no keyword", run("`")],
	["backtick: fence then text, no keyword", after("```", "x")],
	["xml: repeated </", run("</")],
	["heading: # lines", run("#\n")],
	["heading: # then spaces", after("#", " ")],
];

describe("PII and injection scanning is linear in the message", () => {
	for (const [name, make] of WORST) {
		it(`detectPII: ${name}`, () => {
			const verdict = withinRatio(detectPII, make);
			expect(verdict, `ratio ${verdict.ratio.toFixed(1)} at ${verdict.size}`).toMatchObject({
				ok: true,
			});
		});
		it(`detectInjection: ${name}`, () => {
			const verdict = withinRatio(detectInjection, make);
			expect(verdict, `ratio ${verdict.ratio.toFixed(1)} at ${verdict.size}`).toMatchObject({
				ok: true,
			});
		});
	}

	it("the harness sees a quadratic scan: the old patterns fail the bound", () => {
		const OLD_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
		const OLD_JWT = /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/;
		const OLD_BACKTICK = /```[\s\S]*?(?:system|instruction|admin)/i;
		const controls: Array<[RegExp, (n: number) => string]> = [
			[OLD_EMAIL, run("x")],
			[OLD_JWT, run("-eyJ")],
			[OLD_BACKTICK, run("`")],
		];
		for (const [re, make] of controls) {
			const verdict = withinRatio((s) => re.test(s), make);
			// It fails at the first size, 62,500 characters: past the bound in a few seconds at most,
			// where 1M characters would take minutes.
			expect(verdict, String(re)).toMatchObject({ ok: false, size: FULL / 16 });
		}
		expect(sink).toBeTypeOf("number");
	}, 120_000);
});

/** A seeded generator, so a failure names the same strings on every run. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Random strings built from `pieces`, each up to `maxPieces` long. */
function corpus(
	seed: number,
	pieces: readonly string[],
	maxPieces: number,
	count: number,
): string[] {
	const rand = seeded(seed);
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const n = Math.floor(rand() * (maxPieces + 1));
		let s = "";
		for (let j = 0; j < n; j++) s += pieces[Math.floor(rand() * pieces.length)];
		out.push(s);
	}
	return out;
}

/**
 * Every string the old pattern matched, the new scan finds, and no other. The pieces are the
 * characters and fragments each pattern turns on, so both answers occur many times.
 */
function sameAnswers(
	texts: string[],
	oldAnswer: (s: string) => boolean,
	newAnswer: (s: string) => boolean,
): void {
	let found = 0;
	const differ: string[] = [];
	for (const text of texts) {
		const expected = oldAnswer(text);
		if (expected) found++;
		if (newAnswer(text) !== expected) differ.push(text);
	}
	expect(differ.slice(0, 5)).toEqual([]);
	expect(found).toBeGreaterThan(texts.length / 100);
	expect(found).toBeLessThan(texts.length - texts.length / 100);
}

describe("long inputs: no detector throws, and the scans stay linear, up to 10M characters", () => {
	// A regex that repeats a group can overflow the regexp stack on a long enough run (a card-run
	// pattern did, at 6M characters of digit groups). 5.0.4 completed these at 8M.
	const LONG: ReadonlyArray<[string, (n: number) => string]> = [
		["digits and spaces", run("1 ")],
		["digits and dashes", run("1-")],
		["four-digit groups and spaces", run("4111 ")],
		["a phone run glued on both sides", after("x", "1 ", "1x")],
		["digits and dots", run("12.")],
	];
	for (const [name, make] of LONG) {
		it(`detectPII: ${name}`, () => {
			const verdict = withinRatio(detectPII, make, [3_000_000, 10_000_000]);
			expect(verdict, `ratio ${verdict.ratio.toFixed(1)} at ${verdict.size}`).toMatchObject({
				ok: true,
			});
		}, 120_000);
	}
});

describe("the linear scans give the old patterns' answers", () => {
	it("email", () => {
		const OLD_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
		const pieces = [
			"a",
			"Z",
			"9",
			".",
			"@",
			"a@",
			"-",
			"_",
			"+",
			"%",
			" ",
			"co",
			".c",
			".co",
			"é",
			"!",
		];
		sameAnswers(
			corpus(1, pieces, 10, 100_000),
			(s) => OLD_EMAIL.test(s),
			(s) => detectPII(s).types.includes("email"),
		);
	});

	it("jwt", () => {
		const OLD_JWT = /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/;
		// Three segments of lengths around the 10-character minimum, joined by a "." or by
		// something else, between edges that do and do not end a word.
		const rand = seeded(2);
		const pick = (xs: readonly string[]): string => xs[Math.floor(rand() * xs.length)] as string;
		const segment = (): string => {
			let out = "";
			const n = 6 + Math.floor(rand() * 8);
			for (let i = 0; i < n; i++) out += pick(["a", "Z", "9", "_", "-"]);
			return out;
		};
		const edges = ["", " ", "x", "-", "_", ".", "-eyJ", "eyJ-eyJ"];
		const joins = [".", ".", ".", "-", " ", "..", ".eyJ", " eyJ"];
		const texts: string[] = [];
		for (let i = 0; i < 50_000; i++) {
			let text = `${pick(edges)}${pick(["eyJ", "eyj", "-eyJ"])}${segment()}`;
			const segments = 1 + Math.floor(rand() * 5);
			for (let j = 0; j < segments; j++) text += `${pick(joins)}${segment()}`;
			texts.push(text + pick(edges));
		}
		sameAnswers(
			texts,
			(s) => OLD_JWT.test(s),
			(s) => detectPII(s).types.includes("jwt"),
		);
	});

	it("phone: with no letter or underscore in the text, the old whole-text answers, a group of 16+ digits splitting it", () => {
		const OLD_PHONE = /(?:\+?\d{1,3}[-.\s()]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
		// A group of 16 or more digits splits the text, unless it is a dial string (00, 011, 010 or
		// 0011, then at most 15 digits).
		const split = (s: string): string =>
			s.replace(/\d{16,}/g, (g) =>
				["0011", "011", "010", "00"].some((p) => g.startsWith(p) && g.length - p.length <= 15)
					? g
					: "|",
			);
		const pieces = [
			"5",
			"55",
			"555",
			"1234",
			"00",
			"011",
			" ",
			"  ",
			"-",
			".",
			"(",
			")",
			"+",
			"+44",
			"/",
			",",
		];
		sameAnswers(
			corpus(5, pieces, 10, 50_000),
			(s) => OLD_PHONE.test(split(s).replace(/\s+/g, "")),
			(s) => detectPII(s).types.includes("phone"),
		);
	});

	it("phone: a digit group glued to a word is left out, and the rest is checked as before", () => {
		// The reference splits the text into runs of phone characters and the words between them,
		// drops a run's edge digits where a word character touches them, splits what is left at each
		// group of 16 or more digits, and tests the old pattern on it with its whitespace removed.
		const OLD_PHONE = /(?:\+?\d{1,3}[-.\s()]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
		const reference = (s: string): boolean => {
			const parts = s.split(/([^\d\s()+.-]+)/);
			return parts.some((part, k) => {
				if (k % 2 === 1) return false;
				let rest = part;
				if (/\w$/.test(parts[k - 1] ?? "")) rest = rest.replace(/^\d+/, "");
				// An extension (x, ext or ext., spaces, 1-6 digits ending the token) does not glue.
				const after = parts.slice(k + 1).join("");
				const extension = /^(?:x|ext\.?)\s*\d{1,6}(?![A-Za-z0-9_])/i.test(after);
				if (/^\w/.test(after) && !extension) rest = rest.replace(/\d+$/, "");
				const split = rest.replace(/\d{16,}/g, (g) =>
					["0011", "011", "010", "00"].some((p) => g.startsWith(p) && g.length - p.length <= 15)
						? g
						: "|",
				);
				return OLD_PHONE.test(split.replace(/\s+/g, ""));
			});
		};
		const pieces = [
			"5",
			"555",
			"1234",
			" ",
			"-",
			".",
			"(",
			"+",
			"x",
			"_",
			"id",
			":",
			",",
			"ext",
			"ext.",
			"555",
			"1234",
		];
		sameAnswers(corpus(6, pieces, 16, 50_000), reference, (s) =>
			detectPII(s).types.includes("phone"),
		);
	});

	it("credit card: 5.0.4's candidates, or a whole chain in a card's layout, checked one way and another", () => {
		// The reference: 5.0.4's candidate check as it was written, or a whole chain of digit groups,
		// found by splitting the text (not by the detector's scan), each joined to the next by exactly
		// one space, or each by exactly one dash, whose lengths are a card's layout and which no word
		// character touches at either end; or one such group of 13-19 digits. Luhn digit by digit.
		const OLD_CANDIDATE = /\b[\d][\d\s-]{11,22}[\d]\b/g;
		const LAYOUTS = [
			"4,4,4,1",
			"4,4,4,2",
			"4,4,4,3",
			"4,4,4,4",
			"4,4,4,4,1",
			"4,4,4,4,2",
			"4,4,4,4,3",
			"4,6,5",
			"4,6,4",
		];
		const luhn = (digits: string): boolean => {
			let sum = 0;
			for (let i = 0; i < digits.length; i++) {
				const d = Number(digits[digits.length - 1 - i]);
				sum += i % 2 === 1 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d;
			}
			return sum % 10 === 0;
		};
		const candidate = (s: string): boolean =>
			(s.match(OLD_CANDIDATE) ?? []).some((c) => {
				const digits = c.replace(/[\s-]/g, "");
				return digits.length >= 13 && digits.length <= 19 && luhn(digits);
			});
		const layout = (s: string): boolean => {
			// parts: text, group, text, group, ..., text
			const parts = s.split(/(\d+)/);
			const groups = parts.filter((_, k) => k % 2 === 1);
			const before = (g: number) => parts[2 * g] ?? "";
			const after = (g: number) => parts[2 * g + 2] ?? "";
			const word = /[A-Za-z0-9_]/;
			const freeStart = (g: number) => !word.test(before(g).slice(-1));
			const freeEnd = (g: number) => !word.test(after(g).slice(0, 1));
			for (let g = 0; g < groups.length; g++) {
				const one = groups[g] as string;
				if (one.length >= 13 && one.length <= 19 && freeStart(g) && freeEnd(g) && luhn(one)) {
					return true;
				}
			}
			for (const joiner of [" ", "-"]) {
				let a = 0;
				while (a < groups.length) {
					let b = a;
					while (b + 1 < groups.length && after(b) === joiner) b++;
					const chain = groups.slice(a, b + 1);
					if (
						LAYOUTS.includes(chain.map((g) => g.length).join(",")) &&
						freeStart(a) &&
						freeEnd(b) &&
						luhn(chain.join(""))
					) {
						return true;
					}
					a = b + 1;
				}
			}
			return false;
		};
		const pieces = [
			"4111",
			"1111",
			"4242",
			"3782",
			"822463",
			"10005",
			"3056",
			"04",
			"5",
			"12",
			"0",
			" ",
			" ",
			"-",
			"-",
			"  ",
			"/",
			"x",
			"\n",
		];
		sameAnswers(
			corpus(4, pieces, 12, 50_000),
			(s) => candidate(s) || layout(s),
			(s) => detectPII(s).types.includes("credit_card"),
		);
	});

	it("delimiter injection (the backtick fence, beside the XML and heading checks)", () => {
		const OLD_DELIMITER = [
			/```[\s\S]*?(?:system|instruction|admin)/i,
			/<\/(?:system|user|assistant|human|ai)>/i,
			/^#{1,3}\s*(?:system|instruction|new role)/im,
		];
		const pieces = [
			"```",
			"`",
			"``",
			"system",
			"SYSTEM",
			"admin",
			"instr",
			"uction",
			"x",
			"\n",
			" ",
		];
		sameAnswers(
			corpus(3, pieces, 8, 50_000),
			(s) => OLD_DELIMITER.some((re) => re.test(s)),
			(s) => detectInjection(s).patterns.includes("delimiter_injection"),
		);
	});
});
