/**
 * minimatch is only ever called with its default options
 *
 * GHSA-g3hv-75wg-m249 (minimatch < 11.0.1) is an amplification in the pre-processing step that runs only
 * when `optimizationLevel >= 2`. minimatch's default level is lower, so a call that passes no options
 * object does not reach it. The package stays on that guarantee only while minimatch is imported as
 * `import { minimatch } from "minimatch"` and called as `minimatch(path, pattern)` with exactly two arguments:
 * no options object (literal, variable or spread), no `minimatch.defaults(...)` wrapper, no `Minimatch` class,
 * no alias, and no bare reference a caller could pass an options argument through. This file pins it:
 *
 *   1. a structural scan of every `packages/<name>/src` file for that one shape;
 *   2. a runtime check that the policy and scope code reach minimatch with exactly (path, pattern);
 *   3. mutants: the same scan, run on the real sources and on synthetic files in every other shape, must
 *      report each one.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { minimatch } from "minimatch";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPolicies, matchesScope } from "../../src/policy/gate.js";
import { fileMatchesScope, scopesOverlap } from "../../src/resilience/scope.js";

vi.mock("minimatch", async (importOriginal) => {
	const real = await importOriginal<typeof import("minimatch")>();
	return { ...real, minimatch: vi.fn(real.minimatch) };
});

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

interface Scan {
	/** One line per way the source could hand minimatch an options object. */
	violations: string[];
	/** Number of direct minimatch calls seen (the positive control: a scanner that sees none proves nothing). */
	sites: number;
}

/**
 * Parse the source and check it syntactically, so template interpolations, spreads and every import form
 * are seen as code. The only accepted shape is `import { minimatch } from "minimatch"` plus direct calls
 * `minimatch(a, b)` with exactly two non-spread arguments. Anything else that names minimatch, or names
 * `optimizationLevel`, is a violation.
 */
