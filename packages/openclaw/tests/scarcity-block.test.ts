// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * scarcity-block.test.ts — Ship 2, Task 6.
 *
 * Three parts:
 *  1. The pure helpers (`formatScarcityBlock`, `injectScarcityBlock`,
 *     `estimationMessages`) — exact format, copy semantics, exactly-once
 *     representation.
 *  2. The injection wiring through `wrapStreamWithGovernance`: delivery on
 *     `Context.systemPrompt` (contract-notes §4), estimation honesty
 *     (`authorize()`'s messages), and every A8 failure leg (empty read,
 *     rejected read, the injector's OWN formatter failure, `scarcityContext:
 *     false`) degrading to no block rather than gating/delaying/throwing.
 *  3. The receipt seam (`opts.onReceipt`): fires with the settle receipt,
 *     isolates both a synchronous throw and a returned rejection, and never
 *     delays stream termination.
 *
 * `formatScarcityBlock` is mocked (delegating to the real implementation by
 * default) ONLY so the "injector's own failure" case can force it to throw
 * from OUTSIDE `scarcity-block.ts` — `stream-governor.ts`'s cross-module
 * import of it is what makes this interceptable; a same-module self-call
 * would not be (see `scarcity-block.ts`'s module doc for why the try/catches
 * are split the way they are).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvelopeStatus, Governor, TrustReceipt } from "usertrust";
import { createGovernor } from "usertrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCostCenters } from "../src/index.js";
import {
	envelopeDescriptorsFrom,
	estimationMessages,
	formatScarcityBlock,
	injectScarcityBlock,
} from "../src/scarcity-block.js";
import { wrapStreamWithGovernance } from "../src/stream-governor.js";
import type { Context, FrozenCostCenters, StreamEvent, StreamFn } from "../src/types.js";
import {
	asHostStream,
	assistantToolCalls,
	doneEvent,
	makeModel,
	makeUsage,
	streamOf,
	toolResult,
	userMessage,
} from "./host-fixtures.js";

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

// `formatScarcityBlock` delegates to the real implementation by default, so
// every OTHER test in this file (including Part 1's direct unit tests, which
// import the same binding) is unaffected — only the one test that calls
// `.mockImplementationOnce` on it observes a throw.
vi.mock("../src/scarcity-block.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/scarcity-block.js")>();
	return { ...actual, formatScarcityBlock: vi.fn(actual.formatScarcityBlock) };
});

const model = makeModel();

function makeTmpVault(): string {
	const dir = join(tmpdir(), `openclaw-scarcity-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<void> {
	for await (const _event of stream) {
		// consume
	}
}

/** Guards against a promise that never settles, per `stream-governor.test.ts`. */
async function withTimeout<T>(promise: Promise<T>, ms = 500): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("promise never settled")), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function okStream(): StreamFn {
	return streamOf([doneEvent(makeUsage(50, 20))]);
}

// ── Part 1: the pure helpers ──

describe("formatScarcityBlock", () => {
	it("formats percent, the runway clause, and the · join exactly per spec", () => {
		const statuses: EnvelopeStatus[] = [
			{
				costCenter: "research",
				allocated: 10_000,
				spent: 6_600,
				remaining: 3_400,
				fraction: 0.34,
				runwayHours: 2.1,
			},
			{
				costCenter: "verification",
				allocated: 5_000,
				spent: 550,
				remaining: 4_450,
				fraction: 0.89,
				runwayHours: null,
			},
		];
		expect(formatScarcityBlock(statuses)).toBe(
			"[usertrust scarcity] research: 34% left (~2.1h runway) · verification: 89% left",
		);
	});

	it("percent is round(fraction·100), not floor/truncate", () => {
		const statuses: EnvelopeStatus[] = [
			{ costCenter: "x", allocated: 1, spent: 0, remaining: 1, fraction: 0.335, runwayHours: null },
		];
		expect(formatScarcityBlock(statuses)).toBe("[usertrust scarcity] x: 34% left");
	});

	it("omits the runway clause only when runwayHours is null, not when it's 0", () => {
		const statuses: EnvelopeStatus[] = [
			{ costCenter: "x", allocated: 1, spent: 1, remaining: 0, fraction: 0, runwayHours: 0 },
		];
		expect(formatScarcityBlock(statuses)).toBe("[usertrust scarcity] x: 0% left (~0.0h runway)");
	});

	it("returns null for an empty batch", () => {
		expect(formatScarcityBlock([])).toBeNull();
	});
});

