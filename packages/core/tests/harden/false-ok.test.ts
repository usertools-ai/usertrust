// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The false-OK family: three places that answered "fine" to a question they
 * could not read.
 *
 * Each of these took the PERMISSIVE branch on uninterpretable input — an
 * unparseable date, an unlistable directory, a malformed PEM — and reported
 * success. None of them were detectable downstream, because the output of each
 * is indistinguishable from the genuine healthy case: an unexpired credential,
 * an empty vault, a complete snapshot.
 *
 * They are grouped in one file deliberately. They live in three subsystems and
 * share no code, but they are one defect, and the next instance of it will be
 * found by someone reading this file rather than by someone reading any one of
 * the three modules.
 *
 * The fourth member of this family — an unparseable `--successor-pin` — moved to
 * its own branch: it edits a verdict lattice with precedence rules and needed
 * three review rounds, and bundling it here let one hard change gate three
 * one-liners.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyVault } from "../../src/audit/verify.js";
import type { CredentialScope } from "../../src/shared/types.js";
import { createSnapshot } from "../../src/snapshot/checkpoint.js";
import { checkScope } from "../../src/vault/scope.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "usertrust-false-ok-"));
});

afterEach(() => {
	// Restore traversability first — a 0o000 dir cannot be removed recursively.
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; the OS reclaims the temp dir regardless.
	}
});

describe("false OK — an unparseable credential expiry", () => {
	const scope = (expiresAt: string | null): CredentialScope =>
		({ agents: [], actions: [], expiresAt }) as unknown as CredentialScope;
	const accessor = { agent: "a", action: "read" } as Parameters<typeof checkScope>[1];

	it("DENIES an expiry that cannot be parsed", () => {
		// `new Date("not-a-date").getTime()` is NaN, and `NaN <= Date.now()` is
		// false — so this fell through to allowed:true and an unreadable expiry
		// read as "not expired".
		const result = checkScope(scope("not-a-date"), accessor);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/not a valid date/i);
	});

	it("still denies a genuinely expired credential", () => {
		expect(checkScope(scope("2020-01-01T00:00:00.000Z"), accessor).allowed).toBe(false);
	});

	it("still allows a future expiry and a null expiry", () => {
		expect(checkScope(scope("2999-01-01T00:00:00.000Z"), accessor).allowed).toBe(true);
		expect(checkScope(scope(null), accessor).allowed).toBe(true);
	});
});

describe("false OK — an audit directory that cannot be enumerated", () => {
	it("does NOT report a clean vault it could not read", async () => {
		const vault = join(tmp, ".usertrust");
		const auditDir = join(vault, "audit");
		await mkdir(auditDir, { recursive: true });
		// A segment exists, so this vault is NOT empty. With `events.jsonl` absent
		// and the directory unreadable, the old code returned
		// `valid: true, chainLength: 0` — a clean bill of health, exit 0, on a
		// vault nobody could open.
		await writeFile(join(auditDir, "segment-1.jsonl"), "{}\n", "utf-8");
		await chmod(auditDir, 0o000);

		try {
			const result = verifyVault(vault);
			// Running as root defeats permission bits entirely; skip rather than
			// assert a false negative on a machine where the setup cannot hold.
			if (result.chainLength > 0) return;
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toMatch(/could not be enumerated/i);
		} finally {
			await chmod(auditDir, 0o700);
		}
	});

	it("still reports a genuinely absent audit directory honestly", () => {
		const result = verifyVault(join(tmp, "nope"));
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toMatch(/not found/i);
	});

	it("still verifies a readable empty vault as empty, not as broken", async () => {
		const vault = join(tmp, ".usertrust");
		await mkdir(join(vault, "audit"), { recursive: true });
		const result = verifyVault(vault);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(0);
	});
});

