// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { z } from "zod";
import { parentUserIdRefusal } from "./ids.js";

// ── Endpoint classification (M2 local-model governance) ──

/** Settlement scope of an endpoint: local (self-hosted) or cloud (metered provider). */
export type EndpointClass = "local" | "cloud";

/** Best-effort runtime label for a local endpoint (receipt/UX metadata only). */
export type LocalRuntime = "ollama" | "vllm" | "lmstudio" | "openai-compat" | "unknown";

/** Result of endpoint classification — selects the settlement regime for a call. */
export interface EndpointInfo {
	class: EndpointClass;
	runtime: LocalRuntime;
	baseURL?: string | undefined;
}

/** Denomination of a settled cost: real-dollar proxy or nominal bookkeeping units. */
export type CostBasis = "usd-proxy" | "nominal";

/** Where the applied rates came from during resolution. */
export type RateSource = "table" | "custom" | "local-model" | "local-default" | "fallback";

/**
 * The four RESOLVED per-1k rates a settle was metered with (spec D5).
 *
 * "Resolved" is the load-bearing word: these are the rates AFTER the D1
 * fallback, so an absent cache tier appears here as `inputPer1k`, never as
 * `undefined` and never as 0. Publishing the raw `ModelRates` instead would
 * hand an auditor a hole in exactly the tiers the fallback makes non-zero, and
 * their recompute would understate the bill.
 *
 * Together with {@link ReceiptUsage} this is what makes the narrowed
 * reconciliation claim checkable: `ceil(sum(counts x rates / 1000))`, floored
 * at 1, reproduces `TrustReceipt.cost` exactly — from the record alone, with no
 * access to the pricing table, the config, or this codebase.
 */
export interface AppliedRates {
	inputPer1k: number;
	outputPer1k: number;
	cacheReadPer1k: number;
	cacheWritePer1k: number;
}

/**
 * The four-tier DISJOINT token split a settle was metered from (spec D5).
 *
 * Sanitized by construction — every count is a finite integer >= 0 — because
 * this is the object that reaches audit canonicalization, which throws on
 * NaN/Infinity. Disjoint means `inputTokens` is FRESH input only: cached reads
 * and cache writes are separate tiers, and the four sum to the call's billable
 * tokens with nothing double-counted.
 *
 * Present on a record only when the usage was provider-reported. See
 * `TrustReceipt.usage`.
 */
export interface ReceiptUsage {
	/** Fresh (non-cached) prompt tokens. */
	inputTokens: number;
	/** Completion tokens, including provider-billed thinking tokens. */
	outputTokens: number;
	/** Cache-hit prompt tokens. */
	cacheReadTokens: number;
	/** Cache-creation prompt tokens. */
	cacheWriteTokens: number;
}

