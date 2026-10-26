// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Wall-clock thresholds in tests, with a ratchet.
 *
 * A test that sleeps for real, compares elapsed time, or sets its own timeout passes on the
 * machine it was written on and then fails on a slower or busier one: a 20 ms sleep racing a
 * timer, a ratio bound of 3 that a linear scan reads 3.9 against, a 30 s describe timeout a
 * loaded runner takes 38 s to meet. Each was reviewed and passed CI when it landed. The only time
 * anyone knows a threshold's headroom is when they write it, so this script makes the author say
 * so then.
 *
 * Every test file (`tests/` directories and `*.test.*` files) is parsed, and three shapes are
 * found:
 *  - sleep:   `setTimeout`/`setInterval` with a delay other than 0 (a real wait);
 *  - clock:   `performance.now()`, `process.hrtime`, or `Date.now()` in arithmetic or a
 *             comparison (an elapsed time, or a deadline);
 *  - timeout: a numeric `timeout`/`testTimeout`/`hookTimeout`, or a number as the last argument
 *             of `it`/`test`/`describe` or a hook (a time budget).
 * A hit is accepted when:
 *  - the file fakes the timer it uses: `vi.useFakeTimers` called at the top level of the file, or in
 *    a top-level `beforeEach`/`beforeAll`, with no `toFake` or a `toFake` that names the hit's
 *    API (`setTimeout` or `setInterval` for a sleep, `Date` for `Date.now()`). A fake inside one
 *    test or `describe` accepts nothing, and neither does a `toFake` that is not a literal list,
 *    nor any fake in a file that calls `useRealTimers` anywhere but a top-level `afterEach`/`afterAll`:
 *    the scan does not follow which tests a fake covers, so it counts those hits. `performance.now`,
 *    `process.hrtime` and timeouts are never accepted by a fake; or
 *  - a `timing:` comment on its line, or in the comment lines directly above it, states the
 *    bound and the headroom measured on CI (it must contain a number), e.g.
 *    `// timing: 30 s budget; CI's slowest of 20 runs took 9 s`.
 * Every other hit is counted in `timing-thresholds.baseline.json`, keyed by file and shape
 * (never by line), which only ever shrinks: a new key or a count that grew fails, and a count
 * that fell fails until the baseline is tightened, as in `typecheck-tests.mts`. A baseline checked
 * only against itself is not shrink-only (a change can add a threshold and `--update` together),
 * so `--base <rev>` also fails when a shape's total in the baseline grew from that revision's:
 * totals, so that renaming a test file, which moves its keys, does not fail.
 *
 *   tsx scripts/timing-thresholds.mts               # check against the baseline
 *   tsx scripts/timing-thresholds.mts --base HEAD^1 # and the baseline against the base's
 *   tsx scripts/timing-thresholds.mts --update      # rewrite the baseline to the current hits
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { type Counts, compare, failed } from "./typecheck-tests.mts";

export type Shape = "sleep" | "clock" | "timeout";

export interface Hit {
	file: string;
	line: number;
	shape: Shape;
	/** Accepted by fake timers or a `timing:` annotation; not counted. */
	accepted: boolean;
}

/** A test file: under a `tests/` directory, or named `*.test.*`. */
export const TEST_FILE = /(^|\/)tests\/.*\.[cm]?[jt]sx?$|\.test\.[cm]?[jt]sx?$/;

const TEST_CALLS = new Set([
	"it",
	"test",
	"describe",
	"suite",
	"bench",
	"beforeAll",
	"beforeEach",
	"afterAll",
	"afterEach",
]);
const TIMEOUT_KEYS = new Set(["timeout", "testTimeout", "hookTimeout"]);
const COMPARISONS = new Set([
	ts.SyntaxKind.LessThanToken,
	ts.SyntaxKind.LessThanEqualsToken,
	ts.SyntaxKind.GreaterThanToken,
	ts.SyntaxKind.GreaterThanEqualsToken,
]);

/** `a.b.c` as a string, or undefined for anything that is not a plain name chain. */
function dotted(e: ts.Expression): string | undefined {
	if (ts.isIdentifier(e)) return e.text;
	if (ts.isPropertyAccessExpression(e)) {
		const left = dotted(e.expression);
		return left === undefined ? undefined : `${left}.${e.name.text}`;
	}
	return undefined;
}

/** The leftmost name of a callee: `it` for `it.skip.each(rows)`. */
function root(e: ts.Expression): string | undefined {
	if (ts.isIdentifier(e)) return e.text;
	if (ts.isPropertyAccessExpression(e)) return root(e.expression);
	if (ts.isCallExpression(e)) return root(e.expression);
	return undefined;
}

