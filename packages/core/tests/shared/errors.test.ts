import { describe, expect, it } from "vitest";
import { isGovernanceDenial } from "../../src/audit/denial-events.js";
import {
	AccountNotFoundError,
	AuditDegradedError,
	IdempotencyConflictError,
	InsufficientBalanceError,
	LedgerUnavailableError,
	PolicyDeniedError,
	TaskLimitConflictError,
	TaskLimitExceededError,
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
			'Check your policy rules in .usertrust/policies/default.yml, or set "pii": "warn" in .usertrust/usertrust.config.json (or pass { pii: "warn" } to trust()) to downgrade PII enforcement.',
		);
		expect(err.docsUrl).toBe("https://usertrust.ai/docs/errors/policy-denied");
		expect(err.message).toContain("Policy denied: blocked by rule X");
		expect(err.message).toContain("\n\n  Hint: ");
		expect(err.message).toContain("\n  Docs: https://usertrust.ai/docs/errors/policy-denied");
	});

	it("PolicyDeniedError hint is overridable per denial class", () => {
		// Mirrors InsufficientBalanceError's hintOverride (errors.ts): the static
		// hint gives PII advice on budget denials, which is wrong for that class.
		const err = new PolicyDeniedError("[budget-tier] low runway", "Fund it: allocateBudget(...)");
		expect(err.hint).toBe("Fund it: allocateBudget(...)");
		expect(err.message).toContain("\n\n  Hint: Fund it: allocateBudget(...)");
		expect(err.reason).toBe("[budget-tier] low runway");
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
			"Start TigerBeetle 0.17.x (tigerbeetle format … then tigerbeetle start --addresses=127.0.0.1:3001) or use { dryRun: true } to skip the ledger.",
		);
		expect(err.hint).not.toContain("usertrust tb start");
		expect(err.docsUrl).toBe("https://usertrust.ai/docs/errors/ledger-unavailable");
		expect(err.message).toContain("Ledger unavailable: connection refused");
		expect(err.message).toContain("\n\n  Hint: ");
		expect(err.message).toContain("\n  Docs: https://usertrust.ai/docs/errors/ledger-unavailable");
	});

	it("LedgerUnavailableError's hint names the configured ledger address", () => {
		const err = new LedgerUnavailableError("connection refused", "10.0.0.5:3005");
		expect(err.hint).toContain("tigerbeetle start --addresses=10.0.0.5:3005)");
		expect(err.message).toContain("--addresses=10.0.0.5:3005");
		expect(err.hint).not.toContain("\n");
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
			new TaskLimitExceededError("t", 10, 4, 1),
			new TaskLimitConflictError("t", 10, 5),
		];
		for (const err of errors) {
			expect(typeof err.hint).toBe("string");
			expect(err.hint.length).toBeGreaterThan(0);
			expect(typeof err.docsUrl).toBe("string");
			expect(err.docsUrl).toMatch(/^https:\/\/usertrust\.ai\/docs\/errors\//);
		}
	});
});

describe("task-limit errors", () => {
	const EXCEEDED_HINT =
		"The task's limit is spent or held by calls still in flight. Wait for those calls to settle, or run the work under a new task id, which has its own limit.";
	const EXCEEDED_DOCS = "https://usertrust.ai/docs/errors/task-limit-exceeded";
	const CONFLICT_HINT =
		"A task id names one limit. Use the limit it was created with, or a new task id for a new limit.";
	const CONFLICT_DOCS = "https://usertrust.ai/docs/errors/task-limit-conflict";

	it("TaskLimitExceededError is an InsufficientBalanceError with the task in its message", () => {
		const err = new TaskLimitExceededError("triage-1", 2_000, 300, 120);
		// A budget refusal to every existing catch site and to the denial boundary, which records
		// it as ledger_rejected.
		expect(err).toBeInstanceOf(InsufficientBalanceError);
		expect(err).toBeInstanceOf(Error);
		expect(isGovernanceDenial(err)).toBe(true);
		expect(err.name).toBe("TaskLimitExceededError");
		expect(err.taskId).toBe("triage-1");
		expect(err.limit).toBe(2_000);
		expect(err.required).toBe(300);
		expect(err.available).toBe(120);
		expect(err.userId).toBe("task:triage-1");
		expect(err.hint).toBe(EXCEEDED_HINT);
		expect(err.docsUrl).toBe(EXCEEDED_DOCS);
		expect(err.message).toBe(
			`Task triage-1 is at its limit: need 300, have 120 of 2000\n\n  Hint: ${EXCEEDED_HINT}\n  Docs: ${EXCEEDED_DOCS}`,
		);
		// No denial record yet: the boundary attaches one to this instance when it records it.
		expect(err.auditEventHash).toBeUndefined();
		expect(err.auditDegraded).toBeUndefined();
	});

	it("TaskLimitExceededError keeps the budget refusal's message untouched", () => {
		// The subclass carries its own message; the parent's wording, which existing callers read,
		// does not change.
		const budget = new InsufficientBalanceError("user1", 100, 50);
		expect(budget.message).toContain("Insufficient balance for user user1: need 100, have 50");
		expect(new TaskLimitExceededError("t", 10, 4, 1).message).not.toContain("Insufficient");
	});

	it("TaskLimitConflictError carries both limits and is not a governance denial", () => {
		const err = new TaskLimitConflictError("triage-1", 3_000, 2_000);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(InsufficientBalanceError);
		expect(isGovernanceDenial(err)).toBe(false);
		expect(err.name).toBe("TaskLimitConflictError");
		expect(err.taskId).toBe("triage-1");
		expect(err.requestedLimit).toBe(3_000);
		expect(err.existingLimit).toBe(2_000);
		expect(err.hint).toBe(CONFLICT_HINT);
		expect(err.docsUrl).toBe(CONFLICT_DOCS);
		expect(err.message).toBe(
			`Task triage-1 already has a limit of 2000; this call asked for 3000\n\n  Hint: ${CONFLICT_HINT}\n  Docs: ${CONFLICT_DOCS}`,
		);
	});

	it("TaskLimitConflictError without the existing limit says another value", () => {
		const err = new TaskLimitConflictError("t", 10);
		expect(err.existingLimit).toBeUndefined();
		expect(err.message).toContain("Task t already has a limit of another value; this call asked for 10");
	});
});
