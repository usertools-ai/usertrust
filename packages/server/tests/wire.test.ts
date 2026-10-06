import {
	AlreadySettledError,
	AnomalyError,
	InsufficientBalanceError,
	LedgerUnavailableError,
	PolicyDeniedError,
} from "usertrust";
import { describe, expect, it } from "vitest";
import {
	AbortRequestSchema,
	AuthorizeRequestSchema,
	ReleaseRequestSchema,
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

	it("parses params as a string-keyed record and rejects non-record values", () => {
		// Pins the zod-4 `z.record(z.string(), z.unknown())` arity migration:
		// zod 3's `z.record(V)` inferred string keys by default; zod 4 requires
		// the key schema explicitly. These cases confirm zod-3 acceptance
		// semantics carried over exactly.
		expect(AuthorizeRequestSchema.parse({ model: "m", params: {} }).params).toEqual({});
		expect(AuthorizeRequestSchema.parse({ model: "m", params: { a: 1 } }).params).toEqual({
			a: 1,
		});
		expect(() => AuthorizeRequestSchema.parse({ model: "m", params: "x" })).toThrow();
		expect(() => AuthorizeRequestSchema.parse({ model: "m", params: [] })).toThrow();
		expect(() => AuthorizeRequestSchema.parse({ model: "m", params: null })).toThrow();
	});

	it("accepts settle and abort by transferId", () => {
		expect(SettleRequestSchema.parse({ transferId: "tx_1", outputTokens: 5 }).transferId).toBe(
			"tx_1",
		);
		expect(AbortRequestSchema.parse({ transferId: "tx_1" }).transferId).toBe("tx_1");
	});

	it("round-trips the four-tier cache fields on settle (D4 row 6 — the schema used to STRIP them)", () => {
		const parsed = SettleRequestSchema.parse({
			transferId: "tx_1",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 900_000,
			cacheWriteTokens: 1_200,
		});
		// Both directions: present AND round-tripped exactly, not silently dropped.
		expect(parsed.cacheReadTokens).toBe(900_000);
		expect(parsed.cacheWriteTokens).toBe(1_200);
		expect(parsed).toEqual({
			transferId: "tx_1",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 900_000,
			cacheWriteTokens: 1_200,
		});
	});

	it("cache fields stay optional and reject non-integer/negative values like the existing token fields", () => {
		expect(SettleRequestSchema.parse({ transferId: "tx_1" }).cacheReadTokens).toBeUndefined();
		expect(() => SettleRequestSchema.parse({ transferId: "tx_1", cacheReadTokens: -1 })).toThrow();
		expect(() =>
			SettleRequestSchema.parse({ transferId: "tx_1", cacheWriteTokens: 1.5 }),
		).toThrow();
	});

	it("round-trips computeMs on settle (schema used to STRIP it)", () => {
		const parsed = SettleRequestSchema.parse({
			transferId: "tx_1",
			inputTokens: 100,
			outputTokens: 50,
			computeMs: 4709,
		});
		expect(parsed.computeMs).toBe(4709);
		expect(parsed).toEqual({
			transferId: "tx_1",
			inputTokens: 100,
			outputTokens: 50,
			computeMs: 4709,
		});
	});

	it("computeMs stays optional and rejects negative / non-finite values", () => {
		expect(SettleRequestSchema.parse({ transferId: "tx_1" }).computeMs).toBeUndefined();
		// Core SettleParams accepts any finite non-negative number, including
		// fractions — do not .int() this field the way the token counts are.
		expect(SettleRequestSchema.parse({ transferId: "tx_1", computeMs: 1.5 }).computeMs).toBe(1.5);
		expect(SettleRequestSchema.parse({ transferId: "tx_1", computeMs: 0 }).computeMs).toBe(0);
		expect(() => SettleRequestSchema.parse({ transferId: "tx_1", computeMs: -1 })).toThrow();
		expect(() =>
			SettleRequestSchema.parse({ transferId: "tx_1", computeMs: Number.NaN }),
		).toThrow();
		expect(() =>
			SettleRequestSchema.parse({ transferId: "tx_1", computeMs: Number.POSITIVE_INFINITY }),
		).toThrow();
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

describe("#205 wire: keys, principal, release, and the two new error mappings", () => {
	it("accepts a legal key and principal, and strips extra principal keys", () => {
		const parsed = AuthorizeRequestSchema.parse({
			model: "m",
			idempotencyKey: "!~".repeat(128),
			principal: { id: "user-42", type: "human", origin: "cli:session.7", extra: "x" },
		});
		expect(parsed.idempotencyKey).toHaveLength(256);
		expect(parsed.principal).toEqual({ id: "user-42", type: "human", origin: "cli:session.7" });
	});

	it.each([
		["", "an empty key"],
		["k".repeat(257), "a 257-character key"],
		["call 1", "a space"],
		[`call${String.fromCharCode(0x07)}`, "a control character"],
		["cäll", "non-ASCII"],
	])("refuses %j (%s) as a key — the governor's own rule", (idempotencyKey) => {
		expect(AuthorizeRequestSchema.safeParse({ model: "m", idempotencyKey }).success).toBe(false);
		expect(SettleRequestSchema.safeParse({ transferId: "t", idempotencyKey }).success).toBe(false);
	});

	it("refuses an illegal principal field", () => {
		for (const principal of [
			{ id: "a b", type: "human" },
			{ id: "a", type: "human/admin" },
			{ id: "a", type: "human", origin: "" },
			{ id: "x".repeat(129), type: "human" },
			{ id: "a" },
		]) {
			expect(AuthorizeRequestSchema.safeParse({ model: "m", principal }).success).toBe(false);
		}
	});

	it("release takes a transferId and an optional reason", () => {
		expect(ReleaseRequestSchema.parse({ transferId: "tx_1" })).toEqual({ transferId: "tx_1" });
		expect(ReleaseRequestSchema.parse({ transferId: "tx_1", reason: "r" }).reason).toBe("r");
		expect(ReleaseRequestSchema.safeParse({ transferId: "" }).success).toBe(false);
	});

	it("maps AlreadySettledError to 409 already_settled", () => {
		const mapped = toHttpError(new AlreadySettledError());
		expect(mapped.status).toBe(409);
		expect(mapped.body.error).toBe("already_settled");
	});

	it("maps LedgerUnavailableError to 503, with a fixed reason that leaks nothing", () => {
		const mapped = toHttpError(new LedgerUnavailableError("connect ECONNREFUSED 10.0.0.7:3000"));
		expect(mapped.status).toBe(503);
		expect(mapped.body.error).toBe("ledger_unavailable");
		expect(mapped.body.reason).not.toContain("10.0.0.7");
	});
});
