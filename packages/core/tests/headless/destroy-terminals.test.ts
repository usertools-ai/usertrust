// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * destroy() and the terminals still working when it runs (#243).
 *
 * destroy() waited for settles only. An abort() or release() that had claimed its hold
 * and was parked on its ledger void (or on the budget lock) was in neither of the maps
 * destroy() walks: the engine sweep voided the hold under it, and its own record landed
 * after the audit writer was released, taking the vault's lock again. And every hold
 * destroy() ended itself ended with no record at all.
 *
 * Pinned here:
 *  - destroy() waits for a parked abort or release, session hold or attributed: the
 *    terminal lands its own void and its own record, and the sweep finds nothing;
 *  - ONE deadline for every terminal still working. A void that never opens holds
 *    destroy() no longer than that bound; the hold gets exactly one record (destroy()'s)
 *    and one ledger void, and keeps them when the parked void finally lands;
 *  - every hold destroy() ends itself is recorded, attributed, with the void's fixed code
 *    when the ledger refused it, and no model (the capture holds none);
 *  - a terminal called while destroy() is ending holds finds nothing to end, and an
 *    authorize still reserving when destroy() began registers no hold;
 *  - destroy() takes every remaining hold in one synchronous step at its deadline, before
 *    its first await: a release, an abort or a settle called while it records a terminal
 *    still in flight is refused, and nothing is appended after the writer is released;
 *  - while destroy() drains, a release, an abort or a settle runs as before and is waited
 *    for: a settle started then is billed once;
 *  - against the real audit writer, nothing appends after destroy() released it: an
 *    append there lands, and takes the vault's lock again for the life of the process.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { withCostCenter } from "../../src/budget/attribution.js";
import type { TrustEngine } from "../../src/govern.js";
import { type Authorization, createGovernor, type Governor } from "../../src/headless.js";
import { TBTransferError } from "../../src/ledger/client.js";
import { PendingEntryNotFoundError } from "../../src/shared/errors.js";
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
		pending_transfer_already_voided: 34,
		pending_transfer_expired: 35,
		25: "pending_transfer_not_found",
		34: "pending_transfer_already_voided",
		35: "pending_transfer_expired",
	},
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const MODEL = "claude-sonnet-4-6";
const PRINCIPAL = { id: "agent-7", type: "Explore", origin: "claude-code:s1" };
const AUTHORIZE = { model: MODEL, estimatedInputTokens: 100, maxOutputTokens: 100 };
const SCOPE_OPTS = { allocated: 10_000, periodStartMs: Date.UTC(2026, 9, 1, 0, 0, 0) };
/** destroy()'s drain bound, shortened for the tests that run it out. */
const BOUND_MS = 300;
/** destroy()'s record for a terminal still in flight at its deadline: what it knew, no more. */
const STILL_IN_FLIGHT = "governor destroyed (terminal still in flight: its void had not completed)";

type Hold = "session" | "attributed";
type Terminal = "release" | "abort";
const RECORD: Record<Terminal, string> = { release: "hold_released", abort: "llm_call_failed" };

let vaultBase: string;
let events: AppendEventInput[];
/**
 * The fake writer's own account: whether it was released, every record appended after
 * that, and a gate the NEXT append parks on (one append; then it is spent).
 */
let writer: {
	released: boolean;
	lateAppends: AppendEventInput[];
	nextAppendWaits: Promise<void> | undefined;
};
const governors: Governor[] = [];

beforeEach(() => {
	vaultBase = join(tmpdir(), `destroy-terminals-${randomUUID()}`);
	mkdirSync(vaultBase, { recursive: true });
	events = [];
	writer = { released: false, lateAppends: [], nextAppendWaits: undefined };
});

afterEach(async () => {
	for (const gov of governors.splice(0)) await gov.destroy();
	rmSync(vaultBase, { recursive: true, force: true });
});

function audit(): AuditWriter {
	return {
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			if (writer.released) writer.lateAppends.push(input);
			const waits = writer.nextAppendWaits;
			writer.nextAppendWaits = undefined;
			await waits;
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
		release: vi.fn(() => {
			writer.released = true;
		}),
	};
}

/** A gate the test opens; every call parked on it waits until then. */
function gate(): { wait: Promise<void>; open: () => void } {
	let open = (): void => {};
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { wait, open };
}

