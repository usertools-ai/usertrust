// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtPayload } from "../src/shared/api.js";
import { cutRows, pastRows, rowsAsAnswered } from "../src/shared/asof.js";
import { AtFollower, type AtView, pointLoading } from "../src/shared/at-follow.js";
import type { LedgerRow } from "../src/shared/rows.js";
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
		...overrides,
	};
}

function row(pos: number, overrides: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: pos,
		pos,
		id: `id-${pos}`,
		ts: "2026-10-12T17:59:02.770Z",
		kind: "llm_call",
		actor: "local",
		hash: pos.toString(16).padStart(64, "0"),
		previousHash: "0".repeat(64),
		integrity: "verified",
		status: "settled",
		...overrides,
	};
}

/** A loader whose answers the test gives by hand, in any order. */
function harness() {
	// The rows the page holds right now: the test replaces them as live frames arrive.
	const page = { rows: [] as LedgerRow[], resyncs: 0, rowsVault: "boot-a:0" as string | null };
	const calls: Array<{
		pos: number;
		signal: AbortSignal;
		resolve(p: AtPayload): void;
		reject(e: unknown): void;
	}> = [];
	const views: AtView[] = [];
	const follower = new AtFollower(
		(pos, signal) =>
			new Promise<AtPayload>((resolve, reject) => {
				calls.push({ pos, signal, resolve, reject });
			}),
		(v) => views.push(v),
		undefined,
		() => page.rows,
		() => page.resyncs,
		() => page.rowsVault,
	);
	const last = (): AtView => {
		const v = views.at(-1);
		if (v === undefined) throw new Error("nothing published");
		return v;
	};
	// Let the loader's promise settle and the follower's handlers run.
	const flush = async (): Promise<void> => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	return { follower, calls, views, last, flush, page };
}

