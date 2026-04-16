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
	FieldOperator,
	PolicyEffect,
	PolicyEnforcement,
	PolicySeverity,
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
	CredentialScope,
	CredentialEntry,
	CredentialAccessResult,
} from "./shared/types.js";

// Injection detection
export { detectInjection } from "./policy/injection.js";
export { generateCanary, injectCanary, detectCanaryLeak } from "./policy/canary.js";

// Supply Chain
export { validateManifest, createUnsignedManifest, hashManifest } from "./supply-chain/manifest.js";
export { generateKeyPair, signManifest, verifySignature } from "./supply-chain/sign.js";
export { checkPermissions, enforceSkillLoad } from "./supply-chain/permissions.js";

// Credential Vault
export { createVaultStore } from "./vault/store.js";
export type { VaultStore } from "./vault/store.js";
export { checkScope } from "./vault/scope.js";

// Errors
export {
	InsufficientBalanceError,
	PolicyDeniedError,
	AccountNotFoundError,
	IdempotencyConflictError,
	LedgerUnavailableError,
	AuditDegradedError,
	VaultNotInitializedError,
	SkillVerificationError,
	VaultKeyMissingError,
	CredentialAccessDeniedError,
	AnomalyError,
} from "./shared/errors.js";

// Streaming
export type { GovernedStream } from "./streaming.js";

// PII detection
export { detectPII } from "./policy/pii.js";
export type { PIIDetection } from "./policy/pii.js";

// Pattern memory
export { hashPrompt, recordPattern, suggestModel, getPatternStats } from "./memory/patterns.js";

// Merkle proofs
export {
	buildMerkleTree,
	generateInclusionProof,
	verifyInclusionProof,
	generateConsistencyProof,
	verifyConsistencyProof,
	hashLeaf,
	hashInternal,
} from "./audit/merkle.js";
export type {
	MerkleInclusionProof,
	MerkleConsistencyProof,
	MerkleSibling,
} from "./audit/merkle.js";

// Pricing
export { getModelRates, estimateCost, estimateInputTokens } from "./ledger/pricing.js";
export type { ModelRates } from "./ledger/pricing.js";

// Board
export { createBoard } from "./board/board.js";
export type { BoardStats, BoardReviewResult } from "./board/board.js";

// Circuit breaker
export { CircuitBreaker, CircuitBreakerRegistry, CircuitOpenError } from "./resilience/circuit.js";
export type { CircuitBreakerSnapshot } from "./resilience/circuit.js";

// Streaming anomaly governance
export { createAnomalyDetector, resolveAnomalyConfig } from "./anomaly/detector.js";
export type { AnomalyDetector } from "./anomaly/detector.js";
export type {
	AnomalyChunkEvent,
	AnomalyConfig,
	AnomalyDetectorOptions,
	AnomalyDetectorState,
	AnomalyEvent,
	AnomalyInjectionEvent,
	AnomalyKind,
	AnomalyVerdict,
	InjectionCascadeConfig,
	ResolvedAnomalyConfig,
	SpendVelocityConfig,
	TokenRateConfig,
} from "./anomaly/types.js";
