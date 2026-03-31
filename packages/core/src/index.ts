// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// usertrust — AI Financial Governance SDK

// Core
export { trust } from "./govern.js";
export type { TrustOpts, TrustedClient } from "./govern.js";

// Headless governance (non-SDK integrations)
export { createGovernor } from "./headless.js";
export type { Governor, Authorization, AuthorizeParams, SettleParams } from "./headless.js";

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
	ActionKind,
	ActionDescriptor,
	GovernedActionResult,
	InjectionDetection,
	CanaryToken,
	SkillPermission,
	SkillManifest,
	SkillVerification,
} from "./shared/types.js";

// Injection detection
export { detectInjection } from "./policy/injection.js";
export { generateCanary, injectCanary, detectCanaryLeak } from "./policy/canary.js";

// Supply Chain
export { validateManifest, createUnsignedManifest, hashManifest } from "./supply-chain/manifest.js";
export { generateKeyPair, signManifest, verifySignature } from "./supply-chain/sign.js";
export { checkPermissions, enforceSkillLoad } from "./supply-chain/permissions.js";

// Errors
export {
	InsufficientBalanceError,
	PolicyDeniedError,
	LedgerUnavailableError,
	AuditDegradedError,
	VaultNotInitializedError,
	SkillVerificationError,
} from "./shared/errors.js";
