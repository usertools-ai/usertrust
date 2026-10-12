// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `Governor.recordUnheldSettlement()`: a settle for a hold the governor no longer has is a
 * RECORD, never silence, and never anything else.
 *
 * A hold swept by its TTL, lost to a restart or already settled leaves a client's later settle
 * with nothing to settle: real provider spend the ledger will never charge. This pins that it is
 * written to the chain as `settlement_unrecoverable`, and that writing it can never move money or
 * re-open a hold: no ledger call, no budget change, no hold left behind. It also pins the retry
 * memory (bounded, FIFO, a duplicate record past it and never a lost one), the failed append
 * (thrown, and not remembered), and what the record may carry (a hash, never the id).
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import {
	createGovernor,
	type Governor,
	UNHELD_RECORD_BURST,
	UNHELD_RECORD_MEMORY,
	UNHELD_RECORD_WINDOW_MS,
} from "../../src/headless.js";
import { UnheldSettlementRateLimitedError } from "../../src/shared/errors.js";
import type { AuditEvent } from "../../src/shared/types.js";

// tigerbeetle-node is a native module and is never loaded in unit tests. The status
// enum carries its reverse mapping, as the real one does: a refused void is named by it.
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
	CreateTransferStatus: {
		created: 4294967295,
		exists: 1,
		exceeds_credits: 22,
		pending_transfer_not_found: 25,
		pending_transfer_expired: 35,
		25: "pending_transfer_not_found",
		35: "pending_transfer_expired",
	},
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

function makeAudit(): AuditWriter & { events: AppendEventInput[] } {
	const events: AppendEventInput[] = [];
	return {
		events,
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
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
	};
}

