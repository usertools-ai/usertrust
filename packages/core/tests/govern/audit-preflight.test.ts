// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `audit.failClosed`: a vault whose next audit append would be refused is refused BEFORE the hold and
 * before the provider is called, never after the money moved. The pre-flight runs the append's own
 * classification of the tail, under the writer's mutex and lock, at every governed entry point:
 * `trust()`'s calls (non-streaming and streaming) and actions, and now headless `authorize()`. Without
 * `failClosed` (the default) the call settles as before, its event refused and dead-lettered, and its
 * receipt carries `auditDegraded`.
 *
 * The rows use the REAL shared writer (only the ledger engine is a spy), a truncation made while that
 * writer is warm: the case a cached tail would have answered from memory.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AuditTailMismatchError,
	AuditWriterLockHeldError,
	createAuditWriter,
} from "../../src/audit/chain.js";
import { verifyVault } from "../../src/audit/verify.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { AuditDegradedError } from "../../src/shared/errors.js";

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

const VAULT_DIR = ".usertrust";
let vault: string;
const warnings: string[] = [];
const onWarning = (w: Error & { code?: string }) => {
	if (w.code === "USERTRUST_AUDIT_DEGRADED") warnings.push(w.message);
};

beforeEach(() => {
	vault = join(tmpdir(), `audit-preflight-${randomUUID()}`);
	mkdirSync(vault, { recursive: true });
	warnings.length = 0;
	process.on("warning", onWarning);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	process.off("warning", onWarning);
	vi.restoreAllMocks();
	rmSync(vault, { recursive: true, force: true });
});

const logPath = () => join(vault, VAULT_DIR, "audit", "events.jsonl");

function writeConfig(failClosed: boolean): void {
	mkdirSync(join(vault, VAULT_DIR), { recursive: true, mode: 0o700 });
	writeFileSync(
		join(vault, VAULT_DIR, "usertrust.config.json"),
		JSON.stringify({ budget: 500_000, audit: { failClosed } }),
	);
}

function makeEngine() {
	return {
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => ({
			transferId: p.transferId,
		})),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	} satisfies TrustEngine;
}

function makeProvider() {
	return {
		messages: {
			create: vi.fn(async (_request: Record<string, unknown>) => ({
				id: "m",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: { input_tokens: 10, output_tokens: 5 },
			})),
		},
	};
}

const ask = {
	model: "claude-sonnet-4-6",
	max_tokens: 64,
	messages: [{ role: "user", content: "hi" }],
};

/** Cut the log's last line away, the anchor kept: the next append's classification is FEWER_THAN_ANCHOR. */
function truncateOneEvent(): Buffer {
	const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
	writeFileSync(logPath(), `${lines.slice(0, -1).join("\n")}\n`);
	return readFileSync(logPath());
}

/** The refusal names the pre-flight's own classification. */
function expectPreflightRefusal(err: unknown): void {
	expect(err).toBeInstanceOf(AuditDegradedError);
	const cause = (err as Error).cause;
	expect(cause).toBeInstanceOf(AuditTailMismatchError);
	expect((cause as AuditTailMismatchError).state).toBe("FEWER_THAN_ANCHOR");
	expect((err as Error).message).toMatch(/refused before any hold/);
}

