// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Under `audit.failClosed`, a client whose audit writer is ALREADY degraded when a call starts
 * refuses that call before it does anything: no hold, no provider call, no spend, no audit append.
 *
 * A handle's degraded state is whole-life: once one of its audit writes has failed it stays degraded
 * until the client is destroyed and recreated, so every later call on it was always going to be
 * refused. Before this, such a call still placed its hold, reached the provider, settled — and only
 * then did the post-settle check refuse it, after the charge had posted.
 *
 * The writer here is the shipped one, degraded the way a real client degrades: another process takes
 * the vault's writer lock while the first call is at its provider (the parent PID stands in for it),
 * so that call's audit writes fail. (A lock held already when a call STARTS refuses the call at the
 * audit pre-flight, before its hold, and degrades nothing: that call wrote nothing, so no audit write
 * failed. The last row says so.) The lock is then let go, so a later call COULD append — which is
 * what makes "nothing reached the chain" a claim this suite can fail on.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TrustEngine, trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const CHUNKS = [
	{ type: "message_start", message: { usage: { input_tokens: 100 } } },
	{ type: "content_block_delta", delta: { text: "ok" } },
	{ type: "message_delta", usage: { output_tokens: 30 } },
];

/** The request shape the provider double accepts: a Messages request, streamed or not. */
interface MessagesRequest {
	model: string;
	max_tokens: number;
	messages: Array<{ role: string; content: string }>;
	stream?: boolean;
}

const REQUEST: MessagesRequest = {
	model: "claude-sonnet-4-6",
	max_tokens: 64,
	messages: [{ role: "user", content: "hi" }],
};

const ACTION = { kind: "tool_use" as const, name: "search", cost: 25 };

/** An Anthropic-shaped provider: a response, or a stream when the request asks for one. */
function provider() {
	return {
		messages: {
			create: vi.fn(async (params: MessagesRequest) => {
				if (params.stream === true) {
					async function* gen() {
						for (const c of CHUNKS) yield c;
					}
					return gen();
				}
				return { id: "m", usage: { input_tokens: 10, output_tokens: 5 } };
			}),
		},
	};
}

