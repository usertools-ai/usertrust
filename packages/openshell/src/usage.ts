// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Incremental usage parsers for a response body that arrives in units (≤ 64 KiB
 * each from OpenShell, any split). The parser keeps STATE across units — a
 * partial-line buffer and the current event's data, both bounded, and the usage
 * fields seen so far — never the body. Its result is the same for every split of
 * the same bytes.
 *
 * `end()` returns the provider's usage only when the provider reported BOTH input
 * and output (core's `source: "provider"`) AND the body is complete — a stream must
 * reach its route's TERMINAL event. Anything else settles at the hold
 * (`usage_unreadable`, with why) rather than at a count the provider never finished
 * reporting: a stream cut after `message_start` carries the input count and one
 * output token, and settling on that would UNDER-charge.
 */

import {
	fromAnthropicUsage,
	fromOpenAICompletionsUsage,
	fromOpenAIResponsesUsage,
	type NormalizedUsage,
} from "usertrust";
import { MAX_BODY_BYTES } from "./gate.js";
import type { MeteredRoute } from "./routes.js";

/** Why a body's usage cannot be settled on: the caller settles at the hold. */
export type UnreadableWhy =
	/** The JSON body is over the payload maximum. */
	| "too-large"
	/** The JSON body does not parse, or is not an object. */
	| "unparseable"
	/** The body carries no provider usage (or only half of it). */
	| "no-usage"
	/** The stream ended before its route's terminal event. */
	| "truncated"
	/** One SSE line, or one event's data, over its bound. */
	| "line-too-long";

export type UsageResult =
	| { kind: "usage"; usage: NormalizedUsage }
	| { kind: "settle_at_hold"; finding: "usage_unreadable"; why: UnreadableWhy };

export interface UsageParser {
	push(unit: Uint8Array): void;
	end(): UsageResult;
}

/** One SSE line, or one event's joined data, longer than this is not a usage event. */
export const MAX_SSE_LINE = 1024 * 1024;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const atHold = (why: UnreadableWhy): UsageResult => ({
	kind: "settle_at_hold",
	finding: "usage_unreadable",
	why,
});

function normalize(route: MeteredRoute, usage: unknown): UsageResult {
	if (!isObject(usage)) return atHold("no-usage");
	const u =
		route === "anthropic.messages"
			? fromAnthropicUsage(usage)
			: route === "openai.chat"
				? fromOpenAICompletionsUsage(usage)
				: fromOpenAIResponsesUsage(usage);
	return u.source === "provider" ? { kind: "usage", usage: u } : atHold("no-usage");
}

/** WHOLE_BODY_BYTES: the response is one JSON document with a top-level `usage`. */
class JsonUsageParser implements UsageParser {
	private readonly units: Uint8Array[] = [];
	private bytes = 0;
	constructor(private readonly route: MeteredRoute) {}
	push(unit: Uint8Array): void {
		this.bytes += unit.byteLength;
		if (this.bytes <= MAX_BODY_BYTES) this.units.push(unit);
	}
	end(): UsageResult {
		if (this.bytes > MAX_BODY_BYTES) return atHold("too-large");
		const all = new Uint8Array(this.bytes);
		let at = 0;
		for (const u of this.units) {
			all.set(u, at);
			at += u.byteLength;
		}
		let doc: unknown;
		try {
			doc = JSON.parse(new TextDecoder().decode(all));
		} catch {
			// A body cut short is not JSON: complete or nothing.
			return atHold("unparseable");
		}
		return isObject(doc) ? normalize(this.route, doc.usage) : atHold("unparseable");
	}
}

/** The Responses events that END a stream; each carries the response with its usage. */
const RESPONSES_TERMINAL = new Set([
	"response.completed",
	"response.incomplete",
	"response.failed",
]);

/**
 * STREAM_BYTES: server-sent events. Lines are split on LF (CR stripped); an event's
 * `data:` lines are joined and parsed when a blank line ends it.
 * - Anthropic: `message_start` carries input and cache counts; each `message_delta`
 *   carries cumulative counts (output, and sometimes input). Later values win. The
 *   stream is complete at `message_stop`.
 * - OpenAI chat: the usage chunk (`include_usage`) is sent after the last choice
 *   chunk, so it is itself the terminal report; earlier chunks carry `usage: null`.
 * - OpenAI responses: the terminal event (`response.completed`, `.incomplete` or
 *   `.failed`) carries `response.usage`, and is the only usage read — an incomplete
 *   or failed response that reports usage was billed for it.
 */
class SseUsageParser implements UsageParser {
	private readonly decoder = new TextDecoder();
	private line = "";
	private data: string[] = [];
	private dataLength = 0;
	private broken = false;
	private terminal = false;
	private usage: Json | null = null;
	constructor(private readonly route: MeteredRoute) {}

	push(unit: Uint8Array): void {
		if (this.broken) return;
		this.feed(this.decoder.decode(unit, { stream: true }));
	}

	end(): UsageResult {
		if (!this.broken) {
			this.feed(this.decoder.decode());
			if (!this.broken && this.line.length > 0) this.onLine(this.line);
			this.line = "";
			if (!this.broken) this.dispatch();
		}
		if (this.broken) return atHold("line-too-long");
		if (!this.terminal) return atHold("truncated");
		return normalize(this.route, this.usage);
	}

	/**
	 * The line bound is checked on the WHOLE line however it arrived — a completed
	 * line and a pending partial alike — so the result cannot depend on the split.
	 */
	private feed(text: string): void {
		let start = 0;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", start)) {
			if (this.line.length + (i - start) > MAX_SSE_LINE) {
				this.broken = true;
				return;
			}
			this.onLine(this.line + text.slice(start, i));
			this.line = "";
			start = i + 1;
			if (this.broken) return;
		}
		if (this.line.length + (text.length - start) > MAX_SSE_LINE) {
			this.broken = true;
			return;
		}
		this.line += text.slice(start);
	}

	private onLine(raw: string): void {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line === "") {
			this.dispatch();
			return;
		}
		if (!line.startsWith("data:")) return;
		const part = line.slice(line[5] === " " ? 6 : 5);
		// One event's data, across all its lines, is bounded like one line.
		this.dataLength += part.length + 1;
		if (this.dataLength > MAX_SSE_LINE) {
			this.broken = true;
			return;
		}
		this.data.push(part);
	}

	private dispatch(): void {
		if (this.data.length === 0) return;
		const payload = this.data.join("\n");
		this.data = [];
		this.dataLength = 0;
		if (payload === "[DONE]") return;
		let event: unknown;
		try {
			event = JSON.parse(payload);
		} catch {
			return; // not a JSON event: carries no usage
		}
		if (!isObject(event)) return;
		this.take(event);
	}

	private take(event: Json): void {
		if (this.terminal) return; // nothing after the terminal report counts
		if (this.route === "anthropic.messages") {
			const u =
				event.type === "message_start" && isObject(event.message)
					? event.message.usage
					: event.type === "message_delta"
						? event.usage
						: undefined;
			if (isObject(u)) this.usage = { ...(this.usage ?? {}), ...u };
			if (event.type === "message_stop") this.terminal = true;
		} else if (this.route === "openai.chat") {
			if (isObject(event.usage)) {
				this.usage = event.usage;
				this.terminal = true;
			}
		} else if (typeof event.type === "string" && RESPONSES_TERMINAL.has(event.type)) {
			this.terminal = true;
			const r = isObject(event.response) ? event.response : {};
			this.usage = isObject(r.usage) ? r.usage : null;
		}
	}
}

export function createUsageParser(
	route: MeteredRoute,
	mode: "STREAM_BYTES" | "WHOLE_BODY_BYTES",
): UsageParser {
	return mode === "STREAM_BYTES" ? new SseUsageParser(route) : new JsonUsageParser(route);
}
