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
 *  - the file calls `vi.useFakeTimers` (sleep and `Date.now()` only: they run on the fake clock), or
 *  - a `timing:` comment on its line, or in the comment lines directly above it, states the
 *    bound and the headroom measured on CI (it must contain a number), e.g.
 *    `// timing: 30 s budget; CI's slowest of 20 runs took 9 s`.
 * Every other hit is counted in `timing-thresholds.baseline.json`, keyed by file and shape
 * (never by line), which only ever shrinks: a new key or a count that grew fails, and a count
 * that fell fails until the baseline is tightened, as in `typecheck-tests.mts`.
 *
 *   tsx scripts/timing-thresholds.mts            # check against the baseline
 *   tsx scripts/timing-thresholds.mts --update   # rewrite the baseline to the current hits
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

/** A sleep: a timer call with a delay other than 0, including `timers/promises`' `setTimeout(ms)`. */
function sleeps(call: ts.CallExpression): boolean {
	const name = dotted(call.expression);
	if (name === undefined) return false;
	const timer = name.replace(/^(globalThis|global|window)\./, "");
	if (timer !== "setTimeout" && timer !== "setInterval") return false;
	const [first, delay] = call.arguments;
	if (delay !== undefined) return !isZero(delay);
	// One argument: the global timer's callback (delay 0), or `timers/promises`' delay.
	if (first === undefined) return false;
	if (numeric(first)) return !isZero(first);
	return ts.isIdentifier(first) && /ms$|millis|delay|wait|timeout|duration/i.test(first.text);
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
	const found: Array<{ node: ts.Node; shape: Shape; clockDate?: boolean }> = [];
	let fake = false;
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const name = dotted(node.expression);
			if (name === "vi.useFakeTimers" || name === "jest.useFakeTimers") fake = true;
			if (sleeps(node)) found.push({ node, shape: "sleep" });
			if (
				name === "performance.now" ||
				name === "process.hrtime" ||
				name === "process.hrtime.bigint"
			)
				found.push({ node, shape: "clock" });
			if (name === "Date.now" && measures(node))
				found.push({ node, shape: "clock", clockDate: true });
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
	return found.map(({ node, shape, clockDate }) => {
		const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
		const byFakeClock = fake && (shape === "sleep" || clockDate === true);
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
