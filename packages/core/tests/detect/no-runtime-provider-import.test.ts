// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Client detection is duck-typed (AGENTS.md, "Client detection"): no source file under
 * `packages/<pkg>/src` may load a provider SDK at runtime. One exception, and only one: the Google
 * request pipeline (`packages/core/src/google-request.ts`) loads the installed `@google/genai`'s
 * `Models` class, through a variable specifier, to build the exact request the SDK sends.
 *
 * The scanner reads each file's syntax tree, so a type-only import, a comment or a longer string
 * that merely mentions a package (an error message naming `@google/genai`) is not a reference.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PROVIDERS = ["@anthropic-ai/sdk", "openai", "@google/genai"] as const;

/** Is `text` a provider SDK specifier: a package name, or a subpath of one (`<pkg>/<path>`)? */
function isProviderSpecifier(text: string): boolean {
	return PROVIDERS.some((pkg) => text === pkg || text.startsWith(`${pkg}/`));
}

/**
 * The same, for a string that is not in a module position. A bare `"openai"` is also the provider
 * KIND throughout the source (`kind === "openai"`), so it counts only where it is loaded (an import,
 * an export, `import()`, `require()`, or a variable either of those loads); every other provider
 * specifier counts wherever a string or template literal holds exactly it.
 */
function isUnambiguousSpecifier(text: string): boolean {
	return isProviderSpecifier(text) && text !== "openai";
}

interface Hit {
	file: string;
	line: number;
	spec: string;
	how: string;
}

function literalText(node: ts.Node | undefined): string | undefined {
	if (node === undefined) return undefined;
	return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
		? node.text
		: undefined;
}

/** Every runtime reference to a provider SDK specifier in one source file. */
function scanSource(file: string, text: string): Hit[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const hits: Hit[] = [];
	const at = (node: ts.Node, spec: string, how: string): void => {
		const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
		hits.push({ file, line, spec, how });
	};
	/** A file-level or local `const`/`let`/`var` holding a literal: what a dynamic load names. */
	const literals = new Map<string, string>();
	const collect = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			const value = literalText(node.initializer);
			if (value !== undefined) literals.set(node.name.text, value);
		}
		ts.forEachChild(node, collect);
	};
	collect(source);
	/** Literals already reported in a module position, not to be reported again as a value. */
	const placed = new Set<ts.Node>();

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			placed.add(node.moduleSpecifier);
			const spec = literalText(node.moduleSpecifier);
			if (
				spec !== undefined &&
				isProviderSpecifier(spec) &&
				node.importClause?.isTypeOnly !== true
			) {
				at(node, spec, "import");
			}
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
			placed.add(node.moduleSpecifier);
			const spec = literalText(node.moduleSpecifier);
			if (spec !== undefined && isProviderSpecifier(spec) && !node.isTypeOnly) {
				at(node, spec, "export");
			}
		} else if (ts.isImportTypeNode(node)) {
			// `typeof import("x")` and `import("x").T`: types only, nothing loaded.
			const argument = node.argument;
			if (ts.isLiteralTypeNode(argument)) placed.add(argument.literal);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require"))
		) {
			const how = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import()" : "require()";
			const argument = node.arguments[0];
			const spec = literalText(argument);
			if (argument !== undefined) placed.add(argument);
			if (spec !== undefined) {
				if (isProviderSpecifier(spec)) at(node, spec, how);
			} else if (argument !== undefined && ts.isIdentifier(argument)) {
				const value = literals.get(argument.text);
				if (value === undefined) at(node, `<${argument.text}>`, `${how} of an unresolved variable`);
				else if (isProviderSpecifier(value)) at(node, value, `${how} of a variable`);
			} else if (argument !== undefined) {
				at(node, "<expression>", `${how} of an expression`);
			}
		} else if (
			(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
			!placed.has(node) &&
			isUnambiguousSpecifier(node.text)
		) {
			at(node, node.text, "a literal holding a specifier");
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return hits;
}

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

/** Every source file under `packages/<pkg>/src`. */
function sourceFiles(): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
				files.push(path);
			}
		}
	};
	for (const pkg of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		const src = join(repoRoot, "packages", pkg.name, "src");
		try {
			if (readdirSync(src).length > 0) walk(src);
		} catch {
			// a package without a src directory
		}
	}
	return files;
}

