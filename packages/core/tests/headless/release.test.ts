// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `release(auth, reason)` — the third terminal, and the one that is NOT a failure.
 *
 * Before it existed, the only way to give a hold back was `abort`, which means "the
 * call failed": it records a circuit-breaker failure and writes `llm_call_failed`.
 * A hold that simply outlived its usefulness — the server's TTL sweep, a shutdown,
 * a caller that decided not to make the call — was therefore booked as an LLM
 * failure, and five of them in a row opened the breaker on a healthy provider (#204).
 *
 * Pinned here:
 *  - release voids the hold and writes the neutral `hold_released`, never
 *    `llm_call_failed`, and never touches the breaker (five releases keep authorize
 *    working; the CONTROL is five aborts, which open it);
 *  - exactly one terminal per hold across settle | abort | release, in every order,
 *    with the ledger touched once;
 *  - the same claim discipline as abort: a silent no-op while the POST is in flight,
 *    and the claimed-but-never-POSTed set is reachable;
 *  - the session decrement is symmetric with the authorize-time increment;
 *  - an attributed hold's record carries `costCenter`;
 *  - `reason` is caller text: control characters stripped, clipped to 200, default
 *    `"released"`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { withCostCenter } from "../../src/budget/attribution.js";
import type { TrustEngine } from "../../src/govern.js";
import { type Authorization, createGovernor, type Governor } from "../../src/headless.js";
import { CircuitOpenError } from "../../src/resilience/circuit.js";
import type { AuditEvent } from "../../src/shared/types.js";

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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// ── Harness ──

const BUDGET = 100_000;
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 100, maxOutputTokens: 500 };
const USAGE = { inputTokens: 80, outputTokens: 200 };

interface TrackingEngine extends TrustEngine {
	pending: Set<string>;
	posted: string[];
	voided: string[];
	spendPending: Mock<TrustEngine["spendPending"]>;
	postPendingSpend: Mock<TrustEngine["postPendingSpend"]>;
	voidPendingSpend: Mock<TrustEngine["voidPendingSpend"]>;
	lookupBalances?: Mock<NonNullable<TrustEngine["lookupBalances"]>>;
}

