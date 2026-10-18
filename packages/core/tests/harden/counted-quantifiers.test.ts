// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * NO REGEX IN THE PACKAGES' SOURCE USES AN OPEN COUNTED QUANTIFIER `X{n,}`.
 *
 * V8's regexp engine overflows its stack on `X{n,}` over a run of about 6M characters and
 * throws RangeError ("Maximum call stack size exceeded"), where `X{n}X*` (the same language,
 * matched greedily the same way) runs to the end of the string. detectPII, redactPII and
 * detectInjection threw on a long enough run of letters or digits: a plain 6M run of `b` was
 * enough, through the 64-hex rule.
 *
 * Pinned:
 * - Every `X{n,}` in a regex in packages/<pkg>/src is gone: a guard reads every source file and
 *   fails on any outside a comment, so a new one cannot come back unnoticed.
 * - Each rewritten rule is in its source exactly as listed here, and gives the old rule's
 *   matches (each match's index and groups) on a seeded corpus built from its prefixes and
 *   classes, wherever the old rule did not throw.
 * - The old rules threw at 6M characters and the new ones do not (the control that the crash
 *   was real and the inputs reach it). scan-linear.test.ts runs the detectors themselves on
 *   runs of up to 10.4M characters.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");

/** An open counted quantifier: `{n,}` with no upper bound. */
const OPEN_COUNT = /\{\d+,\}/;

/** Source files under packages/<pkg>/src: .ts, .tsx, .js, .mjs and .cjs, recursively. */
function sources(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name !== "node_modules" && e.name !== "dist") walk(p);
			} else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(p);
		}
	};
	for (const pkg of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		const src = join(ROOT, "packages", pkg.name, "src");
		try {
			walk(src);
		} catch {
			// A package with no src directory has nothing to check.
		}
	}
	return out;
}

/** The lines of `text` that hold an open counted quantifier, comment lines left out. */
function openCounts(text: string): number[] {
	const hits: number[] = [];
	text.split("\n").forEach((line, i) => {
		const t = line.trimStart();
		if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
		if (OPEN_COUNT.test(line)) hits.push(i + 1);
	});
	return hits;
}

describe("the source guard", () => {
	it("no source file holds `{n,}` outside a comment", () => {
		const files = sources();
		// The walk reaches every package: core's PII and injection modules among them.
		expect(files.some((f) => f.endsWith("packages/core/src/policy/pii.ts"))).toBe(true);
		expect(files.some((f) => f.endsWith("packages/core/src/policy/injection.ts"))).toBe(true);
		expect(files.length).toBeGreaterThan(100);
		const found: string[] = [];
		for (const f of files) {
			for (const line of openCounts(readFileSync(f, "utf8"))) {
				found.push(`${f.slice(ROOT.length + 1)}:${line}`);
			}
		}
		expect(found).toEqual([]);
	});

	it("the guard reports a regex literal, a RegExp string and a nested one, and skips comments", () => {
		const text = [
			"const a = /x{2,}/g;",
			'const b = new RegExp("[0-9]{16,}");',
			"	return /\\bBearer\\s+\\S{20,}/.test(v);",
			" * `/[a-z]{2,}/` in a comment",
			"// /x{3,}/ in a comment",
			"const ok = /x{2}x*/g;",
			"const bounded = /x{0,2}/g;",
		].join("\n");
		expect(openCounts(text)).toEqual([1, 2, 3]);
	});
});

/**
 * Every rule rewritten, as [file, old, new, [prefix, unit]]: the new one is the literal in that
 * source file, verbatim, and the old one is what 5.0.5 shipped. The prefix and the unit build
 * the crash input: a run of the class the quantifier repeats, after a prefix that reaches it.
 */
