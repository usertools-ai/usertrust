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
 * The time bound is a RATIO, never a number of milliseconds, so it holds on a slow machine and
 * through bursts of load: a scan of an input eight times as long takes about eight times as long if
 * the scan is linear, and about 64 times if it is quadratic. Under sustained overload (more busy processes
 * than cores) a linear scan can read over the bound on every measurement, so CI runs this file in a
 * job of its own, without coverage, beside the test job rather than inside it; the detectors'
 * coverage comes from other files.
 */

import { describe, expect, it } from "vitest";
import { detectInjection } from "../../src/policy/injection.js";
import { detectPII, redactPII } from "../../src/policy/pii.js";

/** Walk time over baseline time, for the deep nesting below. A linear walk measures well under it. */
const MAX_RATIO = 200;

/**
 * How much longer the second input is. A linear scan's time grows with it (8), a quadratic one's with
 * its square (64). V8's time per character steps up once at some length for some inputs (up to about
 * 1.95 times, measured on CI's runners for the normalized view), so a linear scan measured across a
 * step reads up to about 16. Over two lengths only, linear reads 2 and quadratic 4, and one step put a
 * linear scan over a bound of 3.
 */
const SPAN = 8;

/** The bound on time at `SPAN` times the size over time at the size: 8^(5/3), half of quadratic's 64. */
const BOUND = 32;

let sink = 0;

/**
 * `text` as one flat string, as a caller's text arrives (JSON.parse gives one). A string built with
 * `+`, `repeat` or `slice` is a tree of parts. V8 flattens it on the first read, but keeps the tree
 * as a pointer to the flat copy until a garbage collection the string survives replaces it with
 * that copy. An input built once and kept for the whole measurement can then be flat at `n` and
 * still the pointer at twice `n`, which reads slower in every sample.
 */
const flat = (text: string): string => JSON.parse(JSON.stringify(text));

/** What reads `make(n)` with `scan`: the input is built once, flat, and kept. */
function scanning(
	scan: (s: string) => unknown,
	make: (n: number) => string,
): (n: number) => () => unknown {
	return (n) => {
		const input = flat(make(n));
		expect(input.length).toBe(n);
		return () => scan(input);
	};
}

/** A ratio, then the same ratio with the times it comes from, for a message. */
type Measured = [number, string];

/**
 * `make(n)` builds an input of size `n` and gives what reads it. `n` doubles (up to 64 times) until
 * one read takes 15 ms. Both inputs, at that size and `SPAN` times it, are then built, read once, and kept,
 * so each size is timed with the same heap. A sample makes the same number of reads at both sizes,
 * enough for a sample at `n` to take 30 ms, so a garbage collection's pause is a small part of it.
 * Samples alternate between the sizes, so a slow moment slows both, and each time is the least of
 * five. `first` is the time at `SPAN` times the size over the time at the size; `again` measures it once
 * more, from both inputs built anew.
 */
function linearRatio(
	make: (n: number) => () => unknown,
	n: number,
): { first: Measured; again: () => Measured } {
	const timed = (read: () => unknown, reads: number): number => {
		const started = performance.now();
		for (let i = 0; i < reads; i++) read();
		return performance.now() - started;
	};
	let size = n;
	let read = make(size);
	read();
	let one = timed(read, 1);
	while (one < 15 && size < n * 64) {
		size *= 2;
		read = make(size);
		read();
		one = timed(read, 1);
	}
	const large = make(SPAN * size);
	large();
	let reads = Math.max(1, Math.ceil(30 / Math.max(one, 0.01)));
	while (timed(read, reads) < 30) reads *= 2;
	const ratio = (small: () => unknown, big: () => unknown): Measured => {
		let once = Number.POSITIVE_INFINITY;
		let twice = Number.POSITIVE_INFINITY;
		for (let i = 0; i < 5; i++) {
			once = Math.min(once, timed(small, reads));
			twice = Math.min(twice, timed(big, reads));
		}
		const times = `${once.toFixed(1)} ms at ${size}, ${twice.toFixed(1)} ms at ${SPAN * size}, ${reads} reads a sample`;
		return [twice / once, `${(twice / once).toFixed(2)} (${times})`];
	};
	const first = ratio(read, large);
	return {
		first,
		again: () => {
			const small = make(size);
			small();
			const big = make(SPAN * size);
			big();
			return ratio(small, big);
		},
	};
}

/**
 * Reading `SPAN` times the input takes at most `BOUND` times as long: a linear reader takes about 8
 * times, or about 16 across a step, and a quadratic one about 64. A ratio over the bound is measured
 * again from both inputs built anew, up to twice, and the row fails only if all three are over it: a
 * burst of load can slow two in a row, and a quadratic reader is over it each time. Each measurement taken again is printed, marked
 * `[linear-confirm]`.
 */
