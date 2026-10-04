// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Incremental usage parsers for a response body that arrives in units (≤ 64 KiB
 * each from OpenShell, any split). The parser keeps STATE across units — a
 * partial-line buffer, bounded, and the usage fields seen so far — never the
 * body. Its result is the same for every split of the same bytes.
 *
 * `end()` returns the provider's usage only when the provider reported BOTH input
 * and output (core's `source: "provider"`); otherwise null, and the caller settles
 * at the hold with `usage_unreadable` rather than fabricating a count.
 */

import {
	fromAnthropicUsage,
	fromOpenAICompletionsUsage,
	fromOpenAIResponsesUsage,
	type NormalizedUsage,
} from "usertrust";
import { MAX_BODY_BYTES } from "./gate.js";
import type { MeteredRoute } from "./routes.js";

export interface UsageParser {
	push(unit: Uint8Array): void;
	/** Provider-reported usage, or null when the body did not carry it. */
	end(): NormalizedUsage | null;
}

/** One SSE line longer than this is not a provider usage event: give up, settle at the hold. */
const MAX_SSE_LINE = 1024 * 1024;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function provided(u: NormalizedUsage): NormalizedUsage | null {
	return u.source === "provider" ? u : null;
}

function normalize(route: MeteredRoute, usage: unknown): NormalizedUsage | null {
	if (!isObject(usage)) return null;
	if (route === "anthropic.messages") return provided(fromAnthropicUsage(usage));
	if (route === "openai.chat") return provided(fromOpenAICompletionsUsage(usage));
	return provided(fromOpenAIResponsesUsage(usage));
}

/** WHOLE_BODY_BYTES: the response is one JSON document with a top-level `usage`. */
class JsonUsageParser implements UsageParser {
	private readonly units: Uint8Array[] = [];
	private bytes = 0;
	private overflow = false;
	constructor(private readonly route: MeteredRoute) {}
	push(unit: Uint8Array): void {
		this.bytes += unit.byteLength;
		if (this.bytes > MAX_BODY_BYTES) this.overflow = true;
		if (!this.overflow) this.units.push(unit);
	}
	end(): NormalizedUsage | null {
		if (this.overflow) return null;
		const all = new Uint8Array(this.bytes);
		let at = 0;
		for (const u of this.units) {
			all.set(u, at);
			at += u.byteLength;
		}
		try {
			const doc: unknown = JSON.parse(new TextDecoder().decode(all));
			return isObject(doc) ? normalize(this.route, doc.usage) : null;
		} catch {
			return null;
		}
	}
}

/**
 * STREAM_BYTES: server-sent events. Lines are split on LF (CR stripped); an event's
 * `data:` lines are joined and parsed when a blank line ends it.
 * - Anthropic: `message_start` carries input and cache counts; each `message_delta`
 *   carries cumulative counts (output, and sometimes input). Later values win.
 * - OpenAI chat: the final chunk carries `usage` (with `include_usage`).
 * - OpenAI responses: `response.completed` carries `response.usage`.
 */
class SseUsageParser implements UsageParser {
	private readonly decoder = new TextDecoder();
	private line = "";
	private data: string[] = [];
	private broken = false;
	private usage: Json | null = null;
	constructor(private readonly route: MeteredRoute) {}

	push(unit: Uint8Array): void {
		if (this.broken) return;
		this.feed(this.decoder.decode(unit, { stream: true }));
	}

	end(): NormalizedUsage | null {
		if (!this.broken) {
			this.feed(this.decoder.decode());
			if (this.line.length > 0) this.onLine(this.line);
			this.line = "";
			this.dispatch();
		}
		return this.broken || this.usage === null ? null : normalize(this.route, this.usage);
	}

	private feed(text: string): void {
		let start = 0;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", start)) {
			this.onLine(this.line + text.slice(start, i));
			this.line = "";
			start = i + 1;
			if (this.broken) return;
		}
		this.line += text.slice(start);
		if (this.line.length > MAX_SSE_LINE) this.broken = true;
	}

	private onLine(raw: string): void {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line === "") {
			this.dispatch();
			return;
		}
		if (line.startsWith("data:")) this.data.push(line.slice(line[5] === " " ? 6 : 5));
	}

	private dispatch(): void {
		if (this.data.length === 0) return;
		const payload = this.data.join("\n");
		this.data = [];
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
		if (this.route === "anthropic.messages") {
			const u =
				event.type === "message_start" && isObject(event.message)
					? event.message.usage
					: event.type === "message_delta"
						? event.usage
						: undefined;
			if (isObject(u)) this.usage = { ...(this.usage ?? {}), ...u };
		} else if (this.route === "openai.chat") {
			if (isObject(event.usage)) this.usage = event.usage;
		} else if (event.type === "response.completed" && isObject(event.response)) {
			if (isObject(event.response.usage)) this.usage = event.response.usage;
		}
	}
}

export function createUsageParser(
	route: MeteredRoute,
	mode: "STREAM_BYTES" | "WHOLE_BODY_BYTES",
): UsageParser {
	return mode === "STREAM_BYTES" ? new SseUsageParser(route) : new JsonUsageParser(route);
}
