// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The correlation handle a governance denial carries back to the caller.
 *
 * A denial now writes a chain event (`policy_denied` / `ledger_rejected`), and
 * `auditEventHash` is that event's hash — the join between the exception a
 * caller logged and the record an auditor reads.
 *
 * The two fields answer DIFFERENT questions, and both are needed. A missing
 * `auditEventHash` alone is ambiguous: it is what an error built by hand, or
 * thrown by a version before this existed, also looks like. `auditDegraded`
 * separates "the append was attempted and failed" (dead-lettered, no chain
 * record) from "no append was ever attempted".
 */
export interface DenialAuditMetadata {
	/** Hash of the appended denial event; absent when the append did not land. */
	auditEventHash?: string | undefined;
	/** `true` when the append was attempted, failed, and was dead-lettered. */
	auditDegraded?: boolean | undefined;
}

export class InsufficientBalanceError extends Error {
	public readonly userId: string;
	public readonly required: number;
	public readonly available: number;
	public readonly hint: string;
	public readonly docsUrl: string;
	/** @see DenialAuditMetadata */
	public readonly auditEventHash?: string | undefined;
	/** @see DenialAuditMetadata */
	public readonly auditDegraded?: boolean | undefined;

	/**
	 * `hint` is overridable because the default advice is WRONG for a cost-center
	 * envelope: raising `trust({ budget })` funds the session holding wallet, which
	 * an attributed call never debits, so an operator who follows it watches the
	 * same call fail again with a bigger number in the config. The governor passes
	 * the envelope remedy (`allocateBudget`) when it re-wraps a rejected attributed
	 * hold; every other caller omits the argument and gets today's string
	 * byte-for-byte.
	 *
	 * `auditMeta` is argument FIVE, behind `hint`, so every existing three- and
	 * four-argument construction keeps compiling unchanged. In practice the
	 * governor does NOT use it: the boundary attaches the handle to the error
	 * INSTANCE it is about to rethrow, because rebuilding the error there would
	 * break the same-object identity the envelope threading relies on.
	 */
	constructor(
		userId: string,
		required: number,
		available: number,
		hintOverride?: string,
		auditMeta?: DenialAuditMetadata,
	) {
		const hint =
			hintOverride ?? "Increase the budget in trust() options or add funds via the ledger.";
		const docsUrl = "https://usertrust.ai/docs/errors/insufficient-balance";
		super(
			`Insufficient balance for user ${userId}: need ${required}, have ${available}\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`,
		);
		this.name = "InsufficientBalanceError";
		this.userId = userId;
		this.required = required;
		this.available = available;
		this.hint = hint;
		this.docsUrl = docsUrl;
		this.auditEventHash = auditMeta?.auditEventHash;
		this.auditDegraded = auditMeta?.auditDegraded;
	}
}

export class PolicyDeniedError extends Error {
	public readonly reason: string;
	public readonly hint: string;
	public readonly docsUrl: string;
	/** @see DenialAuditMetadata */
	public readonly auditEventHash?: string | undefined;
	/** @see DenialAuditMetadata */
	public readonly auditDegraded?: boolean | undefined;

	/**
	 * `hint` is overridable because the default advice is WRONG for a budget or
	 * scarcity denial: it names a PII downgrade that has nothing to do with the
	 * rule that fired. The governor derives a class-aware remedy at the throw
	 * site; every caller that omits the argument gets the default string.
	 *
	 * `auditMeta` is a THIRD argument for the same source-compatibility reason
	 * as `InsufficientBalanceError`'s fifth; see the note there for why the
	 * governor attaches the handle to the instance instead of passing it here.
	 */
	constructor(reason: string, hintOverride?: string, auditMeta?: DenialAuditMetadata) {
		const hint =
			hintOverride ??
			'Check your policy rules in .usertrust/policies/default.yml or use { pii: "warn" } to downgrade PII enforcement.';
		const docsUrl = "https://usertrust.ai/docs/errors/policy-denied";
		super(`Policy denied: ${reason}\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`);
		this.name = "PolicyDeniedError";
		this.reason = reason;
		this.hint = hint;
		this.docsUrl = docsUrl;
		this.auditEventHash = auditMeta?.auditEventHash;
		this.auditDegraded = auditMeta?.auditDegraded;
	}
}

export class AccountNotFoundError extends Error {
	public readonly userId: string;
	public readonly hint: string;
	public readonly docsUrl: string;

	constructor(userId: string) {
		const hint =
			'Run "npx usertrust init" to create accounts, or verify the userId matches your config.';
		const docsUrl = "https://usertrust.ai/docs/errors/account-not-found";
		super(`Account not found for user: ${userId}\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`);
		this.name = "AccountNotFoundError";
		this.userId = userId;
		this.hint = hint;
		this.docsUrl = docsUrl;
	}
}

export class IdempotencyConflictError extends Error {
	public readonly key: string;
	public readonly hint: string;
	public readonly docsUrl: string;

