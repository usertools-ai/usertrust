// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The request gate (`EvaluateHttpRequest`): pure. It decides ALLOW / DENY /
 * pass-through for one request and, on ALLOW, prices the hold and names the
 * request mutations. Placing the hold is a later slice; nothing here touches a
 * ledger, the network or storage.
 *
 * v1 meters exactly one shape — a synchronous, single-choice, token-billed call —
 * and DENIES every other shape before any hold, with its own reason code. The
 * checks are ALLOWLISTS: a tool, content part or input item of a type not named
 * here is denied, including types that do not exist yet.
 */

import { costFromRates, getModelRates, isModelPriced, type ModelRates } from "usertrust";
import { DenyReason } from "./reasons.js";
import {
	DEFAULT_ROUTE_CONFIG,
	type MeteredRoute,
	matchRoute,
	type Provider,
	type RouteConfig,
} from "./routes.js";

/** OpenShell's payload maximum: a larger body fails the middleware (fail-closed). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface GateConfig {
	routes: RouteConfig;
	/** Operator rates; a model priced here counts as priced. */
	customRates?: Record<string, ModelRates>;
	/**
	 * Tokens charged per image in the input bound, for a model NOT named in
	 * {@link imageTokenMaxByModel}: at or above the provider's documented maximum
	 * for ANY of its models (README "Image bounds").
	 */
	imageTokenMax: Record<Provider, number>;
	/** Per-model image maxima (exact model names), where the documented maximum is lower. */
	imageTokenMaxByModel: Record<string, number>;
	/**
	 * Input tokens the PROVIDER adds when a request carries tools (its tool-use
	 * system prompt), which the body's bytes do not contain.
	 */
	toolOverheadTokens: Record<Provider, number>;
}

/**
 * OpenAI tile-based models: base + 8 tiles × per-tile tokens (the most tiles one
 * image scales to: 768 × 2048 px). Patch-based models are not listed — they fall
 * back to the provider maximum.
 */
const OPENAI_TILE_IMAGE_MAX: Record<string, number> = {
	"gpt-4o": 85 + 8 * 170,
	"gpt-4.1": 85 + 8 * 170,
	"gpt-5": 70 + 8 * 140,
	"gpt-5.1": 70 + 8 * 140,
	o1: 75 + 8 * 150,
	o3: 75 + 8 * 150,
};

export const DEFAULT_GATE_CONFIG: GateConfig = {
	routes: DEFAULT_ROUTE_CONFIG,
	imageTokenMax: {
		// The high-resolution tier (Claude 4.7 and later): 4,784 visual tokens per image.
		anthropic: 4_784,
		// The patch limit (30,000 per image) × the largest documented multiplier (2.46).
		openai: 73_800,
	},
	imageTokenMaxByModel: OPENAI_TILE_IMAGE_MAX,
	// Anthropic's largest documented tool-use system prompt is 804 tokens. OpenAI
	// documents none: function definitions are billed as input — the body's bytes.
	toolOverheadTokens: { anthropic: 1_024, openai: 0 },
};

export interface GateRequest {
	method: string;
	host: string;
	path: string;
	body: Uint8Array;
}

export interface RequestMutations {
	/** Request headers to remove (lowercase). */
	removeHeaders: string[];
	/** The body to forward. Always set on ALLOW: the re-serialized parse the gate checked. */
	body?: Uint8Array;
}

export interface Hold {
	route: MeteredRoute;
	model: string;
	/** The conservative input-token bound the hold was priced on. */
	inputTokenBound: number;
	/** The request's own output limit. */
	maxOutputTokens: number;
	/** Usertokens to reserve: a ceiling the call cannot exceed in the normal case. */
	amount: number;
	streaming: boolean;
	/**
	 * The rates the hold was priced with, SNAPSHOTTED here. Settlement prices the usage
	 * with these — never by re-resolving the model, whose operator rates may have
	 * changed (become cheaper) between the reservation and the settlement.
	 */
	rates: ModelRates;
}

export type GateResult =
	| { decision: "deny"; reason: DenyReason; detail?: string }
	| { decision: "passthrough"; mutations: RequestMutations }
	| { decision: "allow"; hold: Hold; mutations: RequestMutations };

/** A body over {@link MAX_BODY_BYTES}: the middleware fails, and fail-closed blocks the call. */
export class BodyTooLargeError extends Error {
	constructor(public readonly bytes: number) {
		super(`request body is ${bytes} bytes; the limit is ${MAX_BODY_BYTES}`);
		this.name = "BodyTooLargeError";
	}
}

