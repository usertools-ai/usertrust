// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust-verify --tx <id>` finds a `settlement_unrecoverable` record.
 *
 * That record stores only the SHA-256 of the transferId (the id of a hold the server did not hold is
 * caller text, and the chain carries no caller text), so matching on `data.transferId` could never
 * find it: the one record that says "this usage was NOT charged" was invisible to the tool an auditor
 * uses to look a transaction up. The id is hashed here the way the producer hashes it.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyTransaction } from "../src/index.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function verifyChainOf(events: Array<Record<string, unknown>>, txId: string) {
	const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-unrecoverable-"));
	try {
		mkdirSync(join(dir, "audit"), { recursive: true });
		const lines = events.map((e, i) => ({
			actor: "local",
			timestamp: `2026-10-11T12:00:0${i}.000Z`,
			previousHash: i === 0 ? "0".repeat(64) : String(i).repeat(64),
			sequence: i + 1,
			hash: String(i + 1).repeat(64),
			...e,
		}));
		writeFileSync(
			join(dir, "audit", "events.jsonl"),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
			"utf-8",
		);
		return verifyTransaction(dir, txId);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const UNRECOVERABLE = (id: string) => ({
	kind: "settlement_unrecoverable",
	data: {
		transferIdHash: sha(id),
		reason: "no hold for this transferId: swept, restarted or already settled",
		source: "headless",
	},
});

describe("--tx and settlement_unrecoverable", () => {
	it("finds the record by the hash of the queried id and renders UNRECOVERABLE with its reason", () => {
		const r = verifyChainOf([UNRECOVERABLE("tx_lost")], "tx_lost");
		expect(r.found).toBe(true);
		expect(r.receipt).toContain("UNRECOVERABLE");
		expect(r.receipt).not.toContain("PENDING");
		expect(r.receipt).toContain("Reason:");
		expect(r.receipt).toContain("swept, restarted");
		// only the hash is on the chain, and the receipt says so instead of inventing an id
		expect(r.receipt).toContain("TX (sha256)");
		expect(r.receipt).toContain(sha("tx_lost").slice(0, 20));
		expect(r.receipt).not.toContain("tx_lost");
	});

	it("does not find it under another id", () => {
		const r = verifyChainOf([UNRECOVERABLE("tx_lost")], "tx_other");
		expect(r.found).toBe(false);
	});

	it("a different kind carrying the same hash field is not matched", () => {
		const r = verifyChainOf(
			[{ kind: "llm_call", data: { transferIdHash: sha("tx_x"), cost: 5, settled: true } }],
			"tx_x",
		);
		expect(r.found).toBe(false);
	});

	it("a charged settle that comes first stays SETTLED; a later duplicate record cannot rewrite it", () => {
		const r = verifyChainOf(
			[
				{ kind: "llm_call", data: { model: "m", cost: 50, settled: true, transferId: "tx_1" } },
				UNRECOVERABLE("tx_1"),
			],
			"tx_1",
		);
		expect(r.found).toBe(true);
		expect(r.receipt).toContain("SETTLED");
		expect(r.receipt).not.toContain("UNRECOVERABLE");
	});

	it("an unrecoverable record is conclusive: a later forged `settled: true` cannot rewrite it", () => {
		const r = verifyChainOf(
			[
				UNRECOVERABLE("tx_2"),
				{ kind: "llm_call", data: { model: "m", cost: 50, settled: true, transferId: "tx_2" } },
			],
			"tx_2",
		);
		expect(r.found).toBe(true);
		expect(r.receipt).toContain("UNRECOVERABLE");
		expect(r.receipt).not.toContain("SETTLED");
	});

	it("an empty id still matches nothing", () => {
		expect(verifyChainOf([UNRECOVERABLE("tx_lost")], "").found).toBe(false);
	});
});