describe("false OK — a snapshot built from an unreadable vault", () => {
	it("FAILS rather than writing a silently incomplete snapshot", async () => {
		const vault = join(tmp, ".usertrust");
		const auditDir = join(vault, "audit");
		await mkdir(auditDir, { recursive: true });
		await writeFile(join(auditDir, "events.jsonl"), "{}\n", "utf-8");
		await chmod(auditDir, 0o000);

		try {
			// PROBE, don't pattern-match the failure. Root ignores mode 000, and the
			// previous guard tried to detect that by matching /rejects/ against
			// Vitest's message — which says "instead of rejecting", so the guard
			// rethrew instead of skipping. Ask the filesystem directly.
			let readable = true;
			try {
				await readdir(auditDir);
			} catch {
				readable = false;
			}
			if (!readable) {
				await expect(createSnapshot(vault, "snap")).rejects.toThrow(/enumerate/i);
			}
		} finally {
			await chmod(auditDir, 0o700);
		}
	});

	it("still snapshots a readable vault", async () => {
		const vault = join(tmp, ".usertrust");
		await mkdir(join(vault, "audit"), { recursive: true });
		writeFileSync(join(vault, "audit", "events.jsonl"), "{}\n", "utf-8");
		await expect(createSnapshot(vault, "snap")).resolves.toBeDefined();
	});
});

describe("false OK — the fail-closed error must still be machine-readable", () => {
	it("snapshot create --json emits success:false rather than an uncaught throw", async () => {
		// A fail-closed error a machine consumer cannot read is only half-surfaced.
		// The new enumeration failure arrives as a throw, and unguarded it printed
		// no JSON at all — breaking the every-command JSON contract on exactly the
		// path this change exists to expose.
		const vault = join(tmp, ".usertrust");
		const auditDir = join(vault, "audit");
		await mkdir(auditDir, { recursive: true });
		await writeFile(join(auditDir, "events.jsonl"), "{}\n", "utf-8");
		await chmod(auditDir, 0o000);

		const logged: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
			logged.push(String(m));
		});
		const argv = process.argv;
		const exitCode = process.exitCode;
		process.argv = ["node", "usertrust", "snapshot", "create", "snap", "--json"];
		try {
			let readable = true;
			try {
				await readdir(auditDir);
			} catch {
				readable = false;
			}
			if (!readable) {
				const { run } = await import("../../src/cli/snapshot.js");
				await run(tmp, { json: true } as never);
				const out = logged.join("\n");
				expect(() => JSON.parse(out) as unknown).not.toThrow();
				expect(JSON.parse(out)).toMatchObject({ command: "snapshot", success: false });
			}
		} finally {
			process.argv = argv;
			process.exitCode = exitCode;
			spy.mockRestore();
			await chmod(auditDir, 0o700);
		}
	});
});