function expectLinear(make: (n: number) => () => unknown, n: number): void {
	const name = expect.getState().currentTestName;
	const { first, again } = linearRatio(make, n);
	console.log(`[ratio] ${name}: ${first[1]}`);
	if (first[0] <= BOUND) return;
	let readings = first[1];
	let last = first[0];
	for (let i = 0; i < 2 && last > BOUND; i++) {
		const [ratio, times] = again();
		readings += `, then ${times}`;
		last = ratio;
	}
	console.log(`[linear-confirm] ${name}: ${readings}`);
	expect(last, `${name}: ${readings}`).toBeLessThanOrEqual(BOUND);
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

/** `unit` repeated to exactly `n` characters, then `tail`. */
function run(unit: string, tail = ""): (n: number) => string {
	return (n) =>
		unit.repeat(Math.ceil((n - tail.length) / unit.length)).slice(0, n - tail.length) + tail;
}

/** `head`, then `unit` repeated to exactly `n` characters in all. */
function after(head: string, unit: string, tail = ""): (n: number) => string {
	return (n) => head + run(unit, tail)(n - head.length);
}

/**
 * Each pattern's worst plausible input: a run of its class with no terminator, or one that fails.
 * A third entry is the size measured from, where it is not 62,500.
 */
const WORST: ReadonlyArray<[string, (n: number) => string, number?]> = [
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
	["api key: repeated restricted-key starts", run(".rk_live_")],
	["aws key: repeated prefix", run("AKIA")],
	["aws key: repeated temporary prefix", run("ASIA")],
	["github token: prefix, letters, then _", after("ghp_", "a", "_")],
	["github token: repeated starts", run("-ghp_")],
	["github token: fine-grained prefix, then a run", after("github_pat_", "a")],
	[
		"github token: fine-grained first segment, then a run",
		after(`github_pat_${"a".repeat(22)}_`, "a"),
	],
	["github token: repeated fine-grained starts", run("-github_pat_")],
	["github token: stateless prefix, then digits", after("ghs_", "1")],
	["github token: repeated stateless starts", run("-ghs_1_")],
	["github token: repeated stateless starts with eyJ", run("-ghs_1_eyJ")],
	["github token: repeated stateless JWTs of two segments", run("-ghs_1_eyJa.b")],
	["github token: stateless start, then a long segment run", after("ghs_1_eyJ", "a")],
	["generic secret: repeated lowercase GitLab payloads", run("-gldt-abcdefghijklmnopqrstu")],
	["generic secret: xoxb- then a run, then _", after("xoxb-", "a", "_")],
	["api key: sk- then dashes only", after("sk-", "-")],
	["github token: stateless prefix, digits, then _", after("ghs_", "1", "_")],
	["github token: fine-grained prefix, then underscores", after("github_pat_", "_")],
	["api key: sk_org_ then dashes", after("sk_org_", "-")],
	["api key: rk_live_ then dashes", after("rk_live_", "-")],
	["generic secret: xapp- then dashes", after("xapp-", "-")],
	["generic secret: a GitLab prefix, then dashes", after("glagent-", "-")],
	["bearer: Bearer then spaces", after("Bearer", " ")],
	["bearer: repeated", run("Bearer ")],
	["jwt: eyJ then a run, no dot", after("eyJ", "a")],
	["jwt: repeated starts in one run", run("-eyJ")],
	["jwt: segments that fail at the third dot", run("-eyJaaaaaaaaaaaa.aaaaaaaaaaaa")],
	["private key: BEGIN then capitals", after("-----BEGIN ", "A")],
	["private key: repeated BEGIN", run("-----BEGIN ")],
	["generic secret: SG. then dashes", after("SG.", "-", ".")],
	["generic secret: repeated npm_", run("-npm_")],
	["generic secret: repeated xapp-", run("-xapp-")],
	["generic secret: repeated GitLab starts", run("-glagent-")],
	["api key: AIza then a long run", after("AIza", "a")],
	["api key: repeated AIzaSy starts", run("-AIzaSy")],
	["api key: xai- then a run, then _", after("xai-", "a", "_")],
	["api key: repeated gsk_ starts", run("-gsk_")],
	["api key: pplx- then digits", after("pplx-", "1")],
	["generic secret: whsec_ then slashes", after("whsec_", "/")],
	["generic secret: repeated whsec_ starts", run(".whsec_")],
	// The normalized view (format characters removed, fullwidth forms read): built once per string,
	// then scanned.
	["normalized view: zero-width spaces", run(String.fromCodePoint(0x200b))],
	["normalized view: a digit, then a zero-width space", run(`1${String.fromCodePoint(0x200b)}`)],
	["normalized view: a letter, then a zero-width joiner", run(`a${String.fromCodePoint(0x200d)}`)],
	["normalized view: fullwidth digits", run(String.fromCodePoint(0xff11))],
	["normalized view: fullwidth digits and spaces", run(`${String.fromCodePoint(0xff14)} `)],
	["normalized view: U+FDFA, which NFKC expands to 18", run(String.fromCodePoint(0xfdfa))],
	[
		"normalized view: a key prefix, then zero-width spaces",
		after("sk-", String.fromCodePoint(0x200b)),
	],
	[
		"normalized view: fullwidth letters and an at sign",
		run(`${String.fromCodePoint(0xff41)}${String.fromCodePoint(0xff20)}`),
	],
	["aws key: repeated temporary placeholders", run(`ASIA${"X".repeat(16)} `)],
	["github token: repeated user-token placeholders", run(`ghu_${"X".repeat(36)} `)],
	[
		"github token: repeated fine-grained placeholders",
		run(`github_pat_${"X".repeat(22)}_${"X".repeat(59)} `),
	],
	[
		"github token: repeated stateless placeholders",
		run(`ghs_1_eyJ${"X".repeat(12)}.${"X".repeat(12)}.${"X".repeat(12)} `),
	],
	["api key: repeated rk_live_ placeholders", run(`rk_live_${"X".repeat(24)} `)],
	["generic secret: repeated xoxe- placeholders", run(`xoxe-1-${"X".repeat(24)} `)],
	["generic secret: repeated GitLab placeholders", run(`glrt-${"X".repeat(20)} `)],
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
	for (const [name, make, from = 62_500] of WORST) {
		it(`detectPII: ${name}`, () => {
			expectLinear(scanning(detectPII, make), from);
		}, 60_000);
		it(`detectInjection: ${name}`, () => {
			expectLinear(scanning(detectInjection, make), from);
		}, 60_000);
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
			// Both measurements are taken, and one over the bound shows the harness can see the
			// scan; a burst of load can pull one of them under.
			const { first, again } = linearRatio(
				scanning((s) => re.test(s), make),
				2_000,
			);
			const [second, times] = again();
			console.log(`[linear-control] ${re}: ${first[1]}, then ${times}`);
			expect(Math.max(first[0], second), `${re}: ${first[1]}, then ${times}`).toBeGreaterThan(
				BOUND,
			);
		}
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
			expect(() => detectPII(make(10_000_000))).not.toThrow();
			expectLinear(scanning(detectPII, make), 62_500);
		}, 120_000);
	}
});

