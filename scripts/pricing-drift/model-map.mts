/**
 * model-map.mts — the explicit, human-reviewed mapping from PRICING_TABLE keys
 * to upstream source entries, plus the expected-deviation allowlist.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE (spec §3.1, §3.2):
 *
 *  1. VENDOR-PINNED. models.dev carries 190 providers, most of them resellers
 *     and gateways; LiteLLM carries regional and reseller rows beside vendor
 *     rows. A lookup that accepts "any provider carrying this id" returns
 *     plausible-looking wrong numbers — measured 2026-08-17, an unpinned
 *     matcher answered claude-fable-5 at 30/185 against a true 100/500, and
 *     claude-opus-5 at 55/275 (the `us.` regional 1.1x premium). Every entry
 *     below names the vendor, and a row whose vendor does not match is treated
 *     as ABSENT, never as an answer.
 *
 *  2. NO FUZZY MATCHING. Several table keys are short aliases no vendor
 *     publishes: Cohere ships `command-a-03-2025` (and `command-a-translate-…`,
 *     `command-a-vision-…`), Mistral ships `mistral-large-latest`, xAI has aged
 *     `grok-3` out of its own provider entirely. Fuzzy matching would let
 *     `command-a` resolve against a TRANSLATION model's rate. A key is mapped
 *     explicitly or it is recorded as having no source. There is no third
 *     behaviour.
 *
 * A PRICING_TABLE key absent from MODEL_MAP fails the run (spec §6). Adding a
 * rate without deciding its provenance is itself a finding.
 */

/** Where one PRICING_TABLE key can be corroborated upstream. */
export interface ModelSourceMap {
	/**
	 * LiteLLM entry key, plus the `litellm_provider` value it MUST carry.
	 * `null` when LiteLLM does not publish this model under a vendor row.
	 */
	litellm: { key: string; provider: string } | null;
	/**
	 * models.dev provider id and model id. The provider MUST be the vendor's
	 * own — never a reseller that happens to carry the id.
	 * `null` when no vendor provider publishes it.
	 */
	modelsDev: { provider: string; id: string } | null;
	/** Why there is no source. Required when both are null; printed in the report. */
	note?: string;
}

/**
 * One entry per PRICING_TABLE key. Verified against both sources 2026-08-17.
 *
 * Vendor provider ids confirmed present in models.dev on that date:
 * anthropic, openai, google, deepseek, mistral, perplexity, moonshotai.
 */
