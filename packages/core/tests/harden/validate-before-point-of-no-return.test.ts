// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — caller-supplied, audit-bound values are validated BEFORE the point
 * of no return.
 *
 * The rule these tests pin:
 *
 *   Validate everything you will need to durably record BEFORE you do anything
 *   you cannot undo. A guard that runs after the irreversible step isn't a
 *   guard, it's a notification.
 *
 * The defect: `settle(auth, { chunksDelivered: NaN })` learned that the value
 * was unrecordable at `appendEvent`, which runs AFTER `activeAuths.delete()`
 * (the authorization is gone) and AFTER `postPendingSpend()` (the money moved).
 * The caller got a loud failure for a settlement whose money had already
 * committed, and no authorization left to retry against. Making the writer
 * throw was right; the ORDER was the defect.
 *
 * THE LOAD-BEARING ASSERTION IN THIS FILE IS THE RETRY. A test that only
 * asserts "it throws" would pass just as happily against the broken ordering —
 * it would have moved the throw and proved nothing. What proves the fix is that
 * after the throw the authorization is still live, no money moved, no event was
 * written, and the SAME handle settles successfully once the value is corrected.
 *
 * The write-ahead alternative (append the audit event before claiming the
 * authorization) is explicitly rejected upstream and is NOT what these tests
 * describe: nothing is appended before the refusal, which is why the
 * "no event on the chain" assertions below are exact counts, not lower bounds.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { assertAuditRepresentable } from "../../src/audit/representable.js";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { AuditDataInvalidError } from "../../src/shared/errors.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

function readEvents(vaultBase: string): Record<string, unknown>[] {
	const auditPath = join(vaultBase, VAULT_DIR, "audit", "events.jsonl");
	if (!existsSync(auditPath)) return [];
	return readFileSync(auditPath, "utf-8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function makeAnthropicMock() {
	return {
		messages: {
			create: vi.fn(async () => ({
				id: "msg_test",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 10, output_tokens: 5 },
			})),
		},
	};
}

