// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// usertrust — AI Financial Governance SDK

// Core
export { trust } from "./govern.js";
export type { TrustOpts, TrustedClient } from "./govern.js";

// Config
export { loadConfig, defineConfig } from "./config.js";

// Types
export type {
	TrustedResponse,
	TrustReceipt,
	TrustConfig,
	PolicyRule,
	FieldCondition,
	BoardDecision,
	AuditEvent,
	LLMClientKind,
} from "./shared/types.js";

// Errors
export {
	InsufficientBalanceError,
	PolicyDeniedError,
	LedgerUnavailableError,
	AuditDegradedError,
	VaultNotInitializedError,
} from "./shared/errors.js";
