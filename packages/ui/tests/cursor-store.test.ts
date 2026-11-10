// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { createCursorStore } from "../src/shared/cursor-store.js";

describe("createCursorStore", () => {
	it("holds nothing at first", () => {
		expect(createCursorStore().get()).toBeNull();
	});

	it("notifies once for a new value and not for the same value again", () => {
		const s = createCursorStore();
		let calls = 0;
		s.subscribe(() => {
			calls++;
		});
		s.set({ k: 3, via: "pointer", i: 7 });
		expect(calls).toBe(1);
		const first = s.get();
		s.set({ k: 3, via: "pointer", i: 7 });
		expect(calls).toBe(1);
		expect(s.get()).toBe(first);
	});

	it("notifies when k, via or i changes", () => {
		const s = createCursorStore();
		let calls = 0;
		s.subscribe(() => {
			calls++;
		});
		s.set({ k: 3, via: "pointer", i: 7 });
		s.set({ k: 3, via: "key", i: 7 });
		s.set({ k: 4, via: "key", i: 7 });
		s.set({ k: 4, via: "key", i: 8 });
		expect(calls).toBe(4);
		expect(s.get()).toEqual({ k: 4, via: "key", i: 8 });
	});

	it("a listener that unsubscribes another during a notification does not skip it", () => {
		const s = createCursorStore();
		const calls: string[] = [];
		let offB = () => {};
		s.subscribe(() => {
			calls.push("a");
			offB();
		});
		offB = s.subscribe(() => {
			calls.push("b");
		});
		s.set({ k: 1, via: "pointer", i: 0 });
		expect(calls).toEqual(["a", "b"]);
		calls.length = 0;
		s.set({ k: 2, via: "pointer", i: 0 });
		expect(calls).toEqual(["a"]);
	});

	it("stores the value before it notifies, so a listener reads the new one", () => {
		const s = createCursorStore();
		const seen: Array<ReturnType<typeof s.get>> = [];
		s.subscribe(() => {
			seen.push(s.get());
		});
		s.set({ k: 1, via: "pointer", i: 0 });
		s.set(null);
		expect(seen).toEqual([{ k: 1, via: "pointer", i: 0 }, null]);
	});

	it("notifies once for null and not again", () => {
		const s = createCursorStore();
		let calls = 0;
		s.subscribe(() => {
			calls++;
		});
		s.set(null);
		expect(calls).toBe(0);
		s.set({ k: 1, via: "pin", i: 0 });
		s.set(null);
		expect(calls).toBe(2);
		s.set(null);
		expect(calls).toBe(2);
		expect(s.get()).toBeNull();
	});

	it("never calls a listener after it unsubscribed", () => {
		const s = createCursorStore();
		let kept = 0;
		let dropped = 0;
		s.subscribe(() => {
			kept++;
		});
		const off = s.subscribe(() => {
			dropped++;
		});
		s.set({ k: 1, via: "sync", i: 2 });
		off();
		s.set({ k: 2, via: "sync", i: 3 });
		expect(kept).toBe(2);
		expect(dropped).toBe(1);
	});
});
