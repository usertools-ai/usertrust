// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `transferVerdict` is the ONE classification of a transfer: `verifyTransaction` renders it, and the ledger UI shows
 * it on every row of the transfer. These rows pin the verdict for each shape a producer writes, and pin that the
 * `--tx` path reports exactly what the exported function returns.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	matchesTransfer,
	normalizeEvent,
	type TransferStatus,
	transferIdHash,
	transferKeysOf,
	transferVerdict,
	verifyTransaction,
} from "../src/index.js";

type Raw = { kind: string; data: Record<string, unknown> };

function chain(events: Raw[]): Array<Record<string, unknown>> {
	return events.map((e, i) => ({
		id: `evt_${i}`,
		actor: "local",
		timestamp: `2026-10-12T12:00:0${i}.000Z`,
		previousHash: i === 0 ? "0".repeat(64) : String(i).repeat(64),
		sequence: i + 1,
		hash: String(i + 1).repeat(64),
		...e,
	}));
}

const T = { transferId: "tx_1" };
const CASES: Array<[string, Raw[], TransferStatus]> = [
	["a settlement", [{ kind: "llm_call", data: { ...T, settled: true, cost: 5 } }], "SETTLED"],
	[
		"the audit-first path: an OPTIMISTIC settled:true, then the POST's ambiguity",
		[
			{ kind: "llm_call", data: { ...T, settled: true, cost: 5 } },
			{ kind: "settlement_ambiguous", data: { ...T, error: "post failed" } },
		],
		"AMBIGUOUS",
	],
	[
		"the headless path: the ambiguity first, then settled:false",
		[
			{ kind: "settlement_ambiguous", data: { ...T, error: "post failed" } },
			{ kind: "llm_call", data: { ...T, settled: false, cost: 5 } },
		],
		"AMBIGUOUS",
	],
	["a failure", [{ kind: "llm_call_failed", data: { ...T, error: "provider 500" } }], "FAILED"],
	[
		"red-first (PENDING): an action's `<kind>_failed` is a failure terminal",
		[{ kind: "tool_use_failed", data: { ...T, error: "tool threw" } }],
		"FAILED",
	],
	["a denial", [{ kind: "policy_denied", data: { ...T, error: "denied" } }], "DENIED"],
	["a release", [{ kind: "hold_released", data: { ...T, reason: "ttl" } }], "RELEASED"],
	[
		"a detection outranked by the settlement after it",
		[
			{ kind: "anomaly_detected", data: { ...T, message: "spike" } },
			{ kind: "llm_call", data: { ...T, settled: true, cost: 5 } },
		],
		"SETTLED",
	],
	[
		"a detection alone: no terminal",
		[{ kind: "anomaly_detected", data: { ...T, message: "spike" } }],
		"PENDING",
	],
];

describe("transferVerdict", () => {
	it.each(CASES)("%s", (_n, events, status) => {
		expect(transferVerdict(chain(events).map(normalizeEvent))?.status).toBe(status);
	});

	it("an unrecoverable settle (only the id's hash): UNRECOVERABLE", () => {
		const ev = chain([
			{ kind: "settlement_unrecoverable", data: { transferIdHash: "f".repeat(64) } },
		]);
		expect(transferVerdict(ev.map(normalizeEvent))?.status).toBe("UNRECOVERABLE");
	});

	it("no records: no verdict", () => {
		expect(transferVerdict([])).toBeUndefined();
	});

	it.each(CASES)(
		"PARITY: `--tx` reports exactly the exported verdict (%s)",
		(_n, events, status) => {
			const dir = mkdtempSync(join(tmpdir(), "usertrust-verdict-"));
			try {
				mkdirSync(join(dir, "audit"), { recursive: true });
				writeFileSync(
					join(dir, "audit", "events.jsonl"),
					`${chain(events)
						.map((l) => JSON.stringify(l))
						.join("\n")}\n`,
				);
				const res = verifyTransaction(dir, "tx_1");
				expect(res.found).toBe(true);
				expect(res.status).toBe(status);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("matchesTransfer and transferKeysOf: the `--tx` match, as a predicate and as keys", () => {
	const H = transferIdHash;
	const EVENTS: Raw[] = [
		{ kind: "llm_call", data: { transferId: "tx_a", settled: true } },
		{ kind: "llm_call", data: { transferId: "" } },
		{ kind: "llm_call", data: {} },
		{ kind: "llm_call", data: { transferId: 7 } },
		// an unrecoverable settle stores only its transferId's hash
		{ kind: "settlement_unrecoverable", data: { transferIdHash: H("tx_a") } },
		// both: it matches the id AND the hash
		{ kind: "settlement_unrecoverable", data: { transferId: "tx_a", transferIdHash: H("tx_b") } },
		{ kind: "settlement_unrecoverable", data: { transferIdHash: H("tx_a").toUpperCase() } },
		{ kind: "settlement_unrecoverable", data: { transferIdHash: 7 } },
		// a coincidental hash on any other kind matches nothing
		{ kind: "hold_released", data: { transferIdHash: H("tx_a") } },
	];
	const IDS = ["tx_a", "tx_b", "tx_c"];

	it.each(EVENTS.map((e, i) => [i, e] as const))(
		"event %i: the two forms agree for every id",
		(_i, raw) => {
			const [e] = chain([raw]).map(normalizeEvent);
			if (e === undefined) throw new Error("no event");
			for (const id of IDS) {
				expect(transferKeysOf(e).includes(H(id)), id).toBe(matchesTransfer(e, id, H(id)));
			}
		},
	);

	it("the keys: a hash-only unrecoverable record joins its transfer; its own id's key comes first", () => {
		const keys = chain(EVENTS)
			.map(normalizeEvent)
			.map((e) => transferKeysOf(e));
		expect(keys).toEqual([
			[H("tx_a")],
			[],
			[],
			[],
			[H("tx_a")],
			[H("tx_a"), H("tx_b")],
			[H("tx_a").toUpperCase()],
			[],
			[],
		]);
	});
});

describe("the receipt renders an action's failure as one", () => {
	it("red-first (no reason): `--tx` on a `<kind>_failed` record prints FAILED and the record's error", () => {
		const dir = mkdtempSync(join(tmpdir(), "usertrust-verdict-receipt-"));
		try {
			mkdirSync(join(dir, "audit"), { recursive: true });
			writeFileSync(
				join(dir, "audit", "events.jsonl"),
				`${chain([{ kind: "tool_use_failed", data: { ...T, error: "the tool threw" } }])
					.map((l) => JSON.stringify(l))
					.join("\n")}\n`,
			);
			const res = verifyTransaction(dir, "tx_1");
			expect(res.status).toBe("FAILED");
			expect(res.receipt).toContain("FAILED");
			expect(res.receipt).toContain("the tool threw");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
