// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import {
	decodeUrlState,
	EMPTY_URL_STATE,
	encodeUrlState,
	MAX_HASH_LENGTH,
	planHistory,
	sameUrlState,
	type UrlState,
} from "../src/shared/url-state.js";

const H = "a1".repeat(32);

const FULL: UrlState = {
	view: "trends",
	open: H,
	filters: {
		search: "gpt 4 & co",
		kinds: ["llm_call", "tool_use"],
		models: ["claude-sonnet-4-6"],
		actors: ["agent-7"],
		statuses: ["denied", "failed"],
		jobTypes: ["review", "untyped"],
		typeSources: ["declared"],
		from: "2026-11-01",
		to: "2026-11-30",
		costMin: 0,
		costMax: 5000,
	},
};

function withFilters(f: Partial<FilterState>): UrlState {
	return { ...EMPTY_URL_STATE, filters: { ...EMPTY_FILTERS, ...f } };
}

describe("encodeUrlState / decodeUrlState", () => {
	it("round-trips every field", () => {
		expect(decodeUrlState(encodeUrlState(FULL))).toEqual(FULL);
	});

	it("round-trips each field on its own", () => {
		const cases: UrlState[] = [
			{ ...EMPTY_URL_STATE, view: "trends" },
			{ ...EMPTY_URL_STATE, open: H },
			withFilters({ search: "gpt" }),
			withFilters({ kinds: ["llm_call"] }),
			withFilters({ models: ["m"] }),
			withFilters({ actors: ["a"] }),
			withFilters({ statuses: ["failed"] }),
			withFilters({ jobTypes: ["review"] }),
			withFilters({ typeSources: ["declared"] }),
			withFilters({ from: "2026-02-28" }),
			withFilters({ to: "2024-02-29" }),
			withFilters({ costMin: 0 }),
			withFilters({ costMax: 12 }),
		];
		for (const c of cases) expect(decodeUrlState(encodeUrlState(c))).toEqual(c);
	});

	it("round-trips awkward text (separators, unicode, percent signs)", () => {
		const s = withFilters({ search: "a&b=c#d%e+f é 日本", actors: ["x=y&z"] });
		expect(decodeUrlState(encodeUrlState(s))).toEqual(s);
	});

	it("gives an empty hash for the defaults, and decodes an empty hash to the defaults", () => {
		expect(encodeUrlState(EMPTY_URL_STATE)).toBe("");
		expect(decodeUrlState("")).toEqual(EMPTY_URL_STATE);
		expect(decodeUrlState("#")).toEqual(EMPTY_URL_STATE);
		expect(encodeUrlState({ ...EMPTY_URL_STATE, view: "audit" })).toBe("");
	});

	it("writes the documented format", () => {
		const s: UrlState = {
			view: "trends",
			open: H,
			filters: {
				...EMPTY_FILTERS,
				statuses: ["failed", "denied"],
				search: "gpt",
				from: "2026-11-01",
			},
		};
		expect(encodeUrlState(s)).toBe(
			`#from=2026-11-01&open=${H}&q=gpt&status=denied&status=failed&view=trends`,
		);
	});

	it("is stable: the same state gives the same hash whatever order it was built in", () => {
		const a = withFilters({ statuses: ["failed", "denied", "failed"], kinds: ["b", "a"] });
		const b = withFilters({ kinds: ["a", "b"], statuses: ["denied", "failed"] });
		expect(encodeUrlState(a)).toBe(encodeUrlState(b));
		expect(encodeUrlState(a)).toBe("#kind=a&kind=b&status=denied&status=failed");
		// Encoding the decoded hash gives the hash back.
		const hash = encodeUrlState(FULL);
		expect(encodeUrlState(decodeUrlState(hash))).toBe(hash);
		// A hand-written order is read, and normalised on the next write.
		const hand = decodeUrlState("#view=trends&status=failed&status=denied&q=gpt");
		expect(encodeUrlState(hand)).toBe("#q=gpt&status=denied&status=failed&view=trends");
	});

	it("accepts the hash with or without its leading #", () => {
		expect(decodeUrlState("view=trends")).toEqual(decodeUrlState("#view=trends"));
		expect(decodeUrlState("#view=trends").view).toBe("trends");
	});

	it("keeps a cost of zero (a bound, not an absent one)", () => {
		const s = withFilters({ costMin: 0 });
		expect(encodeUrlState(s)).toBe("#min=0");
		expect(decodeUrlState("#min=0").filters.costMin).toBe(0);
	});
});