describe("envelopeDescriptorsFrom", () => {
	it("builds one descriptor per frozen envelope, carrying its metadata", () => {
		const cc: FrozenCostCenters = normalizeCostCenters({
			parentUserId: "acme",
			tools: {},
			envelopes: {
				research: { allocated: 10_000, periodStartMs: 1000 },
				verification: { allocated: 5_000, periodStartMs: 1000, periodEndMs: 2000 },
			},
		});
		expect(envelopeDescriptorsFrom(cc)).toEqual([
			{ costCenter: "research", allocated: 10_000, periodStartMs: 1000 },
			{ costCenter: "verification", allocated: 5_000, periodStartMs: 1000, periodEndMs: 2000 },
		]);
	});
});

describe("injectScarcityBlock", () => {
	it("returns the SAME context reference when there is no block to inject", () => {
		const context: Context = { messages: [] };
		expect(injectScarcityBlock(context, null)).toBe(context);
	});

	it("sets systemPrompt to the block alone when the context had none", () => {
		const context: Context = { messages: [] };
		const result = injectScarcityBlock(context, "[usertrust scarcity] x: 1% left");
		expect(result.systemPrompt).toBe("[usertrust scarcity] x: 1% left");
		expect(result).not.toBe(context);
	});

	it("treats an empty-string systemPrompt as absent", () => {
		const context: Context = { messages: [], systemPrompt: "" };
		expect(injectScarcityBlock(context, "block").systemPrompt).toBe("block");
	});

	it("appends the block onto an existing systemPrompt with a blank-line join", () => {
		const context: Context = { messages: [], systemPrompt: "You are helpful." };
		const result = injectScarcityBlock(context, "[usertrust scarcity] x: 1% left");
		expect(result.systemPrompt).toBe("You are helpful.\n\n[usertrust scarcity] x: 1% left");
	});

	it("never mutates the caller's own context object — deep-untouched", () => {
		const context: Context = {
			messages: [userMessage("hi")],
			systemPrompt: "sys",
		};
		const before = JSON.stringify(context);
		injectScarcityBlock(context, "[usertrust scarcity] x: 1% left");
		expect(JSON.stringify(context)).toBe(before);
	});
});

describe("estimationMessages", () => {
	it("returns the original messages array unchanged when there is no systemPrompt", () => {
		const context: Context = { messages: [userMessage("hi")] };
		expect(estimationMessages(context)).toBe(context.messages);
	});

	it("treats an empty-string systemPrompt as absent", () => {
		const context: Context = { messages: [userMessage("hi")], systemPrompt: "" };
		expect(estimationMessages(context)).toBe(context.messages);
	});

	it("prepends the full effective system prompt exactly once, ahead of the real messages", () => {
		const context: Context = {
			messages: [userMessage("hi")],
			systemPrompt: "full effective prompt",
		};
		const result = estimationMessages(context);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ role: "system", content: "full effective prompt" });
		expect(result[1]).toBe(context.messages[0]);
		// Exactly once: the text does not also appear a second time in the array.
		const occurrences = JSON.stringify(result).split("full effective prompt").length - 1;
		expect(occurrences).toBe(1);
	});
});

// ── Part 2: injection wiring through the wrapper ──

const PERIOD_START = Date.UTC(2026, 7, 3);

const CC: FrozenCostCenters = normalizeCostCenters({
	parentUserId: "acme",
	tools: { web_search: "research" },
	default: "general",
	envelopes: {
		research: { allocated: 10_000, periodStartMs: PERIOD_START },
		general: { allocated: 1_000, periodStartMs: PERIOD_START },
	},
});

const CC_NO_SCARCITY: FrozenCostCenters = normalizeCostCenters({
	parentUserId: "acme",
	tools: { web_search: "research" },
	default: "general",
	envelopes: {
		research: { allocated: 10_000, periodStartMs: PERIOD_START },
		general: { allocated: 1_000, periodStartMs: PERIOD_START },
	},
	scarcityContext: false,
});

const RESEARCH_STATUS: EnvelopeStatus = {
	costCenter: "research",
	allocated: 10_000,
	spent: 6_600,
	remaining: 3_400,
	fraction: 0.34,
	runwayHours: 2.1,
};
const RESEARCH_BLOCK = "[usertrust scarcity] research: 34% left (~2.1h runway)";

