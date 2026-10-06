// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	AnomalyError,
	InsufficientBalanceError,
	PolicyDeniedError,
	principalFieldRefusal,
} from "usertrust";
import { z } from "zod";

/**
 * One principal field, under core's own rule (`principalFieldRefusal`) — the wire
 * never restates the pattern, so the server cannot accept what the governor would
 * refuse, or refuse what it would accept.
 */
const PrincipalField = z.string().superRefine((value, ctx) => {
	const refusal = principalFieldRefusal(value);
	if (refusal !== undefined) ctx.addIssue({ code: "custom", message: refusal });
});

/**
 * Who the work is for. STRICT: an unknown key is a 400, not a silent strip — the
 * same failure the D4 cache tiers had, where a field the caller sent vanished on
 * the wire and the request still returned 200.
 */
export const PrincipalSchema = z
	.object({
		id: PrincipalField.optional(),
		type: PrincipalField.optional(),
		origin: PrincipalField.optional(),
		unit: PrincipalField.optional(),
		role: PrincipalField.optional(),
	})
	.strict();

export const AuthorizeRequestSchema = z.object({
	model: z.string().min(1),
	estimatedInputTokens: z.number().int().nonnegative().optional(),
	maxOutputTokens: z.number().int().positive().optional(),
	messages: z.array(z.unknown()).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	actor: z.string().optional(),
	principal: PrincipalSchema.optional(),
});

export const SettleRequestSchema = z.object({
	transferId: z.string().min(1),
	inputTokens: z.number().int().nonnegative().optional(),
	outputTokens: z.number().int().nonnegative().optional(),
	// Spec D4 row 6: zod strips unrecognized keys by default, so these two
	// tiers used to vanish silently on the wire — a settle carrying real cache
	// counts round-tripped as if they were never sent.
	cacheReadTokens: z.number().int().nonnegative().optional(),
	cacheWriteTokens: z.number().int().nonnegative().optional(),
	chunksDelivered: z.number().int().nonnegative().optional(),
	usageSource: z.enum(["provider", "estimated"]).optional(),
	// Same silent-strip as the D4 cache tiers: computeMs is already a
	// documented SettleParams / receipt.meter field. Without this key, an
	// HTTP settle carrying Ollama eval_duration returns 200 with the field
	// gone. Not .int() — core accepts any finite non-negative number.
	computeMs: z.number().finite().nonnegative().optional(),
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