// ── Trust Receipt ──
export interface TrustReceipt {
	transferId: string;
	cost: number;
	/**
	 * Ledger amount actually POSTED when it differs from `cost`: the settle was
	 * capped at the reserved hold (`cost - postedCost` = the shortfall, audited as
	 * `settlement_shortfall`). Absent when the post matched `cost`. `cost` stays
	 * the true metered cost — the receipt, hash chain, and ledger reconcile
	 * through this field rather than by overwriting any of them.
	 */
	postedCost?: number;
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
	/**
	 * The four-tier disjoint token split this cost was metered from (D5).
	 *
	 * PRESENT IFF `usageSource === "provider"`. An estimated settle has no
	 * reported counts, and a four-tier block full of fabricated zeros would
	 * invite an auditor to "recompute" a cost that was never derived from
	 * counts at all — so it is omitted outright, never zero-filled.
	 *
	 * With `pricing.appliedRates` this is the whole reconciliation surface:
	 * `ceil(sum(counts x rates / 1000))` floored at 1 equals `cost`.
	 */
	usage?: ReceiptUsage;
	/** Number of chunks delivered to the consumer (streaming calls only). */
	chunksDelivered?: number;
	/** Action kind for governed non-LLM actions. Absent for LLM calls (backward compat). */
	actionKind?: ActionKind;
	/** Endpoint classification for this call. Absent on pre-M2 receipts. */
	endpoint?: { class: EndpointClass; runtime: LocalRuntime };
	/**
	 * Metering provenance: denomination and rate origin of the settled cost.
	 *
	 * `rateSource` says WHERE the rates came from. WHAT they were lives in the
	 * sibling {@link TrustReceipt.pricing} block, deliberately NOT here — see the
	 * note there for why this object cannot grow.
	 */
	meter?: {
		costBasis: CostBasis;
		rateSource: RateSource;
		computeMs?: number;
	};
	/**
	 * The rate side of the reconciliation surface (D5): the four RESOLVED per-1k
	 * rates this cost was metered with, and the pricing-table version they came
	 * from. With {@link TrustReceipt.usage} it is everything an auditor needs —
	 * `ceil(sum(counts x rates / 1000))` floored at 1 reproduces `cost` exactly,
	 * from the record alone.
	 *
	 * WHY THIS IS A TOP-LEVEL BLOCK AND NOT PART OF `meter` (Codex PR-85 P1-1).
	 * The published `receipt.v1.schema.json` sets `additionalProperties: false`
	 * on `meter` while leaving the receipt ROOT open (`additionalProperties:
	 * true`). Widening `meter` would therefore make every v1 validator REJECT
	 * every new receipt, breaking the site's "v1 stays frozen and keeps meaning
	 * the same thing" promise; adding a new root-level object keeps v1
	 * validators green and loses nothing, because recomputability only needs the
	 * two halves to be findable, not adjacent. Anything else added later must
	 * clear the same bar: the root is extensible, `meter` is not.
	 *
	 * Optional for backward compatibility with pre-D5 receipts and with non-LLM
	 * action receipts (which meter no tokens at all), but every LLM settle emits
	 * it. When present, BOTH fields are present.
	 *
	 * FROZEN (Codex PR-85 P1-2). `appliedRates` is deep-immutable and is this
	 * receipt's own copy: a caller that mutates what it was handed cannot make
	 * the rates recorded in the audit chain diverge from the rates the money was
	 * computed with.
	 */
	pricing?: {
		/** The four resolved per-1k rates the cost was computed with. */
		appliedRates: AppliedRates;
		/** Date-stamped version of the built-in pricing table (`PRICING_TABLE_VERSION`). */
		tableVersion: string;
	};
	/**
	 * Cost-center envelope snapshot — the PUSH half of visibility (the pull half is
	 * `budgetContext()`). Present only when the call ran inside a `withCostCenter`
	 * scope AND settled AND the post-settle ledger read answered.
	 *
	 * OBSERVATIONAL, NEVER AUTHORITATIVE (A8), and the same contract
	 * `budget/context.ts` documents: `remaining` is the envelope's ledger
	 * `available` READ AFTER this call settled, so it races every concurrent
	 * settlement against the same envelope by design. It is "what the envelope
	 * holds now", never "what this call cost" (that is `cost`) and never anything a
	 * verifier can recompute — it is not part of the hash chain and `packages/verify`
	 * never sees this shape.
	 *
	 * ABSENT is not an error signal: an unattributed call, an unsettled (estimated)
	 * stream handle, and a snapshot read that failed all omit it. The read is
	 * deliberately allowed to fail silently — a receipt is a report, and degrading a
	 * report must never unwind or re-decide money that already committed.
	 */
	budget?: {
		costCenter: string;
		remaining: number;
		/** Omitted when the scope carried no `allocated` metadata (D4). */
		fraction?: number;
	};
}

// ── TrustedResponse — returned by every governed LLM call ──
export interface TrustedResponse<T> {
	response: T;
	receipt: TrustReceipt;
}

// ── Config schema ──

/**
 * Per-1k-token rate tiers (usertokens). Shared by customRates and local.* rates,
 * and structurally the config-side mirror of `ModelRates` (ledger/pricing.ts).
 *
 * The two cache tiers are OPTIONAL and their absence is MEANINGFUL (D1): an
 * omitted tier is not free, it prices at `inputPer1k` inside `costFromRates`.
 * So they must stay `.optional()` with no default — a default of 0 would
 * zero-bill cache tokens, and z.object() is closed, so leaving them undeclared
 * silently STRIPS rates an operator wrote in usertrust.config.json (which is the
 * same zero-billing outcome one indirection away). `.nonnegative()` still admits
 * an explicit 0, which `costFromRates` honours as a deliberate override.
 */
