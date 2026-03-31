// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Canary Token Utilities
 *
 * Generate, inject, and detect canary tokens for prompt leak detection.
 * A canary token is a random secret embedded in system prompts. If it
 * appears in model output, the system prompt was leaked.
 *
 * Pure module — uses only Node.js crypto.
 *
 * INTEGRATION NOTE: These utilities are NOT automatically wired into the
 * governance pipeline. Callers must manually:
 *   1. Generate a canary: const canary = generateCanary()
 *   2. Inject into system prompt: injectCanary(systemPrompt, canary)
 *   3. After LLM response, check: detectCanaryLeak(output, canary)
 *
 * Automatic integration is planned for a future version.
 */

import { randomBytes } from "node:crypto";
import type { CanaryToken } from "../shared/types.js";

/**
 * Generate a new canary token.
 * Returns a 32-char hex token and an HTML comment marker.
 */
export function generateCanary(): CanaryToken {
	const token = randomBytes(16).toString("hex");
	const marker = `<!-- ${token} -->`;
	return { token, marker };
}

/**
 * Inject a canary token into a system prompt.
 * Prepends the HTML comment marker to the prompt.
 */
export function injectCanary(systemPrompt: string, canary: CanaryToken): string {
	return `${canary.marker}\n${systemPrompt}`;
}

/**
 * Detect if a canary token leaked into model output.
 * Returns true if the token appears anywhere in the output.
 */
export function detectCanaryLeak(output: string, canary: CanaryToken): boolean {
	return output.includes(canary.token);
}
