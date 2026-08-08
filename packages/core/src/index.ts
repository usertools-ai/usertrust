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
// Attribution — `withCostCenter(cc, fn)` routes every governed call `fn` makes to a
// cost-center envelope via `node:async_hooks` `AsyncLocalStorage`, from code structure
// rather than request content. `getCurrentCostCenter` stays module-internal (D8): only
// `govern.ts`/`headless.ts` read it, at exactly one point per call.
export { withCostCenter } from "./budget/attribution.js";
export type { BudgetContext, EnvelopeDescriptor, EnvelopeStatus } from "./budget/context.js";
// The scarcity READ API — an agent's own pull-side view across every envelope it
// holds, in one ledger round trip. See the module doc comment for how this differs
// from `getBudgetStatus` (batched, and never a per-envelope registry read) and for
// the observational (never verifier-derivable) contract its numbers carry.
export { budgetContext } from "./budget/context.js";
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
// The ledger client is the required first argument of every budget entry point
// above. Without it at the root those functions can be imported but never
// called: the argument is unnameable and unconstructible outside this package.
export { TrustTBClient } from "./ledger/client.js";
export type { ModelRates, RateResolution } from "./ledger/pricing.js";
// Pricing
export {
	estimateCost,
	estimateInputTokens,
	getModelRates,
	PRICING_TABLE_VERSION,
	resolveAppliedRates,
	resolveRates,
} from "./ledger/pricing.js";
// Usage normalization (spec D2/D5): the one place provider usage becomes the
// four-tier disjoint snapshot that both cost and record emission derive from.
export type { NormalizedUsage, RawUsageCandidate, UsageWireShape } from "./ledger/usage.js";
export {
	fromAnthropicUsage,
	fromGeminiUsage,
	fromOpenAICompletionsUsage,
	fromOpenAIResponsesUsage,
	fromProviderResponse,
	publishableUsage,
	sanitizeUsage,
} from "./ledger/usage.js";
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
// The AUTHORITATIVE parent-id door, exported so an integration that validates its
// own operator config refuses exactly what the ledger doors refuse — charset AND
// the `::` quarantine, with the reason each door already prints. A copy of the
// pattern outside this package is a rule that drifts silently: it would accept an
// id `createGovernor()` then rejects, or (worse) admit a `::` parent whose account
// derivation lands on stranded pre-v3 cost-center money.
export { parentUserIdRefusal } from "./shared/ids.js";
// Types
export type {
	ActionDescriptor,
	ActionKind,
	AppliedRates,
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
	ReceiptUsage,
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