export const MODEL_MAP: Record<string, ModelSourceMap> = {
	// ── Anthropic ── all six corroborated by both sources, all four tiers.
	"claude-sonnet-4-6": {
		litellm: { key: "claude-sonnet-4-6", provider: "anthropic" },
		modelsDev: { provider: "anthropic", id: "claude-sonnet-4-6" },
	},
	"claude-haiku-4-5": {
		litellm: { key: "claude-haiku-4-5", provider: "anthropic" },
		modelsDev: { provider: "anthropic", id: "claude-haiku-4-5" },
	},
	"claude-opus-4-6": {
		litellm: { key: "claude-opus-4-6", provider: "anthropic" },
		modelsDev: { provider: "anthropic", id: "claude-opus-4-6" },
	},
	"claude-opus-4-8": {
		litellm: { key: "claude-opus-4-8", provider: "anthropic" },
		modelsDev: { provider: "anthropic", id: "claude-opus-4-8" },
	},
	"claude-fable-5": {
		litellm: { key: "claude-fable-5", provider: "anthropic" },
		modelsDev: { provider: "anthropic", id: "claude-fable-5" },
	},
	"claude-opus-5": {
		litellm: { key: "claude-opus-5", provider: "anthropic" },
		modelsDev: { provider: "anthropic", id: "claude-opus-5" },
	},
	"claude-sonnet-5": {
		litellm: { key: "claude-sonnet-5", provider: "anthropic" },
		modelsDev: { provider: "anthropic", id: "claude-sonnet-5" },
	},

	// ── OpenAI ──
	"gpt-4o": {
		litellm: { key: "gpt-4o", provider: "openai" },
		modelsDev: { provider: "openai", id: "gpt-4o" },
	},
	"gpt-4o-mini": {
		litellm: { key: "gpt-4o-mini", provider: "openai" },
		modelsDev: { provider: "openai", id: "gpt-4o-mini" },
	},
	"gpt-5.4": {
		litellm: { key: "gpt-5.4", provider: "openai" },
		modelsDev: { provider: "openai", id: "gpt-5.4" },
	},
	"gpt-5.6-sol": {
		litellm: { key: "gpt-5.6-sol", provider: "openai" },
		modelsDev: { provider: "openai", id: "gpt-5.6-sol" },
	},
	o3: {
		litellm: { key: "o3", provider: "openai" },
		modelsDev: { provider: "openai", id: "o3" },
	},
	"o4-mini": {
		litellm: { key: "o4-mini", provider: "openai" },
		modelsDev: { provider: "openai", id: "o4-mini" },
	},

	// ── Moonshot ── LiteLLM does not carry kimi-k3; models.dev does, under the
	// vendor's own provider id (`moonshotai`, not the `moonshotai-cn` mirror).
	"kimi-k3": {
		litellm: null,
		modelsDev: { provider: "moonshotai", id: "kimi-k3" },
	},

	// ── Google ──
	"gemini-2.5-flash": {
		litellm: { key: "gemini-2.5-flash", provider: "vertex_ai-language-models" },
		modelsDev: { provider: "google", id: "gemini-2.5-flash" },
	},
	"gemini-2.5-pro": {
		litellm: { key: "gemini-2.5-pro", provider: "vertex_ai-language-models" },
		modelsDev: { provider: "google", id: "gemini-2.5-pro" },
	},
	// Google's own provider publishes `gemini-3.1-pro-preview`, not the stable
	// id we key on. The preview's rates are NOT assumed to carry over to GA —
	// that is exactly the fuzzy match rule 2 forbids. Recorded as no source
	// until Google publishes the GA key.
	"gemini-3.1-pro": {
		litellm: null,
		modelsDev: null,
		note: "Google publishes gemini-3.1-pro-preview; no vendor row for the stable id",
	},

	// ── DeepSeek ── the two sources DISAGREE WITH EACH OTHER here (LiteLLM
	// 2.8/4.2, matching us; models.dev 1.4/2.8). Both are mapped deliberately:
	// surfacing that disagreement is the product, not a defect to smooth over.
	"deepseek-chat": {
		litellm: { key: "deepseek-chat", provider: "deepseek" },
		modelsDev: { provider: "deepseek", id: "deepseek-chat" },
	},
	"deepseek-reasoner": {
		litellm: { key: "deepseek-reasoner", provider: "deepseek" },
		modelsDev: { provider: "deepseek", id: "deepseek-reasoner" },
	},

	// ── Mistral ── we key on the bare alias; Mistral publishes
	// `mistral-large-latest` and dated `mistral-large-2411`. `-latest` is a
	// MOVING TARGET whose resolution we do not control, so it is not treated as
	// authoritative for a fixed key.
	"mistral-large": {
		litellm: null,
		modelsDev: null,
		note: "Mistral publishes mistral-large-latest (moving alias) and dated builds; no stable vendor row for this key",
	},

	// ── xAI ── xAI's own provider carries grok-4.x only; grok-3 appears solely
	// under gateways (helicone). Retired upstream, still in our table.
	"grok-3": {
		litellm: null,
		modelsDev: null,
		note: "xAI provider carries grok-4.x only; grok-3 aged out upstream — appears only under gateways",
	},

	// ── Meta ── carried only by hosts (digitalocean, helicone, neon), each at
	// its own hosting price. No vendor list price exists to compare against.
	"llama-4-maverick": {
		litellm: null,
		modelsDev: null,
		note: "open-weights; no vendor list price — hosts publish their own rates",
	},

	// ── Cohere ── publishes command-a-03-2025 / -translate- / -vision- /
	// -reasoning-; no bare `command-a` row. Rule 2: do not guess which.
	"command-a": {
		litellm: null,
		modelsDev: null,
		note: "Cohere publishes dated/variant ids (command-a-03-2025, -translate-, -vision-); no bare alias row",
	},

	// ── Perplexity ──
	"sonar-pro": {
		litellm: null,
		modelsDev: { provider: "perplexity", id: "sonar-pro" },
	},

	// ── Alibaba ── the `qwen-72b` generation is absent from both sources;
	// Alibaba's provider carries qwen3.x. Local-override territory regardless.
	"qwen-72b": {
		litellm: null,
		modelsDev: null,
		note: "absent from both sources; Alibaba provider carries the qwen3.x generation",
	},

	// ── Amazon ── Bedrock rows are per-region and per-hosted-model; no bare
	// `nova-pro` vendor row.
	"nova-pro": {
		litellm: null,
		modelsDev: null,
		note: "Bedrock publishes region-qualified ids; no bare vendor row for this key",
	},
};

/**
 * Rates where our table deliberately differs from upstream.
 *
 * THE RULE THAT MAKES THIS SAFE (spec §5): an entry suppresses failure ONLY
 * while our rate is >= upstream on every compared tier. If upstream ever rises
 * ABOVE ours, that is real drift and the run fails DESPITE the entry.
 * Understatement can never be allowlisted — there is no field that permits it
 * and no code path that reaches a pass with our rate below a corroborated
 * upstream rate.
 *
 * That is why the D1 invariant is ENFORCED here rather than restated: a
 * restated invariant is a second copy the moment it is written.
 *
 * An entry whose model no longer deviates is reported as stale and fails the
 * run, so exemptions cannot outlive their reason.
 */
export const EXPECTED_DEVIATIONS: Record<string, { reason: string }> = {
	"claude-sonnet-5": {
		reason:
			"Introductory $2/$10 through 2026-08-31 deliberately not entered; the table carries " +
			"the standard rate effective 2026-09-01 (see pricing.ts). Overstatement is fail-safe. " +
			"EXPECT THIS ENTRY TO GO STALE on 2026-09-01 when upstream catches up — the stale check " +
			"will say so.",
	},
};
