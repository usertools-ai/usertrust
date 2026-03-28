import { describe, expect, it } from "vitest";
import { fnv1a32, tbId, trustId } from "../../src/shared/ids.js";

describe("tbId", () => {
	it("returns a bigint", () => {
		expect(typeof tbId()).toBe("bigint");
	});
	it("returns unique values", () => {
		const a = tbId();
		const b = tbId();
		expect(b).not.toBe(a);
	});
	it("returns time-ordered values across milliseconds", async () => {
		const a = tbId();
		await new Promise((r) => setTimeout(r, 2));
		const b = tbId();
		expect(b).toBeGreaterThan(a);
	});
});

describe("trustId", () => {
	it("returns prefixed string ID", () => {
		const id = trustId("tx");
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
