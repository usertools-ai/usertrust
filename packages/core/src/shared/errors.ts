// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

export class InsufficientBalanceError extends Error {
	public readonly userId: string;
	public readonly required: number;
	public readonly available: number;
	public readonly hint: string;
	public readonly docsUrl: string;

	constructor(userId: string, required: number, available: number) {
		const hint = "Increase the budget in trust() options or add funds via the ledger.";
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
	}
}

export class PolicyDeniedError extends Error {
	public readonly reason: string;
	public readonly hint: string;
	public readonly docsUrl: string;

	constructor(reason: string) {
		const hint =
			'Check your policy rules in .usertrust/policies/ or use { pii: "warn" } to downgrade PII enforcement.';
		const docsUrl = "https://usertrust.ai/docs/errors/policy-denied";
		super(`Policy denied: ${reason}\n\n  Hint: ${hint}\n  Docs: ${docsUrl}`);
		this.name = "PolicyDeniedError";
		this.reason = reason;
		this.hint = hint;
		this.docsUrl = docsUrl;
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
