// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * attribution.test.ts — Ship 2, Task 5.
 *
 * Two halves, and the split is the security model:
 *
 *  1. `deriveAttribution` is PURE and STATELESS. Everything about which
 *     envelope pays a call is decided here, from the caller's own context and
 *     the operator's frozen config — so the table below is the whole trust
 *     boundary written out. TRAILING run only, correlated by `toolCallId`,
 *     `isError` excluded, structured fields only, malformed input skipped.
 *  2. The wrappers thread that decision into `withCostCenter(…, authorize)` and
 *     nothing else, and skip the session-wallet preflight for an attributed
 *     call. Those tests run a REAL headless governor with an injected engine,
 *     so what they observe is the account the hold actually debited and the
 *     record the audit chain actually kept — not a mock of our own wrapper.
 *
 * Shapes come from `contract-notes.md` §2 (`role: "toolResult"`, `toolName`,
 * `toolCallId` → the preceding assistant message's `ToolCall.id`, required
 * `isError`) via `host-fixtures.ts`; nothing here guesses a field name.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Governor, TrustOpts } from "usertrust";
import { createGovernor, TrustTBClient } from "usertrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveAttribution } from "../src/attribution.js";
import { normalizeCostCenters } from "../src/index.js";
import { wrapCompleteWithGovernance, wrapStreamWithGovernance } from "../src/stream-governor.js";
import type { Context, FrozenCostCenters, Message, StreamEvent, Usage } from "../src/types.js";
import {
	assistantToolCalls,
	doneEvent,
	makeAssistantMessage,
	makeModel,
	makeUsage,
	startEvent,
	streamOf,
	toolResult,
	userMessage,
} from "./host-fixtures.js";

// tigerbeetle-node is a native module and is never loaded in unit tests.
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

// ── Frozen operator config (the ONLY source of cost-center strings) ──

const PARENT = "acme";
const PERIOD_START = Date.UTC(2026, 7, 3, 0, 0, 0);

/** The map every table row below is read against — normalized through the real door. */
const CC: FrozenCostCenters = normalizeCostCenters({
	parentUserId: PARENT,
	tools: { web_search: "research", read_file: "verification" },
	default: "general",
	envelopes: {
		research: { allocated: 10_000, periodStartMs: PERIOD_START },
		verification: { allocated: 5_000, periodStartMs: PERIOD_START },
		general: { allocated: 1_000, periodStartMs: PERIOD_START },
	},
});

/**
 * Same map with NO `default` — the "unattributed rather than fall back" config.
 *
 * `scarcityContext: false`: this fixture pins ATTRIBUTION routing (this file's
 * Part 2), which is orthogonal to per-turn scarcity injection (Ship 2 Task 6)
 * — the block reads every configured envelope on every governed call the
 * operator enables it for, independent of any one call's own attribution. Left
 * at its `true` default here, every `lookupBalances` assertion below would be
 * pinning Task 6's behavior instead of Task 5's; turned off, this file stays
 * about what it says it's about.
 */
const CC_NO_DEFAULT: FrozenCostCenters = normalizeCostCenters({
	parentUserId: PARENT,
	tools: { web_search: "research", read_file: "verification" },
	envelopes: {
		research: { allocated: 10_000, periodStartMs: PERIOD_START },
		verification: { allocated: 5_000, periodStartMs: PERIOD_START },
	},
	scarcityContext: false,
});

// ── Part 1: deriveAttribution (pure) ──

/** `messages` is `unknown[]`, so a row may hold deliberately malformed entries. */
interface Row {
	name: string;
	messages: unknown[];
	expected: string | undefined;
	cc?: FrozenCostCenters;
}

