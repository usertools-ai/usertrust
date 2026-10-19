// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The product calls the thing that holds the budget and the money a CONTROLLER ("budget and
 * financial controller"). The word "governor" survives only as a code identifier (`Governor`,
 * `createGovernor`, `GovernorOpts`), as a wire/persisted value, and in the error text of an API
 * object that is named after the identifier. Nothing a person reads may say it.
 *
 * Two scans, each over a tree located from THIS file, never from the cwd (AGENTS.md: a whole-repo
 * command asserts over a tree, not the repo):
 *
 *  (a) string, template and JSX-text literals in the shipped sources, read from the syntax tree so
 *      a comment or an identifier is not a hit. Every literal that says "governor" must be declared
 *      in ALLOWED_LITERALS with the reason it stays. A declared entry that no longer matches fails
 *      too, so the list cannot rot into a blanket exemption.
 *  (b) prose in the READMEs, LIMITATIONS, docs/ and the site's content, outside fenced code and
 *      inline code spans. No allowlist: a code span is where `createGovernor()` belongs.
 *
 * WHAT A GREEN RUN CLAIMS: no undeclared literal or prose sentence in these trees says "governor".
 * It does not claim the trees are complete; the scope is the two lists below, and a new shipped
 * directory must be added to them. The "positive control" cases prove the scanners can see a
 * planted hit, so a scanner that silently matches nothing cannot pass for a clean tree.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

// packages/core/tests/harden -> repo root
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * The standalone word, either number, any case. `createGovernor`, `GovernorOpts` and
 * `stream-governor.js` style identifiers are not prose: a letter or digit on either side of the
 * word means it is part of a longer name. A hyphen is not (`governor-side`).
 */
const WORD = /(?<![A-Za-z0-9_])governors?(?![A-Za-z0-9_])/i;

/** The named entities a page or an MDX file is likely to use; an unknown name is left as written. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
	lsquo: "\u2018",
	rsquo: "\u2019",
	ldquo: "\u201c",
	rdquo: "\u201d",
	mdash: "\u2014",
	ndash: "\u2013",
	hellip: "\u2026",
	shy: "\u00ad",
	zwj: "\u200d",
	zwnj: "\u200c",
};

/**
 * What a reader sees of `text`: HTML entities decoded (numeric, hex and the named ones above),
 * then the characters that render as nothing (soft hyphen, zero-width joiners, the byte-order
 * mark) removed. Without it `govern&#111;r` and `gov&shy;ernor` render "governor" and pass.
 */
function visibleText(text: string): string {
	return text
		.replace(
			/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g,
			(whole, dec, hex, name) => {
				if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
				const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
				return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
					? String.fromCodePoint(code)
					: whole;
			},
		)
		.replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "");
}

interface Hit {
	file: string;
	line: number;
	text: string;
}

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name === "node_modules" || e.name === "dist" || e.name === ".next" || e.name === ".git") {
			continue;
		}
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, accept, out);
		else if (e.isFile() && accept(e.name)) out.push(p);
	}
	return out;
}

/** The literal-bearing source files: build inputs that ship, plus the plugin's hooks. */
function sourceFiles(root: string): string[] {
	const out: string[] = [];
	const code = (n: string): boolean => /\.(ts|tsx|mts|js|mjs)$/.test(n) && !/\.d\.ts$/.test(n);
	const pkgs = join(root, "packages");
	let names: string[] = [];
	try {
		names = readdirSync(pkgs);
	} catch {
		// no packages directory: nothing to scan
	}
	for (const pkg of names) {
		walk(join(pkgs, pkg, "src"), code, out);
		walk(join(pkgs, pkg, "hooks"), code, out);
	}
	// The marketing/docs site's app: its copy is user-facing text too.
	walk(join(root, "site", "app"), code, out);
	return out.sort();
}

