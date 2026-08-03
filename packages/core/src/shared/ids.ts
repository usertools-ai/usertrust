// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { randomBytes } from "node:crypto";

/** Generate a u128 bigint ID for TigerBeetle (time-based + random) */
export function tbId(): bigint {
	const buf = randomBytes(16);
	const now = BigInt(Date.now());
	buf[0] = Number((now >> 40n) & 0xffn);
	buf[1] = Number((now >> 32n) & 0xffn);
	buf[2] = Number((now >> 24n) & 0xffn);
	buf[3] = Number((now >> 16n) & 0xffn);
	buf[4] = Number((now >> 8n) & 0xffn);
	buf[5] = Number(now & 0xffn);
	let id = 0n;
	for (let i = 0; i < 16; i++) {
		id = (id << 8n) | BigInt(buf[i] as number);
	}
	return id;
}

/** Generate a string ID for trust records */
export function trustId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/**
 * The charsets a cost center's two identity parts must match — the AUTHORITATIVE
 * copies; `cli/budget.ts` carries a deliberate display-side mirror, kept honest by a
 * source-parity test. They live here, beside `tbId`, because both the ledger door
 * (`ledger/client.ts`) and the budget path (`budget/allocation.ts`) validate against
 * them and neither may import the other.
 *
 * Both exclude whitespace, control characters, and ANSI escapes, which keeps the
 * derived display label safe to embed in an audit event and in terminal output.
 *
 * `COST_CENTER_PATTERN` is colon-free, and that is a security boundary rather than
 * input cosmetics: it is what keeps the `parent::costCenter` display label injective —
 * the cost center is the label's maximal colon-free suffix. `PARENT_USER_ID_PATTERN`
 * admits `:` (issue #64) because account ids come from the length-prefixed tuple hash
 * `TrustTBClient.deriveCostCenterAccountId`, which no colon on either side can make
 * ambiguous. A SINGLE colon is legal everywhere a parent id is — `acct:123`,
 * `acme:eu:prod` — which is what #64 actually asked for. `::` is not; see below.
 */
export const PARENT_USER_ID_PATTERN = /^[a-zA-Z0-9._@:-]{1,128}$/;
export const COST_CENTER_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * The pre-v3 cost-center separator, QUARANTINED out of every id that hashes into the
 * `wallet:` namespace — ordinary wallet ids, escrow labels, and parent ids alike.
 *
 * This is not the retired derivation reservation. The tuple hash made that obsolete:
 * cost-center accounts now live in a domain-separated preimage space no single string
 * can reach, so `::` carries no meaning for any id v3 itself derives. It is refused
 * because of what a v2.x cluster left behind.
 *
 * *Prevents:* on a cluster upgraded from v2.x, a cost center that was not reclaimed
 * before the upgrade still occupies `deriveAccountId("parent::cc")` — the account the
 * retired joined-string derivation funded — carrying `CODE_USER_WALLET` and the exact
 * flags an ordinary wallet carries. `createUserWallet("parent::cc")` (or
 * `ensureEscrowAccount` on the same label) therefore hashes onto it, TigerBeetle
 * answers `exists` rather than `exists_with_different_flags`, the door reads that as
 * success per the `exists` IS SUCCESS invariant, and the new wallet silently ADOPTS the
 * stranded legacy balance under a different owner's name. Nothing errors, on either
 * side.
 *
 * The documented reclaim-before-upgrade migration does not fully close this on its own:
 * a hold that was pending at upgrade time and is voided afterwards returns its funds to
 * the legacy account, re-stranding a balance in an account a clean migration had already
 * emptied. Only refusing the names keeps them unadoptable.
 *
 * The refusal costs no caller anything: `::` was rejected at these same doors on every
 * released version before v3, so no legal wallet id or escrow label has ever contained
 * it.
 */
export const LEGACY_COST_CENTER_SEPARATOR = "::";

/**
 * The AUTHORITATIVE parent-id rule: matches `PARENT_USER_ID_PATTERN` **and** does not
 * contain {@link LEGACY_COST_CENTER_SEPARATOR}. Returns `null` when the id is legal,
 * otherwise the reason — so each door can prefix it with its own wording while the rule
 * itself lives in exactly one place.
 *
 * The two reasons are deliberately distinct strings. An operator told only "must match
 * `^[a-zA-Z0-9._@:-]{1,128}$`" after passing `acme::billing` reads a charset that plainly
 * admits their id and concludes the validator is broken; the quarantine has to name
 * itself.
 */
export function parentUserIdRefusal(value: unknown): string | null {
	if (typeof value !== "string" || !PARENT_USER_ID_PATTERN.test(value)) {
		return `must match ${PARENT_USER_ID_PATTERN.source}`;
	}
	if (value.includes(LEGACY_COST_CENTER_SEPARATOR)) {
		return `must not contain "${LEGACY_COST_CENTER_SEPARATOR}" (reserved for pre-v3 cost-center accounts)`;
	}
	return null;
}

/** FNV-1a 32-bit hash */
export function fnv1a32(str: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}
