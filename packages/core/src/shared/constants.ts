// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
export const VAULT_DIR = ".usertrust";
export const AUDIT_DIR = "audit";
export const RECEIPT_VERSION = 3;
export const DEFAULT_HOLD_TTL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * The TigerBeetle pending `timeout` of every hold a governor's engine reserves
 * (`createTBEngine`, in govern.ts and headless.ts alike, passes it explicitly). The
 * ledger expires the hold on its own this long after creating it, whatever any
 * process remembers. A headless handle publishes it as `Authorization.holdTimeoutMs`,
 * a duration, and usertrust-server derives each hold's advertised remaining life
 * from it (`expiresInMs`). A client that decides a hold is abandoned must wait
 * longer than this.
 */
export const LEDGER_HOLD_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_BUDGET = 50_000;