const RULES: ReadonlyArray<[string, RegExp, RegExp, [string, string]]> = [
	["policy/pii.ts", /\d{16,}/g, /\d{16}\d*/g, ["", "1"]],
	[
		"policy/pii.ts",
		/\b(?:sk-|sk_(?:live|test)_)([a-zA-Z0-9_-]{20,})/g,
		/\b(?:sk-|sk_(?:live|test)_)([a-zA-Z0-9_-]{20}[a-zA-Z0-9_-]*)/g,
		["sk-", "b"],
	],
	[
		"policy/pii.ts",
		/\b(?:rk_(?:live|test)_|sk_org_)([a-zA-Z0-9_-]{20,})/g,
		/\b(?:rk_(?:live|test)_|sk_org_)([a-zA-Z0-9_-]{20}[a-zA-Z0-9_-]*)/g,
		["rk_live_", "b"],
	],
	[
		"policy/pii.ts",
		/\b(?:(?:xai-|gsk_)([A-Za-z0-9]{20,})|pplx-([A-Za-z0-9]{16,}))(?![A-Za-z0-9_-])/g,
		/\b(?:(?:xai-|gsk_)([A-Za-z0-9]{20}[A-Za-z0-9]*)|pplx-([A-Za-z0-9]{16}[A-Za-z0-9]*))(?![A-Za-z0-9_-])/g,
		["pplx-", "b"],
	],
	[
		"policy/pii.ts",
		/\b(?:ghp_|gho_|ghs_|ghr_|github_pat_)[a-zA-Z0-9]{22,}\b/,
		/\b(?:ghp_|gho_|ghs_|ghr_|github_pat_)[a-zA-Z0-9]{22}[a-zA-Z0-9]*\b/,
		["ghp_", "b"],
	],
	[
		"policy/pii.ts",
		/\bghu_([a-zA-Z0-9]{22,})\b/g,
		/\bghu_([a-zA-Z0-9]{22}[a-zA-Z0-9]*)\b/g,
		["ghu_", "b"],
	],
	["policy/pii.ts", /\bBearer\s+\S{20,}/, /\bBearer\s+\S{20}\S*/, ["Bearer ", "b"]],
	[
		"policy/pii.ts",
		/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/y,
		/eyJ[a-zA-Z0-9_-]{10}[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]{10}[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]{10}[a-zA-Z0-9_-]*\b/y,
		["eyJbbbbbbbbbbbb.bbbbbbbbbbbb.", "b"],
	],
	[
		"policy/pii.ts",
		/\b(?:xox[bpars]-([a-zA-Z0-9-]+)(?!\w)|(?:SG\.|glpat-)([a-zA-Z0-9_-]{20,}))/g,
		/\b(?:xox[bpars]-([a-zA-Z0-9-]+)(?!\w)|(?:SG\.|glpat-)([a-zA-Z0-9_-]{20}[a-zA-Z0-9_-]*))/g,
		["glpat-", "b"],
	],
	[
		"policy/pii.ts",
		/\bnpm_[a-zA-Z0-9]{36,}\b/,
		/\bnpm_[a-zA-Z0-9]{36}[a-zA-Z0-9]*\b/,
		["npm_", "b"],
	],
	[
		"policy/pii.ts",
		/\b(?:xapp|xwfp|xoxe-[0-9])-([a-zA-Z0-9-]{20,})(?!\w)/g,
		/\b(?:xapp|xwfp|xoxe-[0-9])-([a-zA-Z0-9-]{20}[a-zA-Z0-9-]*)(?!\w)/g,
		["xapp-", "b"],
	],
	[
		"policy/pii.ts",
		/\bgl(?:oas|dt|rtr?|cbt|ptt|ft|imt|agent|wt|soat|ffct)-([a-zA-Z0-9_-]{20,})/g,
		/\bgl(?:oas|dt|rtr?|cbt|ptt|ft|imt|agent|wt|soat|ffct)-([a-zA-Z0-9_-]{20}[a-zA-Z0-9_-]*)/g,
		["glrt-", "b"],
	],
	[
		"policy/pii.ts",
		/\bwhsec_([A-Za-z0-9+/]{32,}={0,2})(?![A-Za-z0-9+/=_-])/g,
		/\bwhsec_([A-Za-z0-9+/]{32}[A-Za-z0-9+/]*={0,2})(?![A-Za-z0-9+/=_-])/g,
		["whsec_", "b"],
	],
	["policy/pii.ts", /\b[0-9a-fA-F]{64,}\b/g, /\b[0-9a-fA-F]{64}[0-9a-fA-F]*\b/g, ["", "b"]],
	[
		"policy/injection.ts",
		/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{20,}={0,2}(?![A-Za-z0-9=])/g,
		/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{20}[A-Za-z0-9+/]*={0,2}(?![A-Za-z0-9=])/g,
		["", "b"],
	],
	["audit/sigv4.ts", / {2,}/g, / {2} */g, ["", " "]],
];

