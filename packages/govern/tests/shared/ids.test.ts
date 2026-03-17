import { describe, it, expect } from "vitest";
import { tbId, governId, fnv1a32 } from "../../src/shared/ids.js";

describe("tbId", () => {
	it("returns a bigint", () => {
		expect(typeof tbId()).toBe("bigint");
	});
	it("returns time-ordered values", () => {
		const a = tbId();
		const b = tbId();
		expect(b).toBeGreaterThan(a);
	});
});

describe("governId", () => {
	it("returns prefixed string ID", () => {
		const id = governId("tx");
		expect(id).toMatch(/^tx_[a-z0-9]+_[a-f0-9]+$/);
	});
});

describe("fnv1a32", () => {
	it("returns deterministic u32", () => {
		expect(fnv1a32("hello")).toBe(fnv1a32("hello"));
	});
	it("returns different values for different inputs", () => {
		expect(fnv1a32("hello")).not.toBe(fnv1a32("world"));
	});
});
