// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * usage.ts — the ONE normalization module (spec D2 + the D5 snapshot rule).
 *
 * Core's canonical usage is four DISJOINT tiers: fresh input, output, cache
 * read, cache write. Providers do not agree on that shape, so every boundary
 * that reads provider usage funnels through the extractors here. No boundary
 * hand-rolls the extraction math again — a second derivation is how the two
 * halves of a settle (the cost and the record) drift apart.
 *
 * Two rules govern everything below.
 *
 * **D2 — normalization is per SOURCE, not per provider.** Whether to subtract
 * depends on who normalized the counters first:
 *
 *   - Anthropic's SDK reports the three input counters as already disjoint
 *     (`input_tokens` is fresh-only) ⇒ PASS THROUGH. Subtracting there
 *     undercounts, which is the dangerous direction.
 *   - OpenAI completions / Responses and Gemini report an INCLUSIVE prompt
 *     count ⇒ SUBTRACT the cache tiers back out, clamped at 0.
 *   - pi-ai's pinned adapters normalize to disjoint before core ever sees the
 *     numbers ⇒ those boundaries pass through too and must NOT call the
 *     subtracting extractors. (That row lives at the openclaw boundary; it is
 *     named here so nobody "fixes" it by routing it through this file.)
 *
 * **D5 — one sanitized snapshot per settle.** The object an extractor returns
 * is what feeds `costFromRates` AND record emission. Raw provider values reach
 * neither. That is not tidiness: `canonicalize()` throws on NaN and Infinity,
 * so a single non-finite provider count would fail the audit write for the
 * whole settle. Everything that leaves this module is a finite integer >= 0.
 *
 * Every function here is pure — no I/O, no clock, no config.
 */

/**
 * A sanitized, four-tier, disjoint usage snapshot.
 *
 * Invariants held by construction (see `sanitizeUsage`): all four counts are
 * finite integers >= 0, and the tiers do not overlap — summing them gives the
 * total billable tokens for the call.
 */
export interface NormalizedUsage {
	/** Fresh (non-cached) prompt tokens. */
	inputTokens: number;
	/** Completion tokens, including any provider-billed thinking tokens. */
	outputTokens: number;
	/** Cache-hit prompt tokens (read from an existing cache entry). */
	cacheReadTokens: number;
	/** Cache-creation prompt tokens (written into a cache entry). */
	cacheWriteTokens: number;
	/**
	 * Provenance (D5). `"provider"` means the provider reported BOTH input and
	 * output; absent cache fields then legitimately mean zero. `"estimated"`
	 * means at least one of input/output was missing or unusable, so the caller
	 * must substitute its estimate and MUST NOT publish a `usage` record — a
	 * half-provider snapshot labelled "provider" is a mislabel, not a saving.
	 *
	 * Held by construction: `sanitizeUsage` downgrades a `"provider"` label to
	 * `"estimated"` whenever the input or output it was handed is not a usable
	 * count, so no snapshot leaving this module can carry a fabricated zero
	 * under a provider label — whichever entry point produced it.
	 */
	source: "provider" | "estimated";
}

/** Loose input to {@link sanitizeUsage}: any field may be missing or junk. */
export interface RawUsageCandidate {
	inputTokens?: unknown;
	outputTokens?: unknown;
	cacheReadTokens?: unknown;
	cacheWriteTokens?: unknown;
	source?: "provider" | "estimated";
}

/**
 * Read one provider-reported count.
 *
 * Returns `null` when the value is not a usable count — absent, non-numeric,
 * NaN, Infinity or negative. `null` is distinct from `0`: an explicit 0 IS
 * data (a provider that used no cache reports zero), while `null` means the
 * provider told us nothing and the caller must fall back.
 *
 * A fractional count rounds UP. Providers report integers, so this only fires
 * on garbage or on a proxy that averaged something; rounding down would
 * understate the bill, and understatement is the direction that silently
 * drains budgets slower than the invoice.
 */
function readCount(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	return Math.ceil(value);
}

/** Read a nested object field, or `undefined` when it is not an object. */
function readObject(
	source: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = source[key];
	if (value == null || typeof value !== "object") return undefined;
	return value as Record<string, unknown>;
}