function makeEngine(): TrustEngine {
	return {
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => ({
			transferId: p.transferId,
		})),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

/** Each outcome is captured, so that a call which does not refuse fails an assertion, not the test. */
const outcome = <T>(p: Promise<T>): Promise<T | unknown> =>
	p.then(
		(v) => v,
		(err: unknown) => err,
	);

describe("audit.failClosed: a client already degraded refuses a call before it is charged", () => {
	let vault: string;
	const auditDir = () => join(vault, VAULT_DIR, "audit");
	const lockPath = () => join(auditDir(), ".audit-writer.lock");
	const chainPath = () => join(auditDir(), "events.jsonl");
	const deadLetterPath = () => join(vault, VAULT_DIR, "dlq", "dead-letters.jsonl");
	const spendLedgerPath = () => join(vault, VAULT_DIR, "spend-ledger.json");
	const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf-8") : "");
	/** Everything a call can leave behind on disk: the chain, the dead letters, the session spend. */
	const disk = () => ({
		chain: read(chainPath()),
		deadLetters: read(deadLetterPath()),
		spend: read(spendLedgerPath()),
	});

	beforeEach(() => {
		vault = join(tmpdir(), `failclosed-before-charge-${randomUUID()}`);
		mkdirSync(join(vault, VAULT_DIR), { recursive: true });
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(vault, { recursive: true, force: true });
	});

	function heldByAnotherProcess(): void {
		mkdirSync(auditDir(), { recursive: true });
		writeFileSync(
			lockPath(),
			JSON.stringify({ pid: process.ppid, startedAt: "2020-01-01T00:00:00Z" }),
		);
	}

	/**
	 * A client whose writer one earlier call degraded: that call's audit writes failed on a lock
	 * another process took while the call was at its provider. `releaseLock` then lets go of it, so
	 * the writer could append again — but the handle stays degraded for the rest of the client's life.
	 */
	async function degradedClient(failClosed: boolean, releaseLock: boolean) {
		writeFileSync(
			join(vault, VAULT_DIR, "usertrust.config.json"),
			JSON.stringify({ budget: 500_000, audit: { failClosed } }),
		);
		const client = provider();
		const answer = client.messages.create.getMockImplementation();
		if (answer === undefined) throw new Error("the provider mock has no implementation");
		client.messages.create.mockImplementationOnce(async (params: MessagesRequest) => {
			heldByAnotherProcess();
			return answer(params);
		});
		const engine = makeEngine();
		const governed = await trust(client, {
			dryRun: false,
			vaultBase: vault,
			_engine: engine,
		});
		const earlier = await outcome(governed.messages.create(REQUEST));
		if (failClosed) expect(earlier).toBeInstanceOf(AuditDegradedError);
		if (releaseLock) rmSync(lockPath());
		// What the earlier call did, so each row asserts only what ITS call does.
		const before = {
			provider: client.messages.create.mock.calls.length,
			holds: vi.mocked(engine.spendPending).mock.calls.length,
			posts: vi.mocked(engine.postPendingSpend).mock.calls.length,
			voids: vi.mocked(engine.voidPendingSpend).mock.calls.length,
			disk: disk(),
		};
		return { governed, client, engine, before };
	}

	type Degraded = Awaited<ReturnType<typeof degradedClient>>;

	/**
	 * The call touched nothing: no provider call, no hold, no settle, no void, nothing on disk.
	 * Soft, so a call that was charged reports everything it did, not only the first of it.
	 */
	function expectUntouched({ client, engine, before }: Degraded): void {
		expect.soft(client.messages.create.mock.calls.length, "provider calls").toBe(before.provider);
		expect.soft(vi.mocked(engine.spendPending).mock.calls.length, "holds").toBe(before.holds);
		expect.soft(vi.mocked(engine.postPendingSpend).mock.calls.length, "posts").toBe(before.posts);
		expect.soft(vi.mocked(engine.voidPendingSpend).mock.calls.length, "voids").toBe(before.voids);
		expect.soft(disk().chain, "audit chain").toBe(before.disk.chain);
		expect.soft(disk().deadLetters, "dead letters").toBe(before.disk.deadLetters);
		expect.soft(disk().spend, "session spend").toBe(before.disk.spend);
	}

	function expectRefusedBeforeCharge(err: unknown): void {
		expect(err).toBeInstanceOf(AuditDegradedError);
		const message = (err as AuditDegradedError).cause_message;
		expect(message).toMatch(/refused before it (reached the provider|ran)/);
		expect(message).toContain("nothing was charged");
		expect(message).toMatch(/degraded since an earlier audit write failed/);
		expect(message).toMatch(/recreate the client/i);
	}

	it("a non-streamed call is refused before the provider, the hold, the spend and the chain", async () => {
		const degraded = await degradedClient(true, true);
		const err = await outcome(degraded.governed.messages.create(REQUEST));
		expectUntouched(degraded);
		expectRefusedBeforeCharge(err);
		await degraded.governed.destroy();
	});

	it("a streamed call is refused the same way, before any stream exists", async () => {
		const degraded = await degradedClient(true, true);
		const result = await outcome(degraded.governed.messages.create({ ...REQUEST, stream: true }));
		let err: unknown = result;
		if (!(result instanceof Error)) {
			// The code before the fix returns a stream: drain it, so its settlement runs and the
			// assertions below report what it charged.
			const stream = (
				result as { response: AsyncIterable<unknown> & { receipt: Promise<unknown> } }
			).response;
			err = await outcome(
				(async () => {
					for await (const _ of stream) {
						// drain
					}
					return stream.receipt;
				})(),
			);
		}
		expectUntouched(degraded);
		expectRefusedBeforeCharge(err);
		await degraded.governed.destroy();
	});

	it("governAction is refused the same way, and the action never runs", async () => {
		const degraded = await degradedClient(true, true);
		const run = vi.fn(async () => "ran");
		const err = await outcome(degraded.governed.governAction(ACTION, run));
		expect.soft(run, "the action").not.toHaveBeenCalled();
		expectUntouched(degraded);
		expectRefusedBeforeCharge(err);
		await degraded.governed.destroy();
	});

	it("the writer degrades DURING a call: that call reached the provider, and its hold was placed and voided", async () => {
		// The earlier call in `degradedClient` IS this case: healthy at its start, its llm_call write
		// fails. The new check must not fire on it; the existing in-call refusal still does.
		const degraded = await degradedClient(true, false);
		expect(degraded.before.provider).toBe(1);
		expect(degraded.before.holds).toBe(1);
		expect(degraded.before.posts).toBe(0);
		expect(degraded.before.voids).toBe(1);
		await degraded.governed.destroy();
	});

	it("CONTROL, failClosed off: the same degraded client still runs the call, and its receipt says so", async () => {
		const degraded = await degradedClient(false, false);
		const result = await outcome(degraded.governed.messages.create(REQUEST));
		expect(result).not.toBeInstanceOf(Error);
		const { receipt } = result as { receipt: { settled: boolean; auditDegraded?: boolean } };
		expect(receipt.settled).toBe(true);
		expect(receipt.auditDegraded).toBe(true);
		expect(degraded.client.messages.create.mock.calls.length).toBe(degraded.before.provider + 1);
		expect(vi.mocked(degraded.engine.spendPending).mock.calls.length).toBe(
			degraded.before.holds + 1,
		);
		expect(vi.mocked(degraded.engine.postPendingSpend).mock.calls.length).toBe(
			degraded.before.posts + 1,
		);
		await degraded.governed.destroy();
	});

	it("CONTROL, failClosed off: governAction on the degraded client still runs the action", async () => {
		const degraded = await degradedClient(false, false);
		const run = vi.fn(async () => "ran");
		const result = await outcome(degraded.governed.governAction(ACTION, run));
		expect(result).not.toBeInstanceOf(Error);
		expect(run).toHaveBeenCalledOnce();
		await degraded.governed.destroy();
	});

	it("a lock already held when a call starts: refused at the audit pre-flight, before its hold, and the client is NOT degraded", async () => {
		writeFileSync(
			join(vault, VAULT_DIR, "usertrust.config.json"),
			JSON.stringify({ budget: 500_000, audit: { failClosed: true } }),
		);
		heldByAnotherProcess();
		const client = provider();
		const engine = makeEngine();
		const governed = await trust(client, { dryRun: false, vaultBase: vault, _engine: engine });
		const refused = await outcome(governed.messages.create(REQUEST));
		expect(refused).toBeInstanceOf(AuditDegradedError);
		expect((refused as Error).message).toMatch(/refused before any hold/);
		expect(client.messages.create).not.toHaveBeenCalled();
		expect(engine.spendPending).not.toHaveBeenCalled();
		// Nothing was written, so no audit write failed: once the lock is let go, the next call runs.
		rmSync(lockPath());
		const next = await outcome(governed.messages.create(REQUEST));
		expect(next, "the next call, once the lock is let go").not.toBeInstanceOf(Error);
		const { receipt } = next as { receipt: { settled: boolean; transferId: string } };
		expect(receipt.settled).toBe(true);
		expect(read(chainPath())).toContain(receipt.transferId);
		await governed.destroy();
	});

	it("CONTROL, writer healthy under failClosed: the call runs, settles and reaches the chain", async () => {
		writeFileSync(
			join(vault, VAULT_DIR, "usertrust.config.json"),
			JSON.stringify({ budget: 500_000, audit: { failClosed: true } }),
		);
		const client = provider();
		const engine = makeEngine();
		const governed = await trust(client, { dryRun: false, vaultBase: vault, _engine: engine });
		const { receipt } = await governed.messages.create(REQUEST);
		expect(receipt.settled).toBe(true);
		expect(receipt.auditDegraded).not.toBe(true);
		expect(client.messages.create).toHaveBeenCalledOnce();
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(read(chainPath())).toContain(receipt.transferId);
		const run = vi.fn(async () => "ran");
		await governed.governAction(ACTION, run);
		expect(run).toHaveBeenCalledOnce();
		await governed.destroy();
	});
});
