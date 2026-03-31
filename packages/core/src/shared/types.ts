// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { z } from "zod";

// ── Trust Receipt ──
export interface TrustReceipt {
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
	/** Whether cost came from provider-reported usage or the pre-call estimate. */
	usageSource?: "provider" | "estimated";
	/** Number of chunks delivered to the consumer (streaming calls only). */
	chunksDelivered?: number;
	/** Action kind for governed non-LLM actions. Absent for LLM calls (backward compat). */
	actionKind?: ActionKind;
}

// ── TrustedResponse — returned by every governed LLM call ──
export interface TrustedResponse<T> {
	response: T;
	receipt: TrustReceipt;
}

// ── Config schema ──
export const TrustConfigSchema = z.object({
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

export type TrustConfig = z.infer<typeof TrustConfigSchema>;

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

// ── Action Governance types ──

/** Extensible union for governed action types. */
export type ActionKind = "llm_call" | "tool_use" | "file_access" | "shell_command" | "api_request";

/** Descriptor for a governed action. */
export interface ActionDescriptor {
	/** The kind of action being governed. */
	kind: ActionKind;
	/** Human-readable name (e.g., "file_read", "curl", tool name). */
	name: string;
	/** Estimated cost in usertokens. Required for budget enforcement. */
	cost: number;
	/** Arbitrary parameters for policy evaluation and audit logging. */
	params?: Record<string, unknown>;
	/** Actor identity (defaults to "local"). */
	actor?: string;
}

/** Result wrapper for governed actions. */
export interface GovernedActionResult<T> {
	result: T;
	receipt: TrustReceipt;
}
