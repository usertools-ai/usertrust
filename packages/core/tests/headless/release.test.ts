// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `Governor.release()`: the third terminal, for a hold that did not fail (#238, #204).
 *
 * A client giving back a reservation it no longer needs, and an integration ending a
 * hold itself (an expired hold, a shutdown), used to go through `abort()`, which records
 * a circuit-breaker failure and `llm_call_failed`. Five in a row opened the tenant's
 * breaker and failed every authorize for a minute. `release()` voids the hold and
 * writes a neutral `hold_released`, and touches the breaker not at all: not a failure,
 * and not a success either, so give-backs can neither open the breaker nor close one
 * that real failures opened.
 *
 * Pinned here: the claim discipline (it answers whether IT ended the hold), the
 * accounting it gives back, the record it writes, breaker neutrality, the reason's
 * sanitizer, and the fixed `voidError` code for a void the ledger refused.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import { createGovernor, type Governor, sanitizeReleaseReason } from "../../src/headless.js";
import { TBTransferError } from "../../src/ledger/client.js";
import { CircuitOpenError } from "../../src/resilience/circuit.js";
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

describe("release() ends a hold that did not fail, and says whether it did", () => {
	it("a live hold: released, its budget back, and a neutral hold_released record", async () => {
		const gov = await dryRunGovernor();
		const before = gov.budgetRemaining();
		const principal = { id: "agent-7", type: "Explore", origin: "claude-code:s1" };
		const auth = await gov.authorize({ ...AUTHORIZE, actor: "plugin", principal });
		expect(gov.budgetRemaining()).toBeLessThan(before);

		expect(await gov.release(auth, "released at Stop")).toEqual({ released: true });
		expect(gov.budgetRemaining()).toBe(before);
		expect(kinds()).toEqual(["hold_released"]);
		expect(audit.events[0]).toEqual({
			kind: "hold_released",
			actor: "plugin",
			data: {
				model: MODEL,
				transferId: auth.transferId,
				reason: "released at Stop",
				source: "headless",
				principal,
			},
		});
	});

	it("answers released: false for a hold it no longer holds, and records nothing", async () => {
		const gov = await dryRunGovernor();
		const released = await gov.authorize(AUTHORIZE);
		await gov.release(released);
		expect(await gov.release(released)).toEqual({ released: false });

		const settled = await gov.authorize(AUTHORIZE);
		await gov.settle(settled, { inputTokens: 10, outputTokens: 10 });
		expect(await gov.release(settled)).toEqual({ released: false });

		const aborted = await gov.authorize(AUTHORIZE);
		await gov.abort(aborted, new Error("provider 500"));
		expect(await gov.release(aborted)).toEqual({ released: false });

		expect(kinds()).toEqual(["hold_released", "llm_call", "llm_call_failed"]);
	});

	it("a released hold is gone for the other terminals too", async () => {
		const gov = await dryRunGovernor();
		const auth = await gov.authorize(AUTHORIZE);
		await gov.release(auth);
		await expect(gov.settle(auth, { inputTokens: 1, outputTokens: 1 })).rejects.toThrow(
			"is not active",
		);
		await gov.abort(auth, new Error("late"));
		expect(kinds()).toEqual(["hold_released"]);
	});

	it("a hold whose settle threw before its POST is still released, once", async () => {
		const gov = await dryRunGovernor();
		const auth = await gov.authorize(AUTHORIZE);
		const params = {
			get inputTokens(): number {
				throw new Error("caller getter threw");
			},
		};
		await expect(gov.settle(auth, params)).rejects.toThrow("caller getter threw");
		expect(await gov.release(auth, "settle failed")).toEqual({ released: true });
		expect(await gov.release(auth)).toEqual({ released: false });
	});
});

