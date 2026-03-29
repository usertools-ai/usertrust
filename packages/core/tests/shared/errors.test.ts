import { describe, expect, it } from "vitest";
import {
	AccountNotFoundError,
	AuditDegradedError,
	IdempotencyConflictError,
	InsufficientBalanceError,
	LedgerUnavailableError,
	PolicyDeniedError,
	VaultNotInitializedError,
} from "../../src/shared/errors.js";

describe("domain errors", () => {
	it("InsufficientBalanceError has correct properties", () => {
		const err = new InsufficientBalanceError("user1", 100, 50);
		expect(err.name).toBe("InsufficientBalanceError");
		expect(err.userId).toBe("user1");
		expect(err.required).toBe(100);
		expect(err.available).toBe(50);
		expect(err).toBeInstanceOf(Error);
		expect(err.hint).toBe("Increase the budget in trust() options or add funds via the ledger.");
		expect(err.docsUrl).toBe("https://usertrust.ai/docs/errors/insufficient-balance");
		expect(err.message).toContain("need 100, have 50");
		expect(err.message).toContain("\n\n  Hint: ");
		expect(err.message).toContain(
			"\n  Docs: https://usertrust.ai/docs/errors/insufficient-balance",
		);
	});

	it("PolicyDeniedError has reason", () => {
		const err = new PolicyDeniedError("blocked by rule X");
		expect(err.reason).toBe("blocked by rule X");
		expect(err.name).toBe("PolicyDeniedError");
		expect(err).toBeInstanceOf(Error);
		expect(err.hint).toBe(
			'Check your policy rules in .usertrust/policies/ or use { pii: "warn" } to downgrade PII enforcement.',
		);
		expect(err.docsUrl).toBe("https://usertrust.ai/docs/errors/policy-denied");
		expect(err.message).toContain("Policy denied: blocked by rule X");
		expect(err.message).toContain("\n\n  Hint: ");
		expect(err.message).toContain("\n  Docs: https://usertrust.ai/docs/errors/policy-denied");
	});

	it("AccountNotFoundError has userId", () => {
		const err = new AccountNotFoundError("user1");
		expect(err.name).toBe("AccountNotFoundError");
		expect(err.userId).toBe("user1");
		expect(err).toBeInstanceOf(Error);
		expect(err.hint).toBe(
			'Run "npx usertrust init" to create accounts, or verify the userId matches your config.',
		);
		expect(err.docsUrl).toBe("https://usertrust.ai/docs/errors/account-not-found");
		expect(err.message).toContain("Account not found for user: user1");
		expect(err.message).toContain("\n\n  Hint: ");
		expect(err.message).toContain("\n  Docs: https://usertrust.ai/docs/errors/account-not-found");
	});

	it("IdempotencyConflictError has key", () => {
		const err = new IdempotencyConflictError("tx_abc123");
		expect(err.name).toBe("IdempotencyConflictError");
		expect(err.key).toBe("tx_abc123");
		expect(err).toBeInstanceOf(Error);
		expect(err.hint).toBe(
			"This transfer was already submitted. Use a unique transferId for retries.",
		);
		expect(err.docsUrl).toBe("https://usertrust.ai/docs/errors/idempotency-conflict");
		expect(err.message).toContain("Idempotency conflict for key: tx_abc123");
		expect(err.message).toContain("\n\n  Hint: ");
		expect(err.message).toContain(
			"\n  Docs: https://usertrust.ai/docs/errors/idempotency-conflict",
		);
	});

	it("LedgerUnavailableError exists", () => {
		const err = new LedgerUnavailableError("connection refused");
		expect(err.name).toBe("LedgerUnavailableError");
		expect(err.cause_message).toBe("connection refused");
		expect(err).toBeInstanceOf(Error);
		expect(err.hint).toBe(
			'Start TigerBeetle with "npx usertrust tb start" or use { dryRun: true } to skip the ledger.',
		);
		expect(err.docsUrl).toBe("https://usertrust.ai/docs/errors/ledger-unavailable");
		expect(err.message).toContain("Ledger unavailable: connection refused");
		expect(err.message).toContain("\n\n  Hint: ");
		expect(err.message).toContain("\n  Docs: https://usertrust.ai/docs/errors/ledger-unavailable");
	});

	it("AuditDegradedError exists", () => {
		const err = new AuditDegradedError("disk full");
		expect(err.name).toBe("AuditDegradedError");
		expect(err.cause_message).toBe("disk full");
		expect(err).toBeInstanceOf(Error);
		expect(err.hint).toBe("Check disk space and permissions on the .usertrust/audit/ directory.");
		expect(err.docsUrl).toBe("https://usertrust.ai/docs/errors/audit-degraded");
		expect(err.message).toContain("Audit degraded: disk full");
		expect(err.message).toContain("\n\n  Hint: ");
		expect(err.message).toContain("\n  Docs: https://usertrust.ai/docs/errors/audit-degraded");
	});

	it("VaultNotInitializedError exists", () => {
		const err = new VaultNotInitializedError("/path/to/.usertrust");
		expect(err.name).toBe("VaultNotInitializedError");
		expect(err.path).toBe("/path/to/.usertrust");
		expect(err).toBeInstanceOf(Error);
		expect(err.hint).toBe('Run "npx usertrust init" to create the vault directory.');
		expect(err.docsUrl).toBe("https://usertrust.ai/docs/errors/vault-not-initialized");
		expect(err.message).toContain("Vault not initialized at: /path/to/.usertrust");
		expect(err.message).toContain("\n\n  Hint: ");
		expect(err.message).toContain(
			"\n  Docs: https://usertrust.ai/docs/errors/vault-not-initialized",
		);
	});

	it("all errors have hint and docsUrl as readonly strings", () => {
		const errors = [
			new InsufficientBalanceError("u", 1, 0),
			new PolicyDeniedError("reason"),
			new AccountNotFoundError("u"),
			new IdempotencyConflictError("k"),
			new LedgerUnavailableError("reason"),
			new AuditDegradedError("reason"),
			new VaultNotInitializedError("/path"),
		];
		for (const err of errors) {
			expect(typeof err.hint).toBe("string");
			expect(err.hint.length).toBeGreaterThan(0);
			expect(typeof err.docsUrl).toBe("string");
			expect(err.docsUrl).toMatch(/^https:\/\/usertrust\.ai\/docs\/errors\//);
		}
	});
});