/** An engine whose void does what each test says; every other call succeeds. */
function makeEngine(voidPending: (transferId: string) => Promise<void>): TrustEngine {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(voidPending),
		voidAllPending: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

const MODEL = "claude-sonnet-4-6";
const AUTHORIZE = { model: MODEL, estimatedInputTokens: 100, maxOutputTokens: 100 };
const BUDGET = 1_000_000;

let vaultBase: string;
let audit: AuditWriter & { events: AppendEventInput[] };
const governors: Governor[] = [];

beforeEach(() => {
	vaultBase = join(tmpdir(), `release-${randomUUID()}`);
	mkdirSync(vaultBase, { recursive: true });
	audit = makeAudit();
});

afterEach(async () => {
	for (const gov of governors.splice(0)) await gov.destroy();
	rmSync(vaultBase, { recursive: true, force: true });
});

const ENGINE_CALLS = [
	"spendPending",
	"postPendingSpend",
	"voidPendingSpend",
	"voidAllPending",
] as const;

function recording(): { gov: () => Promise<Governor>; engine: TrustEngine } {
	const engine = makeEngine(async () => {});
	return {
		engine,
		gov: async () => {
			const g = await createGovernor({ budget: BUDGET, vaultBase, _engine: engine, _audit: audit });
			governors.push(g);
			return g;
		},
	};
}

const kinds = () => audit.events.map((e) => e.kind);
const GONE = "tx_swept_by_ttl";

describe("an unheld settle is recorded", () => {
	it("appends settlement_unrecoverable with the usage, the id only as its hash, and no cost", async () => {
		const { gov } = recording();
		const g = await gov();
		const outcome = await g.recordUnheldSettlement({
			transferId: GONE,
			inputTokens: 120,
			outputTokens: 40,
			cacheReadTokens: 7,
			usageSource: "provider",
			principal: { id: "agent-7", type: "Explore" },
		});
		expect(outcome).toEqual({ outcome: "unrecoverable", recorded: true });
		expect(kinds()).toEqual(["settlement_unrecoverable"]);
		const event = audit.events[0] as AppendEventInput;
		expect(event.data).toMatchObject({
			transferIdHash: createHash("sha256").update(GONE).digest("hex"),
			source: "headless",
			usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 7 },
			usageSource: "provider",
			principal: { id: "agent-7", type: "Explore" },
		});
		expect(JSON.stringify(event)).not.toContain(GONE);
		expect(JSON.stringify(event.data)).not.toMatch(/cost|"model"/);
	});

	it("carries a refused tier as a FLAG with its raw figure: the record does not read as zero provider usage", async () => {
		const { gov } = recording();
		const g = await gov();
		await g.recordUnheldSettlement({
			transferId: GONE,
			inputTokens: 0,
			outputTokens: 9,
			refused: { inputTokens: 150_000_000 },
			usageSource: "provider",
		});
		const event = audit.events[0] as AppendEventInput;
		expect(event.data).toMatchObject({ refused: { inputTokens: 150_000_000 } });
		// and a getter on the refused object is read by name once, never trusted twice
		expect(JSON.stringify(event.data)).not.toContain("NaN");
	});

	it("keeps a refused tier whose figure is not a finite count (a direct JS caller), at a finite stand-in", async () => {
		const g = await recording().gov();
		// Presence is the flag: an unusable figure is still a refusal. Infinity is kept as Number.MAX_VALUE, any
		// other unusable figure as 0, so the record stays JSON-safe; a finite figure is kept as stated.
		const cases: Array<[string, unknown, number]> = [
			["Infinity", Number.POSITIVE_INFINITY, Number.MAX_VALUE],
			["NaN", Number.NaN, 0],
			["-1", -1, 0],
			["5", 5, 5],
		];
		for (const [i, [label, value, figure]] of cases.entries()) {
			await g.recordUnheldSettlement({
				transferId: `tx_refused_${i}`,
				inputTokens: 0,
				outputTokens: 9,
				refused: { inputTokens: value } as unknown as { inputTokens: number },
			});
			const data = (audit.events[i] as AppendEventInput).data as Record<string, unknown>;
			expect(data.refused, label).toEqual({ inputTokens: figure });
			expect(JSON.parse(JSON.stringify(data)), label).toEqual(data);
		}
	});

	it("CONTROL: a refused tier whose value is undefined or null is not a flag", async () => {
		const g = await recording().gov();
		for (const [i, value] of [undefined, null].entries()) {
			await g.recordUnheldSettlement({
				transferId: `tx_unflagged_${i}`,
				inputTokens: 3,
				outputTokens: 9,
				refused: { inputTokens: value } as unknown as { inputTokens: number },
			});
			const data = (audit.events[i] as AppendEventInput).data as Record<string, unknown>;
			expect("refused" in data, String(value)).toBe(false);
		}
	});

	it("drops a count it cannot use instead of fabricating a zero", async () => {
		const g = await recording().gov();
		await g.recordUnheldSettlement({
			transferId: GONE,
			inputTokens: -1,
			outputTokens: Number.NaN,
			cacheReadTokens: 1.5,
			cacheWriteTokens: 9,
		});
		expect((audit.events[0] as AppendEventInput).data.usage).toEqual({ cacheWriteTokens: 9 });
		await g.recordUnheldSettlement({ transferId: "tx_none", inputTokens: -1 });
		expect("usage" in ((audit.events[1] as AppendEventInput).data as object)).toBe(false);
	});

	it("refuses an unusable id or principal before anything is written", async () => {
		const g = await recording().gov();
		await expect(g.recordUnheldSettlement({ transferId: "" })).rejects.toThrow(TypeError);
		await expect(g.recordUnheldSettlement({ transferId: "x".repeat(257) })).rejects.toThrow(
			TypeError,
		);
		await expect(
			g.recordUnheldSettlement({ transferId: GONE, principal: { id: "bad id with spaces" } }),
		).rejects.toThrow(TypeError);
		expect(audit.events).toEqual([]);
	});
});