describe("AtFollower", () => {
	it("asking for another position after a failure clears the failure: it is loading, not 'did not load'", async () => {
		const h = harness();
		h.follower.want(10);
		h.calls[0]?.reject(new Error("the dashboard did not answer"));
		await h.flush();
		expect(h.last()).toMatchObject({ wanted: 10, error: "the dashboard did not answer" });
		h.follower.want(20);
		expect(h.last()).toMatchObject({ wanted: 20, at: null, loading: true, error: null });
	});

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
		// The screen follows the preview: the answer for 1 shows until 3's lands.
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
		h.calls[1]?.resolve(at({ pos: 40, head: 120, statusAt: { ["a".repeat(64)]: "ambiguous" } }));
		await h.flush();
		const shown = h.last().at;
		expect(shown?.pos).toBe(40);
		expect(shown?.statusAt).toEqual({ ["a".repeat(64)]: "ambiguous" });
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

	it("the view names the position wanted, so the page knows a past view is asked for before it loads", () => {
		const h = harness();
		h.follower.want(7);
		expect(h.last().wanted).toBe(7);
		h.follower.want(null);
		expect(h.last().wanted).toBeNull();
	});

	it("a re-read that changes nothing publishes nothing new: the same answer object stays", async () => {
		const h = harness();
		h.follower.want(40);
		h.calls[0]?.resolve(at({ pos: 40, head: 99 }));
		await h.flush();
		const before = h.last().at;
		const published = h.views.length;
		h.follower.refresh();
		// Only the head moved: the figures, the chain and the statuses at 40 are what they were.
		h.calls[1]?.resolve(at({ pos: 40, head: 120 }));
		await h.flush();
		expect(h.last().at).toBe(before);
		expect(h.views.length).toBe(published);
	});

	it("a re-read that changes where the budget came from or when is shown, though its figure is the same", async () => {
		const budget = (over: Partial<AtPayload["budget"]>): AtPayload["budget"] => ({
			ut: 1_000_000,
			source: "config",
			writtenAt: null,
			provenance: "from the vault config",
			note: "today's budget",
			...over,
		});
		const h = harness();
		h.follower.want(40);
		h.calls[0]?.resolve(at({ pos: 40, budget: budget({}) }));
		await h.flush();
		const variants: Array<Partial<AtPayload["budget"]>> = [
			{ source: "governor", writtenAt: "2026-11-07T00:00:00.000Z", provenance: "enforced" },
			{ source: "governor", writtenAt: "2026-11-08T00:00:00.000Z", provenance: "enforced" },
			{
				source: "governor",
				writtenAt: "2026-11-08T00:00:00.000Z",
				provenance: "enforced, as recorded",
			},
		];
		let n = 1;
		for (const v of variants) {
			const before = h.last().at;
			h.follower.refresh();
			h.calls[n]?.resolve(at({ pos: 40, budget: budget(v) }));
			n += 1;
			await h.flush();
			expect(h.last().at).not.toBe(before);
			expect(h.last().at?.budget).toMatchObject(v);
		}
	});

	describe("a request that never answers", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("is given up after 10 s, down the failure path, and a later position is served", async () => {
			vi.useFakeTimers();
			const h = harness();
			h.follower.want(1);
			await vi.advanceTimersByTimeAsync(9_999);
			expect(h.last().error).toBeNull();
			await vi.advanceTimersByTimeAsync(1);
			expect(h.calls[0]?.signal.aborted).toBe(true);
			expect(h.last().error).toBe("the dashboard did not answer");
			h.follower.want(2);
			expect(h.calls.map((c) => c.pos)).toEqual([1, 2]);
			h.calls[1]?.resolve(at({ pos: 2 }));
			await h.flush();
			expect(h.last()).toMatchObject({ error: null });
			expect(h.last().at?.pos).toBe(2);
		});
	});

	describe("a failure for a position the user has left", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("is never shown while a newer request runs", async () => {
			vi.useFakeTimers();
			const h = harness();
			h.follower.want(1);
			// The user moves on while 1 is still unanswered.
			h.follower.want(2);
			await vi.advanceTimersByTimeAsync(10_000);
			// 1 timed out; its failure belongs to a position nobody is looking at.
			expect(h.views.some((v) => v.error !== null)).toBe(false);
			expect(h.calls.map((c) => c.pos)).toEqual([1, 2]);
			expect(h.last()).toMatchObject({ wanted: 2, loading: true, error: null });
			h.calls[1]?.resolve(at({ pos: 2 }));
			await h.flush();
			expect(h.last().at?.pos).toBe(2);
		});
	});

	describe("reconnected (the server may have restarted, and epochs restart with it)", () => {
		it("re-reads the position answered (a clamped one), not the one asked for", async () => {
			const h = harness();
			h.follower.want(500);
			h.calls[0]?.resolve(at({ pos: 99, head: 99, clamped: true }));
			await h.flush();
			h.follower.reconnected();
			expect(h.calls[1]?.pos).toBe(99);
		});

		it("a second reconnect before the first re-read answers still re-reads the position answered, not the one asked for", async () => {
			const h = harness();
			h.follower.want(500);
			h.calls[0]?.resolve(at({ pos: 99, head: 99, clamped: true }));
			await h.flush();
			h.follower.reconnected();
			h.follower.reconnected();
			// The first re-read is overtaken; the follower asks again once it settles.
			h.calls[1]?.resolve(at({ pos: 99, head: 99, clamped: true }));
			await h.flush();
			expect(h.calls.map((c) => c.pos)).toEqual([500, 99, 99]);
		});

		it("clears the reloaded note: the old server's epochs say nothing about the new one", async () => {
			const h = harness();
			h.follower.want(40);
			h.calls[0]?.resolve(at({ epoch: 1 }));
			await h.flush();
			h.follower.refresh();
			h.calls[1]?.resolve(at({ epoch: 2 }));
			await h.flush();
			expect(h.last().reloaded).toBe(true);
			h.follower.reconnected();
			expect(h.last().reloaded).toBe(false);
		});

		it("forgets the epoch and the baseline: the re-read is a new baseline, not a reload", async () => {
			const h = harness();
			h.follower.want(40);
			h.calls[0]?.resolve(at({ pos: 40, head: 99, epoch: 3 }));
			await h.flush();
			h.follower.reconnected();
			expect(h.calls.map((c) => c.pos)).toEqual([40, 40]);
			// A restarted server starts its epochs at 0 again, and holds more records.
			h.calls[1]?.resolve(at({ pos: 40, head: 120, epoch: 0 }));
			await h.flush();
			expect(h.last().reloaded).toBe(false);
			// The new baseline's head: nothing is "new since" a position just re-read.
			expect(newSince(h.last().at, 120)).toBe(0);
			expect(h.last().at?.epoch).toBe(0);
		});

		it("an answer from before the reconnect is dropped, never compared with the new server's epochs", async () => {
			const h = harness();
			h.follower.want(40);
			h.follower.reconnected();
			h.calls[0]?.resolve(at({ pos: 40, epoch: 5, spentUt: 1 }));
			await h.flush();
			expect(h.last().at).toBeNull();
			h.calls[1]?.resolve(at({ pos: 40, epoch: 0, spentUt: 2 }));
			await h.flush();
			expect(h.last()).toMatchObject({ reloaded: false });
			expect(h.last().at?.spentUt).toBe(2);
		});

		it("while live it asks for nothing", () => {
			const h = harness();
			h.follower.reconnected();
			expect(h.calls).toHaveLength(0);
		});
	});

	describe("the rows an answer is paired with are the ones held when its request was sent", () => {
		const sent = [row(0), row(1)];
		/** A live `status` frame: a record after the position turned row 0 ambiguous. */
		const turned = (): LedgerRow[] =>
			sent.map((r) => (r.pos === 0 ? { ...r, status: "ambiguous" as const } : r));
		const statusesAt = (view: AtView, live: LedgerRow[]): Array<string | undefined> => {
			if (view.at === null || view.rows === null) throw new Error("no answer shown");
			return cutRows(rowsAsAnswered(live, view.rows, view.at), view.at).map((r) => r.status);
		};

		it("a status frame that overtakes the answer does not reach the past view", async () => {
			const h = harness();
			h.page.rows = sent;
			h.follower.want(0);
			// The server answered at a head that had no record after position 0 (statusAt is empty); a frame for one
			// reaches the page before the answer renders.
			h.page.rows = turned();
			h.calls[0]?.resolve(at({ pos: 0, head: 1 }));
			await h.flush();
			expect(h.last().rows).toBe(sent);
			expect(statusesAt(h.last(), h.page.rows)).toEqual(["settled"]);
		});

		it("the same when the answer's re-read fails: the view keeps the pair it was answered with", async () => {
			const h = harness();
			h.page.rows = sent;
			h.follower.want(0);
			h.page.rows = turned();
			h.calls[0]?.resolve(at({ pos: 0, head: 1 }));
			await h.flush();
			h.follower.refresh();
			h.calls[1]?.reject(new Error("the dashboard did not answer"));
			await h.flush();
			expect(h.last().error).toBe("the dashboard did not answer");
			expect(h.last().rows).toBe(sent);
			expect(statusesAt(h.last(), h.page.rows)).toEqual(["settled"]);
		});

		it("a re-read that covers the change is paired with the rows held when it was sent", async () => {
			const h = harness();
			h.page.rows = sent;
			h.follower.want(0);
			h.calls[0]?.resolve(at({ pos: 0, head: 1 }));
			await h.flush();
			const now = turned();
			h.page.rows = now;
			h.follower.refresh();
			h.calls[1]?.resolve(at({ pos: 0, head: 1, statusAt: { [row(0).hash]: "settled" } }));
			await h.flush();
			expect(h.last().rows).toBe(now);
			expect(statusesAt(h.last(), now)).toEqual(["settled"]);
		});

		it("a re-read that changes nothing keeps the pair and publishes nothing", async () => {
			const h = harness();
			h.page.rows = sent;
			h.follower.want(0);
			h.calls[0]?.resolve(at({ pos: 0, head: 1 }));
			await h.flush();
			const published = h.views.length;
			h.page.rows = turned();
			h.follower.refresh();
			h.calls[1]?.resolve(at({ pos: 0, head: 1 }));
			await h.flush();
			expect(h.views).toHaveLength(published);
			expect(h.last().rows).toBe(sent);
		});

		it("an identical re-read adopts a fresher snapshot when the kept one ends before the position", async () => {
			const h = harness();
			// The first request is sent before the page holds the position (a position in the address, on load).
			h.page.rows = [];
			h.follower.want(1);
			h.calls[0]?.resolve(at({ pos: 1, head: 1 }));
			await h.flush();
			// The rows load, and the summary refresh asks again; its answer reads the same.
			const loaded = [row(0), row(1), row(2), row(3), row(4), row(5)];
			h.page.rows = loaded;
			h.follower.refresh();
			h.calls[1]?.resolve(at({ pos: 1, head: 1 }));
			await h.flush();
			expect(h.last().rows).toBe(loaded);
			// A live frame for a record after the position turns row 0 ambiguous; the answer has no status for it.
			const live = loaded.map((r) => (r.pos === 0 ? { ...r, status: "ambiguous" as const } : r));
			h.page.rows = live;
			expect(statusesAt(h.last(), live)).toEqual(["settled", "settled"]);
		});

		it("an identical re-read keeps the pair when the kept snapshot already covers the position", async () => {
			const h = harness();
			h.page.rows = sent;
			h.follower.want(1);
			h.calls[0]?.resolve(at({ pos: 1, head: 1 }));
			await h.flush();
			const published = h.views.length;
			h.page.rows = [...sent, row(2)];
			h.follower.refresh();
			h.calls[1]?.resolve(at({ pos: 1, head: 2 }));
			await h.flush();
			expect(h.views).toHaveLength(published);
			expect(h.last().rows).toBe(sent);
		});

		it("an identical re-read adopts the rows of a later resync: a reload's answer that overtook them", async () => {
			const h = harness();
			// The page holds rows of the old vault: row 0 reads ambiguous there.
			const old = [row(0, { status: "ambiguous" }), row(1)];
			h.page.rows = old;
			h.follower.want(0);
			h.calls[0]?.resolve(at({ pos: 0, head: 1, statusAt: { [row(0).hash]: "settled" } }));
			await h.flush();
			// The vault is reloaded with other records: the answer for the new epoch lands before the rows are resynced.
			h.follower.refresh();
			h.calls[1]?.resolve(at({ pos: 0, head: 0, epoch: 1 }));
			await h.flush();
			expect(h.last().rows).toBe(old);
			// The resync lands the new vault's rows (row 0 settled), and the summary refresh reads the same.
			const fresh = [row(0)];
			h.page.rows = fresh;
			h.page.resyncs = 1;
			h.follower.refresh();
			h.calls[2]?.resolve(at({ pos: 0, head: 0, epoch: 1 }));
			await h.flush();
			expect(h.last().rows).toBe(fresh);
			expect(statusesAt(h.last(), fresh)).toEqual(["settled"]);
		});

		it("an identical re-read adopts the rows of a resync that landed after a reconnect's answer", async () => {
			const h = harness();
			const old = [row(0, { status: "ambiguous" }), row(1)];
			h.page.rows = old;
			h.follower.want(0);
			h.calls[0]?.resolve(at({ pos: 0, head: 1 }));
			await h.flush();
			// The stream comes back; the answer to the re-read lands before the resync's rows.
			h.follower.reconnected();
			h.calls[1]?.resolve(at({ pos: 0, head: 0, epoch: 1 }));
			await h.flush();
			const fresh = [row(0)];
			h.page.rows = fresh;
			h.page.resyncs = 1;
			h.follower.refresh();
			h.calls[2]?.resolve(at({ pos: 0, head: 0, epoch: 1 }));
			await h.flush();
			expect(h.last().rows).toBe(fresh);
			expect(statusesAt(h.last(), fresh)).toEqual(["settled"]);
		});

		it("the hook re-reads when a resync is installed, whether or not the summary object changed", () => {
			// A snapshot overtaken by a newer summary frame reinstalls the summary already held: rows and the resync count
			// change, the summary does not. The effects have no DOM to run in here, so the dependency list is pinned.
			const src = readFileSync(new URL("../src/app/use-at.ts", import.meta.url), "utf-8");
			const effect =
				/useEffect\(\(\) => \{\s*if \(summary !== null\)[\s\S]*?\}, \[([^\]]*)\]\)/.exec(src);
			expect(effect).not.toBeNull();
			const deps = (effect?.[1] ?? "").split(",").map((d) => d.trim());
			expect(deps).toContain("summary");
			expect(deps).toContain("resyncs");
		});

		it("an answer that landed on the way is paired with its own request's rows", async () => {
			const h = harness();
			h.page.rows = sent;
			h.follower.want(0);
			h.follower.want(1);
			const later = turned();
			h.page.rows = later;
			h.calls[0]?.resolve(at({ pos: 0, head: 1 }));
			await h.flush();
			expect(h.last().rows).toBe(sent);
			// The next request (for 1) was sent after the frame.
			h.calls[1]?.resolve(at({ pos: 1, head: 1 }));
			await h.flush();
			expect(h.last().rows).toBe(later);
		});

		it("going live drops the rows with the answer", async () => {
			const h = harness();
			h.page.rows = sent;
			h.follower.want(0);
			h.calls[0]?.resolve(at({ pos: 0, head: 1 }));
			await h.flush();
			h.follower.want(null);
			expect(h.last()).toMatchObject({ at: null, rows: null });
		});

		it("rows older than the window the answer covers are not drawn, whatever later changes them", async () => {
			const held = [row(0), row(1), row(2), row(3), row(4), row(5)];
			const h = harness();
			h.page.rows = held;
			h.follower.want(4);
			// A record after the position changes row 1, which the server has since evicted: its statusAt cannot say so.
			const live = held.map((r) => (r.pos === 1 ? { ...r, status: "ambiguous" as const } : r));
			h.page.rows = live;
			h.calls[0]?.resolve(at({ pos: 4, head: 5, windowStartPos: 3 }));
			await h.flush();
			const view = h.last();
			if (view.at === null || view.rows === null) throw new Error("no answer shown");
			const shown = cutRows(rowsAsAnswered(live, view.rows, view.at), view.at);
			expect(shown.map((r) => r.pos)).toEqual([3, 4]);
		});
	});

	describe("the resolved selection", () => {
		it("a position asked for past the head is resolved to the record answered, and stays so across a reconnect", async () => {
			const h = harness();
			h.follower.want(500);
			expect(h.last().resolved).toBeNull();
			h.calls[0]?.resolve(at({ pos: 99, head: 99, clamped: true }));
			await h.flush();
			expect(h.last().resolved).toBe(99);
			h.follower.reconnected();
			// Between the reconnect and the re-read's answer.
			expect(h.last().resolved).toBe(99);
			h.calls[1]?.resolve(at({ pos: 99, head: 120, clamped: false }));
			await h.flush();
			expect(h.last()).toMatchObject({ wanted: 500, resolved: 99 });
			expect(h.last().at).toMatchObject({ pos: 99, clamped: false });
		});

		it("a new position starts unresolved", async () => {
			const h = harness();
			h.follower.want(500);
			h.calls[0]?.resolve(at({ pos: 99, head: 99, clamped: true }));
			await h.flush();
			h.follower.want(40);
			expect(h.last().resolved).toBeNull();
			h.follower.want(null);
			expect(h.last().resolved).toBeNull();
		});
	});
});

