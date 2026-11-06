// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import type { AtPayload } from "../src/shared/api.js";
import { AtFollower, type AtView } from "../src/shared/at-follow.js";
import { newSince } from "../src/shared/timeline-view.js";

function at(overrides: Partial<AtPayload> = {}): AtPayload {
	return {
		pos: 40,
		ts: "2026-11-06T10:04:05.000Z",
		head: 99,
		clamped: false,
		epoch: 0,
		spentUt: 0,
		counts: { llm_call: 0, denied: 0, other: 0 },
		chain: { valid: true, breakIndex: null },
		budget: { ut: null, note: "" },
		plan: null,
		windowStartPos: 0,
		statusAt: {},
		...overrides,
	};
}

/** A loader whose answers the test gives by hand, in any order. */
function harness() {
	const calls: Array<{
		pos: number;
		resolve(p: AtPayload): void;
		reject(e: unknown): void;
	}> = [];
	const views: AtView[] = [];
	const follower = new AtFollower(
		(pos) =>
			new Promise<AtPayload>((resolve, reject) => {
				calls.push({ pos, resolve, reject });
			}),
		(v) => views.push(v),
	);
	const last = (): AtView => {
		const v = views.at(-1);
		if (v === undefined) throw new Error("nothing published");
		return v;
	};
	// Let the loader's promise settle and the follower's handlers run.
	const flush = async (): Promise<void> => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	return { follower, calls, last, flush };
}

describe("AtFollower", () => {
	it("keeps one request in flight, and the latest wanted position wins", async () => {
		const h = harness();
		h.follower.want(1);
		h.follower.want(2);
		h.follower.want(3);
		expect(h.calls.map((c) => c.pos)).toEqual([1]);
		h.calls[0]?.resolve(at({ pos: 1 }));
		await h.flush();
		// 2 was overtaken while 1 was in flight: only the latest is asked for.
		expect(h.calls.map((c) => c.pos)).toEqual([1, 3]);
		// The screen follows the drag: the answer for 1 shows until 3's lands.
		expect(h.last().at?.pos).toBe(1);
		h.calls[1]?.resolve(at({ pos: 3 }));
		await h.flush();
		expect(h.last().at?.pos).toBe(3);
		expect(h.calls).toHaveLength(2);
	});

	it("an answer that lands after going live is dropped", async () => {
		const h = harness();
		h.follower.want(5);
		h.follower.want(null);
		expect(h.last().at).toBeNull();
		h.calls[0]?.resolve(at({ pos: 5 }));
		await h.flush();
		expect(h.last().at).toBeNull();
		expect(h.calls).toHaveLength(1);
	});

	it("says it is loading only until the first answer for a position", async () => {
		const h = harness();
		h.follower.want(7);
		expect(h.last()).toMatchObject({ at: null, loading: true, error: null });
		h.calls[0]?.resolve(at({ pos: 7 }));
		await h.flush();
		expect(h.last()).toMatchObject({ loading: false });
	});

	it("a failure keeps the last good view and says why; the next answer clears it", async () => {
		const h = harness();
		h.follower.want(10);
		h.calls[0]?.resolve(at({ pos: 10 }));
		await h.flush();
		h.follower.want(11);
		h.calls[1]?.reject(new Error("the dashboard did not answer"));
		await h.flush();
		expect(h.last().at?.pos).toBe(10);
		expect(h.last().error).toBe("the dashboard did not answer");
		// A failure is not retried in a loop: nothing more is asked until something changes.
		expect(h.calls).toHaveLength(2);
		h.follower.want(12);
		h.calls[2]?.resolve(at({ pos: 12 }));
		await h.flush();
		expect(h.last()).toMatchObject({ error: null });
		expect(h.last().at?.pos).toBe(12);
	});

	it("live append keeps T: a refresh re-reads the same position and keeps the head it was chosen at", async () => {
		const h = harness();
		h.follower.want(40);
		h.calls[0]?.resolve(at({ pos: 40, head: 99 }));
		await h.flush();
		h.follower.refresh();
		expect(h.calls.map((c) => c.pos)).toEqual([40, 40]);
		// A later record settled a transfer held at 40: its status there is fresh, the position is not moved.
		h.calls[1]?.resolve(at({ pos: 40, head: 120, statusAt: { ["a".repeat(64)]: "held" } }));
		await h.flush();
		const shown = h.last().at;
		expect(shown?.pos).toBe(40);
		expect(shown?.statusAt).toEqual({ ["a".repeat(64)]: "held" });
		expect(newSince(shown ?? null, 120)).toBe(21);
		expect(h.last().reloaded).toBe(false);
	});

	it("a refresh re-reads the position answered, not a clamped one asked for", async () => {
		const h = harness();
		h.follower.want(500);
		h.calls[0]?.resolve(at({ pos: 99, head: 99, clamped: true }));
		await h.flush();
		h.follower.refresh();
		expect(h.calls[1]?.pos).toBe(99);
		h.calls[1]?.resolve(at({ pos: 99, head: 120, clamped: false }));
		await h.flush();
		// Still the record the reader was shown, still labelled as the latest when it was chosen.
		expect(h.last().at).toMatchObject({ pos: 99, head: 99, clamped: true });
	});

	it("a refresh while live asks for nothing", () => {
		const h = harness();
		h.follower.refresh();
		expect(h.calls).toHaveLength(0);
	});

	it("a refresh while a request is in flight asks once more after it lands", async () => {
		const h = harness();
		h.follower.want(40);
		h.follower.refresh();
		h.follower.refresh();
		expect(h.calls).toHaveLength(1);
		h.calls[0]?.resolve(at({ pos: 40 }));
		await h.flush();
		expect(h.calls).toHaveLength(2);
	});

	it("an epoch change says the vault was reloaded, and the reloaded answer becomes the baseline", async () => {
		const h = harness();
		h.follower.want(40);
		h.calls[0]?.resolve(at({ pos: 40, head: 99, epoch: 3 }));
		await h.flush();
		h.follower.refresh();
		h.calls[1]?.resolve(at({ pos: 40, head: 99, epoch: 4, spentUt: 77 }));
		await h.flush();
		expect(h.last().reloaded).toBe(true);
		// Never the stale position: the reloaded answer is what shows.
		expect(h.last().at).toMatchObject({ epoch: 4, spentUt: 77 });
		// Moving on clears the note; the new epoch is the one compared from now on.
		h.follower.want(41);
		expect(h.last().reloaded).toBe(false);
		h.calls[2]?.resolve(at({ pos: 41, epoch: 4 }));
		await h.flush();
		expect(h.last().reloaded).toBe(false);
	});

	it("going live forgets the epoch: the next past view is not called a reload", async () => {
		const h = harness();
		h.follower.want(40);
		h.calls[0]?.resolve(at({ epoch: 1 }));
		await h.flush();
		h.follower.want(null);
		h.follower.want(40);
		h.calls[1]?.resolve(at({ epoch: 2 }));
		await h.flush();
		expect(h.last().reloaded).toBe(false);
	});
});
