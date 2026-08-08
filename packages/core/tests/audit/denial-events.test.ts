// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Unit surface of the denial-event helper: classification, prompt hashing,
 * payload construction, and the error-attachment contract. The FLOW behaviour
 * (which boundary appends what, and when) is pinned in
 * `tests/harden/denial-events.test.ts`.
 */

import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import {
	appendDenialEvent,
	classifyPolicyDenial,
	computePromptHash,
	DENIAL_SCHEMA_VERSION,
	isGovernanceDenial,
	PROMPT_HASH_ALG,
	toDenialRuleRefs,
} from "../../src/audit/denial-events.js";
import type { RuleMatch } from "../../src/policy/gate.js";
import {
	InsufficientBalanceError,
	LedgerUnavailableError,
	PolicyDeniedError,
} from "../../src/shared/errors.js";
import type { AuditEvent } from "../../src/shared/types.js";

function match(name: string, fields: string[], id?: string): RuleMatch {
	return {
		name,
		effect: "deny",
		enforcement: "hard",
		severity: "critical",
		fields,
		...(id !== undefined ? { id } : {}),
	};
}

function recordingWriter(): { writer: AuditWriter; inputs: AppendEventInput[] } {
	const inputs: AppendEventInput[] = [];
	const writer: AuditWriter = {
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			inputs.push(input);
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "b".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		}),
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
	return { writer, inputs };
}

