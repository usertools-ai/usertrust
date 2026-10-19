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
 * - `internalErrorLine` redacts before sanitizing, while the delimiters the patterns read are still
 *   there (`Bearer\t<token>`); sanitizes the whole text and redacts again, so a key a control
 *   character split is found once joined; joins the lines and redacts again; and cuts only after
 *   that, at the printed clip.
 */

import { describe, expect, it } from "vitest";
import { MAX_PRINTED_CHARS } from "../src/cli/scrub.js";
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

	it("replaces a key before sanitizing, where an escape sequence would eat its first character", () => {
		// `ESC T` is one escape sequence: removing it leaves `enant-...`, which no later split on the
		// key can find. Replaced first, the key is gone; the ESC left before the marker then reads
		// `ESC [ r` as one sequence and takes the marker's first two characters with it.
		const key = "Tenant-key-0123456789";
		const out = line(`\x1b${key}`, [key]);
		expect(out).toBe(`${LINE}Error: edacted]`);
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