describe("a navigation (Back, Forward, a link) while a preview's request is in flight", () => {
	it("drops the preview's answer: it never replaces the destination, also when the destination's own read fails", async () => {
		const h = harness();
		h.follower.want(70); // a preview asks for 70
		h.follower.navigated(); // Back to #at=20
		h.follower.want(20);
		h.calls[0]?.resolve(at({ pos: 70 }));
		await h.flush();
		expect(h.last().at).toBeNull();
		expect(h.calls.map((c) => c.pos)).toEqual([70, 20]);
		h.calls[1]?.reject(new Error("the dashboard did not answer"));
		await h.flush();
		expect(h.last()).toMatchObject({ wanted: 20, at: null, error: "the dashboard did not answer" });
	});

	it("CONTROL: the same moves without a navigation show 70 on the way, as a moving preview does", async () => {
		const h = harness();
		h.follower.want(70);
		h.follower.want(20);
		h.calls[0]?.resolve(at({ pos: 70 }));
		await h.flush();
		expect(h.last()).toMatchObject({ wanted: 20 });
		expect(h.last().at?.pos).toBe(70);
	});

	it("keeps an answer for the destination itself, sent before the navigation", async () => {
		const h = harness();
		h.follower.want(20);
		h.follower.navigated();
		h.follower.want(20);
		h.calls[0]?.resolve(at({ pos: 20 }));
		await h.flush();
		expect(h.last().at?.pos).toBe(20);
		expect(h.calls).toHaveLength(1);
	});

	it("keeps an answer for the destination sent before a preview and a navigation back to it", async () => {
		const h = harness();
		h.follower.want(20); // the address's position: its request is in flight
		h.follower.want(70); // a preview asks for 70 (due)
		h.follower.navigated(); // Back to #at=20
		h.follower.want(20);
		h.calls[0]?.resolve(at({ pos: 20 }));
		await h.flush();
		expect(h.last().at?.pos).toBe(20);
		// The request for 20 sent after the navigation fails: the destination's earlier answer stays on screen.
		expect(h.calls.map((c) => c.pos)).toEqual([20, 20]);
		h.calls[1]?.reject(new Error("the dashboard did not answer"));
		await h.flush();
		expect(h.last()).toMatchObject({ wanted: 20, error: "the dashboard did not answer" });
		expect(h.last().at?.pos).toBe(20);
	});

	it("shows answers on the way again for a preview that starts after the navigation", async () => {
		const h = harness();
		h.follower.want(70);
		h.follower.navigated();
		h.follower.want(20);
		h.calls[0]?.resolve(at({ pos: 70 }));
		await h.flush();
		h.follower.want(30); // a new preview, after the navigation
		h.calls[1]?.resolve(at({ pos: 20 }));
		await h.flush();
		expect(h.last()).toMatchObject({ wanted: 30 });
		expect(h.last().at?.pos).toBe(20);
	});
});