/** Narrow an unknown provider payload to a readable record (never throws). */
function asRecord(value: unknown): Record<string, unknown> {
	if (value == null || typeof value !== "object") return {};
	return value as Record<string, unknown>;
}

/** Subtract inclusive cache tiers out of an inclusive prompt count (clamp >= 0). */
function disjointInput(promptTokens: number, cacheReadTokens: number, cacheWriteTokens: number) {
	return Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
}

/**
 * The single sanitizer. Every extractor ends here, and any boundary that
 * assembles a snapshot from already-disjoint counters (the pi-ai pass-through
 * rows, headless caller-supplied usage) should route through it too rather
 * than clamping by hand.
 *
 * Non-finite, negative and non-numeric values collapse to 0; fractional counts
 * round up; an absent `source` defaults to the conservative `"estimated"`.
 *
 * **The D5 provenance rule is enforced HERE, not only in the extractors.** A
 * caller may label a snapshot `"provider"`, but the label survives only if
 * BOTH `inputTokens` and `outputTokens` are usable counts (an explicit `0`
 * qualifies — a provider that used no cache reports zero, and that is data).
 * When either is absent or garbage, the clamped `0` is *fabricated*, so the
 * label is downgraded to `"estimated"` and the caller must not publish a
 * `usage` record. Without this guard a boundary that derives `source` from a
 * `typeof value === "number"` check on a NaN counter would publish a
 * provider-labelled zero-input call — the exact mislabel D5 kills, and one
 * that understates money by pricing fresh input at the 1-usertoken floor.
 * Absent CACHE fields never downgrade: D5 says they legitimately default to 0.
 *
 * Note there is no upper clamp: a finite-but-absurd count passes through and
 * prices high. Overstatement is fail-safe under the D1 money invariant, and
 * `canonicalize` only rejects non-finite values, so the audit write stays safe.
 */
export function sanitizeUsage(raw: RawUsageCandidate | null | undefined): NormalizedUsage {
	const r = raw ?? {};
	const input = readCount(r.inputTokens);
	const output = readCount(r.outputTokens);
	const reported = input != null && output != null;
	return {
		inputTokens: input ?? 0,
		outputTokens: output ?? 0,
		cacheReadTokens: readCount(r.cacheReadTokens) ?? 0,
		cacheWriteTokens: readCount(r.cacheWriteTokens) ?? 0,
		source: r.source === "provider" && reported ? "provider" : "estimated",
	};
}

/**
 * D2 row — **Anthropic SDK, core direct: pass through.**
 *
 * `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`
 * are disjoint in the SDK (messages.ts:1139), so nothing is subtracted here.
 *
 * `cache_creation` carries the per-TTL breakdown
 * (`ephemeral_5m_input_tokens` + `ephemeral_1h_input_tokens`). When it reports
 * at least one usable count its sum wins; otherwise the flat
 * `cache_creation_input_tokens` is used. (The two agree in practice — the flat
 * field is the sum — so this is about surviving whichever one a given SDK
 * version, proxy or fixture omits. Per-TTL write pricing is out of scope: both
 * TTLs bill at the single `cacheWritePer1k`, a documented D6 approximation.)
 */
export function fromAnthropicUsage(usage: unknown): NormalizedUsage {
	const u = asRecord(usage);

	const input = readCount(u.input_tokens);
	const output = readCount(u.output_tokens);

	const breakdown = readObject(u, "cache_creation");
	const ephemeral5m = breakdown ? readCount(breakdown.ephemeral_5m_input_tokens) : null;
	const ephemeral1h = breakdown ? readCount(breakdown.ephemeral_1h_input_tokens) : null;
	const nestedWrite =
		ephemeral5m == null && ephemeral1h == null ? null : (ephemeral5m ?? 0) + (ephemeral1h ?? 0);

	return sanitizeUsage({
		inputTokens: input ?? 0,
		outputTokens: output ?? 0,
		cacheReadTokens: readCount(u.cache_read_input_tokens) ?? 0,
		cacheWriteTokens: nestedWrite ?? readCount(u.cache_creation_input_tokens) ?? 0,
		source: input != null && output != null ? "provider" : "estimated",
	});
}

