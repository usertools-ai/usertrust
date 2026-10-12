// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A2 on the action path: `governAction` settles XOR voids its hold, like the LLM path.
 *
 * Under `audit.failClosed`, the post-settle belt check can refuse an action AFTER its budget
 * commit and ledger POST. That refusal reaches the outer catch, which used to void the hold
 * unconditionally — a void request against a transfer it had just posted. TigerBeetle answers
 * such a void with `pending_transfer_already_posted` and moves nothing, so the money was right,
 * but the governor sent a void the ledger had to reject, and a ledger without that guard would
 * have released a settled charge. A throw BEFORE the settle claim still voids exactly once.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { AuditDegradedError } from "../../src/shared/errors.js";
import type { AuditEvent } from "../../src/shared/types.js";

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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const ACTION = { kind: "tool_use" as const, name: "search", cost: 25 };

/** An engine that records the transfer ids it holds, posts and voids. */
function recordingEngine(opts: { failPost?: boolean } = {}) {
	const held: string[] = [];
	const posted: string[] = [];
	const voided: string[] = [];
	const engine: TrustEngine = {
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
			held.push(p.transferId);
			return { transferId: p.transferId };
		}),
		postPendingSpend: vi.fn(async (transferId: string) => {
			if (opts.failPost === true) throw new Error("ledger POST failed");
			posted.push(transferId);
		}),
		voidPendingSpend: vi.fn(async (transferId: string) => {
			voided.push(transferId);
		}),
		destroy: vi.fn(),
	};
	return { engine, held, posted, voided };
}

/**
 * An audit writer, healthy when the action starts.
 * - `degradeOnAppend`: every append succeeds, and the writer reports degraded from the first one
 *   on — it degrades DURING the action, after its own audit event landed.
 * - `failKinds`: appends of these kinds fail, and the writer is degraded from then on.
 */
function makeAudit(opts: { degradeOnAppend?: boolean; failKinds?: string[] } = {}): AuditWriter {
	let degraded = false;
	return {
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			if (opts.failKinds?.includes(input.kind) === true) {
				degraded = true;
				throw new Error("Audit disk full");
			}
			if (opts.degradeOnAppend === true) degraded = true;
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		}),
		getWriteFailures: vi.fn(() => (degraded ? 1 : 0)),
		isDegraded: vi.fn(() => degraded),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

/** Each outcome is captured, so a call that does not reject fails an assertion, not the test. */
const outcome = <T>(p: Promise<T>): Promise<T | unknown> =>
	p.then(
		(v) => v,
		(err: unknown) => err,
	);

describe("A2 on the action path: governAction settles XOR voids its hold", () => {
	let vault: string;
	beforeEach(() => {
		vault = join(tmpdir(), `action-finalize-gate-${randomUUID()}`);
		mkdirSync(join(vault, ".usertrust"), { recursive: true });
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(vault, { recursive: true, force: true });
	});

	async function governed(failClosed: boolean, engine: TrustEngine, audit: AuditWriter) {
		writeFileSync(
			join(vault, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 500_000, audit: { failClosed } }),
		);
		return trust(
			{ messages: { create: vi.fn() } },
			{ dryRun: false, vaultBase: vault, _engine: engine, _audit: audit },
		);
	}

	it("failClosed, the writer degrades on the action's own append: the hold is posted once and never voided", async () => {
		const { engine, held, posted, voided } = recordingEngine();
		const client = await governed(true, engine, makeAudit({ degradeOnAppend: true }));
		const run = vi.fn(async () => "ran");

		const err = await outcome(client.governAction(ACTION, run));

		expect(err).toBeInstanceOf(AuditDegradedError);
		expect(run).toHaveBeenCalledOnce();
		expect(held).toHaveLength(1);
		expect(posted).toEqual(held);
		expect(voided).toEqual([]);
		await client.destroy();
	});

	it("failClosed, the POST fails (ambiguous) and the belt refuses: the hold is never voided", async () => {
		// The POST may still have landed, so the settlement is ambiguous, not failed: the
		// `settlement_ambiguous` event records it and the hold is left for reconciliation, as on
		// the LLM path. That event's own append failing is what trips the belt here.
		const { engine, held, posted, voided } = recordingEngine({ failPost: true });
		const client = await governed(true, engine, makeAudit({ failKinds: ["settlement_ambiguous"] }));
		const run = vi.fn(async () => "ran");

		const err = await outcome(client.governAction(ACTION, run));

		expect(err).toBeInstanceOf(AuditDegradedError);
		expect(run).toHaveBeenCalledOnce();
		expect(held).toHaveLength(1);
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(posted).toEqual([]);
		expect(voided).toEqual([]);
		await client.destroy();
	});

	it("CONTROL, the action throws: the hold is voided exactly once and never posted", async () => {
		const { engine, held, posted, voided } = recordingEngine();
		const client = await governed(true, engine, makeAudit());
		const own = new Error("the action failed");
		const run = vi.fn(async () => {
			throw own;
		});

		const err = await outcome(client.governAction(ACTION, run));

		expect(err).toBe(own);
		expect(held).toHaveLength(1);
		expect(posted).toEqual([]);
		expect(voided).toEqual(held);
		await client.destroy();
	});

	it("CONTROL, failClosed and the action's own audit append fails: the hold is voided exactly once and never posted", async () => {
		const { engine, held, posted, voided } = recordingEngine();
		const client = await governed(true, engine, makeAudit({ failKinds: [ACTION.kind] }));
		const run = vi.fn(async () => "ran");

		const err = await outcome(client.governAction(ACTION, run));

		expect(err).toBeInstanceOf(AuditDegradedError);
		expect(run).toHaveBeenCalledOnce();
		expect(held).toHaveLength(1);
		expect(posted).toEqual([]);
		expect(voided).toEqual(held);
		await client.destroy();
	});

	it("CONTROL, a healthy run: the hold is posted once and never voided", async () => {
		const { engine, held, posted, voided } = recordingEngine();
		const client = await governed(true, engine, makeAudit());
		const run = vi.fn(async () => "ran");

		const { result, receipt } = await client.governAction(ACTION, run);

		expect(result).toBe("ran");
		expect(receipt.settled).toBe(true);
		expect(held).toEqual([receipt.transferId]);
		expect(posted).toEqual(held);
		expect(voided).toEqual([]);
		await client.destroy();
	});
});