describe("wrapStreamWithGovernance — scarcity injection", () => {
	let vaultBase: string;
	let gov: Governor;

	beforeEach(async () => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
		gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase, parentUserId: "acme" });
	});

	afterEach(async () => {
		process.env.USERTRUST_TEST = "";
		vi.restoreAllMocks();
		await gov.destroy();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	it("delivers the block on Context.systemPrompt, into a COPIED context — the caller's own object untouched", async () => {
		vi.spyOn(gov, "budgetContext").mockResolvedValue([RESEARCH_STATUS]);

		let seenContext: Context | undefined;
		const streamFn: StreamFn = (_model, context) => {
			seenContext = context;
			return asHostStream(
				(async function* () {
					yield doneEvent(makeUsage(10, 5));
				})(),
			);
		};

		const wrapped = wrapStreamWithGovernance(streamFn, gov, { costCenters: CC });
		const original: Context = { messages: [userMessage("hi")] };
		const before = JSON.stringify(original);

		await drain(await wrapped(model, original));

		expect(JSON.stringify(original)).toBe(before);
		expect(seenContext).not.toBe(original);
		expect(seenContext?.systemPrompt).toBe(RESEARCH_BLOCK);
	});

	it("represents the FULL effective system prompt exactly once in the messages authorize() receives", async () => {
		vi.spyOn(gov, "budgetContext").mockResolvedValue([RESEARCH_STATUS]);
		const authorize = vi.spyOn(gov, "authorize");

		const wrapped = wrapStreamWithGovernance(okStream(), gov, { costCenters: CC });
		const context: Context = {
			messages: [userMessage("hi")],
			systemPrompt: "You are helpful.",
		};

		await drain(await wrapped(model, context));

		const expectedFull = `You are helpful.\n\n${RESEARCH_BLOCK}`;
		const messages = authorize.mock.calls[0]?.[0]?.messages as unknown[];
		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({ role: "system", content: expectedFull });
		// Exactly once — not duplicated elsewhere in the array.
		const occurrences = JSON.stringify(messages).split(RESEARCH_BLOCK).length - 1;
		expect(occurrences).toBe(1);
	});

	it("pins the no-scarcity case: a pre-existing systemPrompt alone still reaches estimation", async () => {
		// No `costCenters` at all — scarcity is entirely off, but the pre-existing
		// systemPrompt still has to reach `authorize()`'s messages (contract-notes
		// §4: today `Context.systemPrompt` never reaches `authorize()` at all).
		const authorize = vi.spyOn(gov, "authorize");
		const wrapped = wrapStreamWithGovernance(okStream(), gov);
		const context: Context = {
			messages: [userMessage("hi")],
			systemPrompt: "You are helpful.",
		};

		await drain(await wrapped(model, context));

		const messages = authorize.mock.calls[0]?.[0]?.messages as unknown[];
		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({ role: "system", content: "You are helpful." });
	});

	it("[] read → no block, call proceeds", async () => {
		vi.spyOn(gov, "budgetContext").mockResolvedValue([]);
		let seenContext: Context | undefined;
		const streamFn: StreamFn = (_model, context) => {
			seenContext = context;
			return asHostStream(
				(async function* () {
					yield doneEvent(makeUsage(10, 5));
				})(),
			);
		};

		const wrapped = wrapStreamWithGovernance(streamFn, gov, { costCenters: CC });
		await expect(
			drain(await wrapped(model, { messages: [userMessage("hi")] })),
		).resolves.toBeUndefined();
		expect(seenContext?.systemPrompt).toBeUndefined();
	});

	it("a rejected budgetContext read → no block, call proceeds", async () => {
		vi.spyOn(gov, "budgetContext").mockRejectedValue(new Error("ledger unreachable"));
		let seenContext: Context | undefined;
		const streamFn: StreamFn = (_model, context) => {
			seenContext = context;
			return asHostStream(
				(async function* () {
					yield doneEvent(makeUsage(10, 5));
				})(),
			);
		};

		const wrapped = wrapStreamWithGovernance(streamFn, gov, { costCenters: CC });
		await expect(
			drain(await wrapped(model, { messages: [userMessage("hi")] })),
		).resolves.toBeUndefined();
		expect(seenContext?.systemPrompt).toBeUndefined();
	});

	it("the injector's own failure (formatter throw injected) → no block, call proceeds", async () => {
		vi.spyOn(gov, "budgetContext").mockResolvedValue([RESEARCH_STATUS]);
		(formatScarcityBlock as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new Error("format_boom");
		});

		let seenContext: Context | undefined;
		const streamFn: StreamFn = (_model, context) => {
			seenContext = context;
			return asHostStream(
				(async function* () {
					yield doneEvent(makeUsage(10, 5));
				})(),
			);
		};

		const wrapped = wrapStreamWithGovernance(streamFn, gov, { costCenters: CC });
		await expect(
			drain(await wrapped(model, { messages: [userMessage("hi")] })),
		).resolves.toBeUndefined();
		expect(seenContext?.systemPrompt).toBeUndefined();
	});

	it("scarcityContext: false → no read at all", async () => {
		const budgetContext = vi.spyOn(gov, "budgetContext");
		const wrapped = wrapStreamWithGovernance(okStream(), gov, { costCenters: CC_NO_SCARCITY });

		await drain(await wrapped(model, { messages: [userMessage("hi")] }));

		expect(budgetContext).not.toHaveBeenCalled();
	});
});

