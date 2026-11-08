// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * An external navigation (Back, Forward, a followed link, a typed hash) drops every pending preview and restores the
 * destination's own view, whatever the positions of the two entries (review of #510, round 6: a move started on one
 * live entry survived Back to another live entry and wrote its position into the destination, discarding forward
 * history). The page here is a model of the hooks' wiring built from the real classes (`AtFollower`, `AddressSync`)
 * and a model of the browser's history; the wiring itself is pinned below.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AddressSync } from "../src/shared/address-sync.js";
import type { AtPayload } from "../src/shared/api.js";
import { AtFollower, type AtView } from "../src/shared/at-follow.js";
import { decodeUrlState, sameUrlState, type UrlState } from "../src/shared/url-state.js";

function answer(pos: number): AtPayload {
	return {
		pos,
		ts: "2026-11-06T10:04:05.000Z",
		head: 99,
		clamped: false,
		epoch: 0,
		spentUt: 0,
		counts: { llm_call: 0, denied: 0, other: 0 },
		chain: { valid: true, breakIndex: null },
		budget: {
			ut: null,
			source: "unpublished",
			writtenAt: null,
			provenance: "unknown: not yet published; no controller has recorded the budget it enforces",
			note: "",
		},
		plan: null,
		windowStartPos: 0,
		statusAt: {},
	};
}

/** The browser: a history stack with an index, `pushState` cutting off the forward entries. */
class History {
	entries: string[];
	index = 0;
	writes: Array<{ kind: "push" | "replace"; hash: string }> = [];
	constructor(first: string) {
		this.entries = [first];
	}
	get hash(): string {
		return this.entries[this.index] ?? "";
	}
	write(kind: "push" | "replace", hash: string): void {
		this.writes.push({ kind, hash });
		if (kind === "push") {
			this.entries = [...this.entries.slice(0, this.index + 1), hash];
			this.index += 1;
		} else this.entries[this.index] = hash;
	}
}

/**
 * The page: the url state, the writer and the follower, wired as `App` and `useAt` wire them. With `manual`, every load
 * waits in `pending` until the test answers it, so a request can be in flight across a navigation.
 */
function page(initialHash: string, opts: { manual?: boolean } = {}) {
	const history = new History(initialHash);
	let state: UrlState = decodeUrlState(initialHash);
	const sync = new AddressSync(
		state,
		{
			hash: () => history.hash,
			write: (kind, hash) => history.write(kind, hash),
			later: () => () => {},
		},
		() => {},
	);
	const loads: number[] = [];
	const pending: Array<{ pos: number; resolve(a: AtPayload): void }> = [];
	const views: AtView[] = [];
	const follower = new AtFollower(
		(pos) => {
			loads.push(pos);
			if (opts.manual !== true) return Promise.resolve(answer(pos));
			return new Promise<AtPayload>((resolve) => pending.push({ pos, resolve }));
		},
		(v) => views.push(v),
	);
	follower.want(state.at);
	return {
		history,
		follower,
		loads,
		pending,
		views,
		get state() {
			return state;
		},
		/** The browser moved through history, or a hash was typed: `popstate` / `hashchange`. */
		navigate(to: { delta: number } | { hash: string }): void {
			if ("delta" in to) history.index += to.delta;
			else history.write("push", to.hash);
			const next = decodeUrlState(history.hash);
			sync.adopt(next);
			state = sameUrlState(state, next) ? state : next;
			// What `useAt`'s effect does on that navigation.
			follower.navigated();
			follower.want(state.at);
		},
		/** Switch view in the page (a tab click): a pushed entry. */
		setView(view: UrlState["view"]): void {
			state = { ...state, view };
			sync.sync(state);
		},
	};
}

describe("a navigation while a preview is pending", () => {
	it("Back between two live entries: the destination is live and forward history survives", () => {
		const p = page("");
		p.setView("trends"); // live Audit -> live Trends: two entries, both with no position
		expect(p.history.entries).toEqual(["", "#view=trends"]);
		p.follower.want(40); // a preview asked the server for 40
		expect(p.views.at(-1)?.wanted).toBe(40);

		p.navigate({ delta: -1 }); // Back, before the preview lands
		expect(p.history.writes.filter((w) => w.hash.includes("at="))).toEqual([]);
		expect(p.history.entries).toEqual(["", "#view=trends"]); // forward entry intact
		expect(p.history.index).toBe(0);
		expect(p.state.at).toBeNull();
		expect(p.views.at(-1)?.wanted).toBeNull(); // the destination's own view: live
		expect(p.views.at(-1)?.at).toBeNull();
	});

	it("Forward between two live entries", () => {
		const p = page("");
		p.setView("trends");
		p.navigate({ delta: -1 });
		p.follower.want(12);
		p.navigate({ delta: +1 });
		expect(p.history.writes.filter((w) => w.hash.includes("at="))).toEqual([]);
		expect(p.history.entries).toEqual(["", "#view=trends"]);
		expect(p.history.index).toBe(1);
		expect(p.views.at(-1)?.wanted).toBeNull();
	});

	it("Back between two entries that hold the same past position restores that position, not the preview", async () => {
		const p = page("#at=20");
		p.setView("trends");
		expect(p.history.entries).toEqual(["#at=20", "#at=20&view=trends"]);
		p.follower.want(70);
		expect(p.views.at(-1)?.wanted).toBe(70);
		p.navigate({ delta: -1 });
		await Promise.resolve();
		expect(p.history.writes.filter((w) => w.hash.includes("at=70"))).toEqual([]);
		expect(p.history.entries[1]).toBe("#at=20&view=trends");
		expect(p.views.at(-1)?.wanted).toBe(20);
		expect(p.loads.at(-1)).toBe(20);
	});

	it("a typed hash edit", () => {
		const p = page("");
		p.follower.want(33);
		p.navigate({ hash: "#view=trends" });
		expect(p.history.entries).toEqual(["", "#view=trends"]);
		expect(p.history.writes.filter((w) => w.hash.includes("at="))).toEqual([]);
		expect(p.views.at(-1)?.wanted).toBeNull();
	});

	it("a typed address with a position asks for it, and Back returns to live", () => {
		const p = page("");
		p.navigate({ hash: "#at=40" });
		expect(p.state.at).toBe(40);
		expect(p.views.at(-1)?.wanted).toBe(40);
		expect(p.loads.at(-1)).toBe(40);
		p.navigate({ delta: -1 });
		expect(p.state.at).toBeNull();
		expect(p.views.at(-1)?.wanted).toBeNull();
	});
});