/**
 * A ledger with the engine's own shape. The engine keeps an entry per hold, which
 * `voidAllPending` sweeps; the ledger keeps the pending transfers, and refuses a void or a
 * POST of one no longer pending, as TigerBeetle refuses a second void. Every void request
 * that reaches the ledger is logged, by the engine call that sent it and whether the
 * ledger took it; every mutation the ledger took is logged on its own.
 *
 * As in the real engine, a hold's entry goes only when its own void (or POST) returns. So
 * `voidAllPending` also reaches a hold whose terminal is parked on its void: a second void
 * request for one pending transfer. A gate parks a call where the real engine awaits the
 * ledger: a void or POST after its entry lookup, a reserve before the ledger has the hold.
 * `gates` is read at call time, so a test can arm one later.
 */
function ledgerEngine(
	gates: { void?: Promise<void>; post?: Promise<void>; reserve?: Promise<void> } = {},
): {
	engine: TrustEngine;
	mutations: string[];
	voidRequests: Array<{
		transferId: string;
		via: "voidPendingSpend" | "voidAllPending";
		taken: boolean;
	}>;
	reserved: string[];
	refuseVoids: () => void;
} {
	const entries = new Set<string>();
	const pending = new Set<string>();
	const mutations: string[] = [];
	const voidRequests: Array<{
		transferId: string;
		via: "voidPendingSpend" | "voidAllPending";
		taken: boolean;
	}> = [];
	const reserved: string[] = [];
	let refuse = false;
	const engine: TrustEngine = {
		spendPending: vi.fn(async (p: { transferId: string }) => {
			await gates.reserve;
			pending.add(p.transferId);
			entries.add(p.transferId);
			reserved.push(p.transferId);
			return { transferId: p.transferId };
		}),
		postPendingSpend: vi.fn(async (transferId: string) => {
			if (!entries.has(transferId)) throw new Error(`No pending transfer found for ${transferId}`);
			await gates.post;
			if (!pending.delete(transferId)) {
				throw new TBTransferError(34, "Post transfer failed: pending_transfer_already_voided");
			}
			mutations.push(`post:${transferId}`);
			entries.delete(transferId);
		}),
		voidPendingSpend: vi.fn(async (transferId: string) => {
			if (!entries.has(transferId)) throw new PendingEntryNotFoundError(transferId);
			await gates.void;
			if (refuse) {
				voidRequests.push({ transferId, via: "voidPendingSpend", taken: false });
				throw new TBTransferError(25, "Void transfer failed: pending_transfer_not_found");
			}
			const taken = pending.delete(transferId);
			voidRequests.push({ transferId, via: "voidPendingSpend", taken });
			if (!taken) {
				throw new TBTransferError(34, "Void transfer failed: pending_transfer_already_voided");
			}
			mutations.push(`void:${transferId}`);
			entries.delete(transferId);
		}),
		voidAllPending: vi.fn(async () => {
			for (const transferId of [...entries]) {
				const taken = pending.delete(transferId);
				voidRequests.push({ transferId, via: "voidAllPending", taken });
				if (taken) mutations.push(`void:${transferId}`);
				entries.delete(transferId);
			}
		}),
		lookupBalances: vi.fn(async (ids: bigint[]) => new Map(ids.map((id) => [id, 5_000]))),
		destroy: vi.fn(),
	};
	return {
		engine,
		mutations,
		voidRequests,
		reserved,
		refuseVoids: () => {
			refuse = true;
		},
	};
}

async function governor(engine: TrustEngine | undefined, drainMs?: number): Promise<Governor> {
	const gov = await createGovernor({
		budget: 1_000_000,
		vaultBase,
		parentUserId: "acme",
		_audit: audit(),
		...(engine === undefined ? { dryRun: true } : { _engine: engine }),
		...(drainMs === undefined ? {} : { _destroyDrainMs: drainMs }),
	});
	governors.push(gov);
	return gov;
}

/** A session hold with an actor and a principal, or one attributed to a cost center. */
function hold(gov: Governor, kind: Hold): Promise<Authorization> {
	return kind === "session"
		? gov.authorize({ ...AUTHORIZE, actor: "plugin", principal: PRINCIPAL })
		: withCostCenter("research", () => gov.authorize(AUTHORIZE), SCOPE_OPTS);
}

function end(gov: Governor, auth: Authorization, terminal: Terminal): Promise<unknown> {
	return terminal === "release"
		? gov.release(auth, "given back")
		: gov.abort(auth, new Error("provider 500"));
}