describe("pointLoading", () => {
	it("is true while a position is wanted and its own answer has not landed, also with an older point still shown", async () => {
		const h = harness();
		h.follower.want(40);
		expect(pointLoading(h.last())).toBe(true);
		h.calls[0]?.resolve(at({ pos: 40 }));
		await h.flush();
		expect(pointLoading(h.last())).toBe(false);
		h.follower.want(50); // another point, from the address; 40 is still on screen
		expect(h.last().at?.pos).toBe(40);
		expect(pointLoading(h.last())).toBe(true);
		h.calls[1]?.resolve(at({ pos: 50 }));
		await h.flush();
		expect(pointLoading(h.last())).toBe(false);
	});

	it("is false live, and once the read has failed (the failure note speaks then)", async () => {
		const h = harness();
		h.follower.want(40);
		h.calls[0]?.reject(new Error("the dashboard did not answer"));
		await h.flush();
		expect(pointLoading(h.last())).toBe(false);
		h.follower.want(null);
		expect(pointLoading(h.last())).toBe(false);
	});

	it("is false during a reconnect's re-read, and for a position past the head once it is answered", async () => {
		const h = harness();
		h.follower.want(40);
		h.calls[0]?.resolve(at({ pos: 40 }));
		await h.flush();
		h.follower.reconnected();
		expect(pointLoading(h.last())).toBe(false);
		const g = harness();
		g.follower.want(500); // past the head: answered with the head, clamped
		g.calls[0]?.resolve(at({ pos: 99, clamped: true }));
		await g.flush();
		expect(pointLoading(g.last())).toBe(false);
	});
});

