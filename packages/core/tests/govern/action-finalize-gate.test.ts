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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { AuditDegradedError } from "../../src/shared/errors.js";
import type { ActionDescriptor, AuditEvent } from "../../src/shared/types.js";

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
	let stderr: MockInstance<typeof process.stderr.write>;
	beforeEach(() => {
		vault = join(tmpdir(), `action-finalize-gate-${randomUUID()}`);
		mkdirSync(join(vault, ".usertrust"), { recursive: true });
		stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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

	// ── The window between the settle claim and the POST must not throw ──
	// The claim sits before the budget commit, the session-spend persist and the breaker's
	// success, on both paths: a throw in that window would leave the hold neither posted nor
	// voided. The one step there that touches the filesystem is the session-spend persist, which
	// catches its own failures. These rows make that persist fail for real — a DIRECTORY where
	// spend-ledger.json must be written, placed after the client opened its vault — and pin that
	// the hold is still posted once and never voided.

	/** The persist failed through its own code path: its stderr line, not a mock, is the proof. */
	const persistFailed = () =>
		stderr.mock.calls.some((c) => String(c[0]).includes("spend ledger write FAILED"));
	const occupySpendLedger = () =>
		mkdirSync(join(vault, ".usertrust", "spend-ledger.json"), { recursive: true });

	it("governAction: the session-spend persist fails inside the window; the hold is still posted once, never voided", async () => {
		const { engine, held, posted, voided } = recordingEngine();
		const client = await governed(true, engine, makeAudit());
		occupySpendLedger();
		const run = vi.fn(async () => "ran");

		const result = await outcome(client.governAction(ACTION, run));

		expect(persistFailed()).toBe(true);
		expect(result).not.toBeInstanceOf(Error);
		const { receipt } = result as { receipt: { settled: boolean; transferId: string } };
		expect(receipt.settled).toBe(true);
		expect(held).toEqual([receipt.transferId]);
		expect(posted).toEqual(held);
		expect(voided).toEqual([]);
		await client.destroy();
	});

	it("an LLM call: the session-spend persist fails inside the window; the hold is still posted once, never voided", async () => {
		writeFileSync(
			join(vault, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 500_000, audit: { failClosed: true } }),
		);
		const { engine, held, posted, voided } = recordingEngine();
		const client = await trust(
			{
				messages: {
					create: vi.fn(async (_params: unknown) => ({
						id: "m",
						usage: { input_tokens: 10, output_tokens: 5 },
					})),
				},
			},
			{ dryRun: false, vaultBase: vault, _engine: engine, _audit: makeAudit() },
		);
		occupySpendLedger();

		const result = await outcome(
			client.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		expect(persistFailed()).toBe(true);
		expect(result).not.toBeInstanceOf(Error);
		const { receipt } = result as { receipt: { settled: boolean; transferId: string } };
		expect(receipt.settled).toBe(true);
		expect(held).toEqual([receipt.transferId]);
		expect(posted).toEqual(held);
		expect(voided).toEqual([]);
		await client.destroy();
	});

	// ── The caller's descriptor is read ONCE ──
	// governAction reads its descriptor before the hold and again after execute() and after the
	// settle claim. A later read of a live descriptor could throw inside the window above, or see a
	// cost the hold was never sized for. These rows pin that every read uses the first one.

	/** What the governor appended for the action itself (the settlement-defining event). */
	const actionEvents = (audit: AuditWriter) =>
		vi
			.mocked(audit.appendEvent)
			.mock.calls.map((c) => c[0])
			.filter((e) => e.kind !== "tool_use_failed");

	it("a cost getter that throws after its first read: the hold is posted once at the first value, never voided", async () => {
		const { engine, held, posted, voided } = recordingEngine();
		const audit = makeAudit();
		const client = await governed(true, engine, audit);
		let reads = 0;
		const descriptor = {
			kind: ACTION.kind,
			name: ACTION.name,
			get cost(): number {
				reads++;
				if (reads > 1) throw new Error("cost read twice");
				return 25;
			},
		};
		const run = vi.fn(async () => "ran");

		const result = await outcome(client.governAction(descriptor, run));

		expect(result).not.toBeInstanceOf(Error);
		expect(run).toHaveBeenCalledOnce();
		expect(reads).toBe(1);
		expect(vi.mocked(engine.spendPending).mock.calls.map((c) => c[0].amount)).toEqual([25]);
		expect(vi.mocked(engine.postPendingSpend).mock.calls).toEqual([[held[0], 25]]);
		expect(posted).toEqual(held);
		expect(voided).toEqual([]);
		await client.destroy();
	});

	it("execute() raises the descriptor's cost: the hold, commit, POST, receipt, audit and session spend all keep the original", async () => {
		const { engine, held, posted, voided } = recordingEngine();
		const audit = makeAudit();
		const client = await governed(true, engine, audit);
		const descriptor = { ...ACTION };
		const run = vi.fn(async () => {
			descriptor.cost = 999;
			return "ran";
		});

		const result = await outcome(client.governAction(descriptor, run));

		expect(result).not.toBeInstanceOf(Error);
		const { receipt } = result as {
			receipt: { cost: number; transferId: string; budgetRemaining: number };
		};
		expect(vi.mocked(engine.spendPending).mock.calls.map((c) => c[0].amount)).toEqual([25]);
		expect(vi.mocked(engine.postPendingSpend).mock.calls).toEqual([[receipt.transferId, 25]]);
		expect(posted).toEqual(held);
		expect(voided).toEqual([]);
		expect(receipt.cost).toBe(25);
		expect(actionEvents(audit).map((e) => (e.data as { cost?: number }).cost)).toEqual([25]);
		expect(receipt.budgetRemaining).toBe(500_000 - 25);
		const ledger = JSON.parse(
			readFileSync(join(vault, ".usertrust", "spend-ledger.json"), "utf-8"),
		) as { budgetSpent: number };
		expect(ledger.budgetSpent).toBe(25);
		await client.destroy();
	});

	it("execute() renames the descriptor's name and kind: the audit event and the receipt keep the originals", async () => {
		const { engine } = recordingEngine();
		const audit = makeAudit();
		const client = await governed(true, engine, audit);
		const descriptor: ActionDescriptor = { ...ACTION };
		const run = vi.fn(async () => {
			descriptor.name = "renamed";
			descriptor.kind = "shell_command";
			return "ran";
		});

		const result = await outcome(client.governAction(descriptor, run));

		expect(result).not.toBeInstanceOf(Error);
		const events = actionEvents(audit);
		expect(events.map((e) => e.kind)).toEqual(["tool_use"]);
		expect(events.map((e) => (e.data as { actionName?: string }).actionName)).toEqual(["search"]);
		const { receipt } = result as { receipt: { model?: string; actionKind?: string } };
		expect(receipt.model).toBe("search");
		expect(receipt.actionKind).toBe("tool_use");
		await client.destroy();
	});

	// ── A descriptor getter that destroys the client ──
	// The snapshot reads the caller's getters after the first `destroyed` check; a getter can call
	// destroy() there. destroy() marks the client destroyed synchronously, before its first await.

	it("a name getter that destroys the client: rejected as destroyed, the action never runs, nothing is held", async () => {
		const { engine, held, posted, voided } = recordingEngine();
		const client = await governed(true, engine, makeAudit());
		let destroying: Promise<void> | undefined;
		const descriptor = {
			kind: ACTION.kind,
			get name(): string {
				// Not awaited: destroy() waits for in-flight calls.
				destroying ??= client.destroy();
				return ACTION.name;
			},
			cost: ACTION.cost,
		};
		const run = vi.fn(async () => "ran");

		const err = await outcome(client.governAction(descriptor, run));
		await destroying;

		expect(destroying).toBeDefined();
		expect(run).not.toHaveBeenCalled();
		expect(held).toEqual([]);
		expect(posted).toEqual([]);
		expect(voided).toEqual([]);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("TrustedClient has been destroyed");
	});

	it("destroyed while its writer is already degraded under failClosed: rejected as destroyed, not as degraded, and nothing is touched", async () => {
		// The destroyed re-check runs before the degraded-at-start refusal: a destroyed client
		// reports that it was destroyed, and appends no audit event, holds nothing, runs nothing.
		const { engine, held, posted, voided } = recordingEngine();
		const audit = makeAudit({ failKinds: ["earlier"] });
		await audit.appendEvent({ kind: "earlier", actor: "local", data: {} }).catch(() => {});
		expect(audit.isDegraded()).toBe(true);
		vi.mocked(audit.appendEvent).mockClear();
		const client = await governed(true, engine, audit);
		let destroying: Promise<void> | undefined;
		const descriptor = {
			kind: ACTION.kind,
			get name(): string {
				// Not awaited: destroy() waits for in-flight calls.
				destroying ??= client.destroy();
				return ACTION.name;
			},
			cost: ACTION.cost,
		};
		const run = vi.fn(async () => "ran");

		const err = await outcome(client.governAction(descriptor, run));
		await destroying;

		expect(destroying).toBeDefined();
		expect(err).not.toBeInstanceOf(AuditDegradedError);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("TrustedClient has been destroyed");
		expect(run).not.toHaveBeenCalled();
		expect(audit.appendEvent).not.toHaveBeenCalled();
		expect(held).toEqual([]);
		expect(posted).toEqual([]);
		expect(voided).toEqual([]);
	});

	it("CONTROL, an ordinary descriptor: the action runs and its hold is posted once", async () => {
		const { engine, held, posted, voided } = recordingEngine();
		const client = await governed(true, engine, makeAudit());
		const run = vi.fn(async () => "ran");

		const result = await outcome(client.governAction({ ...ACTION }, run));

		expect(result).not.toBeInstanceOf(Error);
		expect(run).toHaveBeenCalledOnce();
		expect(held).toHaveLength(1);
		expect(posted).toEqual(held);
		expect(voided).toEqual([]);
		await client.destroy();
	});
});