/**
 * The operator's token config cannot price a hold: a negative, NaN, infinite, fractional or
 * missing image or tool bound would LOWER the input bound, so an admitted call could settle
 * above its reservation. Thrown (the middleware fails, so OpenShell's fail-closed default
 * blocks the call) — never a silent fall-back to a default.
 */
export class GateConfigError extends Error {
	constructor(public readonly field: string) {
		super(`gate config: ${field} must be a non-negative safe integer`);
		this.name = "GateConfigError";
	}
}

const PROVIDERS: readonly Provider[] = ["anthropic", "openai"];
const isTokenCount = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;

/** Every image and tool bound, whatever this request carries (#171). */
function validateTokenConfig(config: GateConfig): void {
	for (const p of PROVIDERS) {
		if (!isTokenCount(config.imageTokenMax?.[p])) throw new GateConfigError(`imageTokenMax.${p}`);
		if (!isTokenCount(config.toolOverheadTokens?.[p]))
			throw new GateConfigError(`toolOverheadTokens.${p}`);
	}
	for (const [model, v] of Object.entries(config.imageTokenMaxByModel ?? {})) {
		if (!isTokenCount(v)) throw new GateConfigError(`imageTokenMaxByModel.${model}`);
	}
}

/** The stream_options keys a request may carry (#168): the gate sets include_usage itself. */
const STREAM_OPTION_KEYS: ReadonlySet<string> = new Set(["include_usage"]);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** What a content walk found: images to add, inline image bytes to subtract, or a refusal. */
interface Walk {
	images: number;
	inlineBytes: number;
	deny?: { reason: DenyReason; detail: string };
}

function refuse(w: Walk, reason: DenyReason, detail: string): void {
	if (w.deny === undefined) w.deny = { reason, detail };
}

const DATA_URI = /^data:/i;

// ── Anthropic /v1/messages ──

const ANTHROPIC_BLOCKS = new Set([
	"text",
	"image",
	"tool_use",
	"tool_result",
	"thinking",
	"redacted_thinking",
	"document",
]);

function walkAnthropicBlocks(blocks: unknown, w: Walk): void {
	if (typeof blocks === "string") return;
	if (!Array.isArray(blocks)) {
		refuse(w, DenyReason.requestUnparseable, "content");
		return;
	}
	for (const b of blocks) {
		if (!isObject(b) || typeof b.type !== "string" || !ANTHROPIC_BLOCKS.has(b.type)) {
			refuse(w, DenyReason.contentUnsupported, `block:${isObject(b) ? String(b.type) : "?"}`);
			return;
		}
		if (b.type === "image") {
			const src = isObject(b.source) ? b.source : {};
			if (src.type === "file") {
				refuse(w, DenyReason.providerContextUnsupported, "image:file");
				return;
			}
			if (src.type === "base64" && typeof src.data === "string") w.inlineBytes += src.data.length;
			w.images += 1;
		} else if (b.type === "document") {
			// Only an inline TEXT document is bounded by its bytes. A file or URL source is
			// context the provider fetches and bills; a base64 PDF is billed per page.
			const src = isObject(b.source) ? b.source : {};
			if (src.type === "file" || src.type === "url") {
				refuse(w, DenyReason.providerContextUnsupported, `document:${String(src.type)}`);
				return;
			}
			if (src.type !== "text") {
				refuse(w, DenyReason.contentUnsupported, `document:${String(src.type)}`);
				return;
			}
		} else if (b.type === "tool_result") {
			walkAnthropicBlocks(b.content ?? [], w);
		}
		if (w.deny) return;
	}
}

function anthropicChecks(body: Json, w: Walk): void {
	if ("mcp_servers" in body) {
		refuse(w, DenyReason.hostedToolUnsupported, "mcp_servers");
		return;
	}
	if ("container" in body) {
		refuse(w, DenyReason.providerContextUnsupported, "container");
		return;
	}
	if (body.tools !== undefined) {
		if (!Array.isArray(body.tools)) {
			refuse(w, DenyReason.requestUnparseable, "tools");
			return;
		}
		for (const t of body.tools) {
			// A client (custom) tool has no type, or type "custom". Every server tool
			// (web_search_*, web_fetch_*, code_execution_*, …) carries another type.
			if (!isObject(t) || !(t.type === undefined || t.type === "custom")) {
				refuse(w, DenyReason.hostedToolUnsupported, `tool:${isObject(t) ? String(t.type) : "?"}`);
				return;
			}
		}
	}
	if (body.system !== undefined) walkAnthropicBlocks(body.system, w);
	if (w.deny) return;
	if (!Array.isArray(body.messages)) {
		refuse(w, DenyReason.requestUnparseable, "messages");
		return;
	}
	for (const m of body.messages) {
		if (!isObject(m)) {
			refuse(w, DenyReason.requestUnparseable, "message");
			return;
		}
		walkAnthropicBlocks(m.content, w);
		if (w.deny) return;
	}
}

