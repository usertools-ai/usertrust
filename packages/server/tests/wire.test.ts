import { AnomalyError, InsufficientBalanceError, PolicyDeniedError } from "usertrust";
import { describe, expect, it } from "vitest";
import {
	AbortRequestSchema,
	AuthorizeRequestSchema,
	SettleRequestSchema,
	toHttpError,
} from "../src/wire.js";

describe("request schemas", () => {
	it("accepts a minimal authorize request", () => {
		const parsed = AuthorizeRequestSchema.parse({ model: "claude-sonnet-4-6" });
		expect(parsed.model).toBe("claude-sonnet-4-6");
	});

	it("rejects authorize without model and with wrong types", () => {
		expect(() => AuthorizeRequestSchema.parse({})).toThrow();
		expect(() =>
			AuthorizeRequestSchema.parse({ model: "m", estimatedInputTokens: "many" }),
		).toThrow();
	});

	it("accepts settle and abort by transferId", () => {
		expect(SettleRequestSchema.parse({ transferId: "tx_1", outputTokens: 5 }).transferId).toBe(
			"tx_1",
		);
		expect(AbortRequestSchema.parse({ transferId: "tx_1" }).transferId).toBe("tx_1");
	});
});

describe("toHttpError", () => {
	it("maps PolicyDeniedError to 403 policy_denied", () => {
		const mapped = toHttpError(new PolicyDeniedError("pii: ssn detected"));
		expect(mapped.status).toBe(403);
		expect(mapped.body.error).toBe("policy_denied");
		expect(mapped.body.reason).toContain("pii");
	});

	it("maps InsufficientBalanceError to 402 budget_exceeded", () => {
		const mapped = toHttpError(new InsufficientBalanceError("acme", 100, 3));
		expect(mapped.status).toBe(402);
		expect(mapped.body.error).toBe("budget_exceeded");
	});

	it("maps AnomalyError to 429 anomaly", () => {
		const mapped = toHttpError(new AnomalyError("token_rate", "rate spike", 10, 5));
		expect(mapped.status).toBe(429);
		expect(mapped.body.error).toBe("anomaly");
		expect(mapped.body.reason).toContain("token_rate");
	});

	it("maps unknown errors to 500 without leaking messages", () => {
		const mapped = toHttpError(new Error("secret internal detail sk-ant-xyz"));
		expect(mapped.status).toBe(500);
		expect(mapped.body.error).toBe("internal");
		expect(JSON.stringify(mapped.body)).not.toContain("sk-ant");
	});
});
