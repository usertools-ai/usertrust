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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { assertAuditRepresentable } from "../../src/audit/representable.js";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { AuditDataInvalidError, PolicyDeniedError } from "../../src/shared/errors.js";
import type { TrustReceipt } from "../../src/shared/types.js";

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

/**
 * Write a config file the governor will load from `vaultBase`. Only the actor
 * tests need one: `unknownModelPolicy` is config-only (it is not a
 * `GovernorOpts` field), and a governance DENIAL inside `authorize()` is the
 * only place the caller's `actor` reaches the chain from this entry point.
 */
function writeConfig(vaultBase: string, config: Record<string, unknown>): void {
	const dir = join(vaultBase, VAULT_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "usertrust.config.json"), JSON.stringify(config));
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

/**
 * An OpenAI-SDK-shaped client on a LOOPBACK baseURL, so `endpoint.class` is
 * `"local"`.
 *
 * WHY LOCAL, AND WHY IT IS NOT A CONTRIVANCE. `model` is a CAST of the caller's
 * own request object (`(params.model as string) ?? "unknown"`), so it can hold
 * any value at runtime. On the CLOUD path `resolveRates` happens to call
 * `model.startsWith(...)`, which throws a bare `TypeError` for a non-string —
 * loudly, and before anything irreversible, but by accident rather than by
 * design. On the LOCAL path with no configured `local.models`, `resolveRates`
 * never touches `model` as a string at all, so the value sails through
 * untouched and lands in `llm_call.data.model` at the stream terminal. That is
 * the reachable case, and it is exactly the one the fix has to close.
 */
function makeLocalStreamClient(): {
	client: Record<string, unknown>;
	createFn: ReturnType<typeof vi.fn>;
} {
	const createFn = vi.fn(async () => {
		async function* gen(): AsyncGenerator<unknown> {
			yield { choices: [{ delta: { content: "Hello" } }] };
			yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } };
		}
		return gen();
	});
	return {
		client: {
			baseURL: "http://localhost:11434/v1",
			chat: { completions: { create: createFn } },
		},
		createFn,
	};
}

/** The same loopback client, but resolving a plain JSON completion. */
function makeLocalJsonClient(): {
	client: Record<string, unknown>;
	createFn: ReturnType<typeof vi.fn>;
} {
	const createFn = vi.fn(async () => ({
		id: "chatcmpl_1",
		choices: [{ message: { role: "assistant", content: "Hello" } }],
		usage: { prompt_tokens: 100, completion_tokens: 50 },
	}));
	return {
		client: {
			baseURL: "http://localhost:11434/v1",
			chat: { completions: { create: createFn } },
		},
		createFn,
	};
}

interface CallResult {
	response: unknown;
	receipt: TrustReceipt;
}

async function callChat(governed: unknown, params: Record<string, unknown>): Promise<CallResult> {
	const g = governed as {
		chat: { completions: { create: (p: Record<string, unknown>) => Promise<CallResult> } };
	};
	return g.chat.completions.create(params);
}

