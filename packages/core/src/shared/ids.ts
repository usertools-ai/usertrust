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
 * ambiguous.
 */
export const PARENT_USER_ID_PATTERN = /^[a-zA-Z0-9._@:-]{1,128}$/;
export const COST_CENTER_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

/** FNV-1a 32-bit hash */
export function fnv1a32(str: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}