describe("a past view and the vault it comes from", () => {
	const old = [row(0, { id: "a", costUt: 10 }), row(1, { id: "b", costUt: 100 })];
	const reloaded = [
		row(0, { id: "a", costUt: 10 }),
		row(1, { id: "b2", costUt: 500, hash: "f".repeat(64) }),
	];
	/** What the page would draw for the follower's last view, given the page's rows and epoch now. */
	const drawn = (h: ReturnType<typeof harness>) =>
		pastRows(h.page.rows, h.page.rowsVault, h.last(), h.last().at);

	it("the stamp is the page's vault when the request was sent, not when the answer lands", async () => {
		const h = harness();
		h.page.rows = old;
		h.page.rowsVault = "boot-a:0";
		h.follower.want(1);
		h.page.rowsVault = "boot-a:5";
		h.calls[0]?.resolve(at({ pos: 1, boot: "boot-a" }));
		await h.flush();
		expect(h.last().rowsVault).toBe("boot-a:0");
	});

	it("live carries no stamp", async () => {
		const h = harness();
		h.page.rowsVault = "boot-a:3";
		h.follower.want(1);
		h.follower.want(null);
		expect(h.last().rowsVault).toBeNull();
	});

	it("rows first: pending, failed, then landed re-read of a reload", async () => {
		const h = harness();
		h.page.rows = old;
		h.page.rowsVault = "boot-a:0";
		h.follower.want(1);
		h.calls[0]?.resolve(at({ pos: 1, epoch: 0, boot: "boot-a" }));
		await h.flush();
		expect(drawn(h).kind).toBe("answered");
		// The reload's rows land; the re-read is pending: the old answer is paired with its own rows.
		h.page.rows = reloaded;
		h.page.rowsVault = "boot-a:1";
		h.page.resyncs += 1;
		h.follower.refresh();
		expect(h.calls).toHaveLength(2);
		let p = drawn(h);
		expect(p.kind).toBe("snapshot");
		expect(p.rows.map((r) => r.id)).toEqual(["a", "b"]);
		// The re-read fails: the pairing is unchanged and the error is set.
		h.calls[1]?.reject(new Error("the dashboard did not answer"));
		await h.flush();
		expect(h.last().error).toBe("the dashboard did not answer");
		p = drawn(h);
		expect(p.kind).toBe("snapshot");
		expect(p.rows.map((r) => r.id)).toEqual(["a", "b"]);
		// A later re-read lands with the new vault's answer: the reloaded rows.
		h.follower.refresh();
		h.calls[2]?.resolve(at({ pos: 1, epoch: 1, boot: "boot-a" }));
		await h.flush();
		p = drawn(h);
		expect(p.kind).toBe("answered");
		expect(p.rows.map((r) => r.id)).toEqual(["a", "b2"]);
		expect(h.last().reloaded).toBe(true);
	});

	it("answer first: held until the resync lands, then answered", async () => {
		const h = harness();
		h.page.rows = old;
		h.page.rowsVault = "boot-a:0";
		h.follower.want(1);
		h.calls[0]?.resolve(at({ pos: 1, epoch: 0, boot: "boot-a" }));
		await h.flush();
		// The summary frame of the reload asks for a re-read before the reloaded rows are installed.
		h.follower.refresh();
		h.calls[1]?.resolve(at({ pos: 1, epoch: 1, boot: "boot-a" }));
		await h.flush();
		expect(h.last().at?.epoch).toBe(1);
		expect(drawn(h)).toEqual({ kind: "held", rows: [] });
		// The resync lands: the rows are the answer's vault, but the answer was read against the old ones.
		h.page.rows = reloaded;
		h.page.rowsVault = "boot-a:1";
		h.page.resyncs += 1;
		expect(drawn(h)).toEqual({ kind: "held", rows: [] });
		// The resync's summary asks for a re-read, sent with the reloaded rows: once it lands, the view is answered.
		h.follower.refresh();
		h.calls[2]?.resolve(at({ pos: 1, epoch: 1, boot: "boot-a" }));
		await h.flush();
		const p = drawn(h);
		expect(p.kind).toBe("answered");
		expect(p.rows.map((r) => r.id)).toEqual(["a", "b2"]);
	});
});

describe("an answer from another server start", () => {
	it("with the same epoch is a reload, never the same reading", async () => {
		const h = harness();
		h.follower.want(1);
		h.calls[0]?.resolve(at({ pos: 1, epoch: 0, boot: "A" }));
		await h.flush();
		expect(h.last().reloaded).toBe(false);
		h.follower.refresh();
		h.calls[1]?.resolve(at({ pos: 1, epoch: 0, boot: "B" }));
		await h.flush();
		expect(h.last().reloaded).toBe(true);
		expect(h.last().at?.boot).toBe("B");
	});
});
