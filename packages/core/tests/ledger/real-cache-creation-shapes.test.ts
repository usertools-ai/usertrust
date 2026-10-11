// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * EVIDENCE for a declared residue (#203): the real Anthropic API reports BOTH TTL fields.
 *
 * `fromAnthropicUsage` prices the unattributed part of a PARTIAL `cache_creation`
 * breakdown (one TTL field present) at the dearer 1-hour rate, and the stream accumulators
 * only ever rise, so a stream whose early event is partial and whose later event is
 * complete keeps the conservative inferred share (it overstates; overstatement is still
 * inaccuracy). That is accepted because the partial shape is not one the API emits. This
 * test pins the premise to captured data instead of asserting it in prose:
 *
 *  - 73,292 distinct real usage blocks from Claude Code transcripts (scanned
 *    2026-10-08, across opus/sonnet/fable/haiku/mythos generations): every one carries BOTH
 *    `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`, and their sum equals
 *    `cache_creation_input_tokens` (0 violations). The shapes seen were 5m-only (49,135),
 *    1h-only (23,999) and zero (158); a block with both TTLs non-zero was never seen.
 *  - the API reference documents `CacheCreation { ephemeral_1h_input_tokens,
 *    ephemeral_5m_input_tokens }` with both fields defaulting to 0.
 *
 * If this fixture ever shows a partial block, the residue's premise is false and the
 * accumulator rework (track reported 5m/1h separately from the flat total) is no longer
 * optional.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fromAnthropicUsage } from "../../src/ledger/usage.js";

interface Block {
	model: string;
	cache_creation_input_tokens: number;
	cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
}
const fixture = JSON.parse(
	readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"fixtures",
			"real-anthropic-cache-creation.json",
		),
		"utf-8",
	),
) as {
	stats: { distinctBlocks: number; violations: number };
	sample: Block[];
};

describe("real Anthropic cache_creation payloads (captured)", () => {
	it("the scan found no partial or inconsistent block among the distinct real ones", () => {
		expect(fixture.stats.distinctBlocks).toBeGreaterThan(50_000);
		expect(fixture.stats.violations).toBe(0);
	});

	it("the sample covers 5m-only, 1h-only and zero shapes across model generations", () => {
		const shapes = new Set(
			fixture.sample.map((b) =>
				b.cache_creation.ephemeral_1h_input_tokens > 0
					? "1h"
					: b.cache_creation.ephemeral_5m_input_tokens > 0
						? "5m"
						: "zero",
			),
		);
		expect([...shapes].sort()).toEqual(["1h", "5m", "zero"]);
		expect(new Set(fixture.sample.map((b) => b.model)).size).toBeGreaterThanOrEqual(4);
	});

	it("every sampled block carries BOTH TTL fields and they sum to the flat total", () => {
		for (const b of fixture.sample) {
			expect(typeof b.cache_creation.ephemeral_5m_input_tokens, b.model).toBe("number");
			expect(typeof b.cache_creation.ephemeral_1h_input_tokens, b.model).toBe("number");
			expect(
				b.cache_creation.ephemeral_5m_input_tokens + b.cache_creation.ephemeral_1h_input_tokens,
				b.model,
			).toBe(b.cache_creation_input_tokens);
		}
	});

	it("our extractor reads each as reported: write total = flat total, 1h = the reported 1h count, nothing inferred", () => {
		for (const b of fixture.sample) {
			const u = fromAnthropicUsage({
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: b.cache_creation_input_tokens,
				cache_creation: b.cache_creation,
			});
			expect(u.cacheWriteTokens, b.model).toBe(b.cache_creation_input_tokens);
			expect(u.cacheWrite1hTokens ?? 0, b.model).toBe(b.cache_creation.ephemeral_1h_input_tokens);
		}
	});
});
