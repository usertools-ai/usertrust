// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * An external navigation (Back, Forward, a followed link, a typed hash) cancels every pending timeline preview and
 * commit and restores the destination's own view, whatever the positions of the two entries (review of #510, round 6:
 * a drag started on one live entry survived Back to another live entry and wrote its position into the destination,
 * discarding forward history). The page here is a model of the two hooks' wiring built from the real classes
 * (`Scrubber`, `AtFollower`, `AddressSync`) and a model of the browser's history; the wiring itself is pinned below.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AddressSync } from "../src/shared/address-sync.js";
import type { AtPayload } from "../src/shared/api.js";
import { AtFollower, type AtView } from "../src/shared/at-follow.js";
import { COMMIT_IDLE_MS, Scrubber, type ScrubIo } from "../src/shared/scrub.js";
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

/** The page: the url state, the writer, the scrubber and the follower, wired as `App`, `Timeline` and `useAt` wire them. */
function page(initialHash: string) {
	const history = new History(initialHash);
	const frames: Array<() => void> = [];
	const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
	const io: ScrubIo = {
		frame(fn) {
			frames.push(fn);
			return () => {
				const i = frames.indexOf(fn);
				if (i >= 0) frames.splice(i, 1);
			};
		},
		later(fn) {
			const t = { fn, cancelled: false };
			timers.push(t);
			return () => {
				t.cancelled = true;
			};
		},
	};
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
	const views: AtView[] = [];
	const follower = new AtFollower(
		(pos) => {
			loads.push(pos);
			return Promise.resolve(answer(pos));
		},
		(v) => views.push(v),
	);
	const holds: boolean[] = [];
	const scrub = new Scrubber(
		io,
		(p) => follower.want(p),
		(p) => {
			state = state.at === p ? state : { ...state, at: p };
			sync.sync(state);
		},
		(active) => holds.push(active),
	);
	follower.want(state.at);
	scrub.sync(state.at);
	return {
		history,
		scrub,
		follower,
		holds,
		loads,
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
			// What the hooks do on that navigation: the timeline's effect and `useAt`'s effect.
			scrub.navigated(state.at);
			follower.want(state.at);
		},
		/** Switch view in the page (a tab click): a pushed entry. */
		setView(view: UrlState["view"]): void {
			state = { ...state, view };
			sync.sync(state);
		},
		/** Frames and the idle timer run, as time passes. */
		settle(): void {
			for (const fn of frames.splice(0)) fn();
			for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
		},
		runFrame(): void {
			for (const fn of frames.splice(0)) fn();
		},
	};
}

describe(`a navigation while a drag is pending (idle ${COMMIT_IDLE_MS} ms)`, () => {
	it("Back between two live entries: the position is not written, forward history survives, the destination is live", () => {
		const p = page("");
		p.setView("trends"); // live Audit -> live Trends: two entries, both with no position
		expect(p.history.entries).toEqual(["", "#view=trends"]);
		p.scrub.move(40);
		p.runFrame(); // the preview asked the server for 40
		expect(p.views.at(-1)?.wanted).toBe(40);

		p.navigate({ delta: -1 }); // Back, before the drag commits
		p.settle(); // the idle timer / key up that would have written it
		expect(p.history.writes.filter((w) => w.hash.includes("at="))).toEqual([]);
		expect(p.history.entries).toEqual(["", "#view=trends"]); // forward entry intact
		expect(p.history.index).toBe(0);
		expect(p.state.at).toBeNull();
		expect(p.views.at(-1)?.wanted).toBeNull(); // the destination's own view: live
		expect(p.views.at(-1)?.at).toBeNull();
		expect(p.holds.at(-1)).toBe(false);
		expect(p.scrub.pending).toBeNull();
	});

	it("Forward between two live entries", () => {
		const p = page("");
		p.setView("trends");
		p.navigate({ delta: -1 });
		p.scrub.move(12);
		p.runFrame();
		p.navigate({ delta: +1 });
		p.settle();
		expect(p.history.writes.filter((w) => w.hash.includes("at="))).toEqual([]);
		expect(p.history.entries).toEqual(["", "#view=trends"]);
		expect(p.history.index).toBe(1);
		expect(p.views.at(-1)?.wanted).toBeNull();
	});

	it("Back between two entries that hold the same past position restores that position, not the preview", async () => {
		const p = page("#at=20");
		p.setView("trends");
		expect(p.history.entries).toEqual(["#at=20", "#at=20&view=trends"]);
		p.scrub.move(70);
		p.runFrame();
		expect(p.views.at(-1)?.wanted).toBe(70);
		p.navigate({ delta: -1 });
		p.settle();
		await Promise.resolve();
		expect(p.history.writes.filter((w) => w.hash.includes("at=70"))).toEqual([]);
		expect(p.history.entries[1]).toBe("#at=20&view=trends");
		expect(p.views.at(-1)?.wanted).toBe(20);
		expect(p.loads.at(-1)).toBe(20);
	});

	it("a typed hash edit", () => {
		const p = page("");
		p.scrub.move(33);
		p.runFrame();
		p.navigate({ hash: "#view=trends" });
		p.settle();
		expect(p.history.entries).toEqual(["", "#view=trends"]);
		expect(p.history.writes.filter((w) => w.hash.includes("at="))).toEqual([]);
		expect(p.views.at(-1)?.wanted).toBeNull();
		expect(p.holds.at(-1)).toBe(false);
	});

	it("without a navigation the drag still commits once, as a replace-or-push of its position", () => {
		const p = page("");
		p.scrub.move(40);
		p.settle();
		expect(p.history.entries).toEqual(["", "#at=40"]);
		expect(p.views.at(-1)?.wanted).toBe(40);
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

	it("the page hands the count to the timeline and to useAt", () => {
		const app = read("app.tsx");
		expect(app).toMatch(/useUrlState\(\)/);
		expect(app).toMatch(/useAt\(at, summary, live, rows, resyncs, navigation\)/);
		expect(app).toMatch(/<Timeline[\s\S]*?navigation=\{navigation\}/);
	});

	it("the timeline cancels its scrub whenever the count changes, whatever the position", () => {
		const src = read("timeline.tsx");
		const effect =
			/useEffect\(\(\) => \{((?:(?!useEffect)[\s\S])*?)\}, \[props\.navigation\]\)/.exec(src);
		expect(effect).not.toBeNull();
		expect(effect?.[1]).toMatch(/\.navigated\(/);
		expect(effect?.[1]).toMatch(/setThumb\(null\)/);
		expect(effect?.[1]).not.toMatch(/\bif \(.*committed/);
	});

	it("useAt wants the address's position again whenever the count changes", () => {
		const src = read("use-at.ts");
		const effect =
			/useEffect\(\(\) => \{\s*follower\.current\?\.want\(pos\);\s*\}, \[([^\]]*)\]\)/.exec(src);
		expect(effect).not.toBeNull();
		const deps = (effect?.[1] ?? "").split(",").map((d) => d.trim());
		expect(deps).toContain("pos");
		expect(deps).toContain("navigation");
	});
});
