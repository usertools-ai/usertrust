// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Exactly one ledger mutation per hold, claimed synchronously (AGENTS.md, Money).
 *
 * `settle()` claims its hold and then reads caller input: the `SettleParams` fields,
 * and the handle's own. Any of those can be a getter, and a getter can call
 * `release()` or `abort()` on the very hold being settled, synchronously, before
 * settle has started its POST. Both terminals then found the hold in
 * `unpostedHolds` (settle's "claimed, not yet POSTed" set, there so a settle that
 * throws before its POST leaves a voidable hold) and claimed it, and the ledger saw a
 * POST and a VOID for one hold: two terminal records, and the in-flight budget given
 * back twice.
 *
 * A settle attempt now OWNS its hold from the claim: `release()` and `abort()` stay
 * out (`released: false`, a silent abort) until that attempt has either posted, or
 * failed before posting, at which point the hold is theirs again.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
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

/** An engine that records every POST and VOID it is asked for. */
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
		destroy: vi.fn(),
	};
}

async function governor(withLedger: boolean): Promise<Governor> {
	const gov = await createGovernor({
		budget: 1_000_000,
		vaultBase,
		_audit: audit(),
		...(withLedger ? { _engine: engine() } : { dryRun: true }),
	});
	governors.push(gov);
	return gov;
}

/** SettleParams whose first field read runs `during` against the hold being settled. */
function paramsCalling(during: () => unknown): SettleParams {
	return {
		get inputTokens(): number {
			during();
			return 10;
		},
		outputTokens: 10,
	};
}

const terminals = () => events.map((e) => e.kind).filter((k) => k !== "settlement_shortfall");

describe("a getter inside settle() cannot end the hold settle owns", () => {
	for (const withLedger of [true, false]) {
		const where = withLedger ? "with a ledger" : "in dry run";

		it(`${where}: release() from a SettleParams getter answers released: false; one POST, one record`, async () => {
			const gov = await governor(withLedger);
			const before = gov.budgetRemaining();
			const auth = await gov.authorize(AUTHORIZE);
			let inner: Promise<unknown> | undefined;
			const receipt = await gov.settle(
				auth,
				paramsCalling(() => {
					inner = gov.release(auth, "from a getter");
				}),
			);
			expect(await inner).toEqual({ released: false });
			expect(ledger).toEqual(
				withLedger ? { posts: [auth.transferId], voids: [] } : { posts: [], voids: [] },
			);
			expect(terminals()).toEqual(["llm_call"]);
			// The hold's budget came back once: what is left is the budget less the charge.
			expect(gov.budgetRemaining()).toBe(before - receipt.cost);
		});

		it(`${where}: abort() from a SettleParams getter is silent; one POST, one record`, async () => {
			const gov = await governor(withLedger);
			const before = gov.budgetRemaining();
			const auth = await gov.authorize(AUTHORIZE);
			let inner: Promise<unknown> | undefined;
			const receipt = await gov.settle(
				auth,
				paramsCalling(() => {
					inner = gov.abort(auth, new Error("from a getter"));
				}),
			);
			await inner;
			expect(ledger).toEqual(
				withLedger ? { posts: [auth.transferId], voids: [] } : { posts: [], voids: [] },
			);
			expect(terminals()).toEqual(["llm_call"]);
			expect(gov.budgetRemaining()).toBe(before - receipt.cost);
		});
	}

	it("a getter on the HANDLE is held off the same way", async () => {
		const gov = await governor(true);
		const auth = await gov.authorize(AUTHORIZE);
		let inner: Promise<unknown> | undefined;
		const handle: Authorization = Object.create(auth, {
			model: {
				get(): string {
					inner ??= gov.release(handle, "from the handle");
					return MODEL;
				},
			},
		});
		await gov.settle(handle, { inputTokens: 10, outputTokens: 10 });
		expect(await inner).toEqual({ released: false });
		expect(ledger).toEqual({ posts: [auth.transferId], voids: [] });
		expect(terminals()).toEqual(["llm_call"]);
	});

	it("a settle that throws before its POST hands the hold back: release() then ends it, once", async () => {
		const gov = await governor(true);
		const before = gov.budgetRemaining();
		const auth = await gov.authorize(AUTHORIZE);
		const throwing = {
			get inputTokens(): number {
				throw new Error("caller getter threw");
			},
		};
		await expect(gov.settle(auth, throwing)).rejects.toThrow("caller getter threw");
		expect(await gov.release(auth, "settle failed")).toEqual({ released: true });
		expect(ledger).toEqual({ posts: [], voids: [auth.transferId] });
		expect(terminals()).toEqual(["hold_released"]);
		expect(gov.budgetRemaining()).toBe(before);
	});
});