/** Every literal in one file whose text names the governor, as the literal's own text. */
function scanSource(file: string, text: string): Hit[] {
	const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
	const hits: Hit[] = [];
	const record = (node: ts.Node, raw: string): void => {
		// JSX text, and a JSX attribute's string, are entity-decoded when rendered; a plain
		// JS string is not.
		const value =
			ts.isJsxText(node) || (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent))
				? visibleText(raw)
				: raw;
		if (!WORD.test(value)) return;
		const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
		hits.push({ file, line, text: value });
	};
	const visit = (node: ts.Node): void => {
		// A module specifier or `import("...")` type is a path, not text anyone reads.
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			node.forEachChild((c) => {
				if (c !== node.moduleSpecifier) visit(c);
			});
			return;
		}
		if (ts.isImportTypeNode(node)) return;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			record(node, node.text);
		} else if (
			ts.isTemplateHead(node) ||
			ts.isTemplateMiddle(node) ||
			ts.isTemplateTail(node) ||
			ts.isJsxText(node)
		) {
			record(node, node.text);
		}
		node.forEachChild(visit);
	};
	visit(source);
	return hits;
}

/** The prose files: documentation a reader opens. */
function proseFiles(root: string): string[] {
	const out: string[] = [];
	const md = (n: string): boolean => /\.(md|mdx)$/.test(n);
	for (const f of ["README.md", "LIMITATIONS.md"]) {
		if (existsSync(join(root, f))) out.push(join(root, f));
	}
	walk(join(root, "docs"), md, out);
	walk(join(root, "site", "content"), md, out);
	const pkgs = join(root, "packages");
	let names: string[] = [];
	try {
		names = readdirSync(pkgs);
	} catch {
		// no packages directory
	}
	for (const pkg of names) {
		const p = join(pkgs, pkg, "README.md");
		if (existsSync(p)) out.push(p);
	}
	return [...new Set(out)].sort();
}

/**
 * Prose lines of one markdown/MDX file: fenced blocks dropped, inline code spans blanked (a span
 * of N backticks closes at the next run of exactly N), link destinations (not titles) and bare
 * URLs blanked, and entities decoded.
 */