// ── OpenAI /v1/chat/completions ──

function openaiTools(tools: unknown, w: Walk): void {
	if (tools === undefined) return;
	if (!Array.isArray(tools)) {
		refuse(w, DenyReason.requestUnparseable, "tools");
		return;
	}
	for (const t of tools) {
		if (!isObject(t) || t.type !== "function") {
			refuse(w, DenyReason.hostedToolUnsupported, `tool:${isObject(t) ? String(t.type) : "?"}`);
			return;
		}
	}
}

function openaiImage(url: unknown, w: Walk): void {
	if (typeof url === "string" && DATA_URI.test(url)) w.inlineBytes += url.length;
	w.images += 1;
}

function chatChecks(body: Json, w: Walk): void {
	openaiTools(body.tools, w);
	if (w.deny) return;
	if ("web_search_options" in body) {
		refuse(w, DenyReason.hostedToolUnsupported, "web_search_options");
		return;
	}
	if (Array.isArray(body.modalities) && body.modalities.some((m) => m !== "text")) {
		refuse(w, DenyReason.contentUnsupported, "modalities");
		return;
	}
	if (body.n !== undefined && body.n !== null && body.n !== 1) {
		refuse(w, DenyReason.multipleChoicesUnsupported, `n:${String(body.n)}`);
		return;
	}
	if (!Array.isArray(body.messages)) {
		refuse(w, DenyReason.requestUnparseable, "messages");
		return;
	}
	for (const m of body.messages) {
		if (!isObject(m)) {
			refuse(w, DenyReason.requestUnparseable, "message");
			return;
		}
		if (m.audio !== undefined && m.audio !== null) {
			// An earlier audio response referenced by id: the provider expands it into
			// input the body's bytes do not bound.
			refuse(w, DenyReason.providerContextUnsupported, "message:audio");
			return;
		}
		const content = m.content;
		if (content === undefined || content === null || typeof content === "string") continue;
		if (!Array.isArray(content)) {
			refuse(w, DenyReason.requestUnparseable, "content");
			return;
		}
		for (const p of content) {
			if (!isObject(p)) {
				refuse(w, DenyReason.requestUnparseable, "part");
				return;
			}
			if (p.type === "text" || p.type === "refusal") continue;
			if (p.type === "image_url") {
				openaiImage(isObject(p.image_url) ? p.image_url.url : undefined, w);
				continue;
			}
			if (p.type === "file") {
				const f = isObject(p.file) ? p.file : {};
				refuse(
					w,
					"file_id" in f ? DenyReason.providerContextUnsupported : DenyReason.contentUnsupported,
					"file",
				);
				return;
			}
			refuse(w, DenyReason.contentUnsupported, `part:${String(p.type)}`);
			return;
		}
	}
}

// ── OpenAI /v1/responses ──

function responsesContent(content: unknown, w: Walk): void {
	if (content === undefined || typeof content === "string") return;
	if (!Array.isArray(content)) {
		refuse(w, DenyReason.requestUnparseable, "content");
		return;
	}
	for (const p of content) {
		if (!isObject(p)) {
			refuse(w, DenyReason.requestUnparseable, "part");
			return;
		}
		if (p.type === "input_text" || p.type === "output_text" || p.type === "refusal") continue;
		if (p.type === "input_image") {
			if ("file_id" in p) {
				refuse(w, DenyReason.providerContextUnsupported, "input_image:file_id");
				return;
			}
			openaiImage(p.image_url, w);
			continue;
		}
		if (p.type === "input_file") {
			refuse(w, DenyReason.providerContextUnsupported, "input_file");
			return;
		}
		refuse(w, DenyReason.contentUnsupported, `part:${String(p.type)}`);
		return;
	}
}

