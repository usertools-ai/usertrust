import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";

describe("canonicalize", () => {
	it("sorts object keys alphabetically", () => {
		const result = canonicalize({ b: 2, a: 1 });
		expect(result).toBe('{"a":1,"b":2}');
	});

	it("handles nested objects with sorted keys", () => {
		const result = canonicalize({ z: { b: 2, a: 1 }, a: 0 });
		expect(result).toBe('{"a":0,"z":{"a":1,"b":2}}');
	});

	it("strips undefined values from objects", () => {
		const result = canonicalize({ a: 1, b: undefined, c: 3 });
		expect(result).toBe('{"a":1,"c":3}');
	});

	it("preserves null values", () => {
		const result = canonicalize({ a: null });
		expect(result).toBe('{"a":null}');
	});

	it("handles top-level null", () => {
		expect(canonicalize(null)).toBe("null");
	});

	it("handles top-level undefined", () => {
		expect(canonicalize(undefined)).toBe(undefined);
	});

	it("handles primitives", () => {
		expect(canonicalize(42)).toBe("42");
		expect(canonicalize("hello")).toBe('"hello"');
		expect(canonicalize(true)).toBe("true");
		expect(canonicalize(false)).toBe("false");
	});

	it("handles arrays — preserves order, recurses into elements", () => {
		const result = canonicalize([{ b: 2, a: 1 }, 3, "x"]);
		expect(result).toBe('[{"a":1,"b":2},3,"x"]');
	});

	it("handles empty array", () => {
		expect(canonicalize([])).toBe("[]");
	});

	it("handles nested arrays", () => {
		const result = canonicalize([[1, 2], [3]]);
		expect(result).toBe("[[1,2],[3]]");
	});

	it("handles array with null and undefined elements", () => {
		const result = canonicalize([null, undefined, 1]);
		// canonicalize maps each element individually — undefined becomes the string "undefined"
		// (from JSON.stringify(undefined)) and is joined without extra quoting
		expect(result).toBe("[null,,1]");
	});

	it("handles empty object", () => {
		expect(canonicalize({})).toBe("{}");
	});

	it("is deterministic — same input always produces same output", () => {
		const input = { z: [3, 2, 1], a: { y: "hello", x: true } };
		const r1 = canonicalize(input);
		const r2 = canonicalize(input);
		expect(r1).toBe(r2);
	});
});
