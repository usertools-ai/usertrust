// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — a caller must not be able to swallow "this event can NEVER be
 * written".
 *
 * The canonicalizer fix made `appendEvent` refuse data JSON cannot represent.
 * That refusal is only worth anything if it reaches the caller: `audit.failClosed`
 * defaults to FALSE, so a `governAction({ params: { f: () => 1 } })` whose audit
 * write throws used to be swallowed by the action's `catch`, `releaseHoldAndCommit()`
 * and `cb.recordSuccess()` ran anyway, and the receipt carried the SYNTHETIC hash
 * with NO chain event behind it. Success reported over material the system could
 * not handle — the same defect, relocated from the writer to the caller.
 *
 * The distinction these tests pin is transient-failure vs caller-bug:
 *   - transient (disk full, lock contention) STAYS tolerated at best-effort sites;
 *   - `AuditDataInvalidError` is NEVER swallowed.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAuditWriter,
	isMustRecordAuditFailure,
	readAuditFailureKind,
} from "../../src/audit/chain.js";
import { trust } from "../../src/govern.js";
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

function readEvents(vaultBase: string): Record<string, unknown>[] {
	const auditPath = join(vaultBase, VAULT_DIR, "audit", "events.jsonl");
	if (!existsSync(auditPath)) return [];
	return readFileSync(auditPath, "utf-8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("HARDEN: AuditDataInvalidError is never swallowed by a caller", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = join(tmpdir(), `audit-invalid-${randomUUID()}`);
		mkdirSync(tmpVault, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpVault, { recursive: true, force: true });
	});

	it("the writer throws AuditDataInvalidError, tagged with the event kind", async () => {
		const writer = createAuditWriter(tmpVault);
		try {
			const err = await writer
				.appendEvent({ kind: "tool_use", actor: "sys", data: { params: { f: () => 1 } } })
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			expect(err).toBeInstanceOf(AuditDataInvalidError);
			expect((err as AuditDataInvalidError).eventKind).toBe("tool_use");
			// The shaping a follow-up needs: the kind rides on the error, so
			// promoting a kind to must-record edits one predicate, not 20 catches.
			expect(readAuditFailureKind(err)).toBe("tool_use");
			expect(isMustRecordAuditFailure(err)).toBe(true);
			expect(isMustRecordAuditFailure(new Error("ENOSPC: no space left on device"))).toBe(false);
		} finally {
			writer.release();
		}
	});

	it("a TRANSIENT append failure keeps riding the kind tag without becoming must-record", async () => {
		const writer = createAuditWriter(tmpVault);
		try {
			await writer.appendEvent({ kind: "seed", actor: "sys", data: { ok: true } });
			// An I/O failure, not a data failure: the log's directory disappears
			// under the writer. This is precisely the class `.catch(() => {})` was
			// written to tolerate, and it must NOT be promoted to must-record.
			rmSync(join(tmpVault, VAULT_DIR, "audit"), { recursive: true, force: true });

			const err = await writer.appendEvent({ kind: "llm_call", actor: "sys", data: { n: 1 } }).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(Error);
			expect(err).not.toBeInstanceOf(AuditDataInvalidError);
			expect(isMustRecordAuditFailure(err)).toBe(false);
			// Still tagged, so a follow-up promoting `llm_call` to must-record has
			// the kind available on a transient failure too — no re-plumbing.
			expect(readAuditFailureKind(err)).toBe("llm_call");
		} finally {
			writer.release();
		}
	});

	it("governAction REJECTS unrepresentable params and never settles (failClosed FALSE)", async () => {
		const governed = await trust(makeAnthropicMock(), {
			dryRun: true,
			budget: 10_000,
			vaultBase: tmpVault,
		});

		const execute = vi.fn(async () => "ran");

		await expect(
			governed.governAction(
				{ kind: "tool_use", name: "file_read", cost: 50, params: { f: () => 1 } },
				execute,
			),
		).rejects.toBeInstanceOf(AuditDataInvalidError);

		// The action body DID run — the audit event is written after execution —
		// but the call must not report success over an event that can never exist.
		expect(execute).toHaveBeenCalledTimes(1);

		const events = readEvents(tmpVault);
		// No `tool_use` event: the refusal is the whole point.
		expect(events.filter((e) => e.kind === "tool_use")).toHaveLength(0);
		// And the failure IS on the chain, so the refusal is not itself silent.
		expect(events.filter((e) => e.kind === "tool_use_failed").length).toBeGreaterThan(0);

		await governed.destroy();
	});

	it("an ordinary action still settles — the narrowing did not fail-close everything", async () => {
		const governed = await trust(makeAnthropicMock(), {
			dryRun: true,
			budget: 10_000,
			vaultBase: tmpVault,
		});

		const { receipt } = await governed.governAction(
			{ kind: "tool_use", name: "file_read", cost: 50, params: { path: "/etc/hosts" } },
			async () => "contents",
		);
		expect(receipt.settled).toBe(true);
		expect(readEvents(tmpVault).filter((e) => e.kind === "tool_use")).toHaveLength(1);

		await governed.destroy();
	});
});