function responsesChecks(body: Json, w: Walk): void {
	if (body.background === true) {
		refuse(w, DenyReason.backgroundUnsupported, "background");
		return;
	}
	for (const k of ["previous_response_id", "conversation", "prompt"]) {
		if (body[k] !== undefined && body[k] !== null) {
			refuse(w, DenyReason.providerContextUnsupported, k);
			return;
		}
	}
	openaiTools(body.tools, w);
	if (w.deny) return;
	const input = body.input;
	if (typeof input === "string") return;
	if (!Array.isArray(input)) {
		refuse(w, DenyReason.requestUnparseable, "input");
		return;
	}
	for (const item of input) {
		if (!isObject(item)) {
			refuse(w, DenyReason.requestUnparseable, "item");
			return;
		}
		const type = item.type ?? (typeof item.role === "string" ? "message" : undefined);
		if (type === "message") {
			responsesContent(item.content, w);
		} else if (type === "function_call_output") {
			// A tool's output may be content parts (images, files): the SAME allowlist and
			// image counting as a message, or an image is billed and never bounded.
			responsesContent(item.output, w);
		} else if (type === "reasoning") {
			// Without encrypted_content the item is a REFERENCE to stored reasoning the
			// provider expands; only a self-contained item is bounded by its bytes.
			if (typeof item.encrypted_content !== "string") {
				refuse(w, DenyReason.providerContextUnsupported, "reasoning:stored");
				return;
			}
		} else if (type === "item_reference") {
			refuse(w, DenyReason.providerContextUnsupported, "item_reference");
			return;
		} else if (type !== "function_call") {
			refuse(w, DenyReason.contentUnsupported, `item:${String(type)}`);
			return;
		}
		if (w.deny) return;
	}
}

// ── top-level fields: an allowlist per route, and the tiers priced above standard ──

/**
 * Every top-level field a route may carry. A field not named is DENIED — including
 * one that does not exist yet — and so is a documented field whose billing v1 does
 * not bound: Anthropic `fallbacks` (a second attempt at another model's rates),
 * `compaction`, `context_management`, `diagnostics`; OpenAI `audio`, `prediction`,
 * `moderation`, `prompt_cache_options` / `prompt_cache_retention` (cache writes and
 * extended retention priced off the table), `context_management`, `access_programs`.
 */
const TOP_LEVEL: Record<MeteredRoute, ReadonlySet<string>> = {
	"anthropic.messages": new Set([
		"model",
		"max_tokens",
		"messages",
		"system",
		"metadata",
		"stop_sequences",
		"stream",
		"temperature",
		"top_k",
		"top_p",
		"tools",
		"tool_choice",
		"thinking",
		"service_tier",
		"speed",
		"inference_geo",
		"cache_control",
		"output_config",
		"output_format",
	]),
	"openai.chat": new Set([
		"model",
		"messages",
		"max_completion_tokens",
		"max_tokens",
		"frequency_penalty",
		"presence_penalty",
		"function_call",
		"functions",
		"logit_bias",
		"logprobs",
		"top_logprobs",
		"metadata",
		"modalities",
		"n",
		"parallel_tool_calls",
		"prompt_cache_key",
		"reasoning_effort",
		"response_format",
		"safety_identifier",
		"seed",
		"service_tier",
		"stop",
		"store",
		"stream",
		"stream_options",
		"temperature",
		"tool_choice",
		"tools",
		"top_p",
		"user",
		"verbosity",
	]),
	"openai.responses": new Set([
		"model",
		"input",
		"instructions",
		"max_output_tokens",
		"max_tool_calls",
		"metadata",
		"parallel_tool_calls",
		"prompt_cache_key",
		"reasoning",
		"safety_identifier",
		"service_tier",
		"store",
		"stream",
		"stream_options",
		"temperature",
		"text",
		"tool_choice",
		"tools",
		"top_logprobs",
		"top_p",
		"truncation",
		"user",
		"include",
		"background",
	]),
};

/** OpenAI tiers at or BELOW standard rates. Absent and "auto" are pinned to "default". */
const OPENAI_TIERS = new Set(["default", "flex"]);

/**
 * Deny a tier priced above the table's standard rates, then any field off the
 * route's allowlist. Returns the OpenAI service tier to forward (pinned).
 */