/**
 * D2 row — **OpenAI chat.completions, core direct: subtract.**
 *
 * `prompt_tokens` is INCLUSIVE of the cached read (`prompt_tokens_details.
 * cached_tokens`) and, where a vendor reports one, of the cache write
 * (`cache_write_tokens`). Fresh input is the remainder, clamped at 0 — a proxy
 * that reports `cached_tokens > prompt_tokens` must not produce a negative
 * count that would collapse the whole cost to the 1-usertoken floor.
 *
 * `completion_tokens` already includes reasoning tokens
 * (`completion_tokens_details.reasoning_tokens` is a breakdown, not an
 * addition), so nothing is added to output.
 */
export function fromOpenAICompletionsUsage(usage: unknown): NormalizedUsage {
	const u = asRecord(usage);
	const promptDetails = readObject(u, "prompt_tokens_details");

	const prompt = readCount(u.prompt_tokens);
	const completion = readCount(u.completion_tokens);

	const cacheRead = (promptDetails ? readCount(promptDetails.cached_tokens) : null) ?? 0;
	const cacheWrite =
		readCount(u.cache_write_tokens) ??
		(promptDetails ? readCount(promptDetails.cache_write_tokens) : null) ??
		0;

	return sanitizeUsage({
		inputTokens: disjointInput(prompt ?? 0, cacheRead, cacheWrite),
		outputTokens: completion ?? 0,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		source: prompt != null && completion != null ? "provider" : "estimated",
	});
}

/**
 * D2 row — **OpenAI Responses API, core direct: subtract per details.**
 *
 * Same inclusivity as completions with a different field map: `input_tokens`
 * with the cache tiers nested under `input_tokens_details`. This must be used
 * by BOTH the non-stream path and the terminal stream path (streaming.ts:94) —
 * two paths, one extractor.
 *
 * `output_tokens` already includes `output_tokens_details.reasoning_tokens`;
 * adding it would double-bill thinking.
 */
export function fromOpenAIResponsesUsage(usage: unknown): NormalizedUsage {
	const u = asRecord(usage);
	const inputDetails = readObject(u, "input_tokens_details");

	const input = readCount(u.input_tokens);
	const output = readCount(u.output_tokens);

	const cacheRead = (inputDetails ? readCount(inputDetails.cached_tokens) : null) ?? 0;
	const cacheWrite = inputDetails
		? (readCount(inputDetails.cache_creation_tokens) ??
			readCount(inputDetails.cache_write_tokens) ??
			0)
		: 0;

	return sanitizeUsage({
		inputTokens: disjointInput(input ?? 0, cacheRead, cacheWrite),
		outputTokens: output ?? 0,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		source: input != null && output != null ? "provider" : "estimated",
	});
}

/**
 * D2 row — **Gemini, core direct: subtract, and thinking is output.**
 *
 * Takes the root `usageMetadata` object. `promptTokenCount` is INCLUSIVE of
 * `cachedContentTokenCount`, so fresh input is the difference (clamp >= 0).
 * `thoughtsTokenCount` is billed at the output rate and is NOT included in
 * `candidatesTokenCount`, so it is added.
 *
 * `cacheWriteTokens` is always 0: Gemini bills cache creation as ordinary
 * input (plus an hourly storage charge this per-token model does not carry —
 * a documented D6 approximation) and reports no write counter. Those tokens
 * ride inside `promptTokenCount` and price at `inputPer1k`, which is exactly
 * what the provider charges.
 *
 * A thinking-only response (thoughts but no candidates) still counts as
 * provider-reported output — that is real, billed output.
 */
export function fromGeminiUsage(metadata: unknown): NormalizedUsage {
	const m = asRecord(metadata);

	const prompt = readCount(m.promptTokenCount);
	const candidates = readCount(m.candidatesTokenCount);
	const thoughts = readCount(m.thoughtsTokenCount);
	const cacheRead = readCount(m.cachedContentTokenCount) ?? 0;

	return sanitizeUsage({
		inputTokens: disjointInput(prompt ?? 0, cacheRead, 0),
		outputTokens: (candidates ?? 0) + (thoughts ?? 0),
		cacheReadTokens: cacheRead,
		cacheWriteTokens: 0,
		source: prompt != null && (candidates != null || thoughts != null) ? "provider" : "estimated",
	});
}