/** A number written in the source: `30_000`, `5 * 1000`, `(2000)`. */
function numeric(e: ts.Expression): boolean {
	if (ts.isNumericLiteral(e)) return true;
	if (ts.isParenthesizedExpression(e)) return numeric(e.expression);
	if (ts.isBinaryExpression(e)) return numeric(e.left) && numeric(e.right);
	return false;
}

function isZero(e: ts.Expression): boolean {
	return ts.isNumericLiteral(e) && Number(e.text.replaceAll("_", "")) === 0;
}

/**
 * A sleep: a timer call with a delay other than 0, including `timers/promises`' `setTimeout(ms)`.
 * The timer's name, or undefined for anything else.
 */
function sleeps(call: ts.CallExpression): "setTimeout" | "setInterval" | undefined {
	const name = dotted(call.expression);
	if (name === undefined) return undefined;
	const timer = name.replace(/^(globalThis|global|window)\./, "");
	if (timer !== "setTimeout" && timer !== "setInterval") return undefined;
	const [first, delay] = call.arguments;
	const waits = (): boolean => {
		if (delay !== undefined) return !isZero(delay);
		// One argument: the global timer's callback (delay 0), or `timers/promises`' delay.
		if (first === undefined) return false;
		if (numeric(first)) return !isZero(first);
		return ts.isIdentifier(first) && /ms$|millis|delay|wait|timeout|duration/i.test(first.text);
	};
	return waits() ? timer : undefined;
}

const FUNCTION_KINDS = new Set([
	ts.SyntaxKind.ArrowFunction,
	ts.SyntaxKind.FunctionExpression,
	ts.SyntaxKind.FunctionDeclaration,
	ts.SyntaxKind.MethodDeclaration,
	ts.SyntaxKind.Constructor,
	ts.SyntaxKind.GetAccessor,
	ts.SyntaxKind.SetAccessor,
]);

/** The functions a node sits inside, innermost first. */
function enclosingFunctions(node: ts.Node): ts.Node[] {
	const out: ts.Node[] = [];
	for (let p = node.parent; p !== undefined; p = p.parent)
		if (FUNCTION_KINDS.has(p.kind)) out.push(p);
	return out;
}

/** Whether a call sits directly in the callback of a top-level hook named in `hooks`. */
function inTopLevelHook(call: ts.CallExpression, hooks: string[]): boolean {
	const fns = enclosingFunctions(call);
	// One function, the callback of a hook that is itself in no function: a top-level hook.
	if (fns.length !== 1) return false;
	const hook = (fns[0] as ts.Node).parent;
	if (hook === undefined || !ts.isCallExpression(hook)) return false;
	const name = dotted(hook.expression);
	return name !== undefined && hooks.includes(name);
}

/**
 * Whether a fake-timer call covers the whole file: at its top level, or directly in the callback of
 * a top-level `beforeEach`/`beforeAll`. Anywhere else (one test, one `describe`, a helper) it may
 * cover only some of the file's tests.
 */
function fileLevel(call: ts.CallExpression): boolean {
	return enclosingFunctions(call).length === 0 || inTopLevelHook(call, ["beforeEach", "beforeAll"]);
}

/**
 * Whether a real-timer call only undoes the fake after the tests: directly in a top-level
 * `afterEach`/`afterAll`. Anywhere else it may give some tests real timers again.
 */
function restoresAfter(call: ts.CallExpression): boolean {
	return inTopLevelHook(call, ["afterEach", "afterAll"]);
}

/**
 * What a fake-timer call fakes: null for everything (no options, or no `toFake`), else the names in
 * its literal `toFake` list. Options that are not literal fake nothing here, so their hits count.
 */
