export class InsufficientBalanceError extends Error {
	public readonly userId: string;
	public readonly required: number;
	public readonly available: number;

	constructor(userId: string, required: number, available: number) {
		super(`Insufficient balance for user ${userId}: need ${required}, have ${available}`);
		this.name = "InsufficientBalanceError";
		this.userId = userId;
		this.required = required;
		this.available = available;
	}
}

export class PolicyDeniedError extends Error {
	public readonly reason: string;

	constructor(reason: string) {
		super(`Policy denied: ${reason}`);
		this.name = "PolicyDeniedError";
		this.reason = reason;
	}
}

export class AccountNotFoundError extends Error {
	public readonly userId: string;

	constructor(userId: string) {
		super(`Account not found for user: ${userId}`);
		this.name = "AccountNotFoundError";
		this.userId = userId;
	}
}

export class IdempotencyConflictError extends Error {
	public readonly key: string;

	constructor(key: string) {
		super(`Idempotency conflict for key: ${key}`);
		this.name = "IdempotencyConflictError";
		this.key = key;
	}
}

export class LedgerUnavailableError extends Error {
	public readonly cause_message: string;

	constructor(reason: string) {
		super(`Ledger unavailable: ${reason}`);
		this.name = "LedgerUnavailableError";
		this.cause_message = reason;
	}
}

export class AuditDegradedError extends Error {
	public readonly cause_message: string;

	constructor(reason: string) {
		super(`Audit degraded: ${reason}`);
		this.name = "AuditDegradedError";
		this.cause_message = reason;
	}
}

export class VaultNotInitializedError extends Error {
	public readonly path: string;

	constructor(path: string) {
		super(`Vault not initialized at: ${path}`);
		this.name = "VaultNotInitializedError";
		this.path = path;
	}
}
