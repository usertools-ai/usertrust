// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * envelope-integration.test.ts — the Ship 2 mechanism end to end.
 *
 * Every other test in this package pins one piece against a fake: the pure
 * attribution rule, the pure scarcity formatter, the terminal-mode matrix. This
 * file runs a REAL headless governor through `createGovernedStreamFn` over a
 * multi-turn conversation and asserts the only things an operator can actually
 * observe — which account each hold debited, what the receipts say, and what the
 * model was told about its own budget.
 *
 * TWO LEDGERS, one file:
 *
 *   1. An INJECTED engine (`GovernedStreamFnOptions.engine`) for the scripted
 *      turns. It is a real spend lifecycle — holds, posts, refunds, balance
 *      reads — with no cluster, which is why this file deliberately does NOT
 *      `vi.mock("tigerbeetle-node")` the way the other openclaw tests do: the
 *      injected engine IS the isolation seam, and mocking the native module
 *      would break case 2 in the same file.
 *   2. A REAL TigerBeetle cluster, self-skipping (`describe.skipIf`) when
 *      `USERTRUST_TB_ADDRESS` is absent — the same pattern as core's
 *      `budget-envelope.tb.test.ts`, which is also where the allocate → spend →
 *      status → reclaim shape comes from. Nothing cluster-touching runs at
 *      collection time.
 *
 * Field names are CONTRACT-DETERMINED (contract-notes §2/§4); the host shapes
 * come from `host-fixtures.ts`, never inline.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrustOpts, TrustReceipt } from "usertrust";
import {
	allocateBudget,
	getBudgetStatus,
	reclaimBudget,
	TrustTBClient,
	VAULT_DIR,
} from "usertrust";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// `XFER_PURCHASE` is not on core's public root export, and funding a parent
// wallet from the treasury is exactly what core's own `budget-envelope.tb.test.ts`
// does with it — read the code from the same module rather than hard-code a bare
// `1` that would silently rot if the transfer codes were ever renumbered.
import { XFER_PURCHASE } from "../../core/src/ledger/client.js";
import { createGovernedStreamFn, shutdown } from "../src/index.js";
import type { Context, CostCentersConfig, Message, StreamFn } from "../src/types.js";
import {
	assistantToolCalls,
	doneEvent,
	makeAssistantMessage,
	makeModel,
	makeUsage,
	startEvent,
	streamOf,
	textDelta,
	toolResult,
	userMessage,
} from "./host-fixtures.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;

const MODEL = makeModel();

const RESEARCH = "research";
const GENERAL = "general";
/**
 * Each envelope's allocation. Sized so one turn's ~614 UT hold fits comfortably
 * and its ~240 UT settlement is a visible bite out of the envelope — the scarcity
 * block reports whole percents, so a lavish allocation would round every turn back
 * to "100% left" and the level test could not tell spend from no spend.
 */
const ALLOCATED = 2_000;
/** The session holding wallet an attributed call never debits. */
const SESSION_BUDGET = 1_000_000;

// ── The conversation ──
// One script, replayed by both halves of the file: the host asks, the model calls
// `web_search`, the host appends the result, the model answers.

const ASK: Message = userMessage("find the retention spec");
const SEARCHED: Message = assistantToolCalls("web_search");
const READ: Message = assistantToolCalls("read_file");
const ANSWERED: Message = {
	...makeAssistantMessage(),
	content: [{ type: "text", text: "retention is 30 days" }],
};

/** The turn the host sends after executing `toolName` — result run TRAILING. */
function afterTool(issued: Message, toolName: string): Message[] {
	return [ASK, issued, toolResult(toolName)];
}

// ── Host stream ──

/** A stream fn that records the context it was FORWARDED (post-injection). */
function recordingStream(seen: Context[]): StreamFn {
	const inner = streamOf([startEvent(), textDelta("ok"), doneEvent(makeUsage(500, 1500))]);
	return (model, context) => {
		seen.push(context);
		return inner(model, context);
	};
}

