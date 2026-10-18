// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `redactSecrets` NEVER THROWS ON A LONG MESSAGE AND NEVER RETURNS TEXT IT DID NOT SCAN.
 *
 * `API_KEY_VALUE` has a quantified group with an alternation inside it, and V8 throws RangeError
 * (call stack exhausted) running it over an unclosed quoted value of about 10 million characters.
 * An error message can quote what a caller sent, so the server's error log ran it on caller-sized
 * text. Pinned:
 * - The known secrets are replaced in the whole text; then only the first REDACT_INPUT_MAX code
 *   units are kept, marked ` [cut]`, before the patterns run. A value the cut leaves unclosed is
 *   still redacted to its end.
 * - The real case end to end: a 10.4M-character unclosed `x-api-key` value is redacted, where the
 *   pattern alone throws on it.
 * - Should the patterns still throw RangeError (forced by a stub of RegExp.prototype.exec), the
 *   whole text is replaced. Any other error still throws.
 * - internalErrorLine cuts nothing until no key can come back together: a caller's key split by
 *   an escape sequence, which sanitizing joins, is replaced whole across both cuts (the patterns'
 *   REDACT_INPUT_MAX and the printed MAX_PRINTED_CHARS). The key is also replaced before
 *   sanitizing (an escape sequence can eat its first character) and after the lines are joined.
 *   And the line join, quadratic on a whitespace run with no newline, runs only on clipped text:
 *   500k spaces finish fast.
 */

import { describe, expect, it } from "vitest";
import { MAX_PRINTED_CHARS } from "../src/cli/scrub.js";
import {
	API_KEY_VALUE,
	internalErrorLine,
	REDACT_INPUT_MAX,
	redactSecrets,
} from "../src/server.js";

const MARKER = "throw-here";
const UNREADABLE = "[redacted: the message could not be scanned]";

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

describe("redactSecrets on a long message", () => {
	it("redacts a 10.4M-character unclosed api-key value the pattern alone cannot finish", () => {
		const text = `upstream said: x-api-key: "${"a".repeat(10_400_000)}`;
		// The control: the pattern alone overflows on this text.
		expect(() => text.replace(API_KEY_VALUE, "")).toThrow(RangeError);
		const out = redactSecrets(text);
		expect(out).toBe('upstream said: x-api-key: "[redacted]"');
	});

	it("keeps the first REDACT_INPUT_MAX code units, marked as cut", () => {
		const out = redactSecrets("a".repeat(REDACT_INPUT_MAX + 10));
		expect(out).toBe(`${"a".repeat(REDACT_INPUT_MAX)} [cut]`);
		expect(redactSecrets("a".repeat(REDACT_INPUT_MAX))).toBe("a".repeat(REDACT_INPUT_MAX));
	});

	it("replaces a known secret across the cut before cutting", () => {
		const secret = "tenant-key-0123456789";
		const out = redactSecrets(`${"a".repeat(REDACT_INPUT_MAX - 5)}${secret} after`, [secret]);
		expect(out).toBe(`${"a".repeat(REDACT_INPUT_MAX - 5)}[reda [cut]`);
		expect(out).not.toContain(secret.slice(0, 5));
	});

	it("redacts a value the cut leaves unclosed to its end", () => {
		const head = "a ".repeat((REDACT_INPUT_MAX - 20) / 2);
		// The cut keeps `x-api-key: "abcdefgh`; the unclosed quoted value runs to the end of the
		// text, over the cut mark, and is redacted whole.
		const out = redactSecrets(`${head}x-api-key: "abcdefghijklmnopqrstuvwxyz"`);
		expect(out).toBe(`${head}x-api-key: "[redacted]"`);
		const bearer = redactSecrets(`${head}Bearer abcdefghijklmnopqrstuvwxyz`);
		expect(bearer).toBe(`${head}Bearer [redacted] [cut]`);
	});

	it("keeps internalErrorLine's line bounded and redacted", () => {
		const line = internalErrorLine(
			new Error(`x-api-key: "${"a".repeat(10_400_000)}`),
			"tenant-1",
			"POST /v1/authorize",
		);
		expect(line).toBe(
			'usertrust-server: internal error: tenant=tenant-1 route=POST /v1/authorize: Error: x-api-key: "[redacted]"',
		);
	});
});

describe("internalErrorLine cuts only after no key can come back together", () => {
	const secret = "tenant-key-0123456789";
	// The caller's key, split by an escape sequence: no split on `secret` finds it until the
	// sequence is removed.
	const splitKey = "tenant-key-01234\x1b[0m56789";
	const prefix = "Error: ";

	it("replaces a split key whose first part lies before REDACT_INPUT_MAX", () => {
		// NUL padding the sanitizer removes puts the key's first 15 code units before the cut.
		const pad = "\0".repeat(REDACT_INPUT_MAX - prefix.length - 15);
		const line = internalErrorLine(new Error(`${pad}${splitKey}`), "t", "POST /v1/authorize", [
			secret,
		]);
		expect(line).toBe(
			"usertrust-server: internal error: tenant=t route=POST /v1/authorize: Error: [redacted]",
		);
		expect(line).not.toContain("tenant-key");
	});

	it("replaces a split key whose first part lies before MAX_PRINTED_CHARS", () => {
		const pad = "x".repeat(MAX_PRINTED_CHARS - prefix.length - 10);
		const line = internalErrorLine(
			new Error(`${pad}${splitKey} after`),
			"t",
			"POST /v1/authorize",
			[secret],
		);
		expect(line).toBe(
			`usertrust-server: internal error: tenant=t route=POST /v1/authorize: Error: ${pad}[redacted]\u2026`,
		);
		expect(line).not.toContain("tenant-key");
	});

	it("replaces a key before sanitizing, where an escape sequence would eat its first character", () => {
		// `ESC T` is a whole escape sequence: removing it leaves `enant-...`, which no later split
		// on the key can find. Replaced first, the key is gone; the ESC left before the marker then
		// reads `ESC [ r` as one sequence and takes the marker's first two characters with it.
		const key = "Tenant-key-0123456789";
		const line = internalErrorLine(new Error(`\x1b${key}`), "t", "POST /v1/authorize", [key]);
		expect(line).toBe(
			"usertrust-server: internal error: tenant=t route=POST /v1/authorize: Error: edacted]",
		);
		expect(line).not.toContain("enant-key");
	});

	it("replaces a key again after the lines are joined", () => {
		// Joining turns the line break inside this key into the space the key holds.
		const key = "tenant key-0123456789";
		const line = internalErrorLine(new Error("tenant\nkey-0123456789"), "t", "POST /v1/authorize", [
			key,
		]);
		expect(line).toBe(
			"usertrust-server: internal error: tenant=t route=POST /v1/authorize: Error: [redacted]",
		);
	});

	it("joins lines only on clipped text, so a long whitespace run finishes fast", () => {
		const started = performance.now();
		const line = internalErrorLine(
			new Error(`${" ".repeat(500_000)}end`),
			"t",
			"POST /v1/authorize",
		);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(line).toBe(
			`usertrust-server: internal error: tenant=t route=POST /v1/authorize: Error: ${" ".repeat(MAX_PRINTED_CHARS - prefix.length)}\u2026`,
		);
	}, 30_000);
});

describe("redactSecrets when its patterns throw", () => {
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