describe("it is a record ONLY: it can never move money or re-open a hold", () => {
	it("calls no ledger method, changes no budget, and leaves no hold behind", async () => {
		const { gov, engine } = recording();
		const g = await gov();
		const before = g.budgetRemaining();
		await g.recordUnheldSettlement({
			transferId: GONE,
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
		});
		for (const call of ENGINE_CALLS) expect(engine[call]).not.toHaveBeenCalled();
		expect(g.budgetRemaining()).toBe(before);
		// Nothing was reserved under that id: a release or abort of it still finds no hold.
		const ghost = { transferId: GONE, estimatedCost: 1, model: MODEL, createdAt: Date.now() };
		expect(await g.release(ghost)).toEqual({ released: false });
		expect(await g.abort(ghost)).toEqual({ aborted: false });
		for (const call of ENGINE_CALLS) expect(engine[call]).not.toHaveBeenCalled();
		expect(kinds()).toEqual(["settlement_unrecoverable"]);
	});

	it("a live hold is answered held, nothing is recorded, and it still settles afterwards", async () => {
		const { gov, engine } = recording();
		const g = await gov();
		const auth = await g.authorize(AUTHORIZE);
		expect(await g.recordUnheldSettlement({ transferId: auth.transferId, inputTokens: 5 })).toEqual(
			{
				outcome: "held",
				transferId: auth.transferId,
			},
		);
		expect(audit.events).toEqual([]);
		const receipt = await g.settle(auth, { inputTokens: 10, outputTokens: 10 });
		expect(receipt.settled).toBe(true);
		expect(engine.postPendingSpend).toHaveBeenCalledTimes(1);
	});

	it("a hold already settled is unrecoverable (the governor holds nothing for it)", async () => {
		const g = await recording().gov();
		const auth = await g.authorize(AUTHORIZE);
		await g.settle(auth, { inputTokens: 10, outputTokens: 10 });
		audit.events.length = 0;
		expect(await g.recordUnheldSettlement({ transferId: auth.transferId })).toEqual({
			outcome: "unrecoverable",
			recorded: true,
		});
	});

	it("is refused once the governor is destroyed", async () => {
		const g = await recording().gov();
		await g.destroy();
		await expect(g.recordUnheldSettlement({ transferId: GONE })).rejects.toThrow(/destroyed/);
	});
});

describe("an exact retry is one record, within a bounded memory", () => {
	it("the same id and usage again: recorded false, no second record; different usage is recorded", async () => {
		const g = await recording().gov();
		const same = { transferId: GONE, inputTokens: 5, outputTokens: 5 };
		expect(await g.recordUnheldSettlement(same)).toEqual({
			outcome: "unrecoverable",
			recorded: true,
		});
		expect(await g.recordUnheldSettlement(same)).toEqual({
			outcome: "unrecoverable",
			recorded: false,
		});
		expect(audit.events).toHaveLength(1);
		expect(await g.recordUnheldSettlement({ ...same, outputTokens: 6 })).toEqual({
			outcome: "unrecoverable",
			recorded: true,
		});
		expect(audit.events).toHaveLength(2);
	});

	it("the memory is bounded and FIFO: at the bound a retry is still one record; one past it, the oldest is recorded again", async () => {
		const g = await recording().gov();
		// Each record is a window apart: this test is about the retry MEMORY, not the rate cap.
		let tick = 0;
		const clock = vi
			.spyOn(performance, "now")
			.mockImplementation(() => (tick += UNHELD_RECORD_WINDOW_MS));
		const at = (i: number) => ({ transferId: `tx_${i}`, inputTokens: 1 });
		for (let i = 0; i < UNHELD_RECORD_MEMORY; i++) await g.recordUnheldSettlement(at(i));
		expect(audit.events).toHaveLength(UNHELD_RECORD_MEMORY);
		// exactly at the bound: the oldest is still remembered
		expect(await g.recordUnheldSettlement(at(0))).toEqual({
			outcome: "unrecoverable",
			recorded: false,
		});
		expect(audit.events).toHaveLength(UNHELD_RECORD_MEMORY);
		// one more distinct record evicts the oldest ...
		await g.recordUnheldSettlement(at(UNHELD_RECORD_MEMORY));
		// ... so its retry is RECORDED AGAIN: a duplicate record, never a lost one
		expect(await g.recordUnheldSettlement(at(0))).toEqual({
			outcome: "unrecoverable",
			recorded: true,
		});
		// the newest is still remembered
		expect(await g.recordUnheldSettlement(at(UNHELD_RECORD_MEMORY))).toEqual({
			outcome: "unrecoverable",
			recorded: false,
		});
		clock.mockRestore();
	}, 60_000);

	it("an identical retry while the first is being appended shares its outcome", async () => {
		const g = await recording().gov();
		let finish: (() => void) | undefined;
		const append = audit.appendEvent as unknown as ReturnType<typeof vi.fn>;
		const original = append.getMockImplementation() as (i: AppendEventInput) => Promise<AuditEvent>;
		append.mockImplementationOnce(async (input: AppendEventInput) => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return original(input);
		});
		const params = { transferId: GONE, inputTokens: 3 };
		const first = g.recordUnheldSettlement(params);
		const second = g.recordUnheldSettlement(params);
		await new Promise((r) => setTimeout(r, 10));
		expect(append).toHaveBeenCalledTimes(1);
		finish?.();
		expect(await first).toEqual({ outcome: "unrecoverable", recorded: true });
		expect(await second).toEqual({ outcome: "unrecoverable", recorded: false });
		expect(audit.events).toHaveLength(1);
	});
});

