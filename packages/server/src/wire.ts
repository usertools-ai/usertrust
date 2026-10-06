// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	AlreadySettledError,
	AnomalyError,
	InsufficientBalanceError,
	idempotencyKeyRefusal,
	LedgerUnavailableError,
	PolicyDeniedError,
	principalFieldRefusal,
} from "usertrust";
import { z } from "zod";

/**
 * A caller idempotency key, refused by the GOVERNOR's own rule (core's
 * `idempotencyKeyRefusal`), never a copy of it: the wire refuses exactly what
 * `authorize()` would, as a 400, instead of letting the governor's TypeError
 * surface as an opaque 500.
 */
const IdempotencyKeySchema = z
	.string()
	.refine(
		(key) => idempotencyKeyRefusal(key) === null,
		"idempotencyKey must be 1–256 characters of printable ASCII, with no spaces or control characters",
	);

/** One `principal` field, by core's rule for the same reason. Extra keys are stripped. */
const PrincipalField = z
	.string()
	.refine(
		(field) => principalFieldRefusal(field) === null,
		"principal fields must be 1–128 characters of [A-Za-z0-9._:-]",
	);
const PrincipalSchema = z.object({
	id: PrincipalField,
	type: PrincipalField,
	origin: PrincipalField.optional(),
});

export const AuthorizeRequestSchema = z.object({
	model: z.string().min(1),
	estimatedInputTokens: z.number().int().nonnegative().optional(),
	maxOutputTokens: z.number().int().positive().optional(),
	messages: z.array(z.unknown()).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	actor: z.string().optional(),
	// A replay while the first hold is live answers with the same transferId; a key
	// already charged is 409 `already_settled`.
	idempotencyKey: IdempotencyKeySchema.optional(),
	// Who spent: a label on every record the hold leaves, never a wallet selector.
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
	// Read ONLY when this server holds no pending entry for `transferId` — a late
	// settle after a TTL release, or after a restart. With a key, the usage is then
	// recorded as `settlement_unrecoverable` (410) instead of answering a bare 404;
	// a held settle ignores both, because its hold's own capture is authoritative.
	idempotencyKey: IdempotencyKeySchema.optional(),
	principal: PrincipalSchema.optional(),
});

export const AbortRequestSchema = z.object({
	transferId: z.string().min(1),
	error: z.string().optional(),
});

/**
 * Give a hold back without calling it a failure: no circuit-breaker failure, and
 * `hold_released` on the chain rather than `llm_call_failed`. The governor strips
 * control characters from `reason` and clips it to 200 characters before recording.
 */
export const ReleaseRequestSchema = z.object({
	transferId: z.string().min(1),
	reason: z.string().optional(),
});

export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;
export type SettleRequest = z.infer<typeof SettleRequestSchema>;
export type AbortRequest = z.infer<typeof AbortRequestSchema>;
export type ReleaseRequest = z.infer<typeof ReleaseRequestSchema>;

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
	// The first charge under the key stands; this request is a duplicate of it.
	if (err instanceof AlreadySettledError) {
		return { status: 409, body: { error: "already_settled", reason: err.reason } };
	}
	// Retryable, and the client has to be able to tell: a keyed settle that cannot
	// read its key's post anchor must not look like the opaque 500 of a bug. The
	// reason is fixed text — the underlying message can carry ledger addresses.
	if (err instanceof LedgerUnavailableError) {
		return {
			status: 503,
			body: { error: "ledger_unavailable", reason: "the ledger could not be reached; retry" },
		};
	}
	return { status: 500, body: { error: "internal", reason: "internal error" } };
}
