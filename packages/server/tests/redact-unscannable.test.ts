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
 */

import { describe, expect, it } from "vitest";
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