const ROWS: Row[] = [
	// — the happy path —
	{
		name: "a trailing correlated tool-result run attributes to the mapped envelope",
		messages: [userMessage("find it"), assistantToolCalls("web_search"), toolResult("web_search")],
		expected: "research",
	},
	{
		name: "the FIRST mapped name in the run wins, not the last",
		messages: [
			userMessage("go"),
			assistantToolCalls("read_file", "web_search"),
			toolResult("read_file"),
			toolResult("web_search"),
		],
		expected: "verification",
	},
	{
		name: "an unmapped name earlier in the run does not shadow a mapped one after it",
		messages: [
			userMessage("go"),
			assistantToolCalls("unknown_tool", "web_search"),
			toolResult("unknown_tool"),
			toolResult("web_search"),
		],
		expected: "research",
	},
	{
		name: "only the LAST turn's run is read — the previous turn's results are not",
		messages: [
			userMessage("go"),
			assistantToolCalls("web_search"),
			toolResult("web_search"),
			assistantToolCalls("read_file"),
			toolResult("read_file"),
		],
		expected: "verification",
	},

	// — TRAILING only: no stale carry-over into later turns —
	{
		name: "a run followed by the assistant's final answer resets to default",
		messages: [
			userMessage("find it"),
			assistantToolCalls("web_search"),
			toolResult("web_search"),
			makeAssistantMessage(),
		],
		expected: "general",
	},
	{
		name: "a run followed by a NEW user message resets to default (stale carry-over pin)",
		messages: [
			userMessage("find it"),
			assistantToolCalls("web_search"),
			toolResult("web_search"),
			makeAssistantMessage(),
			userMessage("now summarize it"),
		],
		expected: "general",
	},

	// — correlation —
	{
		name: "an uncorrelated result (no such toolCallId on the preceding turn) never attributes",
		messages: [
			userMessage("go"),
			assistantToolCalls("read_file"),
			toolResult("web_search", { toolCallId: "call_from_some_other_turn" }),
		],
		expected: "general",
	},
	{
		name: "a correlated id whose NAME disagrees with the issued call never attributes",
		messages: [
			// `call_read_file` was issued for `read_file`; the result claims `web_search`.
			userMessage("go"),
			assistantToolCalls("read_file"),
			toolResult("web_search", { toolCallId: "call_read_file" }),
		],
		expected: "general",
	},
	{
		name: "an uncorrelated result does not poison a correlated one later in the same run",
		messages: [
			userMessage("go"),
			assistantToolCalls("read_file"),
			toolResult("web_search", { toolCallId: "call_elsewhere" }),
			toolResult("read_file"),
		],
		expected: "verification",
	},
	{
		name: "a run whose preceding message is not an assistant turn never attributes",
		messages: [userMessage("go"), toolResult("web_search")],
		expected: "general",
	},
	{
		name: "a run preceded by an assistant turn that issued NO tool calls never attributes",
		messages: [userMessage("go"), makeAssistantMessage(), toolResult("web_search")],
		expected: "general",
	},
	{
		name: "a run at the very start of the context never attributes",
		messages: [toolResult("web_search")],
		expected: "general",
	},

	// — isError: both ways —
	{
		name: "an error-only run attributes to default",
		messages: [
			userMessage("go"),
			assistantToolCalls("web_search"),
			toolResult("web_search", { isError: true }),
		],
		expected: "general",
	},
	{
		name: "a mixed run takes the first NON-ERROR mapped name (error first)",
		messages: [
			userMessage("go"),
			assistantToolCalls("web_search", "read_file"),
			toolResult("web_search", { isError: true }),
			toolResult("read_file"),
		],
		expected: "verification",
	},
	{
		name: "a mixed run takes the first NON-ERROR mapped name (error second)",
		messages: [
			userMessage("go"),
			assistantToolCalls("web_search", "read_file"),
			toolResult("web_search"),
			toolResult("read_file", { isError: true }),
		],
		expected: "research",
	},

	// — the fallbacks —
	{
		name: "a run of only unmapped names attributes to default",
		messages: [userMessage("go"), assistantToolCalls("unknown_tool"), toolResult("unknown_tool")],
		expected: "general",
	},
	{
		name: "no tool results at all attributes to default",
		messages: [userMessage("hi")],
		expected: "general",
	},
	{ name: "turn 1 (an empty context) attributes to default", messages: [], expected: "general" },
	{
		name: "no default configured leaves an unmapped run UNATTRIBUTED",
		messages: [userMessage("go"), assistantToolCalls("unknown_tool"), toolResult("unknown_tool")],
		expected: undefined,
		cc: CC_NO_DEFAULT,
	},
	{
		name: "no default configured leaves a context with no tool results UNATTRIBUTED",
		messages: [userMessage("hi")],
		expected: undefined,
		cc: CC_NO_DEFAULT,
	},
	{
		name: "no default configured still attributes a mapped run",
		messages: [userMessage("go"), assistantToolCalls("web_search"), toolResult("web_search")],
		expected: "research",
		cc: CC_NO_DEFAULT,
	},

	// — structured fields ONLY: free text never matches —
	{
		name: 'a user message reading "I called web_search" never attributes',
		messages: [userMessage("I called web_search and it worked")],
		expected: "general",
	},
	{
		name: "an assistant message whose TEXT names a mapped tool never attributes",
		messages: [
			userMessage("go"),
			{ ...makeAssistantMessage(), content: [{ type: "text", text: "web_search" }] },
		],
		expected: "general",
	},
	{
		name: "a tool result whose CONTENT names a mapped tool never attributes on that text",
		messages: [
			userMessage("go"),
			assistantToolCalls("unknown_tool"),
			toolResult("unknown_tool", { content: [{ type: "text", text: "ran web_search" }] }),
		],
		expected: "general",
	},

	// — prototype hazards: the map is read with Object.hasOwn, never `in` —
	{
		name: 'a tool named "toString" does not resolve through Object.prototype',
		messages: [userMessage("go"), assistantToolCalls("toString"), toolResult("toString")],
		expected: "general",
	},
	{
		name: 'a tool named "constructor" does not resolve through Object.prototype',
		messages: [userMessage("go"), assistantToolCalls("constructor"), toolResult("constructor")],
		expected: "general",
	},

	// — malformed input is SKIPPED, never thrown on —
	{
		name: "null / primitive entries at the tail of the context are not a run",
		messages: [userMessage("go"), assistantToolCalls("web_search"), null, "toolResult", 42],
		expected: "general",
	},
	{
		name: "an ARRAY entry at the tail of the context is not a run",
		messages: [userMessage("go"), assistantToolCalls("web_search"), [toolResult("web_search")]],
		expected: "general",
	},
	{
		name: "an ARRAY block inside the preceding assistant turn's content is skipped",
		messages: [
			userMessage("go"),
			{
				...makeAssistantMessage(),
				content: [[{ type: "toolCall", id: "call_web_search", name: "web_search" }]],
			},
			toolResult("web_search"),
		],
		expected: "general",
	},
	{
		name: "a tool result with a non-string toolName is skipped",
		messages: [
			userMessage("go"),
			assistantToolCalls("web_search"),
			{ ...toolResult("web_search"), toolName: 7 },
		],
		expected: "general",
	},
	{
		name: "a tool result with a non-string toolCallId is skipped",
		messages: [
			userMessage("go"),
			assistantToolCalls("web_search"),
			{ ...toolResult("web_search"), toolCallId: { id: "call_web_search" } },
		],
		expected: "general",
	},
	{
		name: "a tool result with a MISSING isError is excluded (only an explicit false counts)",
		messages: [
			userMessage("go"),
			assistantToolCalls("web_search"),
			{ role: "toolResult", toolCallId: "call_web_search", toolName: "web_search" },
		],
		expected: "general",
	},
	{
		name: "a malformed result does not stop a well-formed one later in the same run",
		messages: [
			userMessage("go"),
			assistantToolCalls("web_search", "read_file"),
			{ role: "toolResult", toolCallId: null, toolName: "web_search", isError: false },
			toolResult("read_file"),
		],
		expected: "verification",
	},
	{
		name: "malformed toolCall blocks on the preceding assistant turn are skipped",
		messages: [
			userMessage("go"),
			{
				...makeAssistantMessage(),
				content: [null, { type: "toolCall", id: 5, name: "web_search" }, "toolCall"],
			},
			toolResult("web_search"),
		],
		expected: "general",
	},
	{
		name: "an assistant turn whose content is not an array never correlates",
		messages: [
			userMessage("go"),
			{ ...makeAssistantMessage(), content: "web_search" },
			toolResult("web_search"),
		],
		expected: "general",
	},
];

