// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * THE SERVER'S ERROR LOG REDACTS THE WHOLE MESSAGE, AT ANY LENGTH, BEFORE ANYTHING IS CUT.
 *
 * An error message can quote what a caller sent, so the server redacts credentials in it before
 * logging it. Pinned:
 * - `redactApiKeys` matches exactly what the single api-key pattern it replaced matched (a seeded
 *   corpus), and reads a value of 10.4 million characters, where that pattern, or its unrolled
 *   form, throws RangeError.
 * - `redactSecrets` reads the whole text: a credential far past where a cut used to fall is
 *   redacted. Should a pattern still throw RangeError (forced by a stub of RegExp.prototype.exec),
 *   the whole text is replaced; any other error still throws.
 * - `redactSecrets` finds the caller's key with whitespace or a control character anywhere inside
 *   it (in place of a space the key holds, or within a word, as a hard-wrapped key has), or with a
 *   space removed, where the `Bearer` or api-key pattern would take its first part and leave the
 *   rest. It finds every kind of match on the same text before replacing any, so a key that holds
 *   the word `Bearer` or an api-key name cannot take that marker from the token after it. It
 *   builds no pattern from the key: a key of any length is found, and the search stays linear on a
 *   near miss with long runs between the key's characters and on a key that repeats its own start.
 * - `joinLines` joins what `/\s*\n\s*\/g` joined, in one pass: 10.4M spaces finish fast.
 * - `internalErrorLine` looks for credentials in the original text, where the delimiters the
 *   patterns read are still there (`Bearer\t<token>`), and in the sanitized text, where a key or a
 *   marker a control character split is whole; replaces what both find once, in the sanitized
 *   text, so nothing is removed after a replacement (an OSC sequence a replacement shortened would
 *   otherwise join a marker to its value); joins the lines; and cuts only after that, at the
 *   printed clip. Every control, DEL and C1 character and three escape sequences, inside each
 *   marker, with and without a key that swallows the marker in the original, leave no readable
 *   credential. `sanitizeMapped` gives scrubForStderr's text and where each of its units was.
 */

import { describe, expect, it } from "vitest";
import { MAX_PRINTED_CHARS, sanitizeMapped, scrubForStderr } from "../src/cli/scrub.js";
import { internalErrorLine, joinLines, redactApiKeys, redactSecrets } from "../src/server.js";
import { OLD_API_KEY_VALUE, redactWith } from "./helpers/old-api-key-pattern.js";

const MARKER = "throw-here";
const UNREADABLE = "[redacted: the message could not be scanned]";
const LINE = "usertrust-server: internal error: tenant=t route=POST /v1/authorize: ";
const N = 10_400_000;

/** `fn()` with every regexp method throwing `error()` on a string that holds MARKER. */
function throwingOn<T>(error: () => Error, fn: () => T): T {
	const exec = RegExp.prototype.exec;
	RegExp.prototype.exec = function (this: RegExp, input: string) {
		if (typeof input === "string" && input.includes(MARKER)) throw error();
		return exec.call(this, input);
	} as typeof exec;
	try {
		return fn();
	} finally {
		RegExp.prototype.exec = exec;
	}
}

/**
 * `actual` is `expected`. On a difference it fails with where they part and their lengths, never
 * a diff: a diff of two strings of millions of characters takes minutes.
 */
function expectSame(actual: string, expected: string): void {
	if (actual === expected) return;
	let at = 0;
	while (at < actual.length && actual[at] === expected[at]) at++;
	const near = (text: string): string => JSON.stringify(text.slice(at, at + 40));
	expect.fail(
		`they part at ${at}: ${near(actual)} (length ${actual.length}), expected ${near(expected)} (length ${expected.length})`,
	);
}

const line = (message: string, secrets: readonly string[] = []): string =>
	internalErrorLine(new Error(message), "t", "POST /v1/authorize", secrets);

