// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// usertrust — AI Financial Governance SDK

export type { AnomalyDetector } from "./anomaly/detector.js";
// Streaming anomaly governance
export { createAnomalyDetector, resolveAnomalyConfig } from "./anomaly/detector.js";
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
export type {
	MerkleConsistencyProof,
	MerkleInclusionProof,
	MerkleSibling,
} from "./audit/merkle.js";
// Merkle proofs
export {
	buildMerkleTree,
	generateConsistencyProof,
	generateInclusionProof,
	hashInternal,
	hashLeaf,
	verifyConsistencyProof,
	verifyInclusionProof,
} from "./audit/merkle.js";
export type { ChainIntegrity, PersistedAuditEvent } from "./audit/read.js";
// Vault reading (shared by CLI + usertrust-ui)
export { deriveChainIntegrity, loadBudgetConfig, readLedgerEvents } from "./audit/read.js";
export type { ChainVerificationResult, VaultVerificationResult } from "./audit/verify.js";
export { verifyChain, verifyVault } from "./audit/verify.js";
export type { BoardReviewResult, BoardStats } from "./board/board.js";
// Board
export { createBoard } from "./board/board.js";
export type {
	AllocateResult,
	BudgetAuditWriter,
	BudgetStatus,
	ReclaimResult,
} from "./budget/allocation.js";
// Agent budgets — delegate a bounded allocation to a named cost center, reclaim
// what it did not spend, and read its runway. `getBudgetStatus` is the read an
// agent framework wires as a `get_budget()` tool; it is a plain async function
// with no framework coupling. Neither allocate nor reclaim is safe to
// blind-retry — see the module doc comment.
export {
	allocateBudget,
	costCenterUserId,
	getBudgetStatus,
	reclaimBudget,
} from "./budget/allocation.js";
export type { Runway, RunwayInput } from "./budget/runway.js";
// `runwayHours` is the safe derivation of a `budgetRunwayHours` policy field —
// the naive `(projectedExhaustionMs - nowMs) / 3.6e6` turns "not projectable"
// into a large negative number and fires escalation rules on an idle budget.
export { computeRunway, runwayHours } from "./budget/runway.js";
// Config
export { defineConfig, loadConfig } from "./config.js";
// Endpoint classification
export { classifyEndpoint } from "./detect.js";
export type { ExportResult } from "./export/markdown.js";
// Markdown / Obsidian export
export { exportMarkdown } from "./export/markdown.js";
export type { TrustedClient, TrustOpts } from "./govern.js";
// Core
export { trust } from "./govern.js";
export type { Authorization, AuthorizeParams, Governor, SettleParams } from "./headless.js";
// Headless governance (non-SDK integrations)
export { createGovernor } from "./headless.js";
export type { ModelRates, RateResolution } from "./ledger/pricing.js";
// Pricing
export {
	estimateCost,
	estimateInputTokens,
	getModelRates,
	resolveRates,
} from "./ledger/pricing.js";
// Pattern memory
export { getPatternStats, hashPrompt, recordPattern, suggestModel } from "./memory/patterns.js";
export { detectCanaryLeak, generateCanary, injectCanary } from "./policy/canary.js";
// Injection detection
export { detectInjection } from "./policy/injection.js";
export type { PIIDetection } from "./policy/pii.js";
// PII detection
export { detectPII } from "./policy/pii.js";
export type { CircuitBreakerSnapshot } from "./resilience/circuit.js";
// Circuit breaker
export { CircuitBreaker, CircuitBreakerRegistry, CircuitOpenError } from "./resilience/circuit.js";
export { VAULT_DIR } from "./shared/constants.js";
// Errors
export {
	AccountNotFoundError,
	AnomalyError,
	AuditDegradedError,
	CredentialAccessDeniedError,
	IdempotencyConflictError,
	InsufficientBalanceError,
	LedgerUnavailableError,
	PolicyDeniedError,
	SkillVerificationError,
	VaultKeyMissingError,
	VaultNotInitializedError,
} from "./shared/errors.js";
// Types
export type {
	ActionDescriptor,
	ActionKind,
	AuditEvent,
	BoardDecision,
	CanaryToken,
	CostBasis,
	CredentialAccessResult,
	CredentialEntry,
	CredentialScope,
	EndpointClass,
	EndpointInfo,
	FieldCondition,
	FieldOperator,
	GovernedActionResult,
	InjectionDetection,
	LLMClientKind,
	LocalRuntime,
	PolicyEffect,
	PolicyEnforcement,
	PolicyRule,
	PolicySeverity,
	RateSource,
	SkillManifest,
	SkillPermission,
	SkillVerification,
	TrustConfig,
	TrustedResponse,
	TrustReceipt,
} from "./shared/types.js";
// Streaming
export type { GovernedStream } from "./streaming.js";
// Supply Chain
export { createUnsignedManifest, hashManifest, validateManifest } from "./supply-chain/manifest.js";
export { checkPermissions, enforceSkillLoad } from "./supply-chain/permissions.js";
export { generateKeyPair, signManifest, verifySignature } from "./supply-chain/sign.js";
export { checkScope } from "./vault/scope.js";
export type { VaultStore } from "./vault/store.js";
// Credential Vault
export { createVaultStore } from "./vault/store.js";
