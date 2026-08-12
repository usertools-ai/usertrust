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

	// INVERTED (was: `expect(canonicalize(undefined)).toBe(undefined)`). That green
	// assertion PINNED the defect: canonicalize is typed `=> string` and returned a
	// non-string, which is exactly how `{"f":undefined}` reached the audit log.
	// `undefined` has no JSON representation, so it throws — same rule as NaN.
	it("throws on top-level undefined — JSON cannot represent it", () => {
		expect(() => canonicalize(undefined)).toThrow(/not representable in audit data/);
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

	// INVERTED (was: `expect(result).toBe("[null,,1]")`). `[null,,1]` is not JSON —
	// that assertion pinned the defect. An in-array `undefined` is absence AT A
	// POSITION, which JSON writes as `null`; the position itself cannot be dropped
	// without silently re-indexing every element after it.
	it("writes an in-array undefined as null", () => {
		const result = canonicalize([null, undefined, 1]);
		expect(result).toBe("[null,null,1]");
		expect(() => JSON.parse(result)).not.toThrow();
	});

	it("writes an array HOLE as null — Array.map skips holes, an index loop does not", () => {
		// A real hole, not an explicit undefined: `[1,,2]` as a literal, built by
		// index assignment because sparse array literals are a lint error.
		const holey: number[] = [];
		holey[0] = 1;
		holey[2] = 2;
		expect(1 in holey).toBe(false);
		expect(canonicalize({ arr: holey })).toBe('{"arr":[1,null,2]}');
	});

	it("throws on a function value — never omits it", () => {
		// Omitting the key would sign a document missing a member the caller
		// believed they committed. Same defect class as `{"f":undefined}`.
		expect(() => canonicalize({ f: () => 1 })).toThrow(/not representable in audit data/);
		expect(() => canonicalize(() => 1)).toThrow(/not representable in audit data/);
		expect(() => canonicalize([() => 1])).toThrow(/not representable in audit data/);
	});

	it("throws on a symbol value — never omits it", () => {
		expect(() => canonicalize({ s: Symbol("x") })).toThrow(/not representable in audit data/);
		expect(() => canonicalize(Symbol("x"))).toThrow(/not representable in audit data/);
		expect(() => canonicalize([Symbol("x")])).toThrow(/not representable in audit data/);
	});

	it("never returns a string that fails JSON.parse", () => {
		const holey: unknown[] = [];
		holey[0] = 1;
		holey[2] = { a: [null, undefined] };
		const inputs: unknown[] = [
			{ arr: holey },
			[null, undefined, 1],
			{ nested: { deep: [undefined, [undefined]] } },
			{ a: undefined, b: 1 },
			{},
			[],
		];
		for (const input of inputs) {
			expect(() => JSON.parse(canonicalize(input))).not.toThrow();
		}
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