	constructor(key: string) {
		const hint = "This transfer was already submitted. Use a unique transferId for retries.";
		const docsUrl = "https://usertrust.ai/docs/errors/idempotency-conflict";
		super(`Idempotency conflict for key: ${key}\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`);
		this.name = "IdempotencyConflictError";
		this.key = key;
		this.hint = hint;
		this.docsUrl = docsUrl;
	}
}

export class LedgerUnavailableError extends Error {
	public readonly cause_message: string;
	public readonly hint: string;
	public readonly docsUrl: string;

	constructor(reason: string) {
		const hint =
			'Start TigerBeetle with "npx usertrust tb start" or use { dryRun: true } to skip the ledger.';
		const docsUrl = "https://usertrust.ai/docs/errors/ledger-unavailable";
		super(`Ledger unavailable: ${reason}\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`);
		this.name = "LedgerUnavailableError";
		this.cause_message = reason;
		this.hint = hint;
		this.docsUrl = docsUrl;
	}
}

export class AuditDegradedError extends Error {
	public readonly cause_message: string;
	public readonly hint: string;
	public readonly docsUrl: string;

	constructor(reason: string) {
		const hint = "Check disk space and permissions on the .usertrust/audit/ directory.";
		const docsUrl = "https://usertrust.ai/docs/errors/audit-degraded";
		super(`Audit degraded: ${reason}\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`);
		this.name = "AuditDegradedError";
		this.cause_message = reason;
		this.hint = hint;
		this.docsUrl = docsUrl;
	}
}

export class CredentialAccessDeniedError extends Error {
	public readonly credentialName: string;
	public readonly reason: string;
	public readonly hint: string;
	public readonly docsUrl: string;

	constructor(credentialName: string, reason: string) {
		const hint =
			"Check the credential scope in .usertrust/credentials.enc or update the scope with `usertrust secret add --scope`.";
		const docsUrl = "https://usertrust.ai/docs/errors/credential-access-denied";
		super(
			`Credential access denied for ${credentialName}: ${reason}\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`,
		);
		this.name = "CredentialAccessDeniedError";
		this.credentialName = credentialName;
		this.reason = reason;
		this.hint = hint;
		this.docsUrl = docsUrl;
	}
}

export class VaultNotInitializedError extends Error {
	public readonly path: string;
	public readonly hint: string;
	public readonly docsUrl: string;

	constructor(path: string) {
		const hint = 'Run "npx usertrust init" to create the vault directory.';
		const docsUrl = "https://usertrust.ai/docs/errors/vault-not-initialized";
		super(`Vault not initialized at: ${path}\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`);
		this.name = "VaultNotInitializedError";
		this.path = path;
		this.hint = hint;
		this.docsUrl = docsUrl;
	}
}

export class SkillVerificationError extends Error {
	public readonly skillId: string;
	public readonly reason: string;
	public readonly hint: string;
	public readonly docsUrl: string;

	constructor(skillId: string, reason: string) {
		const hint =
			"Verify the skill manifest is signed by a trusted publisher, or add the publisher to supplyChain.trustedPublishers.";
		const docsUrl = "https://usertrust.ai/docs/errors/skill-verification";
		super(
			`Skill verification failed for ${skillId}: ${reason}\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`,
		);
		this.name = "SkillVerificationError";
		this.skillId = skillId;
		this.reason = reason;
		this.hint = hint;
		this.docsUrl = docsUrl;
	}
}

export class AnomalyError extends Error {
	public readonly kind: "token_rate" | "spend_velocity" | "injection_cascade";
	public readonly metric: number;
	public readonly threshold: number;
	public readonly hint: string;
	public readonly docsUrl: string;

	constructor(
		kind: "token_rate" | "spend_velocity" | "injection_cascade",
		message: string,
		metric: number,
		threshold: number,
	) {
		const hint =
			"The streaming circuit breaker tripped on anomalous behavior. Tune anomaly thresholds in config or call detector.reset() to clear the trip.";
		const docsUrl = "https://usertrust.ai/docs/errors/anomaly-detected";
		super(`Anomaly detected (${kind}): ${message}\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`);
		this.name = "AnomalyError";
		this.kind = kind;
		this.metric = metric;
		this.threshold = threshold;
		this.hint = hint;
		this.docsUrl = docsUrl;
	}
}

export class VaultKeyMissingError extends Error {
	public readonly envVar: string;
	public readonly hint: string;
	public readonly docsUrl: string;

	constructor(envVar: string) {
		const hint = `Set the ${envVar} environment variable to the vault master key.`;
		const docsUrl = "https://usertrust.ai/docs/errors/vault-key-missing";
		super(
			`Vault master key not set: ${envVar} is not defined\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`,
		);
		this.name = "VaultKeyMissingError";
		this.envVar = envVar;
		this.hint = hint;
		this.docsUrl = docsUrl;
	}
}
