// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { beforeEach, describe, expect, it } from "vitest";
import type { AtPayload, SummaryPayload } from "../src/shared/api.js";
import {
	type Cutter,
	chainAt,
	createCutter,
	cutRows,
	pastRows,
	rowsAsAnswered,
	vaultKey,
	windowNote,
	windowNoteAt,
} from "../src/shared/asof.js";
import { toCsv } from "../src/shared/csv.js";
import { EMPTY_FILTERS } from "../src/shared/filters.js";
import { type ListInput, listView } from "../src/shared/list-view.js";
import { applyStatusChanges } from "../src/shared/live.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { heldFor } from "../src/shared/verify-view.js";

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

function at(overrides: Partial<AtPayload> = {}): AtPayload {
	return {
		pos: 2,
		ts: "2026-10-12T17:59:02.770Z",
		head: 4,
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

const ROWS = [row(0), row(1), row(2), row(3), row(4)];

describe("cutRows", () => {
	it("cut keeps pos <= at.pos and identity of untouched rows", () => {
		const out = cutRows(ROWS, at({ pos: 2 }));
		expect(out.map((r) => r.pos)).toEqual([0, 1, 2]);
		expect(out[0]).toBe(ROWS[0]);
		expect(out[2]).toBe(ROWS[2]);
	});

	it("cut applies statusAt", () => {
		const out = cutRows(ROWS, at({ pos: 2, statusAt: { [ROWS[1]?.hash ?? ""]: "ambiguous" } }));
		expect(out[1]?.status).toBe("ambiguous");
		expect(out[1]).not.toBe(ROWS[1]);
		expect(ROWS[1]?.status).toBe("settled");
		expect(out[0]).toBe(ROWS[0]);
		expect(out[2]).toBe(ROWS[2]);
	});

	it("cut before the window", () => {
		const held = [row(100), row(101)];
		const payload = at({ pos: 40, head: 101, windowStartPos: 100 });
		expect(cutRows(held, payload)).toEqual([]);
		expect(windowNoteAt(payload)).toBe(
			"The list holds records from position 101; earlier records still count in the totals above.",
		);
	});

	it("rows the server no longer holds are not drawn: it has no statuses for them (a later record may have changed theirs)", () => {
		// The page kept rows 0 and 1 after the server's window moved to 2; a later ambiguity changed row 1 just before it
		// was evicted, so its live status is not the one it had at 3.
		const kept = [row(0), row(1, { status: "ambiguous" }), row(2), row(3), row(4)];
		const out = cutRows(kept, at({ pos: 3, head: 4, windowStartPos: 2 }));
		expect(out.map((r) => r.pos)).toEqual([2, 3]);
		// Out of order (never expected) is cut the same way.
		const shuffled = [kept[3], kept[1], kept[2], kept[0]] as LedgerRow[];
		expect(cutRows(shuffled, at({ pos: 3, head: 4, windowStartPos: 2 })).map((r) => r.pos)).toEqual(
			[3, 2],
		);
	});

	it("cut at head is the input", () => {
		const out = cutRows(ROWS, at({ pos: 4, head: 4 }));
		expect(out).toHaveLength(ROWS.length);
		out.forEach((r, i) => {
			expect(r).toBe(ROWS[i]);
		});
	});
});

describe("windowNoteAt", () => {
	it("is null when the position is inside the window", () => {
		expect(windowNoteAt(at({ pos: 100, windowStartPos: 100 }))).toBeNull();
		expect(windowNoteAt(at({ pos: 2, windowStartPos: 0 }))).toBeNull();
	});
});

describe("cutRows edge cases", () => {
	it("a statusAt key whose row is past the cut leaves the row out", () => {
		const out = cutRows(ROWS, at({ pos: 1, statusAt: { [ROWS[3]?.hash ?? ""]: "ambiguous" } }));
		expect(out.map((r) => r.pos)).toEqual([0, 1]);
	});

	it("a statusAt value equal to the current status keeps the same object", () => {
		const out = cutRows(ROWS, at({ pos: 2, statusAt: { [ROWS[1]?.hash ?? ""]: "settled" } }));
		expect(out[1]).toBe(ROWS[1]);
	});

	it("a __proto__ key is ignored", () => {
		const statusAt = JSON.parse('{"__proto__":"ambiguous"}') as AtPayload["statusAt"];
		const protoRow = row(0, { hash: "__proto__" });
		const out = cutRows([protoRow], at({ pos: 0, statusAt: {} }));
		expect(out[0]).toBe(protoRow);
		const out2 = cutRows(ROWS, at({ pos: 4, statusAt }));
		out2.forEach((r, i) => {
			expect(r).toBe(ROWS[i]);
		});
	});

	it("pos one before the window start returns the note", () => {
		expect(windowNoteAt(at({ pos: 99, windowStartPos: 100 }))).not.toBeNull();
	});
});

describe("windowNote", () => {
	const summary = (truncated: boolean): SummaryPayload =>
		({ truncated, rowCount: 5, chain: { events: 50 } }) as unknown as SummaryPayload;

	it("before the window: only the position's note", () => {
		const n = windowNote(summary(true), at({ pos: 40, windowStartPos: 100 }));
		expect(n).toBe(windowNoteAt(at({ pos: 40, windowStartPos: 100 })));
	});

	it("inside a truncated window at T: the position's own wording, never the live figures", () => {
		const n = windowNote(summary(true), at({ pos: 120, windowStartPos: 100 }));
		expect(n).toBe(
			"The list holds records from position 101 (the newest 5 now); earlier ones count in the totals above.",
		);
		// The live count of events (50) is not a figure at T.
		expect(n).not.toMatch(/of 50/);
	});

	it("inside a truncated window live: the live notice", () => {
		expect(windowNote(summary(true), null)).toMatch(/^Showing the newest 5 of 50 events/);
	});

	it("live and untruncated: null", () => {
		expect(windowNote(summary(false), null)).toBeNull();
		expect(windowNote(summary(false), at({ pos: 120, windowStartPos: 100 }))).toBeNull();
	});
});

describe("chainAt", () => {
	it("the list's chain at T is the position's, never the live verdict", () => {
		expect(chainAt(at({ chain: { valid: true, breakIndex: null } }))).toBe("verified");
		expect(chainAt(at({ chain: { valid: false, breakIndex: 3 } }))).toBe("broken");
	});
});

describe("cutRows on a large, position-ordered window", () => {
	const big = Array.from({ length: 100_000 }, (_, i) => row(1_000 + i));

	it("is the prefix up to the position, by binary search, with every unchanged row the same object", () => {
		const out = cutRows(big, at({ pos: 51_234, head: 100_999 }));
		expect(out).toHaveLength(51_234 - 1_000 + 1);
		expect(out[0]).toBe(big[0]);
		expect(out.at(-1)).toBe(big[50_234]);
	});

	it("overlays statusAt on the rows it names, and only those", () => {
		const named = big[50_000];
		const out = cutRows(
			big,
			at({ pos: 51_234, head: 100_999, statusAt: { [named?.hash ?? ""]: "ambiguous" } }),
		);
		expect(out[50_000]?.status).toBe("ambiguous");
		expect(out[50_000]).not.toBe(named);
		expect(out[49_999]).toBe(big[49_999]);
	});

	it("a position before the window is an empty cut; one past it is the whole window", () => {
		expect(cutRows(big, at({ pos: 999, head: 100_999 }))).toEqual([]);
		expect(cutRows(big, at({ pos: 200_000, head: 200_000 }))).toHaveLength(100_000);
	});

	it("rows that are not in position order are still cut right (no prefix assumed)", () => {
		const shuffled = [row(3), row(1), row(4), row(0), row(2)];
		expect(cutRows(shuffled, at({ pos: 2 })).map((r) => r.pos)).toEqual([1, 0, 2]);
	});
});

describe("rowsAsAnswered", () => {
	// A row's status changed live (an ambiguity after an optimistic settlement) after the answer for position 2 was read:
	// the answer has no statusAt for it, and the row at 2 was settled then.
	const answered = [row(0), row(1), row(2), row(3)];
	const changed = (rows: LedgerRow[], pos: number): LedgerRow[] =>
		rows.map((r) => (r.pos === pos ? { ...r, status: "ambiguous" as const } : r));

	it("keeps the status a row had when the answer was read, until an answer that covers the change lands", () => {
		const now = changed(answered, 1);
		const out = rowsAsAnswered(now, answered, at({ pos: 2 }));
		expect(out[1]?.status).toBe("settled");
		expect(out[1]).toBe(answered[1]);
		// A row after the position is not the answer's to hold.
		expect(rowsAsAnswered(changed(answered, 3), answered, at({ pos: 2 }))[3]?.status).toBe(
			"ambiguous",
		);
		// And cut at the position it reads settled, as it was.
		expect(cutRows(out, at({ pos: 2 })).map((r) => r.status)).toEqual([
			"settled",
			"settled",
			"settled",
		]);
	});

	it("holds nothing when the answer is for a record the page had not yet received: a change that arrives after it may be from a record at or before it", () => {
		// The answer for position 4 overtook the live stream: the page held records 0..3. Record 4 turns row 1 ambiguous
		// (a record AT the position, so `statusAt` has nothing for it), and its frame arrives after the answer.
		const now = changed(answered, 1);
		const out = rowsAsAnswered(now, answered, at({ pos: 4, head: 4 }));
		expect(out).toBe(now);
		expect(out[1]?.status).toBe("ambiguous");
		// At the last record the page held, every later record is after the position: the change is not the position's.
		expect(rowsAsAnswered(now, answered, at({ pos: 3, head: 4 }))[1]?.status).toBe("settled");
	});

	it("leaves a row the answer has a status for to the answer", () => {
		const now = changed(answered, 1);
		const payload = at({ pos: 2, statusAt: { [answered[1]?.hash ?? ""]: "settled" } });
		expect(rowsAsAnswered(now, answered, payload)).toBe(now);
	});

	it("is the rows themselves when nothing changed, live, or no row was held when the answer was read", () => {
		expect(rowsAsAnswered(answered, answered, at({ pos: 2 }))).toBe(answered);
		const copy = [...answered];
		expect(rowsAsAnswered(copy, answered, at({ pos: 2 }))).toBe(copy);
		const now = changed(answered, 1);
		expect(rowsAsAnswered(now, answered, null)).toBe(now);
		expect(rowsAsAnswered(now, [], at({ pos: 2 }))).toBe(now);
		// Rows that arrived after the answer was read are shown as they are.
		const more = [...now, row(4)];
		expect(rowsAsAnswered(more, answered, at({ pos: 4 }))[4]).toBe(more[4]);
	});
});

describe("a list's cutter keeps a past row's identity while its record and its status there are unchanged", () => {
	// Row 1 is ambiguous now (a later record changed it); at position 2 it was settled, so the answer names its status
	// there and the cut shows a projection of the row.
	const live = [row(0), row(1, { status: "ambiguous" }), row(2)];
	const answer = at({ pos: 2, head: 3, statusAt: { [row(1).hash]: "settled" } });
	// Each test draws with its own cutter, as the page keeps one for its list: nothing passes from one test to the next.
	let cutter: Cutter;
	beforeEach(() => {
		cutter = createCutter();
	});
	// What the page draws and shows (it commits the drawn list once React has committed it), and the row it finds again
	// by hash for the open inspector.
	const opened = (rows: LedgerRow[], a: AtPayload | null = answer): LedgerRow => {
		const view = listView(
			{ rows, at: a, filters: EMPTY_FILTERS, phase: "loaded", summary: null },
			cutter,
		);
		cutter.commit(view.shownRows);
		const found = view.shownRows.find((r) => r.hash === row(1).hash);
		if (found === undefined) throw new Error("row 1 is not drawn");
		return found;
	};
	const rowOne = (rows: LedgerRow[]): LedgerRow | undefined => rows.find((r) => r.pos === 1);

	it("red-first: a check started on such a row still shows its receipt after an unrelated record arrives", () => {
		const first = opened(live);
		expect(first.status).toBe("settled");
		// The inspector holds the check for the row object it was started on (`heldFor`).
		const check = { row: first, value: "receipt" };
		// An unrelated append: a new rows array with the same row objects, and the same answer (its re-read read the same).
		expect(heldFor(check, opened([...live, row(3)]))).toBe("receipt");
		// The cutter itself: the same object for that row across two draws with the same record and answer, the first
		// one shown.
		const drawn = cutter.cut(live, answer);
		cutter.commit(drawn);
		const a = rowOne(drawn);
		expect(a).toBeDefined();
		expect(rowOne(cutter.cut(live, answer))).toBe(a);
	});

	it("CONTROL: a real status change of the record still clears the held receipt", () => {
		const check = { row: opened(live), value: "receipt" };
		// A status frame replaces row 1 with a new version of the record, as the page applies it.
		const corrected = applyStatusChanges(live, [
			{ id: row(1).id, hash: row(1).hash, status: "failed" },
		]);
		const shown = opened(corrected);
		expect(shown.status).toBe("settled");
		expect(heldFor(check, shown)).toBeNull();
	});

	it("another status at the position is another projection, and so is changing back, as for a status correction", () => {
		const other = at({ pos: 2, head: 3, statusAt: { [row(1).hash]: "released" } });
		const first = opened(live);
		const check = { row: first, value: "receipt" };
		const second = opened(live, other);
		expect(second.status).toBe("released");
		expect(heldFor(check, second)).toBeNull();
		expect(heldFor(check, opened(live))).toBeNull();
		// A row whose status there is its status now is the row itself.
		expect(cutRows(live, answer).find((r) => r.pos === 0)).toBe(live[0]);
	});

	it("a draw that shows the row as it is now, between two that project it, ends the projection (it failed against a copy kept by status alone)", () => {
		// The page moves to an answer that does not name row 1 (its status there is its status now), then to a new answer
		// that names it settled again: a new version, so a receipt from before, or one that landed in between, stays hidden.
		const check = { row: opened(live), value: "receipt" };
		const between = opened(live, at({ pos: 2, head: 3, statusAt: {} }));
		expect(between).toBe(live[1]);
		expect(heldFor(check, between)).toBeNull();
		const again = opened(live, at({ pos: 2, head: 3, statusAt: { [row(1).hash]: "settled" } }));
		expect(again.status).toBe("settled");
		expect(heldFor(check, again)).toBeNull();
		// The same when the answer in between names the row with its status now.
		const check2 = { row: again, value: "receipt" };
		opened(live, at({ pos: 2, head: 3, statusAt: { [row(1).hash]: "ambiguous" } }));
		const third = opened(live, at({ pos: 2, head: 3, statusAt: { [row(1).hash]: "settled" } }));
		expect(heldFor(check2, third)).toBeNull();
	});

	it("drawing live between two draws that project the row ends the projection (it failed while the live view did not end the run)", () => {
		// The operator checks the row at the point, goes live and comes back. The live view drew the record as it is now,
		// so a receipt from before, or one that landed while live, stays hidden.
		const check = { row: opened(live), value: "receipt" };
		expect(opened(live, null)).toBe(live[1]);
		expect(heldFor(check, live[1] as LedgerRow)).toBeNull();
		const back = opened(live, at({ pos: 2, head: 3, statusAt: { [row(1).hash]: "settled" } }));
		expect(back.status).toBe("settled");
		expect(heldFor(check, back)).toBeNull();
	});

	it("a new reading that leaves the row's status there unchanged keeps the projection, and the receipt", () => {
		const check = { row: opened(live), value: "receipt" };
		// Another row's status there is new, so the reading is a new answer; row 1's status there is the same.
		const next = at({
			pos: 2,
			head: 4,
			statusAt: { [row(1).hash]: "settled", [row(0).hash]: "released" },
		});
		expect(heldFor(check, opened(live, next))).toBe("receipt");
	});

	it("red-first (a draw thrown away before it was shown): a cut that is never committed leaves the projection on screen to reuse", () => {
		// The page shows row 1 at the point, with a check's receipt held for it. A move to another reading starts a draw
		// that React throws away (the operator came back before it was shown), so it is never committed. Kept as the
		// cutter's state, that draw ended the projection on screen, and the page's next draw at the point lost the receipt.
		const check = { row: opened(live), value: "receipt" };
		cutter.cut(live, at({ pos: 2, head: 3, statusAt: { [row(1).hash]: "released" } }));
		expect(heldFor(check, opened(live))).toBe("receipt");
	});

	it("red-first: a live draw that is never committed does not end the projection either", () => {
		const check = { row: opened(live), value: "receipt" };
		cutter.live(live);
		expect(heldFor(check, opened(live))).toBe("receipt");
	});

	it("the draw committed is the one kept, whichever of the draws made since the last commit it is", () => {
		// Two draws made before a commit (a render restarted, or run twice): the one committed decides what the next cut
		// reuses.
		const first = cutter.cut(live, answer);
		const second = cutter.cut(live, answer);
		expect(rowOne(second)).not.toBe(rowOne(first));
		cutter.commit(second);
		expect(rowOne(cutter.cut(live, answer))).toBe(rowOne(second));
		// Committing a list this cutter did not draw changes nothing.
		cutter.commit([...live]);
		expect(rowOne(cutter.cut(live, answer))).toBe(rowOne(second));
		// Nor does a draw made before the last commit: a commit drops every draw staged before it.
		const stale = cutter.cut(
			live,
			at({ pos: 2, head: 3, statusAt: { [row(1).hash]: "released" } }),
		);
		const newer = cutter.cut(live, answer);
		cutter.commit(newer);
		cutter.commit(stale);
		expect(rowOne(cutter.cut(live, answer))).toBe(rowOne(newer));
		// A live draw, committed, ends it; its list is the rows themselves.
		const shownLive = cutter.live(live);
		expect(shownLive).toBe(live);
		cutter.commit(shownLive);
		expect(rowOne(cutter.cut(live, answer))).not.toBe(rowOne(second));
	});

	it("two cutters interleaved keep their own projections", () => {
		const other = createCutter();
		const drawnMine = cutter.cut(live, answer);
		cutter.commit(drawnMine);
		const drawnTheirs = other.cut(live, answer);
		other.commit(drawnTheirs);
		const mine = rowOne(drawnMine);
		const theirs = rowOne(drawnTheirs);
		expect(mine).toBeDefined();
		expect(theirs).not.toBe(mine);
		// The other list draws the row as it is now, then live: its own run ends, this one's does not.
		other.commit(other.cut(live, at({ pos: 2, head: 3, statusAt: {} })));
		other.commit(other.live(live));
		expect(rowOne(cutter.cut(live, answer))).toBe(mine);
		expect(rowOne(other.cut(live, answer))).not.toBe(theirs);
	});

	it("a stateless cutRows call between two of the list's draws neither ends nor reuses the list's projections", () => {
		const first = opened(live);
		// A direct cut that shows the row as it is now, and direct cuts that project it: each keeps nothing.
		expect(rowOne(cutRows(live, at({ pos: 2, head: 3, statusAt: {} })))).toBe(live[1]);
		const direct = rowOne(cutRows(live, answer));
		expect(direct?.status).toBe("settled");
		expect(direct).not.toBe(first);
		expect(rowOne(cutRows(live, answer))).not.toBe(direct);
		// The list's next draw still reuses its own projection.
		expect(opened(live)).toBe(first);
	});
});

describe("rows older than the window the answer covers", () => {
	// The page kept rows 0..2 after the server's window moved to 3. A record after the position changed row 1; the
	// server evicted it before it could say so, so its live status is not a status at the position.
	const held = [row(0), row(1, { status: "ambiguous" }), row(2), row(3), row(4), row(5)];
	const listInput = (payload: AtPayload): ListInput => ({
		rows: held,
		at: payload,
		filters: EMPTY_FILTERS,
		phase: "loaded",
		summary: null,
	});

	it("are not drawn at a position inside the window", () => {
		const view = listView(listInput(at({ pos: 4, head: 5, windowStartPos: 3 })));
		expect(view.shownRows.map((r) => r.pos)).toEqual([3, 4]);
		expect(view.beforeWindow).toBeNull();
	});

	it("leave a position before the window to the note that names where the list starts", () => {
		const payload = at({ pos: 1, head: 5, windowStartPos: 3 });
		const view = listView(listInput(payload));
		expect(view.shownRows).toEqual([]);
		expect(view.beforeWindow).toEqual({ kind: "before", firstHeld: 3, upTo: 1 });
		expect(windowNoteAt(payload)).toContain("from position 4");
	});
});

describe("vaultKey", () => {
	it("a valid boot and epoch give the key", () => {
		expect(vaultKey("boot-a", 0)).toBe("boot-a:0");
		expect(vaultKey("boot-a", 7)).toBe("boot-a:7");
	});

	it("is null for a missing, empty or non-string boot", () => {
		for (const boot of [undefined, null, "", 3, {}]) expect(vaultKey(boot, 1)).toBeNull();
	});

	it("is null for a missing, negative, fractional, non-finite or string epoch", () => {
		for (const epoch of [
			undefined,
			null,
			-1,
			1.5,
			"3",
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
			{},
		])
			expect(vaultKey("boot-a", epoch)).toBeNull();
	});

	it("two different boots with the same epoch give different keys", () => {
		expect(vaultKey("boot-a", 0)).not.toBe(vaultKey("boot-b", 0));
	});
});

describe("pastRows: the rows a past view draws, paired with its answer by the vault they come from", () => {
	// A reload with other records: record 1 (100 UT) is replaced by another record (500 UT) at the same position.
	const old = [row(0, { id: "a", costUt: 10 }), row(1, { id: "b", costUt: 100 })];
	const reloaded = [
		row(0, { id: "a", costUt: 10 }),
		row(1, { id: "b2", costUt: 500, hash: "f".repeat(64) }),
	];
	const V0 = "boot-a:0";
	const V1 = "boot-a:1";
	const answer = (epoch: number, boot = "boot-a") =>
		at({ pos: 1, spentUt: 110, epoch, boot, statusAt: {} });
	const draw = (rows: LedgerRow[], a: AtPayload) =>
		listView({ rows, at: a, filters: EMPTY_FILTERS, phase: "loaded", summary: null });

	it("rows first: the live rows are the reloaded vault's, the answer is the old one's, so the answer's own rows are drawn", () => {
		const a = answer(0);
		const past = pastRows(reloaded, V1, { rows: old, rowsVault: V0 }, a);
		expect(past.kind).toBe("snapshot");
		const shown = draw(past.rows, a).shownRows;
		expect(shown.map((r) => r.id)).toEqual(["a", "b"]);
		expect(shown.reduce((sum, r) => sum + (r.costUt ?? 0), 0)).toBe(a.spentUt);
		const csv = toCsv(shown);
		expect(csv).toContain(",b,");
		expect(csv).not.toContain("b2");
	});

	it("answer first, before its resync: nothing of the answer's vault is held, so nothing is drawn", () => {
		const a = answer(1);
		const past = pastRows(old, V0, { rows: old, rowsVault: V0 }, a);
		expect(past).toEqual({ kind: "held", rows: [] });
		const view = draw(past.rows, a);
		expect(view.shownRows).toEqual([]);
		expect(view.beforeWindow).toEqual({ kind: "not-held", upTo: 1 });
		expect(view.filtered.length).toBe(0);
	});

	it("answer first, after its resync: still held, the answer was read against another vault's rows", () => {
		// The live rows are the answer's vault, but its statuses were read against the old rows: no evidence to read the
		// live rows' statuses at the point, so the view waits for a read against the reloaded rows.
		const a = answer(1);
		expect(pastRows(reloaded, V1, { rows: old, rowsVault: V0 }, a)).toEqual({
			kind: "held",
			rows: [],
		});
	});

	it("answer first, once a read against the reloaded rows has landed: answered", () => {
		const a = answer(1);
		const past = pastRows(reloaded, V1, { rows: reloaded, rowsVault: V1 }, a);
		expect(past.kind).toBe("answered");
		expect(draw(past.rows, a).shownRows.map((r) => r.id)).toEqual(["a", "b2"]);
	});

	it("a request sent during a resync (its rows' vault unknown) never draws the live rows", () => {
		const a = answer(1);
		expect(pastRows(reloaded, V1, { rows: reloaded, rowsVault: null }, a)).toEqual({
			kind: "held",
			rows: [],
		});
	});

	it("an unrelated resync mid-reload (rows re-fetched for the old vault while the answer is the new one's) is held", () => {
		const past = pastRows(old, V0, { rows: old, rowsVault: V0 }, answer(1));
		expect(past).toEqual({ kind: "held", rows: [] });
	});

	it("a server restart is a different vault even at the same epoch: held, never answered or snapshot", () => {
		// Rows and snapshot from boot A epoch 0; the answer is from boot B, which also starts at epoch 0.
		const past = pastRows(
			old,
			"boot-a:0",
			{ rows: old, rowsVault: "boot-a:0" },
			answer(0, "boot-b"),
		);
		expect(past).toEqual({ kind: "held", rows: [] });
	});

	it("a missing boot or epoch on either side never matches, not even another missing one", () => {
		const a0 = answer(0);
		const noBoot = at({ pos: 1, epoch: 0 });
		const noEpoch = { ...a0, epoch: undefined as unknown as number };
		const missing: Array<[string | null, string | null, AtPayload]> = [
			[null, null, a0],
			[V0, null, noBoot],
			[null, null, noBoot],
			[null, null, noEpoch],
			[V0, V0, noBoot],
			[V0, V0, noEpoch],
			[V0, V0, { ...a0, boot: "", epoch: Number.NaN }],
		];
		for (const [liveVault, rowsVault, a] of missing) {
			expect(pastRows(reloaded, liveVault, { rows: old, rowsVault }, a)).toEqual({
				kind: "held",
				rows: [],
			});
		}
	});

	it("CONTROL: all one vault gives the same rows as rowsAsAnswered", () => {
		const a = at({
			pos: 1,
			epoch: 0,
			boot: "boot-a",
			statusAt: { [old[0]?.hash ?? ""]: "ambiguous" },
		});
		const live = [old[0] as LedgerRow, { ...(old[1] as LedgerRow), status: "ambiguous" as const }];
		const past = pastRows(live, V0, { rows: old, rowsVault: V0 }, a);
		expect(past.kind).toBe("answered");
		expect(past.rows).toEqual(rowsAsAnswered(live, old, a));
	});

	it("the live rows are drawn only with a snapshot of the same vault to read their statuses against", () => {
		const a = answer(1);
		expect(pastRows(reloaded, V1, { rows: old, rowsVault: V0 }, a).kind).toBe("held");
		expect(pastRows(reloaded, V1, { rows: reloaded, rowsVault: V1 }, a).kind).toBe("answered");
	});

	it("an answer for a record the page had not received when it asked is held: a later record's live status never shows at the point", () => {
		// The page held records 0..1 when it asked; the answer is for record 2 (it overtook the live stream). Record 3 then
		// turned row 1 ambiguous and its frames arrived after the answer: the answer has no status for row 1, because
		// record 3 did not exist when it was read, and at 2 the row was settled.
		const asked = [row(0, { id: "a" }), row(1, { id: "b" })];
		const live = [
			asked[0] as LedgerRow,
			{ ...(asked[1] as LedgerRow), status: "ambiguous" as const },
			row(2, { id: "c" }),
			row(3, { id: "d" }),
		];
		const a = at({ pos: 2, head: 2, epoch: 0, boot: "boot-a", statusAt: {} });
		expect(pastRows(live, V0, { rows: asked, rowsVault: V0 }, a)).toEqual({
			kind: "held",
			rows: [],
		});
		// Nor is that snapshot drawn by itself when the page's rows are another vault's: it lacks record 2 and what it did.
		expect(pastRows(live, V1, { rows: asked, rowsVault: V0 }, a)).toEqual({
			kind: "held",
			rows: [],
		});
	});

	it("CONTROL: a snapshot that reaches the position is read as the answer, with the status each row had there", () => {
		const asked = [row(0, { id: "a" }), row(1, { id: "b" }), row(2, { id: "c" })];
		const live = [
			asked[0] as LedgerRow,
			{ ...(asked[1] as LedgerRow), status: "ambiguous" as const },
			asked[2] as LedgerRow,
			row(3, { id: "d" }),
		];
		const a = at({ pos: 2, head: 2, epoch: 0, boot: "boot-a", statusAt: {} });
		const past = pastRows(live, V0, { rows: asked, rowsVault: V0 }, a);
		expect(past.kind).toBe("answered");
		expect(draw(past.rows, a).shownRows.map((r) => `${r.id}:${r.status}`)).toEqual([
			"a:settled",
			"b:settled",
			"c:settled",
		]);
		// A snapshot that ends at the position is the answer's own rows when the page's rows are another vault's.
		expect(pastRows(live, V1, { rows: asked, rowsVault: V0 }, a).kind).toBe("snapshot");
	});

	it("live (no answer) is the live rows themselves", () => {
		const past = pastRows(reloaded, V1, { rows: old, rowsVault: V0 }, null);
		expect(past.kind).toBe("live");
		expect(past.rows).toBe(reloaded);
	});
});