function makeEngine(
	opts: { post?: () => Promise<void>; voidFails?: boolean; envelopeBalance?: number } = {},
): TrackingEngine {
	const pending = new Set<string>();
	const posted: string[] = [];
	const voided: string[] = [];
	const engine: TrackingEngine = {
		pending,
		posted,
		voided,
		spendPending: vi.fn<TrustEngine["spendPending"]>(async (p) => {
			pending.add(p.transferId);
			return { transferId: p.transferId };
		}),
		postPendingSpend: vi.fn<TrustEngine["postPendingSpend"]>(async (transferId) => {
			if (opts.post !== undefined) await opts.post();
			pending.delete(transferId);
			posted.push(transferId);
		}),
		voidPendingSpend: vi.fn<TrustEngine["voidPendingSpend"]>(async (transferId) => {
			if (opts.voidFails === true) throw new Error("tb: void timed out");
			pending.delete(transferId);
			voided.push(transferId);
		}),
		voidAllPending: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
	if (opts.envelopeBalance !== undefined) {
		const balance = opts.envelopeBalance;
		engine.lookupBalances = vi.fn<NonNullable<TrustEngine["lookupBalances"]>>(
			async (ids) => new Map(ids.map((id) => [id, balance])),
		);
	}
	return engine;
}

interface AuditHandle extends AuditWriter {
	events: AppendEventInput[];
}

function makeAudit(): AuditHandle {
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

function kinds(audit: AuditHandle): string[] {
	return audit.events.map((e) => e.kind);
}

function released(audit: AuditHandle): Array<Record<string, unknown>> {
	return audit.events.filter((e) => e.kind === "hold_released").map((e) => e.data);
}

/** ESC and a C1 CSI, built from code points so no literal control byte lives in this file. */
const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);
const DEL = String.fromCharCode(0x7f);
const NUL = String.fromCharCode(0x00);

describe("headless release — a terminal that is not a failure", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = join(tmpdir(), `headless-release-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	async function governorWith(
		engine: TrackingEngine,
		audit: AuditHandle,
		extra: { parentUserId?: string } = {},
	): Promise<Governor> {
		return await createGovernor({
			budget: BUDGET,
			vaultBase,
			...extra,
			_engine: engine,
			_audit: audit,
		});
	}

	it("voids the hold and writes hold_released — never llm_call_failed", async () => {
		const engine = makeEngine();
		const audit = makeAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		await gov.release(auth, "caller changed its mind");

		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voided).toEqual([auth.transferId]);
		expect(engine.postPendingSpend).not.toHaveBeenCalled();
		expect(kinds(audit)).toEqual(["hold_released"]);
		expect(released(audit)[0]).toEqual({
			model: AUTHORIZE.model,
			transferId: auth.transferId,
			reason: "caller changed its mind",
			source: "headless",
		});

		await gov.destroy();
	});

	it("leaves the circuit breaker alone: five releases in a row keep authorize working", async () => {
		const gov = await governorWith(makeEngine(), makeAudit());

		for (let i = 0; i < 5; i++) {
			await gov.release(await gov.authorize(AUTHORIZE), "pending TTL expired");
		}

		// The default threshold is five consecutive failures. A release that recorded
		// one would have opened the breaker by now, refusing a healthy provider.
		await expect(gov.authorize(AUTHORIZE)).resolves.toBeDefined();

		await gov.destroy();
	});

	it("control: five ABORTS in a row do open the breaker", async () => {
		// Without this, the test above could pass against a breaker that never opens
		// at all. Same governor shape, same count, the failure terminal instead.
		const gov = await governorWith(makeEngine(), makeAudit());

		for (let i = 0; i < 5; i++) {
			await gov.abort(await gov.authorize(AUTHORIZE), new Error("provider 500"));
		}

		await expect(gov.authorize(AUTHORIZE)).rejects.toBeInstanceOf(CircuitOpenError);

		await gov.destroy();
	});

	it("returns the session's in-flight exposure exactly — the decrement is symmetric", async () => {
		const gov = await governorWith(makeEngine(), makeAudit());
		const before = gov.budgetRemaining();

		const auth = await gov.authorize(AUTHORIZE);
		expect(gov.budgetRemaining()).toBe(before - auth.estimatedCost);

		await gov.release(auth);
		expect(gov.budgetRemaining()).toBe(before);

		await gov.destroy();
	});

	it("decrements what AUTHORIZE reserved, not what the caller's handle says now", async () => {
		// The handle is the caller's own object. A decrement read off it lets a caller
		// shrink or inflate the session's in-flight total by editing one field.
		const gov = await governorWith(makeEngine(), makeAudit());
		const before = gov.budgetRemaining();

		const auth = await gov.authorize(AUTHORIZE);
		auth.estimatedCost = 1;
		await gov.release(auth);

		expect(gov.budgetRemaining()).toBe(before);

		await gov.destroy();
	});

	it("an ATTRIBUTED hold's release carries costCenter and leaves session numbers alone", async () => {
		const engine = makeEngine({ envelopeBalance: 50_000 });
		const audit = makeAudit();
		const gov = await governorWith(engine, audit, { parentUserId: "acme" });
		const before = gov.budgetRemaining();

		const auth = await withCostCenter("research", () => gov.authorize(AUTHORIZE));
		// The envelope paid, so the session's in-flight total never moved…
		expect(gov.budgetRemaining()).toBe(before);

		// …and the release, run outside every scope, still names the envelope.
		await gov.release(auth, "done");
		expect(gov.budgetRemaining()).toBe(before);
		expect(released(audit)[0]?.costCenter).toBe("research");
		expect(engine.voided).toEqual([auth.transferId]);

		await gov.destroy();
	});

	it("an unattributed release spreads NO costCenter key", async () => {
		const audit = makeAudit();
		const gov = await governorWith(makeEngine(), audit);

		await gov.release(await gov.authorize(AUTHORIZE));

		expect("costCenter" in (released(audit)[0] ?? {})).toBe(false);

		await gov.destroy();
	});

	describe("exactly one terminal per hold — the ledger is touched once", () => {
		it("release, then settle: settle is refused and nothing is posted", async () => {
			const engine = makeEngine();
			const audit = makeAudit();
			const gov = await governorWith(engine, audit);

			const auth = await gov.authorize(AUTHORIZE);
			await gov.release(auth);

			await expect(gov.settle(auth, USAGE)).rejects.toThrow(/is not active/);
			expect(engine.postPendingSpend).not.toHaveBeenCalled();
			expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
			expect(kinds(audit)).toEqual(["hold_released"]);

			await gov.destroy();
		});

		it("settle, then release: release is a silent no-op", async () => {
			const engine = makeEngine();
			const audit = makeAudit();
			const gov = await governorWith(engine, audit);

			const auth = await gov.authorize(AUTHORIZE);
			await gov.settle(auth, USAGE);
			const remaining = gov.budgetRemaining();

			await expect(gov.release(auth)).resolves.toBeUndefined();
			expect(engine.voidPendingSpend).not.toHaveBeenCalled();
			expect(engine.postPendingSpend).toHaveBeenCalledOnce();
			expect(kinds(audit)).not.toContain("hold_released");
			// No second decrement either.
			expect(gov.budgetRemaining()).toBe(remaining);

			await gov.destroy();
		});

		it("abort, then release: release is a silent no-op", async () => {
			const engine = makeEngine();
			const audit = makeAudit();
			const gov = await governorWith(engine, audit);

			const auth = await gov.authorize(AUTHORIZE);
			await gov.abort(auth, new Error("provider 500"));
			const remaining = gov.budgetRemaining();

			await gov.release(auth);
			expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
			expect(kinds(audit)).toEqual(["llm_call_failed"]);
			expect(gov.budgetRemaining()).toBe(remaining);

			await gov.destroy();
		});

		it("release, then abort: abort is a silent no-op and writes no failure", async () => {
			const engine = makeEngine();
			const audit = makeAudit();
			const gov = await governorWith(engine, audit);

			const auth = await gov.authorize(AUTHORIZE);
			await gov.release(auth);
			await gov.abort(auth, new Error("late failure"));

			expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
			expect(kinds(audit)).toEqual(["hold_released"]);

			await gov.destroy();
		});

		it("release twice: the second is a silent no-op", async () => {
			const engine = makeEngine();
			const audit = makeAudit();
			const gov = await governorWith(engine, audit);
			const before = gov.budgetRemaining();

			const auth = await gov.authorize(AUTHORIZE);
			await gov.release(auth);
			await gov.release(auth);

			expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
			expect(kinds(audit)).toEqual(["hold_released"]);
			expect(gov.budgetRemaining()).toBe(before);

			await gov.destroy();
		});

		it("an unknown handle is a silent no-op", async () => {
			const engine = makeEngine();
			const audit = makeAudit();
			const gov = await governorWith(engine, audit);

			const stranger: Authorization = {
				transferId: "tx_never_issued",
				estimatedCost: 10,
				model: AUTHORIZE.model,
				createdAt: Date.now(),
			};
			await expect(gov.release(stranger)).resolves.toBeUndefined();
			expect(engine.voidPendingSpend).not.toHaveBeenCalled();
			expect(audit.events).toHaveLength(0);

			await gov.destroy();
		});
	});

	it("is a silent no-op while the hold's POST is in flight (`settling`)", async () => {
		// First terminal wins. A release that voided a hold mid-POST could void money
		// TigerBeetle is committing; one that wrote hold_released would put a second
		// terminal on the chain for a call that settled.
		let finishPost: () => void = () => {};
		const postGate = new Promise<void>((resolve) => {
			finishPost = resolve;
		});
		const engine = makeEngine({ post: () => postGate });
		const audit = makeAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		const settling = gov.settle(auth, USAGE);
		await vi.waitFor(() => expect(engine.postPendingSpend).toHaveBeenCalledOnce());

		await gov.release(auth, "racing the post");
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(kinds(audit)).not.toContain("hold_released");

		finishPost();
		const receipt = await settling;
		expect(receipt.settled).toBe(true);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		expect(kinds(audit)).toContain("llm_call");
		expect(kinds(audit)).not.toContain("hold_released");

		await gov.destroy();
	});

	it("releases a hold that settle CLAIMED and then threw on before POST", async () => {
		// AUD-001's shape, for the new terminal: the claim moved the capture out of
		// `activeAuths` and into `unpostedHolds`, and release must look there too or
		// the hold sits PENDING until destroy or the ledger timeout.
		const engine = makeEngine();
		const audit = makeAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		// The first caller value settle reads after its claim is its SettleParams.
		const throwing = {
			get inputTokens(): number {
				throw new Error("throw after claim");
			},
		};
		await expect(gov.settle(auth, throwing)).rejects.toThrow("throw after claim");
		expect(engine.voided).toEqual([]);

		// Whatever the caller has done to its handle since, the record is the capture's.
		auth.model = "rewritten-by-the-caller";
		await gov.release(auth, "cleanup");
		expect(engine.voided).toEqual([auth.transferId]);
		expect(released(audit)[0]?.reason).toBe("cleanup");
		expect(released(audit)[0]?.model).toBe(AUTHORIZE.model);

		await gov.destroy();
	});

	it("a failed void is best-effort, exactly like abort: the release is still recorded", async () => {
		const engine = makeEngine({ voidFails: true });
		const audit = makeAudit();
		const gov = await governorWith(engine, audit);

		const auth = await gov.authorize(AUTHORIZE);
		await expect(gov.release(auth)).resolves.toBeUndefined();
		expect(kinds(audit)).toEqual(["hold_released"]);

		await gov.destroy();
	});

	it("dry run: records the release and touches no ledger", async () => {
		const audit = makeAudit();
		const gov = await createGovernor({ dryRun: true, budget: BUDGET, vaultBase, _audit: audit });
		const before = gov.budgetRemaining();

		const auth = await gov.authorize(AUTHORIZE);
		await gov.release(auth);

		expect(kinds(audit)).toEqual(["hold_released"]);
		expect(gov.budgetRemaining()).toBe(before);

		await gov.destroy();
	});

	describe("reason is caller text, recorded only after it is made safe", () => {
		async function reasonFor(reason: string | undefined): Promise<unknown> {
			const audit = makeAudit();
			const gov = await governorWith(makeEngine(), audit);
			await gov.release(await gov.authorize(AUTHORIZE), reason);
			await gov.destroy();
			return released(audit)[0]?.reason;
		}

		it('defaults to "released"', async () => {
			expect(await reasonFor(undefined)).toBe("released");
		});

		it("strips C0, DEL and C1 control characters", async () => {
			const raw = `a${ESC}[2Jb${NUL}c${DEL}d${CSI}31me\nf\tg`;
			expect(await reasonFor(raw)).toBe("a[2Jbcd31mefg");
		});

		it("is clipped to 200 characters, AFTER sanitizing", async () => {
			// Sanitize first, clip second: clipping first would let the controls eat
			// into the budget and then be removed, leaving a shorter record than the
			// limit allows; the opposite order cannot leave a control in it at all.
			const raw = `${ESC.repeat(50)}${"x".repeat(250)}`;
			const reason = await reasonFor(raw);
			expect(reason).toBe("x".repeat(200));
		});

		it("clips by character, never splitting a surrogate pair", async () => {
			const raw = "😀".repeat(201);
			const reason = (await reasonFor(raw)) as string;
			expect([...reason]).toHaveLength(200);
			expect(reason).toBe("😀".repeat(200));
		});

		it("a reason that sanitizes to nothing records the default", async () => {
			expect(await reasonFor(`${ESC}${CSI}${NUL}`)).toBe("released");
			expect(await reasonFor("")).toBe("released");
		});

		it("a non-string reason from an untyped caller records the default", async () => {
			expect(await reasonFor({ toString: () => "object" } as unknown as string)).toBe("released");
		});
	});
});
