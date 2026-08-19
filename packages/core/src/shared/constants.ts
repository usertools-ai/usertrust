// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
export const VAULT_DIR = ".usertrust";
export const AUDIT_DIR = "audit";
export const RECEIPT_VERSION = 3;
export const DEFAULT_HOLD_TTL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Deadline for the TigerBeetle handshake that builds the funded holding wallet.
 *
 * Lives here rather than as a schema `.default()` because `TrustConfig` is the
 * schema's inferred OUTPUT and is publicly exported: a defaulted field becomes
 * REQUIRED for every TypeScript consumer, so adding one breaks existing
 * `tigerbeetle: { addresses, clusterId }` literals with TS2741 instead of
 * defaulting them. The field is optional and this is where the default lives.
 *
 * 3s because the deadline is only useful if its error OUTRUNS THE CALLER —
 * usertrust-claude-code aborts its HTTP request at 5s, and usertrust-server bounds
 * a request at 4s.
 */
export const DEFAULT_TB_CONNECT_TIMEOUT_MS = 3_000;
export const DEFAULT_BUDGET = 50_000;
