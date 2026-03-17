// @usertools/govern — AI Financial Governance SDK

// ── Shared primitives ──
export { tbId, governId, fnv1a32 } from "./shared/ids.js";
export {
	InsufficientBalanceError,
	PolicyDeniedError,
	AccountNotFoundError,
	IdempotencyConflictError,
	LedgerUnavailableError,
	AuditDegradedError,
	VaultNotInitializedError,
} from "./shared/errors.js";
export {
	GovernConfigSchema,
	type GovernConfig,
	type GovernanceReceipt,
	type GovernedResponse,
	type PolicyEffect,
	type PolicyEnforcement,
	type PolicySeverity,
	type PolicyRule,
	type FieldOperator,
	type FieldCondition,
	type AuditEvent,
	type BoardDecision,
	type ConcernType,
	type DirectorVote,
	type LLMClientKind,
} from "./shared/types.js";
export {
	GENESIS_HASH,
	VAULT_DIR,
	AUDIT_DIR,
	RECEIPT_VERSION,
	DEFAULT_HOLD_TTL_MS,
	DEFAULT_BUDGET,
} from "./shared/constants.js";
