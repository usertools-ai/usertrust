// usertrust — AI Financial Governance SDK

// Core
export { trust } from "./govern.js";
export type { TrustOpts, GovernedClient } from "./govern.js";

// Config
export { loadConfig, defineConfig } from "./config.js";

// Types
export type {
	GovernedResponse,
	GovernanceReceipt,
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
