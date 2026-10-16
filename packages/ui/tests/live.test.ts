// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { applyStatusChanges, novelRows } from "../src/shared/live.js";
import type { LedgerRow } from "../src/shared/rows.js";

function row(id: string, hash: string, status: LedgerRow["status"]): LedgerRow {
	return {
		seq: null,
		id,
		ts: "2026-10-12T00:00:00.000Z",
		kind: "llm_call",
		actor: "local",
		hash,
		previousHash: "0".repeat(64),
		integrity: "verified",
		...(status !== undefined ? { status } : {}),
	};
}

describe("the client applies live frames by event HASH, never by a reusable id", () => {
	it("red-first (relabelled both): a status change for one of two rows sharing an id changes only that row", () => {
		const rows = [row("dup", "a".repeat(64), "settled"), row("dup", "b".repeat(64), "failed")];
		const next = applyStatusChanges(rows, [
			{ id: "dup", hash: "a".repeat(64), status: "ambiguous" },
		]);
		expect(next.map((r) => r.status)).toEqual(["ambiguous", "failed"]);
	});

	it("red-first (dropped): a live record reusing an id already held is novel, not a duplicate", () => {
		const held = [row("dup", "a".repeat(64), "settled")];
		const fresh = [row("dup", "b".repeat(64), "failed")];
		expect(novelRows(held, fresh).map((r) => r.hash)).toEqual(["b".repeat(64)]);
	});

	it("a row the resync fetch already returned (the same event, so the same hash) is not added twice", () => {
		const held = [row("x", "a".repeat(64), "settled")];
		expect(novelRows(held, [row("x", "a".repeat(64), "settled")])).toEqual([]);
	});
});
