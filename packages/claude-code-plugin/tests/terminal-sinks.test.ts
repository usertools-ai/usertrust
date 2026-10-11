import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const HOOKS = join(import.meta.dirname, "..", "hooks");

/**
 * Where a hook may write to a terminal sink. Everything else goes through these:
 * `say` (stderr, lib.mjs) and `announce` (the SessionStart `systemMessage`,
 * lib.mjs) sanitize C0/DEL/C1 and then clip; `deny` writes PreToolUse's one
 * decision JSON, whose reason it sanitizes the same way.
 */
const ALLOWED: Record<string, Array<{ file: string; fn: string }>> = {
	"process.stderr.write": [{ file: "lib.mjs", fn: "say" }],
	"process.stdout.write": [
		{ file: "lib.mjs", fn: "announce" },
		{ file: "pre-tool-use.mjs", fn: "deny" },
	],
	systemMessage: [{ file: "lib.mjs", fn: "announce" }],
};

interface Sink {
	file: string;
	line: number;
	sink: string;
	fn: string | null;
}

/** The name of the function a node sits in, or null at module level. */
function enclosingFunction(node: ts.Node): string | null {
	for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
		if ((ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at)) && at.name) {
			return at.name.text;
		}
	}
	return null;
}

/**
 * Every terminal sink in one source text, from its syntax tree (so comments and
 * string contents never count): calls of `process.stderr.write`,
 * `process.stdout.write` and any `console.*`, and every `systemMessage` key or
 * property.
 */
function sinksIn(file: string, text: string): Sink[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const found: Sink[] = [];
	const at = (node: ts.Node) =>
		source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression.getText(source);
			if (/^process\.(stderr|stdout)\.write$/.test(callee) || /^console\.\w+$/.test(callee)) {
				found.push({ file, line: at(node), sink: callee, fn: enclosingFunction(node) });
			}
		}
		if (ts.isIdentifier(node) && node.text === "systemMessage") {
			found.push({ file, line: at(node), sink: "systemMessage", fn: enclosingFunction(node) });
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/** The sinks no allowance covers: each one a raw write to a terminal. */
function rawSinks(sinks: Sink[]): Sink[] {
	return sinks.filter(
		(s) =>
			!(ALLOWED[s.sink] ?? []).some((allowed) => allowed.file === s.file && allowed.fn === s.fn),
	);
}

const hookSinks = () =>
	readdirSync(HOOKS)
		.filter((name) => name.endsWith(".mjs"))
		.flatMap((name) => sinksIn(name, readFileSync(join(HOOKS, name), "utf-8")));

describe("terminal sinks: one sanitizing writer, and nothing else writes", () => {
	it("no hook writes to stderr, stdout or a systemMessage except through say / announce / deny", () => {
		const raw = rawSinks(hookSinks());
		expect(raw.map((s) => `${s.file}:${s.line} ${s.sink} in ${s.fn ?? "module scope"}`)).toEqual(
			[],
		);
	});

	it("the allowances are not vacuous: say, announce and deny each hold their one sink", () => {
		const sinks = hookSinks();
		const held = (file: string, fn: string, sink: string) =>
			sinks.filter((s) => s.file === file && s.fn === fn && s.sink === sink).length;
		expect(held("lib.mjs", "say", "process.stderr.write")).toBe(1);
		expect(held("lib.mjs", "announce", "process.stdout.write")).toBe(1);
		expect(held("lib.mjs", "announce", "systemMessage")).toBe(1);
		expect(held("pre-tool-use.mjs", "deny", "process.stdout.write")).toBe(1);
	});

	it("positive control: a raw write injected anywhere makes the guard fire", () => {
		// What a careless edit would add, in a hook file and in lib.mjs outside the writer.
		const injected = [
			"function settle() {",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the injected source's own template literal
			"\tprocess.stderr.write(`usertrust: settle ${id} failed\\n`);",
			'\tconsole.error("usertrust:", reason);',
			"}",
			"// process.stderr.write( in a comment is not a sink",
			'const note = "process.stderr.write( in a string is not a sink";',
			"process.stdout.write(JSON.stringify({ systemMessage: text }));",
		].join("\n");
		const raw = rawSinks([
			...sinksIn("post-tool-use.mjs", injected),
			...sinksIn("lib.mjs", injected),
		]);
		expect(raw.map((s) => `${s.file}:${s.line} ${s.sink}`)).toEqual([
			"post-tool-use.mjs:2 process.stderr.write",
			"post-tool-use.mjs:3 console.error",
			"post-tool-use.mjs:7 process.stdout.write",
			"post-tool-use.mjs:7 systemMessage",
			"lib.mjs:2 process.stderr.write",
			"lib.mjs:3 console.error",
			"lib.mjs:7 process.stdout.write",
			"lib.mjs:7 systemMessage",
		]);
	});
});
