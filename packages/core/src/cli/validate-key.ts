// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: API key duck-typing and validation.
 *
 * Detects provider from key prefix, validates by hitting
 * a lightweight provider endpoint (3s timeout).
 */

export interface KeyValidationResult {
	valid: boolean;
	error?: string;
}

const PROVIDER_ENDPOINTS: Record<
	string,
	{ url: string; headers: (key: string) => Record<string, string> }
> = {
	anthropic: {
		url: "https://api.anthropic.com/v1/models",
		headers: (key) => ({
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
		}),
	},
	openai: {
		url: "https://api.openai.com/v1/models",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
	},
	google: {
		url: "https://generativelanguage.googleapis.com/v1/models",
		headers: (key) => ({ "x-goog-api-key": key }),
	},
};

/** Detect provider from API key prefix. Returns null if unrecognized. */
export function detectProvider(key: string): string | null {
	if (key.startsWith("sk-ant-")) return "anthropic";
	if (key.startsWith("sk-")) return "openai";
	if (key.startsWith("AIza")) return "google";
	return null;
}

/** Validate an API key against the provider's models endpoint. */
export async function validateKey(key: string, provider: string): Promise<KeyValidationResult> {
	const endpoint = PROVIDER_ENDPOINTS[provider];
	if (!endpoint) return { valid: true };

	try {
		const resp = await fetch(endpoint.url, {
			method: "GET",
			headers: endpoint.headers(key),
			signal: AbortSignal.timeout(3000),
		});
		if (resp.ok) return { valid: true };
		return { valid: false, error: `HTTP ${resp.status}` };
	} catch (err) {
		return {
			valid: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Mask an API key for display: show prefix + dots. */
export function maskKey(key: string): string {
	if (key.length <= 8) return "••••••••";
	return `${key.slice(0, 8)}••••••••`;
}
