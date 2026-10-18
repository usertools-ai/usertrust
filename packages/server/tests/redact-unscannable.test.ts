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
 * - `internalErrorLine` redacts before sanitizing, while the delimiters the patterns read are still
 *   there (`Bearer\t<token>`); sanitizes the whole text and redacts again, so a key a control
 *   character split is found once joined; and cuts only after that, at the printed clip. Its line
 *   join, quadratic on a whitespace run with no newline, runs only on clipped text: 500k spaces
 *   finish fast.
 */

import { describe, expect, it } from "vitest";
import { MAX_PRINTED_CHARS } from "../src/cli/scrub.js";
import { internalErrorLine, redactApiKeys, redactSecrets } from "../src/server.js";
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
		expect(redactApiKeys(unclosed)).toBe('x-api-key: "[redacted]"');
		expect(redactApiKeys(`${escapes}' after`)).toBe("api_key='[redacted]' after");
		expect(redactApiKeys(`x-api-key=${"a".repeat(N)} after`)).toBe("x-api-key=[redacted] after");
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
		expect(line(`x-api-key: "${"a".repeat(N)}`)).toBe(`${LINE}Error: x-api-key: "[redacted]"`);
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

	it("replaces a key again after the lines are joined", () => {
		// Joining turns the line break inside this key into the space the key holds.
		expect(line("tenant\nkey-0123456789", ["tenant key-0123456789"])).toBe(
			`${LINE}Error: [redacted]`,
		);
	});

	it("joins lines only on clipped text, so a long whitespace run finishes fast", () => {
		const started = performance.now();
		const out = line(`${" ".repeat(500_000)}end`);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(out).toBe(`${LINE}Error: ${" ".repeat(MAX_PRINTED_CHARS - "Error: ".length)}\u2026`);
	}, 30_000);
});
