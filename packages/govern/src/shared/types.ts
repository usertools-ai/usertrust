import { z } from "zod";

// ── Governance Receipt ──
export interface GovernanceReceipt {
	transferId: string;
	cost: number;
	budgetRemaining: number;
	auditHash: string;
	chainPath: string;
	receiptUrl: string | null; // null in local mode
	settled: boolean;
	model: string;
	provider: string;
	timestamp: string;
	/** Present and true when the audit chain write failed (failure mode 15.3). */
	auditDegraded?: boolean;
}

// ── GovernedResponse — returned by every governed LLM call ──
export interface GovernedResponse<T> {
	response: T;
	governance: GovernanceReceipt;
}

// ── Config schema ──
export const GovernConfigSchema = z.object({
	budget: z.number().int().positive(),
	tier: z.enum(["free", "mini", "pro", "mega", "ultra"]).default("mini"),
	proxy: z.string().url().optional(),
	key: z.string().optional(),
	policies: z.string().default("./policies/default.yml"),
	pii: z.enum(["redact", "warn", "block", "off"]).default("warn"),
	board: z
		.object({
			enabled: z.boolean().default(false),
			vetoThreshold: z.enum(["low", "medium", "high", "critical"]).default("high"),
		})
		.default({}),
	circuitBreaker: z
		.object({
			failureThreshold: z.number().int().default(5),
			resetTimeout: z.number().int().default(60_000),
		})
		.default({}),
	patterns: z
		.object({
			enabled: z.boolean().default(true),
			feedProxy: z.boolean().default(false),
		})
		.default({}),
	audit: z
		.object({
			rotation: z.enum(["daily", "weekly", "none"]).default("daily"),
			indexLimit: z.number().int().default(10_000),
		})
		.default({}),
	tigerbeetle: z
		.object({
			addresses: z.array(z.string()).default(["127.0.0.1:3001"]),
			clusterId: z.number().int().nonnegative().default(0),
		})
		.default({}),
});

export type GovernConfig = z.infer<typeof GovernConfigSchema>;

// ── Policy types (from Turf) ──
export type PolicyEffect = "deny" | "warn";
export type PolicyEnforcement = "hard" | "soft";
export type PolicySeverity = "critical" | "high" | "medium" | "low" | "info";

export interface PolicyRule {
	name: string;
	effect: PolicyEffect;
	enforcement: PolicyEnforcement;
	severity?: PolicySeverity;
	conditions: FieldCondition[];
}

export type FieldOperator =
	| "exists"
	| "not_exists"
	| "eq"
	| "neq"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "in"
	| "not_in"
	| "contains"
	| "regex";

export interface FieldCondition {
	field: string;
	operator: FieldOperator;
	value?: unknown;
}

// ── Audit types ──
export interface AuditEvent {
	id: string;
	timestamp: string;
	previousHash: string;
	hash: string;
	kind: string;
	actor: string;
	data: Record<string, unknown>;
}

// ── Board types (from Turf) ──
export type BoardDecision = "approved" | "blocked" | "escalated";
export type ConcernType =
	| "hallucination"
	| "bias"
	| "safety"
	| "scope_creep"
	| "resource_abuse"
	| "policy_violation";
export type DirectorVote = "approve" | "veto" | "abstain";

// ── LLM Client detection ──
export type LLMClientKind = "anthropic" | "openai" | "google";