const RateSchema = z.object({
	inputPer1k: z.number().finite().nonnegative(),
	outputPer1k: z.number().finite().nonnegative(),
	cacheReadPer1k: z.number().finite().nonnegative().optional(),
	cacheWritePer1k: z.number().finite().nonnegative().optional(),
});

export const TrustConfigSchema = z.object({
	budget: z.number().int().positive(),
	tier: z.enum(["free", "mini", "pro", "mega", "ultra"]).default("mini"),
	proxy: z.string().url().optional(),
	key: z.string().optional(),
	/**
	 * The parent half of the `(parentUserId, costCenter)` tuple every cost-center
	 * envelope account is derived from — this governor's ledger identity.
	 *
	 * OPTIONAL, and it must stay optional: a governor that never spends from an
	 * envelope needs no identity, and every config written before envelopes
	 * existed keeps parsing to exactly the same object it did before (no key
	 * materialises, no default is invented).
	 *
	 * Validated HERE, by the one authoritative rule `parentUserIdRefusal` — the
	 * same charset-plus-`::`-quarantine that `createCostCenterWallet` and
	 * `costCenterUserId` enforce at the ledger doors. Refusing at parse time is
	 * what keeps the refusal off the money path: a malformed identity surfaces
	 * when the operator writes it, not at the first attributed hold with a call
	 * already in flight and the caller believing governance came up clean.
	 *
	 * TRUSTED-OPERATOR input, on the same boundary as budget/customRates —
	 * whoever constructs a governor already holds the TigerBeetle client. Never
	 * derive it from end-user or request data: attribution that request content
	 * can steer is an agent relabelling its calls onto the fattest envelope.
	 */
	parentUserId: z
		.string()
		.superRefine((value, ctx) => {
			const refusal = parentUserIdRefusal(value);
			if (refusal !== null) {
				ctx.addIssue(`parentUserId ${refusal}`);
			}
		})
		.optional(),
	policies: z.string().default("./policies/default.yml"),
	pii: z.enum(["redact", "warn", "block", "off"]).default("warn"),
	injection: z.enum(["block", "warn", "off"]).default("warn"),
	board: z
		.object({
			enabled: z.boolean().default(false),
			vetoThreshold: z.enum(["low", "medium", "high", "critical"]).default("high"),
		})
		.prefault({}),
	circuitBreaker: z
		.object({
			failureThreshold: z.number().int().default(5),
			resetTimeout: z.number().int().default(60_000),
		})
		.prefault({}),
	patterns: z
		.object({
			enabled: z.boolean().default(true),
			feedProxy: z.boolean().default(false),
		})
		.prefault({}),
	audit: z
		.object({
			rotation: z.enum(["daily", "weekly", "none"]).default("daily"),
			indexLimit: z.number().int().default(10_000),
			// P3-AUDIT-FAILCLOSED: when true, a failed CRITICAL audit write aborts the
			// call (deny) instead of settling an unaudited spend. Default false keeps the
			// legacy fail-open behavior (degraded receipt, money still moves).
			failClosed: z.boolean().default(false),
		})
		.prefault({}),
	tigerbeetle: z
		.object({
			addresses: z.array(z.string()).default(["127.0.0.1:3001"]),
			clusterId: z.number().int().nonnegative().default(0),
		})
		.prefault({}),
	providers: z
		.array(
			z.object({
				name: z.string(),
				models: z.array(z.string()).default([]),
			}),
		)
		.default([]),
	pricing: z.enum(["recommended", "custom"]).default("recommended"),
	customRates: z.record(z.string(), RateSchema).optional(),
	/**
	 * Endpoint matchers consumed by classifyEndpoint(). First match wins.
	 * match forms: scheme URL ("http://gpu-box:8000", matched by origin),
	 * leading-star hostname suffix ("*.gpu.internal"), or bare hostname ("gpu-box").
	 */
	endpoints: z
		.array(
			z.object({
				match: z.string().min(1),
				class: z.enum(["local", "cloud"]).default("local"),
				runtime: z
					.enum(["ollama", "vllm", "lmstudio", "openai-compat", "unknown"])
					.default("unknown"),
			}),
		)
		.default([]),
	/** Local (zero-marginal-cost) settlement scope. */
	local: z
		.object({
			/** Loopback hosts (localhost/127.0.0.1/[::1]) classify as local without config. */
			autoDetectLoopback: z.boolean().default(true),
			/**
			 * Rate applied to any local-scope model with no local.models match. Default {0,0}:
			 * with the >=1 floor, every local call settles at exactly 1 nominal usertoken.
			 */
			defaultRate: RateSchema.default({ inputPer1k: 0, outputPer1k: 0 }),
			/**
			 * Denomination of local rates: "nominal" (bookkeeping units) or "amortized-usd"
			 * (operator's GPU-chargeback rate; 1 usertoken = $0.0001 as usual).
			 */
			rateClass: z.enum(["nominal", "amortized-usd"]).default("nominal"),
			/**
			 * Per-model local rates. Keys: exact model strings or trailing-* globs
			 * ("llama3.3*", "*"). Exact match beats glob; longest glob wins.
			 */
			models: z.record(z.string(), RateSchema).default({}),
			/** Inject stream_options:{include_usage:true} into local openai-kind streams. */
			injectUsageOptions: z.boolean().default(true),
		})
		.prefault({}),
	/**
	 * Cloud-scope policy when a model misses customRates, PRICING_TABLE, and prefix match.
	 * "fallback" = silent sonnet-class rate (legacy) · "warn" = same rate + one-time warn +
	 * receipt.meter.rateSource "fallback" · "deny" = PolicyDeniedError before the PENDING hold.
	 */
	unknownModelPolicy: z.enum(["fallback", "warn", "deny"]).default("warn"),
	supplyChain: z
		.object({
			// SC-3: fail-closed by default. A skill with no registered signing key
			// or a bad signature is rejected out of the box; operators opt out
			// explicitly by setting enabled:false.
			enabled: z.boolean().default(true),
			trustedPublishers: z.array(z.string()).default([]),
			// SC-1 trust anchor: publisher -> hex-encoded 32-byte Ed25519 public keys
			// the operator vouches for (array = rotation-friendly). Identity is anchored
			// by these keys, NOT by the key embedded in an attacker-controlled manifest.
			publisherKeys: z.record(z.string(), z.array(z.string().regex(/^[a-f0-9]{64}$/))).default({}),
			allowedPermissions: z
				.array(
					z.enum([
						"llm_call",
						"tool_use",
						"file_read",
						"file_write",
						"shell_command",
						"network_access",
						"credential_access",
					]),
				)
				.default(["llm_call", "tool_use", "file_read"]),
			requireSignature: z.boolean().default(true),
		})
		.prefault({}),
	vault: z
		.object({
			enabled: z.boolean().default(false),
			masterKeyEnv: z.string().default("USERTRUST_VAULT_KEY"),
			auditAccess: z.boolean().default(true),
			defaultScope: z
				.object({
					agents: z.array(z.string()).default([]),
					actions: z
						.array(z.enum(["llm_call", "tool_use", "file_access", "shell_command", "api_request"]))
						.default([]),
					expiresAt: z.string().datetime().nullable().default(null),
				})
				.prefault({}),
		})
		.prefault({}),
	anomaly: z
		.object({
			enabled: z.boolean().default(false),
			tokenRate: z
				.object({
					thresholdTokPerSec: z.number().positive().default(500),
					/** Local-scope threshold (fast local GPU inference legitimately exceeds 500). */
					localThresholdTokPerSec: z.number().positive().default(5000),
					/** Per-model threshold overrides. Keys: exact model or trailing-* glob. */
					perModel: z.record(z.string(), z.number().positive()).default({}),
					windowMs: z.number().int().positive().default(2_000),
					consecutiveWindows: z.number().int().positive().default(3),
				})
				.prefault({}),
			spendVelocity: z
				.object({
					thresholdDollarsPerMin: z.number().positive().default(1.0),
					/** Local-scope velocity threshold in nominal usertokens per minute. */
					localThresholdUsertokensPerMin: z.number().positive().default(10_000),
					windowMs: z.number().int().positive().default(10_000),
				})
				.prefault({}),
			injectionCascade: z
				.object({
					eventCount: z.number().int().positive().default(3),
					windowMs: z.number().int().positive().default(60_000),
				})
				.prefault({}),
			cooldownMs: z.number().int().nonnegative().default(30_000),
		})
		.prefault({}),
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

// ── Injection Detection types ──

/** Result of prompt injection detection scan. */
export interface InjectionDetection {
	/** Whether a prompt injection attempt was detected. */
	detected: boolean;
	/** Confidence score from 0.0 (clean) to 1.0 (certain injection). */
	score: number;
	/** Names of matched detection patterns (e.g., ["keyword_combo", "role_boundary"]). */
	patterns: string[];
	/** Dot-paths where injections were found (e.g., ["messages[0].content(keyword_combo)"]). */
	paths: string[];
}

/** Canary token for prompt leak detection. */
export interface CanaryToken {
	/** Random hex token (32 chars). */
	token: string;
	/** HTML comment marker embedding the token. */
	marker: string;
}

// ── Supply Chain types ──

/** Permission an agent skill can request. */
export type SkillPermission =
	| "llm_call"
	| "tool_use"
	| "file_read"
	| "file_write"
	| "shell_command"
	| "network_access"
	| "credential_access";

/** A signed skill manifest declaring identity, permissions, and integrity. */
export interface SkillManifest {
	/** Schema version for forward compatibility. */
	version: 1;
	/** Unique skill identifier (e.g., "acme/summarizer"). */
	id: string;
	/** Human-readable skill name. */
	name: string;
	/** Skill author or publisher. */
	publisher: string;
	/** Permissions the skill requires at runtime. */
	permissions: SkillPermission[];
	/** SHA-256 hash of the skill's entry point source code. */
	entryHash: string;
	/** ISO 8601 timestamp of when the manifest was signed. */
	signedAt: string;
	/** Ed25519 signature of the canonical manifest (hex-encoded). */
	signature: string;
	/** Ed25519 public key of the signer (hex-encoded). */
	publicKey: string;
}

/** Result of verifying a skill manifest. */
export interface SkillVerification {
	/** Whether the manifest signature is valid. */
	valid: boolean;
	/** Whether all declared permissions are allowed by policy. */
	permissionsAllowed: boolean;
	/** Permissions that were denied by policy. */
	deniedPermissions: SkillPermission[];
	/** SHA-256 hash of the manifest for audit inclusion. */
	manifestHash: string;
	/**
	 * Whether the loaded skill source bytes were re-hashed and matched the signed
	 * `entryHash` (SC-2). False when no source was supplied — an executor MUST treat
	 * `false` as "integrity unverified, do not execute".
	 */
	integrityVerified: boolean;
	/** Error message if verification failed. */
	error?: string;
}

export const SkillManifestSchema = z.object({
	version: z.literal(1),
	id: z.string().regex(/^[a-z0-9_-]+\/[a-z0-9_-]+$/, "Skill ID must be publisher/name format"),
	name: z.string().min(1).max(128),
	publisher: z.string().min(1).max(64),
	permissions: z.array(
		z.enum([
			"llm_call",
			"tool_use",
			"file_read",
			"file_write",
			"shell_command",
			"network_access",
			"credential_access",
		]),
	),
	entryHash: z.string().regex(/^[a-f0-9]{64}$/, "Must be a SHA-256 hex hash"),
	signedAt: z.string().datetime(),
	signature: z.string().regex(/^[a-f0-9]{128}$/, "Must be a hex-encoded 64-byte Ed25519 signature"),
	publicKey: z.string().regex(/^[a-f0-9]{64}$/, "Must be hex-encoded Ed25519 public key"),
});

// ── Credential Vault types ──

/** Scope constraining when/how a credential can be accessed. */
export interface CredentialScope {
	/** Agents allowed to access this credential (empty = all). */
	agents: string[];
	/** Action kinds allowed to use this credential (empty = all). */
	actions: ActionKind[];
	/** Expiration timestamp (ISO 8601). Null = no expiry. */
	expiresAt: string | null;
}

/** A stored credential entry (decrypted form). */
export interface CredentialEntry {
	/** Unique credential name (e.g., "OPENAI_API_KEY"). */
	name: string;
	/** The secret value. */
	value: string;
	/** Access scope constraints. */
	scope: CredentialScope;
	/** ISO 8601 timestamp when the credential was stored. */
	createdAt: string;
	/** ISO 8601 timestamp when the credential was last rotated. */
	rotatedAt: string;
}

/** Result of a credential access attempt. */
export interface CredentialAccessResult {
	/** Whether access was granted. */
	granted: boolean;
	/** The credential value (only present if granted). */
	value?: string;
	/** Reason for denial (only present if denied). */
	reason?: string;
}