/** What destroy() writes for a hold it ended, attributed as the hold was. */
function destroyRecord(auth: Authorization, kind: Hold, reason: string, voidError?: string) {
	return {
		kind: "hold_released",
		actor: kind === "session" ? "plugin" : "local",
		data: {
			transferId: auth.transferId,
			reason,
			source: "headless",
			...(voidError === undefined ? {} : { voidError }),
			...(kind === "session" ? { principal: PRINCIPAL } : { costCenter: "research" }),
		},
	};
}

const recordsOf = (transferId: string) => events.filter((e) => e.data.transferId === transferId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("destroy() waits for an abort or release still in flight", () => {
	for (const kind of ["session", "attributed"] as const) {
		for (const terminal of ["release", "abort"] as const) {
			it(`${kind} hold, ${terminal}() parked on its void: it lands its own void and record first`, async () => {
				const voids = gate();
				const { engine, mutations, voidRequests } = ledgerEngine({ void: voids.wait });
				const gov = await governor(engine);
				const auth = await hold(gov, kind);
				const ending = end(gov, auth, terminal);
				let destroyed = false;
				const destroying = gov.destroy().then(() => {
					destroyed = true;
				});
				await sleep(150);
				// Still waiting: the parked terminal owns the hold, and nothing voided it under it.
				expect(destroyed).toBe(false);
				expect(mutations).toEqual([]);
				voids.open();
				expect(await ending).toEqual(
					terminal === "release" ? { released: true } : { aborted: true },
				);
				await destroying;
				// One void, the terminal's own; the sweep found nothing left to ask about.
				expect(mutations).toEqual([`void:${auth.transferId}`]);
				expect(voidRequests).toEqual([
					{ transferId: auth.transferId, via: "voidPendingSpend", taken: true },
				]);
				// One record, the terminal's own, with its reason and no voidError.
				const records = recordsOf(auth.transferId);
				expect(records.map((e) => e.kind)).toEqual([RECORD[terminal]]);
				expect(records[0]?.data).toMatchObject(
					terminal === "release" ? { reason: "given back" } : { error: "provider 500" },
				);
				expect(records[0]?.data).not.toHaveProperty("voidError");
			});
		}
	}
});

describe("ONE deadline: what never finishes holds destroy() no longer than its bound", () => {
	for (const terminal of ["release", "abort"] as const) {
		it(`${terminal}() whose void never opens: destroy() returns at the bound, with one void and one record, and both stand when the void lands`, {
			timeout: 3_000,
		}, async () => {
			const voids = gate();
			const { engine, mutations, voidRequests } = ledgerEngine({ void: voids.wait });
			const gov = await governor(engine, BOUND_MS);
			const auth = await hold(gov, "session");
			const ending = end(gov, auth, terminal);
			const started = performance.now();
			await gov.destroy();
			const elapsed = performance.now() - started;
			expect(elapsed).toBeGreaterThanOrEqual(BOUND_MS - 5);
			expect(elapsed).toBeLessThan(BOUND_MS + 700);
			// destroy() recorded the hold its terminal had not, and took the record from it.
			// The record names no voidError: the void had no outcome yet.
			expect(recordsOf(auth.transferId)).toEqual([destroyRecord(auth, "session", STILL_IN_FLIGHT)]);
			// The engine sweep reached the parked hold (its entry goes only when its own void
			// returns), and the ledger took that void.
			expect(voidRequests).toEqual([
				{ transferId: auth.transferId, via: "voidAllPending", taken: true },
			]);
			expect(mutations).toEqual([`void:${auth.transferId}`]);

			// The parked void lands at last: a SECOND void request for the one pending
			// transfer, which the ledger refuses. The terminal answers from its own void, and,
			// its record taken, writes none.
			voids.open();
			expect(await ending).toEqual(
				terminal === "release"
					? { released: true, voidError: "pending_transfer_already_voided" }
					: { aborted: true, voidError: "pending_transfer_already_voided" },
			);
			expect(voidRequests).toEqual([
				{ transferId: auth.transferId, via: "voidAllPending", taken: true },
				{ transferId: auth.transferId, via: "voidPendingSpend", taken: false },
			]);
			expect(mutations).toEqual([`void:${auth.transferId}`]);
			expect(recordsOf(auth.transferId)).toHaveLength(1);
		});
	}

	it("a settle and a release that never finish share one deadline, never one each", {
		timeout: 5_000,
	}, async () => {
		const bound = 600;
		const voids = gate();
		const posts = gate();
		const { engine } = ledgerEngine({ void: voids.wait, post: posts.wait });
		const gov = await governor(engine, bound);
		const posting = await hold(gov, "session");
		const releasing = await hold(gov, "session");
		void gov.settle(posting, { inputTokens: 10, outputTokens: 10 }).catch(() => undefined);
		void gov.release(releasing, "given back");
		const started = performance.now();
		await gov.destroy();
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(bound - 5);
		// One bound for both sets: a bound per set would take twice as long.
		expect(elapsed).toBeLessThan(bound * 2 - 200);
		// The release's hold is recorded by destroy(); the settle's is its settle's own.
		expect(recordsOf(releasing.transferId)).toEqual([
			destroyRecord(releasing, "session", STILL_IN_FLIGHT),
		]);
		expect(recordsOf(posting.transferId).filter((e) => e.kind === "hold_released")).toEqual([]);
	});
});

describe("every hold destroy() ends itself is recorded", () => {
	it("still-active holds, session and attributed: voided once each, and recorded as their holds were attributed", async () => {
		const { engine, mutations } = ledgerEngine();
		const gov = await governor(engine);
		const session = await hold(gov, "session");
		const attributed = await hold(gov, "attributed");
		events.length = 0;
		await gov.destroy();
		expect(mutations.sort()).toEqual(
			[`void:${session.transferId}`, `void:${attributed.transferId}`].sort(),
		);
		expect(events).toEqual([
			destroyRecord(session, "session", "governor destroyed"),
			destroyRecord(attributed, "attributed", "governor destroyed"),
		]);
		// No model: the capture holds none, and the record invents none.
		for (const e of events) expect(e.data).not.toHaveProperty("model");
	});

	it("a hold handed back by a settle that threw before its POST: voided and recorded", async () => {
		const { engine, mutations } = ledgerEngine();
		const gov = await governor(engine);
		const auth = await hold(gov, "session");
		const throwing = Object.create(auth, {
			model: {
				get(): string {
					throw new Error("handle getter threw");
				},
			},
		}) as Authorization;
		await expect(gov.settle(throwing, { inputTokens: 10, outputTokens: 10 })).rejects.toThrow(
			"handle getter threw",
		);
		events.length = 0;
		await gov.destroy();
		expect(mutations).toEqual([`void:${auth.transferId}`]);
		expect(events).toEqual([destroyRecord(auth, "session", "governor destroyed")]);
	});

	it("a void the ledger refused: recorded with its fixed code, never the error's text", async () => {
		const { engine, mutations, voidRequests, refuseVoids } = ledgerEngine();
		const gov = await governor(engine);
		const auth = await hold(gov, "attributed");
		refuseVoids();
		events.length = 0;
		await gov.destroy();
		expect(events).toEqual([
			destroyRecord(auth, "attributed", "governor destroyed", "pending_transfer_not_found"),
		]);
		// Declared residue: a refused void leaves the engine entry, and the engine sweep
		// voids it again, unrecorded. The record says what ITS void did.
		expect(voidRequests).toEqual([
			{ transferId: auth.transferId, via: "voidPendingSpend", taken: false },
			{ transferId: auth.transferId, via: "voidAllPending", taken: true },
		]);
		expect(mutations).toEqual([`void:${auth.transferId}`]);
	});

	it("dry run: recorded, with no void to fail", async () => {
		const gov = await governor(undefined);
		const auth = await hold(gov, "session");
		events.length = 0;
		await gov.destroy();
		expect(events).toEqual([destroyRecord(auth, "session", "governor destroyed")]);
	});

	for (const when of ["while destroy() is ending holds", "after destroy() returned"] as const) {
		it(`an authorize that finishes reserving ${when} registers no hold, and gives its reservation back itself`, async () => {
			const voids = gate();
			const reserves = gate();
			const gates: { void?: Promise<void>; reserve?: Promise<void> } = { void: voids.wait };
			const { engine, mutations, voidRequests, reserved } = ledgerEngine(gates);
			const gov = await governor(engine);
			const first = await hold(gov, "session");
			// The next reserve is still on its way to the ledger when destroy() begins.
			gates.reserve = reserves.wait;
			const late = gov.authorize(AUTHORIZE).then(
				(auth) => auth,
				(err: unknown) => err,
			);
			events.length = 0;
			const destroying = gov.destroy();
			if (when === "while destroy() is ending holds") {
				// destroy() is parked on the first hold's void; the late reserve lands now.
				await sleep(50);
				reserves.open();
				await sleep(50);
				voids.open();
				await destroying;
			} else {
				voids.open();
				await destroying;
				reserves.open();
			}
			const outcome = await late;
			expect(outcome).toBeInstanceOf(Error);
			expect((outcome as Error).message).toBe("Governor has been destroyed");
			expect(reserved).toHaveLength(2);
			const lateId = reserved[1] as string;
			// The authorize voided its own reservation (not left to the engine sweep, which
			// runs before a reserve that lands late), and nothing recorded a hold that was never
			// registered.
			expect(voidRequests.filter((r) => r.transferId === lateId)).toEqual([
				{ transferId: lateId, via: "voidPendingSpend", taken: true },
			]);
			expect(mutations.sort()).toEqual([`void:${first.transferId}`, `void:${lateId}`].sort());
			expect(events).toEqual([destroyRecord(first, "session", "governor destroyed")]);
			// Nothing survived destroy(): the late hold is no one's to end.
			expect(await gov.release({ ...first, transferId: lateId }, "given back")).toEqual({
				released: false,
			});
		});
	}

	it("a terminal called while destroy() is ending holds finds nothing to end", async () => {
		const voids = gate();
		const { engine, mutations } = ledgerEngine({ void: voids.wait });
		const gov = await governor(engine);
		const first = await hold(gov, "session");
		const second = await hold(gov, "session");
		events.length = 0;
		const destroying = gov.destroy();
		// destroy() is parked on the first hold's void; the second is already its own.
		await sleep(80);
		expect(await gov.release(second, "given back")).toEqual({ released: false });
		expect(await gov.abort(second, new Error("provider 500"))).toEqual({ aborted: false });
		voids.open();
		await destroying;
		expect(mutations.sort()).toEqual(
			[`void:${first.transferId}`, `void:${second.transferId}`].sort(),
		);
		expect(events).toEqual([
			destroyRecord(first, "session", "governor destroyed"),
			destroyRecord(second, "session", "governor destroyed"),
		]);
	});
});

describe("claims first: destroy() takes every remaining hold before its first await", () => {
	type Late = "release" | "abort" | "settle";
	/** A terminal on another hold, started from INSIDE destroy()'s record for a stray. */
	function lateCall(gov: Governor, auth: Authorization, terminal: Late): Promise<unknown> {
		if (terminal === "settle") {
			return gov.settle(auth, { inputTokens: 10, outputTokens: 10 }).then(
				(receipt) => receipt,
				(err: unknown) => err,
			);
		}
		return end(gov, auth, terminal);
	}

	for (const terminal of ["release", "abort", "settle"] as const) {
		it(`${terminal}() on another hold, started while destroy() records a terminal still in flight: refused; that hold voided once and recorded once, by destroy(); nothing appended after the writer is released`, {
			timeout: 5_000,
		}, async () => {
			const voids = gate();
			const appends = gate();
			const { engine, mutations, voidRequests } = ledgerEngine({ void: voids.wait });
			const gov = await governor(engine, BOUND_MS);
			const parked = await hold(gov, "session");
			const other = await hold(gov, "session");
			const ending = end(gov, parked, "release");
			events.length = 0;
			// destroy()'s first append, its record for the parked release, parks: destroy() is
			// then inside that append, past its deadline and its claim.
			writer.nextAppendWaits = appends.wait;
			const destroying = gov.destroy();
			await sleep(BOUND_MS + 150);
			expect(events).toEqual([]);

			const answer = await lateCall(gov, other, terminal);
			if (terminal === "settle") {
				expect(answer).toBeInstanceOf(Error);
				expect((answer as Error).message).toBe("Governor has been destroyed");
			} else {
				expect(answer).toEqual(terminal === "release" ? { released: false } : { aborted: false });
			}

			appends.open();
			voids.open();
			await destroying;
			await ending;
			// One ledger mutation for the other hold: the walk's void. No POST.
			expect(mutations.filter((m) => m.endsWith(other.transferId))).toEqual([
				`void:${other.transferId}`,
			]);
			expect(voidRequests.filter((r) => r.transferId === other.transferId)).toEqual([
				{ transferId: other.transferId, via: "voidPendingSpend", taken: true },
			]);
			// One record each, destroy()'s, and nothing after the writer was released.
			expect(recordsOf(other.transferId)).toEqual([
				destroyRecord(other, "session", "governor destroyed"),
			]);
			expect(recordsOf(parked.transferId)).toEqual([
				destroyRecord(parked, "session", STILL_IN_FLIGHT),
			]);
			expect(writer.lateAppends).toEqual([]);
		});
	}
});

describe("while destroy() drains, terminals run as before and are waited for", () => {
	for (const terminal of ["release", "abort"] as const) {
		it(`${terminal}() on another hold, started while destroy() drains: it lands its own void and record, and destroy() waits for it`, async () => {
			const voids = gate();
			const { engine, voidRequests } = ledgerEngine({ void: voids.wait });
			const gov = await governor(engine);
			const parked = await hold(gov, "session");
			const other = await hold(gov, "attributed");
			const ending = end(gov, parked, "release");
			events.length = 0;
			const destroying = gov.destroy();
			await sleep(50);
			// destroy() is draining: it waits for the parked release, and for this one too.
			const late = end(gov, other, terminal);
			voids.open();
			expect(await late).toEqual(terminal === "release" ? { released: true } : { aborted: true });
			expect(await ending).toEqual({ released: true });
			await destroying;
			// Its own record, not destroy()'s, and its own void: the walk found nothing.
			const records = recordsOf(other.transferId);
			expect(records.map((e) => e.kind)).toEqual([RECORD[terminal]]);
			expect(records[0]?.data).toMatchObject(
				terminal === "release" ? { reason: "given back" } : { error: "provider 500" },
			);
			expect(voidRequests.filter((r) => r.transferId === other.transferId)).toEqual([
				{ transferId: other.transferId, via: "voidPendingSpend", taken: true },
			]);
		});
	}

	it("a settle started while destroy() drains is billed once: it POSTs, destroy() waits for it, and its only record is llm_call", async () => {
		const voids = gate();
		const { engine, mutations } = ledgerEngine({ void: voids.wait });
		const gov = await governor(engine, BOUND_MS);
		const parked = await hold(gov, "session");
		const other = await hold(gov, "session");
		const ending = end(gov, parked, "release");
		events.length = 0;
		const destroying = gov.destroy();
		// The parked release holds the drain open; the call behind this settle finished just
		// as shutdown began.
		await sleep(60);
		const receipt = await gov.settle(other, { inputTokens: 10, outputTokens: 10 });
		expect(receipt.settled).toBe(true);
		voids.open();
		await ending;
		await destroying;
		expect(mutations).toEqual([`post:${other.transferId}`, `void:${parked.transferId}`]);
		expect(recordsOf(other.transferId).map((e) => e.kind)).toEqual(["llm_call"]);
	});
});

describe("with the real audit writer: nothing appends after destroy() releases it", () => {
	const auditDir = () => join(vaultBase, ".usertrust", "audit");
	/** The chain on disk: each record's kind and reason, by transfer. */
	function chainOf(transferId: string): Array<{ kind: string; reason: unknown }> {
		return readFileSync(join(auditDir(), "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> })
			.filter((e) => e.data.transferId === transferId)
			.map((e) => ({ kind: e.kind, reason: e.data.reason }));
	}

	it("a terminal whose void lands after destroy() writes nothing: the vault stays unlocked, and the next governor records", {
		timeout: 3_000,
	}, async () => {
		const voids = gate();
		const { engine } = ledgerEngine({ void: voids.wait });
		const first = await createGovernor({
			budget: 1_000_000,
			vaultBase,
			_engine: engine,
			_destroyDrainMs: BOUND_MS,
		});
		governors.push(first);
		const parked = await first.authorize(AUTHORIZE);
		const ending = first.release(parked, "given back");
		await first.destroy();
		voids.open();
		await ending;
		// The late release took no lock: the writer released it, and nothing took it again.
		expect(existsSync(join(auditDir(), ".audit-writer.lock"))).toBe(false);
		expect(chainOf(parked.transferId)).toEqual([
			{ kind: "hold_released", reason: STILL_IN_FLIGHT },
		]);

		// So the next governor on this vault, in this process, records as it should.
		const next = await createGovernor({ dryRun: true, budget: 1_000_000, vaultBase });
		governors.push(next);
		const auth = await next.authorize(AUTHORIZE);
		expect(await next.release(auth, "given back")).toEqual({ released: true });
		await next.destroy();
		expect(chainOf(auth.transferId)).toEqual([{ kind: "hold_released", reason: "given back" }]);
	});
});
