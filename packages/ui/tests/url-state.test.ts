// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import {
	addressHolds,
	decodeUrlState,
	EMPTY_URL_STATE,
	encodeUrlState,
	MAX_HASH_LENGTH,
	MAX_SEARCH_LENGTH,
	planHistory,
	sameUrlState,
	type UrlState,
} from "../src/shared/url-state.js";

const H = "a1".repeat(32);

const FULL: UrlState = {
	view: "trends",
	open: H,
	at: 4182,
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
			at: null,
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

	it("drops a cost bound that is not canonical non-negative decimal text", () => {
		for (const c of [
			"-1",
			"-0",
			"-1.5",
			"1.50",
			".5",
			"1.",
			"0.0",
			"01.5",
			"1e-7",
			"1,5",
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
		// A fraction the filter bar accepts is kept: the bar takes 1.5 as typed.
		expect(decodeUrlState("#min=1.5&max=0.25").filters).toMatchObject({
			costMin: 1.5,
			costMax: 0.25,
		});
		expect(decodeUrlState("#min=0").filters.costMin).toBe(0);
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
		const bad = withFilters({ from: "tomorrow", costMin: -1, costMax: 1e-7 });
		expect(encodeUrlState({ ...bad, open: "nope" })).toBe("");
		expect(encodeUrlState(withFilters({ costMin: Number.NaN, costMax: 1e21 }))).toBe("");
	});

	it("writes a fractional cost bound the filter bar accepted", () => {
		expect(encodeUrlState(withFilters({ costMin: 1.5 }))).toBe("#min=1.5");
		expect(encodeUrlState(withFilters({ costMax: 0.1 + 0.2 }))).toBe("#max=0.30000000000000004");
	});
});

/**
 * The encoder never writes a link that decodes to something else (review of #510: a search past 512 characters
 * vanished on reload, and about 460 Japanese characters pushed the fragment past the old 4 KiB cap, resetting
 * everything). Every cap is tested on both sides, with multi-byte text.
 */
describe("addressHolds: what is written decodes to the same state", () => {
	const JA = String.fromCodePoint(0x3042); // a 3-byte UTF-8 character: 9 characters percent-encoded
	const EMOJI = String.fromCodePoint(0x1f600); // two UTF-16 code units, 4 UTF-8 bytes
	const roundTrips = (s: UrlState): void => {
		expect(addressHolds(s)).toBe(true);
		const hash = encodeUrlState(s);
		expect(hash.length).toBeLessThanOrEqual(MAX_HASH_LENGTH);
		expect(sameUrlState(decodeUrlState(hash), s)).toBe(true);
		expect(decodeUrlState(hash).filters.search).toBe(s.filters.search);
		expect(planHistory(EMPTY_URL_STATE, s, "").hash).toBe(hash);
	};
	const notHeld = (s: UrlState): void => {
		expect(addressHolds(s)).toBe(false);
		// Nothing is written for it: a reload opens a clean page, never a different filter set.
		expect(planHistory(EMPTY_URL_STATE, s, "#q=old")).toEqual({ kind: "replace", hash: "" });
		expect(planHistory(EMPTY_URL_STATE, s, "").kind).toBe("none");
	};

	it("the full state and the empty state", () => {
		roundTrips(FULL);
		expect(addressHolds(EMPTY_URL_STATE)).toBe(true);
	});

	it("search: the box's cap round-trips in any script; one past it is not written", () => {
		roundTrips(withFilters({ search: "a".repeat(MAX_SEARCH_LENGTH) }));
		roundTrips(withFilters({ search: JA.repeat(MAX_SEARCH_LENGTH) }));
		roundTrips({ ...FULL, filters: { ...FULL.filters, search: JA.repeat(MAX_SEARCH_LENGTH) } });
		roundTrips(withFilters({ search: EMOJI.repeat(MAX_SEARCH_LENGTH / 2) }));
		// The review's case: about 460 Japanese characters once reset the whole page.
		roundTrips(withFilters({ search: JA.repeat(460) }));
		notHeld(withFilters({ search: "a".repeat(MAX_SEARCH_LENGTH + 1) }));
		notHeld(withFilters({ search: JA.repeat(MAX_SEARCH_LENGTH + 1) }));
	});

	it("search: characters a link cannot carry are not written", () => {
		notHeld(withFilters({ search: `a${String.fromCodePoint(0x200b)}b` }));
		notHeld(withFilters({ search: `a${String.fromCodePoint(0x202e)}b` }));
		notHeld(withFilters({ search: `a${String.fromCharCode(0xd800)}b` })); // a lone surrogate
	});

	it("facets: the value-length and value-count caps, both sides, multi-byte included", () => {
		roundTrips(withFilters({ actors: ["x".repeat(256)] }));
		roundTrips(withFilters({ actors: [JA.repeat(256)] }));
		notHeld(withFilters({ actors: ["x".repeat(257)] }));
		const n = (k: number): string[] =>
			Array.from({ length: k }, (_, i) => `m${String(i).padStart(3, "0")}`);
		roundTrips(withFilters({ models: n(100) }));
		notHeld(withFilters({ models: n(101) }));
		notHeld(withFilters({ kinds: [`a${String.fromCodePoint(0x2028)}b`] }));
		// Duplicates are one value, not a loss.
		roundTrips(withFilters({ statuses: ["failed", "failed"] }));
	});

	it("the whole fragment: past the cap it is not written", () => {
		const big = withFilters({
			actors: Array.from({ length: 10 }, (_, i) => `${i}${JA.repeat(100)}`),
		});
		expect(encodeUrlState(big).length).toBeGreaterThan(MAX_HASH_LENGTH);
		notHeld(big);
	});

	it("costs: a fraction round-trips; a bound with no plain decimal form is not written", () => {
		roundTrips(withFilters({ costMin: 1.5, costMax: 2.25 }));
		roundTrips(withFilters({ costMax: 0.1 + 0.2 }));
		roundTrips(withFilters({ costMin: 0 }));
		notHeld(withFilters({ costMin: -1 }));
		notHeld(withFilters({ costMin: 1e-7 }));
		notHeld(withFilters({ costMax: Number.NaN }));
		notHeld(withFilters({ costMax: Number.POSITIVE_INFINITY }));
	});

	it("a view or record change for a state the address cannot hold writes nothing new", () => {
		const long = withFilters({ search: "a".repeat(MAX_SEARCH_LENGTH + 1) });
		expect(planHistory(long, { ...long, view: "trends" }, "")).toEqual({ kind: "none", hash: "" });
		expect(planHistory(EMPTY_URL_STATE, { ...long, view: "trends" }, "#view=trends")).toEqual({
			kind: "push",
			hash: "",
		});
	});
});

describe("the page honours the address's limits", () => {
	const app = readFileSync(new URL("../src/app/app.tsx", import.meta.url), "utf-8");
	const hook = readFileSync(new URL("../src/app/use-url-state.ts", import.meta.url), "utf-8");
	it("every applied navigation is adopted by the writer, unconditionally, before the state is set", () => {
		const apply = /const apply = \(\): void => \{([\s\S]*?)\n\t\t\};/.exec(hook)?.[1] ?? "";
		const adopt = apply.indexOf("sync.current?.adopt(next);");
		expect(adopt).toBeGreaterThan(-1);
		expect(adopt).toBeLessThan(apply.indexOf("setState("));
		expect(apply.slice(0, adopt)).not.toMatch(/\bif\b/);
	});
	it("the search box stops at the length the address keeps", () => {
		expect(app).toMatch(/type="search"[\s\S]{0,300}maxLength=\{MAX_SEARCH_LENGTH\}/);
	});
	it("says so when the address does not hold the view, and when the browser refused to update it", () => {
		expect(app).toMatch(
			/addressNote === "behind" && \([\s\S]{0,200}role="status"[\s\S]{0,120}Address not updated yet/,
		);
		expect(app).toMatch(
			/addressNote === "cannot-hold" && \([\s\S]{0,200}role="status"[\s\S]{0,120}Not kept in the address/,
		);
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
	it("compares the full state, facet values as sets", () => {
		expect(sameUrlState(FULL, decodeUrlState(encodeUrlState(FULL)))).toBe(true);
		expect(sameUrlState(FULL, EMPTY_URL_STATE)).toBe(false);
		expect(
			sameUrlState(
				withFilters({ statuses: ["failed", "denied", "failed"] }),
				withFilters({ statuses: ["denied", "failed"] }),
			),
		).toBe(true);
	});

	/**
	 * Review of #510: navigation applies the address's state unless it is the same as the page's. Compared by the hash
	 * they write, a filter the encoder leaves out looked equal to none, so Back or a followed link kept it.
	 */
	it("red-first: a filter the address never held is not 'the same' as none, so Back or a link clears it", () => {
		const applied = (prev: UrlState, hash: string): UrlState => {
			const next = decodeUrlState(hash);
			return sameUrlState(prev, next) ? prev : next; // what the page does on hashchange and popstate
		};
		const tiny = withFilters({ costMin: 1e-7 });
		expect(encodeUrlState(tiny)).toBe(""); // the address cannot carry it...
		expect(applied(tiny, "")).toEqual(EMPTY_URL_STATE); // ...and Back to a clean entry clears it
		const invisible = withFilters({ search: `a${String.fromCodePoint(0x200b)}b` });
		expect(applied(invisible, "#view=trends")).toEqual({ ...EMPTY_URL_STATE, view: "trends" });
		// a followed link to the same view the page already shows keeps the page's own state object
		const same = withFilters({ search: "gpt" });
		expect(applied(same, "#q=gpt")).toBe(same);
	});
});

describe("the at field", () => {
	it("at round-trips", () => {
		const s = { ...EMPTY_URL_STATE, at: 4182 };
		expect(encodeUrlState(s)).toBe("#at=4182");
		expect(decodeUrlState("#at=4182").at).toBe(4182);
		expect(decodeUrlState(encodeUrlState(FULL))).toEqual(FULL);
		expect(decodeUrlState("#at=0").at).toBe(0);
		expect(sameUrlState(s, EMPTY_URL_STATE)).toBe(false);
	});

	it("at refuses", () => {
		for (const v of ["-1", "01", "1.5", "1e3", "9007199254740992", "", "abc", "+5", "１２"]) {
			expect(decodeUrlState(`#at=${encodeURIComponent(v)}`).at, `at=${v}`).toBeNull();
		}
		expect(decodeUrlState("#at=9007199254740991").at).toBe(9007199254740991);
	});

	it("a doubled at is refused", () => {
		expect(decodeUrlState("#at=1&at=2").at).toBeNull();
		expect(decodeUrlState("#at=1&at=1").at).toBeNull();
	});

	it("addressHolds refuses a position that is not a safe non-negative integer", () => {
		for (const at of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
			expect(addressHolds({ ...EMPTY_URL_STATE, at }), `at=${at}`).toBe(false);
		}
		expect(addressHolds({ ...EMPTY_URL_STATE, at: 7 })).toBe(true);
	});

	it("entering and leaving a position pushes", () => {
		const live = EMPTY_URL_STATE;
		const at5 = { ...live, at: 5 };
		expect(planHistory(live, at5, "")).toEqual({ kind: "push", hash: "#at=5" });
		expect(planHistory(at5, live, "#at=5")).toEqual({ kind: "push", hash: "" });
	});

	it("moving between positions replaces", () => {
		const at5 = { ...EMPTY_URL_STATE, at: 5 };
		expect(planHistory(at5, { ...at5, at: 6 }, "#at=5")).toEqual({
			kind: "replace",
			hash: "#at=6",
		});
	});
});
