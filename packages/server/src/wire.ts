// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { AnomalyError, InsufficientBalanceError, PolicyDeniedError } from "usertrust";
import { z } from "zod";

export const AuthorizeRequestSchema = z.object({
	model: z.string().min(1),
	estimatedInputTokens: z.number().int().nonnegative().optional(),
	maxOutputTokens: z.number().int().positive().optional(),
	messages: z.array(z.unknown()).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	actor: z.string().optional(),
});

export const SettleRequestSchema = z.object({
	transferId: z.string().min(1),
	inputTokens: z.number().int().nonnegative().optional(),
	outputTokens: z.number().int().nonnegative().optional(),
	chunksDelivered: z.number().int().nonnegative().optional(),
	usageSource: z.enum(["provider", "estimated"]).optional(),
});

export const AbortRequestSchema = z.object({
	transferId: z.string().min(1),
	error: z.string().optional(),
});

export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;
export type SettleRequest = z.infer<typeof SettleRequestSchema>;
export type AbortRequest = z.infer<typeof AbortRequestSchema>;

export interface AuthorizeResponse {
	transferId: string;
	estimatedCost: number;
	model: string;
	createdAt: number;
}

/**
 * Shadow (evaluate_only) response. Carries a `shadowId` — deliberately NOT a
 * `transferId` — because no reservation exists: shadow ids cannot be settled
 * or aborted, and hitting those routes with one 404s naturally.
 */
export interface ShadowResponse {
	shadow: true;
	shadowId: string;
	decision: "would_deny";
	reason: string;
}

/**
 * Map governance errors to HTTP responses. Unknown errors return an opaque
 * 500 — internal messages (which may embed key material or file paths) are
 * never forwarded to clients.
 */
export function toHttpError(err: unknown): {
	status: number;
	body: { error: string; reason: string };
} {
	if (err instanceof PolicyDeniedError) {
		return { status: 403, body: { error: "policy_denied", reason: err.reason } };
	}
	if (err instanceof InsufficientBalanceError) {
		return {
			status: 402,
			body: {
				error: "budget_exceeded",
				reason: `need ${err.required}, have ${err.available}`,
			},
		};
	}
	if (err instanceof AnomalyError) {
		return { status: 429, body: { error: "anomaly", reason: err.message } };
	}
	return { status: 500, body: { error: "internal", reason: "internal error" } };
}