describe("release() is NEUTRAL to the circuit breaker", () => {
	it("five releases in a row leave the next authorize open (five aborts did not)", async () => {
		const gov = await dryRunGovernor();
		for (let i = 0; i < 5; i += 1) {
			expect(await gov.release(await gov.authorize(AUTHORIZE))).toEqual({ released: true });
		}
		await expect(gov.authorize(AUTHORIZE)).resolves.toBeDefined();
	});

	it("control: five aborts open it, so the test above can fail", async () => {
		const gov = await dryRunGovernor();
		for (let i = 0; i < 5; i += 1) {
			await gov.abort(await gov.authorize(AUTHORIZE), new Error("provider 500"));
		}
		await expect(gov.authorize(AUTHORIZE)).rejects.toBeInstanceOf(CircuitOpenError);
	});

	it("a release does not reset the failure count either: 4 aborts, 3 releases, 1 abort opens it", async () => {
		const gov = await dryRunGovernor();
		for (let i = 0; i < 4; i += 1) {
			await gov.abort(await gov.authorize(AUTHORIZE), new Error("provider 500"));
		}
		for (let i = 0; i < 3; i += 1) await gov.release(await gov.authorize(AUTHORIZE));
		await gov.abort(await gov.authorize(AUTHORIZE), new Error("provider 500"));
		await expect(gov.authorize(AUTHORIZE)).rejects.toBeInstanceOf(CircuitOpenError);
	});
});

describe("a void the ledger refused still ends the hold, named by a fixed code", () => {
	it("an expired hold is released cleanly: the engine reports it done", async () => {
		const gov = await engineGovernor(makeEngine(async () => {}));
		const auth = await gov.authorize(AUTHORIZE);
		expect(await gov.release(auth, "pending TTL expired")).toEqual({ released: true });
		expect(audit.events[0]?.data).not.toHaveProperty("voidError");
	});

	it("a refused void: released, with the ledger's own status name, and the budget back", async () => {
		const gov = await engineGovernor(
			makeEngine(async () => {
				throw new TBTransferError(25, "Void transfer failed: pending_transfer_not_found");
			}),
		);
		const before = gov.budgetRemaining();
		const auth = await gov.authorize(AUTHORIZE);
		expect(await gov.release(auth)).toEqual({
			released: true,
			voidError: "pending_transfer_not_found",
		});
		expect(gov.budgetRemaining()).toBe(before);
		expect(audit.events[0]?.data).toMatchObject({ voidError: "pending_transfer_not_found" });
	});

	it("any other failure is `ledger_unavailable`, and its text is never recorded or answered", async () => {
		const secret = "connect ECONNREFUSED 10.20.30.40:3000 /srv/secret/vault";
		const gov = await engineGovernor(
			makeEngine(async () => {
				throw new Error(secret);
			}),
		);
		const outcome = await gov.release(await gov.authorize(AUTHORIZE));
		expect(outcome).toEqual({ released: true, voidError: "ledger_unavailable" });
		expect(JSON.stringify(outcome)).not.toContain("10.20.30.40");
		expect(JSON.stringify(audit.events)).not.toContain("10.20.30.40");
		expect(JSON.stringify(audit.events)).not.toContain("secret");
	});
});

describe("sanitizeReleaseReason: strip every control character, then clip", () => {
	it("strips C0, DEL and C1, and keeps everything else", () => {
		expect(sanitizeReleaseReason("given\u001b[2J back\u0007\u007f\u009b at Stop")).toBe(
			"given[2J back at Stop",
		);
	});

	it("clips at 200 code points, after stripping, and never splits a surrogate pair", () => {
		const controls = "\u0000".repeat(500);
		const emoji = "\u{1F600}";
		const out = sanitizeReleaseReason(`${controls}${emoji.repeat(300)}`);
		expect([...out]).toHaveLength(200);
		expect(out).toBe(emoji.repeat(200));
	});

	it("records the default for a non-string, an empty string, or one of controls only", () => {
		expect(sanitizeReleaseReason(undefined)).toBe("released");
		expect(sanitizeReleaseReason(42)).toBe("released");
		expect(sanitizeReleaseReason("")).toBe("released");
		expect(sanitizeReleaseReason("\u0001\u001b\u009f")).toBe("released");
	});

	it("the record carries the sanitized reason", async () => {
		const gov = await dryRunGovernor();
		await gov.release(await gov.authorize(AUTHORIZE), "x\u001b]0;pwned\u0007y");
		expect(audit.events[0]?.data).toMatchObject({ reason: "x]0;pwnedy" });
	});
});