function throwingWriter(): AuditWriter {
	return {
		appendEvent: vi.fn(async () => {
			throw new Error("ENOSPC: no space left on device");
		}),
		getWriteFailures: vi.fn(() => 1),
		isDegraded: vi.fn(() => true),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

describe("isGovernanceDenial", () => {
	it("accepts exactly the two governance denial classes", () => {
		expect(isGovernanceDenial(new PolicyDeniedError("nope"))).toBe(true);
		expect(isGovernanceDenial(new InsufficientBalanceError("u", 10, 1))).toBe(true);
		expect(isGovernanceDenial(new LedgerUnavailableError("down"))).toBe(false);
		expect(isGovernanceDenial(new Error("boom"))).toBe(false);
		expect(isGovernanceDenial("PolicyDeniedError")).toBe(false);
		expect(isGovernanceDenial(undefined)).toBe(false);
	});
});

describe("classifyPolicyDenial", () => {
	it("classifies budget_gate only when EVERY hard violation is budget-family", () => {
		expect(classifyPolicyDenial([match("overshoot", ["budget_remaining_after"])])).toBe(
			"budget_gate",
		);
		expect(
			classifyPolicyDenial([
				match("overshoot", ["budget_remaining_after"]),
				match("exhausted", ["budget_remaining"]),
			]),
		).toBe("budget_gate");
	});

	it("falls back to policy when any hard violation is content-classed", () => {
		expect(
			classifyPolicyDenial([
				match("overshoot", ["budget_remaining_after"]),
				match("no-frontier", ["model"]),
			]),
		).toBe("policy");
		expect(classifyPolicyDenial([match("no-frontier", ["model"])])).toBe("policy");
	});

	it("classifies an empty violation set as policy, never budget_gate", () => {
		// `[].every(...)` is vacuously true — a naive predicate would call a
		// reason-less deny a budget denial and send the operator to allocateBudget.
		expect(classifyPolicyDenial([])).toBe("policy");
	});
});

describe("toDenialRuleRefs", () => {
	it("carries the rule id when present and OMITS the property when absent", () => {
		const refs = toDenialRuleRefs([
			match("Block overshoot", ["budget_remaining_after"], "block-budget-overshoot"),
			match("nameless-id", ["model"]),
		]);
		expect(refs).toEqual([
			{ id: "block-budget-overshoot", name: "Block overshoot" },
			{ name: "nameless-id" },
		]);
		expect(Object.hasOwn(refs[1] as object, "id")).toBe(false);
	});

	it("preserves duplicate names rather than de-duplicating them", () => {
		const refs = toDenialRuleRefs([match("dup", ["model"]), match("dup", ["tier"])]);
		expect(refs).toHaveLength(2);
	});
});

describe("computePromptHash", () => {
	it("matches sha256 over JSON.stringify of the parts (the pattern-memory formula)", () => {
		const parts = [{ role: "user", content: "hello" }];
		expect(computePromptHash(parts)).toBe(
			createHash("sha256").update(JSON.stringify(parts)).digest("hex"),
		);
	});

	it("returns undefined for unstringifiable input instead of throwing", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(computePromptHash(circular)).toBeUndefined();
		expect(computePromptHash([1n])).toBeUndefined();
		expect(computePromptHash(undefined)).toBeUndefined();
	});
});

describe("appendDenialEvent — payload shape", () => {
	it("builds a policy_denied event with exactly the schema's fields", async () => {
		const { writer, inputs } = recordingWriter();
		const err = new PolicyDeniedError("[no-frontier] frontier models are off");
		const promptParts = [{ role: "user", content: "hi" }];
		await appendDenialEvent({
			audit: writer,
			actor: "local",
			error: err,
			record: {
				denialClass: "policy",
				policyRules: [{ id: "no-frontier", name: "No frontier models" }],
			},
			fields: {
				model: "claude-opus-4",
				costCenter: "research",
				endpointClass: "cloud",
				transferId: "tx_1",
				promptParts,
			},
		});

		expect(inputs).toHaveLength(1);
		const [event] = inputs;
		expect(event?.kind).toBe("policy_denied");
		expect(event?.actor).toBe("local");
		expect(event?.data).toEqual({
			schemaVersion: DENIAL_SCHEMA_VERSION,
			decision: "deny",
			denialClass: "policy",
			model: "claude-opus-4",
			policyRules: [{ id: "no-frontier", name: "No frontier models" }],
			promptHash: createHash("sha256").update(JSON.stringify(promptParts)).digest("hex"),
			promptHashAlg: PROMPT_HASH_ALG,
			costCenter: "research",
			endpointClass: "cloud",
			error: err.message.slice(0, 200),
			transferId: "tx_1",
		});
		expect(err.auditEventHash).toBe("b".repeat(64));
		expect(err.auditDegraded).toBeUndefined();
	});

	it("omits promptHashAlg when no promptHash could be computed", async () => {
		const { writer, inputs } = recordingWriter();
		const err = new PolicyDeniedError("unknown_model: x not in pricing table");
		await appendDenialEvent({
			audit: writer,
			actor: "local",
			error: err,
			record: { denialClass: "unknown_model" },
			fields: { model: "x" },
		});
		const data = inputs[0]?.data ?? {};
		expect(Object.hasOwn(data, "promptHash")).toBe(false);
		expect(Object.hasOwn(data, "promptHashAlg")).toBe(false);
		expect(data).toEqual({
			schemaVersion: DENIAL_SCHEMA_VERSION,
			decision: "deny",
			denialClass: "unknown_model",
			model: "x",
			error: err.message.slice(0, 200),
		});
	});

	it("carries the budget numbers only for a budget_gate denial", async () => {
		const { writer, inputs } = recordingWriter();
		await appendDenialEvent({
			audit: writer,
			actor: "local",
			error: new PolicyDeniedError("[block-budget-overshoot] over"),
			record: {
				denialClass: "budget_gate",
				policyRules: [{ id: "block-budget-overshoot", name: "Block overshoot" }],
				budget: { estimatedCost: 900, budgetRemaining: 100 },
			},
			fields: { model: "m" },
		});
		expect(inputs[0]?.data.budget).toEqual({ estimatedCost: 900, budgetRemaining: 100 });
	});

	it("builds a ledger_rejected event for an InsufficientBalanceError", async () => {
		const { writer, inputs } = recordingWriter();
		const err = new InsufficientBalanceError("acme::research", 900, 100);
		await appendDenialEvent({
			audit: writer,
			actor: "local",
			error: err,
			record: undefined,
			fields: {
				model: "claude-sonnet-4-6",
				transferId: "tx_9",
				estimatedCost: 900,
				costCenter: "research",
				endpointClass: "cloud",
				// A prompt IS in scope here, but ledger_rejected's schema has no
				// promptHash field — a wider field set would be a second place for
				// prompt-derived data to leak into the chain.
				promptParts: [{ role: "user", content: "hi" }],
			},
		});
		expect(inputs[0]?.kind).toBe("ledger_rejected");
		expect(inputs[0]?.data).toEqual({
			schemaVersion: DENIAL_SCHEMA_VERSION,
			decision: "deny",
			model: "claude-sonnet-4-6",
			transferId: "tx_9",
			estimatedCost: 900,
			costCenter: "research",
			endpointClass: "cloud",
			error: err.message.slice(0, 200),
		});
		expect(err.auditEventHash).toBe("b".repeat(64));
	});

	it("redacts before it truncates — a PII-bearing message collapses entirely", async () => {
		// `redactPII` replaces a MATCHING string wholesale, so a denial reason
		// that quoted a value keeps no readable text at all. Losing the reason is
		// the correct trade: clipping first could split a match and leave half an
		// SSN in the chain, where nothing ever removes it.
		const { writer, inputs } = recordingWriter();
		const leaky = new PolicyDeniedError(`caller said ssn 123-45-6789`);
		await appendDenialEvent({
			audit: writer,
			actor: "local",
			error: leaky,
			record: { denialClass: "policy" },
			fields: {},
		});
		const redacted = String(inputs[0]?.data.error);
		expect(redacted).not.toContain("123-45-6789");
		expect(redacted).toContain("REDACTED");
	});

	it("truncates a long PII-free message at 200 characters", async () => {
		const { writer, inputs } = recordingWriter();
		await appendDenialEvent({
			audit: writer,
			actor: "local",
			error: new PolicyDeniedError("x".repeat(500)),
			record: { denialClass: "policy" },
			fields: {},
		});
		expect(String(inputs[0]?.data.error)).toHaveLength(200);
	});
});

describe("appendDenialEvent — the append-failure contract", () => {
	it("never throws, never replaces the denial, and marks auditDegraded", async () => {
		const err = new PolicyDeniedError("denied");
		await expect(
			appendDenialEvent({
				audit: throwingWriter(),
				actor: "local",
				error: err,
				record: { denialClass: "policy" },
				fields: {},
			}),
		).resolves.toBeUndefined();
		expect(err.auditEventHash).toBeUndefined();
		expect(err.auditDegraded).toBe(true);
	});

	it("attaches to the ORIGINAL instance — same object identity, enumerable", async () => {
		const { writer } = recordingWriter();
		const err = new PolicyDeniedError("denied");
		const before = err;
		await appendDenialEvent({
			audit: writer,
			actor: "local",
			error: err,
			record: { denialClass: "policy" },
			fields: {},
		});
		expect(err).toBe(before);
		expect(Object.keys(err)).toContain("auditEventHash");
		expect(JSON.parse(JSON.stringify(err)).auditEventHash).toBe("b".repeat(64));
	});

	it("is a no-op for an error that is not a governance denial", async () => {
		const { writer, inputs } = recordingWriter();
		await appendDenialEvent({
			audit: writer,
			actor: "local",
			error: new LedgerUnavailableError("down"),
			record: { denialClass: "policy" },
			fields: {},
		});
		expect(inputs).toHaveLength(0);
	});
});