describe("decodeUrlState on untrusted input", () => {
	it("falls back to the audit view for an unknown view", () => {
		for (const v of ["", "admin", "Trends", "TRENDS", "audit,trends", "__proto__"]) {
			expect(decodeUrlState(`#view=${v}`).view).toBe("audit");
		}
	});

	it("drops a date that is not a real YYYY-MM-DD day", () => {
		for (const d of [
			"2026-13-01",
			"2026-02-30",
			"2025-02-29",
			"2026-1-1",
			"20261101",
			"2026-11-01T00:00:00Z",
			"yesterday",
			"",
			" 2026-11-01",
			"2026-11-01 ",
			"-2026-11-01",
		]) {
			const f = decodeUrlState(
				`#from=${encodeURIComponent(d)}&to=${encodeURIComponent(d)}`,
			).filters;
			expect(f.from, `from=${d}`).toBeUndefined();
			expect(f.to, `to=${d}`).toBeUndefined();
		}
		expect(decodeUrlState("#from=2024-02-29").filters.from).toBe("2024-02-29");
	});

	it("drops a cost bound that is not a finite non-negative integer", () => {
		for (const c of [
			"-1",
			"-0",
			"1.5",
			"1e3",
			"0x10",
			"+5",
			"007",
			"NaN",
			"Infinity",
			"",
			" 5",
			"5 ",
			"9007199254740993",
			"99999999999999999999999",
			`1${"0".repeat(400)}`,
		]) {
			const f = decodeUrlState(
				`#min=${encodeURIComponent(c)}&max=${encodeURIComponent(c)}`,
			).filters;
			expect(f.costMin, `min=${c}`).toBeUndefined();
			expect(f.costMax, `max=${c}`).toBeUndefined();
		}
		expect(decodeUrlState("#max=9007199254740991").filters.costMax).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("drops an open hash that is not 64 lowercase hex", () => {
		for (const o of [
			"",
			"abc",
			H.slice(1),
			`${H}0`,
			H.toUpperCase(),
			`${"g".repeat(64)}`,
			`${H.slice(0, 62)}<>`,
			`"><script>alert(1)</script>`,
		]) {
			expect(decodeUrlState(`#open=${encodeURIComponent(o)}`).open, `open=${o}`).toBeNull();
		}
		expect(decodeUrlState(`#open=${H}`).open).toBe(H);
	});

	it("ignores unknown keys and keeps the known ones beside them", () => {
		const s = decodeUrlState(
			`#evil=1&__proto__=x&constructor=y&view=trends&status=failed&open=${H}&x[0]=1`,
		);
		expect(s).toEqual({ ...withFilters({ statuses: ["failed"] }), view: "trends", open: H });
		expect(decodeUrlState("#evil=1&only=unknown")).toEqual(EMPTY_URL_STATE);
	});

	it("ignores a hash over the cap, whole", () => {
		const long = `#view=trends&q=${"a".repeat(MAX_HASH_LENGTH)}`;
		expect(long.length).toBeGreaterThan(MAX_HASH_LENGTH);
		expect(decodeUrlState(long)).toEqual(EMPTY_URL_STATE);
		const atCap = `#view=trends${"&x=1".repeat(10)}`;
		expect(atCap.length).toBeLessThanOrEqual(MAX_HASH_LENGTH);
		expect(decodeUrlState(atCap).view).toBe("trends");
	});

	it("bounds the work inside the cap: value count and length", () => {
		const many = `#${Array.from({ length: 300 }, (_, i) => `status=s${String(i).padStart(3, "0")}`).join("&")}`;
		expect(many.length).toBeLessThanOrEqual(MAX_HASH_LENGTH);
		expect(decodeUrlState(many).filters.statuses.length).toBeLessThanOrEqual(100);
		expect(decodeUrlState(`#actor=${"x".repeat(300)}`).filters.actors).toEqual([]);
		expect(decodeUrlState(`#q=${"x".repeat(600)}`).filters.search).toBe("");
	});

	it("drops empty facet values and invisible characters", () => {
		expect(decodeUrlState("#status=&status=failed").filters.statuses).toEqual(["failed"]);
		for (const bad of ["%00", "%0A", "%E2%80%AE", "%E2%80%8B", "%E2%80%A8", "%C2%85"]) {
			expect(decodeUrlState(`#actor=a${bad}b&q=x${bad}`).filters, bad).toEqual(EMPTY_FILTERS);
		}
	});

	it("keeps markup-looking values as plain strings (they are only compared, never rendered here)", () => {
		const s = decodeUrlState(`#actor=${encodeURIComponent("<img src=x onerror=alert(1)>")}`);
		expect(s.filters.actors).toEqual(["<img src=x onerror=alert(1)>"]);
	});

	it("never throws, and a malformed hash gives usable defaults", () => {
		const garbage = [
			"#%E0%A4%A",
			"#%",
			"#%%%",
			"#=",
			"#&&&",
			"#==&=",
			"#view",
			"#view=%",
			"#q=%E0%A4%A",
			"#\u0000",
			"#" + "%E0%A4%A".repeat(400),
			"not a hash",
			"##",
		];
		for (const g of garbage) {
			expect(() => decodeUrlState(g), g).not.toThrow();
			const s = decodeUrlState(g);
			expect(["audit", "trends"]).toContain(s.view);
			expect(Array.isArray(s.filters.kinds)).toBe(true);
			expect(typeof s.filters.search).toBe("string");
		}
		expect(decodeUrlState("#%E0%A4%A")).toEqual(EMPTY_URL_STATE);
		// Not strings at all (a caller passing the wrong thing).
		expect(() => decodeUrlState(undefined as unknown as string)).not.toThrow();
		expect(decodeUrlState(null as unknown as string)).toEqual(EMPTY_URL_STATE);
	});

	it("does not share mutable state with the defaults", () => {
		const s = decodeUrlState("#status=failed");
		expect(s.filters.statuses).toEqual(["failed"]);
		expect(EMPTY_FILTERS.statuses).toEqual([]);
		expect(decodeUrlState("").filters.statuses).toEqual([]);
	});
});

describe("encodeUrlState on bad state", () => {
	it("leaves out what decoding would refuse", () => {
		const bad = withFilters({ from: "tomorrow", costMin: -1, costMax: 1.5 });
		expect(encodeUrlState({ ...bad, open: "nope" })).toBe("");
	});
});

describe("planHistory", () => {
	const none = EMPTY_URL_STATE;

	it("replaces the entry for a filter tweak", () => {
		const next = withFilters({ search: "g" });
		expect(planHistory(none, next, "")).toEqual({ kind: "replace", hash: "#q=g" });
		expect(planHistory(next, withFilters({ search: "gp" }), "#q=g")).toEqual({
			kind: "replace",
			hash: "#q=gp",
		});
	});

	it("pushes an entry when the view changes", () => {
		expect(planHistory(none, { ...none, view: "trends" }, "")).toEqual({
			kind: "push",
			hash: "#view=trends",
		});
		expect(planHistory({ ...none, view: "trends" }, none, "#view=trends")).toEqual({
			kind: "push",
			hash: "",
		});
	});

	it("pushes an entry when a record opens, changes or closes", () => {
		const open = { ...none, open: H };
		expect(planHistory(none, open, "").kind).toBe("push");
		expect(planHistory(open, { ...none, open: "b2".repeat(32) }, `#open=${H}`).kind).toBe("push");
		expect(planHistory(open, none, `#open=${H}`)).toEqual({ kind: "push", hash: "" });
	});

	it("writes nothing when the address already describes the state", () => {
		// The state came from Back, Forward or an edited hash...
		expect(planHistory(none, FULL, encodeUrlState(FULL)).kind).toBe("none");
		// ...even if the hand-edited hash is in another order.
		expect(planHistory(none, decodeUrlState("#view=trends&q=a"), "#view=trends&q=a").kind).toBe(
			"none",
		);
		expect(planHistory(none, none, "").kind).toBe("none");
		// A hash that decodes to the defaults (garbage) needs no write for the defaults.
		expect(planHistory(none, none, "#%E0%A4%A").kind).toBe("none");
	});

	it("replaces a stale address with the state's hash when only filters differ", () => {
		expect(planHistory(none, withFilters({ search: "x" }), "#q=y").kind).toBe("replace");
	});
});

describe("sameUrlState", () => {
	it("compares by the hash they write", () => {
		expect(sameUrlState(FULL, decodeUrlState(encodeUrlState(FULL)))).toBe(true);
		expect(sameUrlState(FULL, EMPTY_URL_STATE)).toBe(false);
	});
});
