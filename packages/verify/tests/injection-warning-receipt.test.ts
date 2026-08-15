// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * THE MERGE-ORDER DEPENDENCY, MADE MECHANICAL.
 *
 * This branch adds `transferId` to `injection_detected` so a detection can be
 * correlated with its own call. Under the DEFAULT `injection: "warn"` that event
 * is appended BEFORE the hold and the terminal — so against a selector that takes
 * the first record matching the transferId, the receipt for an ordinary,
 * successful, billed call renders PENDING with no cost.
 *
 * The selector that makes it safe — first CONCLUSIVE TERMINAL in chain order,
 * detections excluded because a detection is not a terminal — lands on the
 * receipt-hardening branch. So this branch must not merge before that one.
 *
 * A note in the PR body would be a rule someone has to read. This is the same
 * rule with a failure rate of zero: until the selector is present, this test is
 * red and the branch cannot merge. Nobody needs to know why, and nobody has to
 * remember in three weeks.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical.js";
import { GENESIS_HASH } from "../src/constants.js";
import { verifyTransaction } from "../src/index.js";

describe("a warn-mode injection detection is not the transaction's outcome", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "usertrust-injection-warn-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("renders the SETTLED terminal, not the earlier warning", () => {
		const auditDir = join(dir, "audit");
		mkdirSync(auditDir, { recursive: true });

		// A real chain: the warning is appended first, exactly as the governor
		// writes it, and the settlement follows.
		let previousHash = GENESIS_HASH;
		const lines: string[] = [];
		const bodies: Array<Record<string, unknown>> = [
			{
				kind: "injection_detected",
				actor: "local",
				data: { transferId: "tx_warn", patterns: ["ignore previous"], score: 0.4 },
			},
			{
				kind: "llm_call",
				actor: "local",
				data: { transferId: "tx_warn", settled: true, cost: 1234, model: "claude-sonnet" },
			},
		];
		bodies.forEach((body, i) => {
			const event = {
				...body,
				timestamp: `2026-08-14T00:00:0${i}.000Z`,
				sequence: i + 1,
				previousHash,
			};
			const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
			lines.push(JSON.stringify({ ...event, hash }));
			previousHash = hash;
		});
		writeFileSync(join(auditDir, "events.jsonl"), `${lines.join("\n")}\n`, "utf-8");

		const result = verifyTransaction(dir, "tx_warn");

		// A detection is not a terminal. Selecting it reports an ordinary billed
		// call as PENDING and suppresses its spend — an affirmative false statement
		// about money on a call that succeeded.
		expect(result.receipt).not.toContain("PENDING");
		expect(result.receipt).toContain("SETTLED");
	});
});