describe("redactApiKeys", () => {
	it("matches exactly what the old pattern matched, over a seeded corpus", () => {
		const parts = ["x-api-key", "api_key", "API-KEY", "api-key", '"', "'", "\\", ":", "="];
		parts.push(" ", "\t", "\n", "a", "b", ";", "&", ",", "x", "-");
		let seed = 12_345;
		const next = (): number => {
			seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
			return seed / 2 ** 32;
		};
		let redacted = 0;
		for (let i = 0; i < 100_000; i++) {
			let text = "";
			const length = 1 + Math.floor(next() * 14);
			for (let j = 0; j < length; j++) text += parts[Math.floor(next() * parts.length)];
			const expected = redactWith(OLD_API_KEY_VALUE, text);
			if (expected !== text) redacted++;
			expect(redactApiKeys(text), JSON.stringify(text)).toBe(expected);
		}
		// The positive control: the corpus reaches the pattern's every branch often.
		expect(redacted).toBeGreaterThan(5_000);
	}, 60_000);

	it("reads a 10.4M-character value, quoted or not, where a repeated group throws", () => {
		const unclosed = `x-api-key: "${"a".repeat(N)}`;
		const escapes = `api_key='${"\\'".repeat(N / 2)}`;
		// The controls: the old pattern throws on the first, and its unrolled form on the second.
		expect(() => unclosed.replace(OLD_API_KEY_VALUE, "")).toThrow(RangeError);
		const unrolled = /'([^'\\]*(?:\\[\s\S][^'\\]*)*)'?/g;
		expect(() => escapes.replace(unrolled, "")).toThrow(RangeError);
		expectSame(redactApiKeys(unclosed), 'x-api-key: "[redacted]"');
		expectSame(redactApiKeys(`${escapes}' after`), "api_key='[redacted]' after");
		expectSame(redactApiKeys(`x-api-key=${"a".repeat(N)} after`), "x-api-key=[redacted] after");
	});
});

describe("redactSecrets", () => {
	it("reads the whole text: a credential far past where a cut used to fall is redacted", () => {
		const head = "a ".repeat(40_000);
		expect(redactSecrets(`${head}x-api-key: "abc" Bearer abcdef key-1 end`, ["key-1"])).toBe(
			`${head}x-api-key: "[redacted]" Bearer [redacted] [redacted] end`,
		);
	});

	it("replaces the whole text on RangeError", () => {
		const out = throwingOn(
			() => new RangeError("Maximum call stack size exceeded"),
			() => redactSecrets(`Bearer abcdefghijklmnopqrstuvwxyz ${MARKER}`),
		);
		expect(out).toBe(UNREADABLE);
	});

	it("throws any other error", () => {
		expect(() =>
			throwingOn(
				() => new TypeError("a bug, not an overflow"),
				() => redactSecrets(`Bearer abcdefghijklmnopqrstuvwxyz ${MARKER}`),
			),
		).toThrow(TypeError);
	});

	describe("finds a caller's key that holds a space, whatever stands in that space", () => {
		const key = "tenant key-0123456789";

		it("finds it where the Bearer pattern would take its first word", () => {
			for (const gap of ["\n", "\t", "\r\n", " \n ", "\0", "\x1b", "  "]) {
				const text = `Bearer tenant${gap}key-0123456789 after`;
				expect(redactSecrets(text, [key]), JSON.stringify(gap)).toBe("Bearer [redacted] after");
			}
		});

		it("finds it with the space removed, and only the key", () => {
			expect(redactSecrets("tenantkey-0123456789", [key])).toBe("[redacted]");
			expect(redactSecrets("tenant key-012345678", [key])).toBe("tenant key-012345678");
			expect(redactSecrets("a.b+c", ["a.b+c"])).toBe("[redacted]");
			expect(redactSecrets("aXb+c", ["a.b+c"])).toBe("aXb+c");
			expect(redactSecrets("text", [" ", ""])).toBe("text");
		});

		it("drops the key's own whitespace, as it does the text's", () => {
			expect(redactSecrets("x abc\ndef y", [" abc  def "])).toBe("x [redacted] y");
			expect(redactSecrets("x abc  def y", ["abc def"])).toBe("x [redacted] y");
		});

		it("replaces a one-word key wherever it stands, as a plain split did", () => {
			expect(redactSecrets("a cat", ["a"])).toBe("[redacted] c[redacted]t");
		});

		it("stays linear where the key's first word recurs before long whitespace runs", () => {
			const started = performance.now();
			const runs = `tenant${" ".repeat(20_000)}`.repeat(100);
			expectSame(redactSecrets(runs, [key]), runs);
			const words = "tenant ".repeat(500_000);
			expectSame(redactSecrets(words, [key]), words);
			const long = `tenant${" ".repeat(N)}x`;
			expectSame(redactSecrets(long, [key]), long);
			expectSame(redactSecrets(`tenant${" ".repeat(N)}key-0123456789`, [key]), "[redacted]");
			expect(performance.now() - started).toBeLessThan(3_000);
		});
	});

	describe("finds a caller's key that whitespace splits within a word, as a hard-wrapped key is", () => {
		const key = "sk-SECRETsecret-0123456789";
		const splits = ["\n", "\r\n", " ", "\t", " \n ", "\n\n", String.fromCodePoint(0xa0)];
		splits.push(String.fromCodePoint(0x2028));

		it("finds it with no head, after Bearer, and as an api-key value", () => {
			for (const gap of splits) {
				const split = `sk-SEC${gap}RETsecret-0123456789`;
				const name = JSON.stringify(gap);
				expect(redactSecrets(`${split} after`, [key]), name).toBe("[redacted] after");
				expect(redactSecrets(`Bearer ${split} after`, [key]), name).toBe("Bearer [redacted] after");
				expect(redactSecrets(`x-api-key: ${split} after`, [key]), name).toBe(
					"x-api-key: [redacted] after",
				);
			}
		});

		it("finds it split at any point, and at every point at once, but not one character off", () => {
			for (let at = 1; at < key.length; at++) {
				for (const gap of ["\n", "\0\x1b", " \t "]) {
					const text = `${key.slice(0, at)}${gap}${key.slice(at)}`;
					expect(redactSecrets(text, [key]), JSON.stringify(text)).toBe("[redacted]");
				}
			}
			expect(redactSecrets(Array.from(key).join("\n"), [key])).toBe("[redacted]");
			expect(redactSecrets("sk-SEC\nRETsecret-012345678X", [key])).toBe(
				"sk-SEC\nRETsecret-012345678X",
			);
		});

		it("stays linear on a near miss with long runs between its characters, and on fragments", () => {
			const spaced = "tenant key-0123456789";
			const run = " ".repeat(20_000);
			const started = performance.now();
			// Every character but the last, each after a run: a search that began again at each
			// candidate start would read to the X from each one. (A pattern that kept the key's own
			// space as a literal between two gaps split every run two ways, and took minutes.)
			const near = `${Array.from("tenantkey-012345678").join(run)}${run}X`.repeat(50);
			expectSame(redactSecrets(near, [spaced]), near);
			const parts = ["ten", "tenant", "key-01", "tenant key-0123", "0123456789", "\n", "\t"];
			let fragments = "";
			for (let i = 0; fragments.length < N; i++)
				fragments += `${parts[i % parts.length]}${" ".repeat(5_000)}`;
			expectSame(redactSecrets(fragments, [spaced]), fragments);
			expect(performance.now() - started).toBeLessThan(3_000);
		});
	});

	describe("finds every kind of match on the same text, so none hides another", () => {
		const token = "upstream-secret-XYZ123";

		it("keeps a Bearer or api-key marker that a caller's key holds, so the token after it is redacted", () => {
			expect(redactSecrets(`Bearer ${token}`, ["B earer"])).toBe("[redacted] [redacted]");
			expect(redactSecrets(`Bearer ${token}`, ["Bearer"])).toBe("[redacted] [redacted]");
			expect(redactSecrets(`x-api-key: ${token}`, ["api- key"])).toBe("x-[redacted]: [redacted]");
			expect(redactSecrets(`x-api-key: ${token}`, ["x-api-key"])).toBe("[redacted]: [redacted]");
			expect(redactSecrets(`{"api_key": "${token}"}`, ["api_key"])).toBe(
				'{"[redacted]": "[redacted]"}',
			);
		});

		it("redacts the token after a marker whatever part of the marker the key is", () => {
			let keys = 0;
			for (const marker of ["Bearer ", "bearer\t", "x-api-key: ", "api_key=", 'api-key: "']) {
				for (let from = 0; from < marker.length; from++) {
					for (let to = from + 1; to <= marker.length; to++) {
						const key = marker.slice(from, to);
						const out = redactSecrets(`${marker}${token} after`, [key]);
						expect(out, JSON.stringify(key)).not.toContain("upstream");
						expect(out, JSON.stringify(key)).not.toContain("XYZ");
						keys++;
					}
				}
			}
			expect(keys).toBe(28 + 28 + 66 + 36 + 55);
		});

		it("replaces overlapping places as one and adjacent ones each, finding a key after a false start", () => {
			expect(redactSecrets("x aaa y", ["aa"])).toBe("x [redacted] y");
			expect(redactSecrets("x ababab y", ["abab"])).toBe("x [redacted] y");
			expect(redactSecrets("x abab y", ["ab"])).toBe("x [redacted][redacted] y");
			expect(redactSecrets("x aaab y", ["aab"])).toBe("x a[redacted] y");
			expect(redactSecrets("x abacabad y", ["abad"])).toBe("x abac[redacted] y");
			expect(redactSecrets("Bearer\tsk-1 x", ["sk-1"])).toBe("Bearer [redacted] x");
			expect(redactSecrets('api_key="sk-1 more" x', ["sk-1"])).toBe('api_key="[redacted]" x');
		});

		it("takes as gaps exactly the characters [\\s\\x00-\\x1f\\x7f-\\x9f] matches, and no others", () => {
			const gapClass = String.raw`[\s\x00-\x1f\x7f-\x9f]`;
			const gap = new RegExp(gapClass);
			const wrong: number[] = [];
			let gaps = 0;
			for (let code = 0; code <= 0xffff; code++) {
				const char = String.fromCharCode(code);
				const isGap = gap.test(char);
				if (isGap) gaps++;
				if ((redactSecrets(`q${char}z`, ["qz"]) === "[redacted]") !== isGap) wrong.push(code);
				if ((redactSecrets("qz", [`q${char}z`]) === "[redacted]") !== isGap) wrong.push(code);
			}
			expect(wrong).toEqual([]);
			// Positive control: 33 up to U+0020, 34 from U+007F to U+00A0, and 18 other spaces.
			expect(gaps).toBe(85);
		});
	});

	describe("builds no pattern from a caller's key", () => {
		it("finds a key of any length, split by a line break, and never throws", () => {
			for (const length of [1024, 2048, 4096, 8192, 65_536]) {
				const key = "abcdefgh01234567".repeat(length / 16);
				const split = `${key.slice(0, 1000)}\n${key.slice(1000)}`;
				const name = String(length);
				expect(redactSecrets(`x ${key} y`, [key]), name).toBe("x [redacted] y");
				expect(redactSecrets(`Bearer ${split} y`, [key]), name).toBe("Bearer [redacted] y");
				expect(redactSecrets(`x ${key.slice(0, -1)}X y`, [key]), name).toBe(
					`x ${key.slice(0, -1)}X y`,
				);
			}
		});

		it("reads every character of a key literally, those regular expressions treat as syntax too", () => {
			const key = [".*+?^$", "{}()|[]\\/-"].join("");
			expect(redactSecrets(`x ${key} y`, [key])).toBe("x [redacted] y");
			expect(redactSecrets(`x ${key.slice(1)} y`, [key])).toBe(`x ${key.slice(1)} y`);
			expect(redactSecrets("x a y", [key])).toBe("x a y");
			expect(redactSecrets(`x ${"(".repeat(600)} y`, ["(".repeat(600)])).toBe("x [redacted] y");
		});

		it("stays linear on a key that repeats its own start", () => {
			const text = "a".repeat(100_000);
			let started = performance.now();
			expectSame(redactSecrets(text, [`${"a".repeat(1000)}b`]), text);
			expect(performance.now() - started).toBeLessThan(100);
			const pairs = "a ".repeat(N / 2);
			started = performance.now();
			expectSame(redactSecrets(pairs, [`${"a".repeat(40)}b`]), pairs);
			expect(performance.now() - started).toBeLessThan(3_000);
		});
	});
});

describe("joinLines", () => {
	it("joins exactly what the quadratic pattern joined, over a seeded corpus", () => {
		const parts = [" ", "\t", "\n", "\r", "\v", "\f", "a", "b"];
		parts.push(String.fromCodePoint(0xa0), String.fromCodePoint(0x2028));
		let seed = 54_321;
		const next = (): number => {
			seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
			return seed / 2 ** 32;
		};
		let joined = 0;
		for (let i = 0; i < 50_000; i++) {
			let text = "";
			const length = 1 + Math.floor(next() * 12);
			for (let j = 0; j < length; j++) text += parts[Math.floor(next() * parts.length)];
			const expected = text.replace(/\s*\n\s*/g, " ");
			if (expected !== text) joined++;
			expect(joinLines(text), JSON.stringify(text)).toBe(expected);
		}
		// The positive control: the corpus joins often, and leaves runs with no line break.
		expect(joined).toBeGreaterThan(10_000);
		expect(joined).toBeLessThan(50_000);
	}, 60_000);

	it("reads a 10.4M-character whitespace run in one pass", () => {
		const started = performance.now();
		expectSame(joinLines(`a${" ".repeat(N)}b`), `a${" ".repeat(N)}b`);
		expectSame(joinLines(`a${" ".repeat(N / 2)}\n${" ".repeat(N / 2)}b`), "a b");
		expect(performance.now() - started).toBeLessThan(2_000);
	});
});

describe("internalErrorLine redacts the whole message before anything is cut", () => {
	it("redacts before sanitizing removes the delimiters the patterns read", () => {
		expect(line("Authorization: Bearer\tupstream-secret")).toBe(
			`${LINE}Error: Authorization: Bearer [redacted]`,
		);
		expect(line("upstream\tBearer upstream-secret")).toBe(
			`${LINE}Error: upstreamBearer [redacted]`,
		);
		// `ESC B` is one escape sequence, so sanitizing takes the B with it.
		expect(line("\x1bBearer upstream-secret")).toBe(`${LINE}Error: earer [redacted]`);
	});

	it("redacts a 10.4M-character unclosed api-key value", () => {
		expectSame(line(`x-api-key: "${"a".repeat(N)}`), `${LINE}Error: x-api-key: "[redacted]"`);
	});

	it("redacts a credential that only removed padding brings into the printed line", () => {
		// 70k NULs put the token far past where a cut used to fall; sanitizing removes them.
		expect(line(`${"\0".repeat(70_000)}Bearer\tupstream-secret`)).toBe(
			`${LINE}Error: Bearer [redacted]`,
		);
	});

	describe("a key split by an escape sequence, which sanitizing joins", () => {
		const key = "tenant-key-0123456789";
		const split = "tenant-key-01234\x1b[0m56789";

		it("is replaced whole where 64 KiB of removed padding precedes it", () => {
			const out = line(`${"\0".repeat(64 * 1024 - 7 - 15)}${split}`, [key]);
			expect(out).toBe(`${LINE}Error: [redacted]`);
		});

		it("is replaced whole across the printed clip", () => {
			const pad = "x".repeat(MAX_PRINTED_CHARS - "Error: ".length - 10);
			const out = line(`${pad}${split} after`, [key]);
			expect(out).toBe(`${LINE}Error: ${pad}[redacted]\u2026`);
			expect(out).not.toContain("tenant-key");
		});
	});

	it("finds a key in the original, where an escape sequence would eat its first character", () => {
		// `ESC T` is one escape sequence: removing it leaves `enant-...`, which no search of the
		// sanitized text can find. The original holds the key whole; what sanitizing kept of it is
		// replaced, and nothing is removed after that, so the placeholder is printed whole.
		const key = "Tenant-key-0123456789";
		const out = line(`\x1b${key}`, [key]);
		expect(out).toBe(`${LINE}Error: [redacted]`);
		expect(out).not.toContain("enant-key");
	});

	describe("a caller's key that holds a space, quoted with something else in that place", () => {
		const key = "tenant key-0123456789";
		const clean = (out: string): void => {
			expect(out).not.toContain("key-0");
			expect(out).not.toContain("tenant key");
		};

		it("is replaced whole where a line break in its space reaches across the printed clip", () => {
			const pad = "x".repeat(MAX_PRINTED_CHARS - "Error: ".length - 10);
			const out = line(`${pad}tenant\nkey-0123456789 after`, [key]);
			expect(out).toBe(`${LINE}Error: ${pad}[redacted]\u2026`);
			clean(out);
		});

		it("is replaced whole across the printed clip with an escape sequence inside a word", () => {
			// The first pass cannot match it; the pass after sanitizing does, before the clip.
			const pad = "x".repeat(MAX_PRINTED_CHARS - "Error: ".length - 4);
			const out = line(`${pad}ten\x1b[0mant\nkey-0123456789 after`, [key]);
			expect(out).toBe(`${LINE}Error: ${pad}[red\u2026`);
			clean(out);
		});

		it("is replaced whole where a Bearer pattern would take its first word", () => {
			// Sanitizing removes the NUL and makes the word `Bearer` only after the first pass.
			for (const message of ["Bea\0rer tenant\nkey-0123456789", "Bearer tenant\nkey-0123456789"]) {
				const out = line(message, [key]);
				expect(out, JSON.stringify(message)).toBe(`${LINE}Error: Bearer [redacted]`);
				clean(out);
			}
		});

		it("is replaced whole where an api-key pattern would take its first word", () => {
			const out = line("x-api-key: abc\n def-0123456789XYZ", ["abc def-0123456789XYZ"]);
			expect(out).toBe(`${LINE}Error: x-api-key: [redacted]`);
			expect(out).not.toContain("def-0");
		});

		it("is replaced whole where the control character in its space would take the next character", () => {
			// `ESC K` is one escape sequence: sanitizing would leave `tenantey-...`, which is no
			// longer the key, so the key must be found before, with the ESC in its space.
			const out = line("tenant\x1bKey-0123456789", ["tenant Key-0123456789"]);
			expect(out).toBe(`${LINE}Error: [redacted]`);
			expect(out).not.toContain("ey-0");
		});

		it("is replaced whole with a tab, a CRLF, a control character or an escape sequence in its space", () => {
			for (const gap of ["\t", "\r\n", "\0", "\x07", "\x1b[0m"]) {
				const out = line(`Bearer tenant${gap}key-0123456789`, [key]);
				expect(out, JSON.stringify(gap)).toBe(`${LINE}Error: Bearer [redacted]`);
				clean(out);
			}
		});
	});

	it("replaces a key that whitespace splits within a word: no head, Bearer, api-key, across the clip", () => {
		const key = "sk-SECRETsecret-0123456789";
		const splits = [
			"\n",
			"\r\n",
			" ",
			" \n ",
			"\n\n",
			String.fromCodePoint(0xa0),
			String.fromCodePoint(0x2028),
		];
		for (const gap of splits) {
			const split = `sk-SEC${gap}RETsecret-0123456789`;
			const name = JSON.stringify(gap);
			expect(line(split, [key]), name).toBe(`${LINE}Error: [redacted]`);
			expect(line(`Bearer ${split}`, [key]), name).toBe(`${LINE}Error: Bearer [redacted]`);
			expect(line(`x-api-key: ${split}`, [key]), name).toBe(`${LINE}Error: x-api-key: [redacted]`);
		}
		const pad = "x".repeat(MAX_PRINTED_CHARS - "Error: ".length - 10);
		const out = line(`${pad}sk-SEC\nRETsecret-0123456789 after`, [key]);
		expect(out).toBe(`${LINE}Error: ${pad}[redacted]\u2026`);
		expect(out).not.toContain("RET");
	});

	it("keeps a marker a caller's key holds, so the token after it is redacted", () => {
		const token = "upstream-secret-XYZ123";
		expect(line(`Bearer ${token}`, ["B earer"])).toBe(`${LINE}Error: [redacted] [redacted]`);
		expect(line(`Bearer\t${token}`, ["Bearer"])).toBe(`${LINE}Error: [redacted] [redacted]`);
		expect(line(`x-api-key: ${token}`, ["api- key"])).toBe(
			`${LINE}Error: x-[redacted]: [redacted]`,
		);
		expect(line(`x-api-key: ${token}`, ["x-api-key"])).toBe(`${LINE}Error: [redacted]: [redacted]`);
	});

	it("replaces a key of 65,536 characters split by a line break", () => {
		const key = "abcdefgh01234567".repeat(4096);
		const out = line(`x ${key.slice(0, 1000)}\n${key.slice(1000)} y`, [key]);
		expect(out).toBe(`${LINE}Error: x [redacted] y`);
	});

	it("joins the lines before the clip, so what follows a long run of line breaks is kept", () => {
		expect(line(`a${"\n".repeat(10_000)}b`)).toBe(`${LINE}Error: a b`);
	});

	it("joins lines in one pass, so a long whitespace run finishes fast", () => {
		const started = performance.now();
		const out = line(`${" ".repeat(500_000)}end`);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(out).toBe(`${LINE}Error: ${" ".repeat(MAX_PRINTED_CHARS - "Error: ".length)}\u2026`);
	}, 30_000);
});

const C = (...codes: number[]): string => String.fromCharCode(...codes);
const ESC = C(0x1b);
const BEL = C(0x07);

/** Each control, DEL and C1 character, three escape sequences, and the line and paragraph separators. */
const INSIDE: string[] = [];
for (let c = 0; c <= 0x1f; c++) INSIDE.push(C(c));
for (let c = 0x7f; c <= 0x9f; c++) INSIDE.push(C(c));
INSIDE.push(`${ESC}[31m`, `${ESC}]0;t${BEL}`, `${C(0x9b)}1m`, C(0x2028), C(0x2029));

/** Each marker, and what stands between it and its value. */
const MARKERS: Array<[string, string]> = [
	["Bearer", " "],
	["bearer", " "],
	["x-api-key", ": "],
	["api-key", "="],
	["api_key", ": "],
];

const VALUE = "upstream-secret-XYZ";

describe("internalErrorLine reads the original and the sanitized text, and redacts the sanitized one once", () => {
	it("a marker a control character splits, which a caller's key would swallow in the original", () => {
		expect(line(`tenant Bea${C(0)}rer ${VALUE}`, ["tenantBearer"])).toBe(
			`${LINE}Error: [redacted] [redacted]`,
		);
		expect(line(`tenant x-api${BEL}-key: ${VALUE}`, ["tenantx-api-key"])).toBe(
			`${LINE}Error: [redacted]: [redacted]`,
		);
	});

	it("positive control: the original alone, then sanitized, prints those values", () => {
		const viaOriginal = (message: string, key: string): string =>
			joinLines(
				scrubForStderr(redactSecrets(`Error: ${message}`, [key]), Number.POSITIVE_INFINITY),
			);
		expect(viaOriginal(`tenant Bea${C(0)}rer ${VALUE}`, "tenantBearer")).toContain(VALUE);
		expect(viaOriginal(`tenant x-api${BEL}-key: ${VALUE}`, "tenantx-api-key")).toContain(VALUE);
	});

	it("nothing is removed after redacting: an OSC sequence a key's span ends cannot join a marker", () => {
		// The OSC's terminator is inside the key. Redacting the original first and sanitizing after,
		// the OSC runs past the placeholder to the next terminator, and `Bea` meets `rer <value>`.
		const message = `Bea${ESC}]SEC${BEL}RETKEYjunk${BEL}rer ${VALUE}`;
		const redactedFirst = joinLines(
			scrubForStderr(redactSecrets(`Error: ${message}`, ["SECRETKEY"]), Number.POSITIVE_INFINITY),
		);
		expect(redactedFirst).toBe(`Error: Bearer ${VALUE}`);
		// Here the sanitized text is redacted: no marker reads in it, and none in the line.
		expect(line(message, ["SECRETKEY"])).toBe(`${LINE}Error: Bea[redacted]junkrer ${VALUE}`);
	});

	it("a separator sanitizing removes still separates: the token after it is redacted", () => {
		const TAB = C(9);
		// The original's pattern takes the escape sequence for the token, and sanitizing joins
		// `Bearer` to the token; in the text with a space for each removed run, the token reads.
		expect(line(`Authorization: Bearer${TAB}${ESC}[31m${TAB}${VALUE}`)).toBe(
			`${LINE}Error: Authorization: Bearer [redacted]`,
		);
		expect(line(`Bearer${ESC}[31m${VALUE} end`)).toBe(`${LINE}Error: Bearer [redacted] end`);
		const failed: string[] = [];
		for (const [marker, sep] of MARKERS) {
			for (const inside of INSIDE) {
				// The marker's own separator stays (`x-api-key` names no value without `:` or `=`), and the
				// removed characters stand before it, after it, or between tabs after it.
				const head = sep.trimEnd();
				for (const between of [
					`${inside}${sep}`,
					`${head}${inside}`,
					`${head}${C(9)}${inside}${C(9)}`,
				]) {
					const printed = line(`tenant ${marker}${between}${VALUE} end`).slice(LINE.length);
					if (printed.includes(VALUE))
						failed.push(`${JSON.stringify(between)}: ${JSON.stringify(printed)}`);
				}
			}
		}
		expect(failed.slice(0, 10)).toEqual([]);
	});

	it("a token runs on through what sanitizing joins to its end", () => {
		const TAB = C(9);
		// The original and the spaced view end the token at the second tab; once sanitized, what
		// followed it is joined to it, and no pattern reads the marker there.
		expect(line(`Authorization: Bearer${TAB}part-one${TAB}part-two`)).toBe(
			`${LINE}Error: Authorization: Bearer [redacted]`,
		);
		expect(line(`Authorization: Bearer${TAB}Bearer${TAB}${VALUE}`)).toBe(
			`${LINE}Error: Authorization: Bearer [redacted]`,
		);
		// An unquoted api-key value, where only the original reads the marker (a word boundary).
		expect(line(`x${TAB}api_key=part-one${TAB}part-two`)).toBe(`${LINE}Error: xapi_key=[redacted]`);
		// It stops where the token would: at a delimiter sanitizing keeps.
		expect(line(`Bearer${TAB}part-one${TAB}part-two;rest`)).toBe(
			`${LINE}Error: Bearer [redacted];rest`,
		);
		expect(line(`x${TAB}api_key=one${TAB}two&rest`)).toBe(`${LINE}Error: xapi_key=[redacted]&rest`);
		const failed: string[] = [];
		let joined = 0;
		for (const [marker, sep] of MARKERS) {
			const head = sep.trimEnd();
			for (const inside of INSIDE) {
				for (const between of [sep, `${inside}${sep}`, `${head}${inside}`, `${head}${TAB}`]) {
					for (const after of [inside, `${TAB}${inside}${TAB}`]) {
						for (const before of ["tenant ", `tenant${TAB}`]) {
							const message = `${before}${marker}${between}${VALUE}${after}tail end`;
							const printed = line(message).slice(LINE.length);
							if (scrubForStderr(message, Number.POSITIVE_INFINITY).includes(`${VALUE}tail`))
								joined++;
							if (redactSecrets(printed) !== printed)
								failed.push(`${JSON.stringify(message)}: not a fixed point: ${printed}`);
							if (printed.includes(VALUE))
								failed.push(`${JSON.stringify(message)}: ${JSON.stringify(printed)}`);
						}
					}
				}
			}
		}
		expect(failed.slice(0, 10)).toEqual([]);
		// Positive control: sanitizing joins the tail to the value in many of them.
		expect(joined).toBeGreaterThan(500);
	});

	it("a run of joined tokens is read once: 100,000 of them in under 3 seconds", () => {
		const TAB = C(9);
		for (const unit of [
			`Bearer${TAB}x${TAB}`,
			`api_key=x${TAB}`,
			`y${TAB}api_key=x${TAB}`,
			`tenantBearer${TAB}x${TAB}tenantapi_key=x${TAB}`,
		]) {
			const message = unit.repeat(100_000);
			const t = performance.now();
			const printed = line(message, ["tenant"]).slice(LINE.length);
			expect(performance.now() - t, unit).toBeLessThan(3_000);
			expect(redactSecrets(printed, ["tenant"]), unit).toBe(printed);
		}
	}, 60_000);

	it("no match hides a marker inside it: each search goes on from inside its matches", () => {
		const SECRET = "S3CRET";
		// A marker inside a Bearer token: `api_key=` took `x-api-key:` for its value, and the search
		// went on after it, past the value that followed (5.1.0 replaced the token first).
		expect(redactSecrets(`Authorization: Bearer x.api_key= x-api-key: "${SECRET}"`)).toBe(
			'Authorization: Bearer [redacted] [redacted] "[redacted]"',
		);
		expect(line(`Bearer x.api_key=${C(10)}x-api-key: "${SECRET}"`)).toBe(
			`${LINE}Error: Bearer [redacted] [redacted] "[redacted]"`,
		);
		expect(line(`Bearer x.api_key= api-key: '${SECRET}'`)).toBe(
			`${LINE}Error: Bearer [redacted] [redacted] '[redacted]'`,
		);
		expect(line(`Bearer x.api-key: x-api-key='${SECRET}'`)).toBe(
			`${LINE}Error: Bearer [redacted] [redacted]'[redacted]'`,
		);
		// A marker inside an api-key value, and a Bearer that ends a token.
		expect(line(`api_key:TOK0${ESC}]0;t${BEL}x.X-A${C(9)}pi-Key = ${SECRET}`)).not.toContain(
			SECRET,
		);
		expect(redactSecrets(`api_key=x.x-api-key: ${SECRET}`)).toBe("api_key=[redacted] [redacted]");
		expect(redactSecrets(`Bearer a.Bearer ${SECRET}`)).toBe("Bearer [redacted] [redacted]");
		expect(line(`bearer TOK1&xx.BEARER${C(9)}${SECRET}`, ["earer"])).not.toContain(SECRET);
		// The same, with each removed character or sequence inside the inner or the outer marker, where
		// the marker reads whole once sanitized (a line break, or a CSI that takes the letter after it,
		// leaves no marker: 5.1.0 printed those too).
		const failed: string[] = [];
		let whole = 0;
		for (const inside of INSIDE) {
			for (const split of [
				(s: string) => `Bearer x.api_k${s}ey= x-api-key: "${SECRET}"`,
				(s: string) => `Bearer x.api_key= x-api${s}-key: "${SECRET}"`,
				(s: string) => `Bea${s}rer x.api_key= x-api-key: "${SECRET}"`,
				(s: string) => `Bearer x.Bea${s}rer ${SECRET}`,
				(s: string) => `api_key=x.x-api${s}-key: ${SECRET}`,
			]) {
				const message = split(inside);
				if (joinLines(scrubForStderr(message, Number.POSITIVE_INFINITY)) !== split("")) continue;
				whole++;
				const printed = line(message);
				if (printed.includes(SECRET)) failed.push(`${JSON.stringify(message)}: ${printed}`);
			}
		}
		expect(failed.slice(0, 10)).toEqual([]);
		expect(whole).toBeGreaterThan(5 * 60);
		// `redactApiKeys` alone still matches the old pattern, which went on after each value.
		expect(redactApiKeys(`api_key=x.x-api-key: ${SECRET}`)).toBe(`api_key=[redacted] ${SECRET}`);
	});

	it("searching from inside each match reads each value once: 100,000 units in under 3 seconds", () => {
		for (const unit of [
			"api_key=",
			"x-api-key: api_key=",
			"api_key=\"api_key='",
			"api_key='x-api-key=",
			"Bearer ",
			"Bearer x.Bearer ",
			"Bearer x.api_key= ",
		]) {
			const message = unit.repeat(100_000);
			const t = performance.now();
			const printed = line(message).slice(LINE.length);
			redactSecrets(message);
			expect(performance.now() - t, unit).toBeLessThan(3_000);
			expect(printed.includes("api_key=a"), unit).toBe(false);
		}
	}, 60_000);

	it("a marker sanitizing joins to a credential's end is read there, and its credential replaced", () => {
		// The original splits the marker, the spaced view splits it again, and the sanitized text glues
		// it to the credential before it. 5.1.0 replaced that credential first, and its `]` put a word
		// boundary before the marker.
		const ESCM = `${ESC}[m`;
		const rows: Array<[string, string[], string]> = [
			[`api_key: Q${C(9)}Bea${C(0)}rer TK1`, [], "api_key: [redacted]"],
			[`api_key:Q${C(9)}Bea${BEL}rer TK1`, ["x-api-key"], "api_key:[redacted]"],
			[`api_key=K${C(9)}bear${ESCM}er TK2`, ["abc"], "api_key=[redacted]"],
			[`api-key=Q${C(13)}be${BEL}arer TK1`, [], "api-key=[redacted]"],
			[`r${ESC}bearer Q${C(13)}B${ESCM}earer${C(10)}TK1`, [], "rbearer [redacted]"],
			[`r${BEL}bearer${C(9)}Q${C(13)}a${C(0x7f)}pi_key:"TK1`, ["Bearer"], "rbearer [redacted]"],
			// A chain: each token's end is looked at, not only the first one's.
			[`Bearer T0${C(9)}Bearer T1${C(9)}Bea${C(0)}rer T2`, [], "Bearer [redacted]"],
			[`api_key=T0${C(9)}api_key=T1${C(9)}Bea${C(0)}rer T2`, [], "api_key=[redacted]"],
			[`x bearer${C(9)}T0${C(11)}bearer T1${C(13)}Beare${C(0x1f)}r  T2`, [], "x bearer [redacted]"],
		];
		for (const [message, secrets, printed] of rows) {
			expect(line(message, secrets), JSON.stringify(message)).toBe(`${LINE}Error: ${printed}`);
		}
		// Each first credential, each removed character or sequence after it, and each marker split at
		// each position by each of them, where the marker reads whole once sanitized.
		const failed: string[] = [];
		let whole = 0;
		for (const first of ["api_key: Q", "api_key=Q", "x-api-key: 'Q", "Bearer Q", "Bearer x.Q"]) {
			for (const ender of INSIDE) {
				for (const [marker, sep] of MARKERS) {
					for (let p = 1; p < marker.length; p++) {
						for (const inside of [C(0), BEL, ESCM]) {
							const split = `${marker.slice(0, p)}${inside}${marker.slice(p)}`;
							const message = `${first}${ender}${split}${sep}${VALUE} end`;
							const read = joinLines(scrubForStderr(message, Number.POSITIVE_INFINITY));
							if (read !== `${first}${marker}${sep}${VALUE} end`) continue;
							whole++;
							const out = line(message);
							if (out.includes(VALUE)) failed.push(`${JSON.stringify(message)}: ${out}`);
						}
					}
				}
			}
		}
		expect(failed.slice(0, 10)).toEqual([]);
		expect(whole).toBeGreaterThan(5_000);
		// Read once: a run of such credentials, 100,000 of them, in under 3 seconds.
		for (const unit of [
			`api_key=a${C(9)}`,
			`Bearer a${C(9)}`,
			`x-api-key: a${C(0)}`,
			`api_key=a${C(9)}Bea${C(0)}rer `,
			`Bearer a${C(9)}api${BEL}_key=`,
			`api_key=a${C(9)}api_key="`,
			`api_key=a${C(9)}x-api-key: 'b' `,
		]) {
			const message = unit.repeat(100_000);
			const t = performance.now();
			line(message);
			expect(performance.now() - t, JSON.stringify(unit)).toBeLessThan(3_000);
		}
	}, 60_000);

	it("a marker right after the caller's key: the boundary the replacement makes is read in the text", () => {
		expect(line(`tenantBearer ${VALUE}`, ["tenant"])).toBe(
			`${LINE}Error: [redacted]Bearer [redacted]`,
		);
		expect(line(`tenantapi_key=${VALUE}`, ["tenant"])).toBe(
			`${LINE}Error: [redacted]api_key=[redacted]`,
		);
		// Positive control: no pattern finds either marker in the text as it is (no word boundary).
		expect(redactSecrets(`tenantBearer ${VALUE} tenantapi_key=${VALUE}`)).toBe(
			`tenantBearer ${VALUE} tenantapi_key=${VALUE}`,
		);
		const failed: string[] = [];
		let cases = 0;
		for (const [marker, sep] of [
			...MARKERS,
			["BEARER", " "] as [string, string],
			["X-Api-Key", ": "] as [string, string],
		]) {
			for (const p of [0, 1, 2]) {
				for (const inside of ["", ...INSIDE]) {
					const split = p === 0 ? marker : `${marker.slice(0, p)}${inside}${marker.slice(p)}`;
					if (p === 0 && inside !== "") continue;
					for (const secrets of [["tenant"], ["tenant", "nantB"], ["ten", "tenant"]]) {
						cases++;
						const message = `tenant${split}${sep}${VALUE} end`;
						const printed = line(message, secrets).slice(LINE.length);
						const whole = joinLines(scrubForStderr(message, Number.POSITIVE_INFINITY)).includes(
							`${marker}${sep}`,
						);
						if (redactSecrets(printed, secrets) !== printed)
							failed.push(`${JSON.stringify(message)}: not a fixed point`);
						if (whole && printed.includes(VALUE))
							failed.push(`${JSON.stringify(message)}: ${JSON.stringify(printed)}`);
					}
				}
			}
		}
		expect(failed.slice(0, 10)).toEqual([]);
		expect(cases).toBeGreaterThan(1_000);
	});

	it("the search after the key reads each value once: markers after a key 100,000 times, each in under 3 seconds", () => {
		// Each value after a key's match ran to the end of the text, and was read again from the next
		// match: `tenantapi-key=` 8,000 times took about 2 s, and the time grew as N squared.
		for (const unit of [
			"tenantapi-key=",
			'tenantapi-key="',
			"tenantapi-key='",
			"tenantapi-key=\"tenantapi-key='",
			"tenantx-api-key: ",
			"tenantBearer ",
			"tenantBearer x",
		]) {
			const message = unit.repeat(100_000);
			const t = performance.now();
			const printed = line(message, ["tenant"]).slice(LINE.length);
			expect(performance.now() - t, unit).toBeLessThan(3_000);
			expect(redactSecrets(printed, ["tenant"]), unit).toBe(printed);
		}
	}, 60_000);

	it("a key's overlapping matches end in order, and a marker after each is found", () => {
		expect(redactSecrets(`aaaBearer ${VALUE}`, ["aa"])).toBe("[redacted]Bearer [redacted]");
		expect(redactSecrets(`xyBearer ${VALUE} xyapi-key: ${VALUE}`, ["xy", "x"])).toBe(
			"[redacted]Bearer [redacted] [redacted]api-key: [redacted]",
		);
	});

	it("an unclosed quote at the end, found in both texts, is replaced once", () => {
		expect(line(`api_key="`)).toBe(`${LINE}Error: api_key="[redacted]"`);
		expect(line(`api_key="${BEL}`)).toBe(`${LINE}Error: api_key="[redacted]"`);
	});

	it("every control, DEL, C1 character and escape sequence inside each marker, with and without a key that swallows it", () => {
		const failed: string[] = [];
		let readable = 0;
		let withKey = 0;
		for (const [marker, sep] of MARKERS) {
			for (let p = 1; p < marker.length; p++) {
				for (const inside of INSIDE) {
					const split = `${marker.slice(0, p)}${inside}${marker.slice(p)}`;
					const message = `tenant ${split}${sep}${VALUE} end`;
					// Whether the marker and its value read whole once sanitized.
					const whole = joinLines(scrubForStderr(message, Number.POSITIVE_INFINITY)).includes(
						`${marker}${sep}${VALUE}`,
					);
					for (const secrets of [[], [`tenant${marker}`]]) {
						if (secrets.length > 0) withKey++;
						if (whole) readable++;
						const out = line(message, secrets);
						const printed = out.slice(LINE.length);
						const name = `${JSON.stringify(split)} key=${secrets.length}`;
						// No credential reads in what is printed: redacting it again changes nothing.
						if (redactSecrets(printed, secrets) !== printed)
							failed.push(`${name}: not a fixed point`);
						if (whole && printed.includes(VALUE))
							failed.push(`${name}: ${JSON.stringify(printed)}`);
					}
				}
			}
		}
		expect(failed.slice(0, 10)).toEqual([]);
		// The sweep reaches the markers the sanitizing joins, with and without a key.
		expect(readable).toBeGreaterThan(2_000);
		expect(withKey).toBeGreaterThan(1_000);
	});
});

describe("sanitizeMapped", () => {
	/** Texts holding every character INSIDE holds, between letters and line breaks, and pairs. */
	function corpus(): string[] {
		const parts = [
			...INSIDE,
			"a",
			"B",
			"[",
			"]",
			"1",
			";",
			"\n",
			" ",
			C(0xd83d, 0xde00),
			C(0xd83d),
		];
		let seed = 4_242;
		const next = (): number => {
			seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
			return seed;
		};
		const out: string[] = [];
		for (let i = 0; i < 20_000; i++) {
			let t = "";
			const n = next() % 24;
			for (let k = 0; k < n; k++) t += parts[next() % parts.length];
			out.push(t);
		}
		return out;
	}

	it("gives scrubForStderr's text, and each of its units at the unit of the original it was", () => {
		const failed: string[] = [];
		for (const text of corpus()) {
			const { clean, at } = sanitizeMapped(text);
			let ok =
				clean === scrubForStderr(text, Number.POSITIVE_INFINITY) && at.length === clean.length;
			for (let j = 0; ok && j < clean.length; j++) {
				const from = at[j] ?? -1;
				const was = text[from];
				const lineBreak = was === C(0x2028) || was === C(0x2029);
				ok =
					(j === 0 || from > (at[j - 1] ?? -1)) &&
					(was === clean[j] || (lineBreak && clean[j] === "\n"));
			}
			if (!ok) failed.push(JSON.stringify(text));
		}
		expect(failed.slice(0, 5)).toEqual([]);
	});

	it("a part found in the sanitized text maps back to exactly the original characters it read", () => {
		const message = `x Bea${C(0)}rer ${VALUE} and x-api${ESC}[31m-key: ${VALUE}`;
		const { clean, at } = sanitizeMapped(message);
		for (const word of ["Bearer", "x-api-key", VALUE]) {
			const j = clean.indexOf(word);
			expect(j).toBeGreaterThan(-1);
			const back = Array.from({ length: word.length }, (_, k) => message[at[j + k] ?? -1]).join("");
			expect(back).toBe(word);
		}
	});
});
