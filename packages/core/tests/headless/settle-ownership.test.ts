// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Exactly one ledger mutation per hold, claimed synchronously (AGENTS.md, Money).
 *
 * `settle()` used to claim its hold and only then read caller input: the
 * `SettleParams` fields, and the handle's own. Any of those can be a getter, and a
 * getter can call `release()` or `abort()` on the very hold being settled. Both
 * terminals then found the hold in `unpostedHolds` (settle's "claimed, not yet
 * POSTed" set) and claimed it too, and the ledger got a POST and a VOID for one hold:
 * two terminal records, and the in-flight budget given back twice. It was
 * pre-existing in `abort()`; `release()` inherited it.
 *
 * Two rules close it, and each has its own tests here:
 *  - `settle()` reads every `SettleParams` field ONCE, FIRST, before it claims the
 *    hold. A getter that ends the hold is then the first terminal, and settle is
 *    refused. A getter that throws fails before any state change.
 *  - `settle()` OWNS the hold from its claim to its end (`settling`). What it still
 *    reads afterwards, the handle's own fields, cannot end the hold under it, for a
 *    session hold or an attributed one (which takes no budget lock, so nothing but
 *    ownership can stop it). A settle that throws before its POST hands the hold back.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { withCostCenter } from "../../src/budget/attribution.js";
import type { TrustEngine } from "../../src/govern.js";
import {
	type Authorization,
	createGovernor,
	type Governor,
	type SettleParams,
} from "../../src/headless.js";
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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 22 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const MODEL = "claude-sonnet-4-6";
const AUTHORIZE = { model: MODEL, estimatedInputTokens: 100, maxOutputTokens: 100 };
const SCOPE_OPTS = { allocated: 10_000, periodStartMs: Date.UTC(2026, 9, 1, 0, 0, 0) };

type Hold = "session" | "attributed";
type Terminal = "release" | "abort";

let vaultBase: string;
let events: AppendEventInput[];
let ledger: { posts: string[]; voids: string[] };
const governors: Governor[] = [];

beforeEach(() => {
	vaultBase = join(tmpdir(), `settle-ownership-${randomUUID()}`);
	mkdirSync(vaultBase, { recursive: true });
	events = [];
	ledger = { posts: [], voids: [] };
});

afterEach(async () => {
	for (const gov of governors.splice(0)) await gov.destroy();
	rmSync(vaultBase, { recursive: true, force: true });
});

function audit(): AuditWriter {
	return {
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

/** An engine that records every POST and VOID, and funds any envelope it is asked about. */
function engine(): TrustEngine {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async (transferId: string) => {
			ledger.posts.push(transferId);
		}),
		voidPendingSpend: vi.fn(async (transferId: string) => {
			ledger.voids.push(transferId);
		}),
		voidAllPending: vi.fn(async () => {}),
		lookupBalances: vi.fn(async (ids: bigint[]) => new Map(ids.map((id) => [id, 5_000]))),
		destroy: vi.fn(),
	};
}

async function governor(withLedger = true): Promise<Governor> {
	const gov = await createGovernor({
		budget: 1_000_000,
		vaultBase,
		parentUserId: "acme",
		_audit: audit(),
		...(withLedger ? { _engine: engine() } : { dryRun: true }),
	});
	governors.push(gov);
	return gov;
}

/** A session hold, or one attributed to a cost-center envelope (no budget lock on its terminals). */
function hold(gov: Governor, kind: Hold): Promise<Authorization> {
	return kind === "session"
		? gov.authorize(AUTHORIZE)
		: withCostCenter("research", () => gov.authorize(AUTHORIZE), SCOPE_OPTS);
}

function end(gov: Governor, auth: Authorization, terminal: Terminal): Promise<unknown> {
	return terminal === "release"
		? gov.release(auth, "from a getter")
		: gov.abort(auth, new Error("from a getter"));
}

/** SettleParams whose first field read runs `during`. */
function paramsCalling(during: () => unknown): SettleParams {
	return {
		get inputTokens(): number {
			during();
			return 10;
		},
		outputTokens: 10,
	};
}

/** The same hold, through a handle whose `model` getter runs `during` (read after the claim). */
function handleCalling(auth: Authorization, during: () => unknown): Authorization {
	let ran = false;
	return Object.create(auth, {
		model: {
			get(): string {
				if (!ran) {
					ran = true;
					during();
				}
				return auth.model;
			},
		},
	}) as Authorization;
}

const kinds = () => events.map((e) => e.kind);
const RECORD: Record<Terminal, string> = { release: "hold_released", abort: "llm_call_failed" };

describe("a SettleParams getter runs BEFORE the claim: the hold it ends is ended once", () => {
	for (const kind of ["session", "attributed"] as const) {
		for (const terminal of ["release", "abort"] as const) {
			it(`${kind} hold, ${terminal}() from the getter: one VOID, no POST, and settle is refused`, async () => {
				const gov = await governor();
				const before = gov.budgetRemaining();
				const auth = await hold(gov, kind);
				events.length = 0;
				let inner: Promise<unknown> | undefined;
				await expect(
					gov.settle(
						auth,
						paramsCalling(() => {
							inner = end(gov, auth, terminal);
						}),
					),
				).rejects.toThrow("is not active");
				const answer = await inner;
				expect(answer).toEqual(terminal === "release" ? { released: true } : { aborted: true });
				expect(ledger).toEqual({ posts: [], voids: [auth.transferId] });
				expect(kinds()).toEqual([RECORD[terminal]]);
				// The hold's budget came back once, never twice.
				expect(gov.budgetRemaining()).toBe(before);
			});
		}
	}

	it("dry run, the same: one record, and the budget back once", async () => {
		for (const terminal of ["release", "abort"] as const) {
			const gov = await governor(false);
			const before = gov.budgetRemaining();
			const auth = await gov.authorize(AUTHORIZE);
			events.length = 0;
			let inner: Promise<unknown> | undefined;
			await expect(
				gov.settle(
					auth,
					paramsCalling(() => {
						inner = end(gov, auth, terminal);
					}),
				),
			).rejects.toThrow("is not active");
			await inner;
			expect(kinds()).toEqual([RECORD[terminal]]);
			expect(gov.budgetRemaining()).toBe(before);
		}
	});

	it("a SettleParams getter that THROWS fails before any state change: the hold is still live", async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const throwing = {
			get inputTokens(): number {
				throw new Error("caller getter threw");
			},
		};
		await expect(gov.settle(auth, throwing)).rejects.toThrow("caller getter threw");
		// Never claimed, so it settles normally afterwards.
		const receipt = await gov.settle(auth, { inputTokens: 10, outputTokens: 10 });
		expect(receipt.settled).toBe(true);
		expect(ledger).toEqual({ posts: [auth.transferId], voids: [] });
	});
});