/** `re` with the global flag (a sticky rule as global), so matchAll finds every match. */
function global(re: RegExp): RegExp {
	return new RegExp(re.source, `${re.flags.replace(/[gy]/g, "")}g`);
}

/** Every match of `re` in `s`, from each position a match can start: index and groups. */
function matches(re: RegExp, s: string): string {
	return JSON.stringify([...s.matchAll(global(re))].map((m) => [m.index, ...m]));
}

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

/** The prefixes the rules turn on, runs of each class, and the characters that end them. */
const PIECES = [
	"sk-",
	"sk_live_",
	"sk_test_",
	"rk_live_",
	"sk_org_",
	"xai-",
	"gsk_",
	"pplx-",
	"ghp_",
	"github_pat_",
	"ghu_",
	"Bearer ",
	"Bearer\t",
	"eyJ",
	"eyJhbGciOiJIUzI1NiJ9.",
	"abcdefghijkl.",
	"abcdefghijkl",
	"xoxb-",
	"SG.",
	"glpat-",
	"glrt-",
	"npm_",
	"xapp-",
	"xoxe-1-",
	"whsec_",
	"bbbbb",
	"aB3",
	"0123456789",
	"deadbeef",
	"ABCDEF",
	"_",
	"-",
	".",
	"+",
	"/",
	"=",
	"==",
	" ",
	"  ",
	"   ",
	"\n",
	"x",
	String.fromCharCode(0xe9),
];

function corpus(seed: number, count: number, maxPieces: number): string[] {
	const rand = seeded(seed);
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const n = Math.floor(rand() * (maxPieces + 1));
		let s = "";
		for (let j = 0; j < n; j++) {
			const p = PIECES[Math.floor(rand() * PIECES.length)] as string;
			// Long runs too, so that every count (16, 20, 22, 32, 36, 64) is crossed both ways.
			s += rand() < 0.15 ? p.repeat(1 + Math.floor(rand() * 30)) : p;
		}
		out.push(s);
	}
	return out;
}

describe("each rewritten rule", () => {
	for (const [file, oldRe, newRe] of RULES) {
		it(`is in ${file} as written: ${newRe.source.slice(0, 60)}`, () => {
			const text = readFileSync(join(ROOT, "packages/core/src", file), "utf8");
			expect(text).toContain(`/${newRe.source}/${newRe.flags}`);
			expect(text).not.toContain(`/${oldRe.source}/`);
		});
	}

	it("gives the old rule's matches, index and groups, on 20,000 strings", () => {
		const texts = corpus(611, 20_000, 24);
		for (const [, oldRe, newRe] of RULES) {
			let found = 0;
			const differ: string[] = [];
			for (const t of texts) {
				const want = matches(oldRe, t);
				if (want !== "[]") found++;
				if (matches(newRe, t) !== want) differ.push(t);
			}
			expect(differ.slice(0, 3), newRe.source).toEqual([]);
			// The corpus reaches each rule: some strings match it, and most do not.
			expect(found, newRe.source).toBeGreaterThan(20);
			expect(found, newRe.source).toBeLessThan(texts.length / 2);
		}
	}, 120_000);

	for (const [, oldRe, newRe, [prefix, unit]] of RULES) {
		it(`at 6M characters the old rule threw and the new one does not: ${newRe.source.slice(0, 50)}`, () => {
			const s = prefix + unit.repeat(6_000_000);
			// The new rule reaches the run: it matches the input, from the prefix.
			const found = [...s.matchAll(global(newRe))];
			expect(found.length, newRe.source).toBeGreaterThan(0);
			if (unit === " ") {
				// V8 handles a one-character atom: the single-space rule never threw, and was
				// rewritten only so that the guard admits no exception.
				expect(() => [...s.matchAll(global(oldRe))]).not.toThrow();
			} else {
				// The control: this input reached the old quantifier, and V8 overflowed.
				expect(() => [...s.matchAll(global(oldRe))], oldRe.source).toThrow(RangeError);
			}
		}, 120_000);
	}
});
