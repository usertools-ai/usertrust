// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The integrity claims register (docs/claims.json, explained in docs/CLAIMS.md).
 *
 * Public sentences about the audit chain kept saying more than verification
 * does: that a reordered event breaks verification (the verifiers order events
 * by `sequence`), that a shorter but internally consistent chain no longer
 * passes (it does, once `.meta` is rewritten), that the trail is immutable (it
 * is tamper-evident). Each was found by a reader, after it shipped, because
 * nothing tied the sentence to a test that fails when it stops being true.
 *
 * This file is that tie. It checks four things:
 *
 *  (a) every hit of the integrity vocabulary in the documentation sits inside a
 *      registered statement or a registered non-claim, so a new integrity
 *      sentence cannot ship without an entry;
 *  (b) every registered statement is still in its file, word for word, and
 *      every test a claim cites still exists as a literal, unskipped title, so
 *      a register entry cannot outlive what it points at;
 *  (c) no documentation states a denied phrase, each of which is contradicted
 *      by a sentence of LIMITATIONS.md or by a test row, and that contradicting
 *      text must itself still exist;
 *  (d) the claims with no proof yet are listed, printed and capped.
 *
 * What it does NOT do: decide whether a sentence is true. That is the cited
 * test's job, and a reviewer's job when an entry is added. A statement
 * registered against the wrong test passes here. The register makes the claim
 * and its evidence sit next to each other where a reviewer can see both.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const REGISTER = "docs/claims.json";

interface Located {
	file: string;
	text: string;
}
interface Proof {
	file: string;
	test: string;
}
interface Claim {
	id: string;
	kind: "guarantee" | "caveat";
	claim: string;
	statements: Located[];
	proofs: Proof[];
	pending?: string;
}
interface NonClaim extends Located {
	why: string;
}
interface Denied {
	id: string;
	pattern: string;
	why: string;
	contradictedBy: Located;
	pendingCopy?: Located[];
}
interface ScopeEntry {
	file?: string;
	dir?: string;
	ext?: string;
	/** With `dir`: read files exactly this many directories below it (1 for a package README). */
	depth?: number;
	section?: string;
}
interface Register {
	scope: { scan: ScopeEntry[]; exclude: string[]; denied: ScopeEntry[] };
	vocabulary: string[];
	pendingCeiling: number;
	claims: Claim[];
	nonclaims: NonClaim[];
	denied: Denied[];
}

// ---------------------------------------------------------------------------
// The checkers. Pure functions over text, so the fixture rows at the bottom
// can show each one reporting a failure (a checker that cannot fail proves
// nothing).
// ---------------------------------------------------------------------------

/** Whitespace collapsed, so a statement matches across the line wraps of a Markdown paragraph. */
function normalize(text: string): string {
	return text.replace(/\s+/g, " ");
}

/** Every start offset of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
	const at: number[] = [];
	if (needle === "") return at;
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) at.push(i);
	return at;
}

/** The part of a file the vocabulary scan reads: one `## [...]` section of a changelog, or all of it. */
function scannedText(text: string, section: string | undefined): string {
	if (section === undefined) return text;
	const start = text.indexOf(`## ${section}`);
	if (start === -1) throw new Error(`section ${section} not found`);
	const next = text.indexOf("\n## [", start + 1);
	return next === -1 ? text.slice(start) : text.slice(start, next);
}

interface Hit {
	word: string;
	context: string;
}

/** Vocabulary hits in `text` that no span in `covered` contains. `text` and spans are normalized. */
function uncoveredHits(text: string, vocabulary: RegExp, covered: string[]): Hit[] {
	const spans = covered.flatMap((c) =>
		occurrences(text, c).map((at) => [at, at + c.length] as const),
	);
	const out: Hit[] = [];
	for (const m of text.matchAll(vocabulary)) {
		const from = m.index;
		const to = from + m[0].length;
		if (spans.some(([s, e]) => s <= from && to <= e)) continue;
		out.push({ word: m[0], context: text.slice(Math.max(0, from - 100), to + 100) });
	}
	return out;
}