describe("deriveAttribution", () => {
	for (const row of ROWS) {
		it(row.name, () => {
			expect(deriveAttribution(row.messages, row.cc ?? CC)).toBe(row.expected);
		});
	}

	it("never mutates the context it reads", () => {
		const messages: Message[] = [
			userMessage("go"),
			assistantToolCalls("web_search"),
			toolResult("web_search"),
		];
		const before = JSON.stringify(messages);
		deriveAttribution(messages, CC);
		expect(JSON.stringify(messages)).toBe(before);
	});

	it("returns only strings the OPERATOR wrote — never a tool name", () => {
		// The whole cc-provenance invariant in one assertion: every value the
		// function can return is a key of the operator's own `envelopes` map, so
		// no agent-authored string can become a cost center.
		const allowed = new Set(Object.keys(CC.envelopes));
		for (const row of ROWS) {
			const derived = deriveAttribution(row.messages, row.cc ?? CC);
			if (derived !== undefined) expect(allowed.has(derived)).toBe(true);
		}
	});
});

// ── Part 2: the wrappers ──

const MODEL = makeModel();

const ENVELOPE_RESEARCH = TrustTBClient.deriveCostCenterAccountId(PARENT, "research");
const ENVELOPE_VERIFICATION = TrustTBClient.deriveCostCenterAccountId(PARENT, "verification");