function faked(call: ts.CallExpression): Set<string> | null {
	const [options] = call.arguments;
	if (options === undefined) return null;
	if (!ts.isObjectLiteralExpression(options)) return new Set();
	let list: ts.Expression | undefined;
	for (const p of options.properties) {
		if (ts.isSpreadAssignment(p)) return new Set();
		if (
			ts.isPropertyAssignment(p) &&
			(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
			p.name.text === "toFake"
		)
			list = p.initializer;
		else if (ts.isShorthandPropertyAssignment(p) && p.name.text === "toFake") return new Set();
	}
	if (list === undefined) return null;
	if (!ts.isArrayLiteralExpression(list)) return new Set();
	const names = new Set<string>();
	for (const e of list.elements) {
		if (!ts.isStringLiteralLike(e)) return new Set();
		names.add(e.text);
	}
	return names;
}

/**
 * `Date.now()` measuring time: compared (`Date.now() < deadline`), or less a start
 * (`Date.now() - started`). `Date.now() - agoMs` is a timestamp, not a measurement.
 */
function measures(now: ts.CallExpression): boolean {
	const parent = now.parent;
	if (!ts.isBinaryExpression(parent)) return false;
	if (COMPARISONS.has(parent.operatorToken.kind)) return true;
	return (
		parent.operatorToken.kind === ts.SyntaxKind.MinusToken &&
		parent.left === now &&
		ts.isIdentifier(parent.right) &&
		/^(t0|start|begin|before|since)|(start|started|begin|began|before)$/i.test(parent.right.text)
	);
}

/** Is the `timing:` annotation on this line, or in the comment lines directly above it? */
function annotated(lines: string[], line: number): boolean {
	const has = (text: string): boolean => /timing:.*\d/.test(text);
	const at = lines[line] ?? "";
	const comment = at.indexOf("//");
	if (comment >= 0 && has(at.slice(comment))) return true;
	for (let i = line - 1; i >= 0; i--) {
		const text = (lines[i] ?? "").trim();
		if (!/^(\/\/|\/\*|\*)/.test(text)) return false;
		if (has(text)) return true;
	}
	return false;
}

/**
 * Every wall-clock threshold in one file's source. Lines are 1-based. The parser follows the
 * file's extension (a `.ts` file read as TSX takes `<T>(x: T) =>` for JSX and loses what
 * follows), and a file that does not parse throws rather than reporting nothing.
 */
export function scan(file: string, source: string): Hit[] {
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const errors = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
	if (errors.length > 0) {
		const first = errors[0] as ts.Diagnostic;
		const line = sf.getLineAndCharacterOfPosition(first.start ?? 0).line + 1;
		throw new Error(
			`${file}:${line}: does not parse (${ts.flattenDiagnosticMessageText(first.messageText, " ")})`,
		);
	}
	const lines = source.split("\n");
	// `api` is what a fake must cover to accept the hit: the timer for a sleep, `Date` for Date.now.
	const found: Array<{ node: ts.Node; shape: Shape; api?: string }> = [];
	// What every file-level fake covers (null: everything), or undefined with no file-level fake.
	// Two file-level fakes cover what both do.
	let fakes: Set<string> | null | undefined;
	// Real timers again anywhere but after the tests: no fake covers the whole file.
	let realAgain = false;
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const name = dotted(node.expression);
			if ((name === "vi.useFakeTimers" || name === "jest.useFakeTimers") && fileLevel(node)) {
				const these = faked(node);
				if (fakes === undefined || fakes === null) fakes = these;
				else if (these !== null) fakes = new Set([...fakes].filter((n) => these.has(n)));
			}
			if ((name === "vi.useRealTimers" || name === "jest.useRealTimers") && !restoresAfter(node))
				realAgain = true;
			const timer = sleeps(node);
			if (timer !== undefined) found.push({ node, shape: "sleep", api: timer });
			if (
				name === "performance.now" ||
				name === "process.hrtime" ||
				name === "process.hrtime.bigint"
			)
				found.push({ node, shape: "clock" });
			if (name === "Date.now" && measures(node)) found.push({ node, shape: "clock", api: "Date" });
			const callee = root(node.expression);
			const last = node.arguments[node.arguments.length - 1];
			if (
				callee !== undefined &&
				TEST_CALLS.has(callee) &&
				node.arguments.length >= 2 &&
				last !== undefined &&
				numeric(last)
			)
				found.push({ node: last, shape: "timeout" });
		}
		if (
			ts.isPropertyAssignment(node) &&
			(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
			TIMEOUT_KEYS.has(node.name.text) &&
			numeric(node.initializer)
		)
			found.push({ node, shape: "timeout" });
		ts.forEachChild(node, visit);
	};
	visit(sf);
	const covers = (api: string | undefined): boolean =>
		api !== undefined && !realAgain && fakes !== undefined && (fakes === null || fakes.has(api));
	return found.map(({ node, shape, api }) => {
		const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
		const byFakeClock = covers(api);
		return { file, line: line + 1, shape, accepted: byFakeClock || annotated(lines, line) };
	});
}