async function runTurn(governedStreamFn: StreamFn, messages: Message[]): Promise<Context> {
	const context: Context = { messages };
	for await (const _event of await governedStreamFn(MODEL, context)) {
		// drain — settlement runs after the terminal event
	}
	return context;
}

// ── The injected engine ──

type TestEngine = NonNullable<TrustOpts["_engine"]>;

interface HoldRecord {
	transferId: string;
	amount: number;
	/** The envelope account the hold debited; `undefined` = session wallet. */
	debitAccountId: bigint | undefined;
}

interface FakeLedger {
	engine: TestEngine;
	/** Every `spendPending` the governor issued, in order — one per governed turn. */
	holds: HoldRecord[];
	available(accountId: bigint): number;
}

/**
 * The smallest engine that behaves like TigerBeetle for the three things this
 * file reads back: which account a hold debited, what a settle leaves behind
 * (posts cap at the hold, the remainder is refunded), and what `lookupBalances`
 * reports afterwards. An account the seed never named is ABSENT from a lookup,
 * not zero — the batch semantics `TrustEngine.lookupBalances` documents.
 */
function fakeLedger(seed: Map<bigint, number>): FakeLedger {
	const available = new Map(seed);
	const pending = new Map<string, { amount: number; accountId: bigint | undefined }>();
	const holds: HoldRecord[] = [];

	const credit = (accountId: bigint | undefined, delta: number): void => {
		if (accountId === undefined) return;
		available.set(accountId, (available.get(accountId) ?? 0) + delta);
	};

	const engine: TestEngine = {
		spendPending: async ({ transferId, amount, debitAccountId }) => {
			holds.push({ transferId, amount, debitAccountId });
			pending.set(transferId, { amount, accountId: debitAccountId });
			credit(debitAccountId, -amount);
			return { transferId };
		},
		postPendingSpend: async (transferId, actualAmount) => {
			const held = pending.get(transferId);
			if (held === undefined) return { posted: 0, shortfall: 0 };
			pending.delete(transferId);
			const requested = actualAmount ?? held.amount;
			const posted = Math.min(requested, held.amount);
			credit(held.accountId, held.amount - posted);
			return { posted, shortfall: requested - posted };
		},
		voidPendingSpend: async (transferId) => {
			const held = pending.get(transferId);
			if (held === undefined) return;
			pending.delete(transferId);
			credit(held.accountId, held.amount);
		},
		lookupBalances: async (accountIds) => {
			const balances = new Map<bigint, number>();
			for (const accountId of accountIds) {
				const balance = available.get(accountId);
				if (balance !== undefined) balances.set(accountId, balance);
			}
			return balances;
		},
	};

	return { engine, holds, available: (accountId) => available.get(accountId) ?? 0 };
}

// ── Assertion helpers ──

/** The `NN` in `<costCenter>: NN% left` inside a scarcity block, else null. */
function scarcityPercent(systemPrompt: string | undefined, costCenter: string): number | null {
	const match = new RegExp(`${costCenter}: (\\d+)% left`).exec(systemPrompt ?? "");
	return match?.[1] === undefined ? null : Number(match[1]);
}

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	tmpDirs.push(dir);
	return dir;
}