/**
 * Which D2 row a payload belongs to. This is the SOURCE identity, not the
 * provider name: "openai" is two rows (completions vs Responses) with different
 * field maps, and the pi-ai adapters are a third family that never reaches this
 * module at all (they are already disjoint — see the header).
 */
export type UsageWireShape = "anthropic" | "openai-completions" | "openai-responses" | "gemini";

/**
 * Pick the D2 row from the field names actually present, falling back to the
 * caller's hint.
 *
 * Shape wins over the hint because the hint is derived from the CLIENT
 * (`detectClientKind` + the intercepted surface), and an OpenAI-compatible
 * server behind an OpenAI client is free to answer in a different dialect. The
 * dispatch is unambiguous exactly where it matters: the two "pass through" vs
 * "subtract" families use disjoint cache field names
 * (`cache_read_input_tokens` vs `input_tokens_details.cached_tokens`), so a
 * payload that could be read either way carries no cache tokens and both
 * readings agree.
 */
function detectWireShape(container: Record<string, unknown>, hint: UsageWireShape): UsageWireShape {
	if (
		"promptTokenCount" in container ||
		"candidatesTokenCount" in container ||
		"cachedContentTokenCount" in container ||
		"thoughtsTokenCount" in container
	) {
		return "gemini";
	}
	if (
		"prompt_tokens" in container ||
		"completion_tokens" in container ||
		"prompt_tokens_details" in container
	) {
		return "openai-completions";
	}
	if ("input_tokens_details" in container || "output_tokens_details" in container) {
		return "openai-responses";
	}
	if (
		"cache_read_input_tokens" in container ||
		"cache_creation_input_tokens" in container ||
		"cache_creation" in container
	) {
		return "anthropic";
	}
	// A bare `input_tokens`/`output_tokens` pair with no cache detail anywhere.
	// Anthropic and the Responses API share these names, and with no cache fields
	// present the pass-through and subtracting readings produce identical numbers,
	// so either row is correct — pick by hint. The `openai-completions` hint lands
	// here too: core's old `??` chain read `input_tokens` before `prompt_tokens`,
	// and some OpenAI-compatible servers do answer chat.completions in those
	// names. Falling through to the completions extractor (which looks only for
	// `prompt_tokens`) would read nothing and demote a real settle to an estimate.
	if ("input_tokens" in container || "output_tokens" in container) {
		return hint === "anthropic" ? "anthropic" : "openai-responses";
	}
	return hint;
}

/**
 * D4 row 3 — read a NON-STREAM provider response into the one snapshot.
 *
 * Finds the usage container, picks the D2 row, and delegates. Two containers
 * exist in the wild and core previously read only the first:
 *
 *   - `response.usage` — Anthropic, OpenAI completions, OpenAI Responses.
 *   - `response.usageMetadata` — Google. It sits at the ROOT of a
 *     `GenerateContentResponse` (genai.d.ts:4658), so the old
 *     `"usage" in response` test was FALSE for every real Gemini call and every
 *     one of them silently settled at the estimate.
 *
 * When neither container is a usable object the result is an all-zero snapshot
 * with `source: "estimated"` — the caller must then fall back to its estimate
 * and must NOT publish a usage record (D5).
 */
export function fromProviderResponse(response: unknown, hint: UsageWireShape): NormalizedUsage {
	const r = asRecord(response);
	const usage = readObject(r, "usage");
	const metadata = readObject(r, "usageMetadata");
	// Prefer the container the hint expects; fall back to the other one so a
	// misdetected client still meters off real numbers.
	const container = hint === "gemini" ? (metadata ?? usage) : (usage ?? metadata);
	if (container === undefined) return sanitizeUsage(null);

	switch (detectWireShape(container, hint)) {
		case "gemini":
			return fromGeminiUsage(container);
		case "openai-completions":
			return fromOpenAICompletionsUsage(container);
		case "openai-responses":
			return fromOpenAIResponsesUsage(container);
		default:
			return fromAnthropicUsage(container);
	}
}
