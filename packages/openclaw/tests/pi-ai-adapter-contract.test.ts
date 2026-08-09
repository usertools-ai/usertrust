// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * pi-ai-adapter-contract.test.ts — pins `@mariozechner/pi-ai`@0.73.1's
 * per-adapter cache-token normalization (spec D2's pi-ai rows) against
 * openclaw's own normalization (`extractUsageFromEvent` /
 * `normalizeHostUsage` in `token-extractor.ts`).
 *
 * D2's claim for this SOURCE: "pi-ai @ pinned 0.73.1 — Anthropic,
 * OpenAI-completions, Google/Vertex, Bedrock adapters | already disjoint |
 * pass through — subtracting again UNDERCOUNTS"; "pi-ai Responses adapter |
 * forces cacheWrite: 0 ... | pass through"; "pi-ai Faux adapter | input
 * overlaps cache-write | subtract (clamp >= 0)". Every row below gets a test.
 *
 * WHY FIVE OF SIX ROWS ARE HAND-BUILT FIXTURES, NOT LIVE PI-AI CALLS:
 * five of pi-ai's providers export ONLY the network-calling `stream*`
 * functions (see `node_modules/@mariozechner/pi-ai/package.json`'s `exports`
 * map: `./anthropic`, `./openai-completions`, `./openai-responses`,
 * `./google`, `./bedrock-provider` — no unit-testable usage-computation
 * helper). Exercising them for real means mocking an HTTP/SSE transport per
 * provider, which proves the same arithmetic these fixtures pin, at far
 * higher cost and fragility, for a devDependency this package's own README
 * (`packages/openclaw/README.md:203`) and `openclaw-contract.env` both
 * describe (accurately, for those two files) as read TYPE-ONLY. The
 * fixtures below are PORTS of the pinned source (same discipline as
 * `host-fixtures.ts`'s `PinnedEventStream`), each cited to the exact 0.73.1
 * line numbers that produced it, not values pulled from documentation.
 *
 * Faux is the deliberate exception: it needs no network mock (it is
 * pi-ai's own in-memory mock adapter), so its test below drives TWO REAL
 * `stream()` calls against the pinned 0.73.1 package at test-run time — a
 * genuinely live contract, not a fixture. That is a real, if narrow,
 * departure from this file's "read TYPE-ONLY" framing for `@mariozechner/pi-ai`
 * as a whole: this one test file now also exercises pi-ai's runtime code
 * (never its shipped output — `packages/openclaw`'s own runtime never
 * imports pi-ai). See that section for why the trade was made.
 */

import type { Context, UserMessage } from "@mariozechner/pi-ai";
import { fauxAssistantMessage, registerFauxProvider, stream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { extractUsageFromEvent } from "../src/token-extractor.js";
import type { Usage } from "../src/types.js";
import { doneEvent } from "./host-fixtures.js";

function usage(input: number, output: number, cacheRead: number, cacheWrite: number): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("pi-ai adapter contract (0.73.1) — D2 pi-ai rows, pass-through pinned", () => {
	/**
	 * `dist/providers/anthropic.js:338-342` (message_start) and `:488-496`
	 * (message_delta) assign `cacheRead`/`cacheWrite` straight from the raw
	 * `cache_read_input_tokens`/`cache_creation_input_tokens` SSE fields;
	 * `input` comes from `input_tokens` untouched. No arithmetic connects the
	 * three counters — they are disjoint by construction.
	 */
	it("Anthropic: disjoint counters pass through unchanged (regression pin — fails if openclaw ever subtracts)", () => {
		const result = extractUsageFromEvent(doneEvent(usage(1000, 50, 500, 200)));
		expect(result).toEqual({
			inputTokens: 1000,
			outputTokens: 50,
			cacheReadTokens: 500,
			cacheWriteTokens: 200,
		});
	});

	/**
	 * `dist/providers/openai-completions.js:794-814` (`parseChunkUsage`)
	 * computes `input = max(0, prompt_tokens - cacheReadTokens -
	 * cacheWriteTokens)` ITSELF before pi-ai ever hands openclaw the message —
	 * unlike core-direct OpenAI completions extraction (spec D2's OTHER
	 * "OpenAI completions" row, core's own job, Task 3), the pi-ai-delivered
	 * `Usage` here is already disjoint.
	 */
	it("OpenAI completions: disjoint counters pass through unchanged (regression pin)", () => {
		const result = extractUsageFromEvent(doneEvent(usage(300, 50, 500, 200)));
		expect(result).toEqual({
			inputTokens: 300,
			outputTokens: 50,
			cacheReadTokens: 500,
			cacheWriteTokens: 200,
		});
	});

	/**
	 * `dist/providers/google.js:156-167`: `input = promptTokenCount -
	 * cachedContentTokenCount`, `output = candidatesTokenCount +
	 * thoughtsTokenCount` (thinking tokens folded into output, mirroring
	 * core-direct Gemini per D2), `cacheWrite` hardcoded `0` (Gemini has no
	 * write tier). Computed by pi-ai itself — already disjoint.
	 */
	it("Google/Vertex: disjoint counters (thoughtsTokenCount pre-folded into output) pass through unchanged", () => {
		const result = extractUsageFromEvent(doneEvent(usage(500, 120, 80, 0)));
		expect(result).toEqual({
			inputTokens: 500,
			outputTokens: 120,
			cacheReadTokens: 80,
			cacheWriteTokens: 0,
		});
	});

	/**
	 * `dist/providers/amazon-bedrock.js:312-319` (`handleMetadata`) assigns
	 * all four counters straight from the Converse API's own disjoint
	 * `inputTokens`/`outputTokens`/`cacheReadInputTokens`/
	 * `cacheWriteInputTokens` fields — no arithmetic, no overlap.
	 */
	it("Bedrock: disjoint counters pass through unchanged (regression pin)", () => {
		const result = extractUsageFromEvent(doneEvent(usage(700, 90, 300, 150)));
		expect(result).toEqual({
			inputTokens: 700,
			outputTokens: 90,
			cacheReadTokens: 300,
			cacheWriteTokens: 150,
		});
	});

	/**
	 * `dist/providers/openai-responses-shared.js:430-440` subtracts
	 * `input_tokens_details.cached_tokens` from `input_tokens` (disjoint read
	 * tier) but never assigns `cacheWrite` — it stays at the `0` the usage
	 * object is constructed with (`:49-52`). Cache-WRITE tokens for this
	 * adapter therefore ride inside `input` and price at `inputPer1k` — the
	 * D1-conservative direction (documented, not a bug). This pins that
	 * openclaw does not "fix" the forced zero by inventing a write count.
	 */
	it("OpenAI Responses: forced cacheWrite:0 passes through undisturbed (documented D1-conservative)", () => {
		const result = extractUsageFromEvent(doneEvent(usage(400, 60, 150, 0)));
		expect(result).toEqual({
			inputTokens: 400,
			outputTokens: 60,
			cacheReadTokens: 150,
			cacheWriteTokens: 0,
		});
	});

	/**
	 * pi-ai's Faux adapter — the ONE D2 pi-ai row NOT pass-through-safe, and
	 * the one row this test drives LIVE rather than pinning with a fixture.
	 *
	 * Unlike the five rows above, Faux's `withUsageEstimate`
	 * (`dist/providers/faux.js:116-146`) is reachable from the package's
	 * PUBLIC entry point at runtime (`registerFauxProvider`, `stream`,
	 * `fauxAssistantMessage` are all re-exported from `.`, unlike a deep
	 * import of `dist/providers/faux.js` itself, which throws
	 * ERR_PACKAGE_PATH_NOT_EXPORTED — there is no `./faux` subpath), and it
	 * needs no HTTP/SSE mock (it IS the in-memory mock). So rather than
	 * hand-computing what 0.73.1 would produce, the test below makes two real
	 * `stream(...).result()` calls against the pinned package and reads the
	 * resulting `Usage` straight off the wire:
	 *
	 *   call 1: a 99-char user message ("user:" + 99 chars = 104 chars, a
	 *   multiple of 4 — see below for why that matters), sessionId set,
	 *   `cacheRetention: "long"`. Faux has no prior prompt for this
	 *   sessionId, so per `faux.js:125-136` the WHOLE prompt is billed as a
	 *   cache write (this is call 1's own instance of the same overlap, not
	 *   just call 2's).
	 *
	 *   call 2: same sessionId/retention, context = call 1's message + call
	 *   1's own reply + a new user message. Call 2's serialized prompt
	 *   therefore starts with an EXACT copy of call 1's serialized prompt
	 *   (`faux.js:96-108`'s `serializeContext`), so
	 *   `commonPrefixLength` (`faux.js:109-116`) walks the full 104 characters
	 *   of call 1's prompt and no further — a genuine cache hit, not a
	 *   fixture standing in for one.
	 *
	 * `input === cacheWrite` on call 2 is not a coincidence of the chosen
	 * lengths: per `faux.js:129-131`, `input = max(0, promptTokens -
	 * cacheRead)` while `cacheWrite = estimateTokens(promptText.slice(cachedChars))`
	 * — BOTH describe the identical uncached tail of the prompt.
	 * `estimateTokens` is `ceil(len/4)` (`faux.js:52-54`); because call 1's
	 * prompt length (104) is an exact multiple of 4, `ceil` distributes over
	 * the sum cleanly and the two computations agree exactly, for ANY length
	 * of the appended tail — that is what the 99-char (not the 40-char)
	 * choice buys, and it is why this assertion is a property of the code,
	 * not a hardcoded pair of magic numbers that could silently drift out of
	 * sync with a re-run.
	 *
	 * This is where the D2 table's Normalization column ("subtract (clamp >=
	 * 0)") and the dispatch's summary ("the pinned pi-ai 0.73.1 adapters are
	 * ALREADY disjoint — pin pass-through") genuinely disagree for this one
	 * row — see task-6-report.md's "Deviations" section. This task does NOT
	 * add Faux-specific subtraction logic to openclaw: Faux is a test/mock
	 * provider absent from every real deployment this ship governs, and an
	 * unfixed overlap prices the same tail TWICE — OVERSTATEMENT, the
	 * direction D1 already accepts as fail-safe ("overstatement is
	 * fail-safe... zero-billing forbidden"), not the dangerous
	 * understatement direction this whole ship exists to kill. What this test
	 * pins is the FACT of the overlap and that openclaw's pass-through leaves
	 * it exactly as pi-ai delivered it — a deliberate, flagged judgment call,
	 * not an oversight.
	 */
	it("Faux: real pi-ai 0.73.1 cache-hit output overlaps input/cacheWrite, and openclaw does not correct it", async () => {
		const registration = registerFauxProvider({ tokensPerSecond: 0 });
		const model = registration.getModel();
		if (!model) {
			throw new Error("registerFauxProvider produced no default model — pi-ai's Faux API changed");
		}
		try {
			const sessionId = "faux-contract-cache-overlap";
			const streamOptions = { sessionId, cacheRetention: "long" as const };

			const firstUser: UserMessage = {
				role: "user",
				content: "u".repeat(99),
				timestamp: Date.now(),
			};
			const firstContext: Context = { messages: [firstUser] };
			registration.setResponses([fauxAssistantMessage("resp one")]);
			const firstReply = await stream(model, firstContext, streamOptions).result();

			const secondUser: UserMessage = {
				role: "user",
				content: "v".repeat(40),
				timestamp: Date.now(),
			};
			const secondContext: Context = { messages: [firstUser, firstReply, secondUser] };
			registration.setResponses([fauxAssistantMessage("resp two")]);
			const secondReply = await stream(model, secondContext, streamOptions).result();

			// A real cache hit actually happened on call 2 — not a degenerate
			// no-op that would make the overlap assertion below vacuous.
			expect(secondReply.usage.cacheRead).toBeGreaterThan(0);

			const result = extractUsageFromEvent(doneEvent(secondReply.usage));

			// Pass-through: openclaw does not alter what pi-ai computed.
			expect(result).toEqual({
				inputTokens: secondReply.usage.input,
				outputTokens: secondReply.usage.output,
				cacheReadTokens: secondReply.usage.cacheRead,
				cacheWriteTokens: secondReply.usage.cacheWrite,
			});
			// The overlap, named: the same underlying prompt tail is billed once
			// as fresh input and once as a cache write.
			expect(secondReply.usage.input).toBe(secondReply.usage.cacheWrite);
		} finally {
			registration.unregister();
		}
	});
});
