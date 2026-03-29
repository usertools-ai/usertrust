// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * LLM Client Detection — duck typing for Anthropic, OpenAI, and Google SDKs.
 *
 * Uses structural checks (duck typing) to identify which SDK a client object
 * belongs to, without requiring the SDK packages as dependencies.
 *
 * **Governance boundary:** only the following methods are intercepted and governed:
 * - Anthropic: `client.messages.create()`
 * - OpenAI: `client.chat.completions.create()`
 * - Google: `client.models.generateContent()`
 *
 * Alternative methods (e.g., `client.messages.stream`, `client.beta.*`, streaming
 * APIs, `client.completions.create`) are **NOT** intercepted and will bypass
 * governance, audit, and budget enforcement. This is a known limitation of
 * duck-typed proxy interception. Callers relying on ungoverned methods should
 * implement their own budget and audit controls or wrap calls through the
 * governed entry points above.
 */

import type { LLMClientKind } from "./shared/types.js";

/**
 * Detect which LLM SDK a client belongs to by inspecting its shape.
 *
 * Governance boundary: only the following methods are intercepted and governed:
 * - Anthropic: `client.messages.create()`
 * - OpenAI: `client.chat.completions.create()`
 * - Google: `client.models.generateContent()`
 *
 * Alternative methods (e.g., `client.messages.stream`, `client.beta.*`, streaming APIs)
 * are NOT intercepted and will bypass governance, audit, and budget enforcement.
 * This is a known limitation of duck-typed proxy interception.
 *
 * @throws {Error} if the client does not match any known SDK shape
 */
export function detectClientKind(client: unknown): LLMClientKind {
	if (
		client != null &&
		typeof client === "object" &&
		"messages" in client &&
		client.messages != null &&
		typeof client.messages === "object" &&
		"create" in client.messages &&
		typeof client.messages.create === "function"
	) {
		return "anthropic";
	}

	if (
		client != null &&
		typeof client === "object" &&
		"chat" in client &&
		client.chat != null &&
		typeof client.chat === "object" &&
		"completions" in client.chat &&
		client.chat.completions != null &&
		typeof client.chat.completions === "object" &&
		"create" in client.chat.completions &&
		typeof client.chat.completions.create === "function"
	) {
		return "openai";
	}

	if (
		client != null &&
		typeof client === "object" &&
		"models" in client &&
		client.models != null &&
		typeof client.models === "object" &&
		"generateContent" in client.models &&
		typeof client.models.generateContent === "function"
	) {
		return "google";
	}

	throw new Error("Unsupported LLM client: could not detect Anthropic, OpenAI, or Google SDK");
}