describe("HARDEN: validate caller-supplied audit-bound values before the point of no return", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `validate-first-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		rmSync(vaultBase, { recursive: true, force: true });
	});

	// ── headless settle() ──

	it("settle() refuses a NaN chunksDelivered at the boundary and the SAME auth still settles", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 1_000 });

		// NOTE: this already has the PENDING hold subtracted from it — the point of
		// comparing against it is that a refused settle must move NOTHING, neither
		// releasing the hold nor committing the spend.
		const budgetBefore = gov.budgetRemaining();
		const eventsBefore = readEvents(vaultBase).length;

		const err = await gov
			.settle(auth, { inputTokens: 10, outputTokens: 5, chunksDelivered: Number.NaN })
			.then(
				() => undefined,
				(e: unknown) => e,
			);

		// 1. It throws, and the error names the offending field so a caller can
		//    fix it without reading our source.
		expect(err).toBeInstanceOf(AuditDataInvalidError);
		expect((err as Error).message).toContain("SettleParams.chunksDelivered");

		// 2. NO money moved. `budgetSpent` is incremented (and persisted) inside
		//    settle BEFORE the POST, so an unchanged budget proves the throw
		//    preceded every irreversible step, not merely the ledger call.
		expect(gov.budgetRemaining()).toBe(budgetBefore);

		// 3. NO audit event — exact count, because a write-ahead would show up
		//    here as an extra line rather than as a missing one.
		expect(readEvents(vaultBase)).toHaveLength(eventsBefore);

		// 4. THE POINT OF THE WHOLE FIX: the authorization survived, so the caller
		//    can correct the value and retry on the same handle. Without this the
		//    throw has only been relocated.
		const receipt = await gov.settle(auth, {
			inputTokens: 10,
			outputTokens: 5,
			chunksDelivered: 7,
		});
		expect(receipt.settled).toBe(true);
		expect(receipt.chunksDelivered).toBe(7);
		// The hold is released and the real cost committed — exactly once, for the
		// retry. A double-charge from the refused attempt would show up here.
		expect(gov.budgetRemaining()).toBe(100_000 - receipt.cost);

		const llmCalls = readEvents(vaultBase).filter((e) => e.kind === "llm_call");
		expect(llmCalls).toHaveLength(1);
		expect((llmCalls[0] as { data: Record<string, unknown> }).data.chunksDelivered).toBe(7);

		await gov.destroy();
	});

	it("settle() refuses Infinity and -Infinity the same way, and the auth stays retryable", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });

		for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			await expect(gov.settle(auth, { chunksDelivered: bad })).rejects.toBeInstanceOf(
				AuditDataInvalidError,
			);
		}
		// Two refusals did not consume the one-shot authorization.
		const receipt = await gov.settle(auth, { chunksDelivered: 3 });
		expect(receipt.chunksDelivered).toBe(3);

		await gov.destroy();
	});

	it("settle() refuses an unrecordable model on the caller's handle before the delete", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });

		// The Authorization is the CALLER's object and `settle` reads `model` off
		// it, so a mutation between the two phases reaches `llm_call.data.model`.
		(auth as unknown as { model: unknown }).model = Symbol("not-a-model");

		await expect(gov.settle(auth, { inputTokens: 1, outputTokens: 1 })).rejects.toBeInstanceOf(
			AuditDataInvalidError,
		);
		expect(readEvents(vaultBase).filter((e) => e.kind === "llm_call")).toHaveLength(0);

		// Repaired handle, same authorization, clean settle.
		(auth as unknown as { model: unknown }).model = "claude-sonnet-4-6";
		const receipt = await gov.settle(auth, { inputTokens: 1, outputTokens: 1 });
		expect(receipt.settled).toBe(true);

		await gov.destroy();
	});

	it("a settle that never was still refuses a dead authorization first (ordering unchanged)", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.abort(auth);

		// The liveness check must stay AHEAD of the new validation: a caller who
		// settles twice should still be told the authorization is gone, not that
		// their NaN is bad.
		await expect(gov.settle(auth, { chunksDelivered: Number.NaN })).rejects.toThrow(
			/is not active/,
		);

		await gov.destroy();
	});

	// ── governAction() ──

	it("governAction() refuses unrecordable params BEFORE the action executes, and retries clean", async () => {
		const governed = await trust(makeAnthropicMock(), {
			dryRun: true,
			budget: 10_000,
			vaultBase,
		});
		const execute = vi.fn(async () => "ran");

		await expect(
			governed.governAction(
				{ kind: "tool_use", name: "file_read", cost: 50, params: { f: () => 1 } },
				execute,
			),
		).rejects.toBeInstanceOf(AuditDataInvalidError);

		// `execute()` is the point of no return on this path — the action's side
		// effects cannot be undone, and the audit event that records it is written
		// afterwards. So the refusal has to land before the callback runs at all.
		expect(execute).toHaveBeenCalledTimes(0);
		expect(readEvents(vaultBase)).toHaveLength(0);

		const { receipt } = await governed.governAction(
			{ kind: "tool_use", name: "file_read", cost: 50, params: { path: "/etc/hosts" } },
			execute,
		);
		expect(receipt.settled).toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(readEvents(vaultBase).filter((e) => e.kind === "tool_use")).toHaveLength(1);

		await governed.destroy();
	});

	it("governAction() refuses a NaN inside params — the type-legal case a caller actually hits", async () => {
		const governed = await trust(makeAnthropicMock(), {
			dryRun: true,
			budget: 10_000,
			vaultBase,
		});
		const execute = vi.fn(async () => "ran");

		const err = await governed
			.governAction(
				{ kind: "tool_use", name: "http_get", cost: 10, params: { retries: Number.NaN } },
				execute,
			)
			.then(
				() => undefined,
				(e: unknown) => e,
			);

		expect(err).toBeInstanceOf(AuditDataInvalidError);
		expect((err as Error).message).toContain("action.params");
		expect(execute).toHaveBeenCalledTimes(0);
		expect(readEvents(vaultBase)).toHaveLength(0);

		await governed.destroy();
	});

	// ── the writer stays the backstop ──

	it("the writer still refuses unrecordable data — the boundary guard did not replace it", async () => {
		const writer = createAuditWriter(vaultBase);
		try {
			await expect(
				writer.appendEvent({ kind: "tool_use", actor: "sys", data: { n: Number.NaN } }),
			).rejects.toBeInstanceOf(AuditDataInvalidError);
		} finally {
			writer.release();
		}
	});

	it("the boundary and the writer agree BY CONSTRUCTION — same check, not two spellings", () => {
		const unrecordable: unknown[] = [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			() => 1,
			Symbol("s"),
			{ nested: { deep: [1, Number.NaN] } },
			{ nested: { fn: () => 1 } },
		];
		for (const value of unrecordable) {
			// The writer's refusal…
			expect(() => canonicalize(value)).toThrow();
			// …and the boundary's refusal, for the same input.
			expect(() => assertAuditRepresentable("some_kind", { "x.y": value })).toThrow(
				AuditDataInvalidError,
			);
		}

		// Built, not written as `[1, , 2]`: a sparse literal is a lint error, and
		// the hole is exactly the case ut1 §13 clause 1 makes recordable (→ null).
		const withHole: unknown[] = [1];
		withHole[2] = 2;
		const recordable: unknown[] = [
			undefined,
			null,
			0,
			-1,
			"",
			{ a: 1, b: [1, 2, null] },
			{ a: undefined },
			withHole,
			new Date(0),
		];
		for (const value of recordable) {
			expect(() => canonicalize(value)).not.toThrow();
			expect(() => assertAuditRepresentable("some_kind", { "x.y": value })).not.toThrow();
		}
	});

	it("the refusal names the field AND the event kind it would have been written under", () => {
		const err = (() => {
			try {
				assertAuditRepresentable("llm_call", { "SettleParams.chunksDelivered": Number.NaN });
				return undefined;
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(AuditDataInvalidError);
		expect((err as AuditDataInvalidError).eventKind).toBe("llm_call");
		expect((err as Error).message).toContain("SettleParams.chunksDelivered");
		// The writer's own wording rides through, so the two refusals read alike.
		expect((err as Error).message).toContain("NaN is not allowed in audit data");
	});
});
