import { describe, expect, it } from "vitest";
import {
	AccountNotFoundError,
	AuditDegradedError,
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
	});

	it("PolicyDeniedError has reason", () => {
		const err = new PolicyDeniedError("blocked by rule X");
		expect(err.reason).toBe("blocked by rule X");
		expect(err.name).toBe("PolicyDeniedError");
	});

	it("LedgerUnavailableError exists", () => {
		const err = new LedgerUnavailableError("connection refused");
		expect(err.name).toBe("LedgerUnavailableError");
		expect(err).toBeInstanceOf(Error);
	});

	it("AccountNotFoundError has userId", () => {
		const err = new AccountNotFoundError("user1");
		expect(err.name).toBe("AccountNotFoundError");
	});

	it("AuditDegradedError exists", () => {
		const err = new AuditDegradedError("disk full");
		expect(err.name).toBe("AuditDegradedError");
	});

	it("VaultNotInitializedError exists", () => {
		const err = new VaultNotInitializedError("/path/to/.usertools");
		expect(err.name).toBe("VaultNotInitializedError");
	});
});