function scanProse(file: string, text: string): Hit[] {
	const hits: Hit[] = [];
	let fence: string | null = null;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const m = /^\s*(`{3,}|~{3,})/.exec(raw);
		if (fence !== null) {
			if (m?.[1] !== undefined && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
			continue;
		}
		if (m?.[1] !== undefined) {
			fence = m[1];
			continue;
		}
		const prose = visibleText(
			raw
				.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, " ")
				// A link's DESTINATION is a path; its TITLE is text a reader sees on hover.
				.replace(
					/\]\(\s*(?:<[^>]*>|[^\s)]*)(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g,
					(_whole, title: string | undefined) => `] ${title ?? ""}`,
				)
				.replace(/^(\s*\[[^\]]+\]:)\s*(?:<[^>]*>|\S+)/, "$1 ")
				.replace(/https?:\/\/\S+/g, " "),
		);
		if (WORD.test(prose)) hits.push({ file, line: i + 1, text: raw.trim() });
	}
	return hits;
}

/**
 * Every remaining literal that says "governor", and why it stays. `count` is how many literals
 * in that file carry exactly this text. Adding the word to another literal is a new, undeclared
 * hit and fails; so does removing one without updating the list.
 */
interface Allowed {
	file: string;
	literal: string;
	count: number;
	reason: string;
}

const API_OBJECT_ERROR = "Thrown error naming the API object (createGovernor()'s handle) itself.";
const WIRE_VALUE =
	"Wire/persisted enum value of budgetSource: published by the budget record, read by the UI.";
const PERSISTED =
	"Written into the audit chain as a hold_released reason; weekly.ts matches it byte-for-byte.";

const ALLOWED_LITERALS: readonly Allowed[] = [
	{
		file: "packages/core/src/headless.ts",
		literal: "Governor has been destroyed",
		count: 4,
		reason: API_OBJECT_ERROR,
	},
	{
		file: "packages/core/src/headless.ts",
		literal: "governor destroyed",
		count: 1,
		reason: PERSISTED,
	},
	{
		file: "packages/core/src/headless.ts",
		literal: "governor destroyed (terminal still in flight: its void had not completed)",
		count: 1,
		reason: PERSISTED,
	},
	{
		file: "packages/core/src/report/weekly.ts",
		literal: "governor destroyed (terminal still in flight",
		count: 1,
		reason: "Prefix that matches the persisted headless.ts reason above.",
	},
	{ file: "packages/core/src/audit/read.ts", literal: "governor", count: 4, reason: WIRE_VALUE },
	{ file: "packages/core/src/cli/report.ts", literal: "governor", count: 1, reason: WIRE_VALUE },
	{ file: "packages/ui/src/shared/api.ts", literal: "governor", count: 1, reason: WIRE_VALUE },
	{
		file: "packages/ui/src/shared/budget-display.ts",
		literal: "governor",
		count: 2,
		reason: WIRE_VALUE,
	},
];

function relPath(root: string, file: string): string {
	return relative(root, file).split("\\").join("/");
}

/** Undeclared hits, plus declared entries that no longer match what the tree holds. */
function checkLiterals(root: string, allowed: readonly Allowed[]): string[] {
	const problems: string[] = [];
	const seen = new Map<string, number>();
	for (const file of sourceFiles(root)) {
		for (const hit of scanSource(file, readFileSync(file, "utf8"))) {
			const rel = relPath(root, file);
			const key = `${rel}\u0000${hit.text}`;
			seen.set(key, (seen.get(key) ?? 0) + 1);
		}
	}
	const declared = new Map<string, Allowed>();
	for (const a of allowed) declared.set(`${a.file}\u0000${a.literal}`, a);
	for (const [key, n] of seen) {
		const a = declared.get(key);
		const [file, literal] = key.split("\u0000") as [string, string];
		if (a === undefined) {
			problems.push(
				`${file}: a literal says "governor" and is not declared: ${JSON.stringify(literal.slice(0, 160))}`,
			);
		} else if (a.count !== n) {
			problems.push(`${file}: declared ${a.count} of ${JSON.stringify(literal)}, found ${n}`);
		}
	}
	for (const [key, a] of declared) {
		if (!seen.has(key)) {
			problems.push(`${a.file}: declared literal no longer present: ${JSON.stringify(a.literal)}`);
		}
	}
	return problems;
}

function checkProse(root: string): string[] {
	const problems: string[] = [];
	for (const file of proseFiles(root)) {
		for (const hit of scanProse(file, readFileSync(file, "utf8"))) {
			problems.push(`${relPath(root, file)}:${hit.line}: ${hit.text.slice(0, 160)}`);
		}
	}
	return problems;
}

const scratch: string[] = [];
function fixture(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "usertrust-no-governor-"));
	scratch.push(root);
	for (const [rel, body] of Object.entries(files)) {
		const p = join(root, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, body);
	}
	return root;
}

afterAll(() => {
	for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe("no 'governor' in text a person reads", () => {
	it("every string literal in the shipped sources is free of the word, or declared", () => {
		expect(checkLiterals(REPO, ALLOWED_LITERALS)).toEqual([]);
	});

	it("no documentation prose says 'governor' outside a code span or fence", () => {
		expect(checkProse(REPO)).toEqual([]);
	});

	it("scans the trees it claims to (a wrong root would pass vacuously)", () => {
		const src = sourceFiles(REPO).map((f) => relPath(REPO, f));
		expect(src).toContain("packages/core/src/headless.ts");
		expect(src).toContain("packages/ui/src/shared/budget-display.ts");
		expect(src.some((f) => f.startsWith("packages/claude-code-plugin/hooks/"))).toBe(true);
		const prose = proseFiles(REPO).map((f) => relPath(REPO, f));
		expect(prose).toContain("README.md");
		expect(prose).toContain("LIMITATIONS.md");
		expect(prose).toContain("packages/core/README.md");
		expect(prose.some((f) => f.startsWith("site/content/"))).toBe(true);
		expect(prose.some((f) => f.startsWith("docs/"))).toBe(true);
	});

	describe("positive control: the scanners see a planted hit", () => {
		it("finds a planted string, template, and JSX-text literal, not a comment or identifier", () => {
			const root = fixture({
				"packages/x/src/a.ts": [
					"// the governor in a comment is not text",
					"import { createGovernor } from './stream-governor.js';",
					"const GovernorOpts = createGovernor();",
					'export const a = "the governor refused";',
					"export const b = `tenant ${1} governor not ready`;",
				].join("\n"),
				"packages/x/src/b.tsx": "export const B = () => <p>ask the governor</p>;\n",
			});
			const found = checkLiterals(root, []);
			expect(found).toHaveLength(3);
			expect(found.filter((p) => p.startsWith("packages/x/src/a.ts:"))).toHaveLength(2);
			expect(found.filter((p) => p.startsWith("packages/x/src/b.tsx:"))).toHaveLength(1);
			expect(found.join("\n")).not.toContain("comment");
		});

		it("an allowlist entry covers exactly its literal and count, and goes stale loudly", () => {
			const root = fixture({
				"packages/x/src/a.ts": 'export const a = "Governor has been destroyed";',
			});
			const entry = {
				file: "packages/x/src/a.ts",
				literal: "Governor has been destroyed",
				count: 1,
				reason: "test",
			};
			expect(checkLiterals(root, [entry])).toEqual([]);
			expect(checkLiterals(root, [{ ...entry, count: 2 }])).toHaveLength(1);
			expect(checkLiterals(root, [{ ...entry, literal: "gone" }])).toHaveLength(2);
		});

		it("finds planted prose, and ignores fenced code, code spans and link targets", () => {
			const root = fixture({
				"README.md": [
					"The governor enforces the budget.",
					"Use `createGovernor()` and `a governor` freely.",
					"```ts",
					"const governor = createGovernor();",
					"```",
					"See [docs](https://example.com/governor).",
					"Several governors share one ledger.",
				].join("\n"),
				"site/content/docs/x.mdx": "---\ntitle: Governor setup\n---\n",
			});
			expect(checkProse(root)).toEqual([
				"README.md:1: The governor enforces the budget.",
				"README.md:7: Several governors share one ledger.",
				"site/content/docs/x.mdx:2: title: Governor setup",
			]);
		});

		it("reads a link's TITLE as text and only its destination as a path", () => {
			const root = fixture({
				"README.md": [
					'[Setup](/docs "Ask the governor")',
					"[Setup](/docs/governor)",
					"[Setup](</docs/governor> 'safe title')",
					"[Setup](/docs (the governors page))",
					'[ref]: /docs/governor "a governor title"',
					"[ref2]: /docs/governor",
				].join("\n"),
			});
			expect(checkProse(root)).toEqual([
				'README.md:1: [Setup](/docs "Ask the governor")',
				"README.md:4: [Setup](/docs (the governors page))",
				'README.md:5: [ref]: /docs/governor "a governor title"',
			]);
		});

		it("reads HTML entities the way a page renders them, in prose and in JSX text", () => {
			const root = fixture({
				"README.md": [
					"The govern&#111;r enforces it.",
					"The gover&#x6E;or enforces it.",
					"The gov&shy;ernor enforces it.",
					"The gov&zwnj;ernors enforce it.",
					"Terms &amp; conditions, AT&amp;T, &rsquo;quoted&rsquo;, &unknown; stay clean.",
					"A `govern&#111;r` code span is still code.",
				].join("\n"),
				"packages/x/src/a.tsx": [
					"export const A = () => <p>the govern&#111;r</p>;",
					"export const B = () => <p>gov&shy;ernor</p>;",
					'export const C = () => <p title="a govern&#111;r">x</p>;',
					"export const D = () => <p>Terms &amp; conditions&rsquo;</p>;",
					'export const E = "govern&#111;r";',
				].join("\n"),
			});
			expect(checkProse(root).map((p) => p.split(":")[1])).toEqual(["1", "2", "3", "4"]);
			const found = checkLiterals(root, []).map((p) => p.replace(/^.*?a\.tsx: /, ""));
			// A, B and the attribute are caught; D is clean; a plain JS string is NOT decoded (E).
			expect(found).toHaveLength(3);
			expect(visibleText("gover&#110;&#111;r")).toBe("governor");
		});
	});
});