/** A context whose trailing run maps to `research` / `verification` / nothing. */
function contextFor(toolName: string): Context {
	return {
		messages: [userMessage("go"), assistantToolCalls(toolName), toolResult(toolName)],
	};
}
const UNATTRIBUTED: Context = { messages: [userMessage("hi")] };

function makeMockEngine(balance: number) {
	return {
		spendPending: vi.fn(
			async (p: { transferId: string; amount: number; debitAccountId?: bigint | undefined }) => ({
				transferId: p.transferId,
			}),
		),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		voidAllPending: vi.fn(async () => {}),
		destroy: vi.fn(),
		lookupBalances: vi.fn(
			async (ids: bigint[]) => new Map<bigint, number>(ids.map((id) => [id, balance])),
		),
	};
}
type MockEngine = ReturnType<typeof makeMockEngine>;

type AppendInput = Parameters<NonNullable<TrustOpts["_audit"]>["appendEvent"]>[0];

function makeMockAudit(): { writer: NonNullable<TrustOpts["_audit"]>; events: AppendInput[] } {
	const events: AppendInput[] = [];
	return {
		events,
		writer: {
			appendEvent: vi.fn(async (input: AppendInput) => {
				events.push(input);
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
			getWriteFailures: vi.fn(() => 0),
			isDegraded: vi.fn(() => false),
			flush: vi.fn(async () => {}),
			release: vi.fn(),
		},
	};
}

/** The account each `spendPending` call debited, in order (`undefined` = session wallet). */
function debitedAccounts(engine: MockEngine): (bigint | undefined)[] {
	return engine.spendPending.mock.calls.map((call) => call[0].debitAccountId);
}

function auditData(events: AppendInput[], kind: string): Record<string, unknown> {
	const event = events.find((e) => e.kind === kind);
	if (event === undefined) {
		throw new Error(`no ${kind} audit event (saw: ${events.map((e) => e.kind).join(", ")})`);
	}
	return event.data;
}

/** A host stream that carries provider usage, so the settle is a real one. */
function okStream(usage: Usage = makeUsage(50, 20)) {
	return streamOf([startEvent(), doneEvent(usage)]);
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<void> {
	for await (const _event of stream) {
		// consume
	}
}

describe("governed wrappers route attributed calls to the mapped envelope", () => {
	let vaultBase: string;
	let engine: MockEngine;
	let audit: ReturnType<typeof makeMockAudit>;
	let gov: Governor;

	beforeEach(async () => {
		vaultBase = join(tmpdir(), `openclaw-attribution-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		process.env.USERTRUST_TEST = "1";
		engine = makeMockEngine(4_000);
		audit = makeMockAudit();
		gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: audit.writer,
		});
	});

	afterEach(async () => {
		process.env.USERTRUST_TEST = "";
		await gov.destroy();
		vi.restoreAllMocks();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("places the PENDING hold against the envelope the trailing tool-result run names", async () => {
		const wrapped = wrapStreamWithGovernance(okStream(), gov, { costCenters: CC });

		await drain(await wrapped(MODEL, contextFor("web_search")));

		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(debitedAccounts(engine)).toEqual([ENVELOPE_RESEARCH]);
	});

	it("re-derives per call — the same wrapped fn routes each context to its own envelope", async () => {
		// The statelessness pin. One wrapper, three calls, three different
		// answers: nothing about the previous call survives into the next, so
		// there is no per-conversation state to isolate or to go stale.
		const wrapped = wrapStreamWithGovernance(okStream(), gov, { costCenters: CC });

		await drain(await wrapped(MODEL, contextFor("web_search")));
		await drain(await wrapped(MODEL, contextFor("read_file")));
		await drain(await wrapped(MODEL, contextFor("unknown_tool")));

		expect(debitedAccounts(engine)).toEqual([
			ENVELOPE_RESEARCH,
			ENVELOPE_VERIFICATION,
			// `unknown_tool` is unmapped → the config's `default` envelope.
			TrustTBClient.deriveCostCenterAccountId(PARENT, "general"),
		]);
	});

	it("settles AFTER the stream, outside every scope, still on the handle's envelope", async () => {
		// `withCostCenter` wraps `authorize()` and nothing else — its scope has
		// already exited by the time the stream is even subscribed to, let alone
		// settled. So a settle that lands on `research` proves the governor's own
		// authorize-time capture carried it, which is the ALS discipline this
		// wrapper depends on.
		const settleSpy = vi.spyOn(gov, "settle");
		const wrapped = wrapStreamWithGovernance(okStream(), gov, { costCenters: CC });

		await drain(await wrapped(MODEL, contextFor("web_search")));

		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(auditData(audit.events, "llm_call").costCenter).toBe("research");
		// The post-settle snapshot read the envelope the hold debited.
		expect(engine.lookupBalances.mock.calls.at(-1)?.[0]).toEqual([ENVELOPE_RESEARCH]);

		// And the envelope METADATA reached the scope: 4_000 available against the
		// frozen config's `allocated: 10_000`. A wrapper that passed the cc string
		// without `envelopes[cc]` would report `remaining` and no `fraction`.
		const receipt = await settleSpy.mock.results[0]?.value;
		expect(receipt.budget).toEqual({ costCenter: "research", remaining: 4_000, fraction: 0.4 });
	});

	it("leaves an unattributed call on the SESSION wallet", async () => {
		const wrapped = wrapStreamWithGovernance(okStream(), gov, { costCenters: CC_NO_DEFAULT });

		await drain(await wrapped(MODEL, UNATTRIBUTED));

		expect(debitedAccounts(engine)).toEqual([undefined]);
		// No envelope to read, so none is read.
		expect(engine.lookupBalances).not.toHaveBeenCalled();
		expect("costCenter" in auditData(audit.events, "llm_call")).toBe(false);
	});

	it("is byte-identical to the pre-envelope wrapper when no costCenters are configured", async () => {
		// Same context that WOULD attribute — without the config there is nothing
		// to attribute against, so the hold stays on the session wallet.
		const wrapped = wrapStreamWithGovernance(okStream(), gov);

		await drain(await wrapped(MODEL, contextFor("web_search")));

		expect(debitedAccounts(engine)).toEqual([undefined]);
		expect(engine.lookupBalances).not.toHaveBeenCalled();
		expect("costCenter" in auditData(audit.events, "llm_call")).toBe(false);
	});

	it("routes the completion wrapper from the SAME derivation", async () => {
		const complete = wrapCompleteWithGovernance(async () => ({ usage: makeUsage(50, 20) }), gov, {
			costCenters: CC,
		});

		await complete(MODEL, contextFor("read_file"));
		await complete(MODEL, UNATTRIBUTED);

		expect(debitedAccounts(engine)).toEqual([
			ENVELOPE_VERIFICATION,
			// Unmapped/no run → the config's `default`, exactly as the stream path.
			TrustTBClient.deriveCostCenterAccountId(PARENT, "general"),
		]);
	});
});

describe("the session-wallet preflight is skipped for an ATTRIBUTED call", () => {
	let vaultBase: string;
	let engine: MockEngine;
	let gov: Governor;

	beforeEach(async () => {
		vaultBase = join(tmpdir(), `openclaw-attribution-preflight-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		process.env.USERTRUST_TEST = "1";
		engine = makeMockEngine(4_000);
		gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			parentUserId: PARENT,
			_engine: engine,
			_audit: makeMockAudit().writer,
		});
		// The gate under test is literally `governor.budgetRemaining() <= 0`.
		// Stubbing the reader is what isolates it: spending the wallet down for
		// real would also change what the POLICY gate sees, and then a denial
		// could no longer be attributed to the preflight specifically.
		vi.spyOn(gov, "budgetRemaining").mockReturnValue(0);
	});

	afterEach(async () => {
		process.env.USERTRUST_TEST = "";
		vi.restoreAllMocks();
		await gov.destroy();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("lets an attributed stream call PROCEED to authorize on an exhausted session wallet", async () => {
		const wrapped = wrapStreamWithGovernance(okStream(), gov, { costCenters: CC });

		await drain(await wrapped(MODEL, contextFor("web_search")));

		// The envelope is independently funded; the session wallet never pays it.
		expect(debitedAccounts(engine)).toEqual([ENVELOPE_RESEARCH]);
	});

	it("still DENIES an unattributed stream call at the preflight", async () => {
		const wrapped = wrapStreamWithGovernance(okStream(), gov, { costCenters: CC_NO_DEFAULT });

		await expect(drain(await wrapped(MODEL, UNATTRIBUTED))).rejects.toThrow(/budget exhausted/);
		expect(engine.spendPending).not.toHaveBeenCalled();
	});

	it("still denies EVERY call when no costCenters are configured", async () => {
		const wrapped = wrapStreamWithGovernance(okStream(), gov);

		await expect(drain(await wrapped(MODEL, contextFor("web_search")))).rejects.toThrow(
			/budget exhausted/,
		);
		expect(engine.spendPending).not.toHaveBeenCalled();
	});

	it("rejects result() with the denial, not just the iteration", async () => {
		const wrapped = wrapStreamWithGovernance(okStream(), gov);
		const stream = await wrapped(MODEL, UNATTRIBUTED);

		await expect(stream.result()).rejects.toThrow(/budget exhausted/);
	});

	it("applies the same bypass and the same denial to the completion wrapper", async () => {
		const complete = wrapCompleteWithGovernance(async () => ({ usage: makeUsage(50, 20) }), gov, {
			costCenters: CC,
		});

		await complete(MODEL, contextFor("web_search"));
		expect(debitedAccounts(engine)).toEqual([ENVELOPE_RESEARCH]);

		const unattributed = wrapCompleteWithGovernance(
			async () => ({ usage: makeUsage(50, 20) }),
			gov,
			{ costCenters: CC_NO_DEFAULT },
		);
		await expect(unattributed(MODEL, UNATTRIBUTED)).rejects.toThrow(/budget exhausted/);
		expect(engine.spendPending).toHaveBeenCalledOnce();
	});
});

// ── Part 3: index.ts threads the frozen config into BOTH wrap seams ──

describe("the frozen config reaches every wrap seam index.ts owns", () => {
	let vaultBase: string;

	const PLUGIN_CONFIG = {
		budget: 100_000,
		dryRun: true,
		costCenters: {
			parentUserId: PARENT,
			tools: { web_search: "research" },
			envelopes: { research: { allocated: 10_000, periodStartMs: PERIOD_START } },
		},
	};

	beforeEach(() => {
		vaultBase = join(tmpdir(), `openclaw-attribution-seam-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(async () => {
		process.env.USERTRUST_TEST = "";
		vi.restoreAllMocks();
		const mod = await import("../src/index.js");
		await mod.shutdown();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	/**
	 * The cost center the governor was standing in when it authorized — read off
	 * the handle it returned, which is where an active scope lands it. Init is
	 * lazy, so the caller has to make one warm-up call before the governor the
	 * spy attaches to exists.
	 */
	async function costCenterOfNextAuthorize(
		call: () => Promise<void>,
		warmup: () => Promise<void>,
	): Promise<string | undefined> {
		const { getGovernor } = await import("../src/index.js");
		await warmup();
		const gov = getGovernor();
		expect(gov).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: guarded by the expect above
		const spy = vi.spyOn(gov!, "authorize");
		await call();
		const auth = await spy.mock.results[0]?.value;
		return auth.costCenter;
	}

	it("createUsertrustPlugin's wrapStreamFn attributes from the plugin config", async () => {
		const { createUsertrustPlugin } = await import("../src/index.js");
		const plugin = createUsertrustPlugin({ ...PLUGIN_CONFIG, vaultBase });
		const wrapped = plugin.wrapStreamFn?.({
			provider: "anthropic",
			modelId: MODEL.id,
			streamFn: okStream(),
		});
		expect(wrapped).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: guarded by the expect above
		const run = async (ctx: Context) => drain(await wrapped!(MODEL, ctx));

		const costCenter = await costCenterOfNextAuthorize(
			() => run(contextFor("web_search")),
			() => run(UNATTRIBUTED),
		);

		expect(costCenter).toBe("research");
	});

	it("createGovernedStreamFn attributes from the same config (its own wrap seam)", async () => {
		const { createGovernedStreamFn } = await import("../src/index.js");
		const { governedStreamFn } = await createGovernedStreamFn(okStream(), {
			...PLUGIN_CONFIG,
			vaultBase,
		});
		const run = async (ctx: Context) => drain(await governedStreamFn(MODEL, ctx));

		const costCenter = await costCenterOfNextAuthorize(
			() => run(contextFor("web_search")),
			() => run(UNATTRIBUTED),
		);

		expect(costCenter).toBe("research");
	});
});