/** Drain a governed stream and await its receipt — the stream TERMINAL fires here. */
async function drain(result: CallResult): Promise<TrustReceipt> {
	for await (const _chunk of result.response as AsyncIterable<unknown>) {
		// the caller owns the chunks; we only need the terminal
	}
	return (result.response as { receipt: Promise<TrustReceipt> }).receipt;
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

	it("settle() takes the model from the GOVERNOR's capture — a mutated handle cannot reach the record", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });

		// The Authorization is the CALLER's object, and `settle()` used to read
		// `model` off it — so a mutation between the two phases reached
		// `llm_call.data.model`, and an UNRECORDABLE one refused the settle
		// outright. `SettleParams` carries no `model`, so there is no supported
		// flow that settles against a different model than the one authorized:
		// the value now comes from the governor's own capture, validated where it
		// entered. A handle cannot relabel the record, and cannot block it either.
		(auth as unknown as { model: unknown }).model = Symbol("not-a-model");

		const receipt = await gov.settle(auth, { inputTokens: 1, outputTokens: 1 });
		expect(receipt.settled).toBe(true);
		expect(receipt.model).toBe("claude-sonnet-4-6");
		const llmCalls = readEvents(vaultBase).filter((e) => e.kind === "llm_call");
		expect(llmCalls).toHaveLength(1);
		expect((llmCalls[0] as { data: Record<string, unknown> }).data.model).toBe("claude-sonnet-4-6");

		await gov.destroy();
	});

	// ── the boundary must validate the bytes it will WRITE ──
	//
	// A CAST IS NOT A TYPE, and a value you re-read is not the value you checked.
	// `settle()` validated `params?.chunksDelivered` and `auth.model` and then
	// read BOTH again — twice each for the chain event, twice more for the
	// receipt. Every read is a fresh property access on an object the caller
	// still owns, so a `SettleParams` that is a live object (a Proxy, or a getter
	// over a running accumulator — the exact shape the `reportedCounts` comment
	// two screens below already anticipates) answers the boundary with one value
	// and the writer with another. The guard then passes and the writer refuses,
	// after the delete and after the POST: the original defect, intact, reached
	// through the guard instead of around it.
	//
	// The rule the fix restores is the one D5 already applies to the four token
	// counts: read the caller's object ONCE, into a local, and let the check, the
	// money and the record all come from that one read.

	it("settle() reads a LIVE SettleParams exactly once — the value it validated is the value it writes", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 1_000 });

		let reads = 0;
		const liveParams = {
			inputTokens: 10,
			outputTokens: 5,
			// Answers the boundary with a recordable 7 and everything after it with
			// NaN. A getter is the honest miniature of the real shape: an accumulator
			// the caller is still updating while the settle runs.
			get chunksDelivered(): number {
				reads++;
				return reads === 1 ? 7 : Number.NaN;
			},
		};

		const receipt = await gov.settle(auth, liveParams);

		// 1. ONE read. This is the whole fix: three reads (or five, counting the
		//    receipt) is three chances for the caller's object to answer
		//    differently, and the count is asserted exactly so a re-read cannot be
		//    reintroduced without failing here.
		expect(reads).toBe(1);

		// 2. The settle SUCCEEDS, because the value the boundary approved is the
		//    value that reaches the chain. Before the fix this rejected with
		//    AuditDataInvalidError — after `activeAuths.delete`, after the budget
		//    commit and after the POST, with no authorization left to retry
		//    against and no event on the chain at all.
		expect(receipt.settled).toBe(true);
		expect(receipt.chunksDelivered).toBe(7);

		// 3. The chain carries the SAME value the receipt does. Two independent
		//    re-reads used to be able to disagree with each other as well as with
		//    the guard, so this pins them to one snapshot.
		const llmCalls = readEvents(vaultBase).filter((e) => e.kind === "llm_call");
		expect(llmCalls).toHaveLength(1);
		expect((llmCalls[0] as { data: Record<string, unknown> }).data.chunksDelivered).toBe(7);

		// 4. The money moved exactly once, for this settle.
		expect(gov.budgetRemaining()).toBe(100_000 - receipt.cost);

		await gov.destroy();
	});

	it("settle() refuses a live SettleParams whose FIRST read is unrecordable, and the auth still retries", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 1_000 });

		const budgetBefore = gov.budgetRemaining();
		const eventsBefore = readEvents(vaultBase).length;

		let reads = 0;
		const liveParams = {
			inputTokens: 10,
			outputTokens: 5,
			get chunksDelivered(): number {
				reads++;
				return Number.NaN;
			},
		};

		const err = await gov.settle(auth, liveParams).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(AuditDataInvalidError);
		expect((err as Error).message).toContain("SettleParams.chunksDelivered");
		// Refused on the first read — the guard does not sample the caller's object
		// repeatedly looking for a bad answer, it takes one and judges it.
		expect(reads).toBe(1);
		// Exact, not a lower bound: a write-ahead would show up as an extra line.
		expect(gov.budgetRemaining()).toBe(budgetBefore);
		expect(readEvents(vaultBase)).toHaveLength(eventsBefore);

		// THE LOAD-BEARING ASSERTION: the authorization survived the refusal, so a
		// corrected value settles on the same handle.
		const receipt = await gov.settle(auth, {
			inputTokens: 10,
			outputTokens: 5,
			chunksDelivered: 4,
		});
		expect(receipt.settled).toBe(true);
		expect(receipt.chunksDelivered).toBe(4);
		expect(gov.budgetRemaining()).toBe(100_000 - receipt.cost);
		expect(readEvents(vaultBase).filter((e) => e.kind === "llm_call")).toHaveLength(1);

		await gov.destroy();
	});

	it("settle() reads Authorization.model ZERO times — the read is gone, not merely deduplicated", async () => {
		// `local` scope with no configured `local.models`: `resolveRates` never
		// calls a string method on `model`, so a non-string reaches the append
		// untouched. Same reachable path the govern-side stream test uses, and the
		// reason a cloud-scope TypeError is not a guard.
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local" },
		});
		const auth = await gov.authorize({ model: "llama3", estimatedInputTokens: 1_000 });

		let reads = 0;
		Object.defineProperty(auth, "model", {
			configurable: true,
			get(): unknown {
				reads++;
				return Symbol("swapped");
			},
		});

		const receipt = await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });

		// ONE read was the fix that made the check and the record agree. ZERO is
		// the fix that makes the question unaskable: the endpoint scope and the
		// model both come from the capture, so no caller accessor runs on this
		// path at all — it cannot lie, and it cannot throw a terminal off the
		// ledger either. Asserted exactly, so a re-read cannot come back.
		expect(reads).toBe(0);
		expect(receipt.settled).toBe(true);
		const llmCalls = readEvents(vaultBase).filter((e) => e.kind === "llm_call");
		expect(llmCalls).toHaveLength(1);
		expect((llmCalls[0] as { data: Record<string, unknown> }).data.model).toBe("llama3");

		await gov.destroy();
	});

	it("settle() meters with the CAPTURED endpoint scope even when the handle answers otherwise", async () => {
		// A3 already says the settlement meters with the authorize-time scope, and
		// `SettleParams` carries no endpoint field. It was still read off the
		// caller's handle, so a mutation between the phases re-classified the call
		// and re-priced it — the `model` defect one field over, on the value that
		// picks the RATE TABLE.
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local", runtime: "ollama" },
		});
		const auth = await gov.authorize({ model: "llama3", estimatedInputTokens: 1_000 });

		let reads = 0;
		Object.defineProperty(auth, "endpoint", {
			configurable: true,
			get(): unknown {
				reads++;
				return { class: "cloud", runtime: "unknown" };
			},
		});

		const receipt = await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });

		expect(reads).toBe(0);
		expect(receipt.endpoint).toEqual({ class: "local", runtime: "ollama" });
		// The scope also picks the rate table, so this is the money half of the
		// same assertion: a cloud re-classification of `llama3` would resolve
		// against the unknown-model path instead of the local default.
		expect(receipt.meter.rateSource).toBe("local-default");

		await gov.destroy();
	});

	it("the captured endpoint survives an IN-PLACE edit of the handle's object — the object-valued half", async () => {
		// Reading from the capture is what closes `model`, a PRIMITIVE. It does not
		// close `endpoint` on its own, and the test above only defends the property
		// REPLACEMENT vector: `endpoint` is object-valued, and the handle and the
		// capture were handed THE SAME OBJECT — for a governor-wide default, the
		// single `normalizeEndpoint(opts.endpoint)` instance shared by every call.
		// So `auth.endpoint.class = "cloud"` needed no getter and no
		// `defineProperty`. It walked straight past a capture that "owns" a
		// reference into caller-reachable memory, re-classified the hold's own
		// record, re-priced the settlement against the cloud rate table, and — the
		// part a per-call fix would miss — leaked into every LATER authorize() on
		// the same governor.
		//
		// This is the residual `abort()` warns about in place: a snapshot pins
		// identity, not contents, "and do not assume the same snapshot would be
		// sufficient for an object-valued field". Closed by owning the VALUE and
		// not just the reference — `normalizeEndpoint` freezes what it returns, so
		// there is no edit for the capture to observe.
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local", runtime: "ollama" },
		});
		const auth = await gov.authorize({ model: "llama3", estimatedInputTokens: 1_000 });

		expect(auth.endpoint).toEqual({ class: "local", runtime: "ollama" });

		// Frozen: strict-mode code throws, sloppy-mode code no-ops. Either is
		// acceptable — what must never happen is the write LANDING. The assertions
		// that follow are ordered money-first on purpose: pre-fix this edit landed,
		// and the FIRST thing it changed was the price.
		let threw = false;
		try {
			(auth.endpoint as unknown as { class: string }).class = "cloud";
		} catch {
			threw = true;
		}

		const receipt = await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });
		// Pre-fix: `{ class: "cloud", runtime: "ollama" }` and `rateSource:
		// "fallback"` — a different rate table, i.e. a different `actualCost`
		// POSTed for a hold that was priced local.
		expect(receipt.endpoint).toEqual({ class: "local", runtime: "ollama" });
		expect(receipt.meter.rateSource).toBe("local-default");

		// The cross-call half: the default instance is shared, so a landed edit
		// re-classified authorizations that had not been made yet.
		const next = await gov.authorize({ model: "llama3", estimatedInputTokens: 1_000 });
		expect(next.endpoint).toEqual({ class: "local", runtime: "ollama" });
		const nextReceipt = await gov.settle(next, { inputTokens: 10, outputTokens: 5 });
		expect(nextReceipt.endpoint).toEqual({ class: "local", runtime: "ollama" });
		expect(nextReceipt.meter.rateSource).toBe("local-default");

		// And the mechanism, asserted so a later refactor cannot quietly hand the
		// caller a mutable scope again.
		expect(threw || auth.endpoint?.class === "local").toBe(true);
		expect(auth.endpoint?.class).toBe("local");
		expect(Object.isFrozen(auth.endpoint)).toBe(true);

		await gov.destroy();
	});

	// ── the same class, on the field that decides WHICH hold is settled ──
	//
	// `auth.transferId` was the biggest instance of the re-read class and the
	// last one left inside `settle()`: fourteen fresh property accesses on the
	// caller's handle. Two of them are not merely audit data — the liveness `get`
	// and the `delete` that CLAIMS the entry were separate reads, so a getter
	// answering with the live id at the check and anything else at the claim left
	// the entry in `activeAuths`. The authorization then survives its own
	// settlement: settle it again and `budgetSpent` is committed twice while
	// `inFlightHoldTotal` is released twice, driving it negative. The audit hole
	// (an id that never held anything, written into `llm_call`,
	// `settlement_ambiguous` and `settlement_shortfall` after the POST) is the
	// smaller half of it.

	it("settle() reads a LIVE Authorization.transferId exactly once — the entry it checks is the entry it claims", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 1_000 });
		const realId = auth.transferId;

		let reads = 0;
		let poisoned = true;
		Object.defineProperty(auth, "transferId", {
			configurable: true,
			get(): string {
				reads++;
				// Read #1 (the liveness lookup) is honest; every later read points at
				// an id that is NOT in `activeAuths`. Pre-fix, read #2 was the delete.
				return poisoned && reads > 1 ? `${realId}-swapped` : realId;
			},
		});

		const receipt = await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });

		// 1. ONE read. Asserted exactly, so a re-read cannot be reintroduced
		//    without failing here.
		expect(reads).toBe(1);

		// 2. The id that passed the liveness check is the id that was recorded —
		//    on the receipt and on the chain. Pre-fix both carried `-swapped`.
		expect(receipt.transferId).toBe(realId);
		const llmCalls = readEvents(vaultBase).filter((e) => e.kind === "llm_call");
		expect(llmCalls).toHaveLength(1);
		expect((llmCalls[0] as { data: Record<string, unknown> }).data.transferId).toBe(realId);

		// 3. THE MONEY PROOF. Hand back an honest handle and settle again: the
		//    authorization must be GONE. Pre-fix the delete missed, so this second
		//    settle succeeded and committed a second `budgetSpent`.
		poisoned = false;
		await expect(gov.settle(auth, { inputTokens: 10, outputTokens: 5 })).rejects.toThrow(
			/is not active/,
		);

		// 4. One settle's worth of money, and the hold released exactly once — a
		//    double release would show up here as MORE than this.
		expect(gov.budgetRemaining()).toBe(100_000 - receipt.cost);
		expect(readEvents(vaultBase).filter((e) => e.kind === "llm_call")).toHaveLength(1);

		await gov.destroy();
	});

	// ── the window between the LOOKUP and the CLAIM ──
	//
	// A re-read was not the last way two terminals could run for one hold. The
	// entry was looked up, then CALLER CODE ran — the `chunksDelivered` accessor
	// and the guard over it — and only then was the entry claimed. Any accessor
	// in that window can synchronously call `settle()` or `abort()` on the same
	// handle: the nested terminal finds the entry still live, claims it, and runs
	// all the way to its first `await`, which is PAST the delete, the release and
	// the POST. The outer call's own `delete` then answers `false`, which nothing
	// checks, and it carries on with the capture it read before the window. Both
	// paths release the same hold and both account the same spend — and on the
	// settle/abort pairing they race a POST against a VOID.
	//
	// The fix is the rule AGENTS.md already states for the ledger: CLAIM
	// SYNCHRONOUSLY, before any caller code runs, and restore the entry only if
	// the validation that follows refuses it. Narrowing the window is not a fix;
	// the claim has to happen before the FIRST caller read, not merely nearer to
	// it. The retry property the guard is here for is unchanged, because the
	// restore is synchronous with the refusal — nothing can observe the gap.

	it("settle() claims the hold BEFORE it runs caller code — a re-entrant settle cannot release it twice", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 1_000 });

		let nested: Promise<unknown> | undefined;
		const liveParams = {
			inputTokens: 10,
			outputTokens: 5,
			get chunksDelivered(): number {
				// Re-entry from inside the outer call's own validation window,
				// synchronously, exactly as a caller-owned accessor can.
				nested ??= gov.settle(auth, { inputTokens: 10, outputTokens: 5 }).then(
					() => undefined,
					(e: unknown) => e,
				);
				return 7;
			},
		};

		const receipt = await gov.settle(auth, liveParams);

		// The nested terminal found the entry ALREADY CLAIMED. Pre-fix it found it
		// live, claimed it and settled, and the outer call then settled the same
		// hold a second time.
		expect(await nested).toBeInstanceOf(Error);
		expect(((await nested) as Error).message).toMatch(/is not active/);

		// ONE terminal for one hold: one event, one spend, one release. Pre-fix the
		// chain carried two `llm_call` events and `budgetRemaining()` reported the
		// hold released twice.
		expect(readEvents(vaultBase).filter((e) => e.kind === "llm_call")).toHaveLength(1);
		expect(gov.budgetRemaining()).toBe(100_000 - receipt.cost);
		expect(receipt.chunksDelivered).toBe(7);

		await gov.destroy();
	});

	it("settle() claims the hold BEFORE it runs caller code — a re-entrant abort cannot VOID it underneath", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 1_000 });

		let nested: Promise<void> | undefined;
		const liveParams = {
			inputTokens: 10,
			outputTokens: 5,
			get chunksDelivered(): number {
				nested ??= gov.abort(auth, new Error("re-entrant"));
				return 7;
			},
		};

		const receipt = await gov.settle(auth, liveParams);
		await nested;

		// `abort()` is idempotent-silent on a claimed entry, so the re-entrant call
		// is a no-op: no VOID, no failure record, and the hold it could not claim
		// is released exactly once — by the settle that owns it. Pre-fix the abort
		// released the hold and recorded `llm_call_failed`, and the settle then
		// released the SAME hold again and posted the spend on top.
		expect(readEvents(vaultBase).filter((e) => e.kind === "llm_call")).toHaveLength(1);
		expect(readEvents(vaultBase).filter((e) => e.kind === "llm_call_failed")).toHaveLength(0);
		expect(gov.budgetRemaining()).toBe(100_000 - receipt.cost);

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

	// ── the SAME re-read class, on the action path (F2) ──
	//
	// `governAction` had both of `settle()`'s defects at once, and worse odds:
	// `action` is the caller's object and the function used to take SEVEN fresh
	// reads of `cost` and EIGHT of `params` after validating one of each. That is
	// the guard being walked THROUGH, not around — the boundary was never wrong
	// about the value it saw, it was shown a different one.
	//
	// `cost` is the more dangerous of the two, because it is the money: the
	// AUD-466 finite/non-negative check, the PENDING hold, the `budgetSpent`
	// commit, the POST amount and the receipt were five independent reads that a
	// live object can answer five different ways.

	it("governAction() reads a LIVE action.params exactly once — the value it validated is the value it writes", async () => {
		const governed = await trust(makeAnthropicMock(), {
			dryRun: true,
			budget: 10_000,
			vaultBase,
		});
		const execute = vi.fn(async () => "ran");

		let reads = 0;
		const action = {
			kind: "tool_use",
			name: "file_read",
			cost: 50,
			// Answers the guard with a recordable object and everything after it
			// with one the chain cannot carry — the honest miniature of a caller
			// whose descriptor is computed, or a Proxy over live request state.
			get params(): Record<string, unknown> {
				reads++;
				return reads === 1 ? { path: "/etc/hosts" } : { retries: Number.NaN };
			},
		};

		const { receipt } = await governed.governAction(action, execute);

		// 1. ONE read. Exact, so a re-read cannot be reintroduced without failing
		//    here. Pre-fix this was 8.
		expect(reads).toBe(1);

		// 2. The action ran and was RECORDED AS HAVING RUN. Pre-fix `execute()`
		//    ran, the `tool_use` append was refused, and the catch wrote a
		//    `tool_use_failed` for an action that had SUCCEEDED — the chain
		//    actively lied about a side effect that had already happened.
		expect(execute).toHaveBeenCalledTimes(1);
		expect(receipt.settled).toBe(true);

		const events = readEvents(vaultBase);
		expect(events.filter((e) => e.kind === "tool_use")).toHaveLength(1);
		expect(events.filter((e) => e.kind === "tool_use_failed")).toHaveLength(0);

		// 3. The chain carries the params the guard approved, not a later read.
		const toolUse = events.find((e) => e.kind === "tool_use") as { data: Record<string, unknown> };
		expect(toolUse.data.params).toEqual({ path: "/etc/hosts" });

		// 4. The money moved exactly once, for this action.
		expect(receipt.budgetRemaining).toBe(10_000 - 50);

		await governed.destroy();
	});

	it("governAction() reads a LIVE action.cost exactly once — the hold, the commit, the POST and the receipt are ONE number", async () => {
		const governed = await trust(makeAnthropicMock(), {
			dryRun: true,
			budget: 10_000,
			vaultBase,
		});
		const execute = vi.fn(async () => "ran");

		let reads = 0;
		const action = {
			kind: "tool_use",
			name: "file_read",
			params: { path: "/etc/hosts" },
			// Honest for the AUD-466 guard, unrecordable for everything after it.
			get cost(): number {
				reads++;
				return reads === 1 ? 50 : Number.NaN;
			},
		};

		const { receipt } = await governed.governAction(action, execute);

		// 1. ONE read. Pre-fix this was 7.
		expect(reads).toBe(1);

		// 2. The cost the guard approved is the cost that was held, committed,
		//    posted and receipted.
		expect(receipt.cost).toBe(50);
		expect(receipt.budgetRemaining).toBe(10_000 - 50);
		const toolUse = readEvents(vaultBase).find((e) => e.kind === "tool_use") as {
			data: Record<string, unknown>;
		};
		expect(toolUse.data.cost).toBe(50);

		// 3. THE MONEY PROOF, and the reason this one is worse than the params
		//    twin. `inFlightHoldTotal += action.cost` took its own read, so pre-fix
		//    the counter absorbed a NaN and `budgetRemaining` was NaN for the
		//    REST OF THE CLIENT'S LIFE — every later call's gate, receipt and
		//    `budget_remaining_after` poisoned by one bad read on an unrelated
		//    action. A second, ordinary action proves the counter is still a
		//    number.
		const next = await governed.governAction(
			{ kind: "tool_use", name: "http_get", cost: 10, params: { url: "/x" } },
			execute,
		);
		expect(next.receipt.budgetRemaining).toBe(10_000 - 50 - 10);
		expect(Number.isNaN(next.receipt.budgetRemaining)).toBe(false);

		await governed.destroy();
	});

	it("governAction() refuses a live action.params whose FIRST read is unrecordable — before execute(), and it retries clean", async () => {
		const governed = await trust(makeAnthropicMock(), {
			dryRun: true,
			budget: 10_000,
			vaultBase,
		});
		const execute = vi.fn(async () => "ran");

		let reads = 0;
		const err = await governed
			.governAction(
				{
					kind: "tool_use",
					name: "file_read",
					cost: 50,
					get params(): Record<string, unknown> {
						reads++;
						return { retries: Number.NaN };
					},
				},
				execute,
			)
			.then(
				() => undefined,
				(e: unknown) => e,
			);

		expect(err).toBeInstanceOf(AuditDataInvalidError);
		expect((err as Error).message).toContain("action.params");
		// The guard takes ONE read and judges it — it does not sample the caller's
		// object repeatedly looking for a bad answer.
		expect(reads).toBe(1);
		// Exact, not a lower bound: `execute()` is the point of no return here.
		expect(execute).toHaveBeenCalledTimes(0);
		expect(readEvents(vaultBase)).toHaveLength(0);

		// THE LOAD-BEARING ASSERTION: nothing was left half-done, so a corrected
		// descriptor runs and settles on the same client.
		const { receipt } = await governed.governAction(
			{ kind: "tool_use", name: "file_read", cost: 50, params: { retries: 3 } },
			execute,
		);
		expect(receipt.settled).toBe(true);
		expect(receipt.budgetRemaining).toBe(10_000 - 50);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(readEvents(vaultBase).filter((e) => e.kind === "tool_use")).toHaveLength(1);

		await governed.destroy();
	});

	// ── headless authorize(): validate at CAPTURE, not at RECORD ──
	//
	// The ruling this section pins:
	//
	//   Validate before an irreversible step that CREATES an obligation to
	//   record. Never block a step that DISCHARGES one. Validate at CAPTURE, not
	//   at RECORD.
	//
	// `auth.model` reaches `abort()` from `params.model`, captured one call
	// earlier. `abort()` DISCHARGES an obligation — it voids a hold and gives the
	// caller their money back — so it must never be blocked, and a guard there
	// would skip the VOID and strand the hold. The fix therefore moves upstream
	// to the moment the value entered, where nothing is held yet and refusing
	// costs the caller only a corrected call.
	//
	// Reproduced against the unguarded version, on `local` scope (where
	// `resolveRates` never touches `model` as a string, so nothing incidentally
	// rejects it): `authorize({ model: Symbol() })` returned a handle and placed
	// the hold; `abort()` then released the money and threw
	// `AuditDataInvalidError` with NO event on the chain — silent audit loss on
	// the release path.

	it("authorize() refuses an unrecordable model at CAPTURE — before the hold exists", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local" },
		});
		const budgetBefore = gov.budgetRemaining();

		const err = await gov
			.authorize({ model: Symbol("not-a-model") as unknown as string, estimatedInputTokens: 1_000 })
			.then(
				() => undefined,
				(e: unknown) => e,
			);

		// 1. It throws, naming the caller's own field.
		expect(err).toBeInstanceOf(AuditDataInvalidError);
		expect((err as Error).message).toContain("AuthorizeParams.model");
		expect((err as AuditDataInvalidError).eventKind).toBe("llm_call");

		// 2. NOTHING was reserved. This is the whole point of capture-time: there
		//    is no hold to strand, so no terminal has to choose between releasing
		//    money and writing a record. Pre-fix the hold landed (budget 100000 →
		//    99999) and only `abort()` discovered the problem.
		expect(gov.budgetRemaining()).toBe(budgetBefore);
		expect(readEvents(vaultBase)).toHaveLength(0);

		// 3. The governor is clean — a corrected model authorizes and settles.
		const auth = await gov.authorize({ model: "llama3", estimatedInputTokens: 1_000 });
		const receipt = await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });
		expect(receipt.settled).toBe(true);
		expect(gov.budgetRemaining()).toBe(100_000 - receipt.cost);

		await gov.destroy();
	});

	it("an Authorization that EXISTS always carries a recordable model — the property, not the abort path", async () => {
		// Asserting the PROPERTY rather than testing `abort()` directly is the
		// point of the ruling: `abort()` is deliberately unguarded, so the
		// guarantee has to come from the fact that no handle carrying an
		// unrecordable model can be constructed at all.
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local" },
		});

		const unrecordable: unknown[] = [
			Symbol("s"),
			() => "sneaky",
			Number.NaN,
			Number.POSITIVE_INFINITY,
			{ nested: { deep: Number.NaN } },
		];
		for (const bad of unrecordable) {
			await expect(gov.authorize({ model: bad as string })).rejects.toBeInstanceOf(
				AuditDataInvalidError,
			);
		}
		// Not one of them left a hold behind.
		expect(gov.budgetRemaining()).toBe(100_000);
		expect(readEvents(vaultBase)).toHaveLength(0);

		// And the handles that DO exist satisfy the property by construction: the
		// same check the writer will run at the terminal already passes.
		const auth = await gov.authorize({ model: "llama3", estimatedInputTokens: 1_000 });
		expect(() =>
			assertAuditRepresentable("llm_call", { "Authorization.model": auth.model }),
		).not.toThrow();

		// So the discharge path meets a value it can write: `abort()` voids the
		// hold AND records it, with no guard of its own.
		await gov.abort(auth, new Error("provider exploded"));
		expect(gov.budgetRemaining()).toBe(100_000);
		const failures = readEvents(vaultBase).filter((e) => e.kind === "llm_call_failed");
		expect(failures).toHaveLength(1);
		expect((failures[0] as { data: Record<string, unknown> }).data.model).toBe("llama3");

		await gov.destroy();
	});

	// ── headless authorize(): the SECOND caller-supplied audit-bound value ──
	//
	// `actor` is the other one, and it is worse than `model`, because the event
	// it poisons is the DENIAL record. `params.actor ?? "local"` is captured
	// beside `model` and handed to `appendDenialEvent` as the event's `actor`
	// field on every denial boundary in `authorize()`. `appendDenialEvent`
	// deliberately swallows an append rejection and converts it to
	// `auditDegraded` on the thrown error — correct for a transient writer fault,
	// and catastrophic for a value that can NEVER be written: pre-fix, a symbol
	// `actor` gave the caller a correct `PolicyDeniedError` with ZERO
	// `policy_denied` events on the chain. The audited party could erase the
	// record of their own violation, on demand, by choosing their own name.
	//
	// Same helper, same capture boundary, one line above where `model` is
	// checked — so it is fixed here rather than ledgered.

	it("authorize() refuses an unrecordable actor at CAPTURE — before the hold exists", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local" },
		});
		const budgetBefore = gov.budgetRemaining();

		const err = await gov
			.authorize({
				model: "llama3",
				actor: Symbol("anonymous") as unknown as string,
				estimatedInputTokens: 1_000,
			})
			.then(
				() => undefined,
				(e: unknown) => e,
			);

		// 1. It throws, naming the caller's own field — not our local.
		expect(err).toBeInstanceOf(AuditDataInvalidError);
		expect((err as Error).message).toContain("AuthorizeParams.actor");
		expect((err as AuditDataInvalidError).eventKind).toBe("llm_call");

		// 2. Nothing was reserved and nothing was written.
		expect(gov.budgetRemaining()).toBe(budgetBefore);
		expect(readEvents(vaultBase)).toHaveLength(0);

		// 3. The whole unrecordable set is refused, not just symbols — and the
		//    default is untouched: an OMITTED actor is still "local".
		for (const bad of [() => "sneaky", Number.NaN, { nested: { deep: Number.NaN } }]) {
			await expect(
				gov.authorize({ model: "llama3", actor: bad as unknown as string }),
			).rejects.toBeInstanceOf(AuditDataInvalidError);
		}
		expect(gov.budgetRemaining()).toBe(budgetBefore);

		// 4. The governor is clean — a corrected actor authorizes and settles.
		const auth = await gov.authorize({
			model: "llama3",
			actor: "ci-bot",
			estimatedInputTokens: 1_000,
		});
		const receipt = await gov.settle(auth, { inputTokens: 10, outputTokens: 5 });
		expect(receipt.settled).toBe(true);
		expect(gov.budgetRemaining()).toBe(100_000 - receipt.cost);

		await gov.destroy();
	});

	it("a caller can no longer take a PolicyDeniedError while erasing the policy_denied event", async () => {
		// THE DEFECT, on the path that makes it matter. `unknownModelPolicy:
		// "deny"` produces a real governance denial inside `authorize()`, whose
		// `policy_denied` event carries the caller's own `actor`. Pre-fix this
		// call rejected with a correct `PolicyDeniedError` and left NOTHING on the
		// chain: the append threw on the unrecordable actor, `appendDenialEvent`
		// caught it, and the caller walked away un-recorded.
		writeConfig(vaultBase, { budget: 1_000_000, unknownModelPolicy: "deny" });
		const gov = await createGovernor({ dryRun: true, vaultBase });

		const err = await gov
			.authorize({
				model: "nowhere-model-9000",
				actor: Symbol("nobody") as unknown as string,
				messages: [{ role: "user", content: "hello" }],
			})
			.then(
				() => undefined,
				(e: unknown) => e,
			);

		// The refusal is the ENTRY guard, not the denial — so the caller never
		// reaches a state where a denial of theirs exists and its record does not.
		expect(err).toBeInstanceOf(AuditDataInvalidError);
		expect(err).not.toBeInstanceOf(PolicyDeniedError);
		expect((err as Error).message).toContain("AuthorizeParams.actor");
		expect(readEvents(vaultBase)).toHaveLength(0);

		await gov.destroy();
	});

	it("the actor guard does not cost the denial record it exists to protect", async () => {
		// The other half, and the reason the guard is at CAPTURE rather than
		// bolted onto `appendDenialEvent`: a recordable actor must still get its
		// denial written, with the caller's own name on it.
		writeConfig(vaultBase, { budget: 1_000_000, unknownModelPolicy: "deny" });
		const gov = await createGovernor({ dryRun: true, vaultBase });

		await expect(
			gov.authorize({
				model: "nowhere-model-9000",
				actor: "ci-bot",
				messages: [{ role: "user", content: "hello" }],
			}),
		).rejects.toBeInstanceOf(PolicyDeniedError);

		const denials = readEvents(vaultBase).filter((e) => e.kind === "policy_denied");
		expect(denials).toHaveLength(1);
		expect(denials[0]?.actor).toBe("ci-bot");
		expect((denials[0] as { data: Record<string, unknown> }).data.denialClass).toBe(
			"unknown_model",
		);

		// And the default path is unchanged: no actor supplied → "local".
		await expect(
			gov.authorize({ model: "nowhere-model-9001", messages: [{ role: "user", content: "hi" }] }),
		).rejects.toBeInstanceOf(PolicyDeniedError);
		const both = readEvents(vaultBase).filter((e) => e.kind === "policy_denied");
		expect(both).toHaveLength(2);
		expect(both[1]?.actor).toBe("local");

		await gov.destroy();
	});

	it("abort() is still UNGUARDED — it releases the hold first and never refuses", async () => {
		// A regression pin for the ruling's other half. `authorize()` cannot stop
		// a caller from mutating the handle it already owns, so `abort()` can
		// still be handed an unrecordable model. It must STILL void: the audit
		// line is lost (loudly — the writer throws), but the caller's money comes
		// back. A guard added to `abort()` would invert that and strand the hold,
		// which is precisely the trade the ruling rejects.
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			endpoint: { class: "local" },
		});
		const auth = await gov.authorize({ model: "llama3", estimatedInputTokens: 1_000 });
		// The hold is live and the session's exposure reflects it.
		expect(gov.budgetRemaining()).toBeLessThan(100_000);

		(auth as unknown as { model: unknown }).model = Symbol("mutated-after-capture");

		await expect(gov.abort(auth, new Error("boom"))).rejects.toBeInstanceOf(AuditDataInvalidError);

		// THE ASSERTION THAT MATTERS: the money came back anyway. The VOID runs
		// before the append, and no guard was added ahead of it.
		expect(gov.budgetRemaining()).toBe(100_000);

		await gov.destroy();
	});

	// ── the re-read class on the DISCHARGE path: abort() ──
	//
	// The test above pins that `abort()` has no GUARD. This one pins that it
	// takes no second READ — and the two are complements, not a contradiction. A
	// guard throws and skips the VOID, which is why the ruling forbids one here.
	// A snapshot throws nothing and skips nothing; it only makes the id that
	// answers the liveness `get` the same id that answers the `delete`, the VOID
	// and the record.
	//
	// It was the same defect `settle()` had, on the same field, with the same
	// consequence: pre-fix `abort()` took three reads of `auth.transferId` in
	// dry-run (the `get`, the `delete`, the audit line) and four with an engine
	// VOID. A handle that answers honestly at the check and differently at the
	// claim leaves the entry in `activeAuths`, so the authorization SURVIVES its
	// own abort — the hold is released here and then released a second time by a
	// later settle, which also commits `budgetSpent` for a call that was aborted.
	// Measured pre-fix: `budgetRemaining` 100_650 against a configured budget of
	// 100_000. Money that was never allocated.

	it("abort() reads a LIVE Authorization.transferId exactly once — the entry it checks is the entry it claims", async () => {
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 1_000 });
		const realId = auth.transferId;

		let reads = 0;
		let poisoned = true;
		Object.defineProperty(auth, "transferId", {
			configurable: true,
			get(): string {
				reads++;
				// Read #1 (the liveness lookup) is honest; every later read points at
				// an id that is NOT in `activeAuths`. Pre-fix, read #2 was the delete.
				return poisoned && reads > 1 ? `${realId}-swapped` : realId;
			},
		});

		// It must not throw and it must not be refused: this path DISCHARGES an
		// obligation.
		await gov.abort(auth, new Error("provider exploded"));

		// 1. ONE read. Asserted exactly, so a re-read cannot be reintroduced
		//    without failing here. Pre-fix this was 3.
		expect(reads).toBe(1);

		// 2. THE VOID STILL RAN, UNCONDITIONALLY. The hold is released — no guard
		//    was added ahead of it and nothing about the snapshot can skip it.
		expect(gov.budgetRemaining()).toBe(100_000);

		// 3. The id that passed the liveness check is the id that was recorded.
		//    Pre-fix the chain carried `-swapped`: an id that never held anything.
		const failures = readEvents(vaultBase).filter((e) => e.kind === "llm_call_failed");
		expect(failures).toHaveLength(1);
		expect((failures[0] as { data: Record<string, unknown> }).data.transferId).toBe(realId);

		// 4. THE MONEY PROOF. Hand back an honest handle and settle: the
		//    authorization must be GONE. Pre-fix the delete missed, so this settle
		//    succeeded — an aborted call was settled, releasing the same hold twice
		//    and committing `budgetSpent` for it.
		poisoned = false;
		await expect(gov.settle(auth, { inputTokens: 10, outputTokens: 5 })).rejects.toThrow(
			/is not active/,
		);

		// 5. No invented money, stated both ways: exactly the released hold, and —
		//    the property that actually matters — never MORE than the configured
		//    budget. Pre-fix this read 100_650 against a ceiling of 100_000.
		expect(gov.budgetRemaining()).toBe(100_000);
		expect(gov.budgetRemaining()).toBeLessThanOrEqual(100_000);

		// 6. And the abort left exactly one record, with no settlement beside it.
		const events = readEvents(vaultBase);
		expect(events.filter((e) => e.kind === "llm_call_failed")).toHaveLength(1);
		expect(events.filter((e) => e.kind === "llm_call")).toHaveLength(0);

		await gov.destroy();
	});

	it("abort() still discharges when the handle's AUDIT-only accessor throws — the read stays behind the VOID", async () => {
		// NOT a failing-first proof, and named as such: this passes on both sides.
		// It is the pin on WHERE the snapshot stops. The money/identity fields are
		// hoisted above the release because the release needs them; `model` is
		// audit-only and read exactly once, so hoisting it would buy no
		// single-read guarantee and would put a caller-controlled accessor AHEAD
		// of the VOID — a throw there strands the hold, which is the exact trade
		// the ruling rejects. If a future change hoists it, this test fails.
		const gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		const auth = await gov.authorize({ model: "llama3", estimatedInputTokens: 1_000 });
		expect(gov.budgetRemaining()).toBeLessThan(100_000);

		Object.defineProperty(auth, "model", {
			configurable: true,
			get(): string {
				throw new Error("hostile accessor");
			},
		});

		await expect(gov.abort(auth, new Error("boom"))).rejects.toThrow(/hostile accessor/);

		// THE ASSERTION THAT MATTERS: the hold was released before anything could
		// read the audit-only field. The caller's money is back.
		expect(gov.budgetRemaining()).toBe(100_000);

		await gov.destroy();
	});

	// ── the proxy's `model`: the STREAM terminal (fix round 1 finding 2) ──

	it("the STREAM terminal's model is refused at entry — before the money commits AND before the stream is consumed", async () => {
		const { client, createFn } = makeLocalStreamClient();
		const governed = await trust(client, { budget: 100_000, vaultBase });

		const err = await callChat(governed, {
			model: Number.NaN,
			messages: [{ role: "user", content: "hi" }],
			stream: true,
		}).then(
			() => undefined,
			(e: unknown) => e,
		);

		// 1. It throws at the boundary, with the caller's own field named.
		expect(err).toBeInstanceOf(AuditDataInvalidError);
		expect((err as Error).message).toContain("request.model");
		expect((err as AuditDataInvalidError).eventKind).toBe("llm_call");

		// 2. THE ASYMMETRY THIS TEST EXISTS FOR. On the stream path the `llm_call`
		//    append runs AFTER the budget commit, AFTER persistSessionSpend(), and
		//    AFTER the POST/settle. So before the fix the refusal arrived once the
		//    money had committed AND the stream had been consumed — strictly less
		//    recoverable than the settle() case, because a consumed stream cannot
		//    be re-consumed and there is no authorization handle to retry against.
		//    The provider was never called at all, which is what makes it a real
		//    guard rather than a notification.
		expect(createFn).toHaveBeenCalledTimes(0);
		expect(readEvents(vaultBase)).toHaveLength(0);

		// 3. THE RETRY — the whole point. A corrected model streams and settles on
		//    a governor that was never left in a half-committed state.
		const good = await callChat(governed, {
			model: "llama3",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
		});
		const receipt = await drain(good);
		expect(receipt.settled).toBe(true);
		expect(receipt.budgetRemaining).toBe(100_000 - receipt.cost);
		expect(createFn).toHaveBeenCalledTimes(1);

		const llmCalls = readEvents(vaultBase).filter((e) => e.kind === "llm_call");
		expect(llmCalls).toHaveLength(1);
		expect((llmCalls[0] as { data: Record<string, unknown> }).data.model).toBe("llama3");

		await (governed as unknown as { destroy(): Promise<void> }).destroy();
	});

	it("the NON-STREAM twin is refused at the same boundary, before the provider is billed", async () => {
		// The non-stream `llm_call` append at govern.ts:2417 already PRECEDES the
		// budget commit, so on the money axis this path was never broken. It is
		// still improved by the same one-line boundary: the provider call is the
		// caller's own irreversible step (they are billed for it by the provider,
		// whatever our ledger does), and refusing a model we could never record
		// before making that call costs them nothing but a corrected retry.
		const { client, createFn } = makeLocalJsonClient();
		const governed = await trust(client, { budget: 100_000, vaultBase });

		await expect(
			callChat(governed, { model: () => "sneaky", messages: [{ role: "user", content: "hi" }] }),
		).rejects.toBeInstanceOf(AuditDataInvalidError);
		expect(createFn).toHaveBeenCalledTimes(0);
		expect(readEvents(vaultBase)).toHaveLength(0);

		// Same handle, corrected model: the governor was left in a clean state.
		const { receipt } = await callChat(governed, {
			model: "llama3",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(receipt.settled).toBe(true);
		expect(receipt.budgetRemaining).toBe(100_000 - receipt.cost);
		expect(createFn).toHaveBeenCalledTimes(1);

		await (governed as unknown as { destroy(): Promise<void> }).destroy();
	});

	it('an absent model is still the string "unknown", not a refusal', async () => {
		// `(params.model as string) ?? "unknown"` coalesces null/undefined, so the
		// value the guard sees is already the recordable default. Validating the
		// COALESCED value rather than the raw field is what keeps this legal.
		const { client } = makeLocalStreamClient();
		const governed = await trust(client, { budget: 100_000, vaultBase });

		const result = await callChat(governed, {
			messages: [{ role: "user", content: "hi" }],
			stream: true,
		});
		const receipt = await drain(result);
		expect(receipt.settled).toBe(true);
		const llmCalls = readEvents(vaultBase).filter((e) => e.kind === "llm_call");
		expect((llmCalls[0] as { data: Record<string, unknown> }).data.model).toBe("unknown");

		await (governed as unknown as { destroy(): Promise<void> }).destroy();
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

	// ── the boundary judges the BYTES, not the absence of a throw ──
	//
	// `assertAuditRepresentable` accepted every input `canonicalize` did not
	// throw on. But canonicalize's Date branch returns
	// `JSON.stringify(value.toISOString())`, and `JSON.stringify` answers with the
	// JS value `undefined` — not a string — for a `toISOString` that returns
	// `undefined` or a function. No throw, so the boundary waved it through; the
	// value then reached the canonical text as the bare token `undefined`, which
	// the WRITER's parse guard refuses — after `governAction()` has executed and
	// after the money moved, i.e. after the irreversible step this whole module
	// exists to run ahead of. The boundary and the writer are supposed to agree BY
	// CONSTRUCTION, and they only do if the boundary judges what the writer judges:
	// the returned bytes.
	//
	// THE RESIDUAL THAT WAS STATED HERE IS NOW CLOSED AT THE SOURCE. It read:
	// inside an ARRAY the same malformed Date is joined away rather than emitted,
	// so `[bad]` canonicalizes to the parseable `[]` and BOTH guards accept it —
	// a member dropped from the hash and from the record, which is the one thing
	// this canonicalizer refuses to do for functions and symbols. The Date branch
	// now applies the `typeof encoded !== "string"` check its sibling primitive
	// branch always applied (both twins; `canonical.test.ts` and the verify
	// package's own suite pin it at top level, nested and in an array), so
	// canonicalize THROWS on this input and the array case has no output to
	// accept. The boundary's parse remains, deliberately, for the same reason
	// `appendEvent` keeps its own pre-fsync parse: the guard must not depend on a
	// serializer staying correct. What is asserted below is therefore the
	// PROPERTY — boundary and writer refuse the same inputs — not the one vehicle
	// that used to reach past a non-parsing return.

	it("the boundary refuses canonical bytes that do not PARSE, not merely a throw", () => {
		const malformed = (): Date => {
			const d = new Date("2026-08-11T00:00:00.000Z");
			(d as unknown as { toISOString: () => unknown }).toISOString = () => undefined;
			return d;
		};

		// Pre-boundary-fix: canonicalize returned the JS value `undefined` here and
		// never threw — its declared `string` return type was a cast, not a check —
		// so a guard that only watched for a throw waved it through. The
		// canonicalizer refuses it at its own Date branch now, which is the second
		// of the two fixes and the reason this line reads `toThrow`.
		expect(() => canonicalize(malformed())).toThrow(/not representable in audit data/);

		// Top level, nested, and INSIDE AN ARRAY — the position that used to be
		// joined away into the parseable `[]`. All three reach a writer that
		// persists these bytes.
		for (const value of [
			malformed(),
			{ when: malformed() },
			{ a: { b: malformed() } },
			[malformed()],
			{ list: [1, malformed(), 3] },
		]) {
			expect(() => assertAuditRepresentable("llm_call", { "x.y": value })).toThrow(
				AuditDataInvalidError,
			);
		}
	});

	it("the boundary and the writer refuse the SAME malformed Date", async () => {
		const d = new Date("2026-08-11T00:00:00.000Z");
		(d as unknown as { toISOString: () => unknown }).toISOString = () => () => 1;

		expect(() => assertAuditRepresentable("tool_use", { "x.y": d })).toThrow(AuditDataInvalidError);

		const writer = createAuditWriter(vaultBase);
		try {
			await expect(
				writer.appendEvent({ kind: "tool_use", actor: "sys", data: { when: d } }),
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