/** The `it` / `test` / `describe` call a callee names, with its modifier (`it.skip`, `it.each(...)`). */
function testCall(callee: ts.Expression): { base: string; modifier?: string } | undefined {
	if (ts.isIdentifier(callee)) return { base: callee.text };
	if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
		return { base: callee.expression.text, modifier: callee.name.text };
	}
	// it.each(table)("title"), it.skipIf(cond)("title")
	if (ts.isCallExpression(callee)) return testCall(callee.expression);
	return undefined;
}

/** Every call in a source file, from its syntax tree: code inside comments and strings is not a call. */
function calls(source: string): ts.CallExpression[] {
	const out: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) out.push(node);
		ts.forEachChild(node, visit);
	};
	visit(ts.createSourceFile("cited.test.ts", source, ts.ScriptTarget.Latest, true));
	return out;
}

/**
 * The titles of the `it(...)` / `test(...)` rows a test file declares, skipped and todo rows
 * excluded. A template-literal title is returned as written (`${label}: ...`).
 */
function literalTitles(source: string): Set<string> {
	const titles = new Set<string>();
	for (const call of calls(source)) {
		const named = testCall(call.expression);
		if (named === undefined || (named.base !== "it" && named.base !== "test")) continue;
		if (named.modifier === "skip" || named.modifier === "todo" || named.modifier === "skipIf")
			continue;
		const title = call.arguments[0];
		if (title === undefined) continue;
		if (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
			titles.add(title.text);
		else if (ts.isTemplateExpression(title)) titles.add(title.getText().slice(1, -1));
	}
	return titles;
}

/** A cited file that can stop its rows from running wholesale. */
function disablesRows(source: string): string | undefined {
	for (const call of calls(source)) {
		const named = testCall(call.expression);
		if (named === undefined || !["describe", "it", "test"].includes(named.base)) continue;
		if (named.modifier === "skip" || named.modifier === "todo" || named.modifier === "only") {
			return `${named.base}.${named.modifier}(`;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Reading the register and the documentation
// ---------------------------------------------------------------------------

function read(rel: string): string {
	return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

/** Files under `dir` ending in `ext`; dependencies and dot-directories are not documentation. */
function walk(dir: string, ext: string, depth?: number): string[] {
	const out: string[] = [];
	for (const name of readdirSync(join(REPO_ROOT, dir)).sort()) {
		const rel = `${dir}/${name}`;
		if (statSync(join(REPO_ROOT, rel)).isDirectory()) {
			if (name === "node_modules" || name.startsWith(".") || depth === 0) continue;
			out.push(...walk(rel, ext, depth === undefined ? undefined : depth - 1));
		} else if (name.endsWith(ext) && (depth === undefined || depth === 0)) {
			out.push(rel);
		}
	}
	return out;
}

/** The files a scope names, each with the changelog section to read when it names one. */
function scopeFiles(
	entries: ScopeEntry[],
	exclude: string[],
): { file: string; section?: string }[] {
	const out: { file: string; section?: string }[] = [];
	for (const e of entries) {
		if (e.file !== undefined) {
			// Not skip-if-missing: a scope that silently loses a file is the defect this file exists for.
			expect(
				existsSync(join(REPO_ROOT, e.file)),
				`${e.file} is in the register's scope but missing`,
			).toBe(true);
			out.push(e.section === undefined ? { file: e.file } : { file: e.file, section: e.section });
		} else if (e.dir !== undefined && e.ext !== undefined) {
			for (const f of walk(e.dir, e.ext, e.depth)) out.push({ file: f });
		} else {
			throw new Error(`scope entry names neither a file nor a dir+ext: ${JSON.stringify(e)}`);
		}
	}
	return out.filter((f) => !exclude.includes(f.file));
}

const register = JSON.parse(read(REGISTER)) as Register;
const vocabulary = new RegExp(register.vocabulary.join("|"), "gi");
const scanned = scopeFiles(register.scope.scan, register.scope.exclude);

describe("the integrity claims register", () => {
	it("is well formed: unique ids, known kinds, a proof or a stated reason for none", () => {
		const ids = [...register.claims.map((c) => c.id), ...register.denied.map((d) => d.id)];
		expect(new Set(ids).size, "duplicate ids").toBe(ids.length);
		for (const c of register.claims) {
			expect(c.id, c.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(["guarantee", "caveat"], c.id).toContain(c.kind);
			expect(c.claim.length, c.id).toBeGreaterThan(0);
			expect(c.statements.length, `${c.id} states nothing`).toBeGreaterThan(0);
			if (c.proofs.length === 0) {
				expect(c.pending, `${c.id} has no proof and no pending reason`).toBeTruthy();
			} else {
				expect(c.pending, `${c.id} has proofs AND a pending reason`).toBeUndefined();
			}
		}
		for (const n of register.nonclaims) expect(n.why.length, n.text).toBeGreaterThan(0);
	});

	it("scans enough of the documentation to mean something", () => {
		expect(scanned.length).toBeGreaterThanOrEqual(20);
		const hits = scanned.reduce(
			(n, f) =>
				n + [...normalize(scannedText(read(f.file), f.section)).matchAll(vocabulary)].length,
			0,
		);
		expect(hits).toBeGreaterThanOrEqual(100);
	});

	it("(b) every registered statement and non-claim is in its file, word for word", () => {
		const missing: string[] = [];
		const located = [
			...register.claims.flatMap((c) => c.statements.map((s) => ({ ...s, owner: c.id }))),
			...register.nonclaims.map((n) => ({ ...n, owner: "non-claim" })),
			...register.denied.flatMap((d) => (d.pendingCopy ?? []).map((s) => ({ ...s, owner: d.id }))),
		];
		for (const s of located) {
			if (!normalize(read(s.file)).includes(normalize(s.text)))
				missing.push(`${s.owner}: ${s.file}: ${s.text}`);
		}
		expect(missing, "statements no longer in their file: update the register with the doc").toEqual(
			[],
		);
	});

	it("(b) every cited test exists as a literal, unskipped it/test title in its file", () => {
		const missing: string[] = [];
		const files = new Map<string, string>();
		for (const c of register.claims) {
			for (const p of c.proofs) {
				if (!existsSync(join(REPO_ROOT, p.file))) {
					missing.push(`${c.id}: no file ${p.file}`);
					continue;
				}
				const src = files.get(p.file) ?? read(p.file);
				files.set(p.file, src);
				const disabled = disablesRows(src);
				if (disabled !== undefined) missing.push(`${c.id}: ${p.file} contains ${disabled}`);
				if (!literalTitles(src).has(p.test)) missing.push(`${c.id}: ${p.file}: no row "${p.test}"`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("(a) every integrity-vocabulary hit in the documentation is inside a registered statement or non-claim", () => {
		const unregistered: string[] = [];
		for (const { file, section } of scanned) {
			const text = normalize(scannedText(read(file), section));
			const covered = [
				...register.claims.flatMap((c) =>
					c.statements.filter((s) => s.file === file).map((s) => s.text),
				),
				...register.nonclaims.filter((n) => n.file === file).map((n) => n.text),
				...register.denied.flatMap((d) =>
					(d.pendingCopy ?? []).filter((p) => p.file === file).map((p) => p.text),
				),
			].map(normalize);
			for (const h of uncoveredHits(text, vocabulary, covered)) {
				unregistered.push(`${file}: "${h.word}" in ...${h.context}...`);
			}
		}
		expect(
			unregistered,
			"an integrity sentence with no register entry: add it to docs/claims.json with the test that proves it (docs/CLAIMS.md)",
		).toEqual([]);
	});

	it("(a) every non-claim holds a vocabulary hit, so the list cannot fill with dead entries", () => {
		const dead = register.nonclaims.filter(
			(n) => !new RegExp(vocabulary.source, "i").test(normalize(n.text)),
		);
		expect(dead.map((n) => `${n.file}: ${n.text}`)).toEqual([]);
	});

	it("(c) no documentation states a denied phrase, and what contradicts each one still exists", () => {
		const files = scopeFiles(register.scope.denied, []);
		const found: string[] = [];
		const awaiting: string[] = [];
		for (const d of register.denied) {
			const contradiction = normalize(read(d.contradictedBy.file));
			expect(
				contradiction.includes(normalize(d.contradictedBy.text)),
				`${d.id}: the text that contradicts it is gone from ${d.contradictedBy.file}; review the denial`,
			).toBe(true);
			const pattern = new RegExp(d.pattern, "gim");
			for (const { file, section } of files) {
				const text = normalize(scannedText(read(file), section));
				const allowed = (d.pendingCopy ?? [])
					.filter((p) => p.file === file)
					.map((p) => normalize(p.text));
				for (const m of text.matchAll(pattern)) {
					const inPending = allowed.some((a) =>
						occurrences(text, a).some(
							(at) => at <= m.index && m.index + m[0].length <= at + a.length,
						),
					);
					(inPending ? awaiting : found).push(`${d.id}: ${file}: ${m[0]}`);
				}
			}
		}
		if (awaiting.length > 0)
			console.info(`denied phrases awaiting a ruling (pending-cam):\n  ${awaiting.join("\n  ")}`);
		expect(found).toEqual([]);
	});

	it("(d) the claims with no proof yet are printed, and their number never grows", () => {
		const pending = register.claims.filter((c) => c.pending !== undefined);
		console.info(
			`claims with no proof yet: ${pending.length}\n  ${pending.map((c) => `${c.id}: ${c.pending}`).join("\n  ")}`,
		);
		expect(pending.length).toBeLessThanOrEqual(register.pendingCeiling);
	});
});

describe("the register's checkers report a failure when there is one (positive controls)", () => {
	it("an unregistered vocabulary hit is reported, and a registered span covers it across a line wrap", () => {
		const doc = normalize("Intro.\nThe log is tamper-evident\nby construction. Pricing is flat.");
		const v = /tamper-evident|immutable/gi;
		expect(uncoveredHits(doc, v, []).map((h) => h.word)).toEqual(["tamper-evident"]);
		expect(
			uncoveredHits(doc, v, [normalize("The log is tamper-evident by\n construction.")]),
		).toEqual([]);
		// A span that holds only part of the hit does not cover it.
		expect(uncoveredHits(doc, v, ["The log is tamper"]).length).toBe(1);
	});

	it("literal titles are found in every quoting style, and skipped or todo rows are not", () => {
		const src = [
			'it("double", () => {});',
			"test('single', () => {});",
			"it(`template ${x}`, () => {});",
			'it("escaped \\"quote\\"", () => {});',
			'it.each([1])("each %s", () => {});',
			'it.skip("skipped", () => {});',
			'it.todo("todo");',
			'it.skipIf(true)("skip-if", () => {});',
			'audit("not a row", () => {});',
			'// it("commented out", () => {});',
			'/* test("block comment", () => {}); */',
			"const s = 'it(\"inside a string\", () => {})';",
		].join("\n");
		const t = literalTitles(src);
		// An it.each title is the literal format string the source holds.
		expect([...t].sort()).toEqual(
			["double", "each %s", 'escaped "quote"', "single", "template ${x}"].sort(),
		);
		expect(disablesRows(src)).toBe("it.skip(");
		expect(disablesRows('describe.only("x", () => {});')).toBe("describe.only(");
		expect(disablesRows('it("x", () => {});')).toBeUndefined();
		// A commented-out skip disables nothing, as a commented-out row proves nothing.
		expect(disablesRows('// it.skip("x", () => {});\nit("x", () => {});')).toBeUndefined();
	});

	it("a changelog scan reads only the named section", () => {
		const log = "# Changelog\n\n## [Unreleased]\n\nnew\n\n## [1.0.0]\n\nold tamper-proof\n";
		expect(scannedText(log, "[Unreleased]")).toBe("## [Unreleased]\n\nnew\n");
		expect(() => scannedText(log, "[9.9.9]")).toThrow();
	});
});
