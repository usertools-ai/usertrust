// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	AnomalyError,
	InsufficientBalanceError,
	PolicyDeniedError,
	principalFieldRefusal,
	usageTimeRefusal,
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

/**
 * An ISO-8601 UTC instant, under core's own rule (`usageTimeRefusal`): the wire never
 * restates the pattern, for the reason `PrincipalField` doesn't.
 */
const UsageTime = z.string().superRefine((value, ctx) => {
	const refusal = usageTimeRefusal(value);
	if (refusal !== undefined) ctx.addIssue({ code: "custom", message: refusal });
});

export const AuthorizeRequestSchema = z
	.object({
		model: z.string().min(1),
		estimatedInputTokens: z.number().int().nonnegative().optional(),
		maxOutputTokens: z.number().int().positive().optional(),
		// Per-tier estimates (spec D4 tiers, at authorize): without them a window that is
		// mostly cache READS is reserved at the cache-WRITE rate. Same integer rule as the
		// settle-side tiers; omitted → 0, the pre-existing hold.
		estimatedCacheReadTokens: z.number().int().nonnegative().optional(),
		estimatedCacheWriteTokens: z.number().int().nonnegative().optional(),
		messages: z.array(z.unknown()).optional(),
		params: z.record(z.string(), z.unknown()).optional(),
		actor: z.string().optional(),
		principal: PrincipalSchema.optional(),
		// Capability `job`: which job the work is for (a LABEL, never a payer), the
		// job state when the caller's log could not be trusted, and when the usage this
		// hold covers began. Zod strips unknown keys, so an older server drops all three
		// in silence: a client sends them only to a server that lists `job`.
		job: PrincipalField.optional(),
		jobState: z.literal("invalid").optional(),
		usageFrom: UsageTime.optional(),
	})
	.refine((r) => r.job === undefined || r.jobState === undefined, {
		message: "jobState cannot accompany a job",
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
	// Capability `job`. The job and the usage START belong to the AUTHORIZE capture and
	// nothing else: `job`/`jobState` are accepted here only to be checked against it
	// (a mismatch is a 400), and `usageFrom` is accepted only to be REFUSED, so no record
	// can carry two different values. `usageTo` is the one genuine settle-side fact.
	job: PrincipalField.optional(),
	jobState: z.literal("invalid").optional(),
	usageFrom: z.never().optional(),
	usageTo: UsageTime.optional(),
});

export const AbortRequestSchema = z.object({
	transferId: z.string().min(1),
	error: z.string().optional(),
});

/**
 * `POST /v1/release` (capability `release`): give back a hold that did not fail. The
 * field is `reason`, not abort's `error`, because nothing failed. Any string is
 * accepted and CLIPPED, never refused: the governor records it through
 * `sanitizeReleaseReason`, and the `released` event carries that same text.
 */
export const ReleaseRequestSchema = z.object({
	transferId: z.string().min(1),
	reason: z.string().optional(),
});

export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;
export type SettleRequest = z.infer<typeof SettleRequestSchema>;
export type AbortRequest = z.infer<typeof AbortRequestSchema>;
export type ReleaseRequest = z.infer<typeof ReleaseRequestSchema>;

/**
 * `POST /v1/release`'s 200: THIS request ended the hold. A hold the governor no
 * longer held is a 404 `unknown transferId`, never a 200. `voidError` names a ledger
 * void that failed, as a fixed code: the hold is still ended, and the ledger's pending
 * timeout returns its funds.
 */
export interface ReleaseResponse {
	released: true;
	transferId: string;
	voidError?: string;
}

/**
 * `POST /v1/abort`'s 200, by release's rule: THIS request ended the hold. A hold the
 * governor no longer held (a settle owns it, or it already ended) is a 404 `unknown
 * transferId`, never a 200. `voidError` names a ledger void that failed, as a fixed code.
 */
export interface AbortResponse {
	aborted: true;
	transferId: string;
	voidError?: string;
}

export interface AuthorizeResponse {
	transferId: string;
	estimatedCost: number;
	model: string;
	/** Epoch ms on the server's clock, when the hold was made. For display, not for timing. */
	createdAt: number;
	/**
	 * The longest the hold can still be pending, in ms, when the answer was sent: the
	 * shorter of the server's `pendingTtlMs` sweep and the ledger's pending timeout
	 * (`hold-expiry`). No expiry ends it sooner; a settle, a void or a server restart
	 * can. A duration: added to the client's own clock reading taken before it sent the
	 * request, it gives a time no later than the hold's last moment. Absent when the
	 * server cannot state the life (a ledger hold without its timeout): a client must
	 * then treat the hold as one it cannot reuse.
	 */
	expiresInMs?: number;
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
