/**
 * Pricing table for the top 20 LLM models.
 * All rates are in usertokens per 1,000 LLM tokens.
 * 1 usertoken = $0.0001 (one basis point of a cent).
 *
 * Extracted from usertools platform — canonical pricing source.
 */

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

/** Pre-sorted entries for prefix matching (longest key first). */
const SORTED_TABLE = Object.entries(PRICING_TABLE).sort((a, b) => b[0].length - a[0].length);

/** Fallback rate for unknown models (sonnet-class pricing). */
export const FALLBACK_RATE: ModelRates = { inputPer1k: 30, outputPer1k: 150 };

/**
 * Look up rates by model string. Falls back to prefix matching,
 * then FALLBACK_RATE for unknown models.
 */
export function getModelRates(model: string): ModelRates {
	const exact = PRICING_TABLE[model];
	if (exact) return exact;

	// Prefix match — longest key first prevents partial matches
	for (const [key, rates] of SORTED_TABLE) {
		if (model.startsWith(key)) return rates;
	}

	return FALLBACK_RATE;
}

/**
 * Estimate cost in usertokens for a model call.
 * Returns at least 1 (floor to prevent zero-amount transfers).
 */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
	const rates = getModelRates(model);
	const inputCost = (inputTokens / 1000) * rates.inputPer1k;
	const outputCost = (outputTokens / 1000) * rates.outputPer1k;
	return Math.max(1, Math.ceil(inputCost + outputCost));
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