/** The hits nothing accepts, counted per `<file> <shape>`. */
export function count(hits: Hit[]): Counts {
	const counts: Counts = {};
	for (const h of hits) {
		if (h.accepted) continue;
		const key = `${h.file} ${h.shape}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

/** A baseline's hits per shape. */
export function totals(c: Counts): Record<Shape, number> {
	const t: Record<Shape, number> = { sleep: 0, clock: 0, timeout: 0 };
	for (const [key, n] of Object.entries(c)) {
		const shape = key.slice(key.lastIndexOf(" ") + 1) as Shape;
		if (shape in t) t[shape] += n;
	}
	return t;
}

/** The shapes whose baseline total grew from the base revision's. */
export function grewFrom(
	base: Counts,
	head: Counts,
): Array<{ shape: Shape; base: number; now: number }> {
	const b = totals(base);
	const h = totals(head);
	return (Object.keys(h) as Shape[])
		.filter((shape) => h[shape] > b[shape])
		.map((shape) => ({ shape, base: b[shape], now: h[shape] }));
}

function sorted(c: Counts): Counts {
	return Object.fromEntries(Object.entries(c).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function main(): number {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const baselinePath = join(root, "timing-thresholds.baseline.json");
	const ls = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf-8" });
	if (ls.status !== 0) {
		console.error(`timing-thresholds: git ls-files exited ${ls.status}: ${ls.stderr}`);
		return 1;
	}
	const files = ls.stdout.split("\0").filter((f) => TEST_FILE.test(f));
	if (files.length === 0) {
		console.error("timing-thresholds: no test files found: it did not run");
		return 1;
	}
	const hits = files.flatMap((f) => scan(f, readFileSync(join(root, f), "utf-8")));
	const counts = count(hits);
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	const accepted = hits.filter((h) => h.accepted).length;
	if (process.argv.includes("--update")) {
		writeFileSync(baselinePath, `${JSON.stringify(sorted(counts), null, "\t")}\n`);
		console.log(
			`timing-thresholds: baseline written: ${total} hit(s) in ${Object.keys(counts).length} key(s)`,
		);
		return 0;
	}
	const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as Counts;
	const baseAt = process.argv.indexOf("--base");
	if (baseAt >= 0) {
		const rev = process.argv[baseAt + 1];
		if (rev === undefined) {
			console.error("timing-thresholds: --base needs a revision");
			return 2;
		}
		const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf-8" });
		// A revision that does not resolve (unfetched, or misspelt) fails: read as "no baseline yet",
		// it would skip the comparison and pass.
		const commit = git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
		if (commit.status !== 0) {
			console.error(`timing-thresholds: --base ${rev} is not a commit in this checkout`);
			return 2;
		}
		const at = `${commit.stdout.trim()}:timing-thresholds.baseline.json`;
		const atBase = git(["show", at]);
		if (git(["cat-file", "-e", at]).status !== 0) {
			console.log(`timing-thresholds: ${rev} has no baseline yet; nothing to compare it with`);
		} else if (atBase.status !== 0) {
			console.error(`timing-thresholds: git show ${at} exited ${atBase.status}: ${atBase.stderr}`);
			return 2;
		} else {
			const grew = grewFrom(JSON.parse(atBase.stdout) as Counts, baseline);
			for (const g of grew)
				console.error(`  baseline grew from ${rev}: ${g.shape} ${g.base} -> ${g.now}`);
			if (grew.length > 0) {
				console.error(
					"timing-thresholds: the baseline only shrinks. A new threshold needs fake timers or a `// timing:` comment, not an --update.",
				);
				return 1;
			}
		}
	}
	const c = compare(baseline, counts);
	if (!failed(c)) {
		console.log(
			`timing-thresholds: OK: ${files.length} file(s), ${total} baselined hit(s), ${accepted} accepted, none new`,
		);
		return 0;
	}
	const where = (key: string): string =>
		hits
			.filter((h) => !h.accepted && `${h.file} ${h.shape}` === key)
			.map((h) => `${h.file}:${h.line}`)
			.join(", ");
	for (const k of c.added) console.error(`  NEW: ${k} (x${counts[k]}) at ${where(k)}`);
	for (const g of c.grown)
		console.error(`  MORE: ${g.key} ${g.baseline} -> ${g.now} at ${where(g.key)}`);
	for (const s of c.shrunk)
		console.error(`  fewer (tighten the baseline): ${s.key} ${s.baseline} -> ${s.now}`);
	if (c.added.length + c.grown.length > 0) {
		console.error(
			"timing-thresholds: a test added a wall-clock threshold. Use vi.useFakeTimers or an injected clock, or put a `// timing:` comment on it stating the bound and the headroom measured on CI. The baseline only ever shrinks.",
		);
	} else {
		console.error(
			"timing-thresholds: thresholds were removed: run `npm run timing-thresholds -- --update` to tighten the baseline.",
		);
	}
	return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main();
}