/** The one allowed site: google-request.ts loading the installed `@google/genai` by a variable. */
const ALLOWED_FILE = "packages/core/src/google-request.ts";
const isAllowed = (hit: Hit): boolean => hit.file === ALLOWED_FILE && hit.spec === "@google/genai";

describe("no source file loads a provider SDK at runtime, but the Google request pipeline", () => {
	describe("the scanner catches every form (planted fixtures)", () => {
		const caught: Array<[string, string]> = [
			["a static value import", 'import OpenAI from "openai";'],
			["a named value import", 'import { Models } from "@google/genai";'],
			["a side-effect import", 'import "@anthropic-ai/sdk";'],
			["export * from", 'export * from "openai";'],
			["export { x } from", 'export { GoogleGenAI } from "@google/genai";'],
			["import() of a literal", 'const m = await import("openai");'],
			["require() of a literal", 'const m = require("@anthropic-ai/sdk");'],
			["import() of a variable", 'const s = "openai"; const m = await import(s);'],
			[
				"a variable specifier",
				'const specifier = "@google/genai"; const m = await import(specifier);',
			],
			["a template-literal specifier", "const m = await import(`@anthropic-ai/sdk`);"],
			["a template literal held in a variable", "const s = `@google/genai`;"],
			["a subpath", 'import { x } from "openai/resources/chat";'],
			["a scoped subpath in a string", 'const s = "@anthropic-ai/sdk/resources/messages";'],
			["import() of an unresolved variable", "const m = await import(name);"],
		];
		for (const [form, text] of caught) {
			it(`${form} is caught`, () => {
				expect(scanSource("fixture.ts", text).length).toBeGreaterThan(0);
			});
		}

		const ignored: Array<[string, string]> = [
			["a type-only import", 'import type { ClientOptions } from "openai";'],
			["a type-only export", 'export type { Models } from "@google/genai";'],
			["an import type in a type", 'type T = typeof import("@google/genai");'],
			["the provider kind", 'const ok = kind === "openai";'],
			[
				"a message that mentions a package",
				'throw new Error("install @google/genai next to usertrust");',
			],
			["a comment", '// import OpenAI from "openai"\nconst x = 1;'],
			["another package", 'import { x } from "openai-compat";'],
			["a relative import", 'import { x } from "./openai.js";'],
		];
		for (const [form, text] of ignored) {
			it(`${form} is not a runtime reference`, () => {
				expect(scanSource("fixture.ts", text)).toEqual([]);
			});
		}
	});

	it("the source tree holds no runtime provider reference outside the one allowed site", () => {
		const files = sourceFiles();
		// the walk reaches the source: every package's src, the allowed site among it
		expect(files.length).toBeGreaterThan(100);
		expect(files.map((path) => relative(repoRoot, path).split("\\").join("/"))).toContain(
			ALLOWED_FILE,
		);
		const hits = files.flatMap((path) =>
			scanSource(relative(repoRoot, path).split("\\").join("/"), readFileSync(path, "utf8")),
		);
		// the scan reaches the allowed site, and nothing else
		expect(hits.filter(isAllowed)).toHaveLength(2);
		expect(hits.filter((hit) => !isAllowed(hit))).toEqual([]);
	});

	it("the allowed site still exists, exactly as allowed: one specifier and the import() that loads it", () => {
		const path = join(repoRoot, ALLOWED_FILE);
		const hits = scanSource(ALLOWED_FILE, readFileSync(path, "utf8")).filter(isAllowed);
		expect(hits.map((hit) => hit.how).sort()).toEqual([
			"a literal holding a specifier",
			"import() of a variable",
		]);
	});
});