describe("false OK — a documented count that stops matching reality", () => {
	/**
	 * AGENTS.md asserts an EXACT number of sanitizers and enumerates them. That
	 * number went stale twice while this guard was being written: once when a
	 * mirrored pair was added, and again when the count was corrected for a
	 * different copy while that pair stayed uncounted.
	 *
	 * A prose invariant nobody executes is the same shape as a health signal
	 * nobody wired: it reads as authoritative and measures nothing.
	 *
	 * ── WHY THIS MATCHES ON SHAPE, NOT ON NAMES ──
	 *
	 * The first version of this guard counted three known function NAMES. It
	 * worked — it caught a stale count within a minute of the next AGENTS.md edit
	 * — and it was wrong in the direction it exists to catch: a fourth sanitizer
	 * landed under a fourth name (`scrubForTerminal`) and the counter reported
	 * ELEVEN where THIRTEEN existed, failing a correct update. A counter that only
	 * knows the names it was written with reports a smaller inventory than exists,
	 * which is the same false OK this file is named for, one level up.
	 *
	 * So it counts what a sanitizer DOES. Both variants have an unmistakable
	 * signature: the stronger one covers the C1 range and therefore names `0x9f`;
	 * the weaker one is the `CONTROL_CHARS` character-class regex. Any future copy
	 * under any name is counted, because the thing being counted is the behaviour
	 * rather than the label — the same move as deriving fixtures from real
	 * producer call sites instead of inventing them.
	 */
	it("AGENTS.md's sanitizer count matches the sanitizers in src/", async () => {
		const { readFile, readdir } = await import("node:fs/promises");
		const ts = (await import("typescript")).default;
		const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

		const agents = await readFile(join(repoRoot, "AGENTS.md"), "utf-8");
		const declared = agents.match(/There are \*\*(\w+)\*\* sanitizers/)?.[1];
		expect(declared, "AGENTS.md no longer states a sanitizer count").toBeDefined();
		// The two variants are declared and asserted SEPARATELY. Pinning only the
		// total lets a strong sanitizer be replaced by a weak one — `strong` falls
		// by one, `weak` rises by one, the sum is unchanged and the guard passes,
		// while AGENTS.md's "do not consolidate them onto the weaker one" is
		// exactly what just happened. Two errors cancelling into a false OK is the
		// failure this file is named for, and the total-only assertion was it.
		const declaredSplit = agents.match(/\*\*(\w+)\*\* neutralise C1 and \*\*(\w+)\*\* do not/);
		expect(declaredSplit, "AGENTS.md no longer states the per-variant split").not.toBeNull();

		const WORDS: Record<string, number> = {
			six: 6,
			seven: 7,
			eight: 8,
			nine: 9,
			ten: 10,
			eleven: 11,
			twelve: 12,
			thirteen: 13,
			fourteen: 14,
			fifteen: 15,
			sixteen: 16,
		};
		const declaredCount = WORDS[declared as string];
		expect(declaredCount, `unrecognised number word "${declared}"`).toBeDefined();
		const declaredStrong = WORDS[(declaredSplit as RegExpMatchArray)[1] as string];
		const declaredWeak = WORDS[(declaredSplit as RegExpMatchArray)[2] as string];
		expect(declaredStrong, "unrecognised strong-variant number word").toBeDefined();
		expect(declaredWeak, "unrecognised weak-variant number word").toBeDefined();
		expect(
			(declaredStrong as number) + (declaredWeak as number),
			"AGENTS.md's per-variant counts do not sum to its stated total",
		).toBe(declaredCount);

		/**
		 * PARSE. Eleven review rounds went into this counter, and the honest summary
		 * is that I picked a tool one level too weak, twice.
		 *
		 * Rounds 1-10 tried to make a REGEX do lexing — names, the constant, literal
		 * text, line-orientation, identifier binding, identifier boundaries, hex
		 * boundaries, decimal and regex spellings, Unicode escapes inside
		 * identifiers, `159.e3`. Each round widened the alphabet by one escape and
		 * the next round found another, because a character class is not a token
		 * boundary and JS identifiers and numerics are wider than any class.
		 *
		 * Round 11 tried a SCANNER, and it failed in the more dangerous direction:
		 * it UNDER-counted, silently. `/` is regex-or-division, and that choice
		 * needs parser context. Re-scanning every slash swallowed source until the
		 * next one; re-scanning none broke real regex literals. Either way the token
		 * stream desynchronised and whole sanitizers vanished from the count — the
		 * guard reporting a smaller inventory than exists, which is precisely the
		 * false OK this file is named for, produced by the fix for it.
		 *
		 * The parser answers all of it because it is the thing that actually knows:
		 * `st` is one Identifier whose `.text` is resolved, `159.e3` is one
		 * NumericLiteral whose value is 159000, comments and strings are not
		 * expressions, and a `/` is a RegularExpressionLiteral only where one can
		 * legally appear. `createSourceFile` needs no type-checker and no program.
		 *
		 * RESIDUAL LIMIT, unchanged and worth keeping honest: this matches a SHAPE,
		 * not a semantics. A lookup table, an imported helper, or bounds computed at
		 * runtime would still go uncounted, and no static matcher can fix that. The
		 * guard catches a stale count for every form anyone has written; when a
		 * genuinely new one appears the process is a bullet in AGENTS.md and a case
		 * here.
		 */
		/**
		 * ASK THE ENGINE. A regex class has JavaScript's semantics, not mine — my
		 * hand-written reader gave `/[\0-\30\x7f-\x9f]/` a different meaning than the
		 * runtime does, because `\30` is a legacy octal escape and I read it as a
		 * digit. That is the fourth time on this branch that hand-modelling a
		 * grammar which already has an implementation produced a wrong answer, so
		 * the class is compiled and probed instead of parsed.
		 *
		 * THE FLAGS ARE PART OF THE BEHAVIOUR, so they are preserved verbatim.
		 * An earlier version stripped `g` and `y` because they make `.test` stateful
		 * through `lastIndex` — sound while the probe used `.test`, and obsolete the
		 * moment it moved to `.replace`, which manages `lastIndex` itself. Keeping
		 * the strip would have made `/[\x00-\x1f\x7f]/` indistinguishable from the
		 * required global form, and a non-global sanitizer removes only the FIRST
		 * control and leaves the rest of an escape sequence intact
		 * (`AGENTS.md:882-884`). Stripping a flag to make probing convenient is
		 * discarding the property being probed.
		 */
		const compileClass = (literal: string): RegExp | null => {
			const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(literal);
			if (m === null) return null;
			try {
				return new RegExp(m[1] as string, m[2] as string);
			} catch {
				return null;
			}
		};

		/**
		 * PROBE REPLACEMENT INSIDE REAL TEXT, because that is what a sanitizer does.
		 *
		 * Compiling the class stopped me modelling the regex grammar by hand, but I
		 * then asked the compiled regex the wrong question: `.test` against a
		 * ONE-CHARACTER subject. That accepts an anchored copy such as
		 * `/^[\x00-\x1f\x7f]$/` — it matches a lone control, so it "covers" the
		 * range, while `.replace` leaves every control embedded in an actual
		 * terminal string untouched. A sanitizer that sanitizes nothing, counted.
		 *
		 * Membership was never the property. Substitution is. So each code point is
		 * embedded between ordinary characters and the subject must come back with
		 * the control gone and the surrounding text intact.
		 *
		 * TWO occurrences, not one. A single embedded control cannot tell a global
		 * sanitizer from a non-global one — both remove it — so a probe built from
		 * one control accepts `/[\x00-\x1f\x7f]/`, which at runtime strips the first
		 * control of an escape sequence and leaves the remainder on the terminal.
		 * The subject therefore contains the same control twice, separated by
		 * ordinary text, and BOTH must be gone.
		 */
		const PRE = "ok";
		const MID = "mid";
		const POST = "tail";
		const removesEmbedded = (re: RegExp | null, lo: number, hi: number): boolean => {
			if (re === null) return false;
			for (let c = lo; c <= hi; c++) {
				const ch = String.fromCodePoint(c);
				const subject = `${PRE}${ch}${MID}${ch}${POST}`;
				if (subject.replace(re, "") !== `${PRE}${MID}${POST}`) return false;
			}
			return true;
		};

		/**
		 * A control sanitizer targets controls AND LEAVES ORDINARY TEXT ALONE.
		 *
		 * Without the second half, `/[^A-Za-z0-9._-]/` in `export/markdown.ts` counted
		 * as one: an allowlist slugifier covers every control range incidentally,
		 * because it excludes everything that is not alphanumeric. It is not a
		 * sanitizer, it is a different function that happens to subsume the range.
		 * What separates them is not the ranges they cover but the text they spare.
		 */
		const SPARED_TEXT = "aZ0 .-/é漢";
		const sparesOrdinaryText = (re: RegExp | null): boolean =>
			re !== null && SPARED_TEXT.replace(re, "") === SPARED_TEXT;

		/** Parentheses are nodes; the shapes below are written without them. */
		const unwrap = (n: import("typescript").Node): import("typescript").Node =>
			ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n;

		// Scanned rather than matched. A control-character CLASS here trips the same
		// lint the real sanitizers suppress, and building one with `new RegExp` to
		// dodge that gets auto-rewritten back into a literal by the formatter — so
		// this check uses no regex at all. (`countIn` only reads `packages/*/src`, so
		// nothing in this file is counted by the guard it implements.)
		const hasControl = (s: string): boolean => {
			for (const ch of s) {
				const c = ch.codePointAt(0) as number;
				if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
			}
			return false;
		};

		const isNumericValue = (n: import("typescript").Node, want: number): boolean =>
			ts.isNumericLiteral(n) && Number(n.text.replace(/_/g, "")) === want;

		/**
		 * BOUNDS ARE VALUES, NOT OPERATORS. `code < 0x20` and `code <= 0x1f` are the
		 * same assertion about integers, and accepting only the inclusive spelling
		 * meant a sanitizer written half-open went uncounted — the documented total
		 * then reads low, which is the stale-count false OK this guard exists for.
		 *
		 * Both helpers return the identifier's name so the caller can require every
		 * bound to constrain the SAME variable.
		 */
		// Operands are unwrapped too — `(code) <= 0x1f` and `code <= (0x1f)` are the
		// same assertion, and reading raw operands rejected both.
		const upperBound = (node: import("typescript").Node, inclusive: number): string | null => {
			const n = unwrap(node);
			if (!ts.isBinaryExpression(n)) return null;
			const left = unwrap(n.left);
			const right = unwrap(n.right);
			if (!ts.isIdentifier(left)) return null;
			const k = n.operatorToken.kind;
			if (k === ts.SyntaxKind.LessThanEqualsToken && isNumericValue(right, inclusive)) {
				return left.text;
			}
			if (k === ts.SyntaxKind.LessThanToken && isNumericValue(right, inclusive + 1)) {
				return left.text;
			}
			return null;
		};

		const lowerBound = (node: import("typescript").Node, inclusive: number): string | null => {
			const n = unwrap(node);
			if (!ts.isBinaryExpression(n)) return null;
			const left = unwrap(n.left);
			const right = unwrap(n.right);
			if (!ts.isIdentifier(left)) return null;
			const k = n.operatorToken.kind;
			if (k === ts.SyntaxKind.GreaterThanEqualsToken && isNumericValue(right, inclusive)) {
				return left.text;
			}
			if (k === ts.SyntaxKind.GreaterThanToken && isNumericValue(right, inclusive - 1)) {
				return left.text;
			}
			return null;
		};

		/** Does this expression assert the full control range over one identifier? */
		const neutralisesControlRange = (node: import("typescript").Node): boolean => {
			const n = unwrap(node);
			if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.BarBarToken) {
				return false;
			}
			const c0 = upperBound(unwrap(n.left), 0x1f);
			if (c0 === null) return false;
			const rest = unwrap(n.right);
			if (
				!ts.isBinaryExpression(rest) ||
				rest.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
			) {
				return false;
			}
			const lo = lowerBound(unwrap(rest.left), 0x7f);
			const hi = upperBound(unwrap(rest.right), 0x9f);
			return lo === c0 && hi === c0;
		};

		const countIn = (src: string, name: string): { strong: number; weak: number } => {
			const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

			// FIRST PASS: which regexes does this file actually replace WITH? A class
			// that could sanitize is not a sanitizer — it has to be wired to a
			// substitution. Collected up front because the binding and its use are
			// arbitrarily far apart, and the classifier below sees only the literal.
			const replacedNames = new Set<string>();
			const replacedLiterals = new Set<import("typescript").Node>();
			const collect = (n: import("typescript").Node): void => {
				if (
					ts.isCallExpression(n) &&
					ts.isPropertyAccessExpression(n.expression) &&
					(n.expression.name.text === "replace" || n.expression.name.text === "replaceAll") &&
					n.arguments.length > 0
				) {
					const a0 = unwrap(n.arguments[0] as import("typescript").Node);
					if (ts.isRegularExpressionLiteral(a0)) replacedLiterals.add(a0);
					else if (ts.isIdentifier(a0)) replacedNames.add(a0.text);
				}
				ts.forEachChild(n, collect);
			};
			collect(sf);

			const usedForReplacement = (lit: import("typescript").Node): boolean => {
				if (replacedLiterals.has(lit)) return true;
				const p = lit.parent;
				return (
					p !== undefined &&
					ts.isVariableDeclaration(p) &&
					ts.isIdentifier(p.name) &&
					replacedNames.has(p.name.text)
				);
			};

			let strong = 0;
			let weak = 0;
			const visit = (n: import("typescript").Node): void => {
				// `<ident> >= 0x7f && <the same ident> <= 0x9f`, in any spelling of
				// either bound. Comparing VALUES means 0x7f, 127 and 127.0 are one
				// bound and 159e3 is not 159; comparing Identifier `.text` means the
				// two operands must be the same variable, escapes resolved.
				// The FULL neutralisation shape: `<id> <= 0x1f || (<id> >= 0x7f && <id> <= 0x9f)`.
				// Matching only the C1 half counted an ESCAPER — a loop-form
				// `toSafeJson` handles C1 and leaves C0 to `JSON.stringify`, preserving
				// the byte rather than destroying it. The regex path already excluded
				// that; requiring C0 here makes the two paths agree, which they must,
				// since they are two spellings of one question.
				// THE PREDICATE IS NOT THE SANITIZER — THE SUBSTITUTION IS.
				//
				// Counting on the range test alone counted the question rather than
				// the answer: a loop that asks exactly this and then writes `ch`
				// back, or emits a lossless `\uXXXX`, still scored as a sanitizer.
				// Both PRESERVE the byte, and AGENTS.md counts neither — that is the
				// same escaper-versus-sanitizer line the regex path already draws,
				// and the loop path was drawing it one step too early.
				//
				// So the whole conditional is matched, and the taken branch must be a
				// STRING LITERAL: a fixed replacement destroys the character, while
				// `ch` preserves it and a computed escape re-encodes it. Every
				// sanitizer in this tree is `out += <range> ? "?" : ch`.
				//
				// RESIDUAL, and deliberate: a sanitizer written as an `if` statement
				// rather than a conditional expression goes uncounted. That direction
				// fails LOUDLY — the total reads low and the guard trips — which is
				// the safe way for this matcher to be wrong.
				// The replacement must also BE control-free. `isStringLiteral` alone
				// accepted `? "\x1b" : ch` — a "sanitizer" that emits the escape it
				// was meant to destroy, counted as strong. That is the read-HIGH
				// direction: a real sanitizer could be swapped for that one and the
				// total would still say thirteen.
				if (ts.isConditionalExpression(n) && neutralisesControlRange(n.condition)) {
					const rep = unwrap(n.whenTrue);
					if (ts.isStringLiteral(rep) && !hasControl(rep.text)) strong++;
				}
				if (ts.isRegularExpressionLiteral(n)) {
					// Classified by COVERAGE, not spelling. The stronger variant is the
					// one whose class covers C1; the weaker covers C0 and DEL without it.
					// A SANITIZER neutralises the whole control space: C0, DEL, and —
					// for the stronger variant — C1. That is the discriminator, not the
					// spelling, and it is the one AGENTS.md already draws: the `--json`
					// paths ESCAPE C1 as `\uXXXX` with `/[\u007f-\u009f]/`, which
					// handles only the upper part because `JSON.stringify` has already
					// dealt with C0. Requiring C0 coverage separates an escaper that
					// preserves the byte from a sanitizer that destroys it, and keeps
					// `/[\x00-\x1f\x7f-\x9f]/` — the direct regex equivalent of the
					// loops — counted as the stronger variant it is.
					// AND IT MUST ACTUALLY BE USED TO REPLACE. `removesEmbedded` runs a
					// synthetic replacement, which proves the regex COULD sanitize —
					// not that the source does. A full-range class used only as
					// `REJECT_CONTROLS.test(value)` is a DETECTOR, and one left behind
					// after its `.replace` was deleted is nothing at all; both were
					// counted, so removing a sanitizer while leaving its constant
					// kept the inventory green. Read-HIGH, and the exact shape this
					// file is named for.
					const re = usedForReplacement(n) ? compileClass(n.text) : null;
					if (
						removesEmbedded(re, 0x00, 0x1f) &&
						removesEmbedded(re, 0x7f, 0x7f) &&
						sparesOrdinaryText(re)
					) {
						if (removesEmbedded(re, 0x80, 0x9f)) strong++;
						else weak++;
					}
				}
				ts.forEachChild(n, visit);
			};
			visit(sf);
			return { strong, weak };
		};

		/**
		 * THE TWO DETECTORS MUST AGREE.
		 *
		 * This property has two implementations — a loop shape and a regex class —
		 * and for one round they disagreed: the loop path counted a C1-only escaper
		 * that the regex path correctly excluded. Neither was wrong on its own
		 * terms. The defect was that nothing ever fed one construct through both.
		 *
		 * Each pair below is the SAME sanitizer written both ways. If the two paths
		 * ever diverge again, this fails here rather than as a silently wrong total
		 * — which is the only symptom the count itself would show.
		 */
		const EQUIVALENT_PAIRS: ReadonlyArray<
			readonly [string, string, string, "strong" | "weak" | "none"]
		> = [
			[
				"full neutralisation",
				'export const f=(cp:number)=>cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) ? "?" : "y";',
				"export const f=(s:string)=>s.replace(r,'?');export const r=/[\\x00-\\x1f\\x7f-\\x9f]/g;",
				"strong",
			],
			[
				"C1 only — an escaper, not a sanitizer",
				'export const f=(cp:number)=>(cp >= 0x7f && cp <= 0x9f) ? "x" : "y";',
				"export const f=(s:string)=>s.replace(r,'?');export const r=/[\\u007f-\\u009f]/g;",
				"none",
			],
			[
				// Same assertion about integers, different operators. Accepting only
				// the inclusive spelling let a half-open copy go uncounted.
				"half-open bounds — the same range, spelled exclusively",
				'export const f=(cp:number)=>cp < 0x20 || (cp >= 0x7f && cp < 0xa0) ? "?" : "y";',
				"export const f=(s:string)=>s.replace(r,'?');export const r=/[\\x00-\\x1f\\x7f-\\x9f]/g;",
				"strong",
			],
		];
		for (const [label, loopForm, regexForm, expected] of EQUIVALENT_PAIRS) {
			const viaLoop = countIn(loopForm, "pair-loop.ts");
			const viaRegex = countIn(regexForm, "pair-regex.ts");
			const classify = (c: { strong: number; weak: number }): string =>
				c.strong > 0 ? "strong" : c.weak > 0 ? "weak" : "none";
			expect(classify(viaLoop), `${label}: the LOOP form classified as ${classify(viaLoop)}`).toBe(
				expected,
			);
			expect(
				classify(viaRegex),
				`${label}: the REGEX form classified as ${classify(viaRegex)}, but the loop form said ${classify(viaLoop)} — the two detectors for one property have diverged`,
			).toBe(expected);
		}

		// LOOP DECOYS. Each asks the sanitizer's exact question and then declines to
		// sanitize — the range predicate is identical to the real ones, and only the
		// taken branch differs. Counting on the predicate alone counted the question
		// rather than the answer.
		const LOOP_DECOYS: ReadonlyArray<readonly [string, string]> = [
			[
				"preserves the character it just identified",
				"export const f=(cp:number,ch:string)=>cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) ? ch : ch;",
			],
			[
				"escapes losslessly — re-encodes the byte instead of destroying it",
				'export const f=(cp:number,ch:string)=>cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) ? "\\\\u" + cp.toString(16) : ch;',
			],
			[
				// Read-HIGH: a fixed string replacement was enough to count, so a
				// "sanitizer" could EMIT the escape it exists to destroy and the
				// inventory would still report thirteen.
				"emits a control character as its replacement",
				'export const f=(cp:number,ch:string)=>cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) ? "\\x1b" : ch;',
			],
		];
		for (const [label, src] of LOOP_DECOYS) {
			const c = countIn(src, "loop-decoy.ts");
			expect(
				c.strong + c.weak,
				`counted a loop that does not sanitize: ${label}. Its range test is byte-identical ` +
					"to a real sanitizer's; what differs is what it writes back.",
			).toBe(0);
		}

		// REGEX-ONLY DECOYS. These have no loop counterpart, because the defect is
		// in the regex's REACH rather than in the range it names: each one covers
		// the whole control space and still leaves a control embedded in ordinary
		// text untouched. A membership probe against a one-character subject counts
		// both as sanitizers.
		const REGEX_DECOYS: ReadonlyArray<readonly [string, string]> = [
			[
				"anchored to the whole string",
				"export const f=(s:string)=>s.replace(r,'?');export const r=/^[\\x00-\\x1f\\x7f-\\x9f]$/g;",
			],
			[
				"anchored at the start",
				"export const f=(s:string)=>s.replace(r,'?');export const r=/^[\\x00-\\x1f\\x7f-\\x9f]/g;",
			],
			[
				"not global — strips the first control and leaves the rest of the sequence",
				"export const f=(s:string)=>s.replace(r,'?');export const r=/[\\x00-\\x1f\\x7f-\\x9f]/;",
			],
			[
				// Read-HIGH, and the one that masks a DELETION: this class covers the
				// whole control space and is never used to replace anything. Deleting
				// a real sanitizer while leaving its constant behind — or keeping a
				// detector that only tests — held the count at thirteen.
				"a detector, not a sanitizer — tested against, never replaced with",
				"export const r=/[\\x00-\\x1f\\x7f-\\x9f]/g;export const f=(s:string)=>r.test(s);",
			],
		];
		for (const [label, src] of REGEX_DECOYS) {
			const c = countIn(src, "decoy.ts");
			expect(
				c.strong + c.weak,
				`counted a regex that does not sanitize: ${label}. Each of these survives a probe ` +
					"that is too weak in a different way — an anchored form passes a single-character " +
					"subject, a non-global form passes a subject holding one control — and each leaves " +
					"controls in real terminal text.",
			).toBe(0);
		}

		const tsFiles = async (dir: string): Promise<string[]> => {
			const out: string[] = [];
			for (const e of await readdir(dir, { withFileTypes: true })) {
				const full = join(dir, e.name);
				if (e.isDirectory()) out.push(...(await tsFiles(full)));
				else if (e.name.endsWith(".ts")) out.push(full);
			}
			return out;
		};

		const pkgs = join(repoRoot, "packages");
		const srcDirs = (await readdir(pkgs, { withFileTypes: true }))
			.filter((e) => e.isDirectory())
			.map((e) => join(pkgs, e.name, "src"));

		let strong = 0;
		let weak = 0;
		for (const dir of srcDirs) {
			let files: string[];
			try {
				files = await tsFiles(dir);
			} catch (err) {
				// ONLY a genuinely absent directory is "no source". A blanket catch here
				// read EACCES or an I/O error as an empty package, so a new sanitizer in
				// an unreadable tree went uncounted and the stale total passed.
				if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
				throw err;
			}
			for (const f of files) {
				const c = countIn(await readFile(f, "utf-8"), f);
				strong += c.strong;
				weak += c.weak;
			}
		}

		const inventory =
			`AGENTS.md says ${declaredStrong} C1-covering + ${declaredWeak} control-class = ${declaredCount}; ` +
			`src/ contains ${strong} + ${weak} = ${strong + weak}. ` +
			"Add a bullet to the inventory and update BOTH the variant counts and the total — the " +
			"entries are deliberately unnumbered so nothing needs renumbering.";

		// Each variant is pinned on its own. The total is asserted too, but it is
		// the weakest of the three: it is the only one a strong→weak swap leaves
		// intact.
		expect(strong, inventory).toBe(declaredStrong);
		expect(weak, inventory).toBe(declaredWeak);
		expect(strong + weak, inventory).toBe(declaredCount);
	});
});