describe("a failed append is thrown, never swallowed, and never remembered", () => {
	it("the caller learns it is not on the chain, and the retry records it", async () => {
		const g = await recording().gov();
		const append = audit.appendEvent as unknown as ReturnType<typeof vi.fn>;
		append.mockImplementationOnce(async () => {
			throw new Error("disk full");
		});
		const params = { transferId: GONE, inputTokens: 3 };
		await expect(g.recordUnheldSettlement(params)).rejects.toThrow("disk full");
		expect(await g.recordUnheldSettlement(params)).toEqual({
			outcome: "unrecoverable",
			recorded: true,
		});
		expect(audit.events).toHaveLength(1);
	});
});

describe("the record rate is bounded: refused, never dropped", () => {
	it("past the per-window burst a NEW record throws and writes nothing; identical retries do not count; the window reopens", async () => {
		const g = await recording().gov();
		const now = vi.spyOn(performance, "now");
		now.mockReturnValue(1_000);
		for (let i = 0; i < UNHELD_RECORD_BURST; i++)
			await g.recordUnheldSettlement({ transferId: `tx_${i}` });
		expect(audit.events).toHaveLength(UNHELD_RECORD_BURST);
		// an exact retry is not a new record: it does not consume the window
		expect(await g.recordUnheldSettlement({ transferId: "tx_0" })).toEqual({
			outcome: "unrecoverable",
			recorded: false,
		});
		await expect(g.recordUnheldSettlement({ transferId: "tx_over" })).rejects.toBeInstanceOf(
			UnheldSettlementRateLimitedError,
		);
		expect(audit.events).toHaveLength(UNHELD_RECORD_BURST);
		// the refusal is not remembered: once the window passes, the same settle records
		now.mockReturnValue(1_000 + UNHELD_RECORD_WINDOW_MS);
		expect(await g.recordUnheldSettlement({ transferId: "tx_over" })).toEqual({
			outcome: "unrecoverable",
			recorded: true,
		});
		now.mockRestore();
	});
});

describe("usageTo follows the settle path's rule", () => {
	it("an ISO-8601 UTC instant is kept; anything else (control bytes included) is dropped", async () => {
		const g = await recording().gov();
		await g.recordUnheldSettlement({ transferId: "tx_a", usageTo: "2026-10-11T16:00:00.000Z" });
		await g.recordUnheldSettlement({ transferId: "tx_b", usageTo: "\u001b[2Jnot a time" });
		expect((audit.events[0] as AppendEventInput).data.usageTo).toBe("2026-10-11T16:00:00.000Z");
		expect("usageTo" in ((audit.events[1] as AppendEventInput).data as object)).toBe(false);
	});
});

