// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Pricing table for the top 20 LLM models.
 * All rates are in usertokens per 1,000 LLM tokens.
 * 1 usertoken = $0.0001 (one basis point of a cent).
 *
 * Canonical pricing source for supported LLM models.
 */

import type { CostBasis, EndpointClass, RateSource, TrustConfig } from "../shared/types.js";

export interface ModelRates {
	inputPer1k: number;
	outputPer1k: number;
}

/**
 * Pricing table for the top 20 models supported by the SDK.
 * Key: model identifier as sent by the client.
 */
export const PRICING_TABLE: Record<string, ModelRates> = {
	// ── Anthropic ──
	"claude-sonnet-4-6": { inputPer1k: 30, outputPer1k: 150 },
	"claude-haiku-4-5": { inputPer1k: 10, outputPer1k: 50 },
	"claude-opus-4-6": { inputPer1k: 50, outputPer1k: 250 },

	// ── OpenAI ──
	"gpt-4o": { inputPer1k: 25, outputPer1k: 100 },
	"gpt-4o-mini": { inputPer1k: 1.5, outputPer1k: 6 },
	"gpt-5.4": { inputPer1k: 25, outputPer1k: 150 },
	o3: { inputPer1k: 20, outputPer1k: 80 },
	"o4-mini": { inputPer1k: 5.5, outputPer1k: 22 },

	// ── Google Gemini ──
	"gemini-2.5-flash": { inputPer1k: 3, outputPer1k: 25 },
	"gemini-2.5-pro": { inputPer1k: 12.5, outputPer1k: 100 },
	"gemini-3.1-pro": { inputPer1k: 20, outputPer1k: 120 },

	// ── Mistral ──
	"mistral-large": { inputPer1k: 5, outputPer1k: 15 },

	// ── DeepSeek ──
	"deepseek-chat": { inputPer1k: 2.8, outputPer1k: 4.2 },
	"deepseek-reasoner": { inputPer1k: 2.8, outputPer1k: 4.2 },

	// ── xAI ──
	"grok-3": { inputPer1k: 30, outputPer1k: 150 },

	// ── Meta (via Bedrock) ──
	"llama-4-maverick": { inputPer1k: 2.4, outputPer1k: 9.7 },

	// ── Cohere ──
	"command-a": { inputPer1k: 25, outputPer1k: 100 },

	// ── Perplexity ──
	"sonar-pro": { inputPer1k: 30, outputPer1k: 150 },

	// ── Alibaba ──
	"qwen-72b": { inputPer1k: 2.9, outputPer1k: 3.9 },

	// ── Amazon ──
	"nova-pro": { inputPer1k: 8, outputPer1k: 32 },
};

/** Date the PRICING_TABLE rates were last verified against provider pricing pages. */
export const PRICING_TABLE_VERSION = "2026-03-29";

/** Pre-sorted entries for prefix matching (longest key first). */
const SORTED_TABLE = Object.entries(PRICING_TABLE).sort((a, b) => b[0].length - a[0].length);

/** Fallback rate for unknown models (sonnet-class pricing). */
export const FALLBACK_RATE: ModelRates = { inputPer1k: 30, outputPer1k: 150 };

/** Maps provider names to their model key prefixes in PRICING_TABLE. */
const PROVIDER_MODEL_MAP: Record<string, string[]> = {
	anthropic: ["claude-"],
	openai: ["gpt-", "o3", "o4-"],
	google: ["gemini-"],
	mistral: ["mistral-"],
	deepseek: ["deepseek-"],
	xai: ["grok-"],
	meta: ["llama-"],
	cohere: ["command-"],
	perplexity: ["sonar-"],
	alibaba: ["qwen-"],
	amazon: ["nova-"],
};

/** Return all PRICING_TABLE model keys that belong to a given provider. */
export function modelsForProvider(provider: string): string[] {
	// Object.hasOwn guards against inherited Object.prototype keys: a provider
	// name like "constructor" must resolve to nothing, not Object's constructor.
	if (!Object.hasOwn(PROVIDER_MODEL_MAP, provider)) return [];
	const prefixes = PROVIDER_MODEL_MAP[provider];
	if (!prefixes) return [];
	return Object.keys(PRICING_TABLE).filter((model) => prefixes.some((p) => model.startsWith(p)));
}

/**
 * Look up rates by model string. Falls back to prefix matching,
 * then FALLBACK_RATE for unknown models.
 */