function topLevelChecks(route: MeteredRoute, body: Json, w: Walk): string | undefined {
	if (route === "anthropic.messages") {
		// Fast mode bills premium rates; a US-only region bills 1.1×. service_tier
		// ("auto" / "standard_only") carries no per-token premium.
		if (body.speed !== undefined && body.speed !== "standard") {
			refuse(w, DenyReason.pricingTierUnsupported, `speed:${String(body.speed)}`);
			return undefined;
		}
		if (body.inference_geo !== undefined && body.inference_geo !== "global") {
			refuse(w, DenyReason.pricingTierUnsupported, `inference_geo:${String(body.inference_geo)}`);
			return undefined;
		}
		const tier = body.service_tier;
		if (tier !== undefined && tier !== "auto" && tier !== "standard_only") {
			refuse(w, DenyReason.pricingTierUnsupported, `service_tier:${String(tier)}`);
			return undefined;
		}
	}
	let pinned: string | undefined;
	if (route !== "anthropic.messages") {
		// Absent or "auto" means the PROJECT's configured tier, which the gate cannot
		// see and may be priority: pin it to "default" in the forwarded body.
		const tier = body.service_tier;
		if (tier === undefined || tier === null || tier === "auto") pinned = "default";
		else if (typeof tier === "string" && OPENAI_TIERS.has(tier)) pinned = tier;
		else {
			refuse(w, DenyReason.pricingTierUnsupported, `service_tier:${String(tier)}`);
			return undefined;
		}
		if (route === "openai.responses" && body.instructions != null) {
			if (typeof body.instructions !== "string") {
				refuse(w, DenyReason.contentUnsupported, "instructions");
				return undefined;
			}
		}
	}
	// stream_options is an ALLOWLIST (#168): a key a provider adds later (e.g. vLLM's
	// `continuous_usage_stats`, which reports usage on EVERY chunk) could change how, or
	// whether, the stream reports the usage the hold settles from — refused until reviewed.
	// A non-object is refused too: when not streaming it would be forwarded as sent.
	if (body.stream_options != null) {
		if (!isObject(body.stream_options)) {
			refuse(w, DenyReason.parameterUnsupported, "stream_options.type");
			return undefined;
		}
		for (const k of Object.keys(body.stream_options)) {
			if (!STREAM_OPTION_KEYS.has(k)) {
				refuse(w, DenyReason.parameterUnsupported, `stream_options.${k}`);
				return undefined;
			}
		}
	}
	const allowed = TOP_LEVEL[route];
	for (const k of Object.keys(body)) {
		if (!allowed.has(k)) {
			refuse(w, DenyReason.parameterUnsupported, `param:${k}`);
			return undefined;
		}
	}
	return pinned;
}

const hasTools = (body: Json) =>
	(Array.isArray(body.tools) && body.tools.length > 0) ||
	(Array.isArray(body.functions) && body.functions.length > 0);

// ── output limit ──

const isCount = (v: unknown): v is number =>
	typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** The request's own output limit, or null when it sets none (or an invalid one). */
function maxOutput(route: MeteredRoute, body: Json): number | null {
	if (route === "anthropic.messages") return isCount(body.max_tokens) ? body.max_tokens : null;
	if (route === "openai.responses")
		return isCount(body.max_output_tokens) ? body.max_output_tokens : null;
	const limits = [body.max_completion_tokens, body.max_tokens].filter(isCount);
	return limits.length === 0 ? null : Math.max(...limits);
}

const isRate = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * An operator's own rate for this model, if it has one, must be a price: every rate a finite,
 * non-negative number (the cache rates may be absent). A negative, NaN or infinite rate would
 * hold a negative, NaN or infinite amount, so the model is UNPRICED — and a broken override of a
 * table model is never quietly replaced by the table's rate.
 */
function operatorRatesValid(model: string, customRates: GateConfig["customRates"]): boolean {
	if (!customRates || !Object.hasOwn(customRates, model)) return true;
	const r: unknown = customRates[model];
	if (typeof r !== "object" || r === null) return false;
	const rates = r as Record<string, unknown>;
	if (!isRate(rates.inputPer1k) || !isRate(rates.outputPer1k)) return false;
	for (const k of ["cacheReadPer1k", "cacheWritePer1k"]) {
		if (rates[k] !== undefined && !isRate(rates[k])) return false;
	}
	return true;
}

/**
 * Evaluate one request. Throws {@link BodyTooLargeError} past the payload maximum
 * (a middleware failure, so OpenShell's fail-closed default blocks the call).
 */
