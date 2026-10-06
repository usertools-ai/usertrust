// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash } from "node:crypto";

/**
 * WHO did the work a spend paid for — a reporting label, never a payer.
 *
 * `costCenter` (`withCostCenter`) decides which funded envelope a hold DEBITS. A
 * principal decides nothing about money: it never selects an account and never
 * enters the policy gate. It is carried onto the audit records of the call and
 * onto the call's ledger transfers as `user_data` tags, so work can be rolled up
 * by agent, business unit and role without changing who pays. A `unit` that
 * should also be a budget is a separate, deliberate `withCostCenter` scope.
 *
 * Every field is optional; at least one must be present for a principal to exist.
 * - `id`   — the agent instance (e.g. a subagent id). Make it globally unique if
 *            per-agent roll-ups should not merge agents that share an id.
 * - `type` — the agent kind (e.g. "Explore").
 * - `origin` — where the work came from (e.g. a client and its session,
 *              "claude-code:<session>").
 * - `unit` — the business unit the work is for.
 * - `role` — the role the agent was acting in.
 */
export interface Principal {
	// `| undefined` so a parsed wire object (zod infers `string | undefined`) is
	// assignable under exactOptionalPropertyTypes; `capturePrincipal` drops it.
	readonly id?: string | undefined;
	readonly type?: string | undefined;
	readonly origin?: string | undefined;
	readonly unit?: string | undefined;
	readonly role?: string | undefined;
}

/** The principal's fields, in record order. */
export const PRINCIPAL_FIELDS = ["id", "type", "origin", "unit", "role"] as const;

/** 1–128 characters of `[A-Za-z0-9._:-]`: safe in a log line, a path segment and a URL. */
export const PRINCIPAL_FIELD_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Why `value` is not a valid principal field, or `undefined` when it is. One rule,
 * shared by the governor and by any wire that accepts a principal.
 */
export function principalFieldRefusal(value: unknown): string | undefined {
	if (typeof value !== "string") return "must be a string";
	if (!PRINCIPAL_FIELD_PATTERN.test(value)) {
		return "must be 1-128 characters of [A-Za-z0-9._:-]";
	}
	return undefined;
}

/**
 * Capture a caller-supplied principal ONCE.
 *
 * Each field is read exactly once and the result is rebuilt from those reads and
 * frozen, so a getter, a later mutation of the caller's object, or an extra key can
 * never reach a record. `undefined`, or an object with no fields set, is "no
 * principal" and returns `undefined`. Anything invalid throws a `TypeError` —
 * callers capture before any I/O, so a bad principal is refused before money moves.
 */
export function capturePrincipal(input: unknown): Principal | undefined {
	if (input === undefined) return undefined;
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new TypeError("principal must be an object");
	}
	const source = input as Record<string, unknown>;
	const captured: { id?: string; type?: string; origin?: string; unit?: string; role?: string } =
		{};
	for (const field of PRINCIPAL_FIELDS) {
		const value = source[field];
		if (value === undefined) continue;
		const refusal = principalFieldRefusal(value);
		if (refusal !== undefined) throw new TypeError(`principal.${field} ${refusal}`);
		captured[field] = value as string;
	}
	return Object.keys(captured).length === 0 ? undefined : Object.freeze(captured);
}

/** The `user_data` tags a principal puts on its call's ledger transfers. Zero = no tag. */
export interface PrincipalLedgerTags {
	/** `user_data_128`: the agent (`id`). */
	readonly userData128: bigint;
	/** `user_data_64`: the business unit (`unit`). */
	readonly userData64: bigint;
	/** `user_data_32`: the role (`role`). */
	readonly userData32: number;
}

const LEDGER_TAG_DOMAIN = "usertrust/ledger-tag/v1\n";

/**
 * A field's tag: the first `bytes` bytes (big-endian) of
 * SHA-256(`usertrust/ledger-tag/v1\n` ‖ dimension ‖ `\n` ‖ value), never zero.
 *
 * TigerBeetle reads a zero `user_data` as "absent" — on a post/void it inherits
 * the pending transfer's value, and a zero query filter is disabled — so a digest
 * that truncates to zero is mapped to 1. The tag is an INDEX, not an identity:
 * the label itself is in the audit chain, and a ledger roll-up by tag is a
 * candidate set to confirm there (a 32-bit role tag is the field most exposed to
 * collisions).
 */
export function ledgerTag(
	dimension: "agent" | "unit" | "role",
	value: string,
	bytes: 4 | 8 | 16,
): bigint {
	const digest = createHash("sha256")
		.update(`${LEDGER_TAG_DOMAIN}${dimension}\n${value}`, "utf8")
		.digest();
	const tag = BigInt(`0x${digest.subarray(0, bytes).toString("hex")}`);
	return tag === 0n ? 1n : tag;
}

/**
 * The ledger tags for a captured principal: `id` → `user_data_128`, `unit` →
 * `user_data_64`, `role` → `user_data_32`; an absent field (or principal) is 0.
 * `type` and `origin` stay in the audit chain only — the three native slots go to the three
 * roll-up dimensions. Query with TigerBeetle's `query_transfers`, filtering on
 * the same values (`principalLedgerTags({ unit: "acme" }).userData64`).
 */
export function principalLedgerTags(principal: Principal | undefined): PrincipalLedgerTags {
	return {
		userData128: principal?.id === undefined ? 0n : ledgerTag("agent", principal.id, 16),
		userData64: principal?.unit === undefined ? 0n : ledgerTag("unit", principal.unit, 8),
		userData32: principal?.role === undefined ? 0 : Number(ledgerTag("role", principal.role, 4)),
	};
}