export function getModelRates(model: string, customRates?: Record<string, ModelRates>): ModelRates {
	// Object.hasOwn guards both direct lookups against inherited Object.prototype
	// members: a model string like "constructor"/"__proto__"/"toString" would
	// otherwise resolve to a Function/object, survive the truthiness check, and
	// yield NaN cost (NaN then defeats the Math.max(1, ...) floor and poisons the
	// ledger). Prefix matching below is already own-key-only (SORTED_TABLE).
	if (customRates && Object.hasOwn(customRates, model)) {
		const custom = customRates[model];
		if (custom) return custom;
	}

	if (Object.hasOwn(PRICING_TABLE, model)) {
		const exact = PRICING_TABLE[model];
		if (exact) return exact;
	}

	// Prefix match — longest key first prevents partial matches
	for (const [key, rates] of SORTED_TABLE) {
		if (model.startsWith(key)) return rates;
	}

	return FALLBACK_RATE;
}

/** Models already warned about — unknownModelPolicy "warn" fires once per model per process. */
const warnedUnknownModels = new Set<string>();

/**
 * Emit the once-per-process cloud-scope "unknown model" warning for
 * unknownModelPolicy "warn". Shared by trust() and createGovernor() so both
 * governance paths log identical text and share a single dedup set. Idempotent
 * per model string; the receipt's meter.rateSource "fallback" marker is set by
 * the caller independently of this dedup.
 */
export function warnUnknownModel(model: string): void {
	if (warnedUnknownModels.has(model)) return;
	warnedUnknownModels.add(model);
	console.warn(
		`[usertrust] unknown model "${model}": metering at FALLBACK_RATE (sonnet-class); add it to customRates or set unknownModelPolicy`,
	);
}

/**
 * Compute usertoken cost from explicit rates.
 * Applies the same non-finite/negative clamp and >=1 floor as estimateCost —
 * the floor is per-call and load-bearing (zero-amount ledger transfers are
 * invalid; it is what makes a {0,0}-rate local call settle at exactly 1
 * nominal usertoken).
 */
export function costFromRates(
	rates: ModelRates,
	inputTokens: number,
	outputTokens: number,
): number {
	// Defend against non-finite/negative token counts (garbage `max_tokens`, or
	// provider usage that reports a negative/NaN value): any count that is not a
	// finite number >= 0 is treated as 0. A NaN would otherwise poison budget
	// state permanently; a negative would collapse a real cost to the floor of 1.
	const inTok = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
	const outTok = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
	const inputCost = (inTok / 1000) * rates.inputPer1k;
	const outputCost = (outTok / 1000) * rates.outputPer1k;
	return Math.max(1, Math.ceil(inputCost + outputCost));
}

/**
 * Estimate cost in usertokens for a model call.
 * Returns at least 1 (floor to prevent zero-amount transfers).
 */
export function estimateCost(
	model: string,
	inputTokens: number,
	outputTokens: number,
	customRates?: Record<string, ModelRates>,
): number {
	return costFromRates(getModelRates(model, customRates), inputTokens, outputTokens);
}

// ── Scoped rate resolution (M2 local-model governance) ──

/** A matched model-pattern entry: the pattern key that won and its value. */
export interface ModelPatternMatch<T> {
	pattern: string;
	value: T;
}

/**
 * Match a model string against a record keyed by exact models or TRAILING-star
 * globs ("llama3.3*"; "*" matches everything). Exact match beats any glob;
 * among globs the longest prefix wins. This is the model-pattern matcher (A2) —
 * hostname patterns use a different leading-star syntax, implemented in detect.ts.
 *
 * Used by local.models, anomaly tokenRate.perModel.
 */
export function matchModelPattern<T>(
	model: string,
	patterns: Record<string, T>,
): ModelPatternMatch<T> | undefined {
	// Object.hasOwn guards against inherited Object.prototype keys
	// (model "constructor" must not resolve to a Function).
	if (Object.hasOwn(patterns, model)) {
		return { pattern: model, value: patterns[model] as T };
	}
	let best: ModelPatternMatch<T> | undefined;
	let bestLen = -1;
	for (const [pattern, value] of Object.entries(patterns)) {
		if (!pattern.endsWith("*")) continue;
		const prefix = pattern.slice(0, -1);
		if (model.startsWith(prefix) && prefix.length > bestLen) {
			best = { pattern, value };
			bestLen = prefix.length;
		}
	}
	return best;
}

/** Result of scope-aware rate resolution. */
export interface RateResolution {
	rates: ModelRates;
	scope: EndpointClass;
	costBasis: CostBasis;
	rateSource: RateSource;
	/** true when cloud scope missed table+custom+prefix and fell back. */
	unknown: boolean;
}

