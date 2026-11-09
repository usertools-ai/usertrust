// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Which provider a record belongs to, for the desk's breakdown, colours and filters. The provider the record itself
 * names wins; else the model's prefix (`detectProvider`); anything outside the four named providers is "Other".
 */

import { detectProvider, type LedgerRow } from "./rows.js";

export type ProviderName = "Anthropic" | "OpenAI" | "xAI" | "Google" | "Other";

/** `detectProvider`'s lowercase names, and the spellings a record may carry, to the display name. */
function named(p: string): ProviderName {
	switch (p.trim().toLowerCase()) {
		case "anthropic":
			return "Anthropic";
		case "openai":
			return "OpenAI";
		case "xai":
		case "x-ai":
		case "x.ai":
			return "xAI";
		case "google":
		case "gemini":
		case "vertex":
		case "google-vertex":
			return "Google";
		default:
			return "Other";
	}
}

export function providerOf(
	row: Pick<LedgerRow, "provider" | "providerRecorded" | "model">,
): ProviderName {
	if (row.providerRecorded !== undefined && row.providerRecorded.trim() !== "") {
		return named(row.providerRecorded);
	}
	if (row.model !== undefined) return named(detectProvider(row.model.toLowerCase()));
	return row.provider !== undefined ? named(row.provider) : "Other";
}