function scanMinimatchUses(source: string, file: string): Scan {
	const violations: string[] = [];
	let sites = 0;
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
	const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

	const acceptedImports = new Set<ts.Node>();
	const acceptedSpecifiers = new Set<ts.Node>();
	const acceptedLocal = new Set<ts.Node>();

	const visit = (node: ts.Node): void => {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.moduleSpecifier.text === "minimatch"
		) {
			const c = node.importClause;
			const nb = c?.namedBindings;
			const ok =
				c !== undefined &&
				!c.isTypeOnly &&
				c.name === undefined &&
				nb !== undefined &&
				ts.isNamedImports(nb) &&
				nb.elements.length === 1 &&
				!(nb.elements[0] as ts.ImportSpecifier).isTypeOnly &&
				(nb.elements[0] as ts.ImportSpecifier).propertyName === undefined &&
				(nb.elements[0] as ts.ImportSpecifier).name.text === "minimatch";
			if (ok) {
				acceptedImports.add(node);
				acceptedSpecifiers.add(node.moduleSpecifier);
				acceptedLocal.add((nb as ts.NamedImports).elements[0] as ts.ImportSpecifier);
			} else {
				violations.push(
					`${file}:${at(node)}: minimatch is imported other than as \`import { minimatch } from "minimatch"\``,
				);
			}
		}
		if (
			(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
			node.text === "minimatch" &&
			!acceptedSpecifiers.has(node)
		) {
			violations.push(
				`${file}:${at(node)}: the module name "minimatch" appears other than in the one accepted import`,
			);
		}
		if (
			(ts.isIdentifier(node) && node.text === "optimizationLevel") ||
			((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
				node.text === "optimizationLevel")
		) {
			violations.push(`${file}:${at(node)}: names optimizationLevel`);
		}
		if (ts.isIdentifier(node) && node.text === "minimatch") {
			const inAccepted = [...acceptedImports].some((i) => node.pos >= i.pos && node.end <= i.end);
			if (!inAccepted) {
				const parent = node.parent;
				if (ts.isCallExpression(parent) && parent.expression === node) {
					sites++;
					if (parent.arguments.length !== 2) {
						violations.push(
							`${file}:${at(node)}: minimatch called with ${parent.arguments.length} arguments (must be exactly 2)`,
						);
					}
					for (const arg of parent.arguments) {
						if (ts.isSpreadElement(arg))
							violations.push(`${file}:${at(arg)}: minimatch called with a spread argument`);
					}
				} else {
					violations.push(`${file}:${at(node)}: minimatch is used other than as a direct call`);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return { violations, sites };
}

// ---------------------------------------------------------------------------
// 1. Every shipped source file
// ---------------------------------------------------------------------------

const here = fileURLToPath(new URL(".", import.meta.url));
const packagesDir = join(here, "..", "..", "..");

function sourceFiles(): string[] {
	const out: string[] = [];
	for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		const src = join(packagesDir, pkg.name, "src");
		let entries: string[];
		try {
			entries = readdirSync(src, { recursive: true, encoding: "utf8" });
		} catch {
			continue;
		}
		for (const e of entries) if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e)) out.push(join(src, e));
	}
	return out.sort();
}

describe("no source file hands minimatch an options object", () => {
	const files = sourceFiles();

	it("finds the source tree and the known call sites (positive control)", () => {
		expect(files.length).toBeGreaterThan(20);
		const total = files.reduce(
			(n, f) => n + scanMinimatchUses(readFileSync(f, "utf8"), f).sites,
			0,
		);
		// gate.ts: matchesScope + the load-time probe; scope.ts: scopesOverlap (two) + fileMatchesScope
		expect(total).toBeGreaterThanOrEqual(5);
	});

	it("every minimatch call in packages/*/src is (path, pattern) and optimizationLevel is never named", () => {
		const bad = files.flatMap(
			(f) => scanMinimatchUses(readFileSync(f, "utf8"), relative(packagesDir, f)).violations,
		);
		expect(bad).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2. At run time, the policy and scope code call it with exactly two arguments
// ---------------------------------------------------------------------------

describe("the scope code reaches minimatch with its default options", () => {
	beforeEach(() => {
		vi.mocked(minimatch).mockClear();
	});

	it("matchesScope, scopesOverlap, fileMatchesScope and the policy-load probe pass (path, pattern) only", () => {
		const dir = mkdtempSync(join(tmpdir(), "usertrust-mm-default-"));
		const p = join(dir, "policy.yaml");
		writeFileSync(
			p,
			`rules:
  - name: scoped
    effect: deny
    enforcement: hard
    conditions:
      - field: model
        operator: contains
        value: opus
    scopePatterns:
      - "src/**"
`,
		);
		expect(matchesScope(["src/**"], ["src/a.ts"])).toBe(true);
		expect(scopesOverlap(["src/**"], ["src/a/**"])).toBe(true);
		expect(scopesOverlap(["src/a/"], ["src/**/x"])).toBe(true);
		expect(fileMatchesScope("src/a.ts", ["src/**"])).toBe(true);
		expect(loadPolicies(p)).toHaveLength(1);

		const calls = vi.mocked(minimatch).mock.calls;
		// matchesScope 1, scopesOverlap >= 2 + 2, fileMatchesScope 1, load probe 1
		expect(calls.length).toBeGreaterThanOrEqual(6);
		for (const args of calls) expect(args, JSON.stringify(args)).toHaveLength(2);
		expect(calls.some((a) => a[0] === "probe")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 3. Mutants: the scan must refuse every other way to import or call minimatch
// ---------------------------------------------------------------------------

const gateSrc = readFileSync(join(packagesDir, "core", "src", "policy", "gate.ts"), "utf8");
const scopeSrc = readFileSync(join(packagesDir, "core", "src", "resilience", "scope.ts"), "utf8");

function mutate(source: string, from: string, to: string): string {
	expect(source.split(from).length - 1, `anchor ${from}`).toBe(1);
	return source.replace(from, to);
}

describe("mutants: an options argument anywhere makes the scan report it", () => {
	it("the unmodified sources are clean (control)", () => {
		expect(scanMinimatchUses(gateSrc, "gate.ts").violations).toEqual([]);
		expect(scanMinimatchUses(scopeSrc, "scope.ts").violations).toEqual([]);
	});

	const mutants: Array<[string, string, string, string]> = [
		[
			"matchesScope passes optimizationLevel 2",
			"gate",
			"minimatch(scope, pattern)",
			"minimatch(scope, pattern, { optimizationLevel: 2 })",
		],
		[
			"the load probe passes an options object",
			"gate",
			'minimatch("probe", p)',
			'minimatch("probe", p, { dot: true })',
		],
		[
			"scopesOverlap passes an options variable",
			"scope",
			"minimatch(patternA, patternB)",
			"minimatch(patternA, patternB, opts)",
		],
		[
			"fileMatchesScope passes a spread options object",
			"scope",
			"minimatch(file, pattern)",
			"minimatch(file, pattern, { ...opts })",
		],
		[
			"matchesScope hands the function to .some",
			"gate",
			"patterns.some((pattern) => minimatch(scope, pattern))",
			"patterns.some(minimatch.bind(null, scope))",
		],
	];
	for (const [name, which, from, to] of mutants) {
		it(name, () => {
			const src = which === "gate" ? gateSrc : scopeSrc;
			const mutated = mutate(src, from, to);
			expect(scanMinimatchUses(mutated, `${which}.ts`).violations.length).toBeGreaterThan(0);
		});
	}

	it("optimizationLevel named anywhere in code is reported, even away from a call", () => {
		const mutated = `${gateSrc}\nconst tuning = { optimizationLevel: 2 };\n`;
		expect(scanMinimatchUses(mutated, "gate.ts").violations.join("\n")).toMatch(
			/optimizationLevel/,
		);
	});

	it("a comment that mentions optimizationLevel or an options call is not a violation", () => {
		const commented = `${scopeSrc}\n// minimatch(a, b, { optimizationLevel: 2 })\n/* optimizationLevel */\n`;
		expect(scanMinimatchUses(commented, "scope.ts").violations).toEqual([]);
	});

	const synthetic: Array<[string, string]> = [
		[
			"an aliased import",
			'import { minimatch as mm } from "minimatch";\nexport const f = (a: string, b: string) => mm(a, b);\n',
		],
		[
			"minimatch.defaults wrapping optimizationLevel",
			'import { minimatch } from "minimatch";\nconst mm = minimatch.defaults({ optimizationLevel: 2 });\nexport const f = (a: string, b: string) => mm(a, b);\n',
		],
		[
			"minimatch.defaults with options held in a variable",
			'import { minimatch } from "minimatch";\nconst o = { dot: true };\nexport const mm = minimatch.defaults(o);\n',
		],
		[
			"a Minimatch instance built with options",
			'import { Minimatch } from "minimatch";\nexport const m = new Minimatch("a/**", { optimizationLevel: 2 });\n',
		],
		[
			"a Minimatch instance built with an options variable",
			'import { Minimatch } from "minimatch";\nconst o = {};\nexport const m = new Minimatch("a/**", o);\n',
		],
		[
			"options passed through a variable",
			'import { minimatch } from "minimatch";\nconst o = { dot: true };\nexport const f = (a: string, b: string) => minimatch(a, b, o);\n',
		],
		[
			"options passed through a spread",
			'import { minimatch } from "minimatch";\nconst o = { dot: true };\nexport const f = (a: string, b: string) => minimatch(a, b, { ...o });\n',
		],
		[
			"arguments passed through a spread",
			'import { minimatch } from "minimatch";\nconst args: [string, string] = ["a", "b"];\nexport const f = () => minimatch(...args);\n',
		],
		[
			"a namespace import calling match with options",
			'import * as mm from "minimatch";\nexport const f = (l: string[]) => mm.match(l, "a", { dot: true });\n',
		],
		[
			"a default import used as a bare value",
			'import minimatch from "minimatch";\nexport const g = [1].map(minimatch);\n',
		],
		[
			"a named import used as a bare value",
			'import { minimatch } from "minimatch";\nexport const g = ["a"].filter(minimatch);\n',
		],
		[
			"a require() call",
			'const { minimatch } = require("minimatch");\nexport const f = (a: string) => minimatch(a, "x");\n',
		],
		[
			"a dynamic import()",
			'export const f = async () => (await import("minimatch")).minimatch("a", "b");\n',
		],
		["a re-export", 'export { minimatch } from "minimatch";\n'],
		[
			"a spread beside an ordinary argument",
			'import { minimatch } from "minimatch";\nconst o = { dot: true };\nexport const f = (a: string) => minimatch(a, ...([o] as const));\n',
		],
		[
			"a call with options inside a template-literal interpolation",
			'import { minimatch } from "minimatch";\nexport const f = (a: string, b: string) => `${minimatch(a, b, { optimizationLevel: 2 })}`;\n',
		],
		[
			"a call with an options variable inside a nested template interpolation",
			'import { minimatch } from "minimatch";\nexport const f = (a: string, b: string, o: object) => `x${`y${minimatch(a, b, o)}`}`;\n',
		],
		[
			"a type-only import",
			'import type { minimatch } from "minimatch";\nexport type T = typeof minimatch;\n',
		],
	];
	for (const [name, src] of synthetic) {
		it(`${name} is reported`, () => {
			expect(scanMinimatchUses(src, "synthetic.ts").violations.length).toBeGreaterThan(0);
		});
	}

	it("the one accepted shape is accepted (control)", () => {
		const ok =
			'import { minimatch } from "minimatch";\nexport const f = (a: string, b: string) => minimatch(a, b);\nexport const g = () => minimatch("probe", "p");\n';
		const r = scanMinimatchUses(ok, "ok.ts");
		expect(r.violations).toEqual([]);
		expect(r.sites).toBe(2);
	});
});