describe("a preview's answer that lands after a navigation", () => {
	// Let the loader's promise settle and the follower's handlers run.
	const flush = async (): Promise<void> => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};

	it("is not shown: a link to another position keeps the last point shown until its own answer lands", async () => {
		const p = page("#at=20", { manual: true });
		p.pending.shift()?.resolve(answer(20));
		await flush();
		expect(p.views.at(-1)?.at?.pos).toBe(20);
		p.follower.want(70); // a preview asks for 70; it is still in flight
		p.navigate({ hash: "#at=30" }); // a link to 30
		p.pending.shift()?.resolve(answer(70)); // the preview's answer lands after the navigation
		await flush();
		expect(p.views.at(-1)?.wanted).toBe(30);
		expect(p.views.at(-1)?.at?.pos).toBe(20); // never 70
		p.pending.shift()?.resolve(answer(30));
		await flush();
		expect(p.views.at(-1)?.at?.pos).toBe(30);
	});

	it("CONTROL: without the navigation, the same answer is shown on the way, as a moving preview needs", async () => {
		const p = page("#at=20", { manual: true });
		p.pending.shift()?.resolve(answer(20));
		await flush();
		p.follower.want(70);
		p.follower.want(30); // the preview moves on: no navigation
		p.pending.shift()?.resolve(answer(70));
		await flush();
		expect(p.views.at(-1)?.at?.pos).toBe(70);
	});
});

describe("the wiring the model mirrors", () => {
	const read = (f: string): string =>
		readFileSync(new URL(`../src/app/${f}`, import.meta.url), "utf-8");

	it("the address hook counts every applied navigation, after adopting it", () => {
		const hook = read("use-url-state.ts");
		const apply = /const apply = \(\): void => \{([\s\S]*?)\n\t\t\};/.exec(hook)?.[1] ?? "";
		expect(apply).toMatch(/setNavigation\(\(n\) => n \+ 1\)/);
		expect(apply.indexOf("adopt(next)")).toBeLessThan(apply.indexOf("setNavigation("));
		expect(apply.slice(0, apply.indexOf("setNavigation("))).not.toMatch(/\breturn\b/);
		expect(hook).toMatch(/navigation,\n\t\taddressNote,/);
	});

	it("the page hands the count to useAt", () => {
		const app = read("app.tsx");
		expect(app).toMatch(/useUrlState\(\)/);
		expect(app).toMatch(/useAt\(at, summary, live, rows, resyncs, rowsVault, navigation\)/);
	});

	it("the page pairs its rows with the answer by epoch: past.rows feed the list, and Export waits while held", () => {
		const app = read("app.tsx");
		expect(app).toMatch(/pastRows\(rows, rowsVault, atView, shownAt\)/);
		expect(app).toMatch(/rows: past\.rows,/);
		expect(app).toMatch(/reloading: pastHeld\b/);
		expect(app).toMatch(/pastHeldNote\(atView\.reloaded\)/);
		expect(app).toMatch(/const pastHeld = past\.kind === "held"/);
		expect(app).toMatch(/const held = holdNote !== null \|\| pastHeld/);
		const fn = /function exportCsv\(\): void \{([\s\S]*?)\n\t\}\n/.exec(app)?.[1] ?? "";
		expect(fn.length).toBeGreaterThan(20);
		expect(fn.slice(0, fn.indexOf("new Blob"))).toMatch(/if \(pastHeld\) return;/);
	});

	it("useAt hands the follower the epoch of the rows the page holds", () => {
		const src = read("use-at.ts");
		expect(src).toMatch(/\(\) => held\.current\.rowsVault/);
	});

	it("useAt tells the follower of each navigation, then wants the address's position, whenever the count changes", () => {
		const src = read("use-at.ts");
		const effect =
			/useEffect\(\(\) => \{((?:(?!useEffect)[\s\S])*?follower\.current\?\.want\(pos\);\s*)\}, \[([^\]]*)\]\)/.exec(
				src,
			);
		expect(effect).not.toBeNull();
		const body = effect?.[1] ?? "";
		// Only a change of the count is a navigation: a position the address already holds is not one.
		expect(body).toMatch(/if \(navigation !== lastNavigation\.current\)/);
		expect(body).toMatch(/follower\.current\?\.navigated\(\)/);
		expect(body.indexOf("navigated()")).toBeLessThan(body.indexOf("want(pos)"));
		const deps = (effect?.[2] ?? "").split(",").map((d) => d.trim());
		expect(deps).toContain("pos");
		expect(deps).toContain("navigation");
	});
});