afterEach(async () => {
	// The governor is a module-wide singleton: leaving one alive would hand the
	// NEXT test this test's engine, budget and parentUserId.
	await shutdown();
	for (const dir of tmpDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

// ── 1. Injected engine ──

describe("envelope attribution end-to-end (injected engine)", () => {
	beforeEach(() => {
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(() => {
		process.env.USERTRUST_TEST = "";
	});

	interface Run {
		account(costCenter: string): bigint;
		/** The contexts the inner stream fn was handed — copies, post-injection. */
		forwarded: Context[];
		governedStreamFn: StreamFn;
		ledger: FakeLedger;
		receipts: TrustReceipt[];
	}

	async function governedRun(): Promise<Run> {
		const parentUserId = `openclaw-envelope-${randomUUID()}`;
		const periodStartMs = Date.now();
		const account = (costCenter: string): bigint =>
			TrustTBClient.deriveCostCenterAccountId(parentUserId, costCenter);
		const ledger = fakeLedger(
			new Map([
				[account(RESEARCH), ALLOCATED],
				[account(GENERAL), ALLOCATED],
			]),
		);
		const forwarded: Context[] = [];
		const receipts: TrustReceipt[] = [];
		const costCenters: CostCentersConfig = {
			parentUserId,
			tools: { web_search: RESEARCH },
			default: GENERAL,
			envelopes: {
				[RESEARCH]: { allocated: ALLOCATED, periodStartMs },
				[GENERAL]: { allocated: ALLOCATED, periodStartMs },
			},
		};

		const { governedStreamFn } = await createGovernedStreamFn(
			recordingStream(forwarded),
			{ budget: SESSION_BUDGET, vaultBase: makeTmpDir("openclaw-envelope-int"), costCenters },
			{
				engine: ledger.engine,
				onReceipt: (receipt) => {
					receipts.push(receipt);
				},
			},
		);

		return { account, forwarded, governedStreamFn, ledger, receipts };
	}

	/**
	 * The script, in host order: a plain turn, the turn that follows a `web_search`
	 * execution, and the turn after the model has answered. Returns the contexts as
	 * the CALLER wrote them, so a test can check they were never mutated.
	 */
	async function runScript(run: Run): Promise<Context[]> {
		const searched = afterTool(SEARCHED, "web_search");
		return [
			await runTurn(run.governedStreamFn, [ASK]),
			await runTurn(run.governedStreamFn, searched),
			await runTurn(run.governedStreamFn, [...searched, ANSWERED]),
		];
	}

	it("bills the turn after a mapped tool to its envelope, and every other turn to the default", async () => {
		const run = await governedRun();
		await runScript(run);

		// Turn 1 has no tool results at all and turn 3's run is no longer trailing
		// (the model has answered) — both reset to `default`. Only turn 2, the host
		// asking the model to continue right after executing `web_search`, is
		// attributed to `research`. This is the stale-carry-over pin, end to end:
		// one search early in a conversation must not bill every later turn.
		expect(run.ledger.holds.map((hold) => hold.debitAccountId)).toEqual([
			run.account(GENERAL),
			run.account(RESEARCH),
			run.account(GENERAL),
		]);
		// The receipt seam reports the same three, in the same order.
		expect(run.receipts.map((receipt) => receipt.budget?.costCenter)).toEqual([
			GENERAL,
			RESEARCH,
			GENERAL,
		]);
		// And the attributed receipt's envelope snapshot is the ledger's OWN
		// post-settle balance for the account the hold debited — not an estimate.
		expect(run.receipts[1]?.budget?.remaining).toBe(run.ledger.available(run.account(RESEARCH)));
	});

	it("shows the model every envelope's live level, on a copy of the caller's context", async () => {
		const run = await governedRun();
		const inputs = await runScript(run);

		const [turn1, turn2, turn3] = run.forwarded;
		expect(turn1?.systemPrompt).toContain("[usertrust scarcity]");
		// Turn 1 read the ledger before anything had spent: both envelopes full.
		expect(scarcityPercent(turn1?.systemPrompt, RESEARCH)).toBe(100);
		expect(scarcityPercent(turn1?.systemPrompt, GENERAL)).toBe(100);
		// Turn 2 sees turn 1's settled spend on `general`, and `research` still
		// untouched — the tool result it is about to be billed for only just arrived.
		expect(scarcityPercent(turn2?.systemPrompt, GENERAL)).toBeLessThan(100);
		expect(scarcityPercent(turn2?.systemPrompt, RESEARCH)).toBe(100);
		// Turn 3 sees turn 2's spend on `research`: the attributed hold really did
		// debit that envelope, all the way through to what the model is told next.
		expect(scarcityPercent(turn3?.systemPrompt, RESEARCH)).toBeLessThan(100);

		// The block lives on a COPY — the caller's own context objects are untouched.
		expect(inputs.map((context) => context.systemPrompt)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
	});

	it("bills the turn after an UNMAPPED tool to the default envelope", async () => {
		const run = await governedRun();
		await runTurn(run.governedStreamFn, afterTool(READ, "read_file"));

		// `read_file` is a real, correlated, non-error execution — it is simply not
		// in the operator's map, so it selects nothing and `default` pays.
		expect(run.ledger.holds[0]?.debitAccountId).toBe(run.account(GENERAL));
		expect(run.receipts[0]?.budget?.costCenter).toBe(GENERAL);
	});
});

// ── 2. Real TigerBeetle ──

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — an attributed OpenClaw turn", () => {
	/** A vault whose config points the governor's own engine at the live cluster. */
	function makeClusterVault(budget: number): string {
		const dir = makeTmpDir("openclaw-envelope-tb");
		mkdirSync(join(dir, VAULT_DIR), { recursive: true });
		writeFileSync(
			join(dir, VAULT_DIR, "usertrust.config.json"),
			// `addresses`/`clusterId` are the exact TrustTBClient config keys.
			JSON.stringify({ budget, tigerbeetle: { addresses: [TB_ADDRESS], clusterId: 0 } }),
		);
		return dir;
	}

	it("allocates an envelope, bills an attributed turn to it, and reclaims the remainder", async () => {
		// A fresh parent per run — `(parent, costCenter)` IS the envelope account,
		// and this cluster is long-lived.
		const parentUserId = `openclaw-envelope-tb-${randomUUID()}`;
		const periodStartMs = Date.now();

		const tb = new TrustTBClient({ addresses: [TB_ADDRESS as string], clusterId: 0n });
		try {
			// ── Fund the parent, allocate the envelope — the operator's own tooling ──
			const treasury = await tb.createTreasury();
			const parentAccount = await tb.createUserWallet(parentUserId);
			await tb.immediateTransfer({
				debitAccountId: treasury,
				creditAccountId: parentAccount,
				amount: ALLOCATED,
				code: XFER_PURCHASE,
			});
			const allocation = await allocateBudget(tb, {
				parentUserId,
				costCenter: RESEARCH,
				amount: ALLOCATED,
			});
			expect(allocation.allocated).toBe(ALLOCATED);

			// ── One attributed turn through the plugin's programmatic entry point ──
			const forwarded: Context[] = [];
			const receipts: TrustReceipt[] = [];
			const { governedStreamFn } = await createGovernedStreamFn(
				recordingStream(forwarded),
				{
					budget: SESSION_BUDGET,
					vaultBase: makeClusterVault(SESSION_BUDGET),
					costCenters: {
						parentUserId,
						tools: { web_search: RESEARCH },
						envelopes: { [RESEARCH]: { allocated: ALLOCATED, periodStartMs } },
					},
				},
				{
					onReceipt: (receipt) => {
						receipts.push(receipt);
					},
				},
			);
			await runTurn(governedStreamFn, afterTool(SEARCHED, "web_search"));

			const receipt = receipts[0];
			expect(receipt?.budget?.costCenter).toBe(RESEARCH);
			// What the ledger actually posted: the metered cost, or the hold when the
			// engine capped a settle above it.
			const posted = receipt?.postedCost ?? receipt?.cost ?? 0;
			expect(posted).toBeGreaterThan(0);

			// The scarcity block the model saw came off this cluster too — read
			// before the turn's own hold, so the envelope is still whole.
			expect(scarcityPercent(forwarded[0]?.systemPrompt, RESEARCH)).toBe(100);

			// ── The real envelope shows the real spend ──
			const statusArgs = {
				parentUserId,
				costCenter: RESEARCH,
				allocated: ALLOCATED,
				periodStartMs,
			};
			const status = await getBudgetStatus(tb, statusArgs);
			expect(status.balance).toBe(ALLOCATED - posted);
			expect(status.runway.remaining).toBe(ALLOCATED - posted);

			// ── Reclaim what the agent did not spend ──
			const reclaim = await reclaimBudget(tb, { parentUserId, costCenter: RESEARCH });
			expect(reclaim.reclaimed).toBe(ALLOCATED - posted);
			expect((await getBudgetStatus(tb, statusArgs)).balance).toBe(0);
		} finally {
			tb.destroy();
		}
	});
});