describe("destroy() waits for a record still being appended", () => {
	it("the writer is not released until the in-flight append lands", async () => {
		const g = await recording().gov();
		const append = audit.appendEvent as unknown as ReturnType<typeof vi.fn>;
		const original = append.getMockImplementation() as (i: AppendEventInput) => Promise<AuditEvent>;
		let finish: (() => void) | undefined;
		append.mockImplementationOnce(async (input: AppendEventInput) => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return original(input);
		});
		const recorded = g.recordUnheldSettlement({ transferId: GONE, inputTokens: 1 });
		await new Promise((r) => setTimeout(r, 20));
		const destroying = g.destroy();
		await new Promise((r) => setTimeout(r, 200));
		expect(audit.release).not.toHaveBeenCalled();
		finish?.();
		expect(await recorded).toEqual({ outcome: "unrecoverable", recorded: true });
		await destroying;
		expect(audit.release).toHaveBeenCalled();
	});
});

describe("caller input is read ONCE", () => {
	it("a getter that answers differently on a second read cannot put unchecked text on the chain", async () => {
		const g = await recording().gov();
		const reads = { usageTo: 0, usageSource: 0, computeMs: 0, transferId: 0, inputTokens: 0 };
		const params = {
			get transferId() {
				reads.transferId += 1;
				return reads.transferId === 1 ? GONE : "tx_second_read";
			},
			get usageTo() {
				reads.usageTo += 1;
				return reads.usageTo === 1 ? "2026-10-11T16:00:00.000Z" : "\u001b[2Jevil";
			},
			get usageSource() {
				reads.usageSource += 1;
				return reads.usageSource === 1 ? "provider" : "not-a-source";
			},
			get computeMs() {
				reads.computeMs += 1;
				return reads.computeMs === 1 ? 5 : -1;
			},
			get inputTokens() {
				reads.inputTokens += 1;
				return reads.inputTokens === 1 ? 7 : -1;
			},
		} as unknown as Parameters<Governor["recordUnheldSettlement"]>[0];
		await g.recordUnheldSettlement(params);
		expect(reads).toEqual({
			usageTo: 1,
			usageSource: 1,
			computeMs: 1,
			transferId: 1,
			inputTokens: 1,
		});
		expect((audit.events[0] as AppendEventInput).data).toMatchObject({
			transferIdHash: createHash("sha256").update(GONE).digest("hex"),
			usageTo: "2026-10-11T16:00:00.000Z",
			usageSource: "provider",
			computeMs: 5,
			usage: { inputTokens: 7 },
		});
	});
});

describe("a rejected append that is already durable is a record, not a failure to retry", () => {
	it("an error carrying the durable event hash counts as recorded, and the retry writes nothing", async () => {
		const g = await recording().gov();
		const append = audit.appendEvent as unknown as ReturnType<typeof vi.fn>;
		append.mockImplementationOnce(async (input: AppendEventInput) => {
			// What the writer does when the event is fsynced and its sidecar then fails.
			audit.events.push(input);
			throw Object.assign(new Error("sidecar write failed"), {
				[Symbol.for("usertrust.audit.durableEventHash")]: "d".repeat(64),
			});
		});
		const params = { transferId: GONE, inputTokens: 3 };
		expect(await g.recordUnheldSettlement(params)).toEqual({
			outcome: "unrecoverable",
			recorded: true,
		});
		expect(await g.recordUnheldSettlement(params)).toEqual({
			outcome: "unrecoverable",
			recorded: false,
		});
		expect(audit.events).toHaveLength(1);
	});

	it("an ordinary failure (nothing durable) is still thrown, and the retry records", async () => {
		const g = await recording().gov();
		const append = audit.appendEvent as unknown as ReturnType<typeof vi.fn>;
		append.mockImplementationOnce(async () => {
			throw new Error("disk full");
		});
		await expect(g.recordUnheldSettlement({ transferId: GONE })).rejects.toThrow("disk full");
		expect(await g.recordUnheldSettlement({ transferId: GONE })).toEqual({
			outcome: "unrecoverable",
			recorded: true,
		});
	});
});