/** The terminal records a hold can leave. Exactly one may exist per hold. */
const TERMINALS = new Set(["llm_call", "hold_released", "llm_call_failed"]);
const terminalRecords = () => kinds().filter((k) => TERMINALS.has(k));

/**
 * The hold's budget was given back exactly once: a settle charged its cost and released
 * its in-flight hold; a release or abort released it without a charge. An attributed hold
 * never touched the session's numbers at all.
 */
function givenBackOnce(gov: Governor, before: number, kind: Hold, cost: number | undefined): void {
	const settled = terminalRecords()[0] === "llm_call";
	const expected = kind === "attributed" ? before : before - (settled ? (cost ?? 0) : 0);
	expect(gov.budgetRemaining()).toBe(expected);
}

/** The same hold, through a handle whose `transferId` getter runs `during` on its Nth read. */
function idCalling(auth: Authorization, nth: number, during: () => unknown): Authorization {
	let reads = 0;
	return Object.create(auth, {
		transferId: {
			get(): string {
				reads += 1;
				if (reads === nth) during();
				return auth.transferId;
			},
		},
	}) as Authorization;
}

describe("every terminal reads the handle's transferId ONCE: the id it claims is the id it marks", () => {
	it("settle(), release() and abort() each read it exactly once", async () => {
		const gov = await governor();
		for (const call of ["settle", "release", "abort"] as const) {
			const auth = await gov.authorize(AUTHORIZE);
			let reads = 0;
			const counted = Object.create(auth, {
				transferId: {
					get(): string {
						reads += 1;
						return auth.transferId;
					},
				},
			}) as Authorization;
			if (call === "settle") await gov.settle(counted, { inputTokens: 10, outputTokens: 10 });
			else await end(gov, counted, call);
			expect([call, reads]).toEqual([call, 1]);
		}
	});

	for (const [kind, withLedger] of [
		["session", true],
		["attributed", true],
		["session", false],
	] as const) {
		const where = `${kind} hold, ${withLedger ? "with a ledger" : "in dry run"}`;
		for (const terminal of ["release", "abort"] as const) {
			it(`${where}: ${terminal}() from the id getter on its 2nd, 3rd or 4th read never fires; one terminal, one give-back`, async () => {
				for (const nth of [2, 3, 4]) {
					const gov = await governor(withLedger);
					const before = gov.budgetRemaining();
					const auth = await hold(gov, kind);
					events.length = 0;
					ledger = { posts: [], voids: [] };
					let fired = false;
					const receipt = await gov.settle(
						idCalling(auth, nth, () => {
							fired = true;
							void end(gov, auth, terminal);
						}),
						{ inputTokens: 10, outputTokens: 10 },
					);
					// Read once, at entry: the read that would have fed the claim or the marker
					// never happens, so the getter never gets to end the hold.
					expect([nth, fired]).toEqual([nth, false]);
					expect([nth, terminalRecords()]).toEqual([nth, ["llm_call"]]);
					if (withLedger) expect(ledger).toEqual({ posts: [auth.transferId], voids: [] });
					givenBackOnce(gov, before, kind, receipt.cost);
				}
			});
		}
	}

	for (const terminal of ["release", "abort"] as const) {
		it(`${terminal}(): settle() from the id getter, on any read, leaves exactly one ledger mutation`, async () => {
			for (let nth = 1; nth <= 6; nth += 1) {
				const gov = await governor();
				const auth = await gov.authorize(AUTHORIZE);
				ledger = { posts: [], voids: [] };
				let inner: Promise<unknown> | undefined;
				await end(
					gov,
					idCalling(auth, nth, () => {
						inner = gov.settle(auth, { inputTokens: 10, outputTokens: 10 }).catch(() => undefined);
					}),
					terminal,
				);
				await inner;
				expect([nth, ledger.posts.length + ledger.voids.length]).toEqual([nth, 1]);
			}
		});

		it(`${terminal}() on a handle whose id changes after the first read ends that first hold, only`, async () => {
			const gov = await governor();
			const first = await gov.authorize(AUTHORIZE);
			const second = await gov.authorize(AUTHORIZE);
			let reads = 0;
			const shifting = Object.create(first, {
				transferId: {
					get(): string {
						reads += 1;
						return reads === 1 ? first.transferId : second.transferId;
					},
				},
			}) as Authorization;
			await end(gov, shifting, terminal);
			expect(ledger).toEqual({ posts: [], voids: [first.transferId] });
			// The second hold was never touched: it settles normally.
			await gov.settle(second, { inputTokens: 10, outputTokens: 10 });
			expect(ledger).toEqual({ posts: [second.transferId], voids: [first.transferId] });
		});
	}
});