describe("deep nesting: detection and redaction walk 100,000 levels, in time linear in the depth", () => {
	// A recursive walk exhausted the call stack at about 10,000 levels (20 KB of JSON) and threw.
	// The time bound is a ratio to a walk doing the same kinds of work per level in the
	// same run: a frame, a path built from its parent's, a set lookup. At 6,250 levels and at
	// 100,000, detection and redaction must stay within MAX_RATIO of it; a walk that rehashed its
	// whole path at every level was more than a thousand times over.
	const DEPTHS = [6_250, 100_000];
	const LEAF = "write to alice@example.com";
	const SHORT_PATHS: ReadonlySet<string> = new Set(["config", "config.abortSignal"]);
	const shapes: ReadonlyArray<[string, (depth: number) => unknown, (v: unknown) => unknown]> = [
		[
			"arrays",
			(depth) => {
				let v: unknown = LEAF;
				for (let i = 0; i < depth; i++) v = [v];
				return v;
			},
			(v) => (v as unknown[])[0],
		],
		[
			"objects",
			(depth) => {
				let v: unknown = LEAF;
				for (let i = 0; i < depth; i++) v = { a: v };
				return v;
			},
			(v) => (v as { a: unknown }).a,
		],
	];
	/** The baseline: an iterative walk with the same per-level work. */
	const baselineWalk = (v: unknown, child: (v: unknown) => unknown): void => {
		type Frame = { x: unknown; path: string; below: Frame | undefined };
		let top: Frame | undefined = { x: v, path: "", below: undefined };
		let levels = 0;
		while (top !== undefined) {
			const frame: Frame = top;
			top = frame.below;
			if (frame.x !== null && typeof frame.x === "object") {
				if (SHORT_PATHS.has(frame.path.length <= 18 ? frame.path : "")) levels++;
				top = { x: child(frame.x), path: `${frame.path}.a`, below: top };
				levels++;
			}
		}
		sink ^= levels;
	};
	/** The innermost value, reached without recursing. */
	const innermost = (v: unknown, child: (v: unknown) => unknown): unknown => {
		let x = v;
		while (x !== null && typeof x === "object") x = child(x);
		return x;
	};
	const withinDepthRatio = (
		walk: (v: unknown) => unknown,
		make: (depth: number) => unknown,
		child: (v: unknown) => unknown,
	): Verdict => {
		let last: Verdict = { ok: true, size: 0, ratio: 0 };
		for (const depth of DEPTHS) {
			const v = make(depth);
			const baseline = Math.max(
				median([1, 2, 3, 4, 5].map(() => timeMs(() => baselineWalk(v, child)))),
				0.001,
			);
			let t = timeMs(() => walk(v));
			if (t / baseline > MAX_RATIO)
				t = Math.min(
					t,
					timeMs(() => walk(v)),
				);
			last = { ok: t / baseline <= MAX_RATIO, size: depth, ratio: t / baseline };
			if (!last.ok) return last;
		}
		return last;
	};

	for (const [shape, make, child] of shapes) {
		it(`detectPII: ${shape}`, () => {
			const verdict = withinDepthRatio(detectPII, make, child);
			expect(verdict, `ratio ${verdict.ratio.toFixed(1)} at depth ${verdict.size}`).toMatchObject({
				ok: true,
			});
			expect(sink).toBeTypeOf("number");
			const found = detectPII(make(100_000));
			expect(found.types).toEqual(["email"]);
			expect(found.paths).toHaveLength(1);
			expect(found.paths[0]?.endsWith("(email)")).toBe(true);
		}, 120_000);

		it(`redactPII: ${shape}`, () => {
			const verdict = withinDepthRatio(redactPII, make, child);
			expect(verdict, `ratio ${verdict.ratio.toFixed(1)} at depth ${verdict.size}`).toMatchObject({
				ok: true,
			});
			const deep = make(100_000);
			expect(innermost(redactPII(deep).data, child)).toBe("[REDACTED:email]");
			expect(innermost(deep, child)).toBe(LEAF);
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
			String.fromCharCode(0xe9),
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

describe("long runs of letters or digits: no detector throws, up to 10.4M characters", () => {
	// V8 overflows its regexp stack on a counted quantifier `X{n,}` over a run of about 6M
	// characters, and threw RangeError out of detectPII, redactPII and detectInjection. Every
	// counted quantifier is now written `X{n}X*` (counted-quantifiers.test.ts holds the rest).
	// Each row is one rule's prefix and a run of the class its quantifier repeats; the plain
	// runs reach the hex, digit and base64 rules with no prefix at all.
	const RUNS: ReadonlyArray<[string, string]> = [
		["", "b"],
		["", "1"],
		["", "B"],
		["sk-", "b"],
		["sk_live_", "b"],
		["sk-ant-", "b"],
		["rk_live_", "b"],
		["sk_org_", "b"],
		["xai-", "b"],
		["gsk_", "b"],
		["pplx-", "b"],
		["ghp_", "b"],
		["github_pat_", "b"],
		["ghu_", "b"],
		["Bearer ", "b"],
		["eyJ", "b"],
		["eyJbbbbbbbbbbbb.bbbbbbbbbbbb.", "b"],
		["SG.", "b"],
		["glpat-", "b"],
		["glrt-", "b"],
		["npm_", "b"],
		["xapp-", "b"],
		["xoxe-1-", "b"],
		["whsec_", "b"],
		["AIza", "b"],
		["AKIA", "B"],
	];
	const LONGEST = 10_400_000;
	for (const [prefix, unit] of RUNS) {
		const name = `${JSON.stringify(prefix)} then a run of ${JSON.stringify(unit)}`;
		for (const [fn, scan] of [
			["detectPII", detectPII],
			["redactPII", (s: string) => redactPII(s)],
		] as const) {
			it(`${fn}: ${name}`, () => {
				expect(() => scan(after(prefix, unit)(LONGEST))).not.toThrow();
				expectLinear(scanning(scan, after(prefix, unit)), 62_500);
			}, 120_000);
		}
	}
	for (const unit of ["b", "A", "1", "+/"]) {
		it(`detectInjection: a run of ${JSON.stringify(unit)}`, () => {
			expect(() => detectInjection(run(unit)(LONGEST))).not.toThrow();
			expectLinear(scanning(detectInjection, run(unit)), 62_500);
		}, 120_000);
	}
});
