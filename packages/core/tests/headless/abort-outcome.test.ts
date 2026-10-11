// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `Governor.abort()` says what it did (#240), as `release()` does.
 *
 * It used to answer nothing: an abort of a hold the governor no longer held (a settle
 * owns it, or it had already ended) was indistinguishable from one that voided it, so the
 * server's `/v1/abort` answered 200 `{ aborted: true }` for both. And a void the ledger
 * refused was swallowed: neither the caller nor the chain could tell that the hold's funds
 * stayed held until the ledger's own timeout.
 *
 * Pinned here: `{ aborted: true }` only when THIS call ended the hold, `{ aborted: false }`
 * (and no record) otherwise, and a refused void named by the same fixed code `release()`
 * uses, in the answer and on the `llm_call_failed` record, never the error's own text.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import { createGovernor, type Governor } from "../../src/headless.js";
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
	vaultBase = join(tmpdir(), `abort-outcome-${randomUUID()}`);
	mkdirSync(vaultBase, { recursive: true });
	audit = makeAudit();
});

afterEach(async () => {
	for (const gov of governors.splice(0)) await gov.destroy();
	rmSync(vaultBase, { recursive: true, force: true });
});

async function dryRunGovernor(): Promise<Governor> {
	const gov = await createGovernor({ dryRun: true, budget: BUDGET, vaultBase, _audit: audit });
	governors.push(gov);
	return gov;
}

async function engineGovernor(engine: TrustEngine): Promise<Governor> {
	const gov = await createGovernor({ budget: BUDGET, vaultBase, _engine: engine, _audit: audit });
	governors.push(gov);
	return gov;
}

const kinds = () => audit.events.map((e) => e.kind);

describe("abort() answers whether IT ended the hold", () => {
	it("a live hold: aborted, its budget back, and the llm_call_failed record", async () => {
		const gov = await dryRunGovernor();
		const before = gov.budgetRemaining();
		const auth = await gov.authorize({ ...AUTHORIZE, actor: "plugin" });
		expect(await gov.abort(auth, new Error("provider 500"))).toEqual({ aborted: true });
		expect(gov.budgetRemaining()).toBe(before);
		expect(audit.events).toEqual([
			{
				kind: "llm_call_failed",
				actor: "plugin",
				data: {
					model: MODEL,
					transferId: auth.transferId,
					error: "provider 500",
					source: "headless",
				},
			},
		]);
	});

	it("a hold it no longer holds: aborted: false, and nothing recorded", async () => {
		const gov = await dryRunGovernor();
		const aborted = await gov.authorize(AUTHORIZE);
		await gov.abort(aborted, new Error("provider 500"));
		expect(await gov.abort(aborted, new Error("again"))).toEqual({ aborted: false });

		const settled = await gov.authorize(AUTHORIZE);
		await gov.settle(settled, { inputTokens: 10, outputTokens: 10 });
		expect(await gov.abort(settled)).toEqual({ aborted: false });

		const released = await gov.authorize(AUTHORIZE);
		await gov.release(released);
		expect(await gov.abort(released)).toEqual({ aborted: false });

		const unknown = { ...aborted, transferId: "tx_never_held" };
		expect(await gov.abort(unknown)).toEqual({ aborted: false });

		expect(kinds()).toEqual(["llm_call_failed", "llm_call", "hold_released"]);
	});

	it("a hold whose settle threw before its POST is still abortable, once", async () => {
		const gov = await dryRunGovernor();
		const auth = await gov.authorize(AUTHORIZE);
		const params = {
			get inputTokens(): number {
				throw new Error("caller getter threw");
			},
		};
		await expect(gov.settle(auth, params)).rejects.toThrow("caller getter threw");
		expect(await gov.abort(auth, new Error("settle failed"))).toEqual({ aborted: true });
		expect(await gov.abort(auth)).toEqual({ aborted: false });
	});
});

describe("a void the ledger refused still ends the hold, named by release()'s fixed code", () => {
	it("a void that succeeds: aborted, and no voidError anywhere", async () => {
		const gov = await engineGovernor(makeEngine(async () => {}));
		expect(await gov.abort(await gov.authorize(AUTHORIZE))).toEqual({ aborted: true });
		expect(audit.events[0]?.data).not.toHaveProperty("voidError");
	});

	it("a refused void: aborted, with the ledger's own status name, on the answer and the record", async () => {
		const gov = await engineGovernor(
			makeEngine(async () => {
				throw new TBTransferError(25, "Void transfer failed: pending_transfer_not_found");
			}),
		);
		const before = gov.budgetRemaining();
		const auth = await gov.authorize(AUTHORIZE);
		expect(await gov.abort(auth, new Error("provider 500"))).toEqual({
			aborted: true,
			voidError: "pending_transfer_not_found",
		});
		expect(gov.budgetRemaining()).toBe(before);
		expect(audit.events).toEqual([
			{
				kind: "llm_call_failed",
				actor: "local",
				data: {
					model: MODEL,
					transferId: auth.transferId,
					error: "provider 500",
					source: "headless",
					voidError: "pending_transfer_not_found",
				},
			},
		]);
	});

	it("an engine that holds no record of the hold: `no_pending_entry`, by type", async () => {
		const gov = await engineGovernor(
			makeEngine(async (transferId) => {
				throw new PendingEntryNotFoundError(transferId);
			}),
		);
		expect(await gov.abort(await gov.authorize(AUTHORIZE))).toEqual({
			aborted: true,
			voidError: "no_pending_entry",
		});
	});

	it("any other failure is `ledger_unavailable`, and its text is never recorded or answered", async () => {
		const secret = "connect ECONNREFUSED 10.20.30.40:3000 /srv/secret/vault";
		const gov = await engineGovernor(
			makeEngine(async () => {
				throw new Error(secret);
			}),
		);
		const outcome = await gov.abort(await gov.authorize(AUTHORIZE));
		expect(outcome).toEqual({ aborted: true, voidError: "ledger_unavailable" });
		expect(JSON.stringify(outcome)).not.toContain("10.20.30.40");
		expect(JSON.stringify(audit.events)).not.toContain("10.20.30.40");
	});
});