// ── Part 3: the receipt seam (opts.onReceipt) ──

function makeMockEngine(balance: number) {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		voidAllPending: vi.fn(async () => {}),
		destroy: vi.fn(),
		lookupBalances: vi.fn(
			async (ids: bigint[]) => new Map<bigint, number>(ids.map((id) => [id, balance])),
		),
	};
}

/** A context whose trailing run attributes to `research` via `CC_ONRECEIPT`'s map. */
function attributedContext(): Context {
	return {
		messages: [userMessage("go"), assistantToolCalls("web_search"), toolResult("web_search")],
	};
}

const CC_ONRECEIPT: FrozenCostCenters = normalizeCostCenters({
	parentUserId: "acme",
	tools: { web_search: "research" },
	default: "general",
	envelopes: {
		research: { allocated: 10_000, periodStartMs: PERIOD_START },
		general: { allocated: 1_000, periodStartMs: PERIOD_START },
	},
	// Isolates this describe block's concern (the receipt seam) from
	// scarcity injection's own — both read the same mock engine, and mixing
	// the two would leave it ambiguous which feature a given assertion pins.
	scarcityContext: false,
});

describe("wrapStreamWithGovernance — onReceipt", () => {
	let vaultBase: string;
	let engine: ReturnType<typeof makeMockEngine>;
	let gov: Governor;

	beforeEach(async () => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
		engine = makeMockEngine(4_000);
		gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			parentUserId: "acme",
			_engine: engine,
		});
	});

	afterEach(async () => {
		process.env.USERTRUST_TEST = "";
		vi.restoreAllMocks();
		await gov.destroy();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	it("fires with the settle receipt — attributed case, receipt.budget.costCenter matches", async () => {
		const received: TrustReceipt[] = [];
		const wrapped = wrapStreamWithGovernance(okStream(), gov, {
			costCenters: CC_ONRECEIPT,
			onReceipt: (r) => {
				received.push(r);
			},
		});

		await drain(await wrapped(model, attributedContext()));

		expect(received).toHaveLength(1);
		expect(received[0]?.budget?.costCenter).toBe("research");
	});

	it("isolates a SYNCHRONOUS throw from the callback — the stream still completes", async () => {
		const wrapped = wrapStreamWithGovernance(okStream(), gov, {
			costCenters: CC_ONRECEIPT,
			onReceipt: () => {
				throw new Error("callback_boom");
			},
		});

		const stream = await wrapped(model, attributedContext());
		await expect(drain(stream)).resolves.toBeUndefined();
		await expect(withTimeout(stream.result())).resolves.toBeDefined();
	});

	it("isolates a returned REJECTION from the callback — the stream still completes", async () => {
		const wrapped = wrapStreamWithGovernance(okStream(), gov, {
			costCenters: CC_ONRECEIPT,
			onReceipt: () => Promise.reject(new Error("callback_rejection")),
		});

		const stream = await wrapped(model, attributedContext());
		await expect(drain(stream)).resolves.toBeUndefined();
		await expect(withTimeout(stream.result())).resolves.toBeDefined();
	});

	it("never delays stream termination — settle/result finish before a slow callback does", async () => {
		const order: string[] = [];
		const wrapped = wrapStreamWithGovernance(okStream(), gov, {
			costCenters: CC_ONRECEIPT,
			onReceipt: async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				order.push("callback");
			},
		});

		const stream = await wrapped(model, attributedContext());
		await drain(stream);
		order.push("drained");
		await withTimeout(stream.result());
		order.push("result");

		// The callback is still in flight — drain/result did not wait on it.
		expect(order).toEqual(["drained", "result"]);

		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(order).toEqual(["drained", "result", "callback"]);
	});
});