export function evaluateRequest(
	req: GateRequest,
	config: GateConfig = DEFAULT_GATE_CONFIG,
): GateResult {
	validateTokenConfig(config); // a config that cannot price a hold is refused first (#171)
	const match = matchRoute(req.method, req.host, req.path, config.routes);
	if (match.kind === "unsupported")
		return { decision: "deny", reason: DenyReason.routeUnsupported };
	if (match.kind === "passthrough") {
		return { decision: "passthrough", mutations: { removeHeaders: [] } };
	}
	if (req.body.byteLength > MAX_BODY_BYTES) throw new BodyTooLargeError(req.body.byteLength);

	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
	} catch {
		return { decision: "deny", reason: DenyReason.requestUnparseable, detail: "json" };
	}
	if (!isObject(body) || typeof body.model !== "string" || body.model.length === 0) {
		return { decision: "deny", reason: DenyReason.requestUnparseable, detail: "model" };
	}
	const model = body.model;

	const w: Walk = { images: 0, inlineBytes: 0 };
	if (match.route === "anthropic.messages") anthropicChecks(body, w);
	else if (match.route === "openai.chat") chatChecks(body, w);
	else responsesChecks(body, w);
	const serviceTier = w.deny ? undefined : topLevelChecks(match.route, body, w);
	if (w.deny) return { decision: "deny", ...w.deny };

	const maxOutputTokens = maxOutput(match.route, body);
	if (maxOutputTokens === null) {
		return { decision: "deny", reason: DenyReason.maxOutputUnbounded };
	}
	if (!isModelPriced(model, config.customRates) || !operatorRatesValid(model, config.customRates)) {
		return { decision: "deny", reason: DenyReason.modelUnpriced, detail: model };
	}

	const streaming = body.stream === true;
	// The FORWARDED body is always this parse re-serialized, so the provider reads
	// exactly the document the gate checked: with duplicate keys, the gate and the
	// provider's parser could otherwise keep different values.
	const forwarded: Json = { ...body };
	if (serviceTier !== undefined) forwarded.service_tier = serviceTier;
	if (match.route === "openai.chat" && streaming) {
		// Without it a chat-completions stream carries no usage. /v1/responses reports
		// usage in its terminal event.
		forwarded.stream_options = {
			...(isObject(body.stream_options) ? body.stream_options : {}),
			include_usage: true,
		};
	}
	const bytes = new TextEncoder().encode(JSON.stringify(forwarded));
	if (bytes.byteLength > MAX_BODY_BYTES) throw new BodyTooLargeError(bytes.byteLength);

	// The input bound, on the bytes the provider RECEIVES: every byte is at most one
	// token (no tokenizer emits a token for less than a byte, and JSON framing
	// outweighs the providers' template tokens), except inline image data, which is
	// billed per image instead.
	const perImage = Object.hasOwn(config.imageTokenMaxByModel, model)
		? (config.imageTokenMaxByModel[model] ?? config.imageTokenMax[match.provider])
		: config.imageTokenMax[match.provider];
	const inputTokenBound =
		bytes.byteLength -
		w.inlineBytes +
		w.images * perImage +
		(hasTools(body) ? config.toolOverheadTokens[match.provider] : 0);
	// A FROZEN COPY: getModelRates returns the operator's own object, and an in-place edit after
	// authorize must not change what this hold settles at. ModelRates is flat numbers.
	const rates: ModelRates = Object.freeze({ ...getModelRates(model, config.customRates) });
	// Priced at the DEAREST input tier: plain input, cache write (a prompt the provider writes
	// to its cache bills above plain input) and cache read (#169: an operator's rate may price
	// a cache read above both). Each tier is linear, so no split of the bound costs more.
	const amount = Math.max(
		costFromRates(rates, inputTokenBound, maxOutputTokens),
		costFromRates(rates, 0, maxOutputTokens, 0, inputTokenBound),
		costFromRates(rates, 0, maxOutputTokens, inputTokenBound, 0),
	);

	const mutations: RequestMutations = {
		// Response bodies are inspectable only when not content-coded.
		removeHeaders: ["accept-encoding"],
		body: bytes,
	};
	return {
		decision: "allow",
		// Frozen (#170): what this hold settles at is fixed at authorize; `rates` is frozen above.
		hold: Object.freeze({
			route: match.route,
			model,
			inputTokenBound,
			maxOutputTokens,
			amount,
			streaming,
			rates,
		}),
		mutations,
	};
}