describe("the class: a Proxy that tries to end the hold on EVERY property read", () => {
	for (const withLedger of [true, false]) {
		for (const terminal of ["release", "abort"] as const) {
			it(`${withLedger ? "with a ledger" : "in dry run"}, ${terminal}() on every read of the handle and the params: one mutation, one record, one give-back`, async () => {
				const gov = await governor(withLedger);
				const before = gov.budgetRemaining();
				const auth = await gov.authorize(AUTHORIZE);
				events.length = 0;
				const attempts: Array<Promise<unknown>> = [];
				const trap = <T extends object>(target: T): T =>
					new Proxy(target, {
						get(t, prop, receiver) {
							attempts.push(end(gov, auth, terminal));
							return Reflect.get(t, prop, receiver);
						},
					});
				const receipt = await gov
					.settle(trap(auth), trap({ inputTokens: 10, outputTokens: 10 }))
					.catch(() => undefined);
				await Promise.all(attempts);
				// Whichever terminal came first won; there is exactly one of it.
				expect(attempts.length).toBeGreaterThan(0);
				expect(terminalRecords()).toHaveLength(1);
				if (withLedger) expect(ledger.posts.length + ledger.voids.length).toBe(1);
				givenBackOnce(gov, before, "session", receipt?.cost);
			});
		}
	}
});

describe("a getter on the HANDLE runs after the claim: settle owns the hold, and wins", () => {
	for (const kind of ["session", "attributed"] as const) {
		for (const terminal of ["release", "abort"] as const) {
			it(`${kind} hold, ${terminal}() from the handle: one POST, no VOID, no ${RECORD[terminal]}`, async () => {
				const gov = await governor();
				const before = gov.budgetRemaining();
				const auth = await hold(gov, kind);
				events.length = 0;
				let inner: Promise<unknown> | undefined;
				const receipt = await gov.settle(
					handleCalling(auth, () => {
						inner = end(gov, auth, terminal);
					}),
					{ inputTokens: 10, outputTokens: 10 },
				);
				const answer = await inner;
				expect(answer).toEqual(terminal === "release" ? { released: false } : { aborted: false });
				expect(ledger).toEqual({ posts: [auth.transferId], voids: [] });
				expect(kinds().filter((k) => k !== "settlement_shortfall")).toEqual(["llm_call"]);
				// A session hold is charged once and given back once; an attributed one
				// never touched the session's numbers.
				expect(gov.budgetRemaining()).toBe(kind === "session" ? before - receipt.cost : before);
			});
		}
	}

	it("a settle that throws AFTER its claim, before its POST, hands the hold back: release() ends it once", async () => {
		const gov = await governor();
		const before = gov.budgetRemaining();
		const auth = await gov.authorize(AUTHORIZE);
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
		expect(await gov.release(auth, "settle failed")).toEqual({ released: true });
		expect(ledger).toEqual({ posts: [], voids: [auth.transferId] });
		expect(kinds().filter((k) => k !== "policy_denied")).toEqual(["hold_released"]);
		expect(gov.budgetRemaining()).toBe(before);
	});
});