/**
 * Resolve rates for a model within an endpoint scope. Never throws —
 * unknownModelPolicy enforcement lives in the callers (govern/headless).
 *
 * Local scope: local.models exact match → longest trailing-* glob →
 * local.defaultRate (rateSource "local-default"). NEVER FALLBACK_RATE, never
 * the cloud table, never `unknown: true` (A5). costBasis is "usd-proxy" when
 * local.rateClass is "amortized-usd", else "nominal".
 *
 * Cloud scope: delegates to the existing getModelRates(model, customRates)
 * semantics, including the callers' pricing==="custom" gate on customRates;
 * costBasis "usd-proxy"; unknown=true iff the result came from FALLBACK_RATE.
 */
export function resolveRates(
	model: string,
	scope: EndpointClass,
	config: TrustConfig,
): RateResolution {
	if (scope === "local") {
		const costBasis: CostBasis =
			config.local.rateClass === "amortized-usd" ? "usd-proxy" : "nominal";
		const match = matchModelPattern(model, config.local.models);
		if (match !== undefined) {
			return { rates: match.value, scope, costBasis, rateSource: "local-model", unknown: false };
		}
		return {
			rates: config.local.defaultRate,
			scope,
			costBasis,
			rateSource: "local-default",
			unknown: false,
		};
	}

	// Cloud scope — mirrors getModelRates(model, customRates) exactly, including
	// the pricing==="custom" gate applied at the existing govern/headless call sites.
	// Object.hasOwn guards both lookups so a model string like "constructor"/
	// "__proto__" resolves to FALLBACK_RATE, never an inherited prototype member.
	const customRates = config.pricing === "custom" ? config.customRates : undefined;
	if (customRates && Object.hasOwn(customRates, model)) {
		const custom = customRates[model];
		if (custom) {
			return { rates: custom, scope, costBasis: "usd-proxy", rateSource: "custom", unknown: false };
		}
	}

	if (Object.hasOwn(PRICING_TABLE, model)) {
		const exact = PRICING_TABLE[model];
		if (exact) {
			return { rates: exact, scope, costBasis: "usd-proxy", rateSource: "table", unknown: false };
		}
	}

	for (const [key, rates] of SORTED_TABLE) {
		if (model.startsWith(key)) {
			return { rates, scope, costBasis: "usd-proxy", rateSource: "table", unknown: false };
		}
	}

	return {
		rates: FALLBACK_RATE,
		scope,
		costBasis: "usd-proxy",
		rateSource: "fallback",
		unknown: true,
	};
}

/**
 * Estimate the block-level token count for a non-text content block.
 * Extracts textual payload where possible, falls back to serialised length.
 */
function estimateBlockTokens(block: Record<string, unknown>): number {
	let chars = 0;

	if (typeof block.text === "string") chars += (block.text as string).length;
	if (typeof block.content === "string") chars += (block.content as string).length;

	// Handle nested arrays (tool_result payloads)
	if (Array.isArray(block.content)) {
		for (const item of block.content as unknown[]) {
			if (typeof item === "string") {
				chars += item.length;
			} else if (item != null && typeof item === "object") {
				chars += JSON.stringify(item).length;
			}
		}
	}

	// Conservative fallback for unknown/binary shapes
	if (chars === 0) chars = JSON.stringify(block).length;

	return Math.ceil(chars / 4);
}

/**
 * Estimate input token count from a messages array.
 * Heuristic: ~4 chars/token with a 1.5x safety margin so the PENDING
 * hold exceeds actual cost in the vast majority of cases.
 */
export function estimateInputTokens(messages: unknown[]): number {
	if (!Array.isArray(messages)) return 1;

	let textChars = 0;
	let blockTokens = 0;

	for (const msg of messages) {
		if (msg == null || typeof msg !== "object") continue;
		const m = msg as Record<string, unknown>;

		// ~4 tokens per-message overhead (role, structure)
		textChars += 16;

		const content = m.content;
		if (typeof content === "string") {
			textChars += content.length;
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block == null || typeof block !== "object") continue;
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") {
					textChars += (b.text as string).length;
				} else {
					blockTokens += estimateBlockTokens(b);
				}
			}
		}

		// Tool-call overhead
		if (typeof m.tool_call_id === "string") blockTokens += 10;
	}

	const textTokens = Math.ceil(textChars / 4);
	const raw = textTokens + blockTokens;

	// 1.5x safety margin
	return Math.max(1, Math.ceil(raw * 1.5));
}
