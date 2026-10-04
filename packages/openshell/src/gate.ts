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
	 * Tokens charged per image in the input bound. CONSERVATIVE defaults above the
	 * providers' documented per-image maxima as read at the time of writing;
	 * operator-configurable, and a candidate for measurement (README "Spec gaps").
	 */
	imageTokenMax: Record<Provider, number>;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
	routes: DEFAULT_ROUTE_CONFIG,
	imageTokenMax: { anthropic: 2_000, openai: 4_000 },
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
	/** A replacement body, when one is needed. */
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

const RESPONSES_PASS_ITEMS = new Set(["function_call", "function_call_output", "reasoning"]);

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
		} else if (type === "item_reference") {
			refuse(w, DenyReason.providerContextUnsupported, "item_reference");
			return;
		} else if (typeof type !== "string" || !RESPONSES_PASS_ITEMS.has(type)) {
			refuse(w, DenyReason.contentUnsupported, `item:${String(type)}`);
			return;
		}
		if (w.deny) return;
	}
}

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

/**
 * Evaluate one request. Throws {@link BodyTooLargeError} past the payload maximum
 * (a middleware failure, so OpenShell's fail-closed default blocks the call).
 */
export function evaluateRequest(
	req: GateRequest,
	config: GateConfig = DEFAULT_GATE_CONFIG,
): GateResult {
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
	if (w.deny) return { decision: "deny", ...w.deny };

	const maxOutputTokens = maxOutput(match.route, body);
	if (maxOutputTokens === null) {
		return { decision: "deny", reason: DenyReason.maxOutputUnbounded };
	}
	if (!isModelPriced(model, config.customRates)) {
		return { decision: "deny", reason: DenyReason.modelUnpriced, detail: model };
	}

	// The input bound: every byte of the body is at most one token (no tokenizer emits
	// a token for less than a byte, and JSON framing outweighs the providers' template
	// tokens), except inline image data, which is billed per image instead.
	const inputTokenBound =
		req.body.byteLength - w.inlineBytes + w.images * config.imageTokenMax[match.provider];
	const rates = getModelRates(model, config.customRates);
	// Priced at the DEARER of the input and cache-write tiers: a prompt the provider
	// writes to its cache bills above plain input.
	const amount = Math.max(
		costFromRates(rates, inputTokenBound, maxOutputTokens),
		costFromRates(rates, 0, maxOutputTokens, 0, inputTokenBound),
	);

	const streaming = body.stream === true;
	const mutations: RequestMutations = {
		// Response bodies are inspectable only when not content-coded.
		removeHeaders: ["accept-encoding"],
	};
	if (match.route === "openai.chat" && streaming) {
		// Without it a chat-completions stream carries no usage. /v1/responses is never
		// mutated: its stream reports usage in `response.completed`.
		const so = isObject(body.stream_options) ? body.stream_options : {};
		mutations.body = new TextEncoder().encode(
			JSON.stringify({ ...body, stream_options: { ...so, include_usage: true } }),
		);
	}
	return {
		decision: "allow",
		hold: { route: match.route, model, inputTokenBound, maxOutputTokens, amount, streaming },
		mutations,
	};
}