describe("under audit.failClosed, a refused tail refuses every governed entry point BEFORE the hold", () => {
	it("trust(): a call, a stream and an action are each refused with no hold, no provider call, no void, and nothing written", async () => {
		writeConfig(true);
		const engine = makeEngine();
		const provider = makeProvider();
		const governed = await trust(provider, { dryRun: false, vaultBase: vault, _engine: engine });
		try {
			await governed.messages.create(ask);
			await governed.messages.create(ask);
			const log = truncateOneEvent();
			const holds = engine.spendPending.mock.calls.length;
			const calls = provider.messages.create.mock.calls.length;
			const execute = vi.fn(async () => "ran");

			for (const attempt of [
				() => governed.messages.create(ask),
				() => governed.messages.create({ ...ask, stream: true }),
				() => governed.governAction({ kind: "tool_use", name: "t", cost: 5 }, execute),
			]) {
				const err = await attempt().then(
					() => undefined,
					(e: unknown) => e,
				);
				expectPreflightRefusal(err);
			}
			expect(engine.spendPending.mock.calls.length, "no hold").toBe(holds);
			expect(provider.messages.create.mock.calls.length, "no provider call").toBe(calls);
			expect(execute, "the action never ran").not.toHaveBeenCalled();
			expect(engine.voidPendingSpend, "nothing to void").not.toHaveBeenCalled();
			expect(readFileSync(logPath()), "nothing written").toEqual(log);
		} finally {
			await governed.destroy();
		}
	});

	it("headless authorize(): refused before the hold (failClosed now applies here too)", async () => {
		writeConfig(true);
		const engine = makeEngine();
		const gov = await createGovernor({ vaultBase: vault, _engine: engine });
		try {
			for (let i = 0; i < 2; i++) {
				const hold = await gov.authorize({ model: "gpt-4o", estimatedInputTokens: 10 });
				await gov.settle(hold, { inputTokens: 10, outputTokens: 5 });
			}
			const log = truncateOneEvent();
			const holds = engine.spendPending.mock.calls.length;
			const err = await gov.authorize({ model: "gpt-4o", estimatedInputTokens: 10 }).then(
				() => undefined,
				(e: unknown) => e,
			);
			expectPreflightRefusal(err);
			expect(engine.spendPending.mock.calls.length, "no hold").toBe(holds);
			expect(readFileSync(logPath())).toEqual(log);
		} finally {
			await gov.destroy();
		}
	});

	it("another writer holding the vault: refused before the hold, the lock's refusal as the cause", async () => {
		writeConfig(true);
		const engine = makeEngine();
		const provider = makeProvider();
		// A writer that is not this governor's (its own lock, taken at creation), as a second process holds one.
		const other = createAuditWriter(vault, { lockAtCreate: true });
		const governed = await trust(provider, { dryRun: false, vaultBase: vault, _engine: engine });
		try {
			const err = await governed.messages.create(ask).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(AuditDegradedError);
			expect((err as Error).cause).toBeInstanceOf(AuditWriterLockHeldError);
			expect(engine.spendPending, "no hold").not.toHaveBeenCalled();
			expect(provider.messages.create, "no provider call").not.toHaveBeenCalled();
		} finally {
			await governed.destroy();
			other.release();
		}
	});

	it("CONTROL: the same vault with its tail intact is served: the pre-flight passes a MATCH", async () => {
		writeConfig(true);
		const engine = makeEngine();
		const provider = makeProvider();
		const governed = await trust(provider, { dryRun: false, vaultBase: vault, _engine: engine });
		try {
			await governed.messages.create(ask);
			const r = await governed.messages.create(ask);
			expect(r.receipt.auditDegraded).toBeUndefined();
			expect(engine.spendPending).toHaveBeenCalledTimes(2);
		} finally {
			await governed.destroy();
		}
	});
});

describe("without failClosed, the call settles, its append is refused, and it says so", () => {
	it("trust(): the receipt carries auditDegraded, one degraded warning, nothing written, and verify fails", async () => {
		writeConfig(false);
		const engine = makeEngine();
		const governed = await trust(makeProvider(), {
			dryRun: false,
			vaultBase: vault,
			_engine: engine,
		});
		try {
			await governed.messages.create(ask);
			await governed.messages.create(ask);
			const log = truncateOneEvent();
			const r = await governed.messages.create(ask);
			expect(r.receipt.auditDegraded).toBe(true);
			expect(r.receipt.auditHash).toBe("AUDIT_DEGRADED");
			expect(readFileSync(logPath()), "nothing appended over the truncation").toEqual(log);
		} finally {
			await governed.destroy();
		}
		expect(warnings.filter((w) => /failing: AuditTailMismatchError/.test(w))).toHaveLength(1);
		expect(verifyVault(join(vault, VAULT_DIR)).valid).toBe(false);
	});
});
